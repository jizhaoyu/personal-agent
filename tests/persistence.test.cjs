const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const native = process.env.LOOMA_NATIVE_TEST === '1';
const sourceRoot = process.env.LOOMA_SOURCE_ROOT || path.resolve(__dirname, '..');
const corePromise = import(pathToFileURL(path.join(sourceRoot, 'shared/persistence-core.mjs')).href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const memory = (id, fact = '预算需要确认') => ({ id, mode: 'work', category: 'business', fact, createdAt: 1, importance: 5 });
const message = (id, timestamp = 1, content = '沟通原文') => ({ id, role: 'user', content, timestamp });
const engagement = (budgetAmount = 80000) => ({ id: 'project', clientName: '王总', title: '网站设计', budgetAmount,
  stage: '需求确认', internalContext: '', shareableSummary: '', nextAction: '确认方案', updatedAt: 1 });
function v3(settings) {
  const base = () => ({ revision: 0, messages: [], events: [], memories: [], journals: [], customCards: [], processedProposalIds: [] });
  return { schemaVersion: 3, snapshotRevision: 0, activeMode: 'work', settings, partitions: {
    life: { ...base(), wallet: { monthlyBudget: 5000, wishTitle: '心愿', wishTarget: 1000, wishSaved: 0, entries: [] },
      rpg: { energy: 80, waterCups: 0, weightKg: 0, targetWeightKg: 0, streakDays: 0, moodBuff: '未记录' }, persons: [] },
    work: { ...base(), engagements: [], tasks: [] },
  } };
}

test('shared protocol validates explicit spaces, known fields and Chinese two-character terms', async () => {
  const core = await corePromise;
  assert.equal(typeof core.validateRecord, 'function', 'shared validators are available');
  assert.equal(core.validateRecord('work', 'memory', memory('m')), true);
  assert.equal(core.validateRecord('life', 'memory', memory('m')), false);
  assert.equal(core.validateRecord('work', 'memory', { ...memory('m'), apiKey: 'must-reject' }), false);
  assert.equal(core.validateRecord('work', 'wallet', { monthlyBudget: 3 }), false);
  assert.ok(core.searchTerms('王总网站设计 ABC-22').includes('王总'));
  assert.ok(core.searchTerms('王总网站设计 ABC-22').includes('网站'));
});

test('transaction validator rejects stale before values and accepts atomic staged relationships', async () => {
  const core = await corePromise;
  assert.equal(typeof core.validateTransaction, 'function');
  const command = { op: 'transaction', space: 'work', id: 'one', baseRevision: 0,
    mutations: [{ kind: 'engagement', id: 'project', before: null, after: engagement() }] };
  assert.deepEqual(core.validateTransaction(command, 0, () => null), []);
  assert.ok(core.validateTransaction(command, 1, () => null).length);
  assert.ok(core.validateTransaction(command, 0, () => engagement()).length);
});

test('v3 flatten preserves archive rows and rejects unknown fields rather than importing demos or keys', async () => {
  const core = await corePromise;
  const snapshot = v3({ ...core.DEFAULT_PUBLIC_SETTINGS });
  snapshot.partitions.work.messages = Array.from({ length: 250 }, (_, i) => message(`old${i}`, i));
  snapshot.partitions.work.engagements = [engagement()];
  const result = core.flattenV3(snapshot);
  assert.equal(result.records.filter(x => x.kind === 'message').length, 250);
  assert.equal(result.records.filter(x => x.kind === 'engagement').length, 1);
  assert.equal(result.records.find(x => x.kind === 'wallet').data.entries, undefined);
  snapshot.settings.apiKey = 'must-reject';
  assert.throws(() => core.flattenV3(snapshot));
});

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-sqlite-test-'));
  const { createPersistence } = require(path.join(sourceRoot, 'electron/persistence.cjs'));
  const store = await createPersistence({ filePath: path.join(directory, 'archive.sqlite') });
  t.after(() => { store.close();
    if (!directory.startsWith(path.join(os.tmpdir(), 'looma-sqlite-test-'))) throw new Error('Unsafe cleanup');
    fs.rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}
const sqliteTest = (name, fn) => test(name, { skip: !native }, fn);

sqliteTest('deleting an original also redacts event copies and undo cannot restore it', async t => {
  const { store } = await fixture(t);
  const source = message('private-source', 1, '私人原文海盐咖啡');
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'capture-private', sourceMessageId: source.id, sourceText: source.content,
    mutations: [{ kind: 'message', id: source.id, before: null, after: source }], event: true })).ok, true);
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'delete-private', redactSourceIds: [source.id],
    mutations: [{ kind: 'message', id: source.id, before: source, after: null }] })).ok, true);
  assert.equal((await store.request({ op: 'list', space: 'work', kind: 'event', query: '海盐' })).items.length, 0);
  assert.equal((await store.request({ op: 'undo', space: 'work' })).ok, true);
  assert.equal(await store.request({ op: 'get', space: 'work', kind: 'message', id: source.id }), null);
});

sqliteTest('SQLite preserves more than legacy history caps, pages and isolates spaces', async t => {
  const { store, directory } = await fixture(t);
  const mutations = Array.from({ length: 10001 }, (_, i) => ({ kind: 'message', id: `m${i}`, before: null, after: message(`m${i}`, i, '沟通原文'.repeat(50)) }));
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'messages', mutations, event: false })).ok, true);
  const page = await store.request({ op: 'list', space: 'work', kind: 'message', limit: 100 });
  assert.equal(page.items.length, 100);
  const next = await store.request({ op: 'list', space: 'work', kind: 'message', limit: 100, cursor: page.nextCursor });
  assert.equal(next.items.length, 100);
  assert.equal(new Set([...page.items, ...next.items].map(x => x.id)).size, 200);
  const bootstrap = await store.request({ op: 'bootstrap', space: 'work' });
  assert.equal(bootstrap.snapshot.partitions.work.messages.length, 50);
  assert.equal(bootstrap.stats.counts.message, 10001);
  assert.equal(bootstrap.snapshot.partitions.work.revision, 0);
  assert.equal((await store.request({ op: 'list', space: 'life', kind: 'message' })).items.length, 0);
  assert.equal((await store.request({ op: 'list', kind: 'message' })).ok, false);
  const backup = path.join(directory, 'large-archive.jsonl');
  assert.equal((await store.exportToFile(backup)).ok, true);
  assert.ok(fs.statSync(backup).size > 5 * 1024 * 1024);
  assert.equal((await store.restoreFromFile(backup)).ok, true);
  assert.equal((await store.request({ op: 'stats', space: 'work' })).counts.message, 10001);
});

sqliteTest('SQLite confirmation is atomic/idempotent, search reflects current values, undo restores fields', async t => {
  const { store } = await fixture(t);
  const command = { op: 'transaction', space: 'work', id: 'first', baseRevision: 0, sourceText: '王总预算8万', event: true,
    mutations: [{ kind: 'engagement', id: 'project', before: null, after: engagement() }] };
  assert.equal((await store.request(command)).ok, true);
  assert.equal((await store.request(command)).ok, true);
  assert.equal((await store.request({ op: 'stats', space: 'work' })).counts.event, 1);
  assert.equal((await store.request({ op: 'list', space: 'work', kind: 'engagement', query: '王总' })).items.length, 1);
  assert.equal((await store.request({ op: 'list', space: 'work', kind: 'engagement', query: '王', names: ['王总'] })).items.length, 1);
  const fail = await store.request({ ...command, id: 'bad', baseRevision: 1, mutations: [
    { kind: 'memory', id: 'fact', before: null, after: memory('fact') },
    { kind: 'engagement', id: 'project', before: null, after: engagement(120000) }] });
  assert.equal(fail.ok, false);
  assert.equal(await store.request({ op: 'get', space: 'work', kind: 'memory', id: 'fact' }), null);
  assert.equal((await store.request({ ...command, id: 'correct', baseRevision: 1,
    mutations: [{ kind: 'engagement', id: 'project', before: engagement(), after: engagement(120000) }] })).ok, true);
  assert.equal((await store.request({ op: 'list', space: 'work', kind: 'engagement', query: '120000' })).items[0].budgetAmount, 120000);
  assert.equal((await store.request({ op: 'list', space: 'work', kind: 'engagement', query: '80000' })).items.length, 0);
  assert.equal((await store.request({ op: 'undo', space: 'work' })).ok, true);
  assert.equal((await store.request({ op: 'get', space: 'work', kind: 'engagement', id: 'project' })).budgetAmount, 80000);
});

sqliteTest('SQLite retains over 500 events and JSONL validates completely before replacement', async t => {
  const { store, directory } = await fixture(t);
  let before = null;
  for (let i = 0; i < 505; i++) {
    const after = memory('fact', `记录${i}`);
    assert.equal((await store.request({ op: 'transaction', space: 'work', id: `edit${i}`, event: true,
      mutations: [{ kind: 'memory', id: 'fact', before, after }] })).ok, true);
    before = after;
  }
  assert.equal((await store.request({ op: 'stats', space: 'work' })).counts.event, 505);
  const backup = path.join(directory, 'archive.jsonl');
  assert.equal((await store.exportToFile(backup)).ok, true);
  assert.equal((await store.request({ op: 'undo', space: 'work' })).ok, true);
  assert.equal((await store.restoreFromFile(backup)).ok, true);
  assert.equal((await store.request({ op: 'get', space: 'work', kind: 'memory', id: 'fact' })).fact, '记录504');
  fs.appendFileSync(backup, '{broken}\n');
  assert.equal((await store.restoreFromFile(backup)).ok, false);
  assert.equal((await store.request({ op: 'get', space: 'work', kind: 'memory', id: 'fact' })).fact, '记录504');
});

sqliteTest('v3 migration is complete and idempotent, preserves old undo and survives reopening', async t => {
  const { store, directory } = await fixture(t);
  const core = await corePromise;
  const snapshot = v3({ ...core.DEFAULT_PUBLIC_SETTINGS });
  snapshot.partitions.work.messages = Array.from({ length: 230 }, (_, i) => message(`old${i}`, i));
  snapshot.partitions.work.engagements = [engagement()];
  snapshot.partitions.work.events = [{ id: 'old-event', proposalId: 'old-proposal', mode: 'work', sourceMessageId: 'old1', sourceText: '王总预算8万',
    operations: [{ target: 'engagement', entityId: 'project', before: null, after: engagement() }], createdAt: 1 }];
  snapshot.partitions.work.processedProposalIds = ['old-proposal'];
  assert.equal((await store.request({ op: 'init' })).ready, false);
  assert.equal((await store.request({ op: 'migrate', snapshot, fingerprint: 'source-v3' })).ok, true);
  assert.equal((await store.request({ op: 'migrate', snapshot, fingerprint: 'source-v3' })).already, true);
  assert.equal((await store.request({ op: 'stats', space: 'work' })).counts.message, 230);
  assert.equal((await store.request({ op: 'undo', space: 'work' })).ok, true);
  assert.equal(await store.request({ op: 'get', space: 'work', kind: 'engagement', id: 'project' }), null);
  store.close();
  const { createPersistence } = require(path.join(sourceRoot, 'electron/persistence.cjs'));
  const reopened = await createPersistence({ filePath: path.join(directory, 'archive.sqlite') });
  try {
    assert.equal((await reopened.request({ op: 'init' })).ready, true);
    assert.equal((await reopened.request({ op: 'stats', space: 'work' })).counts.message, 230);
    assert.equal((await reopened.request({ op: 'bootstrap', space: 'work' })).snapshot.partitions.work.events[0].revertedAt > 0, true);
  } finally { reopened.close(); }
});

sqliteTest('migration rejection, invalid restore, real write failure and stale previews preserve existing rows', async t => {
  const { store } = await fixture(t);
  const core = await corePromise;
  const snapshot = v3({ ...core.DEFAULT_PUBLIC_SETTINGS });
  snapshot.partitions.work.messages = [message('one')];
  snapshot.partitions.life.wallet.entries = [{ id: 'bad', title: 'bad', amount: -1, type: 'expense', category: '生活🏠', timestamp: 1 }];
  assert.equal((await store.request({ op: 'migrate', snapshot, fingerprint: 'broken' })).ok, false);
  assert.equal((await store.request({ op: 'init' })).ready, false);
  assert.equal((await store.request({ op: 'stats', space: 'work' })).total, 0);
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'first', baseRevision: 0, event: true,
    mutations: [{ kind: 'engagement', id: 'project', before: null, after: engagement() }] })).ok, true);
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'stale', baseRevision: 0, event: true,
    mutations: [{ kind: 'engagement', id: 'project', before: engagement(), after: engagement(120000) }] })).ok, false);
  assert.equal((await store.request({ op: 'restore', settings: { ...core.DEFAULT_PUBLIC_SETTINGS }, mode: 'work', records: [
    { space: 'work', kind: 'message', id: 'new', at: 1, data: message('new') },
    { space: 'work', kind: 'memory', id: 'invalid', at: 1, data: { ...memory('invalid'), mode: 'life' } },
  ] })).ok, false);
  assert.equal(await store.request({ op: 'get', space: 'work', kind: 'message', id: 'new' }), null);
  assert.equal((await store.request({ op: 'get', space: 'work', kind: 'engagement', id: 'project' })).budgetAmount, 80000);
  // A real SQLite trigger aborts the second write, after the first staged mutation.
  const Database = require('better-sqlite3');
  const failingConnection = new Database(store.filename);
  failingConnection.exec("CREATE TRIGGER fail_test BEFORE INSERT ON records WHEN NEW.id='blocked' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
  failingConnection.close();
  const failed = await store.request({ op: 'transaction', space: 'work', id: 'disk-failure', mutations: [
    { kind: 'message', id: 'partial', before: null, after: message('partial') },
    { kind: 'message', id: 'blocked', before: null, after: message('blocked') },
  ] });
  assert.equal(failed.ok, false);
  assert.equal(await store.request({ op: 'get', space: 'work', kind: 'message', id: 'partial' }), null);
});

sqliteTest('derived indexes rebuild from records and deleting a source removes its searchable row', async t => {
  const { store } = await fixture(t);
  const source = message('source', 1, '王总确认网站项目');
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'source', event: false,
    mutations: [{ kind: 'message', id: 'source', before: null, after: source }] })).ok, true);
  const Database = require('better-sqlite3');
  const connection = new Database(store.filename);
  connection.exec("DELETE FROM search_terms WHERE space='work'; DELETE FROM record_fts");
  connection.close();
  assert.equal((await store.request({ op: 'list', space: 'work', kind: 'message', query: '王总' })).items.length, 0);
  assert.equal((await store.request({ op: 'rebuildIndexes', space: 'work' })).ok, true);
  assert.equal((await store.request({ op: 'list', space: 'work', kind: 'message', query: '王总' })).items.length, 1);
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'delete-source', event: false,
    mutations: [{ kind: 'message', id: 'source', before: source, after: null }] })).ok, true);
  assert.equal((await store.request({ op: 'list', space: 'work', kind: 'message', query: '王总' })).items.length, 0);
});
