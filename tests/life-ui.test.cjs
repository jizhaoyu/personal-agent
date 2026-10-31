const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

function component(name, storageOverrides = {}, repositoryOverrides = {}, aiOverrides = {}) {
  const updates = [];
  const loads = [];
  const values = [];
  const refs = [];
  const effects = [];
  let stateIndex = 0;
  let refIndex = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const index = stateIndex++;
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
      return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; updates.push({ index, value: values[index] }); }];
    },
    useRef(value) { const index = refIndex++; return refs[index] ||= { current: value }; },
    useEffect(effect) { effects.push(effect); },
  };
  const storage = {
    getWalletCard: () => ({ monthlyBudget: 1000, wishTitle: '旅行', wishTarget: 1000, wishSaved: 0, entries: [] }),
    getRpgStatusCard: () => ({ energy: 70, waterCups: 0, weightKg: 0, targetWeightKg: 0, moodBuff: '未记录', streakDays: 0 }),
    getPersonProfiles: () => [], getCrmDeals: () => [], getProjectTasks: () => [], getCustomCards: () => [],
    ...storageOverrides,
  };
  const snapshot = { partitions: { life: {
    wallet: { monthlyBudget: 1000, wishTitle: '旅行', wishTarget: 1000, wishSaved: 0, entries: [] },
    rpg: { energy: 70, waterCups: 0, weightKg: 0, targetWeightKg: 0, moodBuff: '未记录', streakDays: 0 },
    persons: [], customCards: [], journals: [],
  }, work: { customCards: [] } } };
  const repository = {
    getCurrent: () => snapshot,
    subscribe: () => () => {},
    saveWalletCard: async () => {}, saveRpgStatusCard: async () => {}, upsert: async () => {},
    addJournal: async () => {}, getJournals: async () => [],
    ...repositoryOverrides,
  };
  const filename = path.join(process.cwd(), 'src/components', `${name}.tsx`);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: dependency => {
      loads.push(dependency);
      if (dependency === 'react') return hooks;
      if (dependency === 'lucide-react') return new Proxy({}, { get: (_target, name) => () => React.createElement('span', { 'data-icon': String(name) }) });
      if (dependency === '../services/storage') return { StorageService: storage };
      if (dependency === '../persistence/repository') return { Repository: repository };
      if (dependency === '../services/aiService') return { AiService: aiOverrides };
      return require(dependency);
    }, Date, Intl, console,
  }, { filename });
  return { exports: module.exports, updates, loads, snapshot,
    render(props) { stateIndex = 0; refIndex = 0; return module.exports[name](props); },
    mount() { const cleanup = effects.map(effect => effect()).filter(value => typeof value === 'function'); return () => cleanup.forEach(fn => fn()); },
  };
}

function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return text(node.props?.children);
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return node.map(value => find(value, predicate)).find(Boolean);
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

test('month totals use Shanghai month boundaries and exclude income and savings', () => {
  const { exports } = component('LivingCardsBoard');
  assert.equal(typeof exports.monthlyExpenseTotal, 'function');
  const entry = (amount, iso, type = 'expense') => ({ amount, timestamp: Date.parse(iso), type });
  const entries = [
    entry(10, '2026-09-30T15:59:59Z'), entry(20, '2026-09-30T16:00:00Z'),
    entry(30, '2026-10-31T15:59:59Z'), entry(40, '2026-10-31T16:00:00Z'),
    entry(100, '2026-10-10T00:00:00Z', 'income'), entry(200, '2026-10-10T00:00:00Z', 'saving'),
  ];
  assert.equal(exports.monthlyExpenseTotal(entries, Date.parse('2026-10-26T00:00:00Z')), 50);
});

test('progress remains finite for unset and zero budget or target', () => {
  const { exports } = component('LivingCardsBoard');
  assert.equal(typeof exports.boundedProgress, 'function');
  assert.equal(exports.boundedProgress(0, 0), 0);
  assert.equal(exports.boundedProgress(100, 0), 0);
  assert.equal(exports.boundedProgress(-50, 100), 0);
  assert.equal(exports.boundedProgress(150, 100), 100);
});

test('life board neither reads work records nor claims a failed saving succeeded', async () => {
  let workReads = 0;
  const notifications = [];
  const view = component('LivingCardsBoard', {
    getCrmDeals: () => { workReads++; return []; },
    getProjectTasks: () => { workReads++; return []; },
  }, { saveWalletCard: async () => { throw new Error('quota'); } });
  const tree = view.exports.LivingCardsBoard({ mode: 'life', onCompanionToast: value => notifications.push(value) });
  assert.equal(workReads, 0);
  const save = find(tree, node => node.type === 'button' && text(node).includes('+攒'));
  assert.ok(save);
  await assert.doesNotReject(async () => save.props.onClick());
  assert.equal(view.updates.length, 0, 'failed persistence must not advance React state');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /失败|未保存/);
});

test('life cards initialize from the migrated repository cache without legacy reads', () => {
  const view = component('LivingCardsBoard', {
    getWalletCard: () => { throw new Error('legacy wallet must not be read'); },
    getRpgStatusCard: () => { throw new Error('legacy RPG must not be read'); },
    getPersonProfiles: () => { throw new Error('legacy people must not be read'); },
    getCustomCards: () => { throw new Error('legacy custom cards must not be read'); },
  });
  view.snapshot.partitions.life.wallet.wishTitle = '数据库里的真实心愿';
  const tree = view.render({ mode: 'life', onCompanionToast() {} });
  assert.match(text(tree), /数据库里的真实心愿/);
});

test('a pending life save leaves business state and success receipt unchanged until persistence resolves', async () => {
  let finish;
  let written;
  const notifications = [];
  const view = component('LivingCardsBoard', {}, { saveWalletCard: value => { written = value; return new Promise(resolve => finish = resolve); } });
  view.snapshot.partitions.life.wallet.entries = [{ id: 'old-loaded', title: '旧记录', amount: 20, type: 'expense', category: '生活', timestamp: Date.now() }];
  const tree = view.render({ mode: 'life', onCompanionToast: value => notifications.push(value) });
  const save = find(tree, node => node.type === 'button' && text(node).includes('+攒'));
  const pending = save.props.onClick();
  assert.equal(view.updates.length, 0);
  assert.equal(notifications.length, 0);
  assert.ok(written.entries.some(item => item.id === 'old-loaded'), 'saving must retain loaded original entries');
  finish();
  await pending;
  assert.equal(view.updates.length, 1);
  assert.match(notifications[0], /已记录/);
});

test('custom card progress upserts only the selected card and never replaces a paged collection', async () => {
  const writes = [];
  const view = component('LivingCardsBoard', {}, { upsert: async (...args) => writes.push(args) });
  view.snapshot.partitions.life.customCards = [{ id: 'selected', mode: 'life', title: '读书', icon: '书', metricValue: 10, metricTarget: 100, unit: '页' }, { id: 'other', mode: 'life', title: '另一张卡', icon: '卡', metricValue: 20, metricTarget: 100, unit: '次' }];
  const props = { mode: 'life', onCompanionToast() {} };
  const initial = view.render(props);
  const customTab = find(initial, node => node.type === 'button' && text(node).includes('自定义'));
  assert.ok(customTab, 'migrated custom cards must be available from the cache');
  customTab.props.onClick();
  const tree = view.render(props);
  await find(tree, node => node.type === 'button' && text(node).includes('推进进度')).props.onClick();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'life');
  assert.equal(writes[0][1], 'custom');
  assert.equal(writes[0][2].length, 1);
  assert.equal(writes[0][2][0].id, 'selected');
  assert.equal(writes[0][2][0].metricValue, 20);
});

test('unused work card surface does not read the life cache', () => {
  const view = component('LivingCardsBoard');
  Object.defineProperty(view.snapshot.partitions, 'life', { get() { throw new Error('work surface read life'); } });
  assert.doesNotThrow(() => view.render({ mode: 'work', onCompanionToast() {} }));
});

test('a migrated previous-day water count starts today at zero before adding a cup', async () => {
  let written;
  const view = component('LivingCardsBoard', {}, { saveRpgStatusCard: async value => { written = value; } });
  view.snapshot.partitions.life.rpg = { ...view.snapshot.partitions.life.rpg, dateKey: '2026-01-01', waterCups: 6 };
  const props = { mode: 'life', onCompanionToast() {} };
  const initial = view.render(props);
  find(initial, node => node.type === 'button' && text(node).includes('人生状态栏')).props.onClick();
  const tree = view.render(props);
  const add = find(tree, node => node.type === 'button' && /喝一杯|喝水|记一杯|一杯水/.test(text(node)));
  assert.ok(add);
  await add.props.onClick();
  assert.equal(written.waterCups, 1);
  assert.notEqual(written.dateKey, '2026-01-01');
});

test('journal waits for persisted add before notifying its parent or selecting the new entry', async () => {
  let finish;
  const notifications = [];
  const journal = { id: 'new-journal', mode: 'life', date: '2026-10-27', title: '真实记录', mood: '平静', userGoldenQuote: '读书', aiReflection: '记录', stickers: [] };
  let savedMode;
  const view = component('ArtifactJournal', {}, {
    addJournal: (_journal, mode) => { savedMode = mode; return new Promise(resolve => finish = resolve); },
  }, { generateDailyJournal: async () => journal });
  const tree = view.render({ mode: 'life', journals: [], messages: [{ id: 'm', role: 'user', content: '读书' }], settings: {}, onJournalsChange: value => notifications.push(value) });
  const pending = find(tree, node => node.type === 'button' && text(node).includes('生成今日')).props.onClick();
  // The component executes in a VM realm; let its awaited host promise continue before inspecting the write.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(savedMode, 'life');
  assert.equal(notifications.length, 0);
  assert.equal(view.updates.some(update => update.value === 'new-journal'), false);
  view.snapshot.partitions.life.journals = [journal];
  finish();
  await pending;
  assert.equal(notifications[0][0].id, 'new-journal');
  assert.equal(view.updates.some(update => update.value === 'new-journal'), true);
});

test('journal async disk failure never publishes the generated journal as saved', async () => {
  const notifications = [];
  let writes = 0;
  const view = component('ArtifactJournal', {}, { addJournal: async () => { writes++; throw new Error('disk full'); } }, {
    generateDailyJournal: async () => ({ id: 'never-saved', mode: 'life' }),
  });
  const tree = view.render({ mode: 'life', journals: [], messages: [{ id: 'm', role: 'user', content: '原文' }], settings: {}, onJournalsChange: value => notifications.push(value) });
  await find(tree, node => node.type === 'button' && text(node).includes('生成今日')).props.onClick();
  assert.equal(writes, 1);
  assert.equal(notifications.length, 0);
  assert.ok(view.updates.some(update => /失败/.test(update.value)));
  assert.equal(view.updates.some(update => update.value === 'never-saved'), false);
});

test('a completed life write after unmount does not send a stale toast into another screen', async () => {
  let finish;
  const notifications = [];
  const view = component('LivingCardsBoard', {}, { saveWalletCard: () => new Promise(resolve => finish = resolve) });
  const tree = view.render({ mode: 'life', onCompanionToast: value => notifications.push(value) });
  const unmount = view.mount();
  view.updates.length = 0;
  const pending = find(tree, node => node.type === 'button' && text(node).includes('+攒')).props.onClick();
  assert.equal(typeof finish, 'function');
  unmount();
  finish();
  await pending;
  assert.equal(notifications.length, 0);
  assert.equal(view.updates.length, 0);
});

test('journal persistence that finishes after unmount cannot replace another visible partition', async () => {
  let finish;
  const notifications = [];
  const view = component('ArtifactJournal', {}, { addJournal: () => new Promise(resolve => finish = resolve) }, {
    generateDailyJournal: async () => ({ id: 'life-journal', mode: 'life' }),
  });
  const tree = view.render({ mode: 'life', journals: [], messages: [{ id: 'm', role: 'user', content: '生活原文' }], settings: {}, onJournalsChange: value => notifications.push(value) });
  const unmount = view.mount();
  const pending = find(tree, node => node.type === 'button' && text(node).includes('生成今日')).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  unmount();
  view.updates.length = 0;
  finish();
  await pending;
  assert.equal(notifications.length, 0);
  assert.equal(view.updates.length, 0);
});

test('fresh journal is an explicit empty state with image export disabled', () => {
  const view = component('ArtifactJournal');
  const tree = view.exports.ArtifactJournal({ mode: 'life', journals: [], messages: [], settings: {}, onJournalsChange() {} });
  assert.match(text(tree), /还没有生活手帐/);
  assert.equal(text(tree).includes('今天在窗边看落日'), false);
  const exportButton = find(tree, node => node.type === 'button' && text(node).includes('存图'));
  assert.equal(exportButton.props.disabled, true);
});

test('life chat accepts text only and has no drop handler advertising image extraction', () => {
  const view = component('ChatPill');
  const tree = view.exports.ChatPill({ mode: 'life', messages: [], settings: {}, isLoading: false, onSendMessage() {}, onInspectMutation() {}, onOpenCards() {} });
  assert.equal(tree.props.onDrop, undefined);
  assert.equal(tree.props.onDragOver, undefined);
  assert.equal(find(tree, node => node.type === 'input' && node.props.type === 'file'), undefined);
});

test('memory banners describe logical local separation without screen protection guarantees', () => {
  for (const mode of ['life', 'work']) {
    const { exports } = component('MemoryTimeline');
    const tree = exports.MemoryTimeline({ mode, memories: [], onMemoriesChange() {} });
    assert.match(text(tree), /本地逻辑分区/);
    assert.doesNotMatch(text(tree), /100%|物理隔离|投屏防窥/);
  }
});

test('image renderer is not loaded while opening board or journal', () => {
  for (const name of ['LivingCardsBoard', 'ArtifactJournal']) {
    const view = component(name);
    assert.equal(view.loads.includes('html2canvas'), false);
  }
});
