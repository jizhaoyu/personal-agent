const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

function harness(name, service = {}) {
  const filename = path.join(process.cwd(), 'src/components', name + '.tsx');
  assert.ok(fs.existsSync(filename), name + ' 尚未实现');
  const states = [], refs = []; let si = 0, ri = 0, effects = [];
  const hooks = { ...React,
    useState(init) { const i = si++; if (!(i in states)) states[i] = typeof init === 'function' ? init() : init; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(init) { const i = ri++; return refs[i] ||= { current: init }; },
    useEffect(fn) { effects.push(fn); },
  };
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText, {
    module, exports: module.exports, console, Date, Intl, setInterval(fn, ms) { const timer = setInterval(fn, ms); timer.unref(); return timer; }, clearInterval, window: {},
    require(dep) {
      if (dep === 'react') return hooks;
      if (dep === 'lucide-react') return new Proxy({}, { get: () => () => null });
      if (dep === '../services/todos') return { TodoService: service };
      if (dep === './Companion') return { Character: () => null };
      if (dep === '../persistence/repository') return { Repository: {} };
      if (dep === '../services/legacyConnection') return {};
      if (dep === '../i18n') {
        const dir = path.join(process.cwd(), 'src/i18n'), cache = {};
        const loadTs = modName => {
          if (cache[modName]) return cache[modName];
          const f = path.join(dir, `${modName}.ts`);
          const mod = { exports: {} }; cache[modName] = mod.exports;
          vm.runInNewContext(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: f }).outputText,
            { module: mod, exports: mod.exports, Intl, console, get window() { return globalThis.window; }, get document() { return globalThis.document; }, get localStorage() { return globalThis.localStorage; },
              require: d => d === 'react' ? hooks : d.startsWith('./') ? loadTs(d.slice(2)) : require(d) }, { filename: f });
          return (cache[modName] = mod.exports);
        };
        return loadTs('index');
      }
      if (dep.endsWith('.css')) return {};
      throw new Error('Unexpected dependency ' + dep);
    },
  }, { filename });
  return { exports: module.exports, render(props) { si = ri = 0; effects = []; return module.exports[name](props); }, async mount() { const cleanups = effects.map(fn => fn()).filter(fn => typeof fn === 'function'); await tick(); return () => cleanups.forEach(fn => fn()); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function text(node) { if (node == null || typeof node === 'boolean') return ''; if (Array.isArray(node)) return node.map(text).join(''); if (typeof node !== 'object') return String(node); return text(node.props?.children); }
function find(node, predicate) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.map(n => find(n, predicate)).find(Boolean); return predicate(node) ? node : find(node.props?.children, predicate); }
const chatProps = { mode: 'life', messages: [], settings: {}, isLoading: false, onSendMessage() {}, onInspectMutation() {}, onOpenCards() {} };

test('IME Enter does not send, then a synchronous callback still clears successfully', async () => {
  let sent = 0; const ui = harness('ChatPill'); const props = { ...chatProps, onSendMessage() { sent++; } };
  let tree = ui.render(props); find(tree, n => n.type === 'textarea').props.onChange({ target: { value: '明天提醒我' } });
  tree = ui.render(props); let input = find(tree, n => n.type === 'textarea');
  input.props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() {} });
  assert.equal(sent, 0);
  input.props.onKeyDown({ key: 'Enter', nativeEvent: { keyCode: 229 }, preventDefault() {} });
  assert.equal(sent, 0);
  await find(tree, n => n.type === 'button' && n.props['aria-label'] === '发送文字记录').props.onClick();
  assert.equal(sent, 1); assert.equal(find(ui.render(props), n => n.type === 'textarea').props.value, '');
});

test('settings show actual reminder capabilities and request Android permissions explicitly', async () => {
  let requests = 0;
  const ui = harness('SettingsModal', { capabilities: async () => ({ background: true, enabled: false, notifications: 'denied', exactAlarms: 'denied' }), requestPermissions: async () => { requests++; return { background: true, enabled: false, notifications: 'granted', exactAlarms: 'granted' }; } });
  const props = { settings: { remindersEnabled: false }, isOpen: true, onClose() {}, onSaveSettings: async () => {}, onDataImported() {} };
  ui.render(props); const cleanup = await ui.mount(); let tree = ui.render(props);
  assert.match(text(tree), /后台提醒/); assert.match(text(tree), /通知权限未授予/);
  await find(tree, n => n.type === 'button' && text(n).includes('开启通知')).props.onClick();
  assert.equal(requests, 1); tree = ui.render(props); assert.match(text(tree), /通知权限已授予/);
  assert.doesNotMatch(text(tree), /仅显示事项数量|退出后不提醒/); cleanup();
});

test('failed async send preserves original text and reports inline error', async () => {
  const ui = harness('ChatPill'); const props = { ...chatProps, onSendMessage: async () => { throw new Error('磁盘失败'); } };
  let tree = ui.render(props); find(tree, n => n.type === 'textarea').props.onChange({ target: { value: '  原始输入  ' } }); tree = ui.render(props);
  await find(tree, n => n.type === 'button' && n.props['aria-label'] === '发送文字记录').props.onClick();
  tree = ui.render(props); assert.equal(find(tree, n => n.type === 'textarea').props.value, '  原始输入  '); assert.match(text(tree), /磁盘失败/);
});

test('pending async send does not clear newer edits', async () => {
  let resolve; const ui = harness('ChatPill'); const props = { ...chatProps, onSendMessage: () => new Promise(r => { resolve = r; }) };
  let tree = ui.render(props); find(tree, n => n.type === 'textarea').props.onChange({ target: { value: '原文' } }); tree = ui.render(props);
  const sending = find(tree, n => n.type === 'button' && n.props['aria-label'] === '发送文字记录').props.onClick();
  assert.equal(find(ui.render(props), n => n.type === 'textarea').props.value, '原文', '持久化返回前不清空');
  find(tree, n => n.type === 'textarea').props.onChange({ target: { value: '下一条' } }); resolve(); await sending;
  assert.equal(find(ui.render(props), n => n.type === 'textarea').props.value, '下一条');
});

test('App routes both entry points through todos before old parsing and lifts life draft state', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
  const work = source.slice(source.indexOf('async function propose('), source.indexOf('async function manual('));
  const life = source.slice(source.indexOf('async function sendLife('), source.indexOf('async function modelRecall('));
  assert.ok(work.indexOf('capturePersonalText') >= 0 && work.indexOf('capturePersonalText') < work.indexOf('StateEngine.propose'));
  assert.ok(life.indexOf('capturePersonalText') >= 0 && life.indexOf('capturePersonalText') < life.indexOf('StateEngine.mutateLifeDraft'));
  assert.match(source, /draftText=\{lifeDraft\}/);
  assert.match(source, /onTodoFocus/);
  assert.doesNotMatch(source, /notifyDue\(/, '移除依赖工作页的重复数量通知');
});

const todo = (id, status, dueAt) => ({ id, space: 'life', title: id, status, dueAt, createdAt: 1, updatedAt: 1, revision: 1 });
test('todo sections use Shanghai days, keep inactive out, and never invent a time', () => {
  const ui = harness('TodoPanel'); const now = Date.parse('2026-11-04T16:30:00Z');
  const rows = [todo('past', 'pending', '2026-11-04T17:00:00+08:00'), todo('today', 'pending', '2026-11-05T09:00:00+08:00'), todo('future', 'pending', '2026-11-06T09:00:00+08:00'), todo('choose', 'suggested'), todo('done', 'completed'), todo('cancelled', 'cancelled'), { ...todo('needs', 'pending'), needsTime: true }];
  const groups = ui.exports.groupTodos(rows, now);
  assert.deepEqual(Array.from(groups.overdue, t => t.id), ['past']);
  assert.deepEqual(Array.from(groups.today, t => t.id), ['today']);
  assert.deepEqual(Array.from(groups.future, t => t.id), ['future', 'needs']);
  assert.deepEqual(Array.from(groups.suggested, t => t.id), ['choose']);
  assert.deepEqual(Array.from(groups.completed, t => t.id), ['done']);
});

test('todo panel lists the requested space, silently completes, snoozes 15 minutes, and requires missing time', async () => {
  const calls = []; const rows = [todo('提醒', 'pending', '2099-01-01T10:00:00+08:00'), { ...todo('补时间', 'suggested'), needsTime: true, dueDate: '2099-01-01' }];
  const service = { list: async (...args) => { calls.push(['list', ...args]); return rows; }, subscribe: () => () => {}, capabilities: async () => ({ background: false, notifications: 'unsupported', exactAlarms: 'unsupported', enabled: false }), complete: async t => calls.push(['complete', t.id]), cancel: async t => calls.push(['cancel', t.id]), snooze: async (t, n) => calls.push(['snooze', t.id, n]), approve: async (...args) => calls.push(['approve', ...args]) };
  const errors = []; const props = { space: 'life', onError: e => errors.push(e) }; const ui = harness('TodoPanel', service); ui.render(props); const cleanup = await ui.mount(); let tree = ui.render(props);
  assert.deepEqual(calls[0], ['list', 'life', true]); assert.match(text(tree), /浏览器.*后台|不支持后台/);
  await find(tree, n => n.type === 'button' && n.props['aria-label'] === '完成提醒').props.onClick();
  await find(tree, n => n.type === 'button' && n.props['aria-label'] === '稍后15分钟提醒').props.onClick();
  assert.ok(calls.some(c => c[0] === 'complete')); assert.ok(calls.some(c => c[0] === 'snooze' && c[2] === 15)); assert.deepEqual(errors, []);
  assert.equal(find(tree, n => n.type === 'button' && n.props['aria-label'] === '确认补时间').props.disabled, false);
  const dt = find(tree, n => n.type === 'input' && n.props.type === 'datetime-local'); assert.equal(dt.props.value, '');
  dt.props.onChange({ target: { value: '2099-01-01T18:30' } }); tree = ui.render(props);
  await find(tree, n => n.type === 'button' && n.props['aria-label'] === '确认补时间').props.onClick();
  assert.ok(calls.some(c => c[0] === 'approve' && c[2] && c[2].includes('T'))); cleanup();
});

test('ambiguous cancellation invokes cancel, never complete', async () => {
  const calls = []; const choice = todo('重名待办', 'pending', '2099-01-01T10:00:00+08:00');
  const ui = harness('TodoPanel', { list: async () => [choice], subscribe: () => () => {}, capabilities: async () => ({ background: false, notifications: 'unsupported', exactAlarms: 'unsupported', enabled: true }), complete: async () => calls.push('complete'), cancel: async () => calls.push('cancel') });
  const props = { space: 'life', choices: [choice], choiceAction: 'cancel' };
  ui.render(props); const cleanup = await ui.mount(); const tree = ui.render(props);
  const group = find(tree, n => n.props?.['aria-label'] === '选择要取消的待办'); assert.ok(group);
  await find(group, n => n.type === 'button' && text(n).includes(choice.title)).props.onClick();
  assert.deepEqual(calls, ['cancel']); cleanup();
});
