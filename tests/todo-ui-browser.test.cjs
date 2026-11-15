const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

test('real browser: dual-space todos, missing time, silent completion, draft and IME retention', { skip: process.env.LOOMA_UI_BROWSER !== '1', timeout: 90000 }, async () => {
  const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const origin = process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173';
  try {
    await page.goto(origin); await page.getByPlaceholder('随手记录…').waitFor();
    const openTodosTab = () => page.getByRole('button', { name: '待办', exact: true }).click();
    const openChatTab = () => page.getByRole('button', { name: '随口说', exact: true }).click();
    await openTodosTab();
    const panel = page.getByRole('region', { name: '生活待办', exact: true });
    await panel.getByText('浏览器仅管理本地待办', { exact: false }).waitFor();
    await openChatTab();
    const input = page.getByPlaceholder('随手记录…');
    const send = async text => { await input.fill(text); await page.getByRole('button', { name: '发送文字记录', exact: true }).click(); await page.waitForFunction(() => document.querySelector('textarea[placeholder="随手记录…"]')?.value === ''); };
    await input.fill('跨页面保留的合成草稿');
    await page.getByRole('button', { name: '生活卡片', exact: true }).click();
    await openChatTab();
    assert.equal(await input.inputValue(), '跨页面保留的合成草稿');
    await page.getByRole('button', { name: '工作态', exact: true }).click();
    await page.getByRole('region', { name: '工作提醒', exact: true }).waitFor();
    await page.getByRole('button', { name: '生活态', exact: true }).click();
    assert.equal(await input.inputValue(), '跨页面保留的合成草稿');
    await input.dispatchEvent('compositionstart'); await input.press('Enter'); await input.dispatchEvent('compositionend');
    assert.equal((await input.inputValue()).trim(), '跨页面保留的合成草稿');
    assert.equal(await page.locator('p.whitespace-pre-wrap').filter({ hasText: '跨页面保留的合成草稿' }).count(), 0, '组合输入不发送消息');
    await send('明天下午三点提醒我提交合成报告');
    await openTodosTab();
    await panel.getByRole('button', { name: '完成提交合成报告', exact: true }).waitFor();
    await openChatTab();
    await send('已完成提交合成报告');
    assert.equal(await page.locator('.app-toast').count(), 0);
    await openTodosTab();
    await panel.getByRole('button', { name: '完成提交合成报告', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await panel.locator('.todo-history').getAttribute('open'), null);
    await openChatTab();
    await send('明天提醒我买合成水果');
    await openTodosTab();
    const row = panel.locator('.todo-row').filter({ hasText: '买合成水果' });
    await row.getByText('以后再设提醒',{exact:true}).click();
    const datetime = row.locator('input[type="datetime-local"]');
    assert.equal(await datetime.inputValue(), ''); assert.equal(await row.getByRole('button', { name: '设置提醒', exact: true }).isDisabled(), true);
    const date = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    await datetime.fill(date + 'T18:30'); await row.getByRole('button', { name: '设置提醒', exact: true }).click();
    await panel.getByRole('button', { name: '完成买合成水果', exact: true }).waitFor();
    await openChatTab();
    await send('明天下午四点准备整理合成书架');
    await openTodosTab();
    await panel.locator('.todo-group--suggested').getByText('整理合成书架', { exact: true }).waitFor();
    await openChatTab();
    await page.evaluate(async () => { const { Repository } = await import('/src/persistence/repository.ts'); const original = Repository.saveMessages; Repository.saveMessages = async (...args) => { Repository.saveMessages = original; await new Promise(resolve => { window.releaseTodoUiSend = resolve; }); return original(...args); }; });
    await input.fill('发送中原文'); await page.getByRole('button', { name: '发送文字记录', exact: true }).click();
    await page.waitForFunction(() => !!window.releaseTodoUiSend);
    await page.getByRole('button', { name: '生活卡片', exact: true }).click(); await openChatTab();
    await input.fill('切页后的新草稿'); await page.evaluate(() => window.releaseTodoUiSend());
    try {
      await page.waitForFunction(() => {
        const btn = document.querySelector('button[aria-label="发送文字记录"]');
        return !!btn && !btn.disabled && Array.from(document.querySelectorAll('p.whitespace-pre-wrap')).some(p => p.textContent?.includes('发送中原文'));
      });
    }
    catch(error){console.error('delayed-send diagnostic',await page.locator('body').innerText());throw error;}
    assert.equal(await input.inputValue(), '切页后的新草稿', '旧组件完成发送不得清空新草稿');
    await page.evaluate(async () => { const { Repository } = await import('/src/persistence/repository.ts'); const original = Repository.saveMessages; Repository.saveMessages = async (...args) => { Repository.saveMessages = original; throw new Error('受控写入失败'); }; });
    await input.fill('发送失败保留这段合成原文'); await page.getByRole('button', { name: '发送文字记录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '受控写入失败' }).waitFor();
    assert.equal(await input.inputValue(), '发送失败保留这段合成原文');
    const output = path.join(process.cwd(), 'output/playwright'); await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'background-todos-life.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(output, 'background-todos-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});

test('real browser: foreground due alert, cancellation and same-revision backup invalidation', { skip: process.env.LOOMA_UI_BROWSER !== '1', timeout:60000 },async()=>{
  const {chromium}=require(process.env.LOOMA_PLAYWRIGHT_MODULE||'playwright');const browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:1000}});const page=await context.newPage();
  try{
    await page.goto(process.env.LOOMA_TEST_URL||'http://127.0.0.1:5173');await page.getByRole('button',{name:'待办',exact:true}).click();await page.getByRole('region',{name:'生活待办',exact:true}).waitFor();
    await page.evaluate(async()=>{const {TodoService:s}=await import('/src/services/todos.ts');await s.configure(true);await s.create({id:'foreground-proof',space:'life',title:'合成页面到期验证',status:'pending',dueAt:new Date(Date.now()-1000).toISOString()});});
    await page.locator('.todo-foreground-notice').getByText(/合成页面到期验证/).waitFor();
    const state=await page.evaluate(async()=>{const {TodoService:s}=await import('/src/services/todos.ts');return(await s.list('life'))[0];});assert.equal(state.notifiedRevision,state.revision);
    await page.getByRole('button',{name:'完成合成页面到期验证',exact:true}).click();await page.locator('.todo-foreground-notice').waitFor({state:'detached'});
    await page.evaluate(async()=>{const {Repository:r}=await import('/src/persistence/repository.ts');const backup=JSON.parse(await r.exportAllData());backup.records=backup.records.filter(row=>row.kind!=='todo');if(!await r.importAllData(JSON.stringify(backup)))throw Error('restore failed');});
    await page.getByText('已完成历史 · 0',{exact:true}).waitFor();
  }finally{await context.close();await browser.close();}
});
