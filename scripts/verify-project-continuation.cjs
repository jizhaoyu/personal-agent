// Synthetic records only, in an isolated browser profile. No model or customer data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173';
const output = path.resolve(__dirname, '../output/playwright');
async function main() {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  const errors = [], external = [], passed = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin + '/')) external.push(request.url()); });
  const pass = text => { passed.push(text); console.log(`PASS ${text}`); };
  try {
    await page.goto(origin); await page.getByRole('button', { name: '工作态', exact: true }).waitFor();
    await page.evaluate(async () => {
      const { Repository: r } = await import('/src/persistence/repository.ts');
      const baseline = JSON.parse(await r.exportAllData());
      const project = { id: 'continuation-p', clientName: '合成陈总', title: '商城改版', stage: '需求确认', budgetAmount: 300, internalContext: '内部底价仅本人查看', shareableSummary: '当前公开摘要：商城首页改版', nextAction: '周五发送报价（项目级安排）', updatedAt: 100 };
      const other = { ...project, id: 'continuation-other', title: '同客户另一项目', shareableSummary: '另一项目专用摘要', budgetAmount: undefined };
      const tasks = Array.from({ length: 60 }, (_, i) => ({ id: `ct-${i}`, title: `合成行动${i}`, assignee: i === 0 ? '我' : '项目负责人', done: i >= 30, deadline: i === 0 ? '月底提交' : '', ...(i === 0 ? { sourceDeadlineText: '月底前', dueAt: '2026-11-23T01:00:00Z' } : {}), priority: 'medium', engagementId: project.id }));
      const followUps = ['waiting', 'question'].flatMap(kind => ['open', 'resolved'].map((status, i) => ({ id: `${kind}-${i}`, kind, title: `${kind === 'waiting' ? '客户补素材' : '费用未定'}${i}`, engagementId: project.id, status, sourceMessageId: 'cm-35', createdAt: 1, updatedAt: 1, ...(kind === 'waiting' ? { expectedDate: '2026-11-09', reviewAt: '2026-11-10T01:00:00Z' } : {}) })));
      const records = [];
      const add = (kind, data, at = data.updatedAt || data.timestamp || data.confirmedAt || data.createdAt || 1) => records.push({ space: 'work', kind, id: data.id, data, at });
      add('engagement', project); add('engagement', other); tasks.forEach(t => add('task', t)); followUps.forEach(f => add('followup', f));
      for (let i = 1; i <= 35; i++) {
        const after = { ...project, budgetAmount: i === 35 ? 300 : 100 + i };
        add('message', { id: `cm-${i}`, role: 'user', content: `合成沟通原文${i}：核对商城预算与我方行动。`, timestamp: i });
        add('event', { id: `ce-${i}`, proposalId: `cp-${i}`, mode: 'work', sourceMessageId: `cm-${i}`, sourceText: '事件正文副本不应作为原文回退', createdAt: i, operations: [{ target: 'engagement', entityId: project.id, before: null, after }, ...(i === 35 ? [{ target: 'task', entityId: 'ct-0', before: null, after: tasks[0] }] : [])], ...(i === 34 ? { revertedAt: 50 } : {}) });
        add('closure', { id: `cc-${i}`, mode: 'work', sourceMessageId: `cm-${i}`, eventId: `ce-${i}`, engagementIds: [project.id], taskIds: i === 35 ? ['ct-0'] : [], followUpIds: [], confirmedAt: i, ...(i === 34 ? { revertedAt: 50 } : {}), ...(i === 33 ? { originalOnly: true } : {}) });
      }
      if (!await r.importAllData(JSON.stringify({ ...baseline, records, mode: 'work', applied: [] }))) throw new Error('synthetic import failed');
      window.continuationFixture = { project, other };
    });
    await page.getByRole('button', { name: '工作态', exact: true }).click();
    await page.getByRole('button', { name: '项目', exact: true }).click();
    const open = async title => {
      await page.locator('.project-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button', { name: '详情', exact: true }).click();
      await page.getByRole('region', { name: `合成陈总 · ${title}项目接续`, exact: true }).waitFor();
    };
    await open('商城改版');
    const detail = () => page.getByRole('region', { name: '合成陈总 · 商城改版项目接续', exact: true });
    assert.match(await detail().innerText(), /当前保存值|当前公开摘要/);
    assert.equal(await detail().locator('.continuation-private').evaluate(el => el.open), false);
    assert.equal(await detail().getByRole('region', { name: '项目我方下一步' }).locator('details').evaluate(el => el.open), false);
    assert.match(await detail().getByRole('region', { name: '项目等待客户' }).innerText(), /2026-11-09.*2026[/-]11[/-]10/s);
    assert.doesNotMatch(await detail().getByRole('region', { name: '项目仍待确认' }).innerText(), /2026-11-09/);
    pass('当前事实、我方行动、等待客户与未定分区，完成项和内部备注默认折叠');
    while (await detail().getByRole('button', { name: '还有更多，加载行动', exact: true }).count()) {
      await detail().getByRole('button', { name: '还有更多，加载行动', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.continuation-columns') && !document.querySelector('.continuation-more[disabled]'));
    }
    assert.equal(await detail().getByRole('region', { name: '项目我方下一步' }).locator('.continuation-item:has(.task-row)').count(), 60);
    await detail().getByRole('button', { name: '还有更多，加载最近变化', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.continuation-history .recent-closure').length === 35);
    pass('真实 IndexedDB 项目行动与收尾分页完整，未将首页窗口当全量');
    const datedTask = detail().locator('.continuation-item').filter({ has: page.getByRole('heading', { name: '合成行动0', exact: true }) });
    assert.match(await datedTask.innerText(), /原日期表达：月底前/); assert.match(await datedTask.innerText(), /我方提醒/);
    await datedTask.getByRole('button', { name: '查看原日期依据', exact: true }).click();
    const dateSource = page.getByRole('region', { name: '字段依据', exact: true });
    await dateSource.getByText('历史记录中的相同值', { exact: true }).waitFor();
    assert.match(await dateSource.innerText(), /当前保存值：月底前/);
    await dateSource.getByRole('button', { name: '关闭依据', exact: true }).click();
    pass('原日期表达与我方提醒分开显示，原日期依据查询对应字段');
    const budgetButton = detail().getByRole('button', { name: '查看预算依据', exact: true });
    await budgetButton.click(); const source = () => page.getByRole('region', { name: '字段依据', exact: true });
    await source().getByText('历史记录中的相同值', { exact: true }).waitFor();
    assert.match(await source().innerText(), /当前保存值：¥300|已撤销的历史变更|历史值/);
    await source().locator('summary').first().click(); assert.match(await source().innerText(), /合成沟通原文35/);
    await source().getByRole('button', { name: '查找更早依据', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.continuation-source-entry').length > 10);
    await source().focus(); await page.keyboard.press('Escape'); await source().waitFor({ state: 'detached' });
    assert.equal(await budgetButton.evaluate(el => el === document.activeElement), true);
    pass('字段历史独立于当前值、撤销与仅原文状态正确，来源按需分页，Escape关闭并归还焦点');
    await page.evaluate(async () => {
      const { Repository: r } = await import('/src/persistence/repository.ts');
      await r.transaction('work', [{ kind: 'message', id: 'cm-35', before: await r.get('work', 'message', 'cm-35'), after: null }], { event: false, redactSourceIds: ['cm-35'] });
    });
    await detail().getByRole('button', { name: '查看预算依据', exact: true }).click();
    await source().getByText('来源原文已删除或不可用，不从事件副本恢复正文。', { exact: true }).waitFor();
    assert.doesNotMatch(await source().innerText(), /事件正文副本不应作为原文回退|合成沟通原文35/);
    await source().getByRole('button', { name: '关闭依据', exact: true }).click();
    pass('删除原文后不从事件副本恢复正文');
    await detail().getByRole('button', { name: '继续记录此项目', exact: true }).click();
    assert.equal(await page.getByLabel('目标项目', { exact: true }).inputValue(), 'continuation-p');
    await page.getByLabel('客户沟通记录', { exact: true }).fill('合成草稿必须保留，不得更换归属');
    await page.getByRole('button', { name: '项目', exact: true }).click(); await open('同客户另一项目');
    const other = page.getByRole('region', { name: '合成陈总 · 同客户另一项目项目接续', exact: true });
    await other.getByRole('button', { name: '继续现有草稿', exact: true }).waitFor(); assert.match(await other.innerText(), /预算待定/);
    assert.match(await other.getByRole('region', { name: '项目我方下一步' }).innerText(), /周五发送报价（项目级安排）/);
    assert.doesNotMatch(await other.innerText(), /合成行动|当前公开摘要：商城/);
    await other.getByRole('button', { name: '继续现有草稿', exact: true }).click();
    assert.equal(await page.getByLabel('客户沟通记录', { exact: true }).inputValue(), '合成草稿必须保留，不得更换归属');
    assert.equal(await page.getByLabel('目标项目', { exact: true }).inputValue(), 'continuation-p');
    pass('继续记录带入项目，同客户多项目不串数据且不覆盖另一项目草稿');
    await page.getByRole('button', { name: '项目', exact: true }).click(); await open('商城改版');
    await page.screenshot({ path: path.join(output, 'project-continuation-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 430, height: 932 });
    assert.equal(await detail().evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await detail().getByRole('button', { name: '查看预算依据', exact: true }).click();
    await source().getByText('历史记录中的相同值', { exact: true }).waitFor();
    assert.equal(await source().evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await page.screenshot({ path: path.join(output, 'project-continuation-mobile.png'), fullPage: true });
    await source().getByRole('button', { name: '关闭依据', exact: true }).click();
    pass('桌面与430px窄窗口接续、来源布局无横向溢出');
    await page.evaluate(async () => {
      const { Repository: r } = await import('/src/persistence/repository.ts');
      window.originalContinuationGet = r.get;
      r.get = async (space, kind, id) => { if (kind === 'engagement') throw new Error('synthetic read failure'); return window.originalContinuationGet(space, kind, id); };
    });
    await detail().getByRole('button', { name: '收起', exact: true }).click();
    await page.locator('.project-card').filter({ has: page.getByRole('heading', { name: '商城改版', exact: true }) }).getByRole('button', { name: '详情', exact: true }).click();
    await page.getByRole('button', { name: '重试读取项目', exact: true }).waitFor();
    await page.evaluate(async () => { (await import('/src/persistence/repository.ts')).Repository.get = window.originalContinuationGet; });
    await page.getByRole('button', { name: '重试读取项目', exact: true }).click(); await detail().waitFor();
    pass('读取失败不冒充空状态，恢复后可显式重试');
    await detail().getByRole('button', { name: '完成合成行动9', exact: true }).click();
    await detail().getByRole('button', { name: '完成合成行动9', exact: true }).waitFor({ state: 'hidden' });
    pass('项目中完成行动后刷新到已完成分组');
    await page.evaluate(async () => {
      const { Repository: r } = await import('/src/persistence/repository.ts');
      window.originalEvidenceGet = r.get;
      window.evidenceGate = new Promise(resolve => { window.releaseEvidence = resolve; });
      window.evidenceStarted = false;
      r.get = async (...args) => { const value = await window.originalEvidenceGet(...args); if (args[1] === 'message' && args[2] === 'cm-35') { window.evidenceStarted = true; await window.evidenceGate; } return value; };
    });
    await detail().getByRole('button', { name: '查看预算依据', exact: true }).click();
    await page.waitForFunction(() => window.evidenceStarted);
    await page.evaluate(async () => {
      const { Repository: r } = await import('/src/persistence/repository.ts');
      const backup = JSON.parse(await r.exportAllData());
      backup.records.find(row => row.kind === 'engagement' && row.id === 'continuation-p').data.budgetAmount = 700;
      const identity = r.getReadIdentity(), revision = r.getCurrent().partitions.work.revision;
      if (!await r.importAllData(JSON.stringify(backup))) throw new Error('restore failed');
      if (r.getReadIdentity() === identity || r.getCurrent().partitions.work.revision !== revision) throw new Error('restore identity regression');
      r.get = window.originalEvidenceGet; window.releaseEvidence();
    });
    await detail().locator('.continuation-facts').getByText('¥700', { exact: true }).waitFor();
    await page.locator('.project-card').filter({ has: page.getByRole('heading', { name: '商城改版', exact: true }) }).getByText('¥700', { exact: true }).waitFor();
    assert.equal(await source().count(), 0);
    pass('同业务版本恢复使详情、项目卡及旧来源请求同步失效');
    await page.evaluate(async () => {
      const { Repository: r } = await import('/src/persistence/repository.ts');
      const before = await r.get('work', 'engagement', 'continuation-p');
      const result = await r.transaction('work', [{ kind: 'engagement', id: before.id, before, after: { ...before, clientName: '合成新客户', updatedAt: Date.now() } }]);
      if (!result.ok) throw new Error('rename failed');
    });
    const renamed = page.getByRole('region', { name: '合成新客户 · 商城改版项目接续', exact: true });
    await renamed.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.project-continuation .task-row-body p')].some(el => el.textContent.includes('合成新客户')));
    await renamed.getByRole('button', { name: '继续记录此项目', exact: true }).click();
    const binding = page.locator('.capture-binding');
    if (!(await binding.evaluate(el => el.open))) await binding.locator('summary').click();
    assert.match(await page.getByLabel('目标项目', { exact: true }).locator('option:checked').innerText(), /合成新客户/);
    pass('项目改名后详情、任务归属与录入选择器使用同一份新资料，项目级下一步不遗漏');
    assert.deepEqual(errors, []); assert.deepEqual(external, []); pass('无模型配置仍可完整接续，无外部请求及未捕获异常');
    await fs.writeFile(path.join(output, 'project-continuation-verification.json'), JSON.stringify({ passed, errors, externalRequests: external }, null, 2));
  } catch (error) { console.error((await page.locator('body').innerText()).slice(-4500)); await page.screenshot({ path: path.join(output, 'project-continuation-failure.png'), fullPage: true }); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
