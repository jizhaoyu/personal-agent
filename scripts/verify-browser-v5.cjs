// Optional real-browser acceptance; Playwright is supplied outside app dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(__dirname, '../output/playwright');
async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-browser-v5-'));
  const checks = [], errors = []; let context, page, failure;
  const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: 1280, height: 960 }, acceptDownloads: true });
    page = context.pages()[0]; page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173');
    await page.getByRole('button', { name: '工作态', exact: true }).waitFor();
  };
  const run = (fn, arg) => page.evaluate(async ({ body, arg }) => {
    const { Repository } = await import('/src/persistence/repository.ts');
    return new Function('Repository', 'arg', `return (${body})(Repository,arg)`)(Repository, arg);
  }, { body: fn.toString(), arg });
  const input = () => page.getByRole('textbox', { name: '客户沟通记录', exact: true });
  const click = name => page.getByRole('button', { name, exact: true }).click();
  const count = async (kind, expected) => page.waitForFunction(async ({ kind, expected }) => {
    const { Repository } = await import('/src/persistence/repository.ts');
    return (await Repository.request({ op: 'stats', space: 'work' })).counts[kind] === expected;
  }, { kind, expected });
  try {
    await fs.mkdir(output, { recursive: true }); await launch();
    assert.equal(await run(async R => (await R.query('work', 'engagement')).items.length), 0);
    assert.equal(await run(async R => (await R.query('life', 'expense')).items.length), 0);
    pass('全新工作区无虚构客户或账单');
    const raw = '李总的网站改版，预算300元。我周五发首页原型，客户下周一补素材，新增页面费用还没谈定。';
    await input().fill(raw);
    await page.locator('.draft-save-state').filter({ hasText: '草稿已保存在本机' }).waitFor();
    const revision = await run(async R => R.getCurrent().partitions.work.revision);
    await click('打开记忆中心'); await page.getByRole('region', { name: '工作记忆与档案', exact: true }).waitFor();
    await click('← 返回当前空间'); await click('随口记录'); assert.equal(await input().inputValue(), raw);
    await click('生活态'); await page.getByRole('heading', { name: '留一点空间，给生活。', exact: true }).waitFor();
    assert.equal((await page.locator('main').innerText()).includes(raw), false);
    await click('工作态'); await click('随口记录'); assert.equal(await input().inputValue(), raw);
    await page.reload(); await click('随口记录'); assert.equal(await input().inputValue(), raw);
    assert.equal(await run(async R => R.getCurrent().partitions.work.revision), revision);
    pass('500ms草稿、记忆查看、空间切换、刷新恢复且业务版本不变');
    await click('整理并核对'); await page.getByLabel('预算 1', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('预算 1', { exact: true }).inputValue(), '300');
    assert.equal(await run(async R => (await R.query('work', 'engagement')).items.length), 0);
    for (const text of ['本次核对内容', '我方下一步', '等待客户', '仍待确认']) assert.ok((await page.getByRole('region', { name: '待确认变更', exact: true }).innerText()).includes(text));
    await page.getByLabel('合作项目 1', { exact: true }).fill('网站改版');
    await page.getByLabel('预算 1', { exact: true }).fill('350');
    await page.getByText('查看与修改完整项目字段', { exact: true }).click();
    await page.getByText('内部备注 · 不进入外发纪要', { exact: true }).click();
    await page.getByLabel('内部备注 1', { exact: true }).fill('合成验收内部底价200与私人评价');
    await page.locator('.draft-save-state').filter({ hasText: '草稿已保存在本机' }).waitFor();
    await page.reload(); await click('随口记录'); assert.equal(await page.getByLabel('预算 1', { exact: true }).inputValue(), '350');
    await click('确认并保存'); await count('closure', 1); await count('capture_draft', 0);
    const receipt = page.getByRole('region', { name: '本次沟通收尾记录', exact: true }); await receipt.waitFor();
    assert.doesNotMatch(await receipt.innerText(), /全部完成|已达成共识|私人评价/);
    const saved = await run(async R => ({ project: (await R.query('work', 'engagement')).items[0], tasks: (await R.query('work', 'task')).items, follow: (await R.query('work', 'followup')).items, closure: (await R.query('work', 'closure')).items[0] }));
    assert.equal(saved.project.budgetAmount, 350); assert.equal(saved.tasks.length, 1);
    assert.ok(saved.follow.some(x => x.kind === 'waiting' && x.expectedDate && !x.expectedAt && !x.reviewAt));
    assert.ok(saved.follow.some(x => x.kind === 'question')); pass('四类核对、手动修改恢复、原子收尾与日期粒度');
    await page.screenshot({ path: path.join(output, 'v5-closure.png'), fullPage: true });
    await click('查看项目'); await page.getByRole('region', { name: '李总项目详情', exact: true }).waitFor();
    await page.getByRole('region', { name: '李总项目详情', exact: true }).getByRole('button', { name: /完成.*原型/ }).click();
    await page.waitForFunction(async id => { const { Repository:R } = await import('/src/persistence/repository.ts'); return (await R.get('work', 'task', id)).done; }, saved.tasks[0].id);
    await page.getByRole('region', { name: '李总项目详情', exact: true }).waitFor();
    await click('撤销这次操作');
    await page.waitForFunction(async id => { const { Repository:R } = await import('/src/persistence/repository.ts'); return !(await R.get('work', 'task', id)).done; }, saved.tasks[0].id);
    pass('明确完成直接保存、留在项目、绑定对应操作撤销');
    await click('随口记录'); await input().fill('张三说费用还没确定。'); await click('整理并核对');
    await page.getByText('这段沟通属于哪个合作项目？', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认并保存', exact: true }).isDisabled(), true);
    await page.getByLabel('明确新客户姓名', { exact: true }).fill('张三'); await page.getByLabel('新项目名称', { exact: true }).fill('新站讨论');
    await click('整理并核对'); await page.getByLabel('客户名称 1', { exact: true }).waitFor();
    await click('仅保存原文'); await count('closure', 2);
    assert.equal(await run(async R => (await R.query('work', 'engagement')).items.length), 1);
    await page.locator('.receipt-boundary').filter({ hasText: '仅保存原文，未更新项目或安排提醒。' }).waitFor();
    pass('普通姓名归属澄清、不重写原文、只存原文不改业务');
    await click('客户项目'); await page.getByRole('button', { name: '准备纪要', exact: true }).click();
    const alignment = page.getByLabel('可手动复制的纪要全文');
    assert.doesNotMatch(await alignment.inputValue(), /内部底价|私人评价|350|未定/);
    await page.getByLabel('纪要外发摘要').fill('讨论页面结构、原型验收和后续排期，请对方确认。'.repeat(20));
    await page.getByLabel('我已核对预览内容，确认可以对外分享').check();
    const download = page.waitForEvent('download'); await click('导出 PNG');
    const png = await download; const pngPath = path.join(output, 'v5-alignment-long.png'); await png.saveAs(pngPath); assert.ok((await fs.stat(pngPath)).size > 1000);
    await click('关闭纪要'); pass('长文本PNG与独立外发审核、内部和未定字段不自动进入');
    const backup = await run(async R => R.exportAllData());
    assert.equal(JSON.parse(backup).version, 'looma-v5');
    const before = await run(async R => (await R.query('work', 'engagement')).items);
    assert.equal(await run(async R => R.importAllData('{"version":"looma-v5","records":[{"kind":"engagement","space":"work","id":"bad","data":{}}]}')), false);
    assert.deepEqual(await run(async R => (await R.query('work', 'engagement')).items), before);
    assert.equal(await run(async (R, value) => R.importAllData(value), backup), true);
    await page.reload(); await click('接着处理'); await page.getByRole('region', { name: '最近沟通', exact: true }).waitFor();
    await context.close(); context = null; await launch(); await page.getByRole('region', { name: '最近沟通', exact: true }).waitFor();
    pass('v5完整备份恢复、坏备份不覆盖、关闭浏览器重开恢复');
    await page.screenshot({ path: path.join(output, 'v5-home.png'), fullPage: true });
    await page.setViewportSize({ width: 430, height: 932 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: path.join(output, 'v5-mobile.png'), fullPage: true }); pass('窄屏无横向溢出');
    assert.deepEqual(errors, []); pass('浏览器无未捕获异常');
  } catch (error) { failure = error; if (page) { console.error((await page.locator('body').innerText()).slice(-8000)); await page.screenshot({ path: path.join(output, 'v5-failure.png'), fullPage: true }).catch(() => {}); } }
  finally { if (context) await context.close(); await fs.writeFile(path.join(output, 'browser-v5-verification.json'), JSON.stringify({ passed: checks, errors, failure: failure?.message || null }, null, 2)); }
  if (failure) { console.log(`Retained synthetic QA profile: ${profile}`); throw failure; }
  if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('looma-browser-v5-')) await fs.rm(profile, { recursive: true, force: true });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
