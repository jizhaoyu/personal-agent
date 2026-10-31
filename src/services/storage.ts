import type {
  AppSettings, PublicAppSettings, AppSnapshotV3, WorkspaceMode, WorkPartition, LifePartition,
  Message, MemoryItem, JournalArtifact, WalletCardState, RpgStatusCardState, PersonProfile,
  CrmDealItem, Engagement, ProjectTaskItem, CustomLivingCard, WorkOperation, ProposedChangeSet,
  MutationResult, StateMutationReceipt,
} from '../types';
import { shanghaiDateKey } from './dates';

export const SNAPSHOT_KEY = 'looma_app_v3';
export const DEFAULT_SETTINGS: PublicAppSettings = {
  apiBaseUrl: 'https://api.deepseek.com/v1', modelName: 'deepseek-chat', personaName: 'Looma',
  personaAvatar: '✨', personaGreeting: '把零散沟通整理成可信的下一步。',
  systemPrompt: '你是 Looma 客户跟进伴侣。整理用户提供的事实，不猜测预算、成交或承诺；变更必须由用户确认。',
  alwaysOnTop: false, modelEnabled: false, remindersEnabled: false,
};
const stages = ['初步接触', '需求确认', '方案报价', '商务谈判', '赢单成交'];
const listeners = new Set<() => void>();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const isRecord = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown) => typeof x === 'string';
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const strings = (x: unknown) => Array.isArray(x) && x.every(str);
const only = (x: Record<string, any>, keys: string[]) => Object.keys(x).every(key => keys.includes(key));
const unique = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;
const baseEntity = (x: unknown): x is Record<string, any> => isRecord(x) && str(x.id) && x.id.length > 0;
export const newId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

function publicSettings(input: unknown): PublicAppSettings {
  const result = { ...DEFAULT_SETTINGS };
  if (!isRecord(input)) return result;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof input[key] === typeof result[key]) result[key] = input[key];
  }
  return result;
}
function partitionBase() {
  return { revision: 0, messages: [], memories: [], journals: [], customCards: [], events: [], processedProposalIds: [] };
}
function emptySnapshot(): AppSnapshotV3 {
  return {
    schemaVersion: 3, snapshotRevision: 0, activeMode: 'work', settings: { ...DEFAULT_SETTINGS },
    partitions: {
      life: { ...partitionBase(), wallet: { monthlyBudget: 5000, wishTitle: '心愿小金库', wishTarget: 10000, wishSaved: 0, entries: [] },
        rpg: { energy: 80, waterCups: 0, weightKg: 0, targetWeightKg: 0, moodBuff: '尚未记录', streakDays: 0, dateKey: shanghaiDateKey() }, persons: [] },
      work: { ...partitionBase(), engagements: [], tasks: [] },
    },
  };
}

function validEngagement(x: unknown): x is Engagement {
  return baseEntity(x) && only(x, ['id', 'clientName', 'title', 'budgetAmount', 'stage', 'internalContext', 'shareableSummary', 'nextAction', 'updatedAt']) &&
    str(x.clientName) && !!x.clientName.trim() && str(x.title) && !!x.title.trim() &&
    (x.budgetAmount === undefined || (num(x.budgetAmount) && x.budgetAmount >= 0)) && stages.includes(x.stage) &&
    str(x.internalContext) && str(x.shareableSummary) && str(x.nextAction) && num(x.updatedAt);
}
function validTask(x: unknown): x is ProjectTaskItem {
  return baseEntity(x) && only(x, ['id', 'title', 'assignee', 'deadline', 'priority', 'done', 'engagementId', 'dueAt', 'sourceDeadlineText']) &&
    str(x.title) && !!x.title.trim() && str(x.assignee) && str(x.deadline) && ['high', 'medium', 'low'].includes(x.priority) && typeof x.done === 'boolean' &&
    (x.engagementId === undefined || str(x.engagementId)) && (x.sourceDeadlineText === undefined || str(x.sourceDeadlineText)) &&
    (x.dueAt === undefined || (str(x.dueAt) && Number.isFinite(Date.parse(x.dueAt))));
}
function validMemory(x: unknown, mode: WorkspaceMode): x is MemoryItem {
  return baseEntity(x) && only(x, ['id', 'mode', 'category', 'fact', 'sourceMessageId', 'createdAt', 'importance']) && x.mode === mode &&
    ['preference', 'habit', 'experience', 'person', 'business'].includes(x.category) && str(x.fact) && num(x.createdAt) && num(x.importance) &&
    x.importance >= 0 && x.importance <= 10 && (x.sourceMessageId === undefined || str(x.sourceMessageId));
}
function validOperation(x: any, mode: WorkspaceMode): x is WorkOperation {
  if (!isRecord(x) || !only(x, ['target', 'entityId', 'before', 'after']) || !str(x.entityId) || !x.entityId ||
      !('before' in x) || !('after' in x) || (x.before === null && x.after === null)) return false;
  const validate = x.target === 'engagement' && mode === 'work' ? validEngagement : x.target === 'task' && mode === 'work' ? validTask :
    x.target === 'memory' ? (item: unknown) => validMemory(item, mode) : null;
  return !!validate && [x.before, x.after].every(item => item === null || (validate(item) && item.id === x.entityId));
}
function validMessage(x: any, mode: WorkspaceMode) {
  return baseEntity(x) && only(x, ['id', 'role', 'content', 'timestamp', 'attachments', 'mutations', 'artifactRef']) &&
    ['user', 'assistant', 'system'].includes(x.role) && str(x.content) && num(x.timestamp) &&
    (x.attachments === undefined || strings(x.attachments)) && (x.mutations === undefined || (Array.isArray(x.mutations) && x.mutations.every(m =>
      baseEntity(m) && m.mode === mode && ['wallet', 'rpg_status', 'relationships', 'crm', 'projects', 'custom'].includes(m.targetCardType) &&
      str(m.targetCardTitle) && str(m.summaryText) && str(m.deltaBadge) && num(m.timestamp)))) &&
    (x.artifactRef === undefined || (isRecord(x.artifactRef) && ['journal', 'gomoku', 'note'].includes(x.artifactRef.type) && str(x.artifactRef.dataId)));
}
function validJournal(x: any, mode: WorkspaceMode) {
  return baseEntity(x) && only(x, ['id', 'mode', 'date', 'title', 'mood', 'userGoldenQuote', 'aiReflection', 'photoUrl', 'stickers', 'createdAt']) &&
    x.mode === mode && ['date', 'title', 'mood', 'userGoldenQuote', 'aiReflection'].every(key => str(x[key])) &&
    strings(x.stickers) && num(x.createdAt) && (x.photoUrl === undefined || str(x.photoUrl));
}
function validCard(x: any, mode: WorkspaceMode) {
  return baseEntity(x) && only(x, ['id', 'mode', 'title', 'icon', 'metricLabel', 'metricValue', 'metricTarget', 'unit', 'checklist']) && x.mode === mode &&
    ['title', 'icon', 'metricLabel', 'unit'].every(key => str(x[key])) && num(x.metricValue) && num(x.metricTarget) && x.metricTarget > 0 &&
    Array.isArray(x.checklist) && unique(x.checklist) && x.checklist.every(item => baseEntity(item) && only(item, ['id', 'text', 'done']) && str(item.text) && typeof item.done === 'boolean');
}
function validPartition(x: any, mode: WorkspaceMode) {
  const common = ['revision', 'messages', 'memories', 'journals', 'customCards', 'events', 'processedProposalIds'];
  if (!isRecord(x) || !only(x, [...common, ...(mode === 'work' ? ['engagements', 'tasks'] : ['wallet', 'rpg', 'persons'])]) ||
      !Number.isInteger(x.revision) || x.revision < 0 || !common.slice(1).every(key => Array.isArray(x[key])) || !strings(x.processedProposalIds)) return false;
  if (!x.messages.every(m => validMessage(m, mode)) || !unique(x.messages) || !x.memories.every(m => validMemory(m, mode)) || !unique(x.memories) ||
      !x.journals.every(j => validJournal(j, mode)) || !unique(x.journals) || !x.customCards.every(c => validCard(c, mode)) || !unique(x.customCards)) return false;
  if (!x.events.every(e => baseEntity(e) && only(e, ['id', 'proposalId', 'mode', 'sourceMessageId', 'sourceText', 'operations', 'createdAt', 'revertedAt']) &&
      e.mode === mode && str(e.proposalId) && str(e.sourceMessageId) && str(e.sourceText) && num(e.createdAt) &&
      (e.revertedAt === undefined || num(e.revertedAt)) && Array.isArray(e.operations) && e.operations.every(op => validOperation(op, mode))) || !unique(x.events)) return false;
  if (mode === 'work') return Array.isArray(x.engagements) && x.engagements.every(validEngagement) && unique(x.engagements) &&
    Array.isArray(x.tasks) && x.tasks.every(validTask) && unique(x.tasks) && x.tasks.every(t => !t.engagementId || x.engagements.some(e => e.id === t.engagementId));
  const wallet = x.wallet, rpg = x.rpg;
  return isRecord(wallet) && only(wallet, ['monthlyBudget', 'wishTitle', 'wishTarget', 'wishSaved', 'entries']) &&
    num(wallet.monthlyBudget) && wallet.monthlyBudget >= 0 && num(wallet.wishTarget) && wallet.wishTarget >= 0 && num(wallet.wishSaved) && wallet.wishSaved >= 0 && str(wallet.wishTitle) &&
    Array.isArray(wallet.entries) && unique(wallet.entries) && wallet.entries.every(e => baseEntity(e) && only(e, ['id', 'title', 'amount', 'type', 'category', 'timestamp']) &&
      str(e.title) && num(e.amount) && e.amount >= 0 && ['expense', 'income', 'saving'].includes(e.type) &&
      ['餐饮☕', '购物🛍️', '出行🚕', '娱乐🎮', '生活🏠', '金库✨'].includes(e.category) && num(e.timestamp)) &&
    isRecord(rpg) && only(rpg, ['energy', 'waterCups', 'weightKg', 'targetWeightKg', 'streakDays', 'moodBuff', 'dateKey', 'lastActivityDate']) &&
    ['energy', 'waterCups', 'weightKg', 'targetWeightKg', 'streakDays'].every(key => num(rpg[key]) && rpg[key] >= 0) && rpg.energy <= 100 && rpg.waterCups <= 8 && str(rpg.moodBuff) &&
    (rpg.dateKey === undefined || str(rpg.dateKey)) && (rpg.lastActivityDate === undefined || str(rpg.lastActivityDate)) &&
    Array.isArray(x.persons) && unique(x.persons) && x.persons.every(p => baseEntity(p) &&
      only(p, ['id', 'name', 'relation', 'taboos', 'preferences', 'nextImportantDate', 'updatedAt']) && str(p.name) && str(p.relation) && strings(p.taboos) && strings(p.preferences) &&
      (p.nextImportantDate === undefined || str(p.nextImportantDate)) && num(p.updatedAt));
}
export function validateSnapshot(x: unknown): x is AppSnapshotV3 {
  return isRecord(x) && only(x, ['schemaVersion', 'snapshotRevision', 'activeMode', 'settings', 'partitions']) && x.schemaVersion === 3 &&
    Number.isInteger(x.snapshotRevision) && x.snapshotRevision >= 0 && ['life', 'work'].includes(x.activeMode) &&
    isRecord(x.settings) && only(x.settings, Object.keys(DEFAULT_SETTINGS)) && Object.keys(DEFAULT_SETTINGS).every(key => typeof x.settings[key] === typeof DEFAULT_SETTINGS[key]) &&
    isRecord(x.partitions) && only(x.partitions, ['life', 'work']) && validPartition(x.partitions.life, 'life') && validPartition(x.partitions.work, 'work');
}

function legacyValue(key: string, fallback: any) {
  const raw = localStorage.getItem(key);
  if (raw === null) return copy(fallback);
  try { return JSON.parse(raw); } catch { throw new Error(`旧数据 ${key} 格式损坏，原数据已保留，请先备份恢复。`); }
}
function migratedEngagement(item: CrmDealItem): Engagement {
  return { id: item.id, clientName: item.clientName, title: `${item.clientName}的合作项目`, budgetAmount: item.budgetAmount,
    stage: item.stage, internalContext: [item.painPoints, item.internalBottomLine].filter(Boolean).join('\n'), shareableSummary: '',
    nextAction: item.nextAction || '', updatedAt: item.updatedAt };
}
function fromLegacy(data?: any): AppSnapshotV3 {
  if (data && (!isRecord(data.settings) || !isRecord(data.lifeVault) || !isRecord(data.workVault))) {
    throw new Error('旧版备份缺少完整的设置与双空间数据，未导入。');
  }
  const snapshot = emptySnapshot();
  const life = snapshot.partitions.life, work = snapshot.partitions.work;
  const lifeData = data?.lifeVault;
  const workData = data?.workVault;
  snapshot.settings = publicSettings(data ? data.settings : legacyValue('looma_settings', {}));
  snapshot.activeMode = data ? 'work' : (localStorage.getItem('looma_workspace_mode') === 'life' ? 'life' : 'work');
  for (const mode of ['life', 'work'] as WorkspaceMode[]) {
    const partition = snapshot.partitions[mode];
    const legacy = mode === 'life' ? lifeData : workData;
    partition.messages = (data ? legacy?.messages || [] : legacyValue(`looma_${mode}_messages`, [])).map(message => ({
      ...message, ...(Array.isArray(message.mutations) ? { mutations: message.mutations.filter(receipt => receipt.mode === mode) } : {}),
    }));
    partition.memories = (data ? legacy?.memories || [] : legacyValue(`looma_${mode}_memories`, [])).map(item => ({ ...item, mode }));
  }
  life.wallet = data ? lifeData?.wallet || life.wallet : legacyValue('looma_life_wallet', life.wallet);
  life.rpg = data ? lifeData?.rpg || life.rpg : legacyValue('looma_life_rpg', life.rpg);
  life.persons = data ? lifeData?.persons || [] : legacyValue('looma_life_persons', []);
  work.engagements = (data ? workData?.crmDeals || [] : legacyValue('looma_work_crm', [])).map(migratedEngagement);
  work.tasks = data ? workData?.projectTasks || [] : legacyValue('looma_work_projects', []);
  const cards = data ? data.customCards || [] : legacyValue('looma_custom_cards', []);
  const journals = data ? data.journals || [] : legacyValue('looma_journals', []);
  for (const mode of ['life', 'work'] as WorkspaceMode[]) {
    snapshot.partitions[mode].customCards = cards.filter(item => (item.mode || 'life') === mode).map(item => ({ ...item, mode }));
    snapshot.partitions[mode].journals = journals.filter(item => (item.mode || 'life') === mode).map(item => ({ ...item, mode }));
  }
  if (!validateSnapshot(snapshot)) throw new Error('旧数据未通过完整校验，原数据已保留。');
  return snapshot;
}
function emit() { for (const listener of listeners) { try { listener(); } catch { /* UI listeners cannot change persistence outcome. */ } } }
function persist(snapshot: AppSnapshotV3) {
  if (!validateSnapshot(snapshot)) throw new Error('数据校验失败，未保存任何更改。');
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  emit();
}
function updatePartition(mode: WorkspaceMode, update: (partition: any) => void, bumpRevision = false) {
  if (mode !== 'life' && mode !== 'work') throw new Error('必须明确指定生活或工作空间。');
  const snapshot = StorageService.getSnapshot();
  update(snapshot.partitions[mode]);
  if (bumpRevision) snapshot.partitions[mode].revision++;
  snapshot.snapshotRevision++;
  persist(snapshot);
}
function collection(partition: any, target: string): any[] {
  return partition[target === 'engagement' ? 'engagements' : target === 'task' ? 'tasks' : 'memories'];
}
function applyOperation(partition: any, operation: WorkOperation, reverse = false) {
  const list = collection(partition, operation.target);
  const index = list.findIndex(item => item.id === operation.entityId);
  const value = reverse ? operation.before : operation.after;
  if (value === null) { if (index >= 0) list.splice(index, 1); }
  else if (index >= 0) list[index] = copy(value);
  else list.push(copy(value));
}
export function validateProposal(proposal: ProposedChangeSet, partition: WorkPartition | LifePartition): string[] {
  const errors: string[] = [];
  if (!isRecord(proposal) || !['life', 'work'].includes(proposal.mode) || !str(proposal.id) || !str(proposal.sourceMessageId) || !str(proposal.sourceText) ||
      !Array.isArray(proposal.operations) || !strings(proposal.warnings) || !num(proposal.createdAt)) return ['变更格式无效。'];
  if (proposal.baseRevision !== partition.revision) errors.push('预览已过期，请重新整理后确认。');
  if (!proposal.operations.length) errors.push('没有可提交的变更。');
  const targets = new Set<string>();
  for (const operation of proposal.operations) {
    if (!validOperation(operation, proposal.mode)) { errors.push('变更字段或空间无效。'); continue; }
    const key = `${operation.target}:${operation.entityId}`;
    if (targets.has(key)) errors.push('同一批次包含重复实体，请先合并变更。');
    targets.add(key);
    const existing = collection(partition, operation.target).find(item => item.id === operation.entityId) || null;
    if (JSON.stringify(existing) !== JSON.stringify(operation.before)) errors.push('记录已变化，请刷新预览。');
  }
  return [...new Set(errors)];
}

export const StorageService = {
  getSnapshot(): AppSnapshotV3 {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (raw !== null) {
      let snapshot: any;
      try { snapshot = JSON.parse(raw); } catch { throw new Error('本地快照损坏，原数据未覆盖，请从备份恢复。'); }
      if (!validateSnapshot(snapshot)) throw new Error('本地快照未通过校验，原数据未覆盖。');
      return snapshot;
    }
    const snapshot = fromLegacy();
    persist(snapshot);
    return copy(snapshot);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getWorkspaceMode(): WorkspaceMode { return this.getSnapshot().activeMode; },
  saveWorkspaceMode(mode: WorkspaceMode): void {
    if (!['life', 'work'].includes(mode)) throw new Error('空间无效。');
    const snapshot = this.getSnapshot(); snapshot.activeMode = mode; snapshot.snapshotRevision++; persist(snapshot);
  },
  getSettings(): PublicAppSettings { return this.getSnapshot().settings; },
  saveSettings(settings: AppSettings): void { const snapshot = this.getSnapshot(); snapshot.settings = publicSettings(settings); snapshot.snapshotRevision++; persist(snapshot); },
  getMessages(mode: WorkspaceMode): Message[] { if (!mode) throw new Error('必须指定空间。'); return this.getSnapshot().partitions[mode].messages; },
  saveMessages(messages: Message[], mode: WorkspaceMode): void { updatePartition(mode, p => { p.messages = messages.slice(-200); }); },
  getMemories(mode: WorkspaceMode): MemoryItem[] { if (!mode) throw new Error('必须指定空间。'); return this.getSnapshot().partitions[mode].memories; },
  saveMemories(memories: MemoryItem[], mode: WorkspaceMode): void {
    const normalized = memories.map(item => ({ ...item, mode }));
    if (mode === 'work') {
      const before = this.getMemories(mode);
      const operations: WorkOperation[] = [];
      for (const item of normalized) if (JSON.stringify(before.find(x => x.id === item.id)) !== JSON.stringify(item)) {
        operations.push({ target: 'memory', entityId: item.id, before: before.find(x => x.id === item.id) || null, after: item });
      }
      for (const item of before) if (!normalized.some(x => x.id === item.id)) operations.push({ target: 'memory', entityId: item.id, before: item, after: null });
      if (operations.length) { const result = this.commit(this.createProposal(mode, operations, '用户手动确认记忆编辑')); if (!result.ok) throw new Error(result.error); }
    } else updatePartition(mode, p => { p.memories = normalized; }, true);
  },
  addMemory(fact: string, category: MemoryItem['category'], mode: WorkspaceMode): MemoryItem {
    if (!mode) throw new Error('必须指定空间。');
    const item: MemoryItem = { id: newId('memory'), mode, category, fact, createdAt: Date.now(), importance: 3 };
    this.saveMemories([...this.getMemories(mode), item], mode); return item;
  },
  deleteMemory(id: string, mode: WorkspaceMode): void { this.saveMemories(this.getMemories(mode).filter(item => item.id !== id), mode); },
  getWalletCard(): WalletCardState { return this.getSnapshot().partitions.life.wallet; },
  saveWalletCard(wallet: WalletCardState): void { updatePartition('life', p => { p.wallet = wallet; }, true); },
  getRpgStatusCard(): RpgStatusCardState {
    const rpg = this.getSnapshot().partitions.life.rpg;
    return rpg.dateKey !== shanghaiDateKey() ? { ...rpg, waterCups: 0, dateKey: shanghaiDateKey() } : rpg;
  },
  saveRpgStatusCard(rpg: RpgStatusCardState): void { updatePartition('life', p => { p.rpg = { ...rpg, dateKey: shanghaiDateKey() }; }, true); },
  updateLifeAtomically(update: (life: LifePartition) => StateMutationReceipt[], sourceMessageId?: string): StateMutationReceipt[] {
    const snapshot = this.getSnapshot();
    const life = snapshot.partitions.life;
    const processedId = sourceMessageId ? `life:${sourceMessageId}` : undefined;
    if (processedId && life.processedProposalIds.includes(processedId)) return [];
    const receipts = update(life);
    if (!receipts.length) return [];
    if (processedId) life.processedProposalIds = [...life.processedProposalIds, processedId].slice(-500);
    life.revision++; snapshot.snapshotRevision++;
    persist(snapshot);
    return receipts;
  },
  getPersonProfiles(): PersonProfile[] { return this.getSnapshot().partitions.life.persons; },
  savePersonProfiles(persons: PersonProfile[]): void { updatePartition('life', p => { p.persons = persons; }, true); },
  getCrmDeals(): CrmDealItem[] {
    return this.getSnapshot().partitions.work.engagements.map(e => ({ id: e.id, clientName: e.clientName, budgetAmount: e.budgetAmount,
      stage: e.stage, winProbability: 0, painPoints: e.internalContext, internalBottomLine: e.internalContext, nextAction: e.nextAction, updatedAt: e.updatedAt }));
  },
  saveCrmDeals(deals: CrmDealItem[]): void {
    const current = this.getSnapshot().partitions.work.engagements;
    const operations: WorkOperation[] = deals.map(deal => {
      const before = current.find(item => item.id === deal.id) || null;
      return { target: 'engagement', entityId: deal.id, before, after: { ...migratedEngagement(deal), title: before?.title || `${deal.clientName}的合作项目`, shareableSummary: before?.shareableSummary || '' } };
    });
    for (const before of current) if (!deals.some(item => item.id === before.id)) operations.push({ target: 'engagement', entityId: before.id, before, after: null });
    if (!operations.length) return;
    const result = this.commit(this.createProposal('work', operations, '用户手动确认项目编辑')); if (!result.ok) throw new Error(result.error);
  },
  getProjectTasks(): ProjectTaskItem[] { return this.getSnapshot().partitions.work.tasks; },
  saveProjectTasks(tasks: ProjectTaskItem[]): void {
    const before = this.getProjectTasks();
    const operations: WorkOperation[] = [];
    for (const after of tasks) if (JSON.stringify(before.find(item => item.id === after.id)) !== JSON.stringify(after)) operations.push({ target: 'task', entityId: after.id, before: before.find(item => item.id === after.id) || null, after });
    for (const item of before) if (!tasks.some(after => after.id === item.id)) operations.push({ target: 'task', entityId: item.id, before: item, after: null });
    if (operations.length) { const result = this.commit(this.createProposal('work', operations, '用户手动确认待办编辑')); if (!result.ok) throw new Error(result.error); }
  },
  getCustomCards(mode: WorkspaceMode): CustomLivingCard[] { if (!mode) throw new Error('必须指定空间。'); return this.getSnapshot().partitions[mode].customCards; },
  saveCustomCards(cards: CustomLivingCard[], mode: WorkspaceMode): void { updatePartition(mode, p => { p.customCards = cards.map(item => ({ ...item, mode })); }, true); },
  recordWorkIntensityBridge(): void { /* Deliberately disabled: work must never mutate the life partition. */ },
  getJournals(mode: WorkspaceMode): JournalArtifact[] { if (!mode) throw new Error('必须指定空间。'); return this.getSnapshot().partitions[mode].journals; },
  saveJournals(journals: JournalArtifact[], mode: WorkspaceMode): void { updatePartition(mode, p => { p.journals = journals.map(item => ({ ...item, mode })); }); },
  addJournal(journal: JournalArtifact, mode: WorkspaceMode): void { this.saveJournals([journal, ...this.getJournals(mode)], mode); },
  createProposal(mode: WorkspaceMode, operations: WorkOperation[], sourceText: string, sourceMessageId = newId('manual')): ProposedChangeSet {
    return { id: newId('proposal'), mode, sourceMessageId, sourceText, baseRevision: this.getSnapshot().partitions[mode].revision,
      operations: copy(operations), warnings: [], createdAt: Date.now() };
  },
  commit(proposal: ProposedChangeSet): MutationResult {
    try {
      const snapshot = this.getSnapshot();
      if (!proposal || !['life', 'work'].includes(proposal.mode)) return { ok: false, error: '变更空间无效。' };
      const partition = snapshot.partitions[proposal.mode];
      if (partition.processedProposalIds.includes(proposal.id)) return { ok: true, receipts: [] };
      const errors = validateProposal(proposal, partition);
      if (errors.length) return { ok: false, error: errors.join(' ') };
      for (const operation of proposal.operations) applyOperation(partition, operation);
      partition.revision++;
      partition.processedProposalIds = [...partition.processedProposalIds, proposal.id].slice(-500);
      partition.events = [...partition.events, { id: newId('event'), proposalId: proposal.id, mode: proposal.mode,
        sourceMessageId: proposal.sourceMessageId, sourceText: proposal.sourceText, operations: copy(proposal.operations), createdAt: Date.now() }].slice(-500);
      snapshot.snapshotRevision++;
      persist(snapshot);
      const receipts: StateMutationReceipt[] = proposal.operations.map((op, index) => ({ id: `${proposal.id}-${index}`, mode: proposal.mode,
        targetCardType: op.target === 'engagement' ? 'crm' : op.target === 'task' ? 'projects' : 'custom', targetCardTitle: op.target === 'engagement' ? '客户合作项目' : op.target === 'task' ? '行动待办' : '工作记忆',
        summaryText: `${op.after ? '已确认保存' : '已确认移除'}：${op.after ? (op.target === 'engagement' ? (op.after as Engagement).clientName : op.target === 'task' ? (op.after as ProjectTaskItem).title : (op.after as MemoryItem).fact) : op.entityId}`,
        deltaBadge: '已确认', timestamp: Date.now() }));
      return { ok: true, receipts };
    } catch { return { ok: false, error: '未能保存，原数据未改变。请检查本地存储空间或备份后重试。' }; }
  },
  undo(mode: WorkspaceMode): MutationResult {
    try {
      const snapshot = this.getSnapshot();
      const partition = snapshot.partitions[mode];
      const event = [...partition.events].reverse().find(item => !item.revertedAt);
      if (!event) return { ok: false, error: '没有可撤销的最近变更。' };
      for (const operation of event.operations) {
        const current = collection(partition, operation.target).find(item => item.id === operation.entityId) || null;
        if (JSON.stringify(current) !== JSON.stringify(operation.after)) return { ok: false, error: '相关记录已被后续更改，请先处理最新变更。' };
      }
      for (const operation of [...event.operations].reverse()) applyOperation(partition, operation, true);
      event.revertedAt = Date.now(); partition.revision++; snapshot.snapshotRevision++; persist(snapshot);
      return { ok: true };
    } catch { return { ok: false, error: '撤销未保存，原数据未改变。' }; }
  },
  exportAllData(): string { return JSON.stringify(this.getSnapshot(), null, 2); },
  importAllData(json: string): boolean {
    try {
      const parsed = JSON.parse(json);
      const incoming = parsed?.version === '2.0-looma-dual-vault' ? fromLegacy(parsed) : parsed;
      if (!validateSnapshot(incoming)) return false;
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      let previous: AppSnapshotV3 | null = null;
      try { const candidate = raw && JSON.parse(raw); if (validateSnapshot(candidate)) previous = candidate; } catch { /* a valid backup may replace a corrupt snapshot */ }
      incoming.snapshotRevision = Math.max(incoming.snapshotRevision, previous?.snapshotRevision || 0) + 1;
      for (const mode of ['life', 'work'] as WorkspaceMode[]) incoming.partitions[mode].revision = Math.max(incoming.partitions[mode].revision, previous?.partitions[mode].revision || 0) + 1;
      persist(incoming); return true;
    } catch { return false; }
  },
};
