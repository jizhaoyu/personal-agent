const assert = require('node:assert/strict');
const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173';
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const action of ['confirm', 'discard', 'edit', 'switch']) {
      const context = await browser.newContext(); const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.addInitScript(() => {
        window.electronAPI = { modelStatus: async () => ({ configured: true, persistent: false, enabled: true, apiBaseUrl: 'http://localhost:11434/v1', modelName: 'controlled' }),
          setAlwaysOnTop: async () => false, cancelModel: async () => {}, proposeModel: async () => {
            await new Promise(resolve => setTimeout(resolve, 900));
            return { content: JSON.stringify({ engagements: [{ clientName: '李总', title: '不应覆盖的新模型结果', budgetAmount: 300 }], tasks: [], warnings: [] }) };
          } };
      });
      await page.goto(url); await page.getByText('桌面模型增强', { exact: true }).waitFor();
      await page.getByLabel('客户沟通记录', { exact: true }).fill('李总预算300元');
      await page.getByRole('button', { name: '整理并核对', exact: true }).click();
      await page.getByLabel('预算 1', { exact: true }).waitFor();
      if (action === 'confirm') await page.getByRole('button', { name: '确认并保存', exact: true }).click();
      if (action === 'discard') await page.getByRole('button', { name: '忽略整批', exact: true }).click();
      if (action === 'edit') await page.getByLabel('合作项目 1', { exact: true }).fill('人工保留标题');
      if (action === 'switch') await page.getByRole('button', { name: '生活态', exact: true }).click();
      await page.waitForTimeout(1100);
      const state = await page.evaluate(async () => { const { Repository } = await import('/src/persistence/repository.ts'); await Repository.initialize(); return (await Repository.refresh()).snapshot; });
      assert.doesNotMatch(await page.locator('main').innerText(), /不应覆盖的新模型结果/);
      assert.equal(state.partitions.work.engagements.length, action === 'confirm' ? 1 : 0);
      if (action === 'edit') assert.equal(await page.getByLabel('合作项目 1', { exact: true }).inputValue(), '人工保留标题');
      if (action === 'switch') assert.equal(state.activeMode, 'life');
      await context.close(); console.log(`PASS delayed-model-${action}`);
    }
    const context = await browser.newContext(); const page = await context.newPage(); await page.goto(url);
    await page.getByLabel('客户沟通记录', { exact: true }).fill('李总预算300元，明天前发原型');
    await page.getByRole('button', { name: '整理并核对', exact: true }).click(); await page.getByLabel('预算 1', { exact: true }).waitFor();
    await page.evaluate(() => { const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) { if (this.name === 'records' && value?.kind === 'task') throw new DOMException('controlled quota failure', 'QuotaExceededError'); return original.call(this, value, ...args); };
    });
    await page.getByRole('button', { name: '确认并保存', exact: true }).click(); await page.getByRole('alert').waitFor();
    const stats = await page.evaluate(async () => (await import('/src/persistence/repository.ts')).Repository.request({ op: 'stats', space: 'work' }));
    assert.equal(stats.counts.engagement, 0); assert.equal(stats.counts.task, 0); assert.equal(stats.counts.message, 1);
    assert.equal(await page.locator('.looma-companion[data-state="error"]').count(), 1);
    console.log('PASS real-IDB-mid-batch-failure-is-atomic-and-companion-reports-error'); await context.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
