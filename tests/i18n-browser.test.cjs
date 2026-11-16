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

    // 1. Header has NO .lang-switch-btn and .space-switch stays compact (<= 125px) with full accessible labels
    assert.equal(await page.locator('.lang-switch-btn').count(), 0);
    const switchBoxZh = await page.locator('.space-switch').boundingBox();
    assert.ok(switchBoxZh && switchBoxZh.width > 0 && switchBoxZh.width <= 125, `Expected .space-switch width <= 125px in zh-CN, got ${switchBoxZh?.width}`);
    assert.equal((await page.getByRole('button', { name: '工作态', exact: true }).textContent()).trim(), '工作');
    assert.equal((await page.getByRole('button', { name: '生活态', exact: true }).textContent()).trim(), '生活');

    // 2. Open Settings and switch to English via segmented radiogroup (instant update + immediate save)
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    const langGroup = page.getByRole('radiogroup', { name: '界面语言 / Language', exact: true });
    await langGroup.waitFor();
    const zhRadio = langGroup.getByRole('radio', { name: '简体中文', exact: true });
    const enRadio = langGroup.getByRole('radio', { name: 'English', exact: true });
    assert.equal(await zhRadio.getAttribute('aria-checked'), 'true');
    assert.equal(await enRadio.getAttribute('aria-checked'), 'false');
    await enRadio.click();

    await page.getByText('Switched to English.', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Settings & Data', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    const langGroupEn = page.getByRole('radiogroup', { name: 'Interface Language / 界面语言', exact: true });
    assert.equal(await langGroupEn.getByRole('radio', { name: 'English', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await langGroupEn.getByRole('radio', { name: '简体中文', exact: true }).getAttribute('aria-checked'), 'false');
    await page.getByRole('button', { name: 'Close Settings', exact: true }).click();

    // Verify immediate reload-free UI switch across Life space & Check-ins
    await page.getByPlaceholder('Jot down anything…').waitFor();
    const switchBoxEn = await page.locator('.space-switch').boundingBox();
    assert.ok(switchBoxEn && switchBoxEn.width > 0 && switchBoxEn.width <= 125, `Expected .space-switch width <= 125px in en, got ${switchBoxEn?.width}`);
    assert.equal((await page.getByRole('button', { name: 'Work', exact: true }).textContent()).trim(), 'Work');
    assert.equal((await page.getByRole('button', { name: 'Life', exact: true }).textContent()).trim(), 'Life');
    await page.getByRole('button', { name: 'Check-ins', exact: true }).click();
    await page.getByRole('heading', { name: 'Daily Check-ins', exact: true }).waitFor();
    await page.getByText('Active 0 / 3', { exact: true }).waitFor();

    // 3. Switch to Work space and verify English WorkBench + Work Reminders + Trial Report
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

    // 4. Reload page and verify IndexedDB + localStorage persistence stays 'en' (app boots to Life space)
    await page.reload();
    await page.getByPlaceholder('Jot down anything…').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.locator('.lang-switch-btn').count(), 0);

    // 5. Open Settings, confirm segmented control shows 'en', switch back to 'zh-CN', and verify bottom Save Settings still works
    await page.getByRole('button', { name: 'Open Settings', exact: true }).click();
    const langGroupReloaded = page.getByRole('radiogroup', { name: 'Interface Language / 界面语言', exact: true });
    const enRadioReloaded = langGroupReloaded.getByRole('radio', { name: 'English', exact: true });
    const zhRadioReloaded = langGroupReloaded.getByRole('radio', { name: '简体中文', exact: true });
    assert.equal(await enRadioReloaded.getAttribute('aria-checked'), 'true');
    await zhRadioReloaded.click();
    await page.getByText('已切换为简体中文。', { exact: true }).waitFor();
    await page.getByRole('heading', { name: '设置与数据', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-CN');
    const langGroupZh = page.getByRole('radiogroup', { name: '界面语言 / Language', exact: true });
    assert.equal(await langGroupZh.getByRole('radio', { name: '简体中文', exact: true }).getAttribute('aria-checked'), 'true');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByText('设置已保存。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();

    // 6. Confirm zh-CN UI restored cleanly on Life and Work header labels
    await page.getByPlaceholder('随手记录…').waitFor();
    assert.equal((await page.getByRole('button', { name: '工作态', exact: true }).textContent()).trim(), '工作');
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await browser.close();
  }
});
