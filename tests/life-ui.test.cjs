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
      if (dependency === '../i18n') {
        const fs = require('node:fs');
        const path = require('node:path');
        const vm = require('node:vm');
        const ts = require('typescript');
        const cache = new Map();
        const loadTs = rel => {
          const abs = path.join(process.cwd(), 'src/i18n', rel);
          if (cache.has(abs)) return cache.get(abs);
          const code = ts.transpileModule(fs.readFileSync(abs, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: abs }).outputText;
          const m = { exports: {} }; cache.set(abs, m.exports);
          vm.runInNewContext(code, { module: m, exports: m.exports, Date, Intl, console, require(d) {
            if (d === 'react') return hooks;
            if (d === '../types') return {};
            if (d === './store') return loadTs('store.ts');
            if (d === './domain') return loadTs('domain.ts');
            if (d === './zh') return loadTs('zh.ts');
            if (d === './en') return loadTs('en.ts');
            return require(d);
          } }, { filename: abs });
          return m.exports;
        };
        return loadTs('index.ts');
      }
      if (dependency === '../services/storage') return { StorageService: storage };
      if (dependency === '../persistence/repository') return { Repository: repository };
      if (dependency === '../services/aiService') return { AiService: aiOverrides };
      if (dependency === './Companion') return { Character: () => hooks.createElement('span', { 'data-testid': 'character' }) };
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

test('life chat accepts text only and has no drop handler advertising image extraction', () => {
  const view = component('ChatPill');
  const tree = view.exports.ChatPill({ mode: 'life', messages: [], settings: {}, isLoading: false, onSendMessage() {}, onInspectMutation() {}, onOpenCards() {} });
  assert.equal(tree.props.onDrop, undefined);
  assert.equal(tree.props.onDragOver, undefined);
  assert.equal(find(tree, node => node.type === 'input' && node.props.type === 'file'), undefined);
});

test('image renderer is not loaded while opening living cards board', () => {
  const view = component('LivingCardsBoard');
  assert.equal(view.loads.includes('html2canvas'), false);
});

test('deleting a quick-saved +200 entry also deducts 200 from wishSaved and persists wallet config', async () => {
  const transactions = [];
  let savedWallet = null;
  const view = component('LivingCardsBoard', {}, {
    saveWalletCard: async (w) => { savedWallet = w; },
    get: async (_space, kind, id) => {
      if (kind === 'expense' && savedWallet) return savedWallet.entries.find(e => e.id === id) || null;
      if (kind === 'wallet' && savedWallet) {
        const { entries: _e, ...cfg } = savedWallet;
        return cfg;
      }
      return null;
    },
    transaction: async (space, mutations, opts) => {
      transactions.push({ space, mutations, opts });
      return { ok: true };
    },
  });
  const props = { mode: 'life', onCompanionToast() {} };
  let tree = view.render(props);

  // 1. Click +攒 ¥200
  const quickSaveBtn = find(tree, node => node.type === 'button' && text(node).includes('+攒'));
  assert.ok(quickSaveBtn);
  await quickSaveBtn.props.onClick();

  tree = view.render(props);
  assert.match(text(tree), /已攒 ¥200/);
  assert.match(text(tree), /\+¥200/);

  // 2. Click delete button on the +200 entry and confirm deletion
  const deleteBtn = find(tree, node => node.type === 'button' && String(node.props?.['aria-label'] || '').includes('删除记录'));
  assert.ok(deleteBtn, 'entry must have a delete button');
  deleteBtn.props.onClick();

  tree = view.render(props);
  const confirmBtn = find(tree, node => node.type === 'button' && text(node) === '确认');
  assert.ok(confirmBtn, 'delete confirmation button must render');
  await confirmBtn.props.onClick();

  tree = view.render(props);
  assert.match(text(tree), /已攒 ¥0/, 'wishSaved must return to 0 after deleting the +200 saving entry');
  assert.doesNotMatch(text(tree), /\+¥200/, 'deleted +200 entry must no longer be displayed');
  assert.equal(transactions.length, 1);
  const walletMut = transactions[0].mutations.find(m => m.kind === 'wallet');
  assert.ok(walletMut, 'transaction must also update wallet config');
  assert.equal(walletMut.after.wishSaved, 0);
  assert.equal(walletMut.after.wishes[0].savedAmount, 0);
});

test('recorded ledger entry amount and type can be edited inline and syncs wishSaved / monthly spent', async () => {
  let savedWallet = null;
  const notifications = [];
  const view = component('LivingCardsBoard', {}, {
    saveWalletCard: async (w) => { savedWallet = w; },
  });
  view.snapshot.partitions.life.wallet = {
    monthlyBudget: 5000,
    wishTitle: '旅行基金',
    wishTarget: 10000,
    wishSaved: 400,
    wishes: [{ id: 'wish-1', title: '旅行基金', targetAmount: 10000, savedAmount: 400, group: '品质生活', isPrimary: true }],
    activeWishId: 'wish-1',
    entries: [
      { id: 'exp-1', title: '买衣服', amount: 400, type: 'expense', category: '购物🛍️', timestamp: Date.now() },
      { id: 'exp-2', title: '随手攒入心愿金库', amount: 400, type: 'saving', category: '金库✨', timestamp: Date.now() - 1000 },
    ],
  };
  const props = { mode: 'life', onCompanionToast: msg => notifications.push(msg) };
  let tree = view.render(props);
  assert.match(text(tree), /已支出 ¥400/);
  assert.match(text(tree), /已攒 ¥400/);

  // 1. Edit expense entry '买衣服' from 400 to 40
  const editExpenseBtn = find(tree, node => node.type === 'button' && node.props?.['aria-label'] === '编辑记录 买衣服');
  assert.ok(editExpenseBtn, 'expense entry must have an edit button');
  editExpenseBtn.props.onClick();

  tree = view.render(props);
  const amountInput = find(tree, node => node.type === 'input' && node.props?.['aria-label'] === '账单金额');
  assert.ok(amountInput);
  assert.equal(amountInput.props.value, '400');
  amountInput.props.onChange({ target: { value: '40' } });

  tree = view.render(props);
  const editForm = find(tree, node => node.type === 'form' && find(node, child => child.type === 'input' && child.props?.['aria-label'] === '账单金额'));
  assert.ok(editForm);
  await editForm.props.onSubmit({ preventDefault() {} });

  tree = view.render(props);
  assert.match(text(tree), /已支出 ¥40 /);
  assert.equal(savedWallet.entries.find(e => e.id === 'exp-1').amount, 40);

  // 2. Edit saving entry '随手攒入心愿金库' from 400 to 150
  const editSavingBtn = find(tree, node => node.type === 'button' && node.props?.['aria-label'] === '编辑记录 随手攒入心愿金库');
  assert.ok(editSavingBtn, 'saving entry must have an edit button');
  editSavingBtn.props.onClick();

  tree = view.render(props);
  const savingAmountInput = find(tree, node => node.type === 'input' && node.props?.['aria-label'] === '账单金额');
  savingAmountInput.props.onChange({ target: { value: '150' } });

  tree = view.render(props);
  const savingEditForm = find(tree, node => node.type === 'form' && find(node, child => child.type === 'input' && child.props?.['aria-label'] === '账单金额'));
  await savingEditForm.props.onSubmit({ preventDefault() {} });

  tree = view.render(props);
  assert.match(text(tree), /已攒 ¥150/);
  assert.equal(savedWallet.wishSaved, 150);
  assert.equal(savedWallet.wishes[0].savedAmount, 150);
  assert.equal(savedWallet.entries.find(e => e.id === 'exp-2').amount, 150);
});
