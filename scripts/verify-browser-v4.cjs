// Optional real-browser v4 acceptance. Playwright stays outside application dependencies.
// The persistent profile contains synthetic QA records only and is removed after the run.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173';
const output = path.resolve(__dirname, '../output/playwright');

async function main() {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-browser-v4-'));
  const passed = []; const errors = []; let context; let page; let failure;
  const record = name => { passed.push(name); console.log(`PASS ${name}`); };
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, {
      channel: process.env.LOOMA_BROWSER_CHANNEL || 'msedge', headless: true,
      viewport: { width: 1280, height: 960 }, acceptDownloads: true,
    });
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button', { name: '工作态', exact: true }).waitFor();
  };
  const read = async (space, kind, options = {}) => page.evaluate(async ({ space, kind, options }) => {
    const { Repository } = await import('/src/persistence/repository.ts');
    return Repository.query(space, kind, options);
  }, { space, kind, options });
  const stats = async space => page.evaluate(async space => {
    const { Repository } = await import('/src/persistence/repository.ts');
    return Repository.request({ op: 'stats', space });
  }, space);
  const waitCount = async (space, kind, count) => page.waitForFunction(async ({ space, kind, count }) => {
    const { Repository } = await import('/src/persistence/repository.ts');
    return (await Repository.request({ op: 'stats', space })).counts[kind] === count;
  }, { space, kind, count });
  const memory = () => page.getByRole('region', { name: /记忆与档案/ });
  const memoryTab = async name => { await memory().getByRole('button', { name, exact: true }).click(); };
  const openMemory = async () => {
    await page.getByRole('button', { name: '打开记忆中心', exact: true }).click();
    await memory().waitFor();
  };
  const returnWorkspace = async () => page.getByRole('button', { name: '← 返回当前空间', exact: true }).click();
  const inputFact = async (subject, topic, fact) => {
    const form = memory().locator('.memory-compose');
    if (!(await form.getAttribute('open'))) {
      const isOpen = await form.evaluate(el => el.open);
      if (!isOpen) await form.locator('summary').click();
    }
    await form.getByLabel('主体', { exact: true }).fill(subject);
    await form.getByLabel('主题', { exact: true }).fill(topic);
    await form.getByLabel('需要确认的事实', { exact: true }).fill(fact);
    await form.getByRole('button', { name: /预览待确认事实|核对纠正内容/ }).click();
    await page.getByRole('dialog').waitFor();
  };
  try {
    await launch();
    assert.equal((await read('work', 'engagement')).items.length, 0);
    assert.equal((await read('life', 'expense')).items.length, 0);
    record('全新IndexedDB工作区无虚构客户与账单');

    const input = page.getByRole('textbox', { name: '客户沟通记录', exact: true });
    await input.fill('李总的网站改版项目，预算300元，明天前发原型。还没成交。');
    await page.getByRole('button', { name: '整理并核对', exact: true }).click();
    await page.getByLabel('预算 1', { exact: true }).waitFor();
    assert.equal((await read('work', 'engagement')).items.length, 0);
    assert.equal(await page.getByLabel('预算 1', { exact: true }).inputValue(), '300');
    await page.getByLabel('合作项目 1', { exact: true }).fill('网站改版');
    await page.getByLabel('预算 1', { exact: true }).fill('350');
    await page.getByText('内部备注 · 不进入外发纪要', { exact: true }).click();
    await page.getByLabel('内部备注 1', { exact: true }).fill('合成验收内部底价200与私人评价');
    await page.getByRole('button', { name: '确认并保存', exact: true }).click();
    await waitCount('work', 'engagement', 1);
    const project = (await read('work', 'engagement')).items[0];
    assert.equal(project.budgetAmount, 350);
    assert.notEqual(project.stage, '赢单成交');
    await page.reload();
    await page.getByRole('button', { name: '客户项目', exact: true }).click();
    await page.getByText('网站改版', { exact: true }).waitFor();
    record('工作输入→预览→编辑→确认→IndexedDB刷新恢复');

    await page.getByRole('button', { name: '准备纪要', exact: true }).click();
    const draft = page.getByLabel('可手动复制的纪要全文');
    assert.doesNotMatch(await draft.inputValue(), /内部底价|私人评价|350/);
    assert.equal(await page.getByRole('button', { name: '导出 PNG', exact: true }).isDisabled(), true);
    await page.getByLabel('纪要外发摘要').fill('讨论页面结构、原型验收和后续排期，请对方确认。'.repeat(20));
    await page.getByLabel('发原型', { exact: false }).check();
    await page.getByLabel('我已核对预览内容，确认可以对外分享').check();
    const pngPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
    const png = await pngPromise; const pngPath = path.join(output, 'v4-alignment-long.png');
    await png.saveAs(pngPath);
    assert.ok((await fs.stat(pngPath)).size > 1000);
    assert.doesNotMatch(await draft.inputValue(), /内部底价|私人评价/);
    await page.getByRole('button', { name: '关闭纪要', exact: true }).click();
    record('长文本纪要PNG下载、默认预算排除、内部字段排除与审核门槛');

    await page.getByRole('button', { name: '随口记录', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'v4-workbench-desktop.png') });
    await page.getByRole('button', { name: '收起为伴侣胶囊', exact: true }).first().click();
    const capsule = page.locator('.looma-companion--compact');
    await capsule.waitFor();
    const bounds = await capsule.boundingBox();
    assert.equal(bounds.width, 220); assert.equal(bounds.height, 96);
    assert.doesNotMatch(await capsule.innerText(), /李总|350|内部底价|网站改版/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await capsule.locator('.looma-companion__figure').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.screenshot({ path: path.join(output, 'v4-capsule.png') });
    await page.keyboard.press('Tab');
    await capsule.getByRole('button', { name: /^展开/ }).focus();
    assert.notEqual(await capsule.getByRole('button', { name: /^展开/ }).evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await page.keyboard.press('Enter');
    await input.waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, 'v4-workbench-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 960 });
    record('同一角色胶囊220×96、隐私、键盘展开、减弱动画及390px工作台');

    const workBeforeLife = (await stats('work')).counts;
    await page.getByRole('button', { name: '生活态', exact: true }).click();
    const lifeInput = page.getByPlaceholder('输入花销、体重、饮水或亲友备忘文字...');
    await lifeInput.fill('午饭花了35元');
    await page.getByRole('button', { name: '发送文字记录', exact: true }).click();
    await waitCount('life', 'expense', 1);
    await page.getByRole('button', { name: '生活卡片', exact: true }).click();
    await page.getByText('午饭', { exact: true }).waitFor();
    await page.getByRole('button', { name: '+攒 ¥200', exact: true }).click();
    await waitCount('life', 'expense', 2);
    await page.waitForFunction(async () => (await (await import('/src/persistence/repository.ts')).Repository.getWalletCard()).wishSaved === 200);
    await page.getByRole('button', { name: '手记', exact: true }).click();
    await page.getByRole('button', { name: '生成今日', exact: true }).click();
    await waitCount('life', 'journal', 1);
    await page.getByText('今日生活手记', { exact: true }).waitFor();
    assert.deepEqual((await stats('work')).counts, workBeforeLife);
    assert.doesNotMatch(await page.locator('main').innerText(), /李总|网站改版|内部底价/);
    const lifeBeforeWork = (await stats('life')).counts;
    await page.getByRole('button', { name: '工作态', exact: true }).click();
    await page.locator('.space-switch button.active').filter({ hasText: '工作态' }).waitFor();
    assert.doesNotMatch(await page.locator('main').innerText(), /午饭花了35元/);
    record('生活真实录入、钱包await保存、手记生成与双空间读写隔离');

    await openMemory();
    await inputFact('李总', '沟通偏好', '李总喜欢通过邮件沟通。');
    await page.getByRole('button', { name: '确认保存', exact: true }).click();
    await waitCount('work', 'memory', 1);
    const firstFact = memory().locator('.memory-item').filter({ hasText: '李总喜欢通过邮件沟通。' });
    await firstFact.getByRole('button', { name: '查看来源', exact: true }).click();
    await page.getByRole('dialog', { name: '原文依据', exact: true }).waitFor();
    assert.match(await page.getByRole('dialog').innerText(), /用户手动确认事实/);
    await page.getByRole('button', { name: '关闭来源', exact: true }).click();
    await inputFact('李总', '沟通偏好', '李总现在希望通过微信沟通。');
    await page.getByRole('heading', { name: '同一主题出现不同内容，请核对', exact: true }).waitFor();
    await page.getByRole('button', { name: '确认纠正并替代旧事实', exact: true }).click();
    await waitCount('work', 'memory', 2);
    const facts = (await read('work', 'memory')).items;
    assert.equal(facts.filter(fact => fact.status === 'active').length, 1);
    assert.equal(facts.filter(fact => fact.status === 'superseded').length, 1);
    record('记忆明确新增、来源可查、冲突确认纠正并保留旧事实');

    await memoryTab('只读回忆');
    const beforeRecall = (await stats('work')).counts;
    await memory().getByLabel('想回忆什么', { exact: true }).fill('李总');
    await memory().getByRole('button', { name: '查找依据', exact: true }).click();
    await memory().locator('.memory-budget').waitFor();
    assert.match(await memory().innerText(), /350|微信/);
    assert.deepEqual((await stats('work')).counts, beforeRecall);
    assert.doesNotMatch(await memory().innerText(), /午饭花了35元/);
    await memoryTab('历史档案');
    await memory().getByRole('button', { name: '整理最近确认记录', exact: true }).click();
    await page.waitForFunction(async () => (await (await import('/src/persistence/repository.ts')).Repository.request({ op: 'stats', space: 'work' })).counts.summary >= 1);
    await memory().getByText('本地可重建摘要 · 不是新增事实', { exact: true }).first().waitFor();
    assert.equal((await stats('work')).counts.memory, 2);
    await memoryTab('容量概况');
    await memory().getByRole('heading', { name: '档案增长，日常工作集保持有界', exact: true }).waitFor();
    await memory().getByRole('button', { name: '重建当前空间检索索引', exact: true }).click();
    await page.getByText('当前空间的检索索引已重建，业务记录未改变。', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'v4-memory-capacity.png') });
    record('只读回忆无业务写入、上下文有界、可重建摘要与容量说明');

    await memoryTab('长期事实');
    const activeFact = memory().locator('.memory-item').filter({ hasText: '李总现在希望通过微信沟通。' });
    await activeFact.getByRole('button', { name: '忘记', exact: true }).click();
    await page.getByRole('dialog', { name: '忘记这条事实', exact: true }).waitFor();
    await page.getByLabel('已了解范围，确认执行', { exact: true }).check();
    await page.getByRole('button', { name: '确认忘记', exact: true }).click();
    await page.waitForFunction(async () => (await (await import('/src/persistence/repository.ts')).Repository.query('work', 'memory')).items.some(item => item.fact.includes('微信') && item.status === 'retracted'));
    assert.ok((await read('work', 'message', { query: '微信' })).items.length > 0);
    await memoryTab('只读回忆');
    await memory().getByLabel('想回忆什么', { exact: true }).fill('沟通偏好');
    await memory().getByRole('button', { name: '查找依据', exact: true }).click();
    await memory().locator('.memory-budget').waitFor();
    assert.equal(await memory().locator('.memory-item-top').filter({ hasText: '已确认事实' }).count(), 0);
    record('主动忘记停用默认事实回忆、派生摘要清理并保留可查原文');

    await page.evaluate(async () => {
      const { Repository } = await import('/src/persistence/repository.ts');
      const base = Date.now() - 300000;
      await Repository.saveMessages(Array.from({ length: 240 }, (_, index) => ({ id: `qa-history-${index}`, role: 'user', content: `合成验收原文 第${String(index).padStart(3, '0')}条 绿茶资料`, timestamp: base + index })), 'work');
    });
    const countBeforeRestart = (await stats('work')).counts.message;
    assert.ok(countBeforeRestart > 200);
    let next; const ids = new Set(); let pages = 0;
    do { const batch = await read('work', 'message', { limit: 30, cursor: next }); assert.ok(batch.items.length <= 30); batch.items.forEach(item => { assert.equal(ids.has(item.id), false); ids.add(item.id); }); next = batch.nextCursor; pages++; } while (next);
    assert.equal(ids.size, countBeforeRestart); assert.ok(pages >= 8);
    await memoryTab('历史档案');
    await memory().getByLabel('资料类型', { exact: true }).selectOption('message');
    await memory().getByLabel('搜索当前空间', { exact: true }).fill('绿茶');
    await memory().getByRole('button', { name: '搜索', exact: true }).click();
    await memory().getByText('合成验收原文 第239条 绿茶资料', { exact: true }).waitFor();
    assert.equal(await memory().locator('.memory-item').count(), 30);
    await memory().getByRole('button', { name: '加载更早记录', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.memory-list .memory-item').length === 60);
    await context.close(); await launch();
    assert.equal((await stats('work')).counts.message, countBeforeRestart);
    const bootstrap = await page.evaluate(async () => { const { Repository } = await import('/src/persistence/repository.ts'); await Repository.initialize(); return Repository.getCurrent(); });
    assert.ok(bootstrap.partitions.work.messages.length <= 50);
    assert.ok((await read('work', 'message', { query: '绿茶', limit: 30 })).nextCursor);
    record('超过200条原文完整保留、30条分页无重漏、中文短词检索与真实浏览器重启');

    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    const originalExport = await page.evaluate(async () => (await import('/src/persistence/repository.ts')).Repository.exportAllData());
    await page.locator('input[type=file]').setInputFiles({ name: 'invalid-v4.json', mimeType: 'application/json', buffer: Buffer.from('{"version":"looma-v4","records":[{"space":"life"}]}') });
    await page.getByLabel('我已备份，确认替换两个空间的业务数据', { exact: true }).check();
    await page.getByRole('button', { name: '校验并恢复', exact: true }).click();
    await page.getByText('文件校验或写入失败，当前业务数据未替换。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => (await import('/src/persistence/repository.ts')).Repository.exportAllData()), originalExport);
    const backupPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出备份', exact: true }).click();
    const backupDownload = await backupPromise; const backupPath = path.join(output, 'v4-synthetic-backup.json'); await backupDownload.saveAs(backupPath);
    const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
    assert.equal(backup.version, 'looma-v4');
    assert.ok(backup.records.length > 240);
    assert.doesNotMatch(JSON.stringify(backup), /apiKey|accessToken|credential/i);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    record('坏备份完整校验不覆盖、双区完整备份下载且无凭据');

    await page.getByRole('button', { name: '变更记录', exact: true }).click();
    // Memory governance writes also have events. Undo in strict reverse order until the project batch.
    for (let index = 0; index < 8 && (await read('work', 'engagement')).items.length; index++) {
      const undo = page.getByRole('button', { name: '撤销最近变更', exact: true });
      if (await undo.isDisabled()) break;
      await undo.click();
      await page.waitForTimeout(80);
    }
    assert.equal((await read('work', 'engagement')).items.length, 0);
    assert.deepEqual((await stats('life')).counts, lifeBeforeWork);
    await page.reload();
    assert.equal((await read('work', 'engagement')).items.length, 0);
    record('最近批次逐步撤销、生活数据不变、撤销后刷新恢复');
    assert.deepEqual(errors, []);
  } catch (error) {
    failure = error;
    if (page) await page.screenshot({ path: path.join(output, 'v4-failure.png'), fullPage: true }).catch(() => {});
  } finally {
    await fs.writeFile(path.join(output, 'browser-v4-verification.json'), JSON.stringify({ passed, errors, failure: failure ? { message: failure.message, stack: failure.stack } : null }, null, 2));
    if (context) await context.close().catch(() => {});
    const target = path.resolve(profile), temporaryRoot = path.resolve(os.tmpdir());
    if (target.startsWith(`${temporaryRoot}${path.sep}`) && path.basename(target).startsWith('looma-browser-v4-')) await fs.rm(target, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ passed, errors, failure: failure?.message || null }, null, 2));
  if (failure) throw failure;
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
