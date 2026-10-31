const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const Database = require('better-sqlite3');

const SPACES = ['life', 'work'];
const FORMAT = 'looma-archive';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('分页游标无效。');
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
  if (!Number.isFinite(parsed.at) || typeof parsed.id !== 'string' || (parsed.reviewAt !== undefined && !Number.isFinite(parsed.reviewAt))) throw new Error('分页游标无效。');
  return parsed;
}
function schema(db) {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (
      rid INTEGER PRIMARY KEY, space TEXT NOT NULL CHECK(space IN ('life','work')),
      kind TEXT NOT NULL, id TEXT NOT NULL, at REAL NOT NULL, data TEXT NOT NULL,
      UNIQUE(space,kind,id)
    );
    CREATE INDEX IF NOT EXISTS records_page ON records(space,kind,at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS records_client ON records(space,kind,json_extract(data,'$.clientName'));
    CREATE INDEX IF NOT EXISTS records_title ON records(space,kind,json_extract(data,'$.title'));
    CREATE INDEX IF NOT EXISTS records_name ON records(space,kind,json_extract(data,'$.name'));
    CREATE INDEX IF NOT EXISTS records_subject ON records(space,kind,json_extract(data,'$.subject'));
    CREATE TABLE IF NOT EXISTS search_terms (
      space TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, term TEXT NOT NULL,
      PRIMARY KEY(space,kind,id,term),
      FOREIGN KEY(space,kind,id) REFERENCES records(space,kind,id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS terms_lookup ON search_terms(space,kind,term,id);
    CREATE TABLE IF NOT EXISTS relations (
      space TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, related_id TEXT NOT NULL,
      PRIMARY KEY(space,kind,id,related_id),
      FOREIGN KEY(space,kind,id) REFERENCES records(space,kind,id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS relation_lookup ON relations(space,kind,related_id,id);
    CREATE TABLE IF NOT EXISTS work_index (
      space TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, bucket TEXT NOT NULL, time REAL NOT NULL, sort REAL NOT NULL,
      PRIMARY KEY(space,kind,id), FOREIGN KEY(space,kind,id) REFERENCES records(space,kind,id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS work_by_time ON work_index(space,bucket,time,id);
    CREATE INDEX IF NOT EXISTS work_by_sort ON work_index(space,bucket,sort,id);
    CREATE VIRTUAL TABLE IF NOT EXISTS record_fts USING fts5(text, tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS applied (
      space TEXT NOT NULL, id TEXT NOT NULL, signature TEXT NOT NULL, result TEXT NOT NULL, at REAL NOT NULL,
      PRIMARY KEY(space,id)
    ) WITHOUT ROWID;
  `);
}
const readMeta = (db, key, fallback) => {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : fallback;
};
const writeMeta = (db, key, value) => db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
const fromRow = row => row ? ({ space: row.space, kind: row.kind, id: row.id, at: row.at, data: JSON.parse(row.data) }) : null;

async function createPersistence({ filePath }) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('需要明确数据库文件路径。');
  const core = await import(pathToFileURL(path.join(__dirname, '../shared/persistence-core.mjs')).href);
  const { redactEvent } = core;
  const { RECORD_KINDS, DEFAULT_PUBLIC_SETTINGS, validateRecord, validateSettings, validateTransaction, flattenV3,
    makeBootstrap, searchTerms, recordAt, recordText, stableJson, sameValue, eventMutations, isBusinessKind,
    validateCaptureCommand, captureRows, workIndex, workDay, normalizeApplied } = core;
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  let db = new Database(filePath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    schema(db);
  } catch (error) { db.close(); throw error; }
  let closed = false;
  const filename = filePath === ':memory:' ? filePath : path.resolve(filePath);
  const get = (space, kind, id) => {
    const row = db.prepare('SELECT data FROM records WHERE space=? AND kind=? AND id=?').get(space, kind, id);
    return row ? JSON.parse(row.data) : null;
  };
  function envelope(row) {
    return row && Object.keys(row).every(k => ['space', 'kind', 'id', 'data', 'at'].includes(k)) &&
      SPACES.includes(row.space) && RECORD_KINDS.includes(row.kind) && typeof row.id === 'string' && !!row.id && Number.isFinite(row.at) &&
      validateRecord(row.space, row.kind, row.data) && (['wallet', 'rpg'].includes(row.kind) ? row.id === row.kind : row.data.id === row.id);
  }
  function put(target, row) {
    const existing = target.prepare('SELECT rid FROM records WHERE space=? AND kind=? AND id=?').get(row.space, row.kind, row.id);
    if (existing) {
      target.prepare('DELETE FROM record_fts WHERE rowid=?').run(existing.rid);
      target.prepare('DELETE FROM search_terms WHERE space=? AND kind=? AND id=?').run(row.space, row.kind, row.id);
      target.prepare('DELETE FROM relations WHERE space=? AND kind=? AND id=?').run(row.space, row.kind, row.id);
    }
    target.prepare(`INSERT INTO records(space,kind,id,at,data) VALUES (?,?,?,?,?)
      ON CONFLICT(space,kind,id) DO UPDATE SET at=excluded.at,data=excluded.data`).run(row.space, row.kind, row.id, row.at, JSON.stringify(row.data));
    const rid = existing?.rid || target.prepare('SELECT rid FROM records WHERE space=? AND kind=? AND id=?').get(row.space, row.kind, row.id).rid;
    const text = recordText(row.kind, row.data);
    target.prepare('INSERT INTO record_fts(rowid,text) VALUES (?,?)').run(rid, text);
    const termStatement = target.prepare('INSERT OR IGNORE INTO search_terms(space,kind,id,term) VALUES (?,?,?,?)');
    for (const term of searchTerms(text)) termStatement.run(row.space, row.kind, row.id, term);
    const refs = [row.data.engagementId, row.data.sourceMessageId, row.data.eventId, ...(row.data.sourceIds || []), ...(row.data.engagementIds || []), ...(row.data.taskIds || []), ...(row.data.followUpIds || [])].filter(v => typeof v === 'string' && v);
    const referenceStatement = target.prepare('INSERT OR IGNORE INTO relations(space,kind,id,related_id) VALUES (?,?,?,?)');
    for (const ref of new Set(refs)) referenceStatement.run(row.space, row.kind, row.id, ref);
    target.prepare('DELETE FROM work_index WHERE space=? AND kind=? AND id=?').run(row.space, row.kind, row.id);
    const entry = row.space === 'work' ? workIndex(row.kind, row.data) : null;
    if (entry) target.prepare('INSERT INTO work_index(space,kind,id,bucket,time,sort) VALUES (?,?,?,?,?,?)').run(row.space, row.kind, row.id, entry.bucket, entry.time, entry.sort);
  }
  function remove(target, space, kind, id) {
    const row = target.prepare('SELECT rid FROM records WHERE space=? AND kind=? AND id=?').get(space, kind, id);
    if (row) target.prepare('DELETE FROM record_fts WHERE rowid=?').run(row.rid);
    target.prepare('DELETE FROM records WHERE space=? AND kind=? AND id=?').run(space, kind, id);
  }
  function metadata(target = db) {
    return { settings: readMeta(target, 'settings', { ...DEFAULT_PUBLIC_SETTINGS }), mode: readMeta(target, 'mode', 'work'),
      revisions: readMeta(target, 'revisions', { life: 0, work: 0 }), snapshotRevision: readMeta(target, 'snapshotRevision', 0) };
  }
  function bump(space, business = true) {
    const meta = metadata();
    if (business) { meta.revisions[space]++; writeMeta(db, 'revisions', meta.revisions); }
    writeMeta(db, 'snapshotRevision', meta.snapshotRevision + 1);
    writeMeta(db, 'ready', true);
  }
  function validateLinks(target) {
    const invalid = target.prepare(`SELECT t.id FROM records t WHERE t.kind IN ('task','followup') AND
      json_extract(t.data,'$.engagementId') IS NOT NULL AND json_extract(t.data,'$.engagementId') != '' AND NOT EXISTS
      (SELECT 1 FROM records e WHERE e.space=t.space AND e.kind='engagement' AND e.id=json_extract(t.data,'$.engagementId')) LIMIT 1`).get();
    if (invalid) throw new Error('待办关联项目不存在，未保存任何更改。');
  }
  // The metadata switch and derived-index upgrade are atomic. Existing business JSON is unchanged.
  if (readMeta(db, 'schemaVersion', 0) < 5) db.transaction(() => {
    let cursor = 0;
    while (true) {
      const rows = db.prepare("SELECT * FROM records WHERE rid>? AND kind IN ('task','followup','closure') ORDER BY rid LIMIT 200").all(cursor);
      if (!rows.length) break;
      for (const row of rows) {
        const data = JSON.parse(row.data), entry = row.space === 'work' ? workIndex(row.kind, data) : null;
        if (entry) db.prepare('INSERT OR REPLACE INTO work_index(space,kind,id,bucket,time,sort) VALUES (?,?,?,?,?,?)').run(row.space, row.kind, row.id, entry.bucket, entry.time, entry.sort);
      }
      cursor = rows.at(-1).rid;
    }
    writeMeta(db, 'schemaVersion', 5);
  })();
  function saveDraft(command) {
    if (Object.keys(command).some(k => !['op', 'space', 'draft'].includes(k)) || !validateRecord('work', 'capture_draft', command.draft)) throw new Error('工作草稿格式无效。');
    return db.transaction(() => {
      const draft = command.draft;
      if (db.prepare('SELECT 1 FROM applied WHERE space=? AND id=?').get('work', `capture-session:${draft.sessionId}`)) throw new Error('这次整理已结束，旧草稿未重新打开。');
      const previous = get('work', 'capture_draft', 'active-work');
      if (previous && previous.sessionId !== draft.sessionId) throw new Error('已有另一段未完成整理，请先处理。');
      if (previous && (previous.draftVersion > draft.draftVersion || (previous.draftVersion === draft.draftVersion && !sameValue(previous, draft)))) throw new Error('草稿已更新，拒绝较旧的保存。');
      put(db, { space: 'work', kind: 'capture_draft', id: draft.id, data: draft, at: draft.updatedAt });
      bump('work', false); return { ok: true };
    })();
  }
  function commitCapture(command) {
    if (!validateCaptureCommand(command)) throw new Error('沟通收尾格式无效，请重新核对。');
    const signature = createHash('sha256').update(stableJson(command)).digest('hex');
    const p = command.proposal;
    return db.transaction(() => {
      const previous = db.prepare('SELECT signature,result FROM applied WHERE space=? AND id=?').get('work', p.id);
      if (previous) {
        if (previous.signature !== signature) throw new Error('同一批次标识被用于不同内容。');
        return { ...JSON.parse(previous.result), already: true };
      }
      const draft = get('work', 'capture_draft', 'active-work');
      if (!draft || draft.sessionId !== command.draftSessionId || draft.sourceMessageId !== p.sourceMessageId || draft.text !== p.sourceText ||
          (!command.originalOnly && (!sameValue(draft.proposal, p) || draft.conflicts?.length))) throw new Error('草稿已改变或仍有冲突，请重新核对。');
      const { mutations, source, closure } = captureRows(command);
      if (mutations.length) {
        const errors = validateTransaction({ op: 'transaction', space: 'work', id: p.id, baseRevision: p.baseRevision, mutations }, metadata().revisions.work, (kind, id) => get('work', kind, id));
        if (errors.length) throw new Error(errors.join(' '));
      }
      const existingSource = get('work', 'message', source.id);
      if (existingSource && (existingSource.content !== source.content || existingSource.role !== 'user')) throw new Error('来源原文与本次整理不一致。');
      if (!existingSource) put(db, { space: 'work', kind: 'message', id: source.id, data: source, at: source.timestamp });
      for (const m of mutations) {
        if (m.after === null) remove(db, 'work', m.kind, m.id);
        else put(db, { space: 'work', kind: m.kind, id: m.id, data: m.after, at: recordAt(m.after) });
      }
      validateLinks(db);
      const createdAt = Math.max(command.confirmedAt, (db.prepare("SELECT max(at) AS at FROM records WHERE space='work' AND kind='event'").get().at || 0) + 1);
      const event = { id: closure.eventId, proposalId: p.id, mode: 'work', sourceMessageId: p.sourceMessageId, sourceText: p.sourceText, mutations, createdAt };
      put(db, { space: 'work', kind: 'event', id: event.id, data: event, at: createdAt });
      put(db, { space: 'work', kind: 'closure', id: closure.id, data: closure, at: closure.confirmedAt });
      remove(db, 'work', 'capture_draft', 'active-work');
      bump('work', mutations.some(m => isBusinessKind(m.kind)));
      const result = { ok: true, closureId: closure.id, eventId: event.id, receipts: [] };
      db.prepare('INSERT INTO applied(space,id,signature,result,at) VALUES (?,?,?,?,?)').run('work', p.id, signature, JSON.stringify(result), command.confirmedAt);
      db.prepare('INSERT INTO applied(space,id,signature,result,at) VALUES (?,?,?,?,?)').run('work', `capture-session:${command.draftSessionId}`, '', JSON.stringify({ ok: true, receipts: [] }), command.confirmedAt);
      return result;
    })();
  }
  function workHome(command) {
    const { start, end } = workDay(command.now ?? Date.now()); const limit = Math.min(3, Math.max(1, command.limit || 3));
    const group = (bucket, condition = '', params = [], reverse = false) => {
      const where = `i.space='work' AND i.bucket=?${condition}`;
      const count = db.prepare(`SELECT count(*) AS count FROM work_index i WHERE ${where}`).get(bucket, ...params).count;
      const rows = db.prepare(`SELECT r.data FROM work_index i JOIN records r ON r.space=i.space AND r.kind=i.kind AND r.id=i.id WHERE ${where} ORDER BY i.${bucket === 'waiting' || bucket === 'question' ? 'sort' : 'time'} ${reverse ? 'DESC' : 'ASC'},i.id LIMIT ?`).all(bucket, ...params, limit);
      return { items: rows.map(row => JSON.parse(row.data)), count };
    };
    const today = group('task', ' AND i.time>=? AND i.time<?', [start, end]);
    const overdue = group('task', ' AND i.time<?', [start]); const waiting = group('waiting'), questions = group('question'), recent = group('closure', '', [], true);
    return { draft: get('work', 'capture_draft', 'active-work'), today: today.items, overdue: overdue.items, waiting: waiting.items, questions: questions.items, recent: recent.items,
      counts: { today: today.count, overdue: overdue.count, waiting: waiting.count, questions: questions.count } };
  }
  function stats(space) {
    const counts = Object.fromEntries(RECORD_KINDS.map(kind => [kind, 0]));
    for (const row of db.prepare('SELECT kind,count(*) AS total FROM records WHERE space=? GROUP BY kind').all(space)) counts[row.kind] = row.total;
    const tasks = db.prepare(`SELECT
      sum(CASE WHEN json_extract(data,'$.done')=0 THEN 1 ELSE 0 END) AS openTasks,
      sum(CASE WHEN json_extract(data,'$.done')=0 AND json_extract(data,'$.dueAt') IS NOT NULL AND
        julianday(json_extract(data,'$.dueAt')) <= julianday(?) THEN 1 ELSE 0 END) AS dueTasks
      FROM records WHERE space=? AND kind='task'`).get(new Date().toISOString(), space);
    let storageBytes = 0;
    if (filename !== ':memory:') for (const name of [filename, `${filename}-wal`, `${filename}-shm`]) {
      try { storageBytes += fs.statSync(name).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const dueFollowUps = space === 'work' ? db.prepare("SELECT count(*) AS count FROM work_index WHERE space='work' AND bucket IN ('waiting','question') AND sort<=?").get(Date.now()).count : 0;
    return { space, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), openTasks: tasks.openTasks || 0, dueTasks: tasks.dueTasks || 0, dueFollowUps, storageBytes };
  }
  function query(command) {
    if (!RECORD_KINDS.includes(command.kind)) throw new Error('记录类型无效。');
    const limit = command.limit === undefined ? 50 : Math.max(1, Math.min(200, Number.isInteger(command.limit) ? command.limit : 50));
    const where = ['r.space=?', 'r.kind=?'], args = [command.space, command.kind];
    if (command.dueOnly !== undefined && (typeof command.dueOnly !== 'boolean' || !['task', 'followup'].includes(command.kind))) throw new Error('到期筛选仅支持待办和自设回访。');
    const followupDue = command.dueOnly && command.kind === 'followup';
    if (followupDue) { where.push("i.bucket IN ('waiting','question') AND i.sort<=?"); args.push(Date.now()); }
    else if (command.dueOnly) { where.push("json_extract(r.data,'$.done')=0 AND julianday(json_extract(r.data,'$.dueAt'))<=julianday(?)"); args.push(new Date().toISOString()); }
    const filters = ['ids', 'names'];
    for (const field of filters) {
      if (command[field] !== undefined && (!Array.isArray(command[field]) || command[field].length > 200 || !command[field].every(x => typeof x === 'string'))) throw new Error('精确查询条件无效。');
      if (!command[field]) continue;
      if (!command[field].length) return { items: [], nextCursor: null };
      const placeholders = command[field].map(() => '?').join(',');
      if (field === 'ids') { where.push(`r.id IN (${placeholders})`); args.push(...command[field]); }
      else {
        where.push(`(json_extract(r.data,'$.clientName') IN (${placeholders}) OR json_extract(r.data,'$.title') IN (${placeholders}) OR json_extract(r.data,'$.name') IN (${placeholders}) OR json_extract(r.data,'$.subject') IN (${placeholders}))`);
        for (let i = 0; i < 4; i++) args.push(...command[field]);
      }
    }
    if (command.relatedId !== undefined) {
      if (typeof command.relatedId !== 'string') throw new Error('关联查询条件无效。');
      where.push('EXISTS (SELECT 1 FROM relations rel WHERE rel.space=r.space AND rel.kind=r.kind AND rel.id=r.id AND rel.related_id=?)'); args.push(command.relatedId);
    }
    if (command.query !== undefined && command.query !== '') {
      if (typeof command.query !== 'string' || command.query.length > 1000) throw new Error('搜索文本无效。');
      const terms = searchTerms(command.query);
      if (!terms.length) return { items: [], nextCursor: null };
      if (terms.some(term => [...term].length === 1) && !command.ids?.length && !command.names?.length && !command.relatedId) throw new Error('单字搜索请先限定人物、项目或来源。');
      for (const term of terms) {
        if ([...term].length === 1) where.push('EXISTS (SELECT 1 FROM record_fts WHERE rowid=r.rid AND instr(lower(text),?)>0)');
        else where.push('EXISTS (SELECT 1 FROM search_terms st WHERE st.space=r.space AND st.kind=r.kind AND st.id=r.id AND st.term=?)');
        args.push(term);
      }
    }
    if (command.cursor) { const cursor = decode(command.cursor);
      if (followupDue) {
        if (!Number.isFinite(cursor.reviewAt)) throw new Error('回访分页游标无效。');
        where.push('(i.sort>? OR (i.sort=? AND r.id>?))'); args.push(cursor.reviewAt, cursor.reviewAt, cursor.id);
      } else { where.push('(r.at<? OR (r.at=? AND r.id<?))'); args.push(cursor.at, cursor.at, cursor.id); }
    }
    const join = followupDue ? ' JOIN work_index i ON i.space=r.space AND i.kind=r.kind AND i.id=r.id' : '';
    const order = followupDue ? 'i.sort ASC,r.id ASC' : 'r.at DESC,r.id DESC';
    const rows = db.prepare(`SELECT r.*${followupDue ? ',i.sort AS reviewAt' : ''} FROM records r${join} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...args, limit + 1);
    const more = rows.length > limit; if (more) rows.pop();
    const last = rows.at(-1);
    return { items: rows.map(row => JSON.parse(row.data)), nextCursor: more ? encode({ at: last.at, id: last.id, ...(followupDue ? { reviewAt: last.reviewAt } : {}) }) : null };
  }
  function commit(command) {
    const signature = createHash('sha256').update(stableJson(command)).digest('hex');
    return db.transaction(() => {
      const previous = db.prepare('SELECT signature,result FROM applied WHERE space=? AND id=?').get(command.space, command.id);
      if (previous) {
        if (previous.signature && previous.signature !== signature) throw new Error('同一批次标识被用于不同内容。');
        return { ...JSON.parse(previous.result), already: true };
      }
      const errors = validateTransaction(command, metadata().revisions[command.space], (kind, id) => get(command.space, kind, id));
      if (errors.length) throw new Error(errors.join(' '));
      for (const mutation of command.mutations) {
        if (mutation.after === null) remove(db, command.space, mutation.kind, mutation.id);
        else put(db, { space: command.space, kind: mutation.kind, id: mutation.id, data: mutation.after, at: recordAt(mutation.after) });
      }
      const retired = command.mutations.filter(m => m.kind === 'memory' && m.after?.status === 'retracted').map(m => m.id);
      if (command.redactSourceIds?.length || retired.length) {
        const draft = get(command.space, 'capture_draft', 'active-work');
        if (draft && command.redactSourceIds?.includes(draft.sourceMessageId)) {
          remove(db, command.space, 'capture_draft', 'active-work');
          db.prepare('INSERT OR IGNORE INTO applied(space,id,signature,result,at) VALUES (?,?,?,?,?)').run(command.space, `capture-session:${draft.sessionId}`, '', JSON.stringify({ ok: true, receipts: [] }), Date.now());
        }
        let cursor = 0;
        while (true) {
          const rows = db.prepare("SELECT * FROM records WHERE space=? AND kind='event' AND rid>? ORDER BY rid LIMIT 200").all(command.space, cursor);
          if (!rows.length) break;
          for (const row of rows) { const data = redactEvent(JSON.parse(row.data), command.redactSourceIds, retired); if (data) put(db, { ...fromRow(row), data }); }
          cursor = rows.at(-1).rid;
        }
      }
      validateLinks(db);
      const now = Math.max(Date.now(), (db.prepare("SELECT max(at) AS at FROM records WHERE space=? AND kind='event'").get(command.space).at || 0) + 1);
      if (command.event) {
        const event = { id: `event-${command.id}`, proposalId: command.id, mode: command.space, sourceMessageId: command.sourceMessageId || '',
          sourceText: command.sourceText || '', mutations: command.mutations, createdAt: now };
        if (!validateRecord(command.space, 'event', event)) throw new Error('变更历史校验失败。');
        put(db, { space: command.space, kind: 'event', id: event.id, data: event, at: now });
      }
      const business = command.mutations.some(m => isBusinessKind(m.kind));
      bump(command.space, business);
      const receipts = command.event ? command.mutations.map((m, i) => ({ id: `receipt-${command.id}-${i}`, mode: command.space,
        targetCardType: ({ engagement: 'crm', task: 'projects', memory: 'custom', wallet: 'wallet', expense: 'wallet', rpg: 'rpg_status', person: 'relationships', custom: 'custom' })[m.kind] || 'custom',
        targetCardTitle: m.after?.title || m.after?.clientName || m.after?.name || '已确认记录', summaryText: m.after === null ? '已删除' : m.before === null ? '已添加' : '已更新', deltaBadge: '已保存', timestamp: now })) : [];
      const result = { ok: true, receipts };
      db.prepare('INSERT INTO applied(space,id,signature,result,at) VALUES (?,?,?,?,?)').run(command.space, command.id, signature, JSON.stringify(result), now);
      return result;
    })();
  }
  function undo(space, eventId) {
    return db.transaction(() => {
      const row = db.prepare(`SELECT * FROM records WHERE space=? AND kind='event' AND json_extract(data,'$.revertedAt') IS NULL ORDER BY at DESC,rid DESC LIMIT 1`).get(space);
      if (!row) return { ok: false, error: '没有可撤销的变更。' };
      if (eventId !== undefined && eventId !== row.id) throw new Error('该操作之后已有新变更，请在变更记录中核对。');
      const event = JSON.parse(row.data), mutations = eventMutations(event);
      for (const m of mutations) if (!sameValue(get(space, m.kind, m.id), m.after)) throw new Error('记录已有后续修改，请先核对后再撤销。');
      for (const m of [...mutations].reverse()) {
        if (m.before === null) remove(db, space, m.kind, m.id);
        else put(db, { space, kind: m.kind, id: m.id, data: m.before, at: recordAt(m.before) });
      }
      validateLinks(db);
      event.revertedAt = Date.now(); put(db, { ...fromRow(row), data: event });
      const closure = get(space, 'closure', `closure-${event.proposalId}`);
      if (closure) put(db, { space, kind: 'closure', id: closure.id, data: { ...closure, revertedAt: event.revertedAt }, at: closure.confirmedAt });
      bump(space, mutations.some(m => isBusinessKind(m.kind)));
      return { ok: true };
    })();
  }
  function migrate(command) {
    if (readMeta(db, 'ready', false)) return { ok: true, already: true };
    if (typeof command.fingerprint !== 'string' || !command.fingerprint) throw new Error('迁移缺少来源指纹。');
    const migrated = flattenV3(command.snapshot);
    return db.transaction(() => {
      if (db.prepare('SELECT 1 FROM records LIMIT 1').get()) throw new Error('当前资料库已有记录，未覆盖。');
      for (const row of migrated.records) put(db, row);
      validateLinks(db);
      writeMeta(db, 'settings', migrated.settings); writeMeta(db, 'mode', migrated.mode);
      writeMeta(db, 'revisions', migrated.revisions); writeMeta(db, 'snapshotRevision', command.snapshot.snapshotRevision);
      writeMeta(db, 'sourceFingerprint', command.fingerprint); writeMeta(db, 'ready', true);
      for (const space of SPACES) for (const id of migrated.processedProposalIds[space]) {
        db.prepare('INSERT OR IGNORE INTO applied(space,id,signature,result,at) VALUES (?,?,?,?,?)').run(space, id, '', JSON.stringify({ ok: true, receipts: [] }), 0);
      }
      return { ok: true };
    })();
  }
  function validateBackupMeta(meta) {
    return meta && Object.keys(meta).every(key => ['settings', 'mode', 'revisions', 'snapshotRevision'].includes(key)) &&
      validateSettings(meta.settings) && SPACES.includes(meta.mode) && meta.revisions &&
      Object.keys(meta.revisions).every(key => SPACES.includes(key)) && SPACES.every(space => Number.isInteger(meta.revisions[space]) && meta.revisions[space] >= 0) &&
      Number.isInteger(meta.snapshotRevision) && meta.snapshotRevision >= 0;
  }
  function replaceFromStage(stagePath) {
    db.prepare('ATTACH DATABASE ? AS restoration').run(stagePath);
    try {
      db.transaction(() => {
        db.exec(`DELETE FROM record_fts; DELETE FROM records; DELETE FROM meta; DELETE FROM applied;
          INSERT INTO records SELECT * FROM restoration.records;
          INSERT INTO search_terms SELECT * FROM restoration.search_terms;
          INSERT INTO relations SELECT * FROM restoration.relations;
          INSERT INTO work_index SELECT * FROM restoration.work_index;
          INSERT INTO record_fts(rowid,text) SELECT rowid,text FROM restoration.record_fts;
          INSERT INTO meta SELECT * FROM restoration.meta;
          INSERT INTO applied SELECT * FROM restoration.applied;`);
        validateLinks(db);
      })();
    } finally { db.exec('DETACH DATABASE restoration'); }
  }
  function newStage() {
    const stagePath = filename === ':memory:' ? path.join(require('node:os').tmpdir(), `looma-restore-${randomUUID()}.sqlite`) : `${filename}.restore-${randomUUID()}`;
    const stage = new Database(stagePath); schema(stage);
    return { stage, stagePath };
  }
  function finishStage(stage, meta) {
    validateLinks(stage);
    for (const key of ['settings', 'mode', 'revisions', 'snapshotRevision']) writeMeta(stage, key, key === 'settings' ? { ...DEFAULT_PUBLIC_SETTINGS, ...meta[key] } : meta[key]);
    writeMeta(stage, 'ready', true);
    writeMeta(stage, 'schemaVersion', 5);
  }
  function stageCleanup(stage, stagePath) {
    if (stage.open) stage.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.unlinkSync(stagePath + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  async function restoreFromFile(inputPath) {
    let temporary;
    try {
      if (closed) throw new Error('资料库已关闭。');
      temporary = newStage();
      const { stage, stagePath } = temporary;
      const input = fs.createReadStream(inputPath);
      const inputClosed = new Promise(resolve => input.once('close', resolve));
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      let meta, count = 0, end = false;
      const hash = createHash('sha256');
      stage.exec('BEGIN');
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          if (end) throw new Error('备份结束标记后包含多余内容。');
          const value = JSON.parse(line);
          if (!meta) {
            if (!value || value.format !== FORMAT || ![4, 5].includes(value.version) || Object.keys(value).some(k => !['format', 'version', 'meta'].includes(k)) || !validateBackupMeta(value.meta)) throw new Error('备份头部无效。');
            meta = value.meta; hash.update(`${line}\n`); continue;
          }
          if (value.type === 'end') {
            if (Object.keys(value).some(k => !['type', 'count', 'sha256'].includes(k)) || value.count !== count || value.sha256 !== hash.digest('hex')) throw new Error('备份数量或校验值不匹配。');
            end = true; continue;
          }
          if (value.type === 'record') {
            const { type, ...row } = value;
            if (!envelope(row)) throw new Error('备份包含无效记录。');
            if (stage.prepare('SELECT 1 FROM records WHERE space=? AND kind=? AND id=?').get(row.space, row.kind, row.id)) throw new Error('备份包含重复记录。');
            put(stage, row);
          } else if (value.type === 'applied') {
            const { type, ...envelope } = value; const mark = normalizeApplied(envelope);
            stage.prepare('INSERT INTO applied(space,id,signature,result,at) VALUES (?,?,?,?,?)').run(mark.space, mark.id, mark.signature, JSON.stringify(mark.result), mark.at);
          } else throw new Error('备份记录类型无效。');
          count++; hash.update(`${line}\n`);
        }
        if (!meta || !end) throw new Error('备份不完整。');
        finishStage(stage, meta); stage.exec('COMMIT');
      } catch (error) { if (stage.inTransaction) stage.exec('ROLLBACK'); throw error; }
      finally { lines.close(); input.destroy(); await inputClosed; }
      stage.close(); replaceFromStage(stagePath);
      return { ok: true };
    } catch (error) { return { ok: false, error: `恢复失败，原资料库已保留：${error.message}` }; }
    finally { if (temporary) stageCleanup(temporary.stage, temporary.stagePath); }
  }
  async function exportToFile(outputPath) {
    let readDb, stream, temporaryPath;
    try {
      if (closed) throw new Error('资料库已关闭。');
      if (typeof outputPath !== 'string' || !outputPath || [filename, `${filename}-wal`, `${filename}-shm`].some(name => name.toLowerCase() === path.resolve(outputPath).toLowerCase())) throw new Error('备份路径不能覆盖当前资料库。');
      temporaryPath = `${outputPath}.writing-${randomUUID()}`;
      readDb = filename === ':memory:' ? db : new Database(filename, { readonly: true });
      if (readDb !== db) readDb.exec('BEGIN');
      stream = fs.createWriteStream(temporaryPath, { flags: 'wx' });
      // Keep errors observed even when a small write has not filled the stream buffer.
      let streamError; stream.on('error', error => { streamError = error; });
      const hash = createHash('sha256'); let count = 0;
      const write = async (value, hashed = true) => {
        if (streamError) throw streamError;
        const line = `${JSON.stringify(value)}\n`;
        if (hashed) hash.update(line);
        if (!stream.write(line)) await once(stream, 'drain');
      };
      await write({ format: FORMAT, version: 5, meta: metadata(readDb) });
      for (const row of readDb.prepare('SELECT * FROM records ORDER BY rid').iterate()) { await write({ type: 'record', ...fromRow(row) }); count++; }
      for (const row of readDb.prepare('SELECT * FROM applied ORDER BY space,id').iterate()) { await write({ type: 'applied', ...row, result: JSON.parse(row.result) }); count++; }
      await write({ type: 'end', count, sha256: hash.digest('hex') }, false);
      const streamClosed = new Promise(resolve => stream.once('close', resolve));
      stream.end(); await once(stream, 'finish'); await streamClosed; if (streamError) throw streamError;
      fs.renameSync(temporaryPath, outputPath); temporaryPath = undefined;
      return { ok: true, records: count };
    } catch (error) { return { ok: false, error: `备份失败：${error.message}` }; }
    finally {
      if (stream && !stream.closed) stream.destroy();
      if (readDb && readDb !== db) readDb.close();
      if (temporaryPath) { try { fs.unlinkSync(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
  }
  async function request(command) {
    try {
      if (closed) throw new Error('资料库已关闭。');
      if (!command || typeof command !== 'object' || typeof command.op !== 'string') throw new Error('资料请求无效。');
      if (['bootstrap', 'list', 'get', 'transaction', 'undo', 'mode', 'stats', 'rebuildIndexes', 'saveDraft', 'commitCapture', 'workHome'].includes(command.op) && !SPACES.includes(command.space)) throw new Error('必须明确指定工作或生活空间。');
      if (['saveDraft', 'commitCapture', 'workHome'].includes(command.op) && command.space !== 'work') throw new Error('收尾操作仅属于工作空间。');
      switch (command.op) {
        case 'init': return { ready: readMeta(db, 'ready', false), mode: metadata().mode, settings: metadata().settings };
        case 'migrate': return migrate(command);
        case 'bootstrap': {
          const rows = [];
          for (const kind of RECORD_KINDS) rows.push(...db.prepare('SELECT * FROM records WHERE space=? AND kind=? ORDER BY at DESC,id DESC LIMIT 50').all(command.space, kind).map(fromRow));
          return makeBootstrap(metadata(), rows, stats(command.space));
        }
        case 'list': return query(command);
        case 'get': if (!RECORD_KINDS.includes(command.kind) || typeof command.id !== 'string') throw new Error('记录标识无效。'); return get(command.space, command.kind, command.id);
        case 'transaction': return commit(command);
        case 'saveDraft': return saveDraft(command);
        case 'commitCapture': return commitCapture(command);
        case 'workHome': return workHome(command);
        case 'undo': return undo(command.space, command.eventId);
        case 'stats': return stats(command.space);
        case 'rebuildIndexes': return db.transaction(() => {
          let cursor = 0, total = 0;
          // Explicit maintenance also keeps its in-memory working set bounded.
          while (true) {
            const rows = db.prepare('SELECT * FROM records WHERE space=? AND rid>? ORDER BY rid LIMIT 200').all(command.space, cursor);
            if (!rows.length) break;
            for (const row of rows) put(db, fromRow(row));
            cursor = rows.at(-1).rid; total += rows.length;
          }
          return { ok: true, records: total };
        })();
        case 'settings': {
          const settings = metadata().settings;
          if (command.patch !== undefined) {
            if (!validateSettings(command.patch, true)) throw new Error('设置包含未知字段或凭据，未保存。');
            writeMeta(db, 'settings', { ...settings, ...command.patch });
          }
          return metadata().settings;
        }
        case 'mode': writeMeta(db, 'mode', command.space); return { ok: true };
        case 'exportPage': {
          const limit = Math.max(1, Math.min(200, Number.isInteger(command.limit) ? command.limit : 200));
          const cursor = command.cursor ? decode(command.cursor) : { at: 0, id: '' };
          if (cursor.phase === 'applied') {
            const marks = db.prepare('SELECT * FROM applied WHERE (space>? OR (space=? AND id>?)) ORDER BY space,id LIMIT ?').all(cursor.space || '', cursor.space || '', cursor.id, limit + 1);
            const more = marks.length > limit; if (more) marks.pop(); const last = marks.at(-1);
            return { records: [], applied: marks.map(row => ({ ...row, result: JSON.parse(row.result) })), nextCursor: more ? encode({ phase: 'applied', at: 0, space: last.space, id: last.id }) : null, ...metadata() };
          }
          const rows = db.prepare('SELECT * FROM records WHERE rid>? ORDER BY rid LIMIT ?').all(cursor.at, limit + 1);
          const more = rows.length > limit; if (more) rows.pop();
          const hasMarks = !more && !!db.prepare('SELECT 1 FROM applied LIMIT 1').get();
          return { records: rows.map(fromRow), applied: [], nextCursor: more ? encode({ at: rows.at(-1).rid, id: '' }) : hasMarks ? encode({ phase: 'applied', at: 0, space: '', id: '' }) : null, ...metadata() };
        }
        case 'exportSnapshot': return db.transaction(() => ({ records: db.prepare('SELECT * FROM records ORDER BY rid').all().map(fromRow),
          applied: db.prepare('SELECT * FROM applied ORDER BY space,id').all().map(row => ({ ...row, result: JSON.parse(row.result) })), ...metadata() }))();
        case 'restore': {
          if (!Array.isArray(command.records)) throw new Error('备份记录无效。');
          const meta = { settings: command.settings, mode: command.mode, revisions: command.revisions || { life: 0, work: 0 }, snapshotRevision: command.snapshotRevision || 0 };
          if (!validateBackupMeta(meta)) throw new Error('备份设置无效。');
          const { stage, stagePath } = newStage();
          try {
            stage.transaction(() => {
              for (const row of command.records) {
                if (!envelope(row)) throw new Error('备份包含无效记录。');
                if (stage.prepare('SELECT 1 FROM records WHERE space=? AND kind=? AND id=?').get(row.space, row.kind, row.id)) throw new Error('备份包含重复记录。');
                put(stage, row);
              }
              if (command.applied !== undefined && !Array.isArray(command.applied)) throw new Error('备份批次标记无效。');
              for (const raw of command.applied || []) {
                const mark = normalizeApplied(raw);
                stage.prepare('INSERT INTO applied(space,id,signature,result,at) VALUES (?,?,?,?,?)').run(mark.space, mark.id, mark.signature, JSON.stringify(mark.result), mark.at);
              }
              finishStage(stage, meta);
            })();
            stage.close(); replaceFromStage(stagePath);
            return { ok: true };
          } finally { stageCleanup(stage, stagePath); }
        }
        default: throw new Error('不支持该资料操作。');
      }
    } catch (error) { return { ok: false, error: error.message }; }
  }
  return { filename, request, exportToFile, restoreFromFile, close() { if (!closed) { db.close(); closed = true; } } };
}
module.exports = { createPersistence };
