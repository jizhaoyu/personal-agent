const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { buildTrialReport } = require('../src/services/trialInfo');
function harness() {
  const values = []; let index = 0;
  const react = { ...React, useState(initial) { const current = index++; if (!(current in values)) values[current] = typeof initial === 'function' ? initial() : initial; return [values[current], next => { values[current] = typeof next === 'function' ? next(values[current]) : next; }]; }, useEffect() {}, useRef(value) { return { current: value }; } };
  const filename = path.join(process.cwd(), 'src/components/TrialInfoModal.tsx');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Date, Blob, URL, setTimeout, navigator: { clipboard: { writeText: async () => { throw new Error('clipboard denied'); } } }, require(name) {
    if (name === 'react') return react;
    if (name === 'lucide-react') return new Proxy({}, { get: (_target, icon) => () => React.createElement('span', { 'data-icon': String(icon) }) });
    if (name === '../services/trialInfo') return { buildTrialReport };
    if (name.endsWith('.css')) return {};
    throw new Error(`Unexpected dependency ${name}`);
  } }, { filename });
  return { render(props) { index = 0; return module.exports.TrialInfoModal(props); } };
}
const props = { isOpen: true, onClose() {}, context: { mode: 'work', phase: 'draft', hasError: false }, buildInfo: { productVersion: '5.1.0', buildId: 'trial-test', builtAt: '2026-10-29T01:00:00Z', channel: 'internal-validation' } };
function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return text(node.props?.children); }
function find(node, predicate) { if (!node || typeof node !== 'object') return undefined; if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean); return predicate(node) ? node : find(node.props?.children, predicate); }

test('trial feedback shows the full readonly report before enabling explicit export', () => {
  const ui = harness(); let tree = ui.render(props);
  const preview = find(tree, node => node.props?.['aria-label'] === '试用问题记录预览');
  assert.equal(preview.props.readOnly, true); assert.match(preview.props.value, /trial-test/);
  assert.equal(find(tree, node => node.type === 'button' && text(node).includes('复制问题记录')).props.disabled, true);
  find(tree, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); tree = ui.render(props);
  assert.equal(find(tree, node => node.type === 'button' && text(node).includes('下载文本')).props.disabled, false);
  find(tree, node => node.props?.['aria-label'] === '试用问题实际').props.onChange({ target: { value: '切换后没有回到输入位置' } }); tree = ui.render(props);
  assert.equal(find(tree, node => node.type === 'button' && text(node).includes('复制问题记录')).props.disabled, true);
  assert.match(find(tree, node => node.props?.['aria-label'] === '试用问题记录预览').props.value, /切换后没有回到输入位置/);
});
test('denied clipboard access keeps an explicit manual-copy fallback', async () => {
  const ui = harness(); let tree = ui.render(props);
  find(tree, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); tree = ui.render(props);
  find(tree, node => node.type === 'button' && text(node).includes('复制问题记录')).props.onClick();
  await new Promise(resolve => setImmediate(resolve)); tree = ui.render(props);
  assert.match(text(tree), /系统未允许复制.*手动复制/);
  assert.equal(ui.render({ ...props, isOpen: false }), null);
});
