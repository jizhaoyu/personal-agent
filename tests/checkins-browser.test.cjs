const test = require('node:test');
const assert = require('node:assert/strict');

test('real browser: check-in tab creation, max-3 cap, inline rename, daily 1-step limit, reminder sync, reload persistence, and card isolation', { skip: process.env.LOOMA_UI_BROWSER !== '1', timeout: 90000 }, async () => {
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

    // 1. Switch to 打卡 tab
    await page.getByRole('button', { name: '打卡', exact: true }).click();
    const panel = page.getByRole('region', { name: '每日打卡', exact: true });
    await panel.waitFor();
    await panel.getByText('进行中 0 / 3', { exact: true }).waitFor();

    // 2. Create 7-day check-in "读书" with reminder 23:55
    await panel.getByLabel('新打卡名称', { exact: true }).fill('读书');
    await panel.getByRole('button', { name: '7天', exact: true }).click();
    await panel.getByLabel('新打卡每日最晚提醒时间', { exact: true }).fill('23:55');
    await panel.getByRole('button', { name: '+ 开启打卡', exact: true }).click();

    const readingCard = panel.locator('.checkin-card').filter({ hasText: '读书' });
    await readingCard.waitFor();
    assert.equal(await readingCard.locator('button.checkin-square').count(), 7);
    await readingCard.getByText('0 / 7 天', { exact: true }).waitFor();

    // 3. Check today's box once -> 1 / 7 天
    await readingCard.getByRole('button', { name: '读书 第 1 天今日打卡', exact: true }).click();
    await readingCard.getByText('1 / 7 天', { exact: true }).waitFor();
    await readingCard.getByText('今日已打', { exact: true }).waitFor();

    // 4. Attempting to click box #2 on the same day stays at 1 / 7 and shows daily limit tip
    await readingCard.getByRole('button', { name: /读书 第 2 天/ }).click();
    await panel.getByText(/每天限打 1 格/).waitFor();
    await readingCard.getByText('1 / 7 天', { exact: true }).waitFor();

    // 5. Inline rename "读书" -> "睡前读书"
    await readingCard.getByRole('button', { name: '编辑名称 读书', exact: true }).click();
    const renameInput = panel.getByLabel('修改打卡名称', { exact: true });
    await renameInput.fill('睡前读书');
    await renameInput.press('Enter');
    const renamedCard = panel.locator('.checkin-card').filter({ hasText: '睡前读书' });
    await renamedCard.waitFor();

    // 6. Verify reminder synced into 待办 with updated title
    await page.getByRole('button', { name: '待办', exact: true }).click();
    const todoPanel = page.getByRole('region', { name: '生活待办', exact: true });
    await todoPanel.waitFor();
    await todoPanel.getByText('睡前读书 · 每日打卡提醒', { exact: true }).waitFor();

    // 7. Return to 打卡, add 2 more active tracks -> hits 3 / 3 cap
    await page.getByRole('button', { name: '打卡', exact: true }).click();
    await panel.waitFor();

    await panel.getByLabel('新打卡名称', { exact: true }).fill('背单词');
    await panel.getByRole('button', { name: '14天', exact: true }).click();
    await panel.getByRole('button', { name: '+ 开启打卡', exact: true }).click();
    await panel.locator('.checkin-card').filter({ hasText: '背单词' }).waitFor();

    await panel.getByLabel('新打卡名称', { exact: true }).fill('早睡');
    await panel.getByRole('button', { name: '21天', exact: true }).click();
    await panel.getByRole('button', { name: '+ 开启打卡', exact: true }).click();
    await panel.locator('.checkin-card').filter({ hasText: '早睡' }).waitFor();

    await panel.getByText('进行中 3 / 3', { exact: true }).waitFor();
    assert.equal(await panel.getByLabel('新打卡名称', { exact: true }).isDisabled(), true);
    assert.equal(await panel.getByRole('button', { name: '并行上限 3 条', exact: true }).isDisabled(), true);

    // 8. Archiving "早睡" frees one active slot
    const sleepCard = panel.locator('.checkin-card').filter({ hasText: '早睡' });
    await sleepCard.getByRole('button', { name: '归档', exact: true }).click();
    await panel.getByText('进行中 2 / 3', { exact: true }).waitFor();
    await panel.getByText('已归档 · 1', { exact: true }).waitFor();
    assert.equal(await panel.getByLabel('新打卡名称', { exact: true }).isDisabled(), false);

    // 9. LivingCardsBoard must NOT duplicate check-in cards inside "自定义"
    await page.getByRole('button', { name: '生活卡片', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: /自定义\(/ }).count(), 0);

    // 10. Reload page and assert full IndexedDB persistence
    await page.reload();
    await page.getByRole('button', { name: '打卡', exact: true }).click();
    await panel.waitFor();
    await panel.getByText('进行中 2 / 3', { exact: true }).waitFor();
    await panel.locator('.checkin-card').filter({ hasText: '睡前读书' }).getByText('1 / 7 天', { exact: true }).waitFor();
    await panel.locator('.checkin-card').filter({ hasText: '背单词' }).getByText('0 / 14 天', { exact: true }).waitFor();
    await panel.getByText('已归档 · 1', { exact: true }).waitFor();

    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
