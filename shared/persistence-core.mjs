// Pure persistence rules shared by Electron and IndexedDB. Never import platform APIs here.
export const DEFAULT_PUBLIC_SETTINGS = Object.freeze({
  apiBaseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-chat', personaName: 'Looma',
  personaAvatar: '✨', personaGreeting: '把零散沟通整理成可信的下一步。',
  systemPrompt: '你是 Looma 客户跟进伴侣。整理用户提供的事实，不猜测预算、成交或承诺；变更必须由用户确认。',
  alwaysOnTop: false, modelEnabled: false, remindersEnabled: false, memoryModelEnabled: false,
});
export const RECORD_KINDS = Object.freeze(['message', 'event', 'engagement', 'task', 'memory', 'summary', 'expense', 'person', 'journal', 'custom', 'wallet', 'rpg', 'capture_draft', 'followup', 'closure']);
const spaces = ['life', 'work'];
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const str = x => typeof x === 'string';
const finite = x => typeof x === 'number' && Number.isFinite(x);
const strings = x => Array.isArray(x) && x.every(str);
const only = (x, keys) => object(x) && Object.keys(x).every(key => keys.includes(key));
const base = x => object(x) && str(x.id) && !!x.id.trim();
const optional = (x, key, check) => x[key] === undefined || check(x[key]);
const unique = xs => new Set(xs.map(x => x?.id)).size === xs.length;
const status = x => ['active', 'superseded', 'retracted'].includes(x);
const commonLife = ['expense', 'person', 'wallet', 'rpg'];
const commonWork = ['engagement', 'task', 'capture_draft', 'followup', 'closure'];
export const clone = x => JSON.parse(JSON.stringify(x));
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sameValue = (a, b) => stableJson(a) === stableJson(b);
const day = value => str(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const iso = value => str(value) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && day(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
export const isBusinessKind = kind => !['message', 'summary', 'capture_draft', 'closure'].includes(kind);
export function validateCaptureProposal(proposal) {
  return only(proposal, ['id', 'sourceMessageId', 'sourceText', 'mode', 'baseRevision', 'operations', 'warnings', 'createdAt', 'clarification']) && base(proposal) &&
    proposal.mode === 'work' && str(proposal.sourceMessageId) && !!proposal.sourceMessageId && str(proposal.sourceText) && proposal.sourceText.length <= 12000 &&
    Number.isInteger(proposal.baseRevision) && proposal.baseRevision >= 0 && finite(proposal.createdAt) && strings(proposal.warnings) &&
    Array.isArray(proposal.operations) && proposal.operations.length <= 2000 && proposal.operations.every(op =>
      only(op, ['target', 'entityId', 'before', 'after']) && ['engagement', 'task', 'memory', 'followup'].includes(op.target) &&
      validMutation('work', { kind: op.target, id: op.entityId, before: op.before, after: op.after })) &&
    optional(proposal, 'clarification', c => only(c, ['kind', 'message']) && c.kind === 'project' && str(c.message));
}
function validateDraftProposal(proposal) {
  if (!object(proposal)) return false;
  const candidate = clone(proposal);
  if (Array.isArray(candidate.operations)) candidate.operations = candidate.operations.map(op => {
    if (!object(op?.after)) return op;
    const after = { ...op.after };
    const fields = op.target === 'engagement' ? ['clientName', 'title'] : ['task', 'followup'].includes(op.target) ? ['title'] : [];
    for (const field of fields) if (typeof after[field] === 'string' && !after[field].trim()) after[field] = '待核对';
    return { ...op, after };
  });
  return validateCaptureProposal(candidate);
}
export function validateCaptureCommand(command) {
  return only(command, ['op', 'space', 'draftSessionId', 'proposal', 'confirmedAt', 'originalOnly']) && command.op === 'commitCapture' && command.space === 'work' &&
    str(command.draftSessionId) && !!command.draftSessionId && validateCaptureProposal(command.proposal) && finite(command.confirmedAt) &&
    optional(command, 'originalOnly', value => typeof value === 'boolean') && (command.originalOnly ? command.proposal.operations.length === 0 : command.proposal.operations.length > 0 && !command.proposal.clarification);
}
export function captureRows(command) {
  const proposal = command.proposal;
  const mutations = proposal.operations.map(op => ({ kind: op.target, id: op.entityId, before: op.before, after: op.after }));
  return { mutations, source: { id: proposal.sourceMessageId, role: 'user', content: proposal.sourceText, timestamp: proposal.createdAt },
    closure: { id: `closure-${proposal.id}`, mode: 'work', sourceMessageId: proposal.sourceMessageId, eventId: `event-${proposal.id}`,
      engagementIds: [...new Set(mutations.flatMap(m => [m.kind === 'engagement' ? m.id : undefined, m.after?.engagementId, m.before?.engagementId]).filter(Boolean))],
      taskIds: mutations.filter(m => m.kind === 'task').map(m => m.id), followUpIds: mutations.filter(m => m.kind === 'followup').map(m => m.id),
      confirmedAt: command.confirmedAt, ...(command.originalOnly ? { originalOnly: true } : {}) } };
}
export function workIndex(kind, data) {
  if (kind === 'task' && !data.done && data.dueAt) return { bucket: 'task', time: Date.parse(data.dueAt), sort: Date.parse(data.dueAt) };
  if (kind === 'followup' && data.status === 'open') return { bucket: data.kind, time: data.createdAt, sort: data.reviewAt ? Date.parse(data.reviewAt) : Number.MAX_VALUE };
  if (kind === 'closure') return { bucket: 'closure', time: data.confirmedAt, sort: data.confirmedAt };
  return null;
}
export function workDay(now) {
  if (!finite(now)) throw new Error('首页时间无效。');
  const start = Math.floor((now + 28800000) / 86400000) * 86400000 - 28800000;
  return { start, end: start + 86400000 };
}
export function normalizeApplied(value) {
  if (!only(value, ['space', 'id', 'signature', 'result', 'at']) || !spaces.includes(value.space) || !str(value.id) || !value.id ||
      (value.signature !== undefined && (!str(value.signature) || !/^([a-f0-9]{64})?$/.test(value.signature))) || (value.at !== undefined && !finite(value.at))) throw new Error('备份批次标记无效。');
  const result = value.result || { ok: true, receipts: [] };
  if (!only(result, ['ok', 'receipts', 'closureId', 'eventId']) || result.ok !== true || !Array.isArray(result.receipts) ||
      !optional(result, 'closureId', str) || !optional(result, 'eventId', str) ||
      !validateRecord(value.space, 'message', { id: 'receipts', role: 'system', content: '', timestamp: 0, mutations: result.receipts })) throw new Error('备份提交结果无效。');
  return { space: value.space, id: value.id, signature: value.signature || '', result: clone(result), at: value.at || 0 };
}

export function validateSettings(settings, partial = false) {
  return only(settings, Object.keys(DEFAULT_PUBLIC_SETTINGS)) &&
    Object.keys(settings).every(k => typeof settings[k] === typeof DEFAULT_PUBLIC_SETTINGS[k]) &&
    (partial || Object.keys(DEFAULT_PUBLIC_SETTINGS).filter(k => k !== 'memoryModelEnabled').every(k => k in settings));
}
function validMutation(space, m) {
  return only(m, ['kind', 'id', 'before', 'after']) && RECORD_KINDS.includes(m.kind) && m.kind !== 'event' &&
    str(m.id) && !!m.id && (!['wallet', 'rpg'].includes(m.kind) || m.id === m.kind) && 'before' in m && 'after' in m && !(m.before === null && m.after === null) &&
    [m.before, m.after].every(value => value === null || (validateRecord(space, m.kind, value) &&
      (['wallet', 'rpg'].includes(m.kind) || value.id === m.id)));
}
export function eventMutations(event) {
  return event.mutations || (event.operations || []).map(op => op && ({ kind: op.target, id: op.entityId, before: op.before, after: op.after }));
}
/** Privacy cleanup is irreversible by business undo; independently confirmed business fields remain. */
export function redactEvent(event, sourceIds = [], retiredMemoryIds = []) {
  const sources = new Set(sourceIds), retired = new Set(retiredMemoryIds);
  const next = clone(event);
  if (sources.has(event.sourceMessageId)) next.sourceText = '来源原文已由用户删除';
  const keep = m => !(m.kind === 'message' && sources.has(m.id)) && !(m.kind === 'memory' && retired.has(m.id));
  if (next.mutations) next.mutations = next.mutations.filter(keep);
  if (next.operations) next.operations = next.operations.filter(op => keep({ kind: op.target, id: op.entityId }));
  return sameValue(next, event) ? null : next;
}
export function validateRecord(space, kind, x) {
  if (!spaces.includes(space) || !RECORD_KINDS.includes(kind) || !object(x) ||
      (space === 'work' && commonLife.includes(kind)) || (space === 'life' && commonWork.includes(kind))) return false;
  switch (kind) {
    case 'followup': return base(x) && only(x, ['id', 'kind', 'title', 'engagementId', 'status', 'sourceMessageId', 'createdAt', 'updatedAt', 'expectedDate', 'expectedAt', 'sourceDateText', 'reviewAt']) &&
      ['waiting', 'question'].includes(x.kind) && str(x.title) && !!x.title.trim() && ['open', 'resolved'].includes(x.status) && str(x.sourceMessageId) && !!x.sourceMessageId &&
      finite(x.createdAt) && finite(x.updatedAt) && optional(x, 'engagementId', str) && optional(x, 'expectedDate', day) && optional(x, 'expectedAt', iso) &&
      !(x.expectedDate && x.expectedAt) && optional(x, 'sourceDateText', str) && optional(x, 'reviewAt', iso);
    case 'capture_draft': return x.id === 'active-work' && only(x, ['id', 'sessionId', 'mode', 'text', 'selectedEngagementId', 'newClientName', 'newProjectTitle', 'sourceVersion', 'draftVersion', 'sourceMessageId', 'proposal', 'conflicts', 'status', 'updatedAt']) &&
      x.mode === 'work' && str(x.sessionId) && !!x.sessionId && str(x.text) && x.text.length <= 12000 && ['editing', 'review'].includes(x.status) && finite(x.updatedAt) &&
      Number.isInteger(x.sourceVersion) && x.sourceVersion >= 0 && Number.isInteger(x.draftVersion) && x.draftVersion >= 0 && str(x.sourceMessageId) && !!x.sourceMessageId &&
      ['selectedEngagementId', 'newClientName', 'newProjectTitle'].every(k => optional(x, k, str)) && optional(x, 'proposal', validateDraftProposal) &&
      (x.status !== 'review' || !!x.proposal) && (!x.proposal || (x.proposal.sourceMessageId === x.sourceMessageId && x.proposal.sourceText === x.text)) &&
      optional(x, 'conflicts', list => Array.isArray(list) && list.every(c => base(c) && only(c, ['id', 'target', 'entityId', 'field', 'original', 'current', 'proposed']) &&
        ['engagement', 'task', 'memory', 'followup'].includes(c.target) && str(c.entityId) && str(c.field)));
    case 'closure': return base(x) && only(x, ['id', 'mode', 'sourceMessageId', 'eventId', 'engagementIds', 'taskIds', 'followUpIds', 'confirmedAt', 'revertedAt', 'originalOnly']) && x.mode === 'work' &&
      str(x.sourceMessageId) && str(x.eventId) && ['engagementIds', 'taskIds', 'followUpIds'].every(k => strings(x[k]) && new Set(x[k]).size === x[k].length) &&
      finite(x.confirmedAt) && optional(x, 'revertedAt', finite) && optional(x, 'originalOnly', value => typeof value === 'boolean');
    case 'engagement': return base(x) && only(x, ['id', 'clientName', 'title', 'budgetAmount', 'stage', 'internalContext', 'shareableSummary', 'nextAction', 'updatedAt']) &&
      str(x.clientName) && !!x.clientName.trim() && str(x.title) && !!x.title.trim() && optional(x, 'budgetAmount', n => finite(n) && n >= 0) &&
      ['初步接触', '需求确认', '方案报价', '商务谈判', '赢单成交'].includes(x.stage) &&
      ['internalContext', 'shareableSummary', 'nextAction'].every(k => str(x[k])) && finite(x.updatedAt);
    case 'task': return base(x) && only(x, ['id', 'title', 'assignee', 'deadline', 'priority', 'done', 'engagementId', 'dueAt', 'sourceDeadlineText']) &&
      str(x.title) && !!x.title.trim() && str(x.assignee) && str(x.deadline) && ['high', 'medium', 'low'].includes(x.priority) && typeof x.done === 'boolean' &&
      optional(x, 'engagementId', str) && optional(x, 'sourceDeadlineText', str) && optional(x, 'dueAt', value => str(value) && Number.isFinite(Date.parse(value)));
    case 'memory': return base(x) && only(x, ['id', 'mode', 'category', 'fact', 'sourceMessageId', 'createdAt', 'importance',
      'status', 'subject', 'topic', 'pinned', 'sourceIds', 'supersedesId', 'validFrom']) && x.mode === space &&
      ['preference', 'habit', 'experience', 'person', 'business'].includes(x.category) && str(x.fact) && !!x.fact.trim() && finite(x.createdAt) &&
      finite(x.importance) && x.importance >= 0 && x.importance <= 10 && optional(x, 'sourceMessageId', str) && optional(x, 'status', status) &&
      ['subject', 'topic', 'supersedesId'].every(k => optional(x, k, str)) && optional(x, 'pinned', value => typeof value === 'boolean') &&
      optional(x, 'sourceIds', strings) && optional(x, 'validFrom', finite);
    case 'summary': return base(x) && only(x, ['id', 'mode', 'content', 'sourceIds', 'createdAt', 'status']) && x.mode === space &&
      str(x.content) && strings(x.sourceIds) && finite(x.createdAt) && status(x.status);
    case 'message': return base(x) && only(x, ['id', 'role', 'content', 'timestamp', 'attachments', 'mutations', 'artifactRef']) &&
      ['user', 'assistant', 'system'].includes(x.role) && str(x.content) && finite(x.timestamp) && optional(x, 'attachments', strings) &&
      optional(x, 'mutations', items => Array.isArray(items) && items.every(m => base(m) &&
        only(m, ['id', 'mode', 'targetCardType', 'targetCardTitle', 'summaryText', 'deltaBadge', 'timestamp']) && m.mode === space &&
        ['wallet', 'rpg_status', 'relationships', 'crm', 'projects', 'custom'].includes(m.targetCardType) &&
        ['targetCardTitle', 'summaryText', 'deltaBadge'].every(k => str(m[k])) && finite(m.timestamp))) &&
      optional(x, 'artifactRef', ref => only(ref, ['type', 'dataId']) && ['journal', 'gomoku', 'note'].includes(ref.type) && str(ref.dataId));
    case 'event': return base(x) && only(x, ['id', 'proposalId', 'mode', 'sourceMessageId', 'sourceText', 'operations', 'mutations', 'createdAt', 'revertedAt']) &&
      x.mode === space && str(x.proposalId) && str(x.sourceMessageId) && str(x.sourceText) && finite(x.createdAt) && optional(x, 'revertedAt', finite) &&
      (Array.isArray(x.mutations) !== Array.isArray(x.operations)) && eventMutations(x).every(m => validMutation(space, m)) &&
      (!x.operations || x.operations.every(op => only(op, ['target', 'entityId', 'before', 'after'])));
    case 'journal': return base(x) && only(x, ['id', 'mode', 'date', 'title', 'mood', 'userGoldenQuote', 'aiReflection', 'photoUrl', 'stickers', 'createdAt']) &&
      x.mode === space && ['date', 'title', 'mood', 'userGoldenQuote', 'aiReflection'].every(k => str(x[k])) && strings(x.stickers) &&
      finite(x.createdAt) && optional(x, 'photoUrl', str);
    case 'custom': return base(x) && only(x, ['id', 'mode', 'title', 'icon', 'metricLabel', 'metricValue', 'metricTarget', 'unit', 'checklist']) &&
      x.mode === space && ['title', 'icon', 'metricLabel', 'unit'].every(k => str(x[k])) && finite(x.metricValue) && finite(x.metricTarget) && x.metricTarget > 0 &&
      Array.isArray(x.checklist) && unique(x.checklist) && x.checklist.every(item => base(item) && only(item, ['id', 'text', 'done']) && str(item.text) && typeof item.done === 'boolean');
    case 'expense': return base(x) && only(x, ['id', 'title', 'amount', 'type', 'category', 'timestamp']) && str(x.title) && finite(x.amount) && x.amount >= 0 &&
      ['expense', 'income', 'saving'].includes(x.type) && ['餐饮☕', '购物🛍️', '出行🚕', '娱乐🎮', '生活🏠', '金库✨'].includes(x.category) && finite(x.timestamp);
    case 'wallet': return only(x, ['monthlyBudget', 'wishTitle', 'wishTarget', 'wishSaved']) &&
      ['monthlyBudget', 'wishTarget', 'wishSaved'].every(k => finite(x[k]) && x[k] >= 0) && str(x.wishTitle);
    case 'rpg': return only(x, ['energy', 'waterCups', 'weightKg', 'targetWeightKg', 'streakDays', 'moodBuff', 'dateKey', 'lastActivityDate']) &&
      ['energy', 'waterCups', 'weightKg', 'targetWeightKg', 'streakDays'].every(k => finite(x[k]) && x[k] >= 0) && x.energy <= 100 && x.waterCups <= 8 &&
      str(x.moodBuff) && optional(x, 'dateKey', str) && optional(x, 'lastActivityDate', str);
    case 'person': return base(x) && only(x, ['id', 'name', 'relation', 'taboos', 'preferences', 'nextImportantDate', 'updatedAt']) &&
      str(x.name) && str(x.relation) && strings(x.taboos) && strings(x.preferences) && optional(x, 'nextImportantDate', str) && finite(x.updatedAt);
    default: return false;
  }
}

export function validateTransaction(command, revision, getRecord) {
  const errors = [];
  if (!only(command, ['op', 'space', 'id', 'baseRevision', 'sourceMessageId', 'sourceText', 'mutations', 'event', 'redactSourceIds']) || command.op !== 'transaction' ||
      !spaces.includes(command.space) || !str(command.id) || !command.id || !Array.isArray(command.mutations) || !command.mutations.length ||
      !optional(command, 'sourceMessageId', str) || !optional(command, 'sourceText', str) || !optional(command, 'event', value => typeof value === 'boolean') ||
      !optional(command, 'redactSourceIds', strings)) return ['变更批次格式无效。'];
  if (command.redactSourceIds?.some(id => !command.mutations.some(m => m.kind === 'message' && m.id === id && m.after === null))) errors.push('原文清理必须与明确删除同批提交。');
  if (command.baseRevision !== undefined && (!Number.isInteger(command.baseRevision) || command.baseRevision !== revision)) errors.push('预览已过期，请重新核对。');
  const keys = new Set();
  const staged = new Map();
  for (const m of command.mutations) {
    if (!validMutation(command.space, m)) { errors.push('变更字段或所属空间无效。'); continue; }
    const key = `${m.kind}:${m.id}`;
    if (keys.has(key)) errors.push('同一批次包含重复目标。');
    keys.add(key);
    if (!sameValue(getRecord(m.kind, m.id) ?? null, m.before)) errors.push('记录已被修改，请重新核对。');
    staged.set(key, m.after);
  }
  for (const m of command.mutations) {
    if (!['task', 'followup'].includes(m?.kind) || !m.after?.engagementId) continue;
    const key = `engagement:${m.after.engagementId}`;
    if (!(staged.has(key) ? staged.get(key) : getRecord('engagement', m.after.engagementId))) errors.push('待办关联的合作项目不存在。');
  }
  return [...new Set(errors)];
}

// SQLite's unicode tokenizer cannot find Chinese two-character names reliably.
// Both backends index the same adjacent Han pairs, plus complete Latin/number tokens.
export function searchTerms(text) {
  const tokens = new Set();
  for (const part of String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) || []) {
    if (/^\p{Script=Han}+$/u.test(part)) {
      const chars = [...part];
      if (chars.length === 1) tokens.add(part);
      for (let i = 0; i < chars.length - 1; i++) tokens.add(chars[i] + chars[i + 1]);
    } else tokens.add(part);
  }
  return [...tokens];
}
export function recordAt(data) { return data.timestamp ?? data.confirmedAt ?? data.updatedAt ?? data.createdAt ?? 0; }
export function recordText(kind, data) {
  if (kind === 'engagement') return [data.clientName, data.title, data.budgetAmount, data.stage, data.internalContext, data.shareableSummary, data.nextAction].filter(v => v !== undefined).join(' ');
  if (kind === 'event') return [data.sourceText, data.proposalId].join(' ');
  const values = [];
  const collect = value => { if (typeof value === 'string' || typeof value === 'number') values.push(String(value)); else if (Array.isArray(value)) value.forEach(collect); };
  Object.values(data).forEach(collect);
  return values.join(' ');
}

export function flattenV3(snapshot) {
  if (!only(snapshot, ['schemaVersion', 'snapshotRevision', 'activeMode', 'settings', 'partitions']) || snapshot.schemaVersion !== 3 ||
      !Number.isInteger(snapshot.snapshotRevision) || snapshot.snapshotRevision < 0 || !spaces.includes(snapshot.activeMode) ||
      !validateSettings(snapshot.settings) || !only(snapshot.partitions, spaces)) throw new Error('旧版快照格式无效，原数据已保留。');
  const records = [], revisions = {}, processedProposalIds = {};
  const mapping = { messages: 'message', events: 'event', memories: 'memory', journals: 'journal', customCards: 'custom', engagements: 'engagement', tasks: 'task', persons: 'person' };
  for (const space of spaces) {
    const partition = snapshot.partitions[space];
    const common = ['revision', 'messages', 'events', 'memories', 'journals', 'customCards', 'processedProposalIds'];
    if (!only(partition, [...common, ...(space === 'work' ? ['engagements', 'tasks'] : ['wallet', 'rpg', 'persons'])]) ||
        !Number.isInteger(partition.revision) || partition.revision < 0 || !strings(partition.processedProposalIds)) throw new Error('旧版分区格式无效。');
    revisions[space] = partition.revision;
    processedProposalIds[space] = [...partition.processedProposalIds];
    for (const [field, kind] of Object.entries(mapping)) {
      if ((space === 'work' && field === 'persons') || (space === 'life' && ['engagements', 'tasks'].includes(field))) continue;
      const items = partition[field];
      if (!Array.isArray(items) || !items.every(item => validateRecord(space, kind, item)) || !unique(items)) throw new Error(`旧版${field}记录无效。`);
      for (const data of items) records.push({ space, kind, id: data.id, data: clone(data), at: recordAt(data) });
    }
    if (space === 'work' && partition.tasks.some(task => task.engagementId && !partition.engagements.some(item => item.id === task.engagementId))) throw new Error('待办关联项目缺失。');
    if (space === 'life') {
      const wallet = partition.wallet;
      if (!only(wallet, ['monthlyBudget', 'wishTitle', 'wishTarget', 'wishSaved', 'entries']) || !Array.isArray(wallet.entries) ||
          !wallet.entries.every(item => validateRecord(space, 'expense', item)) || !unique(wallet.entries) || !validateRecord(space, 'rpg', partition.rpg)) throw new Error('旧版生活资料无效。');
      const { entries, ...config } = wallet;
      if (!validateRecord(space, 'wallet', config)) throw new Error('旧版钱包配置无效。');
      records.push({ space, kind: 'wallet', id: 'wallet', data: clone(config), at: 0 }, { space, kind: 'rpg', id: 'rpg', data: clone(partition.rpg), at: 0 });
      for (const data of entries) records.push({ space, kind: 'expense', id: data.id, data: clone(data), at: recordAt(data) });
    }
  }
  return { records, settings: { ...DEFAULT_PUBLIC_SETTINGS, ...clone(snapshot.settings) }, mode: snapshot.activeMode, revisions, processedProposalIds };
}

function emptyPartition() { return { revision: 0, messages: [], memories: [], summaries: [], journals: [], customCards: [], events: [], processedProposalIds: [] }; }
export function makeBootstrap(meta, rows, stats) {
  const space = stats.space;
  if (!spaces.includes(space)) throw new Error('读取快照必须明确空间。');
  const snapshot = { schemaVersion: 5, snapshotRevision: meta.snapshotRevision || 0, activeMode: meta.mode || 'work',
    settings: { ...DEFAULT_PUBLIC_SETTINGS, ...meta.settings }, partitions: {
      life: { ...emptyPartition(), wallet: { monthlyBudget: 5000, wishTitle: '心愿小金库', wishTarget: 10000, wishSaved: 0, entries: [] },
        rpg: { energy: 80, waterCups: 0, weightKg: 0, targetWeightKg: 0, moodBuff: '尚未记录', streakDays: 0 }, persons: [] },
      work: { ...emptyPartition(), engagements: [], tasks: [], followUps: [], closures: [] },
    } };
  const partition = snapshot.partitions[space];
  partition.revision = meta.revisions?.[space] || 0;
  const mapping = { message: 'messages', event: 'events', memory: 'memories', summary: 'summaries', journal: 'journals', custom: 'customCards', engagement: 'engagements', task: 'tasks', person: 'persons', followup: 'followUps', closure: 'closures' };
  for (const row of [...rows].filter(row => row.space === space).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
    if (row.kind === 'wallet') partition.wallet = { ...clone(row.data), entries: partition.wallet.entries };
    else if (row.kind === 'rpg') partition.rpg = clone(row.data);
    else if (row.kind === 'expense') partition.wallet.entries.push(clone(row.data));
    else if (mapping[row.kind] && Array.isArray(partition[mapping[row.kind]])) partition[mapping[row.kind]].push(clone(row.data));
  }
  return { snapshot, stats };
}
