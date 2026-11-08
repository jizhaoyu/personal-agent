import type { TodoRecord, WorkspaceMode } from '../types';

export interface ForegroundTodoSchedulerOptions {
  /** Return both spaces, including completed/cancelled records for invalidation. */
  list: () => Promise<TodoRecord[]>;
  /** Persist delivery for this exact revision, without increasing its revision. */
  markDelivered: (todo: TodoRecord) => Promise<void>;
  /** onShown must reflect the platform's actual show event, not construction. */
  notify: (todo: TodoRecord, onShown: () => void, onFailed: () => void, onClick?: () => void) => { close: () => void };
  now?: () => number;
  onFocus?: (focus: { space: WorkspaceMode; id: string }) => void;
}

interface Notice {
  todo: TodoRecord;
  shown: boolean;
  handle?: { close: () => void };
}

/** Page-lifetime reminders only. The adapter owns its enabled flag and timer. */
export function createForegroundTodoScheduler(options: ForegroundTodoSchedulerOptions) {
  const now = options.now || Date.now;
  const notices = new Map<string, Notice>();
  let stopped = false;
  let queue: Promise<void> = Promise.resolve();
  let ticking: Promise<void> | undefined;
  const keyOf = (todo: TodoRecord) => `${todo.space}:${todo.id}`;
  const active = (todo: TodoRecord | undefined): todo is TodoRecord => !!todo &&
    (todo.space === 'life' || todo.space === 'work') && todo.status === 'pending' && !todo.needsTime &&
    typeof todo.dueAt === 'string' && Number.isFinite(Date.parse(todo.dueAt));
  const due = (todo: TodoRecord | undefined): todo is TodoRecord => active(todo) && Date.parse(todo.dueAt!) <= now();
  const same = (todo: TodoRecord | undefined, notice: Notice) => active(todo) &&
    todo.revision === notice.todo.revision && todo.dueAt === notice.todo.dueAt;
  const enqueue = (work: () => Promise<void>) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const close = (key: string) => {
    const notice = notices.get(key);
    if (!notice) return;
    notices.delete(key); // Invalidate callbacks before OS close emits any event.
    try { notice.handle?.close(); } catch { /* A dismissed OS notice may reject close. */ }
  };
  const current = async (todo: TodoRecord) => (await options.list()).find(record => record.space === todo.space && record.id === todo.id);

  async function scan() {
    if (stopped) return;
    const records = await options.list();
    if (stopped) return;
    const byKey = new Map(records.map(record => [keyOf(record), record]));
    for (const [key, notice] of notices) if (!same(byKey.get(key), notice)) close(key);
    for (const candidate of records) {
      if (stopped) return;
      if (!due(candidate) || candidate.notifiedRevision === candidate.revision || notices.has(keyOf(candidate))) continue;
      // Completion/snooze can occur while the initial asynchronous scan is read.
      const latest = await current(candidate);
      if (stopped) return;
      if (!due(latest) || latest.revision !== candidate.revision || latest.notifiedRevision === latest.revision) continue;
      const key = keyOf(latest), notice: Notice = { todo: { ...latest }, shown: false };
      notices.set(key, notice);
      const onShown = () => {
        if (stopped || notices.get(key) !== notice || notice.shown) return;
        // Even if the later durable write fails, one actually shown revision
        // must not repeatedly interrupt the user during this page session.
        notice.shown = true;
        void enqueue(async () => {
          if (stopped || notices.get(key) !== notice) return;
          const record = await current(notice.todo);
          if (stopped || notices.get(key) !== notice) return;
          if (!same(record, notice)) { close(key); return; }
          if (record!.notifiedRevision !== record!.revision) await options.markDelivered(record!);
        }).catch(() => {});
      };
      const onFailed = () => {
        // A platform firing failure after show must not erase the dedupe guard.
        if (stopped || notices.get(key) !== notice || notice.shown) return;
        void enqueue(async () => {
          if (!stopped && notices.get(key) === notice && !notice.shown) close(key);
        }).catch(() => {});
      };
      const onClick = () => {
        if (stopped || notices.get(key) !== notice) return;
        void enqueue(async () => {
          const record = await current(notice.todo);
          if (!stopped && notices.get(key) === notice && same(record, notice)) options.onFocus?.({ space: record!.space, id: record!.id });
        }).catch(() => {});
      };
      try { notice.handle = options.notify(notice.todo, onShown, onFailed, onClick); }
      catch { onFailed(); }
      // A stop invoked synchronously by the adapter still closes its new handle.
      if (stopped || notices.get(key) !== notice) {
        try { notice.handle?.close(); } catch { /* Best effort. */ }
      }
    }
  }

  return {
    tick(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (ticking) return ticking;
      const run = enqueue(scan);
      ticking = (async () => {
        await run;
        // Drain callbacks synchronously raised by notify, but never wait for an
        // OS event that has not arrived. Reentrant ticks coalesce into this run.
        let pending: Promise<void>;
        do { pending = queue; await pending; } while (pending !== queue);
      })().finally(() => { ticking = undefined; });
      return ticking;
    },
    stop(): void {
      stopped = true;
      for (const key of notices.keys()) close(key);
    },
  };
}
