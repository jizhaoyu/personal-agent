const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
let createTodoDesktop, createTodoWindowGuard;
try { ({ createTodoDesktop } = require('../electron/todo-desktop.cjs')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
try { ({ createTodoWindowGuard } = require('../electron/todo-window.cjs')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

const at = Date.parse('2026-11-04T09:00:00+08:00');
const todo = (patch = {}) => ({ id: 'one', space: 'life', title: '交接方案', status: 'pending', dueAt: new Date(at + 1000).toISOString(), createdAt: at, updatedAt: at, revision: 1, ...patch });
function clock() {
  let time = at, id = 0;
  const tasks = new Map();
  return { now: () => time, setTimeout: (fn, delay) => { tasks.set(++id, { fn, delay }); return id; }, clearTimeout: key => tasks.delete(key),
    advance: ms => { time += ms; }, callbacks: () => [...tasks.values()].map(x => x.fn), count: () => tasks.size };
}
function memoryStore(initial = []) {
  let rows = initial.map(data => ({ space: data.space, kind: 'todo', id: data.id, data, at: data.updatedAt }));
  let settings = { remindersEnabled: false }, applied = [{ space: 'work', id: 'keep', signature: '', result: { ok: true }, at: 1 }];
  return { async request(command) {
    if (command.op === 'settings') { settings = { ...settings, ...command.patch }; return { ...settings }; }
    if (command.op === 'list') return { items: rows.filter(r => r.space === command.space && r.kind === command.kind).map(r => structuredClone(r.data)), nextCursor: null };
    if (command.op === 'get') return structuredClone(rows.find(r => r.space === command.space && r.kind === command.kind && r.id === command.id)?.data || null);
    if (command.op === 'exportSnapshot') return structuredClone({ records: rows, settings, applied, mode: 'work', revisions: { life: 0, work: 0 }, snapshotRevision: 0 });
    if (command.op === 'restore') { rows = structuredClone(command.records); settings = command.settings; applied = command.applied; return { ok: true }; }
    if (command.op === 'transaction') {
      for (const mutation of command.mutations) {
        const old = rows.find(r => r.space === command.space && r.kind === mutation.kind && r.id === mutation.id);
        if (JSON.stringify(old?.data || null) !== JSON.stringify(mutation.before)) return { ok: false, error: 'stale' };
        rows = rows.filter(r => r !== old);
        if (mutation.after) rows.push({ space: command.space, kind: mutation.kind, id: mutation.id, data: structuredClone(mutation.after), at: mutation.after.updatedAt });
      }
      return { ok: true };
    }
    throw new Error(`unexpected operation: ${command.op}`);
  } };
}
async function harness(initial = []) {
  assert.equal(typeof createTodoDesktop, 'function', 'desktop todo scheduler is implemented');
  const timer = clock(), persistence = memoryStore(initial), notices = [], focused = [];
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; this.closed = false; notices.push(this); }
    show() { if (Notification.fail) this.emit('failed', new Error('denied')); else this.emit('show'); }
    close() { this.closed = true; this.emit('close'); }
  }
  const desktop = await createTodoDesktop({ getPersistence: () => persistence, Notification, onFocus: value => focused.push(value), ...timer });
  return { desktop, timer, persistence, notices, focused, Notification };
}

test('desktop scheduling is opt-in and marks one delivered revision without bumping it', async () => {
  const h = await harness([todo()]);
  h.timer.advance(2000); await h.desktop.refresh(); assert.equal(h.notices.length, 0);
  assert.equal((await h.desktop.request({ op: 'configure', enabled: true })).ok, true);
  await h.desktop.flush();
  assert.equal(h.notices.length, 1);
  const record = (await h.desktop.request({ op: 'list' })).todos[0];
  assert.equal(record.revision, 1); assert.equal(record.notifiedRevision, 1);
  await h.desktop.refresh(); await h.desktop.refresh(); assert.equal(h.notices.length, 1);
  assert.deepEqual(Object.keys(h.notices[0].options).sort(), ['body', 'title']);
  assert.equal(h.notices[0].options.title, '交接方案');
  assert.equal(h.notices[0].options.body, '提醒时间到了 · 今天 09:00');
  assert.doesNotMatch(h.notices[0].options.body,/T\d\d:.*Z/);
  h.notices[0].emit('click'); await h.desktop.flush(); assert.deepEqual(h.focused, [{ space: 'life', id: 'one' }]);
  h.desktop.stop(); assert.equal(h.timer.count(), 0); assert.equal(h.notices[0].closed, true);
});

test('delayed desktop reminder uses the original Shanghai date, without the source conversation', async () => {
  const h = await harness([todo({dueAt:'2026-11-03T15:30:00Z',sourceText:'不应显示的对话'})]);
  await h.desktop.request({op:'configure',enabled:true});
  await h.desktop.flush();
  assert.deepEqual(h.notices[0].options,{title:'交接方案',body:'这条待办还没完成 · 原定昨天 23:30'});
  h.desktop.stop();
});

test('completion persists before notification close and discards old scheduled callbacks', async () => {
  const h = await harness([todo()]); await h.desktop.request({ op: 'configure', enabled: true });
  const stale = h.timer.callbacks();
  const result = await h.desktop.request({ op: 'put', expectedRevision: 1, todo: todo({ revision: 2, status: 'completed', completedAt: at, updatedAt: at + 1 }) });
  assert.equal(result.ok, true); h.timer.advance(2000);
  for (const callback of stale) await callback();
  await h.desktop.flush(); assert.equal(h.notices.length, 0);
});

test('CAS rejects concurrent edits and rescheduling invalidates an old callback', async () => {
  const h = await harness([todo()]); await h.desktop.request({ op: 'configure', enabled: true });
  const stale = h.timer.callbacks();
  const updated = todo({ revision: 2, dueAt: new Date(at + 600000).toISOString(), updatedAt: at + 1 });
  const results = await Promise.all([h.desktop.request({ op: 'put', todo: updated, expectedRevision: 1 }), h.desktop.request({ op: 'put', todo: updated, expectedRevision: 1 })]);
  assert.deepEqual(results.map(x => x.ok), [true, false]); h.timer.advance(2000);
  for (const callback of stale) await callback();
  await h.desktop.flush(); assert.equal(h.notices.length, 0);
});

test('delivered notices close on cancel and failed sends never mark delivery or retry in a tight loop', async () => {
  const h = await harness([todo({ dueAt: new Date(at - 1).toISOString() })]);
  h.Notification.fail = true;
  await h.desktop.request({ op: 'configure', enabled: true }); await h.desktop.flush();
  assert.equal(h.notices.length, 1); assert.equal((await h.desktop.request({ op: 'list' })).todos[0].notifiedRevision, undefined);
  await h.desktop.refresh(); assert.equal(h.notices.length, 1);
  h.Notification.fail = false; h.timer.advance(61000); await h.desktop.refresh(); await h.desktop.flush();
  assert.equal(h.notices.length, 2);
  const current = (await h.desktop.request({ op: 'list' })).todos[0];
  assert.equal((await h.desktop.request({ op: 'put', expectedRevision: 1, todo: { ...current, status: 'cancelled', revision: 2, updatedAt: at + 61000 } })).ok, true);
  assert.equal(h.notices[1].closed, true);
  h.notices[1].emit('click'); await h.desktop.flush(); assert.deepEqual(h.focused, []);
});

test('replaceAll validates the complete set and preserves non-todo records and applied history', async () => {
  const h = await harness([todo()]);
  await h.persistence.request({ op: 'transaction', space: 'work', mutations: [{ kind: 'capture_draft', id: 'active-work', before: null, after: { id: 'active-work', updatedAt: 7 } }] });
  assert.equal((await h.desktop.request({ op: 'replaceAll', todos: [todo({ id: 'new' }), todo({ title: '' })] })).ok, false);
  assert.equal((await h.desktop.request({ op: 'list' })).todos[0].id, 'one');
  assert.equal((await h.desktop.request({ op: 'replaceAll', todos: [todo({ id: 'new' })] })).ok, true);
  const snapshot = await h.persistence.request({ op: 'exportSnapshot' });
  assert.equal(snapshot.records.some(r => r.kind === 'capture_draft'), true); assert.equal(snapshot.applied[0].id, 'keep');
  assert.deepEqual((await h.desktop.request({ op: 'list' })).todos.map(x => x.id), ['new']);
});

test('a failed restore preserves the old reminders and rearms the scheduler', async () => {
  const h = await harness([todo()]); await h.desktop.request({ op: 'configure', enabled: true });
  const request = h.persistence.request;
  h.persistence.request = command => command.op === 'restore' ? { ok: false, error: 'disk failure' } : request(command);
  assert.equal((await h.desktop.request({ op: 'replaceAll', todos: [todo({ id: 'new' })] })).ok, false);
  assert.equal(h.timer.count() > 0, true);
  h.timer.advance(2000); for (const callback of h.timer.callbacks()) await callback();
  await h.desktop.flush(); assert.equal(h.notices.length, 1);
  assert.equal((await h.desktop.request({ op: 'list' })).todos[0].id, 'one');
});

function windowHarness() {
  assert.equal(typeof createTodoWindowGuard, 'function', 'tray save-before-hide guard is implemented');
  const timer = clock(), events = [], window = { isDestroyed: () => false, hide: () => events.push('hide'), close: () => events.push('close'),
    webContents: { isDestroyed: () => false, isCrashed: () => false, send: (channel, id) => events.push({ channel, id }) } };
  const guard = createTodoWindowGuard({ window, hideToTray: true, onQuit: () => events.push('quit'), askDiscard: async () => false, randomUUID: () => 'save-id', ...timer });
  return { guard, events, timer, close: () => guard.onClose({ preventDefault: () => events.push('prevent') }) };
}
test('window close saves first then hides, and explicit quit uses the same save protocol', () => {
  const h = windowHarness(); h.guard.setReady(true); h.close();
  assert.deepEqual(h.events, ['prevent', { channel: 'window:prepareClose', id: 'save-id' }]);
  h.guard.confirm({ requestId: 'wrong', success: true }); assert.equal(h.events.includes('hide'), false);
  h.guard.confirm({ requestId: 'save-id', success: true }); assert.equal(h.events.at(-1), 'hide'); assert.equal(h.events.includes('quit'), false);
  h.guard.requestQuit(); assert.equal(h.events.at(-1).channel, 'window:prepareClose');
  h.guard.confirm({ requestId: 'save-id', success: true }); assert.equal(h.events.at(-1), 'quit');
});
test('explicit quit upgrades an in-flight close instead of bypassing draft persistence', () => {
  const h = windowHarness(); h.guard.setReady(true); h.close(); h.guard.requestQuit();
  assert.equal(h.events.includes('quit'), false); assert.equal(h.events.filter(x => x.channel === 'window:prepareClose').length, 1);
  h.guard.confirm({ requestId: 'save-id', success: true }); assert.equal(h.events.at(-1), 'quit'); assert.equal(h.events.includes('hide'), false);
});
test('failed save keeps app running when discard is declined', async () => {
  const h = windowHarness(); h.guard.setReady(true); h.guard.requestQuit(); h.guard.confirm({ requestId: 'save-id', success: false });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.events.includes('quit'), false); assert.equal(h.events.includes('hide'), false);
  h.close(); assert.equal(h.events.at(-1).channel, 'window:prepareClose');
});

test('native SQLite desktop adapter persists todo CAS and backup includes delivery marker', { skip: process.env.LOOMA_NATIVE_TEST !== '1' }, async () => {
  const { createPersistence } = require('../electron/persistence.cjs');
  const persistence = await createPersistence({ filePath: ':memory:' });
  const timer = clock(); let desktop, shown = 0;
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    show() { shown++; this.emit('show'); }
    close() {}
  }
  try {
    desktop = await createTodoDesktop({ getPersistence: () => persistence, Notification, ...timer });
    assert.equal((await desktop.request({ op: 'put', expectedRevision: null, todo: todo() })).ok, true);
    timer.advance(2000); await desktop.request({ op: 'configure', enabled: true }); await desktop.flush();
    let snapshot = await persistence.request({ op: 'exportSnapshot' });
    assert.equal(snapshot.records.find(r => r.kind === 'todo').data.notifiedRevision, 1);
    assert.equal(snapshot.records.find(r => r.kind === 'todo').data.revision, 1);
    assert.equal(shown, 1);
    desktop.stop(); desktop = await createTodoDesktop({ getPersistence: () => persistence, Notification, ...timer });
    await desktop.flush(); assert.equal(shown, 1, 'restart must honor the persisted delivered revision');
    assert.equal((await desktop.request({ op: 'put', expectedRevision: 1, todo: todo({ revision: 2, status: 'completed', completedAt: at }) })).ok, true);
    assert.equal((await desktop.request({ op: 'put', expectedRevision: 1, todo: todo({ revision: 2 }) })).ok, false);
    snapshot = await persistence.request({ op: 'exportSnapshot' });
    assert.equal(snapshot.records.find(r => r.kind === 'todo').data.status, 'completed');
    assert.equal((await desktop.request({ op: 'replaceAll', todos: [todo({ id: 'replacement', space: 'work' })] })).ok, true);
    assert.deepEqual((await desktop.request({ op: 'list' })).todos.map(x => [x.space, x.id]), [['work', 'replacement']]);
  } finally { desktop?.stop(); persistence.close(); }
});
