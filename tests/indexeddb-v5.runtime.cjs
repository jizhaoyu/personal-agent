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
      const restoredRevision = (await backend.request({ op: 'bootstrap', space: 'work' })).snapshot.partitions.work.revision;
      // IndexedDB artifact relation indexing & foreign key parity check
      const proj = { id: 'p-art', clientName: '王总', title: '系统交付', stage: '方案报价', internalContext: '', shareableSummary: '', nextAction: '', updatedAt: 10 };
      const cond = { id: 'c-art', space: 'work', conditionText: '确认报价', actionTitle: '整理报价简报', conditionKind: 'manual_confirm', status: 'ready', engagementId: 'p-art', sourceMessageId: 'source', revision: 1, createdAt: 10, updatedAt: 10 };
      const art = { id: 'art-1', space: 'work', projectId: 'p-art', conditionId: 'c-art', type: 'proposal_brief', title: '王总方案简报', content: '待核对草稿', sourceSnapshot: { projectUpdatedAt: 10, tasksCount: 0, followUpsCount: 0, conditionsCount: 1 }, version: 1, status: 'draft', createdAt: 10, updatedAt: 10 };
      await backend.request({ op: 'transaction', space: 'work', id: 'seed-art', mutations: [
        { kind: 'engagement', id: 'p-art', before: null, after: proj },
        { kind: 'condition', id: 'c-art', before: null, after: cond },
        { kind: 'artifact', id: 'art-1', before: null, after: art },
      ] });
      const byProj = await backend.request({ op: 'list', space: 'work', kind: 'artifact', relatedId: 'p-art' });
      const byCond = await backend.request({ op: 'list', space: 'work', kind: 'artifact', relatedId: 'c-art' });
      const deleteProjBlocked = await backend.request({ op: 'transaction', space: 'work', id: 'del-proj-with-art', mutations: [
        { kind: 'condition', id: 'c-art', before: cond, after: null },
        { kind: 'engagement', id: 'p-art', before: proj, after: null },
      ] });
      const snapWithArt = await backend.request({ op: 'exportSnapshot' });
      const orphanArtRestore = await backend.request({
        op: 'restore',
        records: snapWithArt.records.filter(r => !(r.kind === 'engagement' && r.id === 'p-art')),
        settings: snapWithArt.settings, mode: snapWithArt.mode, applied: snapWithArt.applied,
      });
      const artReady = { ...art, status: 'ready', content: 'IDB精修正文', updatedAt: 11 };
      await backend.request({ op: 'transaction', space: 'work', id: 'art-ready-1', mutations: [{ kind: 'artifact', id: 'art-1', before: art, after: artReady }] });
      await backend.request({ op: 'transaction', space: 'work', id: 'art-task-1', event: true, sourceText: '新增任务', mutations: [{ kind: 'task', id: 't-art', before: null, after: { id: 't-art', engagementId: 'p-art', title: '确认终版', assignee: '我', deadline: '周五', priority: 'high', done: false } }] });
      const artAfterTask = await backend.request({ op: 'get', space: 'work', kind: 'artifact', id: 'art-1' });
      const artReady2 = { ...artAfterTask, status: 'ready', updatedAt: artAfterTask.updatedAt + 1 };
      delete artReady2.reviewReason;
      await backend.request({ op: 'transaction', space: 'work', id: 'art-ready-2', mutations: [{ kind: 'artifact', id: 'art-1', before: artAfterTask, after: artReady2 }] });
      await backend.request({ op: 'undo', space: 'work' });
      const artAfterUndo = await backend.request({ op: 'get', space: 'work', kind: 'artifact', id: 'art-1' });
      return { ids, dueFollowUps: stats.dueFollowUps, waitingCount: home.counts.waiting, questionCount: home.counts.questions, homeBound: home.waiting.length,
        unchangedAfterBadRestore: JSON.stringify(before) === JSON.stringify(after), rejected: rejected.ok, restored: restored.ok,
        revision: restoredRevision,
        byProjIds: byProj.items.map(i => i.id), byCondIds: byCond.items.map(i => i.id),
        deleteProjBlockedOk: deleteProjBlocked.ok, orphanArtRestoreOk: orphanArtRestore.ok,
        idbAfterTaskStatus: artAfterTask.status, idbAfterTaskContent: artAfterTask.content,
        idbAfterUndoStatus: artAfterUndo.status, idbAfterUndoContent: artAfterUndo.content };
    });
    assert.deepEqual(result.ids, ['a', 'b', 'c']); assert.equal(result.dueFollowUps, 3);
    assert.equal(result.waitingCount, 3); assert.equal(result.questionCount, 1); assert.equal(result.homeBound, 3);
    assert.equal(result.rejected, false); assert.equal(result.unchangedAfterBadRestore, true); assert.equal(result.restored, true); assert.equal(result.revision, 3);
    assert.deepEqual(result.byProjIds, ['art-1']);
    assert.deepEqual(result.byCondIds, ['art-1']);
    assert.equal(result.deleteProjBlockedOk, false);
    assert.equal(result.orphanArtRestoreOk, false);
    assert.equal(result.idbAfterTaskStatus, 'needs_review');
    assert.equal(result.idbAfterTaskContent, 'IDB精修正文');
    assert.equal(result.idbAfterUndoStatus, 'needs_review');
    assert.equal(result.idbAfterUndoContent, 'IDB精修正文');
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
