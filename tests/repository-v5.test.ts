import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../src/persistence/repository';
import type { CaptureDraft } from '../src/types';
import { makeBootstrap } from '../shared/persistence-core.mjs';
const initial = (): CaptureDraft => ({ id: 'active-work', sessionId: 'session-one', mode: 'work', text: '李总预算300元',
  sourceVersion: 1, draftVersion: 2, sourceMessageId: 'source-session-one-1', status: 'review', updatedAt: 1,
  proposal: { id: 'proposal-one', mode: 'work', sourceMessageId: 'source-session-one-1', sourceText: '李总预算300元', baseRevision: 0, createdAt: 1, warnings: [], operations: [] } });
function fixture() {
  const state = { badRefresh: false, transport: '' as ''|'after'|'before', reject: false, writes: 0, draft: initial() as CaptureDraft|null, closures: new Map<string, any>(), restored: null as any, holdCommit: null as Promise<void> | null };
  const repository = createRepository({ async request(command: any) {
    if (command.op === 'init') return { ready: true, mode: 'work' };
    if (command.op === 'bootstrap') return state.badRefresh ? { ok: false, error: 'controlled read failure' } : makeBootstrap({ mode: 'work', revisions: { life: 0, work: 0 } }, [], { space: command.space });
    if (command.op === 'saveDraft') { if (state.reject) return { ok: false, error: 'draft disk failure' }; state.draft = command.draft; return { ok: true }; }
    if (command.op === 'get') return command.kind === 'closure' ? state.closures.get(command.id) || null : command.kind === 'capture_draft' ? state.draft : null;
    if (command.op === 'commitCapture') {
      state.writes++; if (state.reject) return { ok: false, error: 'stale preview' };
      if (state.transport === 'before') throw new Error('IPC disconnected');
      const closureId = `closure-${command.proposal.id}`, eventId = `event-${command.proposal.id}`;
      state.closures.set(closureId, { id: closureId, mode: 'work', sourceMessageId: command.proposal.sourceMessageId, eventId, engagementIds: [], taskIds: [], followUpIds: [], confirmedAt: command.confirmedAt }); state.draft = null;
      if (state.holdCommit) await state.holdCommit;
      if (state.transport === 'after') throw new Error('IPC lost after commit');
      return { ok: true, closureId, eventId };
    }
    if (command.op === 'exportSnapshot') return { records: [...(state.draft ? [{ space: 'work', kind: 'capture_draft', id: state.draft.id, data: structuredClone(state.draft), at: state.draft.updatedAt }] : []),
      ...[...state.closures.values()].map(data => ({ space: 'work', kind: 'closure', id: data.id, data: structuredClone(data), at: data.confirmedAt }))],
      applied: [{ space: 'work', id: 'closed-session', signature: '', result: { ok: true }, at: 1 }], settings: makeBootstrap({}, [], { space: 'work' }).snapshot.settings, mode: 'work' };
    if (command.op === 'restore') { state.restored = command; state.draft = structuredClone(command.records.find((row: any) => row.kind === 'capture_draft')?.data || null);
      state.closures.clear(); for (const row of command.records.filter((row: any) => row.kind === 'closure')) state.closures.set(row.id, structuredClone(row.data)); return { ok: true }; }
    throw new Error(`Unexpected command ${command.op}`);
  } });
  return { repository, state };
}
test('an acknowledged capture stays committed when refreshing its view fails', async () => {
  const { repository, state } = fixture(); await repository.initialize(); state.badRefresh = true;
  assert.equal(typeof (repository as any).commitCapture, 'function');
  const result = await (repository as any).commitCapture(initial(), true);
  assert.equal(result.outcome, 'committed'); assert.equal(result.closureId, 'closure-proposal-one'); assert.ok(result.refreshWarning);
  assert.equal(state.draft, null); assert.equal(state.writes, 1);
});
test('a lost acknowledgement is reconciled by stable receipt ID and a true unknown preserves the draft', async () => {
  const { repository, state } = fixture(); await repository.initialize(); state.transport = 'after';
  assert.equal(typeof (repository as any).commitCapture, 'function');
  assert.equal((await (repository as any).commitCapture(initial(), true)).outcome, 'committed');
  const other = fixture(); await other.repository.initialize(); other.state.transport = 'before';
  assert.equal((await (other.repository as any).commitCapture(initial(), true)).outcome, 'unknown'); assert.equal(other.state.draft.text, '李总预算300元');
});
test('double confirmation shares one frozen command and rejected edits can be retried', async () => {
  const { repository, state } = fixture(); await repository.initialize();
  assert.equal(typeof (repository as any).commitCapture, 'function');
  const [a, b] = await Promise.all([(repository as any).commitCapture(initial(), true), (repository as any).commitCapture(initial(), true)]);
  assert.equal(a.closureId, b.closureId); assert.equal(state.writes, 1);
  const other = fixture(); await other.repository.initialize(); other.state.reject = true;
  assert.equal((await (other.repository as any).commitCapture(initial(), true)).outcome, 'rejected'); other.state.reject = false;
  assert.equal((await (other.repository as any).commitCapture(initial(), true)).outcome, 'committed');
});
test('draft disk failure rejects save rather than publishing a false saved state', async () => {
  const { repository, state } = fixture(); await repository.initialize(); state.reject = true;
  assert.equal(typeof (repository as any).saveCaptureDraft, 'function');
  await assert.rejects((repository as any).saveCaptureDraft(initial()), /draft disk failure/);
});
test('unknown confirmation reuses its frozen command even when current revision later changes', async () => {
  let failed = true; let firstTime: number; let commands = 0;
  const repository = createRepository({ async request(command: any) {
    if (command.op === 'init') return { ready: true, mode: 'work' };
    if (command.op === 'bootstrap') return makeBootstrap({ mode: 'work', revisions: { work: failed ? 0 : 7, life: 0 } }, [], { space: 'work' });
    if (command.op === 'get') return null;
    if (command.op === 'commitCapture') { commands++; if (failed) { firstTime = command.confirmedAt; throw new Error('lost'); }
      assert.equal(command.confirmedAt, firstTime); assert.equal(command.proposal.baseRevision, 0); return { ok: true, closureId: 'closure-proposal-source-session-one-1' }; }
  } });
  await repository.initialize(); const raw = initial(); delete raw.proposal;
  assert.equal((await repository.commitCapture(raw, true)).outcome, 'unknown');
  failed = false; await repository.refresh('work');
  assert.equal((await repository.commitCapture(raw, true)).outcome, 'committed'); assert.equal(commands, 2);
});
test('v5 web backup round trip preserves applied session markers', async () => {
  const { repository, state } = fixture(); await repository.initialize();
  const text = await repository.exportAllData(); const data = JSON.parse(text);
  assert.equal(data.version, 'looma-v5'); assert.equal(data.applied[0].id, 'closed-session');
  assert.equal(await repository.importAllData(text), true); assert.equal(state.restored.applied[0].id, 'closed-session');
});

test('restoring a pre-commit web backup lets its draft be committed again instead of reusing a past receipt', async () => {
  const { repository, state } = fixture(); await repository.initialize();
  const backup = await repository.exportAllData();
  assert.equal((await repository.commitCapture(initial(), true)).outcome, 'committed');
  assert.equal(await repository.importAllData(backup), true);
  const restored = await repository.getCaptureDraft(); assert.ok(restored);
  assert.equal((await repository.commitCapture(restored, true)).outcome, 'committed');
  assert.equal(state.writes, 2); assert.equal(state.draft, null); assert.ok(state.closures.has('closure-proposal-one'));
});

test('reloading after native restore invalidates completed capture receipts from the previous database', async () => {
  const { repository, state } = fixture(); await repository.initialize();
  assert.equal((await repository.commitCapture(initial(), true)).outcome, 'committed');
  state.closures.clear(); state.draft = initial();
  await repository.reloadAfterRestore();
  assert.equal((await repository.commitCapture((await repository.getCaptureDraft())!, true)).outcome, 'committed');
  assert.equal(state.writes, 2); assert.equal(state.draft, null);
});

test('a late acknowledgement from before restore cannot report a restored-away capture as currently committed', async () => {
  const { repository, state } = fixture(); await repository.initialize();
  const backup = await repository.exportAllData(); let release: () => void;
  state.holdCommit = new Promise<void>(resolve => { release = resolve; });
  const pending = repository.commitCapture(initial(), true);
  // Wait until the real repository has sent the command and our storage boundary has applied it.
  while (!state.writes) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await repository.importAllData(backup), true);
  release!(); const oldResult = await pending;
  assert.notEqual(oldResult.outcome, 'committed');
  assert.equal((await repository.getCaptureDraft())?.sourceMessageId, 'source-session-one-1');
  state.holdCommit = null;
  assert.equal((await repository.commitCapture((await repository.getCaptureDraft())!, true)).outcome, 'committed');
  assert.equal(state.writes, 2);
});

test('a successful restore remains successful when its following view refresh fails', async () => {
  const { repository, state } = fixture(); await repository.initialize();
  const backup = await repository.exportAllData(); await repository.commitCapture(initial(), true);
  state.badRefresh = true;
  assert.equal(await repository.importAllData(backup), true);
  assert.equal(state.draft?.sourceMessageId, 'source-session-one-1');
  assert.match(repository.getRestoreWarning() || '', /已.*恢复/);
  state.badRefresh = false; await repository.refresh('work');
  assert.equal(repository.getRestoreWarning(), undefined);
});

test('native restore reload failure retains a truthful restore warning until the current view can be read', async () => {
  const { repository, state } = fixture(); await repository.initialize(); state.badRefresh = true;
  await assert.rejects(repository.reloadAfterRestore());
  assert.equal(typeof repository.getRestoreWarning, 'function');
  assert.match(repository.getRestoreWarning() || '', /已.*恢复/);
  state.badRefresh = false; await repository.refresh('work');
  assert.equal(repository.getRestoreWarning(), undefined);
});

function settingsHarness(repository: any, electronAPI?: any) {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), ts = require('typescript'), React = require('react');
  const state: any[] = []; let index = 0;
  const react = { ...React, useEffect() {}, useState(initial: any) { const own = index++; if (!(own in state)) state[own] = initial;
    return [state[own], (value: any) => { state[own] = typeof value === 'function' ? value(state[own]) : value; }]; } };
  const filename = path.join(process.cwd(), 'src/components/SettingsModal.tsx');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, { module, exports: module.exports, window: { electronAPI }, URL, Blob, Date, setTimeout,
    require(dependency: string) {
      if (dependency === 'react') return react;
      if (dependency === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (dependency === '../persistence/repository') return { Repository: repository };
      if (dependency === '../services/legacyConnection') return { clearLegacyCredential() {} };
      return require(dependency);
    } }, { filename });
  const text = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
  const find = (node: any, predicate: (node: any) => boolean): any => !node || typeof node !== 'object' ? undefined : Array.isArray(node) ? node.map(child => find(child, predicate)).find(Boolean) : predicate(node) ? node : find(node.props?.children, predicate);
  let imported = 0;
  const render = () => { index = 0; return module.exports.SettingsModal({ isOpen: true, settings: makeBootstrap({}, [], { space: 'work' }).snapshot.settings,
    onClose() {}, onSaveSettings: async () => {}, onDataImported() { imported++; } }); };
  return { state, render, find, text, imported: () => imported };
}

test('settings report acknowledged native restore accurately even if reloading the view fails', async () => {
  const ui = settingsHarness({ reloadAfterRestore: async () => { throw new Error('controlled read failure'); }, getRestoreWarning: () => '业务资料已从备份恢复，视图暂未读取成功。' }, { importDataBackup: async () => ({ canceled: false }) });
  let tree = ui.render();
  const accepted = ui.find(tree, (node: any) => node.type === 'label' && /确认替换两个空间/.test(ui.text(node)));
  ui.find(accepted, (node: any) => node.type === 'input').props.onChange({ target: { checked: true } });
  tree = ui.render(); await ui.find(tree, (node: any) => node.type === 'button' && ui.text(node) === '校验并恢复').props.onClick();
  await new Promise(resolve => setImmediate(resolve)); tree = ui.render();
  assert.match(ui.text(tree), /已.*恢复/); assert.doesNotMatch(ui.text(tree), /当前业务数据未替换/); assert.equal(ui.imported(), 1);
});
