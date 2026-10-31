const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const project = { id: 'practice-project', clientName: '林先生', title: '官网改版', budgetAmount: 120000, stage: '需求确认', nextAction: '周五发送首页原型', internalContext: '', shareableSummary: '', updatedAt: 2 };
const task = { id: 'practice-task', title: '发送首页原型', assignee: '我', deadline: '周五', dueAt: '2026-10-30T01:00:00.000Z', done: false, priority: 'medium', engagementId: project.id };
const waiting = { id: 'practice-waiting', kind: 'waiting', title: '客户补充品牌素材', status: 'open', engagementId: project.id, sourceMessageId: 'practice-source', createdAt: 1, updatedAt: 1, expectedDate: '2026-11-02' };
const question = { ...waiting, id: 'practice-question', kind: 'question', title: '新增页面费用未定', expectedDate: undefined };
const sourceText = '我周五发首页原型，客户下周一补品牌素材，新增页面费用还没谈定。';
const proposal = { id: 'practice-proposal', sourceMessageId: 'practice-source', sourceText, mode: 'work', baseRevision: 1, createdAt: 1, warnings: [], operations: [
  { target: 'engagement', entityId: project.id, before: null, after: project },
  { target: 'task', entityId: task.id, before: null, after: task },
  { target: 'followup', entityId: waiting.id, before: null, after: waiting },
  { target: 'followup', entityId: question.id, before: null, after: question },
] };
function editing(text = sourceText) {
  return { partition: { revision: 1, engagements: [], tasks: [], followUps: [], closures: [], events: [], messages: [], memories: [], journals: [], customCards: [], processedProposalIds: [] }, draft: { id: 'active-work', sessionId: 'practice', mode: 'work', text, sourceVersion: 1, draftVersion: 1, sourceMessageId: 'practice-source', status: 'editing', updatedAt: 1 }, closure: null, event: null, source: { id: 'practice-source', role: 'user', content: text, timestamp: 1 } };
}
function reviewed(state) { return { ...state, draft: { ...state.draft, status: 'review', proposal } }; }
function committed(state) {
  const event = { id: 'practice-event', proposalId: proposal.id, mode: 'work', sourceMessageId: 'practice-source', sourceText: state.draft.text, operations: proposal.operations, createdAt: 2 };
  const closure = { id: 'practice-closure', mode: 'work', sourceMessageId: 'practice-source', eventId: event.id, engagementIds: [project.id], taskIds: [task.id], followUpIds: [waiting.id, question.id], confirmedAt: 2 };
  return { ...state, partition: { ...state.partition, revision: 2, engagements: [project], tasks: [task], followUps: [waiting, question], closures: [closure], events: [event] }, closure, event };
}

function load(name, react = React, practice = {}) {
  const filename = path.join(process.cwd(), 'src/components', `${name}.tsx`);
  if (!fs.existsSync(filename)) return undefined;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true }, fileName: filename }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Date, Intl, console, crypto,
    require(dependency) {
      if (dependency === 'react') return react;
      if (dependency === 'lucide-react') return new Proxy({}, { get: (_target, key) => () => React.createElement('span', { 'data-icon': String(key) }) });
      if (dependency.endsWith('.css')) return {};
      if (dependency === '../services/practice') return practice;
      if (dependency === './ProposalReview') return { ProposalReview: load('ProposalReview', react, practice) };
      if (dependency === './ClosureReceipt') return { ClosureReceipt: load('ClosureReceipt', react, practice) };
      if (dependency.endsWith('persistence-core.mjs')) return { eventMutations: event => (event.operations || []).map(op => ({ kind: op.target, id: op.entityId, before: op.before, after: op.after })) };
      return require(dependency);
    },
  }, { filename });
  return module.exports[name];
}
function harness(practice) {
  const values = []; let stateIndex = 0;
  const react = { ...React, useState(initial) { const index = stateIndex++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next; }]; } };
  const component = load('PracticeModal', react, practice);
  return { render(props = { onClose() {} }) { stateIndex = 0; return component(props); } };
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.props?.children);
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return node.map(item => find(item, predicate)).find(Boolean);
  return predicate(node) ? node : find(node.props?.children, predicate);
}

test('practice modal keeps the full edit-review-receipt-project flow inside its temporary state', () => {
  const practice = {
    createPractice: () => editing(),
    revisePractice: (state, value) => editing(value),
    proposePractice: state => reviewed(state),
    editPracticeProposal: (state, next) => ({ ...state, draft: { ...state.draft, proposal: next } }),
    commitPractice: state => committed(state),
    undoPractice: state => ({ ...state, closure: { ...state.closure, revertedAt: 3 }, event: { ...state.event, revertedAt: 3 }, partition: { ...state.partition, engagements: [], tasks: [], followUps: [] } }),
  };
  const ui = harness(practice);
  let tree = ui.render();
  assert.match(text(tree), /放心练习一次/);
  assert.match(text(tree), /演练资料，仅在当前窗口临时保留，关闭后丢弃/);
  const input = find(tree, node => node.type === 'textarea' && node.props['aria-label'] === '演练沟通原文');
  input.props.onChange({ target: { value: `${sourceText}预算改为 12 万。` } });
  tree = ui.render();
  assert.match(find(tree, node => node.type === 'textarea').props.value, /预算改为 12 万/);
  find(tree, node => node.type === 'button' && text(node) === '整理并核对').props.onClick();
  tree = ui.render();
  const review = find(tree, node => node.type?.name === 'ProposalReview');
  assert.ok(review, 'proposal review is shown');
  const edited = { ...review.props.proposal, operations: review.props.proposal.operations.slice(0, 3) };
  review.props.onChange(edited);
  tree = ui.render();
  assert.equal(find(tree, node => node.type?.name === 'ProposalReview').props.proposal.operations.length, 3);
  find(tree, node => node.type?.name === 'ProposalReview').props.onConfirm();
  tree = ui.render();
  const receipt = find(tree, node => node.type?.name === 'ClosureReceipt');
  assert.ok(receipt, 'closure receipt is shown');
  assert.equal(receipt.props.practice, true);
  receipt.props.onProject(project.id);
  tree = ui.render();
  const projectView = find(tree, node => node.type?.name === 'PracticeProject');
  assert.ok(projectView, 'practice project view is shown');
  const projectTree = projectView.type(projectView.props);
  assert.match(text(projectTree), /演练项目/);
  assert.match(text(projectTree), /林先生/);
  assert.match(text(projectTree), /官网改版/);
  projectView.props.onBack();
  tree = ui.render();
  const returnedReceipt = find(tree, node => node.type?.name === 'ClosureReceipt');
  returnedReceipt.props.onUndo(returnedReceipt.props.closure.eventId);
  tree = ui.render();
  const revertedReceipt = find(tree, node => node.type?.name === 'ClosureReceipt');
  assert.ok(revertedReceipt.props.closure.revertedAt, 'undo marks only the practice receipt as reverted');
  revertedReceipt.props.onContinue();
  tree = ui.render();
  assert.ok(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === '演练沟通原文'), 'restart returns to a fresh synthetic draft');
});

test('practice modal keeps the draft visible when organizing fails and closes only through its callback', () => {
  let closed = 0;
  const ui = harness({ createPractice: () => editing(), revisePractice: (state, value) => ({ ...state, draft: { ...state.draft, text: value } }), proposePractice() { throw new Error('这段演练暂时无法整理'); } });
  let tree = ui.render({ onClose: () => closed++ });
  find(tree, node => node.type === 'button' && text(node) === '整理并核对').props.onClick();
  tree = ui.render({ onClose: () => closed++ });
  assert.match(text(tree), /这段演练暂时无法整理/);
  assert.equal(find(tree, node => node.type === 'textarea').props.value, sourceText);
  const close = find(tree, node => node.type === 'button' && node.props['aria-label'] === '关闭演练');
  close.props.onClick();
  assert.equal(closed, 1);
});

test('practice receipt names the temporary boundary and cannot prepare external material or claim notifications', () => {
  const component = load('ClosureReceipt');
  const state = committed(editing());
  let exported = 0;
  const tree = component({ closure: state.closure, source: state.source, event: state.event, engagements: [project], tasks: [task], followUps: [waiting, question], onProject() {}, onContinue() {}, onExport() { exported++; }, onUndo() {}, practice: true });
  assert.match(text(tree), /演练回执/);
  assert.match(text(tree), /演练资料，仅在当前窗口临时保留，关闭后丢弃/);
  assert.match(text(tree), /演练不会发送通知/);
  assert.doesNotMatch(text(tree), /退出后不提醒/);
  const external = find(tree, node => node.type === 'button' && /纪要/.test(text(node)));
  assert.equal(external.props.disabled, true);
  external.props.onClick?.();
  assert.equal(exported, 0);
});
