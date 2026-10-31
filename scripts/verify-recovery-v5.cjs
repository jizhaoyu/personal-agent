const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); const checks = [];
  const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
  const open = async () => { const page = await browser.newPage(); page.setDefaultTimeout(12000); page.on('dialog', d => d.accept()); await page.goto(process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173'); await page.getByLabel('客户沟通记录', { exact: true }).waitFor(); return page; };
  const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
  const preview = async page => { await page.getByLabel('客户沟通记录', { exact: true }).fill('李总预算300元'); await click(page, '整理并核对'); await page.getByLabel('预算 1', { exact: true }).waitFor(); };
  try {
    let page = await open();
    await page.evaluate(() => { const put = IDBObjectStore.prototype.put; window.restorePut = () => { IDBObjectStore.prototype.put = put; }; IDBObjectStore.prototype.put = function(value, ...args) { if (this.name === 'records' && value?.kind === 'capture_draft') throw new DOMException('controlled quota failure', 'QuotaExceededError'); return put.call(this, value, ...args); }; });
    await page.getByLabel('客户沟通记录', { exact: true }).fill('保存失败时仍要保留的合成原文');
    await page.getByRole('button', { name: '重试保存草稿', exact: true }).waitFor();
    assert.equal(await page.getByLabel('客户沟通记录', { exact: true }).inputValue(), '保存失败时仍要保留的合成原文');
    await click(page, '生活态'); await page.getByRole('alert').waitFor(); assert.ok(await page.getByLabel('客户沟通记录', { exact: true }).isVisible());
    await page.evaluate(() => window.restorePut()); await click(page, '重试保存草稿');
    await page.locator('.draft-save-state').filter({ hasText: '草稿已保存在本机' }).waitFor(); await page.reload(); await click(page, '随口记录');
    assert.equal(await page.getByLabel('客户沟通记录', { exact: true }).inputValue(), '保存失败时仍要保留的合成原文');
    pass('真实IndexedDB草稿写失败保留输入、阻止离开、明确重试恢复'); await page.context().close();

    page = await open(); await preview(page);
    await page.evaluate(async () => {
      const { createIndexedDbBackend } = await import('/src/persistence/indexedDb.ts'); const backend = createIndexedDbBackend();
      let lost = false, failLookup = false;
      window.electronAPI = { storeRequest: async command => {
        if (command.op === 'commitCapture' && !lost) { lost = true; await backend.request(command); failLookup = true; throw new Error('controlled lost ACK'); }
        if (command.op === 'get' && command.kind === 'closure' && failLookup) { failLookup = false; throw new Error('controlled unavailable reconciliation'); }
        return backend.request(command);
      } };
    });
    await click(page, '确认并保存'); await page.getByRole('button', { name: '核查本次保存结果', exact: true }).waitFor();
    assert.equal(await page.getByLabel('客户沟通记录', { exact: true }).isDisabled(), true);
    await click(page, '核查本次保存结果'); await page.getByRole('region', { name: '本次沟通收尾记录', exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => (await window.electronAPI.storeRequest({ op: 'stats', space: 'work' })).counts.closure), 1);
    assert.equal(await page.evaluate(async () => (await window.electronAPI.storeRequest({ op: 'stats', space: 'work' })).counts.engagement), 1);
    pass('真实提交后受控丢失ACK、结果不确定保留并锁定草稿、核查仅形成一次回执'); await page.context().close();

    page = await open(); await preview(page);
    await page.evaluate(async () => {
      const { createIndexedDbBackend } = await import('/src/persistence/indexedDb.ts'); const backend = createIndexedDbBackend(); let nextReadFails = false;
      window.electronAPI = { storeRequest: async command => {
        if (command.op === 'commitCapture') { const result = await backend.request(command); nextReadFails = result.ok; return result; }
        if (command.op === 'bootstrap' && nextReadFails) { nextReadFails = false; throw new Error('controlled view refresh failure'); }
        return backend.request(command);
      } };
    });
    await click(page, '确认并保存'); await page.getByRole('region', { name: '本次沟通收尾记录', exact: true }).waitFor();
    assert.match(await page.getByRole('alert').innerText(), /已保存.*视图尚未刷新/);
    assert.equal(await page.evaluate(async () => (await window.electronAPI.storeRequest({ op: 'stats', space: 'work' })).counts.capture_draft), 0);
    pass('写入ACK成功后刷新失败仍明确已保存、草稿已结束'); await page.context().close();

    page = await open();
    const project = await page.evaluate(async () => { const { Repository:R } = await import('/src/persistence/repository.ts'); const value = { id: 'rebase', clientName: '李总', title: '网站改版', budgetAmount: 80000, stage: '需求确认', internalContext: '', shareableSummary: '', nextAction: '', updatedAt: 1 }; await R.upsert('work', 'engagement', [value]); return value; });
    await page.getByLabel('客户沟通记录', { exact: true }).fill('李总预算从8万改为12万'); await click(page, '整理并核对'); await page.getByLabel('预算 1', { exact: true }).fill('125000');
    await page.evaluate(async value => { const { Repository:R } = await import('/src/persistence/repository.ts'); await R.upsert('work', 'engagement', [{ ...value, budgetAmount: 100000, updatedAt: 2 }]); }, project);
    await click(page, '确认并保存'); await page.getByRole('alert').waitFor(); assert.equal(await page.getByLabel('预算 1', { exact: true }).inputValue(), '125000');
    await click(page, '重新核对当前资料'); await page.getByRole('region', { name: '需要重新核对的冲突', exact: true }).waitFor();
    assert.match(await page.getByRole('region', { name: '需要重新核对的冲突', exact: true }).innerText(), /100000/);
    await click(page, '使用本次修改'); await click(page, '确认并保存'); await page.getByRole('region', { name: '本次沟通收尾记录', exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => (await (await import('/src/persistence/repository.ts')).Repository.get('work', 'engagement', 'rebase')).budgetAmount), 125000);
    pass('旧预览拒绝覆盖新值、保留手改、展示冲突后明确选择'); await page.context().close();

    page = await open(); await preview(page);
    await page.evaluate(async () => { const { createIndexedDbBackend } = await import('/src/persistence/indexedDb.ts'); const backend = createIndexedDbBackend(); let hold = true; window.electronAPI = { storeRequest: async command => { if (hold && command.op === 'list' && command.ids) { hold = false; await new Promise(resolve => { window.releaseRebase = resolve; }); } return backend.request(command); } }; });
    await click(page, '重新核对当前资料'); await page.waitForFunction(() => typeof window.releaseRebase === 'function');
    await page.getByLabel('预算 1', { exact: true }).fill('375'); await page.evaluate(() => window.releaseRebase());
    await page.waitForTimeout(150); assert.equal(await page.getByLabel('预算 1', { exact: true }).inputValue(), '375');
    await page.locator('.draft-save-state').filter({ hasText: '草稿已保存在本机' }).waitFor();
    pass('迟到的重新核对响应不覆盖期间的手动编辑'); await page.context().close();
    page = await open(); await preview(page); await click(page, '打开设置');
    const backupDownload = page.waitForEvent('download'); await click(page, '导出备份');
    const backupFile = await backupDownload; const backupPath = path.resolve(__dirname, '../output/playwright/v5-draft-backup.json');
    await fs.mkdir(path.dirname(backupPath), { recursive: true }); await backupFile.saveAs(backupPath); await click(page, '关闭设置');
    await click(page, '确认并保存'); await page.getByRole('region', { name: '本次沟通收尾记录', exact: true }).waitFor();
    await click(page, '打开设置'); await page.locator('input[type=file]').setInputFiles(backupPath);
    await page.getByLabel('我已备份，确认替换两个空间的业务数据', { exact: true }).check(); await click(page, '校验并恢复');
    await page.getByText('业务数据已完整恢复，模型凭据保持独立。', { exact: true }).waitFor(); await click(page, '关闭设置'); await click(page, '随口记录');
    assert.equal(await page.getByLabel('预算 1', { exact: true }).inputValue(), '300'); await click(page, '确认并保存');
    await page.getByRole('region', { name: '本次沟通收尾记录', exact: true }).waitFor();
    const restoredCounts = await page.evaluate(async () => (await (await import('/src/persistence/repository.ts')).Repository.request({ op: 'stats', space: 'work' })).counts);
    assert.equal(restoredCounts.engagement, 1); assert.equal(restoredCounts.closure, 1); assert.equal(restoredCounts.capture_draft, 0);
    pass('从真实设置页恢复确认前备份后，同一候选重新提交，不复用旧成功缓存'); await page.context().close();
    await fs.mkdir(path.resolve(__dirname, '../output/playwright'), { recursive: true });
    await fs.writeFile(path.resolve(__dirname, '../output/playwright/recovery-v5-verification.json'), JSON.stringify({ passed: checks }, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
