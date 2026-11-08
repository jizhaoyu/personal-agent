const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = process.env.LOOMA_SOURCE_ROOT || process.cwd();

test('SQLite project continuity pages, field evidence, deletion and undo use the real persistence backend', { skip: process.env.LOOMA_NATIVE_TEST !== '1' }, async t => {
  const core = await import(pathToFileURL(path.join(root, 'shared/persistence-core.mjs')).href);
  const ts = require('typescript');
  const filename = path.join(root, 'src/services/projectContinuation.ts');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require: name => { assert.ok(name.endsWith('persistence-core.mjs')); return core; }, JSON, Error, Map, Set }, { filename });
  const { loadProjectContinuation, loadContinuationPage, loadFieldEvidence } = module.exports;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-continuation-native-'));
  const store = await require(path.join(root, 'electron/persistence.cjs')).createPersistence({ filePath: path.join(directory, 'test.sqlite') });
  t.after(() => { store.close(); if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('looma-continuation-native-')) throw new Error('unsafe cleanup'); fs.rmSync(directory, { recursive: true, force: true }); });
  const project = { id: 'np', clientName: '合成客户', title: '原生接续', stage: '需求确认', budgetAmount: 300, internalContext: '内部备注', shareableSummary: '', nextAction: '', updatedAt: 1 };
  const tasks = Array.from({ length: 62 }, (_, i) => ({ id: `nt${i}`, engagementId: 'np', title: `合成行动${i}`, assignee: '我', deadline: '', priority: 'medium', done: i > 30 }));
  const proposal = { id: 'native-continuation', mode: 'work', sourceMessageId: 'native-source', sourceText: '合成原文预算300元', baseRevision: 0, createdAt: 1, warnings: [], operations: [
    { target: 'engagement', entityId: 'np', before: null, after: project }, ...tasks.map(task => ({ target: 'task', entityId: task.id, before: null, after: task })),
  ] };
  const draft = { id: 'active-work', mode: 'work', sessionId: 'native-session', text: proposal.sourceText, sourceVersion: 1, draftVersion: 1, sourceMessageId: proposal.sourceMessageId, proposal, status: 'review', updatedAt: 1 };
  assert.equal((await store.request({ op: 'saveDraft', space: 'work', draft })).ok, true);
  const saved = await store.request({ op: 'commitCapture', space: 'work', draftSessionId: draft.sessionId, proposal, confirmedAt: 2 });
  assert.equal(saved.ok, true);
  const reader = {
    get: (space, kind, id) => store.request({ op: 'get', space, kind, id }),
    query: (space, kind, options) => store.request({ op: 'list', space, kind, ...options }),
  };
  const view = await loadProjectContinuation(reader, 'np'); assert.equal(view.tasks.items.length, 25); assert.ok(view.tasks.nextCursor);
  const ids = new Set(view.tasks.items.map(t => t.id)); let cursor = view.tasks.nextCursor;
  while (cursor) { const page = await loadContinuationPage(reader, 'np', 'task', cursor); page.items.forEach(t => ids.add(t.id)); cursor = page.nextCursor; }
  assert.equal(ids.size, 62);
  const target = { kind: 'engagement', id: 'np', field: 'budgetAmount', label: '预算' };
  let evidence = await loadFieldEvidence(reader, 'np', target);
  assert.equal(evidence.entries[0].original, '合成原文预算300元'); assert.equal(evidence.entries[0].matchesCurrent, true);
  const source = await reader.get('work', 'message', proposal.sourceMessageId);
  assert.equal((await store.request({ op: 'transaction', space: 'work', id: 'delete-native-source', event: false, redactSourceIds: [source.id], mutations: [{ kind: 'message', id: source.id, before: source, after: null }] })).ok, true);
  evidence = await loadFieldEvidence(reader, 'np', target); assert.equal(evidence.entries[0].original, null);
  assert.equal((await store.request({ op: 'undo', space: 'work', eventId: saved.eventId })).ok, true);
  assert.equal((await reader.get('work', 'closure', saved.closureId)).revertedAt > 0, true);
  assert.equal(await reader.get('work', 'message', source.id), null);
});
