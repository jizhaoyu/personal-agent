const test = require('node:test');
const assert = require('node:assert/strict');

test('real browser: bilingual zh-CN / en live toggle, reload persistence, and Settings selector stay synchronized', { skip: process.env.LOOMA_UI_BROWSER !== '1', timeout: 90000 }, async () => {
  const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  const origin = process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173';

  try {
    await page.goto(origin);
    await page.getByPlaceholder('随手记录…').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');

    // 1. Toggle to English via header quick switch button (EN)
    const toggleBtn = page.locator('button.lang-switch-btn');
    assert.equal((await toggleBtn.textContent()).trim(), 'EN');
    await toggleBtn.click();

    // Verify immediate reload-free UI switch across Life space
    await page.getByPlaceholder('Jot down anything…').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal((await toggleBtn.textContent()).trim(), '中');
    await page.getByRole('button', { name: 'Check-ins', exact: true }).click();
    await page.getByRole('heading', { name: 'Daily Check-ins', exact: true }).waitFor();
    await page.getByText('Active 0 / 3', { exact: true }).waitFor();

    // 2. Switch to Work space and verify English WorkBench + Work Reminders + Trial Report
    await page.getByRole('button', { name: 'Work', exact: true }).click();
    await page.getByRole('heading', { name: 'Capture a Work Update', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Organize Update', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Work Reminders', exact: true }).waitFor();

    await page.getByRole('button', { name: 'Version & Issue Log', exact: true }).click();
    const trialDialog = page.getByRole('dialog');
    await trialDialog.waitFor();
    const reportText = await trialDialog.locator('textarea[readonly]').inputValue();
    assert.match(reportText, /Looma Trial Issue Report/);
    assert.match(reportText, /Space: Work/);
    await page.getByRole('button', { name: 'Close issue log', exact: true }).click();

    // 3. Reload page and verify IndexedDB + localStorage persistence stays 'en' (app boots to Life space)
    await page.reload();
    await page.getByPlaceholder('Jot down anything…').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal((await page.locator('button.lang-switch-btn').textContent()).trim(), '中');

    // 4. Open Settings, confirm select value is 'en', and switch back via Settings <select> + Save Settings
    await page.getByRole('button', { name: 'Open Settings', exact: true }).click();
    const langSelect = page.getByLabel('Interface Language / 界面语言', { exact: true });
    assert.equal(await langSelect.inputValue(), 'en');
    await langSelect.selectOption('zh-CN');
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();

    await page.getByRole('heading', { name: '设置与数据', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();

    // 5. Confirm zh-CN UI restored on Life and Work header toggle shows EN
    await page.getByPlaceholder('随手记录…').waitFor();
    await page.getByRole('button', { name: '工作态', exact: true }).waitFor();
    assert.equal((await page.locator('button.lang-switch-btn').textContent()).trim(), 'EN');
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await browser.close();
  }
});
