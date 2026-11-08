const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function harness(reader) {
  const filename = path.join(process.cwd(), 'src/components/ProjectContinuation.tsx');
  assert.ok(fs.existsSync(filename), '项目接续组件尚未实现');
  const values = [], refs = []; let stateIndex = 0, refIndex = 0, effects = [];
  const react = { ...React,
    useState(initial) { const i = stateIndex++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; },
    useRef(initial) { const i = refIndex++; return refs[i] ||= { current: initial }; },
    useEffect(effect) { effects.push(effect); },
  };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText, {
    module, exports: module.exports, console, Date, Intl,
    require(name) {
      if (name === 'react') return react;
      if (name === '../persistence/repository') return { Repository: reader };
      if (name === '../services/projectContinuation') return require('../src/services/projectContinuation');
      throw new Error(`Unexpected dependency ${name}`);
    },
  }, { filename });
  return { render(props) { stateIndex = refIndex = 0; effects = []; return module.exports.ProjectContinuation(props); }, async flush() { for (const fn of effects) fn(); await new Promise(resolve => setImmediate(resolve)); } };
}
const p = { id: 'p', clientName: '陈总', title: '商城', stage: '需求确认', internalContext: '不外发', shareableSummary: '已保存摘要', updatedAt: 1 };
const input = { projectId: 'p', revision: 1, draft: null, busy: false, onContinueProject() {}, onResumeDraft() {}, onEdit() {}, onClose() {}, onOpenClosure() {}, renderTask: t => React.createElement('p', null, t.title), renderFollowUp: t => React.createElement('p', null, t.title) };
function reader() { return { getReadIdentity: () => '1', subscribe: () => () => {}, get: async () => p, query: async () => ({ items: [], nextCursor: null }) }; }
test('project continuation separates current facts, own actions, waiting, questions and history', async () => {
  const ui = harness(reader()); ui.render(input); await ui.flush();
  const markup = renderToStaticMarkup(ui.render(input));
  for (const word of ['当前保存值', '我方下一步', '等待客户', '仍待确认', '最近变化', '继续记录此项目', '预算待定']) assert.ok(markup.includes(word), word);
  assert.doesNotMatch(markup, /客户已确认/);
});
test('failed project reads offer retry, not an empty successful state', async () => {
  const r = reader(); r.get = async () => { throw new Error('controlled disk failure'); };
  const ui = harness(r); ui.render(input); await ui.flush();
  const markup = renderToStaticMarkup(ui.render(input));
  assert.match(markup, /重试读取项目/); assert.doesNotMatch(markup, /暂无未完成行动/);
});
test('changing project immediately hides previously loaded project facts', async () => {
  const ui = harness(reader()); ui.render(input); await ui.flush();
  const markup = renderToStaticMarkup(ui.render({ ...input, projectId: 'other' }));
  assert.doesNotMatch(markup, /已保存摘要|不外发|陈总/); assert.match(markup, /读取/);
});
test('saved project-level next action remains visible even without separate tasks', async () => {
  const r = reader(); r.get = async () => ({ ...p, nextAction: '周五发报价' });
  const ui = harness(r); ui.render(input); await ui.flush();
  const markup = renderToStaticMarkup(ui.render(input));
  assert.match(markup, /周五发报价/); assert.match(markup, /查看项目级下一步依据/);
});
