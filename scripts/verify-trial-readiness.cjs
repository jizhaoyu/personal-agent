// Real-browser integration for trial preparation. Uses only synthetic data and an isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); const results = [], errors = [];
  const directory = path.resolve(__dirname, '../output/playwright'); await fs.mkdir(directory, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, acceptDownloads: true }); const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message)); const external = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:5173')) external.push(request.url()); });
  const pass = name => { results.push(name); console.log(`PASS ${name}`); };
  const backup = () => page.evaluate(async () => (await import('/src/persistence/repository.ts')).Repository.exportAllData());
  const practice = () => page.getByRole('dialog', { name: '放心练习一次', exact: true });
  try {
    await page.goto(process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173'); await page.getByLabel('客户沟通记录', { exact: true }).waitFor();
    await page.getByLabel('客户沟通记录', { exact: true }).fill('李总预算300元。合成真实草稿标记不应进入反馈。');
    await page.getByRole('button', { name: '整理并核对', exact: true }).click(); await page.getByLabel('预算 1', { exact: true }).fill('350');
    await page.locator('.draft-save-state').filter({ hasText: '草稿已保存在本机' }).waitFor();
    const before = await backup();
    await page.evaluate(() => { window.practiceWrites = 0; const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(...args) { window.practiceWrites++; return put.apply(this, args); }; });
    await page.getByRole('button', { name: '放心练习一次', exact: true }).click(); await practice().waitFor();
    assert.match(await practice().innerText(), /关闭后丢弃/);
    assert.equal(await page.locator('.workspace-content').evaluate(el => el.inert), true);
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.workspace-content')), false);
    }
    await practice().getByRole('button', { name: '整理并核对', exact: true }).click();
    await practice().getByLabel('预算 1', { exact: true }).fill('3600');
    await practice().getByRole('button', { name: '确认并保存', exact: true }).click();
    await practice().getByRole('region', { name: '演练回执', exact: true }).waitFor();
    assert.match(await practice().innerText(), /演练/); assert.match(await practice().innerText(), /3,600/);
    assert.equal(await practice().getByRole('button', { name: '演练中不准备纪要', exact: true }).isDisabled(), true);
    await page.screenshot({ path: path.join(directory, 'trial-practice-receipt.png'), fullPage: true });
    await practice().getByRole('button', { name: '查看项目', exact: true }).click();
    await practice().getByRole('region', { name: '演练项目', exact: true }).waitFor();
    await practice().getByRole('button', { name: '返回演练回执', exact: true }).click();
    await practice().locator('.receipt-source > summary').click(); await practice().getByRole('button', { name: '撤销这次记录', exact: true }).click();
    await practice().getByRole('heading', { name: /已撤销/ }).waitFor();
    assert.equal(await page.evaluate(() => window.practiceWrites), 0);
    assert.equal(await backup(), before); pass('完整演练核对、手改、确认、项目和撤销均零持久化写入，真实备份逐字相同');
    await practice().getByRole('button', { name: '关闭演练', exact: true }).click();
    assert.equal(await page.getByLabel('客户沟通记录', { exact: true }).inputValue(), '李总预算300元。合成真实草稿标记不应进入反馈。');
    assert.equal(await page.getByLabel('预算 1', { exact: true }).inputValue(), '350');
    await page.getByRole('button', { name: '放心练习一次', exact: true }).click(); await practice().getByLabel('演练沟通原文', { exact: true }).waitFor();
    assert.equal(await practice().getByRole('region', { name: '演练项目', exact: true }).count(), 0);
    await practice().getByRole('button', { name: '关闭演练', exact: true }).click(); pass('关闭即丢弃演练，重开从示例开始，真实原文和手改候选仍在');
    await page.getByRole('button', { name: '版本与问题记录', exact: true }).click();
    const feedback = page.getByRole('dialog', { name: '版本与问题记录', exact: true }); await feedback.waitFor();
    const defaultReport = await feedback.getByLabel('试用问题记录预览', { exact: true }).inputValue();
    assert.doesNotMatch(defaultReport, /李总|合成真实草稿标记|预算[^\n]*(?:300|350)|apiKey|127\.0\.0\.1/);
    assert.match(defaultReport, /trial-/); assert.equal(await feedback.getByRole('button', { name: '下载文本', exact: true }).isDisabled(), true);
    await feedback.getByLabel('试用问题实际', { exact: true }).fill('合成反馈：第二步需要解释');
    await feedback.getByLabel('我已核对完整预览，主动填写的内容也已脱敏', { exact: true }).check();
    const downloadPromise = page.waitForEvent('download'); await feedback.getByRole('button', { name: '下载文本', exact: true }).click();
    const download = await downloadPromise; const filename = path.join(directory, 'trial-feedback.txt'); await download.saveAs(filename);
    assert.match(await fs.readFile(filename, 'utf8'), /合成反馈：第二步需要解释/);
    assert.doesNotMatch(await fs.readFile(filename, 'utf8'), /李总|合成真实草稿标记|预算[^\n]*350/);
    assert.equal(await backup(), before); pass('反馈白名单排除真实输入与业务字段，主动核对后实际下载，数据不变');
    await page.setViewportSize({ width: 430, height: 932 });
    assert.equal(await feedback.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await page.screenshot({ path: path.join(directory, 'trial-feedback-integrated-mobile.png'), fullPage: true });
    await feedback.getByRole('button', { name: '关闭问题记录', exact: true }).click();
    await page.getByRole('button', { name: '放心练习一次', exact: true }).click();
    await practice().getByRole('button', { name: '整理并核对', exact: true }).click();
    assert.equal(await practice().evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await page.screenshot({ path: path.join(directory, 'trial-practice-mobile.png'), fullPage: true });
    await practice().getByRole('button', { name: '关闭演练', exact: true }).click(); pass('430px演练与反馈无横向溢出，关闭后回到真实工作区');
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    assert.equal(await page.locator('.optional-model-settings').evaluate(el => el.open), false);
    assert.match(await page.getByRole('dialog', { name: '设置与数据', exact: true }).innerText(), /无需配置模型即可开始/);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click(); pass('首次模型设置为可选且默认折叠');
    await page.getByRole('button', { name: '生活态', exact: true }).click();
    await page.getByRole('button', { name: '版本与问题记录', exact: true }).click();
    const lifeReport = await page.getByLabel('试用问题记录预览', { exact: true }).inputValue();
    assert.match(lifeReport, /所在空间：生活空间/); assert.doesNotMatch(lifeReport, /所在步骤：核对内容|合成真实草稿标记|李总/);
    await page.getByRole('button', { name: '关闭问题记录', exact: true }).click(); pass('生活态反馈和伴侣状态不沿用工作候选');
    assert.deepEqual(external, []); assert.deepEqual(errors, []); pass('无外部请求或未捕获异常');
    await fs.writeFile(path.join(directory, 'trial-readiness-verification.json'), JSON.stringify({ passed: results, externalRequests: external, errors }, null, 2));
  } catch (error) { console.error((await page.locator('body').innerText()).slice(-7000)); await page.screenshot({ path: path.join(directory, 'trial-readiness-failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
