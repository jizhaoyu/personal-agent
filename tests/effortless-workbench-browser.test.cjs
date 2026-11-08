const test = require('node:test');
const assert = require('node:assert/strict');

test('real Edge: effortless work capture, keyboard, failed storage, optional tools and 390px layout', { skip: process.env.LOOMA_UI_BROWSER !== '1', timeout: 90000 }, async () => {
  const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const fs = require('node:fs/promises'); const path = require('node:path');
  await fs.mkdir('output/playwright', { recursive: true });
  const shot = name => page.screenshot({ path: path.resolve('output/playwright', name) });
  try {
    await page.goto(process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173');
    await page.getByRole('button', { name: '工作态', exact: true }).waitFor();
    await page.getByRole('button', { name: '工作态', exact: true }).click();
    await page.locator('.work-v5 textarea').waitFor();
    assert.equal(await page.locator('.work-v5 textarea').count(), 1, '实际工作首页直接可写');
    assert.equal(await page.locator('.capture-binding').getAttribute('open'), null);
    const realInput = page.getByLabel('客户沟通记录', { exact: true });
    const example = page.getByRole('button', { name: /填入例句/ });
    await page.getByRole('heading', { name: '记一条工作进展', exact: true }).waitFor();
    const summary = page.getByRole('complementary', { name: '工作摘要' });
    assert.ok((await page.locator('.capture-card').boundingBox()).x < (await summary.boundingBox()).x);
    await summary.getByRole('heading', { name: '从第一条工作进展开始' }).waitFor();
    assert.equal(await summary.locator('.home-section').count(), 0);
    const reminders = page.getByRole('region', { name: '工作提醒', exact: true });
    await reminders.getByText('目前没有需要处理的提醒', { exact: true }).waitFor();
    assert.equal(await reminders.locator('.todo-group').count(), 0);
    await shot('work-journal-summary-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    const firstAction = await page.getByRole('button', { name: '整理这条记录', exact: true }).boundingBox();
    assert.ok(firstAction.y + firstAction.height < 844, '窄屏空账户首屏可见主操作');
    assert.equal(await page.locator('.app-shell').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await shot('work-journal-summary-390.png');
    await page.setViewportSize({ width: 1100, height: 900 });
    await example.click();
    assert.equal(await realInput.inputValue(), '刚和客户确认了首页方向，周五前发新版报价。');
    assert.equal(await realInput.evaluate(el => document.activeElement === el), true);
    assert.equal(await page.locator('.proposal-box, .closure-receipt').count(), 0);
    await page.getByRole('button', { name: '变更记录', exact: true }).click();
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    assert.match(await realInput.inputValue(), /新版报价/);
    await page.getByRole('button', { name: '生活态', exact: true }).click();
    await page.locator('.life-shell .life-workspace').waitFor();
    await page.getByRole('button', { name: '工作态', exact: true }).click();
    assert.match(await realInput.inputValue(), /新版报价/);
    const raw = '李总的网站改版，预算300元。我周五发首页原型，客户下周一补素材，新增页面费用还没谈定。';
    await realInput.fill(raw);
    const organize = page.getByRole('button', { name: '整理这条记录', exact: true });
    const review = page.getByRole('heading', { name: '核对待办与项目更新', exact: true });
    await organize.click();
    await review.waitFor();
    await page.getByRole('button', { name: '忽略整批', exact: true }).click();
    await review.waitFor({ state: 'hidden' });
    assert.equal(await realInput.inputValue(), raw);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.app-shell').evaluate(el => el.scrollTo(0, 0));
    assert.ok((await organize.boundingBox()).y < (await page.getByRole('complementary', { name: '工作摘要' }).boundingBox()).y);
    await organize.click();
    await page.getByRole('link', { name: '已整理，查看待核对内容' }).click();
    await review.waitFor();
    assert.equal(await page.locator('.app-shell').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    const panel = page.getByRole('region', { name: '待确认变更' });
    const confirm = panel.getByRole('button', { name: '确认并保存', exact: true });
    assert.match(await panel.locator('.review-overview').innerText(), /新增 1 个项目/);
    assert.match(await panel.locator('.review-overview').innerText(), /新增 1 条行动/);
    assert.equal(await panel.getByLabel('预算 1', { exact: true }).isVisible(), false);
    const confirmBox = await confirm.boundingBox();
    assert.ok(confirmBox.y >= 0 && confirmBox.y + confirmBox.height <= 844, '进入窄屏核对页即可看到确认按钮');
    await shot('work-journal-review-summary-390.png');
    await panel.locator('.review-category--record .review-item-editor > summary').click();
    await panel.getByLabel('预算 1', { exact: true }).fill('350');
    assert.match(await panel.locator('.review-category--record .review-differences').innerText(), /350/);
    await confirm.click();
    await page.getByRole('region', { name: '本次沟通收尾记录', exact: true }).waitFor();
    await page.getByRole('button', { name: '项目', exact: true }).click();
    await page.locator('.project-card').filter({ hasText: '李总' }).getByText('¥350', { exact: true }).waitFor();
    await page.locator('.work-sub-nav').getByRole('button', { name: '项目行动', exact: true }).click();
    await page.getByRole('heading', { name: '项目行动', exact: true }).waitFor();
    await page.locator('.records-panel').getByRole('heading', { name: '发首页原型', exact: true }).waitFor();
    await reminders.locator('.todo-row').filter({ hasText: '发首页原型' }).waitFor();
    assert.equal(await reminders.locator('.todo-group .todo-empty').count(), 0);
    await page.locator('.app-toast').waitFor({ state: 'hidden' });
    await reminders.scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.app-shell').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await shot('work-journal-reminders-390.png');
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.getByRole('button', { name: '工作台', exact: true }).click();
    await summary.getByRole('region', { name: '等待客户', exact: true }).waitFor();
    await summary.getByRole('region', { name: '最近沟通', exact: true }).waitFor();
    assert.equal(await summary.locator('.home-summary-empty').count(), 0);
    await page.locator('.app-shell').evaluate(el => el.scrollTo(0, 0));
    await shot('work-journal-summary-populated.png');

    // Isolated component mount uses the shipped component and actual browser events.
    // Callbacks let us force a persistence rejection without changing user data.
    await page.evaluate(async () => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { WorkBench } = await import('/src/components/WorkBench.tsx');
      window.captureProof = { calls: [], fail: false };
      const mount = document.createElement('div'); mount.id = 'capture-proof';
      Object.assign(mount.style, { position: 'absolute', inset: '0', background: '#101216', padding: '12px', boxSizing: 'border-box', minHeight: '100vh' });
      document.body.replaceChildren(mount);
      function Fixture() {
        const [draft, setDraft] = React.useState({ text: '' });
        const noop = () => {};
        const submit = async text => { window.captureProof.calls.push(text); if (window.captureProof.fail) throw Error('controlled failure'); setDraft({ text: '' }); };
        return React.createElement(WorkBench, {
          work: { revision: 1, engagements: [], tasks: [], followUps: [] }, pending: null, busy: false,
          selectedId: '', draft, draftSaveState: 'saved', home: null, closure: null,
          onDraftChange: patch => setDraft(previous => ({ ...previous, ...patch })), onPropose: submit,
          onOriginalOnly: () => submit(draft.text), onContinue: noop, onResume: noop,
          onSelect: noop, onManual: noop,
        });
      }
      createRoot(mount).render(React.createElement(Fixture));
    });
    const input = page.locator('#capture-proof textarea'); await input.waitFor();
    await input.fill('中文候选确认');
    await input.dispatchEvent('compositionstart'); await input.press('Enter'); await input.dispatchEvent('compositionend');
    assert.equal(await page.evaluate(() => window.captureProof.calls.length), 0);
    await input.press('Shift+Enter'); assert.match(await input.inputValue(), /\n/);
    await input.fill('不选项目也能记'); await input.press('Enter');
    await page.waitForFunction(() => window.captureProof.calls.length === 1);
    await page.waitForFunction(() => document.querySelector('#capture-proof textarea').value === '');
    await page.evaluate(() => { window.captureProof.fail = true; });
    await input.fill('写入失败仍然保留'); await page.getByRole('button', { name: '整理这条记录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '保存未完成' }).waitFor();
    assert.equal(await input.inputValue(), '写入失败仍然保留');
    await page.evaluate(() => { window.captureProof.fail = false; });
    await page.getByRole('button', { name: '只保存原文', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#capture-proof textarea').value === '');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.capture-binding summary').click();
    await page.locator('.capture-advanced summary').click();
    assert.ok(await page.getByLabel('明确新客户姓名', { exact: true }).isVisible());
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#capture-proof, #capture-proof *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => node.className));
    assert.deepEqual(overflow, []);
    await page.locator('.capture-binding summary').click(); await page.locator('.capture-advanced summary').click();
    await input.focus(); await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.activeElement?.tagName !== 'BODY'));
    await page.screenshot({ path: path.resolve('output/playwright/effortless-workbench-390.png'), fullPage: true });
  } finally { await context.close(); await browser.close(); }
});
