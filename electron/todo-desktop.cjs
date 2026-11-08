const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

const reminderClock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function reminderBody(dueAt, now) {
  const parts = value => Object.fromEntries(reminderClock.formatToParts(value).map(({type,value})=>[type,value]));
  const due = Date.parse(dueAt), target = parts(due), current = parts(now);
  const sameDay = (a,b) => a.year===b.year && a.month===b.month && a.day===b.day;
  const date = sameDay(target,current) ? '今天' : sameDay(target,parts(now-86400000)) ? '昨天'
    : `${target.year===current.year?'':target.year+'年'}${target.month}月${target.day}日`;
  return `${now-due>=60000?'这条待办还没完成 · 原定':'提醒时间到了 · '}${date} ${target.hour}:${target.minute}`;
}

// The renderer is only a client. All alarms and delivery state live in this process
// and the same records table used by the regular archive/export implementation.
async function createTodoDesktop({ getPersistence, Notification, onFocus = () => {}, now = Date.now,
  setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout }) {
  const { validateRecord } = await import(pathToFileURL(path.join(__dirname, '../shared/persistence-core.mjs')).href);
  let queue = Promise.resolve(), timer = null, stopped = false, paused = false, enabled = false;
  let permission = Notification.isSupported() ? 'unknown' : 'unsupported';
  const notices = new Map(), retries = new Map();
  const keyOf = todo => `${todo.space}:${todo.id}`;
  const active = todo => todo?.status === 'pending' && !todo.needsTime && typeof todo.dueAt === 'string' && Number.isFinite(Date.parse(todo.dueAt));
  const enqueue = callback => {
    const result = queue.then(callback);
    queue = result.catch(() => {});
    return result;
  };
  const checked = async command => {
    const persistence = getPersistence();
    if (!persistence) throw new Error('本地资料库尚未打开');
    const result = await persistence.request(command);
    if (result?.ok === false) throw new Error(result.error || '待办保存失败');
    return result;
  };
  const clearAlarm = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const closeNotice = key => {
    const entry = notices.get(key);
    if (!entry) return;
    notices.delete(key);
    if (entry.timeout !== undefined) clearTimer(entry.timeout);
    try { entry.notification.close(); } catch { /* Closing an already dismissed OS toast is best effort. */ }
  };
  const closeAll = () => { for (const key of notices.keys()) closeNotice(key); };
  async function list(space) {
    if (space !== undefined && !['life', 'work'].includes(space)) throw new Error('待办空间无效');
    const todos = [];
    for (const partition of space ? [space] : ['life', 'work']) {
      let cursor;
      do {
        const result = await checked({ op: 'list', space: partition, kind: 'todo', limit: 200, ...(cursor ? { cursor } : {}) });
        todos.push(...result.items); cursor = result.nextCursor;
      } while (cursor);
    }
    return todos;
  }
  async function save(before, after) {
    return checked({ op: 'transaction', space: after.space, id: `todo-${randomUUID()}`, event: false,
      mutations: [{ kind: 'todo', id: after.id, before, after }] });
  }
  const capabilities = () => ({ ok: true, background: true, notifications: permission, exactAlarms: 'not-required', enabled });

  async function reconcile() {
    clearAlarm();
    if (stopped || paused) return;
    const settings = await checked({ op: 'settings' }); enabled = settings.remindersEnabled === true;
    if (!enabled || !Notification.isSupported()) { closeAll(); return; }
    const todos = await list(), current = new Map(todos.map(todo => [keyOf(todo), todo]));
    for (const [key, notice] of notices) {
      const todo = current.get(key);
      if (!active(todo) || todo.revision !== notice.revision) closeNotice(key);
    }
    let next = now() + 60000; // Also recovers from wall-clock changes and system sleep.
    for (const todo of todos) {
      if (!active(todo) || todo.notifiedRevision === todo.revision) continue;
      const key = keyOf(todo), retry = retries.get(key);
      if (notices.has(key)) continue;
      const due = Math.max(Date.parse(todo.dueAt), retry?.revision === todo.revision ? retry.at : 0);
      if (due > now()) { next = Math.min(next, due); continue; }
      // Re-read immediately before asking the OS to show a notification. A stale
      // callback is never trusted, including after completion, restore or snooze.
      const latest = await checked({ op: 'get', space: todo.space, kind: 'todo', id: todo.id });
      if (stopped || paused || !active(latest) || latest.revision !== todo.revision || latest.notifiedRevision === latest.revision) continue;
      let entry;
      try {
        const notification = new Notification({ title: latest.title, body: reminderBody(latest.dueAt, now()) });
        entry = { notification, revision: latest.revision, delivered: false };
        notices.set(key, entry);
        const failed = () => {
          if (notices.get(key) !== entry) return;
          retries.set(key, { revision: entry.revision, at: now() + 60000 });
          permission = 'unknown';
          closeNotice(key);
        };
        notification.on('failed', () => { void enqueue(async () => { failed(); await reconcile(); }).catch(() => {}); });
        notification.on('show', () => { void enqueue(async () => {
          if (entry.timeout !== undefined) { clearTimer(entry.timeout); delete entry.timeout; }
          const record = await checked({ op: 'get', space: latest.space, kind: 'todo', id: latest.id });
          if (stopped || paused || notices.get(key) !== entry || !active(record) || record.revision !== entry.revision) { closeNotice(key); return; }
          entry.delivered = true; permission = 'granted'; retries.delete(key);
          try {
            // Delivery bookkeeping intentionally keeps the business revision stable.
            await save(record, { ...record, notifiedRevision: record.revision, lastNotifiedAt: now() });
          } catch {
            // Keep the displayed notification in memory to avoid a duplicate this
            // session; do not claim a durable delivery if the database write failed.
          }
          await reconcile();
        }).catch(() => {}); });
        notification.on('click', () => { void enqueue(async () => {
          const record = await checked({ op: 'get', space: latest.space, kind: 'todo', id: latest.id });
          if (!stopped && notices.get(key) === entry && active(record) && record.revision === entry.revision) onFocus({ space: record.space, id: record.id });
        }).catch(() => {}); });
        notification.on('close', () => {
          if (notices.get(key) !== entry) return;
          // A closed delivered toast no longer needs an OS handle. Keep its
          // revision sentinel until durable delivery bookkeeping has completed.
          if (entry.delivered) return;
          void enqueue(async () => { failed(); await reconcile(); }).catch(() => {});
        });
        entry.timeout = setTimer(() => enqueue(async () => { failed(); await reconcile(); }).catch(() => {}), 30000);
        notification.show();
      } catch {
        retries.set(key, { revision: latest.revision, at: now() + 60000 });
        if (entry) closeNotice(key);
      }
    }
    if (!stopped && !paused && enabled) {
      timer = setTimer(() => enqueue(reconcile).catch(() => {}), Math.max(1, next - now()));
      timer?.unref?.();
    }
  }

  async function execute(command) {
    if (!command || typeof command !== 'object') throw new Error('待办请求无效');
    switch (command.op) {
      case 'list': return { ok: true, todos: await list(command.space) };
      case 'capabilities': case 'requestPermissions': {
        const settings = await checked({ op: 'settings' }); enabled = settings.remindersEnabled === true;
        // Electron has no reliable Windows permission query or permission prompt.
        // Only an actual OS show event upgrades unknown to granted.
        return capabilities();
      }
      case 'configure': {
        if (typeof command.enabled !== 'boolean') throw new Error('待办提醒开关无效');
        await checked({ op: 'settings', patch: { remindersEnabled: command.enabled } });
        enabled = command.enabled; await reconcile(); return capabilities();
      }
      case 'put': {
        const todo = command.todo;
        if (!todo || !validateRecord(todo.space, 'todo', todo)) throw new Error('待办格式无效');
        const before = await checked({ op: 'get', space: todo.space, kind: 'todo', id: todo.id });
        if (before ? command.expectedRevision !== before.revision || todo.revision !== before.revision + 1 : command.expectedRevision !== null || todo.revision !== 1) throw new Error('待办已更新，请刷新后重试');
        if (before && todo.createdAt !== before.createdAt) throw new Error('待办创建时间不可改写');
        await save(before, todo); retries.delete(keyOf(todo)); await reconcile(); return { ok: true, todo };
      }
      case 'replaceAll': {
        if (!Array.isArray(command.todos)) throw new Error('待办备份格式无效');
        const keys = new Set();
        for (const todo of command.todos) {
          if (!todo || !validateRecord(todo.space, 'todo', todo) || keys.has(keyOf(todo))) throw new Error('待办备份包含无效或重复记录');
          keys.add(keyOf(todo));
        }
        clearAlarm();
        try {
          const snapshot = await checked({ op: 'exportSnapshot' });
          const records = [...snapshot.records.filter(row => row.kind !== 'todo'), ...command.todos.map(todo => ({ space: todo.space, kind: 'todo', id: todo.id, data: todo, at: todo.updatedAt }))];
          await checked({ op: 'restore', ...snapshot, records });
          closeAll(); retries.clear(); return { ok: true };
        } finally {
          // Failed/rolled-back restore must not silently disable the old alarms.
          await reconcile().catch(() => {});
        }
      }
      default: throw new Error('不支持该待办操作');
    }
  }
  // Do not make startup fail if the existing database is temporarily unavailable.
  await enqueue(reconcile).catch(() => {});
  return {
    request: command => enqueue(() => execute(command)).catch(error => ({ ok: false, error: error.message })),
    refresh: () => enqueue(reconcile),
    runExclusive: callback => enqueue(async () => {
      // A background rescan must not turn a successfully saved business draft
      // into an apparent failed save if notification/database availability drifts.
      try { return await callback(); } finally { await reconcile().catch(() => {}); }
    }),
    suspend() { paused = true; clearAlarm(); closeAll(); },
    resume() { paused = false; return enqueue(reconcile); },
    stop() { stopped = true; clearAlarm(); closeAll(); },
    async flush() { let previous; do { previous = queue; await previous; } while (queue !== previous); },
  };
}
module.exports = { createTodoDesktop };
