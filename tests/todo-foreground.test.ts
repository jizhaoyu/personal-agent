import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TodoRecord } from '../src/types';

let createForegroundTodoScheduler: typeof import('../src/services/foregroundTodos').createForegroundTodoScheduler;
try { ({ createForegroundTodoScheduler } = require('../src/services/foregroundTodos')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

const time = Date.parse('2026-11-04T10:00:00+08:00');
const todo = (patch: Partial<TodoRecord> = {}): TodoRecord => ({ id: 'one', space: 'life', title: '交电费', status: 'pending', revision: 1,
  createdAt: time - 1000, updatedAt: time - 1000, dueAt: new Date(time - 1).toISOString(), ...patch });
function fixture(initial: TodoRecord[] = [todo()]) {
  assert.equal(typeof createForegroundTodoScheduler, 'function', 'foreground reminder scheduler exists');
  let records = structuredClone(initial), mode: 'shown' | 'failed' | 'deferred' | 'throw' = 'shown';
  const notices: { todo: TodoRecord; show: () => void; fail: () => void; click: () => void; closed: boolean }[] = [];
  const delivered: TodoRecord[] = [], focused: { space: string; id: string }[] = [];
  const scheduler = createForegroundTodoScheduler({
    list: async () => structuredClone(records), now: () => time,
    markDelivered: async record => {
      delivered.push(record);
      records = records.map(current => current.space === record.space && current.id === record.id && current.revision === record.revision
        ? { ...current, notifiedRevision: current.revision, lastNotifiedAt: time } : current);
    },
    notify: (record, show, fail, click) => {
      if (mode === 'throw') throw new Error('Notification unavailable');
      const notice = { todo: record, show, fail, click, closed: false }; notices.push(notice);
      if (mode === 'shown') show();
      if (mode === 'failed') fail();
      return { close() { notice.closed = true; } };
    },
    onFocus: focus => focused.push(focus),
  });
  return { scheduler, notices, delivered, focused, setMode: value => { mode = value; }, setRecords: value => { records = structuredClone(value); } };
}

test('foreground scheduler sends both spaces only when pending, fully timed, due and not delivered', async () => {
  const h = fixture([todo(), todo({ space: 'work' }), todo({ id: 'suggested', status: 'suggested' }), todo({ id: 'completed', status: 'completed' }),
    todo({ id: 'cancelled', status: 'cancelled' }), todo({ id: 'future', dueAt: new Date(time + 1).toISOString() }),
    todo({ id: 'no-time', dueAt: undefined }), todo({ id: 'needs-time', needsTime: true }), todo({ id: 'bad-time', dueAt: 'bad' }),
    todo({ id: 'delivered', notifiedRevision: 1 })]);
  await h.scheduler.tick();
  assert.deepEqual(h.notices.map(n => [n.todo.space, n.todo.id]), [['life', 'one'], ['work', 'one']]);
  assert.equal(h.delivered.length, 2); assert.equal(h.delivered[0].revision, 1);
  await h.scheduler.tick(); assert.equal(h.notices.length, 2);
});

test('notification delivery is persisted only after shown, and a deferred same version is not reissued', async () => {
  const h = fixture(); h.setMode('deferred');
  await h.scheduler.tick(); await h.scheduler.tick();
  assert.equal(h.notices.length, 1); assert.equal(h.delivered.length, 0);
  h.notices[0].show(); await h.scheduler.tick();
  assert.equal(h.delivered.length, 1); assert.equal(h.delivered[0].notifiedRevision, undefined);
  await h.scheduler.tick(); assert.equal(h.notices.length, 1);
});

test('failed and thrown notifications retry on a later tick without a tight loop', async () => {
  const h = fixture(); h.setMode('failed'); await h.scheduler.tick();
  assert.equal(h.notices.length, 1); assert.equal(h.delivered.length, 0); assert.equal(h.notices[0].closed, true);
  h.setMode('shown'); await h.scheduler.tick(); assert.equal(h.notices.length, 2); assert.equal(h.delivered.length, 1);
  const thrown = fixture(); thrown.setMode('throw'); await thrown.scheduler.tick(); assert.equal(thrown.delivered.length, 0);
  thrown.setMode('shown'); await thrown.scheduler.tick(); assert.equal(thrown.notices.length, 1); assert.equal(thrown.delivered.length, 1);
});

test('completion, cancellation and rescheduling close old notifications and reject stale callbacks', async () => {
  for (const patch of [{ status: 'completed' }, { status: 'cancelled' }, { dueAt: new Date(time + 100000).toISOString() }]) {
    const h = fixture(); h.setMode('deferred'); await h.scheduler.tick();
    h.setRecords([todo({ ...patch, revision: 2 } as Partial<TodoRecord>)]); await h.scheduler.tick();
    assert.equal(h.notices[0].closed, true);
    h.notices[0].show(); h.notices[0].click(); await h.scheduler.tick();
    assert.equal(h.delivered.length, 0); assert.deepEqual(h.focused, []); assert.equal(h.notices.length, 1);
  }
});

test('send rechecks the current record rather than trusting the initial due snapshot', async () => {
  assert.equal(typeof createForegroundTodoScheduler, 'function');
  let lists = 0, sends = 0;
  const scheduler = createForegroundTodoScheduler({ now: () => time,
    list: async () => [todo(++lists === 1 ? {} : { status: 'completed', revision: 2 })],
    markDelivered: async () => { throw new Error('must not mark'); },
    notify: () => { sends++; return { close() {} }; },
  });
  await scheduler.tick(); assert.equal(lists >= 2, true); assert.equal(sends, 0);
});

test('concurrent ticks coalesce and stop prevents late async scans or callbacks from delivering', async () => {
  assert.equal(typeof createForegroundTodoScheduler, 'function');
  let release: (todos: TodoRecord[]) => void, lists = 0, sends = 0;
  const scheduler = createForegroundTodoScheduler({ now: () => time,
    list: () => { lists++; return new Promise(resolve => { release = resolve; }); }, markDelivered: async () => {},
    notify: () => { sends++; return { close() {} }; },
  });
  const first = scheduler.tick(), second = scheduler.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(lists, 1); scheduler.stop(); release([todo()]); await Promise.all([first, second]); assert.equal(sends, 0);
  const h = fixture(); h.setMode('deferred'); await h.scheduler.tick(); h.scheduler.stop(); h.scheduler.stop();
  assert.equal(h.notices[0].closed, true); h.notices[0].show(); h.notices[0].click(); await h.scheduler.tick();
  assert.equal(h.delivered.length, 0); assert.deepEqual(h.focused, []); assert.equal(h.notices.length, 1);
});

test('notification clicks focus only a still-current record, and durable marking failure does not repeat a shown version', async () => {
  const h = fixture(); await h.scheduler.tick(); h.notices[0].click(); await h.scheduler.tick();
  assert.deepEqual(h.focused, [{ space: 'life', id: 'one' }]);
  let shown = 0, marks = 0;
  const scheduler = createForegroundTodoScheduler({ now: () => time, list: async () => [todo()],
    markDelivered: async () => { marks++; throw new Error('database unavailable'); },
    notify: (_todo, onShown) => { shown++; onShown(); return { close() {} }; },
  });
  await scheduler.tick(); await scheduler.tick(); assert.equal(shown, 1); assert.equal(marks, 1);
});
