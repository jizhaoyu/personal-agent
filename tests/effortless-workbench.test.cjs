const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

function loadI18n(react) {
  const cache = new Map();
  const loadTs = (relPath) => {
    const abs = path.join(process.cwd(), 'src/i18n', relPath);
    if (cache.has(abs)) return cache.get(abs);
    const compiled = ts.transpileModule(fs.readFileSync(abs, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: abs,
    }).outputText;
    const mod = { exports: {} };
    cache.set(abs, mod.exports);
    vm.runInNewContext(compiled, {
      module: mod,
      exports: mod.exports,
      Date,
      Intl,
      console,
      require(dep) {
        if (dep === 'react') return react;
        if (dep === '../types') return {};
        if (dep === './store') return loadTs('store.ts');
        if (dep === './domain') return loadTs('domain.ts');
        if (dep === './zh') return loadTs('zh.ts');
        if (dep === './en') return loadTs('en.ts');
        return require(dep);
      },
    }, { filename: abs });
    return mod.exports;
  };
  return loadTs('index.ts');
}

function harness() {
  const states = [], refs = []; let index = 0, refIndex = 0;
  const react = { ...React, useEffect() {}, useRef(value) { return refs[refIndex++] ||= { current: value }; }, useState(value) { const i = index++; if (!(i in states)) states[i] = typeof value === 'function' ? value() : value; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; } };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/components/WorkBench.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText, {
    module, exports: module.exports, crypto, console,
    require(name) {
      if (name === 'react') return react;
      if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (name.endsWith('.css')) return {};
      if (name === '../i18n') return loadI18n(react);
      if (name.includes('repository')) return { Repository: { getReadIdentity: () => '' } };
      if (name.includes('aiService')) return { chinaTime: String };
      if (name.includes('projectContinuation')) return { canContinueProject: () => true };
      if (name.includes('persistence-core')) return { eventMutations: () => [] };
      return new Proxy({}, { get: () => () => null });
    },
  });
  return { render(props) { index = refIndex = 0; return module.exports.WorkBench(props); } };
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
  return predicate(node) ? node : find(node.props?.children, predicate);
}
const noop = () => {};
function props(overrides = {}) { return { work: { revision: 1, engagements: [{ id: 'existing', clientName: '陈总' }], tasks: [], followUps: [] }, pending: null, busy: false, selectedId: '', draft: { text: '今天累死了，先记着' }, draftSaveState: 'saved', home: null, closure: null, onDraftChange: noop, onContinue: noop, onResume: noop, onPropose: async () => {}, onOriginalOnly: noop, ...overrides }; }

test('existing work home offers a single free-text capture without opening a form', () => {
  const tree = harness().render(props());
  assert.ok(find(tree, n => n.type === 'textarea'));
  const binding = find(tree, n => n.type === 'details' && n.props.className === 'capture-binding');
  assert.ok(binding); assert.equal(Boolean(binding.props.open), false);
  assert.ok(find(tree, n => n.type === 'button' && n.props.children?.[0] === '整理这条记录'));
  assert.ok(find(tree, n => n.type === 'h2' && n.props.children === '记一条工作进展'));
  assert.equal(find(tree, n => n.props?.className === 'capture-example'), undefined);
});

test('empty work home example only fills the draft and focuses the composer', () => {
  const updates = [];
  let focused = false;
  const tree = harness().render(props({
    draft: null, onDraftChange: patch => updates.push(patch),
    onPropose: () => assert.fail('example must not submit'),
    onOriginalOnly: () => assert.fail('example must not save a record'),
  }));
  find(tree, n => n.type === 'textarea').props.ref.current = { focus() { focused = true; } };
  const example = find(tree, n => n.props?.className === 'capture-example');
  assert.ok(example);
  example.props.onClick();
  assert.deepEqual(updates.map(patch => patch.text), ['刚和客户确认了首页方向，周五前发新版报价。']);
  assert.equal(focused, true);
});

test('Enter submits, Shift Enter and IME candidate confirmation do not', async () => {
  let sends = 0, prevented = 0;
  const tree = harness().render(props({ onPropose: async () => { sends++; } }));
  const input = find(tree, n => n.type === 'textarea');
  assert.equal(typeof input.props.onKeyDown, 'function');
  const event = overrides => ({ key: 'Enter', shiftKey: false, nativeEvent: {}, preventDefault() { prevented++; }, ...overrides });
  input.props.onKeyDown(event({ shiftKey: true }));
  input.props.onKeyDown(event({ nativeEvent: { isComposing: true } }));
  input.props.onCompositionStart(); input.props.onKeyDown(event({})); input.props.onCompositionEnd();
  input.props.onKeyDown(event({ nativeEvent: { keyCode: 229 } }));
  assert.equal(sends, 0);
  input.props.onKeyDown(event({})); await Promise.resolve();
  assert.equal(sends, 1); assert.equal(prevented, 1);
});

test('failed asynchronous submission keeps original controlled text and offers retry', async () => {
  const updates = []; const p = props({ onDraftChange: patch => updates.push(patch), onPropose: async () => { throw Error('disk failure'); } });
  const ui = harness(); const tree = ui.render(p);
  const submit = find(tree, n => n.type === 'button' && n.props.children?.[0] === '整理这条记录');
  assert.ok(submit); await submit.props.onClick();
  const next = ui.render(p);
  assert.equal(find(next, n => n.type === 'textarea').props.value, p.draft.text);
  assert.equal(updates.length, 0);
  assert.ok(find(next, n => n.props?.role === 'alert'));
});
