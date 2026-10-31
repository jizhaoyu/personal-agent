import {
  DEFAULT_PUBLIC_SETTINGS, RECORD_KINDS, validateRecord, validateTransaction, flattenV3, searchTerms,
  makeBootstrap, recordAt, recordText, sameValue, eventMutations, validateSettings, stableJson, redactEvent,
  isBusinessKind, validateCaptureCommand, captureRows, workIndex, workDay, normalizeApplied,
} from '../../shared/persistence-core.mjs';
import type { WorkspaceMode } from '../types';

export type RecordKind = 'message' | 'event' | 'engagement' | 'task' | 'memory' | 'summary' | 'expense' | 'person' | 'journal' | 'custom' | 'wallet' | 'rpg' | 'capture_draft' | 'followup' | 'closure';
export interface PersistedRow { space: WorkspaceMode; kind: RecordKind; id: string; data: any; at: number }
export interface PersistenceBackend { request(command: any): Promise<any> }
type Meta = { ready: boolean; settings: any; mode: WorkspaceMode; revisions: { life: number; work: number }; snapshotRevision: number; stats: any; fingerprint?: string };
const DB_NAME = 'looma-local-v4';
const MIN = -Number.MAX_VALUE, MAX = Number.MAX_VALUE;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const key = (space: string, kind: string, id: string) => [space, kind, id];
const encoded = (value: unknown) => JSON.stringify(value);
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().trim();
const freshStats = () => ({ counts: Object.fromEntries(RECORD_KINDS.map(kind => [kind, 0])), openTasks: 0, dueTasks: 0, storageBytes: 0 });
const freshMeta = (): Meta => ({ ready: false, settings: { ...DEFAULT_PUBLIC_SETTINGS }, mode: 'work', revisions: { life: 0, work: 0 }, snapshotRevision: 0,
  stats: { life: freshStats(), work: freshStats() } });
const wrap = <T,>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error || new Error('浏览器存储事务未完成，原数据保留。')); tx.onerror = () => { /* onabort is authoritative. */ };
});
const allStores = ['records', 'terms', 'meta', 'processed'];
const rangeFor = (space: string, kind: string, cursor?: string) => {
  const value = cursor ? JSON.parse(cursor) : undefined;
  if (value && (!Number.isFinite(value.at) || typeof value.id !== 'string')) throw new Error('分页游标无效。');
  return IDBKeyRange.bound([space, kind, MIN, ''], [space, kind, value?.at ?? MAX, value?.id ?? '\uffff'], false, !!value);
};
function relations(data: any): string[] { return [...new Set([...(data.sourceIds || []), ...(data.engagementIds || []), ...(data.taskIds || []), ...(data.followUpIds || []), data.sourceMessageId, data.engagementId, data.supersedesId, data.eventId].filter(Boolean))] as string[]; }
function indexed(row: PersistedRow) {
  const agenda = row.space === 'work' ? workIndex(row.kind, row.data) : null;
  return { ...clone(row), relatedKeys: relations(row.data).map(id => encoded([row.space, row.kind, id])),
    workBucket: agenda?.bucket, workTime: agenda?.time, workSort: agenda?.sort,
    nameKeys: [...new Set([row.data.clientName, row.data.name, row.data.title, row.data.subject].filter(value => typeof value === 'string' && value.trim()))]
      .map(value => encoded([row.space, row.kind, normalized(value)])) };
}
function updateStats(meta: Meta, row: PersistedRow, before: any | null) {
  const stats = meta.stats[row.space];
  stats.counts[row.kind] += Number(row.data !== null) - Number(before !== null);
  stats.storageBytes += (row.data === null ? 0 : JSON.stringify(row.data).length * 2) - (before === null ? 0 : JSON.stringify(before).length * 2);
  if (row.kind === 'task') stats.openTasks += Number(!!row.data && !row.data.done) - Number(!!before && !before.done);
}
async function removeTerms(tx: IDBTransaction, space: string, kind: string, id: string) {
  const index = tx.objectStore('terms').index('byRecord');
  await new Promise<void>((resolve, reject) => {
    const request = index.openKeyCursor(IDBKeyRange.only([space, kind, id]));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const cursor = request.result; if (!cursor) { resolve(); return; } tx.objectStore('terms').delete(cursor.primaryKey); cursor.continue(); };
  });
}
async function writeRow(tx: IDBTransaction, row: PersistedRow, before: any, meta: Meta) {
  await removeTerms(tx, row.space, row.kind, row.id);
  if (row.data === null) tx.objectStore('records').delete(key(row.space, row.kind, row.id));
  else {
    tx.objectStore('records').put(indexed(row));
    const terms = [...searchTerms(recordText(row.kind, row.data)), ...relations(row.data).map(id => `@related:${id}`),
      ...[row.data.clientName, row.data.name, row.data.title, row.data.subject].filter(value => typeof value === 'string' && value.trim()).map(value => `@name:${normalized(value)}`)];
    for (const term of new Set(terms)) tx.objectStore('terms').put({ space: row.space, kind: row.kind, id: row.id, term, at: row.at });
  }
  updateStats(meta, row, before);
}
async function checkRemovedProjectLinks(tx: IDBTransaction, space: WorkspaceMode, mutations: any[]) {
  for (const id of new Set(mutations.filter(m => m.kind === 'engagement' && m.after === null).map(m => m.id))) {
    for (const kind of ['task', 'followup']) {
      const children = await collect(tx.objectStore('records').index('byRelated'), IDBKeyRange.only(encoded([space, kind, id])), 1);
      if (children.length) throw new Error('项目仍有关联事项，未保存任何更改。');
    }
  }
}
function collect(index: IDBIndex | IDBObjectStore, range: IDBKeyRange | undefined, limit: number, direction: IDBCursorDirection = 'prev',
  accept: (row: any) => boolean = () => true): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const output: any[] = []; const request = index.openCursor(range, direction);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const cursor = request.result; if (!cursor || output.length >= limit) { resolve(output); return; }
      if (accept(cursor.value)) output.push(cursor.value); cursor.continue(); };
  });
}
function assertSpace(space: string) { if (space !== 'life' && space !== 'work') throw new Error('必须明确指定当前空间。'); }
function ensureKind(kind: string) { if (!RECORD_KINDS.includes(kind)) throw new Error('记录类型无效。'); }

export function createIndexedDbBackend(name = DB_NAME): PersistenceBackend {
  let opening: Promise<IDBDatabase>;
  const database = () => opening ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    request.onerror = () => { opening = undefined; reject(request.error || new Error('无法打开浏览器本地存储。')); };
    request.onblocked = () => reject(new Error('本地数据库正由旧页面占用，请关闭旧页面再重试。'));
    request.onupgradeneeded = event => {
      const db = request.result;
      let rows: IDBObjectStore;
      if (event.oldVersion === 0) {
        rows = db.createObjectStore('records', { keyPath: ['space', 'kind', 'id'] });
        rows.createIndex('byTime', ['space', 'kind', 'at', 'id'], { unique: true });
        rows.createIndex('byRelated', 'relatedKeys', { multiEntry: true }); rows.createIndex('byName', 'nameKeys', { multiEntry: true });
        rows.createIndex('byKind', ['space', 'kind']);
        const terms = db.createObjectStore('terms', { keyPath: ['space', 'kind', 'id', 'term'] });
        terms.createIndex('byTermTime', ['space', 'kind', 'term', 'at', 'id'], { unique: true }); terms.createIndex('byRecord', ['space', 'kind', 'id']);
        db.createObjectStore('meta'); db.createObjectStore('processed', { keyPath: ['space', 'id'] });
      } else rows = request.transaction!.objectStore('records');
      rows.createIndex('byWorkTime', ['space', 'workBucket', 'workTime', 'id'], { unique: true });
      rows.createIndex('byWorkSort', ['space', 'workBucket', 'workSort', 'id'], { unique: true });
      // IndexedDB's versionchange transaction rolls the index and wrapper upgrade back together.
      if (event.oldVersion > 0) {
        const cursor = rows.openCursor(); cursor.onsuccess = () => { const row = cursor.result; if (!row) return; row.update(indexed(row.value)); row.continue(); };
      }
    };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
  });
  async function readMeta(tx: IDBTransaction): Promise<Meta> {
    const meta: Meta = await wrap(tx.objectStore('meta').get('state')) || freshMeta();
    for (const space of ['life', 'work']) meta.stats[space] = { ...freshStats(), ...meta.stats[space], counts: { ...freshStats().counts, ...meta.stats[space]?.counts } };
    return meta;
  }
  async function list(tx: IDBTransaction, command: any) {
    const { space, kind } = command; assertSpace(space); ensureKind(kind);
    const limit = Math.min(200, Math.max(1, Math.floor(command.limit || 50)));
    const store = tx.objectStore('records');
    for (const field of ['ids', 'names']) if (command[field] !== undefined && (!Array.isArray(command[field]) || command[field].length > 200 || !command[field].every(value => typeof value === 'string'))) throw new Error('精确查询最多200个ID或名称。');
    if (command.query !== undefined && (typeof command.query !== 'string' || command.query.length > 1000)) throw new Error('搜索文本无效。');
    const terms: string[] = searchTerms(command.query || '');
    if (terms.some(term => [...term].length === 1) && !command.ids?.length && !command.names?.length && !command.relatedId) throw new Error('单字搜索请先限定人物、项目或来源。');
    if (command.dueOnly !== undefined && (typeof command.dueOnly !== 'boolean' || !['task', 'followup'].includes(kind))) throw new Error('到期筛选仅支持待办和自设回访。');
    const followupDue = command.dueOnly && kind === 'followup';
    const page = rangeFor(space, kind, followupDue ? undefined : command.cursor);
    const matches = (row: any) => {
      if (!row || !page.includes([space, kind, row.at, row.id])) return false;
      if (followupDue && (row.data.status !== 'open' || !row.data.reviewAt || Date.parse(row.data.reviewAt) > Date.now())) return false;
      if (command.dueOnly && !followupDue && (row.data.done || !row.data.dueAt || Date.parse(row.data.dueAt) > Date.now())) return false;
      if (command.ids && !command.ids.includes(row.id)) return false;
      if (command.relatedId && !relations(row.data).includes(command.relatedId)) return false;
      if (command.names && !command.names.some(value => row.nameKeys.includes(encoded([space, kind, normalized(value)])))) return false;
      const text = recordText(kind, row.data), indexedTerms = searchTerms(text);
      return terms.every(term => [...term].length === 1 ? normalized(text).includes(term) : indexedTerms.includes(term));
    };
    let rows: any[];
    if (followupDue) {
      const position = command.cursor ? JSON.parse(command.cursor) : null;
      if (position && (!Number.isFinite(position.reviewAt) || !Number.isFinite(position.at) || typeof position.id !== 'string')) throw new Error('回访分页游标无效。');
      const outputs = await Promise.all(['waiting', 'question'].map(bucket => {
        const range = IDBKeyRange.bound([space, bucket, position?.reviewAt ?? MIN, position?.id ?? ''], [space, bucket, Date.now(), '\uffff'], !!position, false);
        return collect(store.index('byWorkSort'), range, limit + 1, 'next', matches);
      }));
      rows = outputs.flat().sort((a, b) => a.workSort - b.workSort || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
    } else if (command.ids) {
      rows = (await Promise.all(command.ids.map(id => wrap<any>(store.get(key(space, kind, id)))))).filter(matches);
      rows.sort((a, b) => b.at - a.at || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
    } else if (command.query || command.relatedId || command.names) {
      if (command.query && !terms.length) return { items: [], nextCursor: null };
      const position = command.cursor ? JSON.parse(command.cursor) : null;
      const channels = command.names ? command.names.map(value => `@name:${normalized(value)}`) : command.relatedId ? [`@related:${command.relatedId}`] : [terms.find(term => [...term].length >= 2)];
      const outputs = await Promise.all(channels.map(channel => new Promise<any[]>((resolve, reject) => {
        const output: any[] = [];
        const range = IDBKeyRange.bound([space, kind, channel, MIN, ''], [space, kind, channel, position?.at ?? MAX, position?.id ?? '\uffff'], false, !!position);
        const request = tx.objectStore('terms').index('byTermTime').openCursor(range, 'prev');
        request.onerror = () => reject(request.error);
        request.onsuccess = async () => {
          const cursor = request.result; if (!cursor || output.length > limit) { resolve(output); return; }
          try { const row = await wrap<any>(store.get(key(space, kind, cursor.value.id)));
            if (matches(row)) output.push(row);
            cursor.continue();
          } catch (error) { reject(error); }
        };
      })));
      rows = [...new Map(outputs.flat().map(row => [row.id, row])).values()].sort((a, b) => b.at - a.at || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
    } else rows = await collect(store.index('byTime'), page, limit + 1, 'prev', matches);
    const hasMore = rows.length > limit;
    rows = rows.slice(0, limit);
    return { items: rows.map(row => row.data), nextCursor: hasMore ? encoded({ at: rows.at(-1).at, id: rows.at(-1).id, ...(followupDue ? { reviewAt: rows.at(-1).workSort } : {}) }) : null };
  }
  async function statistics(tx: IDBTransaction, meta: Meta, space: WorkspaceMode) {
    // Due status changes as the clock advances, so derive it from the indexed task collection only.
    let dueTasks = 0;
    if (space === 'work') await new Promise<void>((resolve, reject) => {
      const request = tx.objectStore('records').index('byKind').openCursor(IDBKeyRange.only([space, 'task']));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const cursor = request.result; if (!cursor) { resolve(); return; } const task = cursor.value.data;
        if (!task.done && task.dueAt && Date.parse(task.dueAt) <= Date.now()) dueTasks++; cursor.continue(); };
    });
    const dueFollowUps = space === 'work' ? (await Promise.all(['waiting', 'question'].map(bucket => wrap<number>(tx.objectStore('records').index('byWorkSort')
      .count(IDBKeyRange.bound([space, bucket, MIN, ''], [space, bucket, Date.now(), '\uffff'])))))).reduce((sum, count) => sum + count, 0) : 0;
    return { space, ...clone(meta.stats[space]), dueTasks, dueFollowUps, storageBytesEstimated: true, backend: 'indexeddb' };
  }
  async function workHome(tx: IDBTransaction, command: any) {
    const { start, end } = workDay(command.now ?? Date.now()), limit = Math.min(3, Math.max(1, command.limit || 3));
    const store = tx.objectStore('records');
    const range = (bucket: string, low = MIN, high = MAX, open = false) => IDBKeyRange.bound(['work', bucket, low, ''], ['work', bucket, high, open ? '' : '\uffff'], false, open);
    const group = async (bucket: string, selected: IDBKeyRange, reverse = false) => ({
      items: (await collect(store.index(bucket === 'waiting' || bucket === 'question' ? 'byWorkSort' : 'byWorkTime'), selected, limit, reverse ? 'prev' : 'next')).map(row => row.data),
      count: await wrap(store.index('byWorkTime').count(selected)),
    });
    const [today, overdue, waiting, questions, recent, draft] = await Promise.all([
      group('task', range('task', start, end, true)), group('task', range('task', MIN, start, true)),
      group('waiting', range('waiting')), group('question', range('question')), group('closure', range('closure'), true),
      wrap<any>(store.get(key('work', 'capture_draft', 'active-work'))),
    ]);
    return { draft: draft?.data || null, today: today.items, overdue: overdue.items, waiting: waiting.items, questions: questions.items, recent: recent.items,
      counts: { today: today.count, overdue: overdue.count, waiting: waiting.count, questions: questions.count } };
  }
  return { async request(command: any) {
    const db = await database();
    // Hash before opening the IDB transaction: crypto awaits must not let it auto-close.
    const signature = ['transaction', 'commitCapture'].includes(command?.op) ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(command))))).map(n => n.toString(16).padStart(2, '0')).join('') : '';
    const writes = ['migrate', 'transaction', 'undo', 'restore', 'settings', 'mode', 'rebuildIndexes', 'saveDraft', 'commitCapture'].includes(command?.op);
    const tx = db.transaction(allStores, writes ? 'readwrite' : 'readonly');
    const done = completed(tx);
    try {
      let meta = await readMeta(tx); let result: any;
      if (['saveDraft', 'commitCapture', 'workHome'].includes(command?.op) && command.space !== 'work') throw new Error('收尾操作仅属于工作空间。');
      switch (command?.op) {
        case 'init': result = { ready: meta.ready, mode: meta.mode, settings: meta.settings }; break;
        case 'migrate': {
          if (meta.ready) { result = { ok: true, already: true }; break; }
          const flat = flattenV3(command.snapshot);
          meta = { ...freshMeta(), ready: true, mode: flat.mode, settings: flat.settings, revisions: flat.revisions, fingerprint: command.fingerprint, snapshotRevision: command.snapshot.snapshotRevision };
          for (const row of flat.records) await writeRow(tx, row, null, meta);
          for (const space of ['life', 'work']) for (const id of flat.processedProposalIds[space]) tx.objectStore('processed').put({ space, id });
          tx.objectStore('meta').put(meta, 'state'); result = { ok: true }; break;
        }
        case 'bootstrap': {
          assertSpace(command.space);
          const output = await Promise.all(RECORD_KINDS.map(async kind => {
            const rows = await collect(tx.objectStore('records').index('byTime'), rangeFor(command.space, kind), 50); return rows;
          }));
          result = makeBootstrap(meta, output.flat(), await statistics(tx, meta, command.space)); break;
        }
        case 'list': result = await list(tx, command); break;
        case 'get': assertSpace(command.space); ensureKind(command.kind); result = (await wrap<any>(tx.objectStore('records').get(key(command.space, command.kind, command.id))))?.data || null; break;
        case 'saveDraft': {
          if (Object.keys(command).some(k => !['op', 'space', 'draft'].includes(k)) || !validateRecord('work', 'capture_draft', command.draft)) throw new Error('工作草稿格式无效。');
          const draft = command.draft;
          if (await wrap(tx.objectStore('processed').get(['work', `capture-session:${draft.sessionId}`]))) throw new Error('这次整理已结束，旧草稿未重新打开。');
          const row: any = await wrap(tx.objectStore('records').get(key('work', 'capture_draft', 'active-work'))), previous = row?.data || null;
          if (previous && previous.sessionId !== draft.sessionId) throw new Error('已有另一段未完成整理，请先处理。');
          if (previous && (previous.draftVersion > draft.draftVersion || (previous.draftVersion === draft.draftVersion && !sameValue(previous, draft)))) throw new Error('草稿已更新，拒绝较旧的保存。');
          await writeRow(tx, { space: 'work', kind: 'capture_draft', id: draft.id, data: draft, at: draft.updatedAt }, previous, meta);
          meta.ready = true; meta.snapshotRevision++; tx.objectStore('meta').put(meta, 'state'); result = { ok: true }; break;
        }
        case 'commitCapture': {
          if (!validateCaptureCommand(command)) throw new Error('沟通收尾格式无效，请重新核对。');
          const p = command.proposal; const processed: any = await wrap(tx.objectStore('processed').get(['work', p.id]));
          if (processed) {
            if (processed.signature !== signature) throw new Error('同一批次标识被用于不同内容。');
            result = { ...processed.result, already: true }; break;
          }
          const stored: any = await wrap(tx.objectStore('records').get(key('work', 'capture_draft', 'active-work'))), draft = stored?.data;
          if (!draft || draft.sessionId !== command.draftSessionId || draft.sourceMessageId !== p.sourceMessageId || draft.text !== p.sourceText ||
              (!command.originalOnly && (!sameValue(draft.proposal, p) || draft.conflicts?.length))) throw new Error('草稿已改变或仍有冲突，请重新核对。');
          const { mutations, source, closure } = captureRows(command);
          const existing = new Map<string, any>();
          const targets = mutations.flatMap(m => [[m.kind, m.id], ...(m.after?.engagementId ? [['engagement', m.after.engagementId]] : [])]);
          await Promise.all(targets.map(async ([kind, id]) => { const row: any = await wrap(tx.objectStore('records').get(key('work', kind, id))); existing.set(`${kind}:${id}`, row?.data || null); }));
          if (mutations.length) {
            const errors = validateTransaction({ op: 'transaction', space: 'work', id: p.id, baseRevision: p.baseRevision, mutations }, meta.revisions.work, (kind, id) => existing.get(`${kind}:${id}`) || null);
            if (errors.length) throw new Error(errors.join(' '));
          }
          const previousSource: any = await wrap(tx.objectStore('records').get(key('work', 'message', source.id)));
          if (previousSource && (previousSource.data.content !== source.content || previousSource.data.role !== 'user')) throw new Error('来源原文与本次整理不一致。');
          if (!previousSource) await writeRow(tx, { space: 'work', kind: 'message', id: source.id, data: source, at: source.timestamp }, null, meta);
          for (const m of mutations) await writeRow(tx, { space: 'work', kind: m.kind, id: m.id, data: m.after, at: m.after ? recordAt(m.after) : 0 }, m.before, meta);
          await checkRemovedProjectLinks(tx, 'work', mutations);
          const latest = await collect(tx.objectStore('records').index('byTime'), rangeFor('work', 'event'), 1);
          const event = { id: closure.eventId, proposalId: p.id, mode: 'work', sourceMessageId: p.sourceMessageId, sourceText: p.sourceText,
            mutations, createdAt: Math.max(command.confirmedAt, (latest[0]?.at || 0) + 1) };
          await writeRow(tx, { space: 'work', kind: 'event', id: event.id, data: event, at: event.createdAt }, null, meta);
          await writeRow(tx, { space: 'work', kind: 'closure', id: closure.id, data: closure, at: closure.confirmedAt }, null, meta);
          await writeRow(tx, { space: 'work', kind: 'capture_draft', id: 'active-work', data: null, at: 0 }, draft, meta);
          if (mutations.some(m => isBusinessKind(m.kind))) meta.revisions.work++;
          meta.ready = true; meta.snapshotRevision++; tx.objectStore('meta').put(meta, 'state');
          result = { ok: true, closureId: closure.id, eventId: event.id, receipts: [] };
          tx.objectStore('processed').put({ space: 'work', id: p.id, signature, result, at: command.confirmedAt });
          tx.objectStore('processed').put({ space: 'work', id: `capture-session:${command.draftSessionId}`, signature: '', result: { ok: true, receipts: [] }, at: command.confirmedAt });
          break;
        }
        case 'workHome': result = await workHome(tx, command); break;
        case 'transaction': {
          assertSpace(command.space);
          const previous: any = await wrap(tx.objectStore('processed').get([command.space, command.id]));
          if (previous) {
            if (previous.signature && previous.signature !== signature) throw new Error('同一批次标识被用于不同内容。');
            result = { ok: true, already: true, receipts: [] }; break;
          }
          const existing = new Map<string, any>();
          if (!Array.isArray(command.mutations)) throw new Error('变更批次格式无效。');
          const targets = command.mutations.flatMap(mutation => [[mutation.kind, mutation.id], ...(mutation.after?.engagementId ? [['engagement', mutation.after.engagementId]] : [])]);
          await Promise.all(targets.map(async ([kind, id]) => { const row: any = await wrap(tx.objectStore('records').get(key(command.space, kind, id))); existing.set(`${kind}:${id}`, row?.data || null); }));
          const errors = validateTransaction(command, meta.revisions[command.space], (kind, id) => existing.get(`${kind}:${id}`) || null);
          if (errors.length) { result = { ok: false, error: errors.join(' ') }; break; }
          for (const mutation of command.mutations) await writeRow(tx, { space: command.space, kind: mutation.kind, id: mutation.id, data: mutation.after, at: mutation.after ? recordAt(mutation.after) : 0 }, mutation.before, meta);
          await checkRemovedProjectLinks(tx, command.space, command.mutations);
          const retired = command.mutations.filter(m => m.kind === 'memory' && m.after?.status === 'retracted').map(m => m.id);
          if (command.redactSourceIds?.length || retired.length) {
            const row: any = await wrap(tx.objectStore('records').get(key(command.space, 'capture_draft', 'active-work')));
            if (row && command.redactSourceIds?.includes(row.data.sourceMessageId)) {
              await writeRow(tx, { ...row, data: null }, row.data, meta);
              tx.objectStore('processed').put({ space: command.space, id: `capture-session:${row.data.sessionId}`, signature: '', result: { ok: true, receipts: [] }, at: Date.now() });
            }
            let cursor: string | undefined;
            do {
              const events = await collect(tx.objectStore('records').index('byTime'), rangeFor(command.space, 'event', cursor), 200);
              for (const row of events) { const data = redactEvent(row.data, command.redactSourceIds, retired); if (data) await writeRow(tx, { ...row, data }, row.data, meta); }
              cursor = events.length === 200 ? JSON.stringify({ at: events.at(-1).at, id: events.at(-1).id }) : undefined;
            } while (cursor);
          }
          const business = command.mutations.some(mutation => isBusinessKind(mutation.kind));
          if (command.event) {
            const latest = await collect(tx.objectStore('records').index('byTime'), rangeFor(command.space, 'event'), 1);
            const event = { id: `event-${command.id}`, proposalId: command.id, mode: command.space, sourceMessageId: command.sourceMessageId || command.id,
              sourceText: command.sourceText || '', mutations: command.mutations, createdAt: Math.max(Date.now(), (latest[0]?.at || 0) + 1) };
            await writeRow(tx, { space: command.space, kind: 'event', id: event.id, data: event, at: event.createdAt }, null, meta);
          }
          if (business) meta.revisions[command.space]++;
          const now = Date.now();
          const receipts = command.event ? command.mutations.map((mutation, index) => ({ id: `receipt-${command.id}-${index}`, mode: command.space,
            targetCardType: ({ engagement: 'crm', task: 'projects', memory: 'custom', wallet: 'wallet', expense: 'wallet', rpg: 'rpg_status', person: 'relationships', custom: 'custom' })[mutation.kind] || 'custom',
            targetCardTitle: mutation.after?.title || mutation.after?.clientName || mutation.after?.name || '已确认记录', summaryText: mutation.after === null ? '已删除' : mutation.before === null ? '已添加' : '已更新', deltaBadge: '已保存', timestamp: now })) : [];
          meta.snapshotRevision++; tx.objectStore('processed').put({ space: command.space, id: command.id, signature, result: { ok: true, receipts }, at: now }); tx.objectStore('meta').put(meta, 'state');
          result = { ok: true, receipts }; break;
        }
        case 'undo': {
          assertSpace(command.space);
          const events = await collect(tx.objectStore('records').index('byTime'), rangeFor(command.space, 'event'), 1, 'prev', row => !row.data.revertedAt);
          const eventRow = events[0]; if (!eventRow) { result = { ok: false, error: '没有可撤销的最近变更。' }; break; }
          if (command.eventId !== undefined && command.eventId !== eventRow.id) throw new Error('该操作之后已有新变更，请在变更记录中核对。');
          const mutations = eventMutations(eventRow.data);
          const rows = await Promise.all(mutations.map(mutation => wrap<any>(tx.objectStore('records').get(key(command.space, mutation.kind, mutation.id)))));
          if (mutations.some((mutation, index) => !sameValue(rows[index]?.data || null, mutation.after))) { result = { ok: false, error: '相关记录已被后续修改，请先处理最新变更。' }; break; }
          for (const mutation of [...mutations].reverse()) await writeRow(tx, { space: command.space, kind: mutation.kind, id: mutation.id, data: mutation.before, at: mutation.before ? recordAt(mutation.before) : 0 }, mutation.after, meta);
          await checkRemovedProjectLinks(tx, command.space, mutations.map(m => ({ ...m, after: m.before })));
          const changed = { ...eventRow.data, revertedAt: Date.now() };
          await writeRow(tx, { ...eventRow, data: changed }, eventRow.data, meta);
          const closure: any = await wrap(tx.objectStore('records').get(key(command.space, 'closure', `closure-${eventRow.data.proposalId}`)));
          if (closure) await writeRow(tx, { ...closure, data: { ...closure.data, revertedAt: changed.revertedAt } }, closure.data, meta);
          if (mutations.some(m => isBusinessKind(m.kind))) meta.revisions[command.space]++;
          meta.snapshotRevision++; tx.objectStore('meta').put(meta, 'state'); result = { ok: true }; break;
        }
        case 'settings':
          if (command.patch) { if (!validateSettings(command.patch, true)) throw new Error('设置字段无效，不能包含凭据。'); meta.settings = { ...meta.settings, ...command.patch }; tx.objectStore('meta').put(meta, 'state'); }
          result = meta.settings; break;
        case 'mode': assertSpace(command.space); meta.mode = command.space; tx.objectStore('meta').put(meta, 'state'); result = { ok: true }; break;
        case 'stats': assertSpace(command.space); result = await statistics(tx, meta, command.space); break;
        case 'rebuildIndexes': {
          assertSpace(command.space); let count = 0;
          await new Promise<void>((resolve, reject) => {
            const request = tx.objectStore('terms').openCursor(IDBKeyRange.bound([command.space], [command.space, '\uffff', '\uffff', '\uffff']));
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { const cursor = request.result; if (!cursor) { resolve(); return; } cursor.delete(); cursor.continue(); };
          });
          for (const kind of RECORD_KINDS) {
            let cursor: string | undefined;
            do {
              const rows = await collect(tx.objectStore('records').index('byTime'), rangeFor(command.space, kind, cursor), 200);
              for (const row of rows) { await writeRow(tx, row, row.data, meta); count++; }
              cursor = rows.length === 200 ? JSON.stringify({ at: rows.at(-1).at, id: rows.at(-1).id }) : undefined;
            } while (cursor);
          }
          result = { ok: true, records: count }; break;
        }
        case 'exportPage': {
          const cursor = command.cursor ? JSON.parse(command.cursor) : null, limit = Math.max(1, Math.min(command.limit || 200, 200));
          if (cursor?.phase === 'applied') {
            const rows = await collect(tx.objectStore('processed'), cursor.key ? IDBKeyRange.lowerBound(cursor.key, true) : undefined, limit + 1, 'next');
            const more = rows.length > limit; if (more) rows.pop();
            result = { records: [], applied: rows.map(normalizeApplied), nextCursor: more ? encoded({ phase: 'applied', key: [rows.at(-1).space, rows.at(-1).id] }) : null,
              settings: meta.settings, mode: meta.mode, revisions: meta.revisions, snapshotRevision: meta.snapshotRevision }; break;
          }
          const previous = Array.isArray(cursor) ? cursor : cursor?.key;
          const rows = await collect(tx.objectStore('records'), previous ? IDBKeyRange.lowerBound(previous, true) : undefined, limit + 1, 'next');
          const hasMore = rows.length > limit; const page = hasMore ? rows.slice(0, -1) : rows;
          const hasMarks = !hasMore && (await wrap(tx.objectStore('processed').count())) > 0;
          result = { records: page.map(({ space, kind, id, data, at }) => ({ space, kind, id, data, at })),
            applied: [], nextCursor: hasMore ? encoded({ key: key(page.at(-1).space, page.at(-1).kind, page.at(-1).id) }) : hasMarks ? encoded({ phase: 'applied' }) : null,
            settings: meta.settings, mode: meta.mode, revisions: meta.revisions, snapshotRevision: meta.snapshotRevision }; break;
        }
        case 'exportSnapshot': {
          const [records, applied] = await Promise.all([wrap<any[]>(tx.objectStore('records').getAll()), wrap<any[]>(tx.objectStore('processed').getAll())]);
          result = { records: records.map(({ space, kind, id, data, at }) => ({ space, kind, id, data, at })), applied: applied.map(normalizeApplied),
            settings: meta.settings, mode: meta.mode, revisions: meta.revisions, snapshotRevision: meta.snapshotRevision }; break;
        }
        case 'restore': {
          if (!Array.isArray(command.records) || !validateSettings(command.settings) || !['life', 'work'].includes(command.mode)) throw new Error('备份结构无效，当前资料未替换。');
          const ids = new Set<string>(); const engagements = new Set<string>();
          for (const row of command.records) {
            const identifier = encoded(key(row.space, row.kind, row.id));
            if (!row || typeof row !== 'object' || Object.keys(row).some(field => !['space', 'kind', 'id', 'data', 'at'].includes(field)) ||
                !validateRecord(row.space, row.kind, row.data) || !Number.isFinite(row.at) || typeof row.id !== 'string' || !row.id ||
                (['wallet', 'rpg'].includes(row.kind) && row.id !== row.kind) ||
                (!['wallet', 'rpg'].includes(row.kind) && row.id !== row.data.id) || ids.has(identifier)) throw new Error('备份记录校验失败，当前资料未替换。');
            ids.add(identifier); if (row.kind === 'engagement') engagements.add(row.id);
          }
          if (command.records.some(row => ['task', 'followup'].includes(row.kind) && row.data.engagementId && !engagements.has(row.data.engagementId))) throw new Error('备份待办关联项目缺失。');
          if (command.applied !== undefined && !Array.isArray(command.applied)) throw new Error('备份批次标记无效。');
          const applied = (command.applied || []).map(normalizeApplied), appliedKeys = new Set();
          for (const mark of applied) { const id = encoded([mark.space, mark.id]); if (appliedKeys.has(id)) throw new Error('备份含重复批次标记。'); appliedKeys.add(id); }
          if (command.revisions !== undefined && (!command.revisions || Object.keys(command.revisions).some(key => !['life', 'work'].includes(key)) || !['life', 'work'].every(space => Number.isInteger(command.revisions[space]) && command.revisions[space] >= 0))) throw new Error('备份版本信息无效。');
          if (command.snapshotRevision !== undefined && (!Number.isInteger(command.snapshotRevision) || command.snapshotRevision < 0)) throw new Error('备份版本信息无效。');
          for (const store of ['records', 'terms', 'processed']) tx.objectStore(store).clear();
          const revisions = command.revisions || { life: meta.revisions.life + 1, work: meta.revisions.work + 1 };
          meta = { ...freshMeta(), ready: true, settings: { ...DEFAULT_PUBLIC_SETTINGS, ...command.settings }, mode: command.mode, revisions, snapshotRevision: command.snapshotRevision ?? meta.snapshotRevision + 1 };
          for (const row of command.records) await writeRow(tx, row, null, meta);
          for (const mark of applied) tx.objectStore('processed').put(mark);
          tx.objectStore('meta').put(meta, 'state'); result = { ok: true }; break;
        }
        default: throw new Error('不支持的持久化请求。');
      }
      await done; return result;
    } catch (error) {
      try { tx.abort(); } catch { /* Already aborted / completed. */ }
      await done.catch(() => undefined);
      if (['transaction', 'undo', 'restore', 'saveDraft', 'commitCapture'].includes(command?.op)) return { ok: false, error: error instanceof Error ? error.message : '本地事务失败，原数据保留。' };
      throw error;
    }
  } };
}
