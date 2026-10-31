// Run explicitly with LOOMA_PLAYWRIGHT_MODULE pointing at the existing workspace runtime.
// This uses an isolated browser context and a dedicated database, never the user's profile.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.LOOMA_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(process.env.LOOMA_VITE_URL || 'http://127.0.0.1:5173/');
    const result = await page.evaluate(async () => {
      const { createIndexedDbBackend } = await import('/src/persistence/indexedDb.ts');
      const { DEFAULT_PUBLIC_SETTINGS } = await import('/shared/persistence-core.mjs');
      const name = `looma-v5-index-check-${Date.now()}`;
      const items = [
        { id: 'expectation-only', kind: 'waiting', title: '客户补素材', status: 'open', sourceMessageId: 'source', createdAt: 1, updatedAt: 1, expectedDate: '2020-01-01' },
        { id: 'c', kind: 'question', title: '未定费用', status: 'open', sourceMessageId: 'source', createdAt: 1, updatedAt: 1, reviewAt: '2020-01-02T01:00:00Z' },
        { id: 'b', kind: 'waiting', title: '再问一次', status: 'open', sourceMessageId: 'source', createdAt: 1, updatedAt: 3, reviewAt: '2020-01-01T01:00:00Z' },
        { id: 'a', kind: 'waiting', title: '先问客户', status: 'open', sourceMessageId: 'source', createdAt: 1, updatedAt: 2, reviewAt: '2020-01-01T01:00:00Z' },
        { id: 'resolved', kind: 'waiting', title: '已处理', status: 'resolved', sourceMessageId: 'source', createdAt: 1, updatedAt: 1, reviewAt: '2020-01-01T01:00:00Z' },
      ];
      // Construct the real v4 object stores, before v5's two work indexes exist.
      const old = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          const db = request.result;
          const rows = db.createObjectStore('records', { keyPath: ['space', 'kind', 'id'] });
          rows.createIndex('byTime', ['space', 'kind', 'at', 'id'], { unique: true });
          rows.createIndex('byRelated', 'relatedKeys', { multiEntry: true }); rows.createIndex('byName', 'nameKeys', { multiEntry: true }); rows.createIndex('byKind', ['space', 'kind']);
          const terms = db.createObjectStore('terms', { keyPath: ['space', 'kind', 'id', 'term'] });
          terms.createIndex('byTermTime', ['space', 'kind', 'term', 'at', 'id'], { unique: true }); terms.createIndex('byRecord', ['space', 'kind', 'id']);
          db.createObjectStore('meta'); db.createObjectStore('processed', { keyPath: ['space', 'id'] });
        };
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve, reject) => {
        const tx = old.transaction(['records', 'meta'], 'readwrite');
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
        for (const data of items) tx.objectStore('records').put({ space: 'work', kind: 'followup', id: data.id, at: data.updatedAt, data, relatedKeys: [], nameKeys: [] });
        const stats = () => ({ counts: { followup: items.length }, openTasks: 0, dueTasks: 0, storageBytes: 1 });
        tx.objectStore('meta').put({ ready: true, settings: { ...DEFAULT_PUBLIC_SETTINGS }, mode: 'work', revisions: { life: 0, work: 3 }, snapshotRevision: 8, stats: { life: stats(), work: stats() } }, 'state');
      });
      old.close();
      const backend = createIndexedDbBackend(name), ids = [];
      let cursor;
      do {
        const page = await backend.request({ op: 'list', space: 'work', kind: 'followup', dueOnly: true, limit: 1, ...(cursor ? { cursor } : {}) });
        ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
      } while (cursor);
      const stats = await backend.request({ op: 'stats', space: 'work' });
      const home = await backend.request({ op: 'workHome', space: 'work', now: Date.parse('2026-10-27T04:00:00Z') });
      const before = await backend.request({ op: 'exportSnapshot' });
      const bad = structuredClone(before.records); bad[0].data.apiKey = 'forbidden-test-value';
      const rejected = await backend.request({ op: 'restore', records: bad, settings: before.settings, mode: before.mode, applied: before.applied });
      const after = await backend.request({ op: 'exportSnapshot' });
      const restored = await backend.request({ op: 'restore', records: before.records, settings: before.settings, mode: before.mode, revisions: before.revisions, snapshotRevision: before.snapshotRevision, applied: before.applied });
      return { ids, dueFollowUps: stats.dueFollowUps, waitingCount: home.counts.waiting, questionCount: home.counts.questions, homeBound: home.waiting.length,
        unchangedAfterBadRestore: JSON.stringify(before) === JSON.stringify(after), rejected: rejected.ok, restored: restored.ok,
        revision: (await backend.request({ op: 'bootstrap', space: 'work' })).snapshot.partitions.work.revision };
    });
    assert.deepEqual(result.ids, ['a', 'b', 'c']); assert.equal(result.dueFollowUps, 3);
    assert.equal(result.waitingCount, 3); assert.equal(result.questionCount, 1); assert.equal(result.homeBound, 3);
    assert.equal(result.rejected, false); assert.equal(result.unchangedAfterBadRestore, true); assert.equal(result.restored, true); assert.equal(result.revision, 3);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
