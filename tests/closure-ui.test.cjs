const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(name, react = React, repository = { query: async () => ({ items: [], nextCursor: null }), get: async () => null }) {
  const filename = path.join(process.cwd(), 'src/components', `${name}.tsx`);
  if (!fs.existsSync(filename)) return undefined;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
  }, fileName: filename }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Date, Intl, console, crypto, get window() { return globalThis.window; },
    require(dependency) {
      if (dependency === 'react') return react;
      // Icons are decorative here; Node's CJS runner cannot load this package's mixed ESM entry.
      if (dependency === 'lucide-react') return new Proxy({}, { get: (_target, name) => () => React.createElement('span', { 'data-icon': String(name) }) });
      if (dependency.endsWith('.css')) return {};
      if (dependency === '../persistence/repository') return { Repository: repository };
      if (dependency === './ProposalReview') return { ProposalReview: load('ProposalReview', react, repository) };
      if (dependency === './ClosureReceipt') return { ClosureReceipt: load('ClosureReceipt', react, repository) };
      if (dependency === './ProjectContinuation') return { ProjectContinuation: load('ProjectContinuation', react, repository) };
      if (dependency === '../services/projectContinuation') {
        const file = path.join(process.cwd(), 'src/services/projectContinuation.ts');
        const compiledService = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: file }).outputText;
        const m = { exports: {} };
        vm.runInNewContext(compiledService, { module: m, exports: m.exports, console, require(dep) {
          if (dep.includes('persistence-core.mjs')) return require('../shared/persistence-core.mjs');
          return require(dep);
        } });
        return m.exports;
      }
      if (dependency === '../services/artifacts') {
        const file = path.join(process.cwd(), 'src/services/artifacts.ts');
        const compiledService = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: file }).outputText;
        const m = { exports: {} };
        vm.runInNewContext(compiledService, { module: m, exports: m.exports, Date, console, crypto, require(dep) {
          if (dep === './storage') return { newId: prefix => `${prefix}-${crypto.randomUUID()}` };
          return require(dep);
        } });
        return m.exports;
      }
      if (dependency === '../services/conditionIntents') {
        const file = path.join(process.cwd(), 'src/services/conditionIntents.ts');
        const compiledService = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: file }).outputText;
        const m = { exports: {} };
        vm.runInNewContext(compiledService, { module: m, exports: m.exports, Date, console, crypto, require(dep) {
          if (dep === './storage') return { newId: prefix => `${prefix}-${crypto.randomUUID()}` };
          if (dep.includes('persistence-core.mjs')) return require('../shared/persistence-core.mjs');
          return require(dep);
        } });
        return m.exports;
      }
      if (dependency === '../services/aiService') return { chinaTime: value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), getDueTasks: tasks => tasks.filter(t => !t.done && Date.parse(t.dueAt) <= Date.now()) };
      if (dependency === '../services/legacyConnection') return { clearLegacyCredential: () => true };
      if (dependency === '../services/todos') return { TodoService: { capabilities: async () => ({ background: false, notifications: 'unsupported', exactAlarms: 'unsupported', enabled: false }), requestPermissions: async () => ({ background: false, notifications: 'unsupported', exactAlarms: 'unsupported', enabled: false }) } };
      if (dependency.endsWith('persistence-core.mjs')) return { eventMutations: event => event.mutations || (event.operations || []).map(op => ({ kind: op.target, id: op.entityId, before: op.before, after: op.after })) };
      return require(dependency);
    },
  }, { filename });
  return module.exports[name];
}
function harness(name, repository) {
  const values = [], refs = []; let stateIndex = 0, refIndex = 0; let effects = [];
  const react = { ...React,
    useState(initial) { const index = stateIndex++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; },
    useRef(initial) { const index = refIndex++; return refs[index] ||= { current: initial }; },
    useEffect(effect) { effects.push(effect); },
  };
  const component = load(name, react, repository);
  assert.equal(typeof component, 'function');
  return { render(props) { stateIndex = 0; refIndex = 0; effects = []; return component(props); }, async effects() { for (const effect of effects) effect(); await new Promise(resolve => setImmediate(resolve)); } };
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.props?.children);
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return node.map(value => find(value, predicate)).find(Boolean);
  return predicate(node) ? node : find(node.props?.children, predicate);
}
const project = { id: 'project', clientName: '张三', title: '官网改版', budgetAmount: 80000, stage: '需求确认', nextAction: '', internalContext: '内部底价不默认展示', shareableSummary: '', updatedAt: 1 };
const task = { id: 'task', title: '发送首页原型', assignee: '我', deadline: '周五', dueAt: '2026-10-30T01:00:00Z', done: false, priority: 'medium', engagementId: project.id };
const waiting = { id: 'waiting', kind: 'waiting', title: '补充品牌素材', status: 'open', engagementId: project.id, sourceMessageId: 'source', createdAt: 1, updatedAt: 1, expectedDate: '2026-11-02', sourceDateText: '下周一' };
const question = { ...waiting, id: 'question', kind: 'question', title: '新增页面费用尚未谈定', expectedDate: undefined, sourceDateText: undefined };
const work = { revision: 1, engagements: [project], tasks: [task], followUps: [waiting, question], closures: [], events: [], messages: [], memories: [], journals: [], customCards: [], processedProposalIds: [] };
const draft = { id: 'active-work', sessionId: 'session', mode: 'work', text: '我周五发原型，客户下周一补素材，新增页面费用未定。', sourceVersion: 1, draftVersion: 1, sourceMessageId: 'source', status: 'editing', updatedAt: 1 };
const proposal = { id: 'proposal', sourceMessageId: 'source', sourceText: draft.text, mode: 'work', baseRevision: 1, createdAt: 1, warnings: [], operations: [
  { target: 'engagement', entityId: project.id, before: project, after: { ...project, budgetAmount: 120000, updatedAt: 2 } },
  { target: 'task', entityId: task.id, before: null, after: task },
  { target: 'followup', entityId: waiting.id, before: null, after: waiting },
  { target: 'followup', entityId: question.id, before: null, after: question },
] };
const noop = () => {};
function props(overrides = {}) { return { work, pending: null, busy: false, selectedId: '', onSelect: noop, onPropose: async () => {}, onChange: noop, onConfirm: noop, onDiscard: noop, onReparse: noop, onManual: noop, onUndo: noop, onExport: noop, modelEnabled: false, onCancel: noop,
  draft, draftSaveState: 'saved', home: null, closure: null, onDraftChange: noop, onContinue: noop, onResume: noop, onOriginalOnly: noop, onRebase: noop, onResolveConflict: noop, onSetItemState: async () => {}, onUndoEvent: noop, onOpenMemory: noop, ...overrides }; }

test('continuation home keeps each group bounded and separates waiting from own overdue work', () => {
  const component = load('WorkBench'); assert.equal(typeof component, 'function');
  const home = { draft, today: Array.from({ length: 5 }, (_, i) => ({ ...task, id: `today-${i}`, title: `今日事项${i}` })), overdue: [], waiting: [waiting], questions: [question], recent: [], counts: { today: 5, overdue: 0, waiting: 1, questions: 1 } };
  const markup = renderToStaticMarkup(React.createElement(component, props({ home })));
  assert.match(markup, /今日事项0/); assert.match(markup, /今日事项2/); assert.doesNotMatch(markup, /今日事项3/);
  assert.match(markup, /补充品牌素材/); assert.match(markup, /新增页面费用尚未谈定/);
  assert.doesNotMatch(markup, /最近沟通|暂无/);
});
test('work home uses one empty summary and keeps draft and overdue entry points', () => {
  const component = load('WorkBench');
  const emptyHome = { today: [], overdue: [], waiting: [], questions: [], recent: [], counts: { today: 0, overdue: 0, waiting: 0, questions: 0 } };
  const emptyWork = { ...work, engagements: [], tasks: [], followUps: [] };
  const render = overrides => renderToStaticMarkup(React.createElement(component, props({ work: emptyWork, home: emptyHome, draft: null, ...overrides })));
  const empty = render();
  assert.match(empty, /第一条记录保存后/);
  assert.equal((empty.match(/class="home-summary-empty"/g) || []).length, 1);
  assert.doesNotMatch(empty, /今日暂无待办行动|暂无等待客户事项|暂无未定事项|暂无最近沟通记录/);
  assert.match(render({ draft }), /继续整理.*第一条记录保存后/);
  assert.match(render({ work }), /目前没有需要跟进的工作/);
  const loading = render({ home: null });
  assert.match(loading, /读取中/); assert.doesNotMatch(loading, /class="home-summary-empty"/);
  const overdue = render({ draft, home: { ...emptyHome, overdue: [task], counts: { ...emptyHome.counts, overdue: 1 } } });
  assert.match(overdue, /继续整理/); assert.match(overdue, /逾期未完/);
  assert.doesNotMatch(overdue, /class="home-summary-empty"|今天要处理|最近沟通/);
});
test('capture input is controlled by the persistent draft and edits are handed to the draft owner', () => {
  const updates = []; const ui = harness('WorkBench'); let tree = ui.render(props({ onDraftChange: patch => updates.push(patch) }));
  const begin = find(tree, node => node.type === 'button' && /记下刚才|记下一段|继续整理/.test(text(node)));
  if (begin) begin.props.onClick();
  tree = ui.render(props({ onDraftChange: patch => updates.push(patch) }));
  const input = find(tree, node => node.type === 'textarea' && node.props['aria-label'] === '客户沟通记录');
  assert.ok(input); assert.equal(input.props.value, draft.text);
  input.props.onChange({ target: { value: '修改后的真实输入' } });
  assert.equal(updates.at(-1).text, '修改后的真实输入');
  const remount = harness('WorkBench'); let restored = remount.render(props({ draft: { ...draft, text: '重开后恢复的输入' } }));
  const resume = find(restored, node => node.type === 'button' && /记下刚才|记下一段|继续整理/.test(text(node))); if (resume) resume.props.onClick();
  restored = remount.render(props({ draft: { ...draft, text: '重开后恢复的输入' } }));
  assert.equal(find(restored, node => node.type === 'textarea' && node.props['aria-label'] === '客户沟通记录').props.value, '重开后恢复的输入');
});
test('starting a practice uses its own entry without replacing the real draft', () => {
  let practices = 0; const patches = [];
  const ui = harness('WorkBench'); const input = props({ onPractice: () => practices++, onDraftChange: patch => patches.push(patch) });
  let tree = ui.render(input); find(tree, node => node.type === 'button' && text(node) === '随心记下').props.onClick();
  tree = ui.render(input);
  const entry = find(tree, node => node.type === 'button' && /放心练习一次/.test(text(node)));
  assert.ok(entry); entry.props.onClick();
  assert.equal(practices, 1); assert.deepEqual(patches, []); assert.equal(input.draft.text, draft.text);
});
test('a definite task completion saves directly and leaves the user in the action list', async () => {
  const calls = []; let manualCalls = 0;
  const ui = harness('WorkBench', { query: async (_space, kind) => ({ items: kind === 'task' ? [task] : [project], nextCursor: null }), get: async () => null });
  const input = props({ onSetItemState: async (...args) => calls.push(args), onManual: () => manualCalls++ });
  let tree = ui.render(input); find(tree, node => node.type === 'button' && text(node) === '项目').props.onClick();
  tree = ui.render(input);
  const projectNav = find(tree, node => node.props?.className === 'work-sub-nav');
  const actions = find(projectNav, node => node.type === 'button' && text(node) === '项目行动');
  assert.ok(actions);
  actions.props.onClick();
  tree = ui.render(input); await ui.effects(); tree = ui.render(input);
  const complete = find(tree, node => node.type === 'button' && node.props['aria-label'] === '完成发送首页原型'); assert.ok(complete);
  await complete.props.onClick(); tree = ui.render(input);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'task'); assert.equal(calls[0][1].id, task.id); assert.equal(calls[0][2], true);
  assert.equal(manualCalls, 0);
  const activeTab = find(tree, node => node.type === 'button' && node.props.className === 'sub-tab active');
  assert.equal(text(activeTab), '项目行动');
  assert.ok(find(tree, node => node.type === 'button' && node.props['aria-label'] === '完成发送首页原型'));
});
test('review groups known changes, own actions, waiting and questions without inventing a client time', () => {
  const component = load('ProposalReview'); assert.equal(typeof component, 'function');
  const markup = renderToStaticMarkup(React.createElement(component, { proposal, engagements: [project], onChange: noop, onConfirm: noop, onDiscard: noop, onReparse: noop }));
  for (const expected of ['本次核对内容', '我方下一步', '等待客户', '仍待确认', '80000', '120000', '补充品牌素材', '新增页面费用尚未谈定']) assert.ok(markup.includes(expected), expected);
  assert.match(markup, /2026-11-02/); assert.doesNotMatch(markup, /2026-11-02[^<]{0,30}09:00/);
});
test('unresolved rebase conflicts block confirmation and expose the actual field choices', () => {
  const changes = []; const component = load('ProposalReview');
  const tree = component({ proposal, engagements: [project], conflicts: [{ id: 'budget-conflict', target: 'engagement', entityId: project.id, field: 'budgetAmount', original: 80000, current: 100000, proposed: 120000 }], onResolveConflict: (...args) => changes.push(args), onChange: noop, onConfirm: noop, onDiscard: noop, onReparse: noop });
  const confirm = find(tree, node => node.type === 'button' && /确认并保存|确认收尾/.test(text(node))); assert.equal(confirm.props.disabled, true);
  const keep = find(tree, node => node.type === 'button' && /保留当前/.test(text(node))); assert.ok(keep); keep.props.onClick();
  assert.deepEqual(changes[0], ['budget-conflict', 'current']); assert.match(text(tree), /100000/);
  assert.match(text(tree), /先解决.*冲突.*再保存/);
});
test('review summarizes operations and hides empty categories and routine editors', () => {
  const component = load('ProposalReview');
  const tree = component({ proposal: { ...proposal, operations: proposal.operations.filter(op => op.target === 'task') }, engagements: [project], onChange: noop, onConfirm: noop, onDiscard: noop, onReparse: noop });
  assert.match(text(find(tree, node => node.props?.className === 'review-overview')), /新增 1 条行动/);
  assert.equal(find(tree, node => node.props?.['aria-label'] === '等待客户'), undefined);
  const editor = find(tree, node => node.type === 'details' && node.props.className === 'review-item-editor');
  assert.ok(editor);
  assert.equal(editor.props.open, undefined);
});
test('review surfaces project clarification and keeps confirm disabled', () => {
  const component = load('ProposalReview');
  const tree = component({ proposal: { ...proposal, clarification: { kind: 'project', message: '同客户有两个项目，请选择归属。' } }, engagements: [project], onChange: noop, onConfirm: noop, onDiscard: noop, onReparse: noop });
  assert.match(text(find(tree, node => node.props?.className === 'review-blockers')), /同客户有两个项目/);
  assert.equal(find(tree, node => node.type === 'button' && /确认并保存/.test(text(node))).props.disabled, true);
});
test('a persisted closure remains an internal receipt with open work and an explicit reminder boundary', () => {
  const component = load('ClosureReceipt'); assert.equal(typeof component, 'function');
  const closure = { id: 'closure', mode: 'work', sourceMessageId: 'source', eventId: 'event', engagementIds: [project.id], taskIds: [task.id], followUpIds: [waiting.id, question.id], confirmedAt: 1 };
  const markup = renderToStaticMarkup(React.createElement(component, { closure, event: { id: 'event', mutations: proposal.operations.map(op => ({ kind: op.target, id: op.entityId, before: op.before, after: op.after })) }, source: { id: 'source', content: draft.text, role: 'user', timestamp: 1 }, engagements: [project], tasks: [task], followUps: [waiting, question], onProject: noop, onContinue: noop, onExport: noop, onUndo: noop }));
  assert.match(markup, /补充品牌素材/); assert.match(markup, /新增页面费用尚未谈定/); assert.match(markup, /退出后不提醒/);
  assert.doesNotMatch(markup, /全部完成|已达成共识|内部底价不默认展示/);
  for (const action of ['查看项目', '继续记录', '准备纪要']) assert.ok(markup.includes(action));
});
test('an original-only closure never claims to have changed business records or scheduled a reminder', () => {
  const component = load('ClosureReceipt'); assert.equal(typeof component, 'function');
  const markup = renderToStaticMarkup(React.createElement(component, { closure: { id: 'original', mode: 'work', sourceMessageId: 'source', eventId: 'event', engagementIds: [], taskIds: [], followUpIds: [], confirmedAt: 1, originalOnly: true }, engagements: [], tasks: [], followUps: [], onProject: noop, onContinue: noop, onExport: noop, onUndo: noop }));
  assert.match(markup, /仅保存原文/); assert.match(markup, /未更新项目或安排提醒/);
});
test('a task-only historical receipt never attributes the current project budget to that past conversation', () => {
  const component = load('ClosureReceipt');
  const markup = renderToStaticMarkup(React.createElement(component, {
    closure: { id: 'past', mode: 'work', sourceMessageId: 'source', eventId: 'event', engagementIds: [project.id], taskIds: [task.id], followUpIds: [], confirmedAt: 1 },
    event: { id: 'event', mutations: [{ kind: 'task', id: task.id, before: null, after: task }] },
    engagements: [{ ...project, budgetAmount: 120000 }], tasks: [task], followUps: [], onProject: noop, onContinue: noop, onExport: noop,
  }));
  assert.match(markup, /发送首页原型/); assert.doesNotMatch(markup, /120,?000|当前进展/);
});
test('a deleted historical event is shown as unavailable rather than reconstructed from current rows', () => {
  const component = load('ClosureReceipt');
  const markup = renderToStaticMarkup(React.createElement(component, {
    closure: { id: 'past', mode: 'work', sourceMessageId: 'source', eventId: 'deleted', engagementIds: [project.id], taskIds: [task.id], followUpIds: [], confirmedAt: 1 },
    engagements: [{ ...project, budgetAmount: 120000 }], tasks: [task], followUps: [], onProject: noop, onContinue: noop, onExport: noop,
  }));
  assert.match(markup, /本次变更依据已删除或暂不可用/); assert.doesNotMatch(markup, /120,?000|发送首页原型/);
});
test('a large receipt loads every explicitly referenced row in bounded batches', async () => {
  const calls = [];
  const ids = Array.from({ length: 205 }, (_, index) => `action-${index}`);
  const ui = harness('WorkBench', {
    get: async () => null,
    query: async (_space, kind, options) => {
      calls.push({ kind, ...options });
      return { items: (options.ids || []).map(id => ({ ...task, id })), nextCursor: null };
    },
  });
  const input = props({ closure: { id: 'large', mode: 'work', sourceMessageId: 'source', eventId: 'event', engagementIds: [], taskIds: ids, followUpIds: [], confirmedAt: 1 } });
  ui.render(input); await ui.effects(); const tree = ui.render(input);
  const receipt = find(tree, node => node.type?.name === 'ClosureReceipt');
  assert.ok(receipt); assert.equal(receipt.props.tasks.length, 205);
  assert.ok(calls.filter(call => call.kind === 'task').every(call => call.ids.length <= 200));
});

test('equal-revision restore invalidates project cards before old rows can be exported', async () => {
  let identity = 'before', notify;
  const ui = harness('WorkBench', {
    getReadIdentity: () => identity, subscribe: listener => { notify = listener; return () => {}; },
    get: async () => null,
    query: async () => ({ items: [{ ...project, title: identity === 'before' ? '恢复前项目' : '恢复后项目' }], nextCursor: null }),
  });
  const input = props(); let tree = ui.render(input);
  find(tree, node => node.type === 'button' && text(node) === '项目').props.onClick();
  ui.render(input); await ui.effects(); tree = ui.render(input); assert.match(text(tree), /恢复前项目/);
  assert.equal(typeof notify, 'function'); identity = 'after'; notify(); tree = ui.render(input);
  assert.doesNotMatch(text(tree), /恢复前项目/);
  await ui.effects(); tree = ui.render(input); assert.match(text(tree), /恢复后项目/);
});
test('freshly read project metadata replaces the opened copy in capture options', async () => {
  const ui = harness('WorkBench', { get: async () => project, query: async () => ({ items: [project], nextCursor: null }) });
  const input = props({ draft: { ...draft, text: '', selectedEngagementId: project.id } });
  let tree = ui.render(input); find(tree, node => node.type === 'button' && text(node) === '项目').props.onClick();
  ui.render(input); await ui.effects(); tree = ui.render(input);
  find(tree, node => node.type === 'button' && text(node) === '详情').props.onClick(); tree = ui.render(input);
  const continuation = find(tree, node => node.type?.name === 'ProjectContinuation'); assert.ok(continuation);
  assert.equal(typeof continuation.props.onProjectLoaded, 'function');
  continuation.props.onProjectLoaded({ ...project, clientName: '更新后的客户' });
  continuation.props.onContinueProject(project.id); tree = ui.render(input);
  const select = find(tree, node => node.type === 'select' && node.props['aria-label'] === '目标项目');
  assert.match(text(select), /更新后的客户/); assert.doesNotMatch(text(select), /张三/);
});
test('work summary items display linked project and open project continuation in one click', () => {
  const ui = harness('WorkBench', { get: async () => project, query: async () => ({ items: [project], nextCursor: null }) });
  const home = { draft: null, today: [task], overdue: [], waiting: [waiting], questions: [question], recent: [], counts: { today: 1, overdue: 0, waiting: 1, questions: 1 } };
  let tree = ui.render(props({ home, draft: null }));
  const waitingCard = find(tree, node => node.type === 'article' && String(node.props?.className || '').includes('followup-row'));
  assert.ok(waitingCard);
  assert.match(text(waitingCard), /张三 · 官网改版/);
  const openBtn = find(waitingCard, node => node.type === 'button' && text(node) === '查看项目');
  assert.ok(openBtn);
  openBtn.props.onClick();
  tree = ui.render(props({ home, draft: null }));
  const continuation = find(tree, node => node.type?.name === 'ProjectContinuation');
  assert.ok(continuation);
  assert.equal(continuation.props.projectId, project.id);
});

test('ProposalReview does not treat artifact drafts as editable memory facts', () => {
  const ProposalReview = load('ProposalReview');
  const artifact = { id: 'artifact', projectId: project.id, title: '报价草稿', content: '待核对内容' };
  const tree = ProposalReview({ proposal: { ...proposal, operations: [
    { target: 'artifact', entityId: artifact.id, before: null, after: artifact },
  ] }, engagements: [project], onChange: noop, onConfirm: noop, onDiscard: noop, onReparse: noop });
  assert.doesNotMatch(text(tree), /待记住的工作事实/);
});

test('ProposalReview and WorkBench render and manage M2 ConditionIntent candidates and ready highlights', async () => {
  const ProposalReview = load('ProposalReview');
  const cond = {
    id: 'cond-1',
    space: 'work',
    conditionText: '陈总把首页素材发过来',
    actionTitle: '整理第二版报价',
    conditionKind: 'followup_resolved',
    status: 'watching',
    engagementId: project.id,
    followUpId: waiting.id,
    sourceMessageId: 'msg-1',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  let changed = null;
  const reviewProposal = {
    id: 'prop-cond',
    mode: 'work',
    sourceMessageId: 'msg-1',
    sourceText: '等陈总把首页素材发过来后，再整理第二版报价',
    summary: '整理条件意图',
    warnings: [],
    operations: [
      { target: 'followup', entityId: waiting.id, before: null, after: waiting },
      { target: 'condition', entityId: cond.id, before: null, after: cond },
    ],
  };
  const reviewTree = ProposalReview({
    proposal: reviewProposal,
    engagements: [project],
    onChange: next => { changed = next; },
    onConfirm: noop,
    onDiscard: noop,
    onReparse: noop,
  });
  assert.match(text(reviewTree), /条件跟进/);
  assert.match(text(reviewTree), /陈总把首页素材发过来/);
  assert.match(text(reviewTree), /整理第二版报价/);
  const actionInput = find(reviewTree, node => node.type === 'input' && node.props['aria-label'] === '满足后下一步 2');
  assert.ok(actionInput);
  actionInput.props.onChange({ target: { value: '整理第三版报价' } });
  assert.equal(changed.operations[1].after.actionTitle, '整理第三版报价');

  const readyCond = { ...cond, status: 'ready', revision: 2, triggeredAt: 2, updatedAt: 2 };
  const actionsCalled = [];
  const ui = harness('WorkBench', { get: async () => project, query: async () => ({ items: [project], nextCursor: null }) });
  const home = {
    draft: null,
    today: [],
    overdue: [],
    waiting: [],
    questions: [],
    conditions: [readyCond],
    recent: [],
    counts: { today: 0, overdue: 0, waiting: 0, questions: 0 },
  };
  const tree = ui.render(props({
    home,
    draft: null,
    onSetConditionState: async (item, action) => { actionsCalled.push({ id: item.id, action }); },
  }));
  const readySection = find(tree, node => node.type === 'section' && node.props['aria-label'] === '条件已就绪');
  assert.ok(readySection);
  assert.match(text(readySection), /条件已就绪，可推进/);
  const convertBtn = find(readySection, node => node.type === 'button' && text(node) === '转为项目行动');
  assert.ok(convertBtn);
  await convertBtn.props.onClick();
  assert.deepEqual(actionsCalled, [{ id: 'cond-1', action: 'convert_to_task' }]);
});

test('US09 hides proactive ready-condition banners when workSuggestionsEnabled is false without deleting conditions and supports prepare-artifact CTA when enabled', async () => {
  const readyCond = {
    id: 'cond-ready',
    space: 'work',
    conditionText: '陈总确认预算方向',
    actionTitle: '准备正式报价方案',
    conditionKind: 'manual_confirm',
    status: 'ready',
    engagementId: project.id,
    sourceMessageId: 'msg-1',
    revision: 2,
    triggeredAt: 2,
    createdAt: 1,
    updatedAt: 2,
  };
  const home = {
    draft: null,
    today: [],
    overdue: [],
    waiting: [],
    questions: [],
    conditions: [readyCond],
    recent: [],
    counts: { today: 0, overdue: 0, waiting: 0, questions: 0 },
  };
  let prepared = null;
  const ui = harness('WorkBench', {
    get: async () => project,
    query: async (_space, kind) => ({ items: kind === 'condition' ? [readyCond] : kind === 'engagement' ? [project] : [], nextCursor: null }),
  });

  // When disabled, ready-condition highlight section is hidden on home, and CTA is absent there.
  let tree = ui.render(props({ home, draft: null, workSuggestionsEnabled: false }));
  assert.equal(find(tree, node => node.type === 'section' && node.props['aria-label'] === '条件已就绪'), undefined);
  assert.doesNotMatch(text(tree), /准备交付草稿/);

  // Opening project continuation still keeps the underlying ConditionIntent visible under 条件跟进.
  find(tree, node => node.type === 'button' && text(node) === '项目').props.onClick();
  tree = ui.render(props({ home, draft: null, workSuggestionsEnabled: false }));
  await ui.effects();
  tree = ui.render(props({ home, draft: null, workSuggestionsEnabled: false }));
  find(tree, node => node.type === 'button' && text(node) === '详情').props.onClick();
  tree = ui.render(props({ home, draft: null, workSuggestionsEnabled: false }));
  const embeddedContinuation = find(tree, node => node.type?.name === 'ProjectContinuation');
  assert.ok(embeddedContinuation);
  assert.equal(embeddedContinuation.props.workSuggestionsEnabled, false);

  const contUi = harness('ProjectContinuation', {
    getReadIdentity: () => 'stable:1',
    subscribe: () => () => {},
    get: async () => project,
    query: async (_space, kind) => ({ items: kind === 'condition' ? [readyCond] : [], nextCursor: null }),
  });
  let contTree = contUi.render({
    projectId: project.id,
    revision: 1,
    draft: null,
    busy: false,
    workSuggestionsEnabled: false,
    onContinueProject: noop,
    onResumeDraft: noop,
    onEdit: noop,
    onClose: noop,
    onOpenClosure: noop,
    renderTask: item => React.createElement('div', { key: item.id }, item.title),
    renderFollowUp: item => React.createElement('div', { key: item.id }, item.title),
  });
  await contUi.effects();
  contTree = contUi.render({
    projectId: project.id,
    revision: 1,
    draft: null,
    busy: false,
    workSuggestionsEnabled: false,
    onContinueProject: noop,
    onResumeDraft: noop,
    onEdit: noop,
    onClose: noop,
    onOpenClosure: noop,
    renderTask: item => React.createElement('div', { key: item.id }, item.title),
    renderFollowUp: item => React.createElement('div', { key: item.id }, item.title),
  });
  assert.doesNotMatch(text(contTree), /条件已就绪，可推进/);
  assert.match(text(contTree), /条件跟进/);
  assert.match(text(contTree), /陈总确认预算方向/);

  // When enabled, ready condition exposes 准备交付草稿 bridge action.
  const uiEnabled = harness('WorkBench', {
    get: async () => project,
    query: async (_space, kind) => ({ items: kind === 'condition' ? [readyCond] : kind === 'engagement' ? [project] : [], nextCursor: null }),
  });
  let enabledTree = uiEnabled.render(props({
    home,
    draft: null,
    workSuggestionsEnabled: true,
    onPrepareArtifactFromCondition: cond => { prepared = cond; },
  }));
  const prepBtn = find(enabledTree, node => node.type === 'button' && text(node) === '准备交付草稿');
  assert.ok(prepBtn, '就绪条件开启主动建议时应显示准备交付草稿入口');
  prepBtn.props.onClick();
  assert.equal(prepared?.id, 'cond-ready');
});

test('US09 SettingsModal manages workSuggestionsEnabled independently of remindersEnabled', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  try {
    let saved = null;
    const ui = harness('SettingsModal');
    const baseSettings = {
      apiBaseUrl: 'https://api.deepseek.com/v1',
      modelName: 'deepseek-chat',
      personaName: 'Looma',
      personaAvatar: '✨',
      personaGreeting: 'hi',
      systemPrompt: 'prompt',
      alwaysOnTop: false,
      remindersEnabled: true,
    };
    let tree = ui.render({
      isOpen: true,
      settings: baseSettings,
      onClose: noop,
      onSaveSettings: async s => { saved = s; },
      onDataImported: noop,
    });
    const suggestionLabel = find(tree, node => node.type === 'label' && /工作台主动建议/.test(text(node)));
    assert.ok(suggestionLabel, 'SettingsModal 应包含工作台主动建议独立开关');
    const checkbox = find(suggestionLabel, node => node.type === 'input' && node.props.type === 'checkbox');
    assert.equal(checkbox.props.checked, true);
    checkbox.props.onChange({ target: { checked: false } });
    tree = ui.render({
      isOpen: true,
      settings: baseSettings,
      onClose: noop,
      onSaveSettings: async s => { saved = s; },
      onDataImported: noop,
    });
    const saveBtn = find(tree, node => node.type === 'button' && text(node) === '保存设置');
    await saveBtn.props.onClick();
    assert.equal(saved.workSuggestionsEnabled, false);
    assert.equal(saved.remindersEnabled, true);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  }
});
