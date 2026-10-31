const assert = require('node:assert/strict');
const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');
async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    await page.goto(process.env.LOOMA_TEST_URL || 'http://127.0.0.1:5173');
    await page.getByRole('button', { name: '打开记忆中心', exact: true }).waitFor();
    await page.evaluate(async () => {
      const { Repository } = await import('/src/persistence/repository.ts');
      const source = { id: 'shared-source', role: 'user', content: '海盐原文，甲乙两条确认资料', timestamp: 1 };
      const fact = id => ({ id, mode: 'work', fact: `海盐资料${id}`, category: 'business', importance: 3, createdAt: 2, sourceIds: [source.id], status: 'active' });
      const project = { id: 'current-project', clientName: '张三', title: '网站设计', budgetAmount: 120000, stage: '需求确认', internalContext: '不得进入模型的独立备注', shareableSummary: '', nextAction: '', updatedAt: 3 };
      // Project is independent of the source event, so undo tests redaction rather than orphan-project rejection.
      await Repository.upsert('work', 'engagement', [project]);
      const result = await Repository.transaction('work', [
        { kind: 'message', id: source.id, before: null, after: source },
        ...['fact-a', 'fact-b'].map(id => ({ kind: 'memory', id, before: null, after: fact(id) })),
        { kind: 'message', id: 'old-budget', before: null, after: { id: 'old-budget', role: 'user', content: '张三的预算8万', timestamp: 1 } },
      ], { event: true, sourceMessageId: source.id, sourceText: source.content });
      if (!result.ok) throw new Error(result.error);
      const tasks = Array.from({ length: 76 }, (_, i) => ({ id: `task-${i}`, title: `待办${i}`, assignee: '我', priority: 'medium', done: false, deadline: '', engagementId: project.id,
        dueAt: i === 0 ? '2020-01-01T01:00:00Z' : '2099-01-01T01:00:00Z' }));
      await Repository.upsert('work', 'task', tasks);
    });
    await page.getByRole('button', { name: '打开记忆中心', exact: true }).click();
    const region = page.getByRole('region', { name: '工作记忆与档案', exact: true });
    await region.getByRole('button', { name: '只读回忆', exact: true }).click();
    await region.getByLabel('想回忆什么', { exact: true }).fill('张三的预算现在是多少');
    await region.getByRole('button', { name: '查找依据', exact: true }).click();
    const current = region.locator('.memory-item').filter({ hasText: '当前结构化记录' });
    await current.waitFor(); assert.match(await current.innerText(), /120000/); assert.doesNotMatch(await current.innerText(), /不得进入模型/);
    console.log('PASS natural-language-current-budget-with-real-IDB-index');
    await region.getByRole('button', { name: '长期事实', exact: true }).click();
    const target = region.locator('.memory-item').filter({ hasText: '海盐资料fact-a' }); await target.getByRole('button', { name: '忘记', exact: true }).click();
    await page.getByLabel('同时删除这条事实引用的原始沟通', { exact: true }).check();
    await page.getByLabel('已了解范围，确认执行', { exact: true }).check();
    await page.getByRole('button', { name: '确认忘记', exact: true }).click();
    await page.waitForFunction(async () => { const { Repository } = await import('/src/persistence/repository.ts'); return !(await Repository.get('work', 'message', 'shared-source')); });
    const result = await page.evaluate(async () => {
      const { Repository } = await import('/src/persistence/repository.ts');
      return { facts: (await Repository.query('work', 'memory')).items, copies: (await Repository.query('work', 'event', { query: '原文' })).items,
        due: (await Repository.query('work', 'task', { dueOnly: true })).items,
        undo: await Repository.undo('work'), source: await Repository.get('work', 'message', 'shared-source') };
    });
    assert.equal(result.facts.filter(item => item.status === 'retracted').length, 2);
    assert.equal(result.copies.some(item => item.sourceText.includes('海盐原文')), false);
    assert.equal(result.due.length, 1); assert.equal(result.due[0].id, 'task-0');
    assert.equal(result.undo.ok, true, result.undo.error); assert.equal(result.source, null);
    console.log('PASS source-delete-retracts-shared-facts-redacts-event-and-undo-cannot-resurrect');
    console.log('PASS due-filter-finds-old-task-outside-bootstrap-window');
    const rebuilt = await page.evaluate(async () => {
      const { Repository } = await import('/src/persistence/repository.ts');
      await new Promise((resolve, reject) => { const request = indexedDB.open('looma-local-v4'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, tx = db.transaction('terms', 'readwrite'); tx.objectStore('terms').clear(); tx.oncomplete = () => { db.close(); resolve(true); }; }; });
      const before = (await Repository.query('work', 'memory', { query: '海盐' })).items.length;
      const result = await Repository.request({ op: 'rebuildIndexes', space: 'work' });
      const after = (await Repository.query('work', 'memory', { query: '海盐' })).items.length;
      return { before, after, ok: result.ok };
    });
    assert.equal(rebuilt.ok, true); assert.equal(rebuilt.before, 0); assert.equal(rebuilt.after, 2);
    console.log('PASS IDB-derived-index-rebuild-maintenance');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
