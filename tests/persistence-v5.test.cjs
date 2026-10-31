const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = process.env.LOOMA_SOURCE_ROOT || path.resolve(__dirname, '..');
const corePromise = import(pathToFileURL(path.join(root, 'shared/persistence-core.mjs')).href);
const native = process.env.LOOMA_NATIVE_TEST === '1';
const project = () => ({ id: 'website', clientName: '张三', title: '网站改版', stage: '需求确认', budgetAmount: 300,
  internalContext: '', shareableSummary: '', nextAction: '周五发原型', updatedAt: 1 });
const waiting = () => ({ id: 'materials', kind: 'waiting', title: '客户补充素材', engagementId: 'website', status: 'open',
  sourceMessageId: 'session-1:1', createdAt: 1, updatedAt: 1, expectedDate: '2026-11-02', sourceDateText: '下周一' });
const proposal = () => ({ id: 'proposal-session-1:1', mode: 'work', sourceMessageId: 'session-1:1', sourceText: '张三预算300元，客户下周一补充素材',
  baseRevision: 0, createdAt: 1, warnings: [], operations: [{ target: 'engagement', entityId: 'website', before: null, after: project() },
    { target: 'followup', entityId: 'materials', before: null, after: waiting() }] });
const draft = () => ({ id: 'active-work', sessionId: 'session-1', mode: 'work', text: proposal().sourceText, sourceVersion: 1, draftVersion: 1,
  sourceMessageId: 'session-1:1', status: 'review', proposal: proposal(), updatedAt: 1 });
const command = () => ({ op: 'commitCapture', space: 'work', draftSessionId: 'session-1', proposal: proposal(), confirmedAt: 2 });

test('v5 records keep date-only waiting separate and validate nested draft candidates', async () => {
  const core = await corePromise;
  assert.equal(core.validateRecord('work', 'followup', waiting()), true);
  assert.equal(core.validateRecord('life', 'followup', waiting()), false);
  assert.equal(core.validateRecord('work', 'capture_draft', draft()), true);
  assert.equal(core.validateRecord('work', 'capture_draft', { ...draft(), apiKey: 'forbidden' }), false);
  const invalid = draft(); invalid.proposal.operations[1].after.apiKey = 'forbidden';
  assert.equal(core.validateRecord('work', 'capture_draft', invalid), false);
  assert.equal(core.validateRecord('work', 'followup', { ...waiting(), expectedDate: '2026-02-31' }), false);
});
test('an unfinished manual form is a valid draft but cannot become a committed entity', async () => {
  const core = await corePromise; const form = draft();
  form.proposal.operations = [{ target: 'engagement', entityId: 'website', before: null, after: { ...project(), clientName: '', title: '' } }];
  assert.equal(core.validateRecord('work', 'capture_draft', form), true);
  assert.equal(core.validateCaptureCommand({ ...command(), proposal: form.proposal }), false);
  form.proposal.operations[0].after.apiKey = 'must-reject';
  assert.equal(core.validateRecord('work', 'capture_draft', form), false);
});

test('business timestamps reject impossible calendar days instead of rolling them forward', async () => {
  const core = await corePromise;
  for (const field of ['expectedAt', 'reviewAt']) {
    const item = { ...waiting(), expectedDate: undefined, [field]: '2026-02-31T01:00:00Z' };
    assert.equal(core.validateRecord('work', 'followup', item), false, field);
  }
});

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-v5-native-'));
  const { createPersistence } = require(path.join(root, 'electron/persistence.cjs'));
  const store = await createPersistence({ filePath: path.join(directory, 'test.sqlite') });
  t.after(() => { store.close(); const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('looma-v5-native-')) throw new Error('unsafe cleanup');
    fs.rmSync(resolved, { recursive: true, force: true }); });
  return { store, directory };
}
const nativeTest = (name, run) => test(name, { skip: !native }, run);

nativeTest('v5 draft saves do not change business revision and reject stale or closed session writes', async t => {
  const { store } = await fixture(t);
  assert.equal((await store.request({ op: 'saveDraft', space: 'work', draft: draft() })).ok, true);
  assert.equal((await store.request({ op: 'bootstrap', space: 'work' })).snapshot.partitions.work.revision, 0);
  assert.equal((await store.request({ op: 'saveDraft', space: 'work', draft: { ...draft(), draftVersion: 0 } })).ok, false);
  assert.equal((await store.request(command())).ok, true);
  assert.equal((await store.request({ op: 'saveDraft', space: 'work', draft: draft() })).ok, false);
});

nativeTest('v5 capture atomically commits source, waiting, receipt and removes draft exactly once', async t => {
  const { store } = await fixture(t);
  await store.request({ op: 'saveDraft', space: 'work', draft: draft() });
  const first = await store.request(command()); assert.equal(first.ok, true, first.error);
  assert.equal(first.closureId, 'closure-proposal-session-1:1');
  assert.equal(await store.request({ op: 'get', space: 'work', kind: 'capture_draft', id: 'active-work' }), null);
  assert.equal((await store.request({ op: 'get', space: 'work', kind: 'followup', id: 'materials' })).expectedAt, undefined);
  assert.equal((await store.request({ op: 'get', space: 'work', kind: 'message', id: 'session-1:1' })).content, proposal().sourceText);
  const again = await store.request(command()); assert.equal(again.ok, true); assert.equal(again.already, true); assert.equal(again.closureId, first.closureId);
  assert.equal((await store.request({ op: 'stats', space: 'work' })).counts.closure, 1);
  const altered = command(); altered.proposal.operations[0].after.budgetAmount = 999;
  assert.equal((await store.request(altered)).ok, false);
  const undo = await store.request({ op: 'undo', space: 'work', eventId: first.eventId }); assert.equal(undo.ok, true, undo.error);
  assert.equal(await store.request({ op: 'get', space: 'work', kind: 'capture_draft', id: 'active-work' }), null);
  assert.ok((await store.request({ op: 'get', space: 'work', kind: 'closure', id: first.closureId })).revertedAt);
});

nativeTest('v5 capture failure rolls back source, business and receipt while preserving draft', async t => {
  const { store } = await fixture(t);
  await store.request({ op: 'saveDraft', space: 'work', draft: draft() });
  const Database = require('better-sqlite3'); const raw = new Database(store.filename);
  raw.exec("CREATE TRIGGER reject_closure BEFORE INSERT ON records WHEN NEW.kind='closure' BEGIN SELECT RAISE(ABORT,'controlled failure'); END"); raw.close();
  const failed = await store.request(command()); assert.equal(failed.ok, false);
  assert.equal((await store.request({ op: 'stats', space: 'work' })).counts.engagement, 0);
  assert.equal((await store.request({ op: 'stats', space: 'work' })).counts.message, 0);
  assert.equal((await store.request({ op: 'stats', space: 'work' })).counts.closure, 0);
  assert.equal((await store.request({ op: 'get', space: 'work', kind: 'capture_draft', id: 'active-work' })).sessionId, 'session-1');
});

nativeTest('v5 home uses Shanghai day boundaries, bounded groups and independent waiting', async t => {
  const { store } = await fixture(t); const now = Date.parse('2026-10-27T04:00:00Z');
  const tasks = Array.from({ length: 20 }, (_, i) => ({ kind: 'task', id: `task-${i}`, before: null, after: { id: `task-${i}`, title: `今日${i}`, assignee: '我', deadline: '', priority: 'medium', done: false, dueAt: new Date(Date.parse('2026-10-26T16:00:00Z') + i * 3600000).toISOString() } }));
  tasks.push({ kind: 'task', id: 'old', before: null, after: { ...tasks[0].after, id: 'old', dueAt: '2026-10-26T15:59:00Z' } });
  const item = { ...waiting(), engagementId: undefined };
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'seed', mutations: [...tasks, { kind: 'followup', id: item.id, before: null, after: item }] })).ok, true);
  const home = await store.request({ op: 'workHome', space: 'work', now, limit: 3 });
  assert.equal(home.today.length, 3); assert.equal(home.counts.today, 20);
  assert.equal(home.overdue.length, 1); assert.equal(home.counts.overdue, 1);
  assert.equal(home.waiting.length, 1); assert.equal(home.questions.length, 0);
  assert.equal((await store.request({ op: 'workHome', space: 'life', now })).ok, false);
});

nativeTest('follow-up reminders query only open items with an explicit review time', async t => {
  const { store } = await fixture(t);
  const items = [
    { ...waiting(), id: 'expectation-only', engagementId: undefined, expectedDate: '2020-01-01' },
    { ...waiting(), id: 'review-due', engagementId: undefined, reviewAt: '2020-01-01T01:00:00Z' },
    { ...waiting(), id: 'resolved', engagementId: undefined, reviewAt: '2020-01-01T01:00:00Z', status: 'resolved' },
    { ...waiting(), id: 'future', engagementId: undefined, reviewAt: '2099-01-01T01:00:00Z' },
  ];
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'seed-followups', mutations: items.map(after => ({ kind: 'followup', id: after.id, before: null, after })) })).ok, true);
  const result = await store.request({ op: 'list', space: 'work', kind: 'followup', dueOnly: true, limit: 2 });
  assert.equal(result.ok, undefined, result.error);
  assert.deepEqual(result.items.map(item => item.id), ['review-due']);
  assert.equal((await store.request({ op: 'stats', space: 'work' })).dueFollowUps, 1);
});

nativeTest('follow-up due pagination orders explicit review times without losing tied items', async t => {
  const { store } = await fixture(t);
  const items = [
    { ...waiting(), id: 'c', kind: 'question', expectedDate: undefined, engagementId: undefined, reviewAt: '2020-01-02T01:00:00Z', updatedAt: 1 },
    { ...waiting(), id: 'b', engagementId: undefined, reviewAt: '2020-01-01T01:00:00Z', updatedAt: 3 },
    { ...waiting(), id: 'a', engagementId: undefined, reviewAt: '2020-01-01T01:00:00Z', updatedAt: 2 },
  ];
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'seed-followup-pages', mutations: items.map(after => ({ kind: 'followup', id: after.id, before: null, after })) })).ok, true);
  const first = await store.request({ op: 'list', space: 'work', kind: 'followup', dueOnly: true, limit: 1 });
  const second = await store.request({ op: 'list', space: 'work', kind: 'followup', dueOnly: true, limit: 1, cursor: first.nextCursor });
  const third = await store.request({ op: 'list', space: 'work', kind: 'followup', dueOnly: true, limit: 1, cursor: second.nextCursor });
  assert.deepEqual([first, second, third].flatMap(page => page.items.map(item => item.id)), ['a', 'b', 'c']);
  assert.equal(third.nextCursor, null);
});

nativeTest('opening an actual v4 database adds v5 indexes without rewriting its project fields', async t => {
  const { store } = await fixture(t);
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'seed-v4', mutations: [{ kind: 'engagement', id: 'website', before: null, after: project() },
    { kind: 'task', id: 'due', before: null, after: { id: 'due', title: '继续处理', assignee: '我', deadline: '今天', dueAt: '2026-10-27T01:00:00Z', done: false, priority: 'medium', engagementId: 'website' } }] })).ok, true);
  store.close();
  const Database = require('better-sqlite3'), raw = new Database(store.filename);
  const originalJson = raw.prepare("SELECT data FROM records WHERE kind='engagement'").get().data;
  raw.exec('DROP TABLE work_index'); raw.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('schemaVersion','4')").run(); raw.close();
  const upgraded = await require(path.join(root, 'electron/persistence.cjs')).createPersistence({ filePath: store.filename });
  try {
    const home = await upgraded.request({ op: 'workHome', space: 'work', now: Date.parse('2026-10-27T04:00:00Z') });
    assert.equal(home.today[0].id, 'due');
    const current = new Database(store.filename, { readonly: true });
    try { assert.equal(current.prepare("SELECT data FROM records WHERE kind='engagement'").get().data, originalJson);
      assert.equal(JSON.parse(current.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get().value), 5); }
    finally { current.close(); }
  } finally { upgraded.close(); }
});

nativeTest('v5 backup preserves capture receipt idempotency and accepts old v4 JSONL headers', async t => {
  const { store, directory } = await fixture(t); await store.request({ op: 'saveDraft', space: 'work', draft: draft() });
  await store.request(command()); const file = path.join(directory, 'v5.jsonl');
  assert.equal((await store.exportToFile(file)).ok, true); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).version, 5);
  assert.equal((await store.restoreFromFile(file)).ok, true);
  const repeated = await store.request(command()); assert.equal(repeated.ok, true); assert.equal(repeated.already, true); assert.equal(repeated.closureId, 'closure-proposal-session-1:1');
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const header = JSON.parse(lines[0]); header.version = 4; lines[0] = JSON.stringify(header);
  const end = JSON.parse(lines.at(-1)); end.sha256 = require('node:crypto').createHash('sha256').update(`${lines.slice(0, -1).join('\n')}\n`).digest('hex');
  lines[lines.length - 1] = JSON.stringify(end); const oldFile = path.join(directory, 'v4.jsonl'); fs.writeFileSync(oldFile, `${lines.join('\n')}\n`);
  assert.equal((await store.restoreFromFile(oldFile)).ok, true);
  assert.equal((await store.request({ op: 'get', space: 'work', kind: 'engagement', id: 'website' })).budgetAmount, 300);
});
