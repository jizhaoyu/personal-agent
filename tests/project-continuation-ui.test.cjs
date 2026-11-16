const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

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
      if (name === '../i18n') return loadI18n(react);
      if (name === '../persistence/repository') return { Repository: reader };
      if (name === '../services/projectContinuation') return require('../src/services/projectContinuation');
      if (name === '../services/artifacts') return require('../src/services/artifacts');
      if (name === '../services/artifacts') {
        const artFile = path.join(process.cwd(), 'src/services/artifacts.ts');
        const compiledArt = ts.transpileModule(fs.readFileSync(artFile, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: artFile }).outputText;
        const m = { exports: {} };
        vm.runInNewContext(compiledArt, { module: m, exports: m.exports, Date, console, crypto: require('node:crypto'), require(dep) {
          if (dep === './storage') return { newId: prefix => `${prefix}-${require('node:crypto').randomUUID()}` };
          if (dep === '../i18n/domain') return require('../src/i18n/domain');
          return require(dep);
        } });
        return m.exports;
      }
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

function vdomText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(vdomText).join('');
  return vdomText(node.props?.children);
}
function vdomFind(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return node.map(item => vdomFind(item, predicate)).find(Boolean);
  return predicate(node) ? node : vdomFind(node.props?.children, predicate);
}

test('M3 artifact composer cancellation leaves zero persisted drafts, and saved drafts support ready check, staleness rebuild, and deletion', async () => {
  const saved = [];
  const deleted = [];
  const task1 = { id: 't1', engagementId: 'p', title: '确认视觉稿', assignee: '我', deadline: '周五', priority: 'high', done: false };
  const artStale = {
    id: 'art-existing',
    space: 'work',
    projectId: 'p',
    type: 'proposal_brief',
    title: '用户自定义方案标题',
    content: '用户精修方案正文（不可覆盖）',
    sourceSnapshot: { projectUpdatedAt: 1, tasksCount: 0, followUpsCount: 0, conditionsCount: 0 },
    version: 1,
    status: 'needs_review',
    reviewReason: '关联行动已更新',
    createdAt: 1,
    updatedAt: 2,
  };
  const artifacts = new Map([[artStale.id, artStale]]);
  const customReader = {
    ...reader(),
    get: async (_s, kind, id) => kind === 'engagement' ? p : kind === 'task' && id === 't1' ? task1 : kind === 'artifact' ? (artifacts.get(id) || null) : null,
    query: async (_s, kind) => {
      if (kind === 'task') return { items: [task1], nextCursor: null };
      if (kind === 'artifact') return { items: [...artifacts.values()].sort((a, b) => b.updatedAt - a.updatedAt), nextCursor: null };
      return { items: [], nextCursor: null };
    },
    saveArtifactDraft: async art => { saved.push(art); artifacts.set(art.id, art); return { ok: true, receipts: [] }; },
    deleteArtifactDraft: async id => { deleted.push(id); artifacts.delete(id); return { ok: true, receipts: [] }; },
  };
  const ui = harness(customReader);
  ui.render(input); await ui.flush();
  let tree = ui.render(input);

  // 1. Open composer -> verify preview renders -> edit text -> click 取消 -> zero saves!
  const openBtn = vdomFind(tree, n => n.type === 'button' && /生成交付草稿/.test(vdomText(n)));
  assert.ok(openBtn, '项目接续面板应提供生成交付草稿按钮');
  openBtn.props.onClick();
  tree = ui.render(input);
  const composerTextarea = vdomFind(tree, n => n.type === 'textarea' && n.props['aria-label'] === '交付草稿正文');
  assert.ok(composerTextarea, '打开预览编辑器后应可编辑正文');
  assert.doesNotMatch(composerTextarea.props.value, /不外发/);
  composerTextarea.props.onChange({ target: { value: '临时未保存正文' } });
  tree = ui.render(input);
  const cancelBtn = vdomFind(tree, n => n.type === 'button' && vdomText(n) === '取消');
  assert.ok(cancelBtn);
  cancelBtn.props.onClick();
  tree = ui.render(input);
  assert.equal(saved.length, 0, '取消预览不应保存半成品草稿');
  assert.equal(vdomFind(tree, n => n.type === 'textarea' && n.props['aria-label'] === '交付草稿正文'), undefined);

  // 2. Open composer again -> switch type to material_checklist -> save draft
  vdomFind(tree, n => n.type === 'button' && /生成交付草稿/.test(vdomText(n))).props.onClick();
  tree = ui.render(input);
  const typeSelect = vdomFind(tree, n => n.type === 'select' && n.props['aria-label'] === '交付草稿类型');
  assert.ok(typeSelect);
  typeSelect.props.onChange({ target: { value: 'material_checklist' } });
  tree = ui.render(input);
  vdomFind(tree, n => n.type === 'button' && vdomText(n) === '保存草稿').props.onClick();
  await ui.flush();
  tree = ui.render(input);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].type, 'material_checklist');
  assert.equal(saved[0].status, 'draft');
  assert.equal(vdomFind(tree, n => n.type === 'textarea' && n.props['aria-label'] === '交付草稿正文'), undefined, '保存后应关闭预览编辑器');

  // 3. Stale draft card shows needs_review + snapshot drift + 保留正文并同步快照 / 按最新事实重新生成 / 删除草稿
  const staleCard = vdomFind(tree, n => n.type === 'article' && /用户自定义方案标题/.test(vdomText(n)));
  assert.ok(staleCard);
  assert.match(vdomText(staleCard), /需核对/);
  assert.match(vdomText(staleCard), /关联行动已更新/);
  assert.match(vdomText(staleCard), /行动数量变化（0 → 1）/);

  vdomFind(staleCard, n => n.type === 'button' && /保留正文并同步快照/.test(vdomText(n))).props.onClick();
  await ui.flush();
  tree = ui.render(input);
  assert.equal(saved.length, 2);
  assert.equal(saved[1].content, '用户精修方案正文（不可覆盖）');
  assert.equal(saved[1].version, 2);
  assert.equal(saved[1].sourceSnapshot.tasksCount, 1);
  const refreshedCard = vdomFind(tree, n => n.type === 'article' && /用户自定义方案标题/.test(vdomText(n)));
  assert.ok(refreshedCard);
  assert.doesNotMatch(vdomText(refreshedCard), /需核对/);

  vdomFind(refreshedCard, n => n.type === 'button' && /删除草稿/.test(vdomText(n))).props.onClick();
  await ui.flush();
  tree = ui.render(input);
  assert.deepEqual(deleted, ['art-existing']);
  assert.equal(vdomFind(tree, n => n.type === 'article' && /用户自定义方案标题/.test(vdomText(n))), undefined);
  assert.equal(vdomFind(tree, n => n.type === 'button' && /发送/.test(vdomText(n))), undefined);
});

test('real browser: US09 workSuggestionsEnabled toggle and M3 ArtifactDraft lifecycle on IndexedDB', { skip: process.env.LOOMA_UI_BROWSER !== '1', timeout: 90000 }, async () => {
  const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    await page.goto(process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173/');
    await page.getByRole('button', { name: '工作态', exact: true }).click();
    await page.locator('.work-v5 textarea').waitFor();

    // Seed project + task + ready condition cleanly in IndexedDB, then reload cleanly
    await page.evaluate(async () => {
      const { Repository } = await import('/src/persistence/repository.ts');
      await Repository.initialize();
      const proj = { id: 'e2e-p1', clientName: '赵总', title: '企业官网升级', stage: '方案报价', internalContext: '内部机密底价35000', shareableSummary: '首期含官网重构与响应式适配', nextAction: '周五发送正式方案简报', updatedAt: 100 };
      const task = { id: 'e2e-t1', engagementId: 'e2e-p1', title: '输出首页原型', assignee: '我', deadline: '周四前', priority: 'high', done: false };
      const cond = { id: 'e2e-c1', space: 'work', conditionText: '赵总确认主页结构', actionTitle: '起草正式报价简报', conditionKind: 'manual_confirm', status: 'ready', engagementId: 'e2e-p1', sourceMessageId: 'src-1', revision: 1, triggeredAt: 100, createdAt: 90, updatedAt: 100 };
      await Repository.transaction('work', [
        { kind: 'engagement', id: proj.id, before: null, after: proj },
        { kind: 'task', id: task.id, before: null, after: task },
        { kind: 'condition', id: cond.id, before: null, after: cond },
      ], { event: false });
    });
    await page.reload();
    await page.getByRole('button', { name: '工作态', exact: true }).click();

    // Verify US09 ready condition & 准备交付草稿 CTA on home, then disable workSuggestionsEnabled in settings
    await page.getByRole('region', { name: '条件已就绪' }).waitFor();
    await page.getByRole('button', { name: '准备交付草稿', exact: true }).waitFor();
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    const toggle = page.getByLabel(/开启工作台主动建议/);
    await toggle.uncheck();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('设置已保存。').waitFor();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByRole('region', { name: '条件已就绪' }).waitFor({ state: 'detached' });

    // Re-enable workSuggestionsEnabled -> click 准备交付草稿 -> opens ProjectContinuation composer
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    await page.getByLabel(/开启工作台主动建议/).check();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('设置已保存。').waitFor();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByRole('button', { name: '准备交付草稿', exact: true }).click();

    // Verify preview isolates internalContext & cancel does not persist anything
    const artifacts = page.getByRole('region', { name: '项目交付草稿' });
    const preview = page.getByRole('region', { name: '交付草稿预览' });
    const editor = preview.getByLabel('交付草稿正文', { exact: true });
    await editor.waitFor();
    const previewValue = await editor.inputValue();
    assert.ok(!previewValue.includes('35000') && !previewValue.includes('内部机密'));
    await preview.getByRole('button', { name: '取消', exact: true }).click();
    await editor.waitFor({ state: 'detached' });

    // Create & save draft, mark ready, then mutate project to trigger needs_review
    await artifacts.getByRole('button', { name: /生成交付草稿/ }).click();
    await editor.fill('赵总定制精修正文');
    await preview.getByRole('button', { name: '保存草稿', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    await artifacts.getByText('赵总定制精修正文', { exact: true }).waitFor();

    // Mark Ready (check explicit review box first)
    await artifacts.getByLabel(/我已核对事实与信息缺口/).check();
    await artifacts.getByRole('button', { name: '标记可查看', exact: true }).click();
    await artifacts.getByText(/已可查看 · 仅本地查看/).waitFor();

    // Mutate project task -> reloads continuation & surfaces needs_review keeping user edit
    await page.getByRole('region', { name: '项目我方下一步' }).getByRole('button', { name: /完成输出首页原型/ }).click();
    await artifacts.getByText('需核对 · v1', { exact: true }).waitFor();
    await artifacts.getByText('赵总定制精修正文', { exact: true }).waitFor();

    // Delete draft cleans up completely
    await artifacts.getByRole('button', { name: '删除草稿', exact: true }).click();
    await artifacts.getByText('赵总定制精修正文', { exact: true }).waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
