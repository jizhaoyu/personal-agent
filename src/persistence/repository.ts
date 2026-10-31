import type {
  AppSnapshotV3, WorkspaceMode, PublicAppSettings, AppSettings, Message, MemoryItem, JournalArtifact,
  WalletCardState, RpgStatusCardState, PersonProfile, CrmDealItem, ProjectTaskItem, CustomLivingCard,
  ProposedChangeSet, WorkOperation, MutationResult, StateMutationReceipt, WorkPartition, LifePartition,
  CaptureDraft, CaptureCommitResult, ClosureRecord, FollowUpItem, WorkHome,
} from '../types';
import { StorageService, SNAPSHOT_KEY, newId } from '../services/storage';
import { shanghaiDateKey } from '../services/dates';
import { extractClientNames } from '../services/stateEngine';
import { createIndexedDbBackend } from './indexedDb';
import type { PersistenceBackend, RecordKind } from './indexedDb';
import { DEFAULT_PUBLIC_SETTINGS, makeBootstrap, sameValue, searchTerms, flattenV3 } from '../../shared/persistence-core.mjs';

export type AppSnapshotV5 = Omit<AppSnapshotV3, 'schemaVersion'> & { schemaVersion: 5 };
/** Source compatibility for the v4 UI adapters; persisted/current snapshots are v5. */
export type AppSnapshotV4 = AppSnapshotV5;
export interface Bootstrap { snapshot: AppSnapshotV5; stats: any }
export interface QueryOptions { limit?: number; cursor?: string; query?: string; ids?: string[]; names?: string[]; relatedId?: string; dueOnly?: boolean }
export interface QueryPage<T = any> { items: T[]; nextCursor?: string | null; total?: number }
export interface RecordMutation { kind: RecordKind; id: string; before: any | null; after: any | null }
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const emptyCurrent = (): AppSnapshotV4 => makeBootstrap({ settings: DEFAULT_PUBLIC_SETTINGS, mode: 'work', revisions: { life: 0, work: 0 } }, [], { space: 'work' }).snapshot;
const onlyPublicSettings = (settings: AppSettings) => Object.fromEntries(Object.keys(DEFAULT_PUBLIC_SETTINGS).filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));

/** The production API returns bounded windows. Full archives are only traversed by explicit backup / maintenance flows. */
export function createRepository(backend: PersistenceBackend, readLegacy = () => StorageService.getSnapshot()) {
  let current = emptyCurrent();
  let initialized: Promise<Bootstrap> | undefined;
  let stats: any = {};
  let active: WorkspaceMode = 'work';
  const partitionRefreshSequence = { life: 0, work: 0 };
  let metadataRequestSequence = 0;
  let acceptedMetadataSequence = 0;
  let dataEpoch = 0;
  let restoreWarning: string | undefined;
  const captures = new Map<string, { signature: string; intent: string; command: any; promise?: Promise<CaptureCommitResult>; uncertain?: boolean; completed?: boolean }>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) { try { listener(); } catch { /* UI cannot invalidate a committed write. */ } } };
  const restoredMessage = '工作区已从备份恢复，请按恢复后的资料重新核对这次操作。';
  const restoredReadWarning = '业务资料已从备份恢复，视图暂未读取成功。请重新读取或重开应用，勿重复导入。';
  const retiredCapture = (): CaptureCommitResult => ({ outcome: 'rejected', error: restoredMessage });
  function invalidateAfterRestore() {
    dataEpoch++; captures.clear();
    partitionRefreshSequence.life++; partitionRefreshSequence.work++;
    initialized = undefined; current = emptyCurrent(); stats = {};
  }
  const api = {
    async initialize(): Promise<Bootstrap> {
      if (!initialized) { const epoch = dataEpoch; initialized = (async () => {
        const state = await backend.request({ op: 'init' });
        if (epoch !== dataEpoch) return api.initialize();
        if (state?.ok === false) throw new Error(state.error || '本地资料初始化失败，原数据保留。');
        active = state.mode || 'work';
        if (!state.ready) {
          const snapshot = readLegacy();
          // This fingerprint is an idempotency label, not a security checksum. No original source is removed.
          const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SNAPSHOT_KEY) || JSON.stringify(snapshot) : JSON.stringify(snapshot);
          let fingerprint = 2166136261;
          for (let index = 0; index < raw.length; index++) fingerprint = Math.imul(fingerprint ^ raw.charCodeAt(index), 16777619);
          const result = await backend.request({ op: 'migrate', snapshot, fingerprint: `v3-${(fingerprint >>> 0).toString(16)}-${raw.length}` });
          if (epoch !== dataEpoch) return api.initialize();
          if (!result.ok) throw new Error(result.error || '本地迁移未完成，旧快照保留。');
          active = snapshot.activeMode;
        }
        return api.refresh(active, true);
      })().catch(error => { if (epoch === dataEpoch) initialized = undefined; throw error; }); }
      return initialized;
    },
    getCurrent(): AppSnapshotV4 { return current; },
    getStats() { return stats; },
    getRestoreWarning() { return restoreWarning; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async refresh(space: WorkspaceMode = active, initializing = false): Promise<Bootstrap> {
      if (!initializing && !initialized) await api.initialize();
      const sequence = ++partitionRefreshSequence[space];
      const metadataSequence = ++metadataRequestSequence;
      const epoch = dataEpoch;
      const result: Bootstrap = await backend.request({ op: 'bootstrap', space });
      if (epoch !== dataEpoch) return { snapshot: current, stats };
      if ((result as any)?.ok === false || !result?.snapshot) throw new Error((result as any)?.error || '本地资料读取失败，原数据保留。');
      // A response owns the requested partition only. It never switches the visible workspace.
      if (sequence === partitionRefreshSequence[space]) {
        restoreWarning = undefined;
        const metadata = metadataSequence >= acceptedMetadataSequence ? result.snapshot : current;
        if (metadataSequence >= acceptedMetadataSequence) acceptedMetadataSequence = metadataSequence;
        current = { ...metadata, activeMode: active, partitions: { ...current.partitions, [space]: result.snapshot.partitions[space] } };
        if (space === active) stats = result.stats;
        emit();
      }
      return { snapshot: current, stats: result.stats };
    },
    async getSnapshot(): Promise<AppSnapshotV4> { await api.initialize(); return current; },
    async reloadAfterRestore(): Promise<Bootstrap> {
      restoreWarning = undefined; invalidateAfterRestore();
      try { return await api.initialize(); }
      catch (error) { restoreWarning = restoredReadWarning; throw error; }
    },
    async request(command: any): Promise<any> {
      const epoch = dataEpoch;
      await api.initialize(); if (epoch !== dataEpoch) return { ok: false, error: restoredMessage };
      const result = await backend.request(command);
      if (epoch !== dataEpoch) return { ok: false, error: restoredMessage };
      if (command.op === 'restore' && result?.ok === true) invalidateAfterRestore();
      if (result?.ok !== false && ['transaction', 'undo', 'restore', 'migrate', 'settings', 'mode'].includes(command.op)) {
        try { await api.refresh(command.space || active); }
        catch (error) {
          if (result?.ok === true) return { ...result, refreshWarning: '写入已成功，但视图尚未刷新，请重试读取。' };
          throw error;
        }
      }
      return result;
    },
    async query<T = any>(space: WorkspaceMode, kind: RecordKind, options: QueryOptions = {}): Promise<QueryPage<T>> {
      await api.initialize(); const result = await backend.request({ op: 'list', space, kind, ...options });
      if (result?.ok === false) throw new Error(result.error || '查询失败。'); return result;
    },
    async get<T = any>(space: WorkspaceMode, kind: RecordKind, id: string): Promise<T | null> { await api.initialize(); const result = await backend.request({ op: 'get', space, kind, id });
      if (result?.ok === false) throw new Error(result.error || '读取失败。'); return result; },
    async transaction(space: WorkspaceMode, mutations: RecordMutation[], options: { id?: string; baseRevision?: number; sourceMessageId?: string; sourceText?: string; event?: boolean; redactSourceIds?: string[] } = {}): Promise<MutationResult> {
      if (!mutations.length) return { ok: true, receipts: [] };
      return api.request({ op: 'transaction', space, id: options.id || newId('batch'), ...options, mutations });
    },
    async upsert(space: WorkspaceMode, kind: RecordKind, values: any[], event = false): Promise<void> {
      const mutations: RecordMutation[] = [];
      for (const after of values) {
        const id = ['wallet', 'rpg'].includes(kind) ? kind : after.id;
        const before = await api.get(space, kind, id);
        if (!sameValue(before, after)) mutations.push({ kind, id, before, after });
      }
      const result = await api.transaction(space, mutations, { event, sourceText: '用户确认编辑' });
      if (!result.ok) throw new Error(result.error || '保存失败，原数据保留。');
    },
    async getCaptureDraft(): Promise<CaptureDraft | null> { return api.get('work', 'capture_draft', 'active-work'); },
    async saveCaptureDraft(draft: CaptureDraft): Promise<void> {
      const epoch = dataEpoch;
      await api.initialize(); if (epoch !== dataEpoch) throw new Error(restoredMessage);
      const result = await backend.request({ op: 'saveDraft', space: 'work', draft: copy(draft) });
      if (epoch !== dataEpoch) throw new Error(restoredMessage);
      if (!result?.ok) throw new Error(result?.error || '草稿未保存，请保留输入后重试。');
    },
    async getWorkHome(now = Date.now()): Promise<WorkHome> {
      await api.initialize(); const result = await backend.request({ op: 'workHome', space: 'work', now, limit: 3 });
      if (result?.ok === false) throw new Error(result.error || '暂时无法读取工作接续。'); return result;
    },
    async commitCapture(draft: CaptureDraft, originalOnly = false): Promise<CaptureCommitResult> {
      const epoch = dataEpoch;
      if (draft.conflicts?.length) return { outcome: 'rejected', error: '请先核对发生冲突的字段。' };
      try { await api.initialize(); } catch { return { outcome: 'rejected', error: '工作区暂时无法读取，草稿仍保留。' }; }
      if (epoch !== dataEpoch) return retiredCapture();
      let proposal: ProposedChangeSet = draft.proposal ? copy(draft.proposal) : {
        id: `proposal-${draft.sourceMessageId}`, mode: 'work', sourceMessageId: draft.sourceMessageId, sourceText: draft.text,
        baseRevision: current.partitions.work.revision, operations: [], warnings: [], createdAt: draft.updatedAt,
      };
      if (originalOnly) { proposal.operations = []; delete proposal.clarification; }
      if (!draft.text.trim()) return { outcome: 'rejected', error: '请先留下需要保存的原文。' };
      const signature = JSON.stringify({ draftSessionId: draft.sessionId, proposal, originalOnly });
      const intent = JSON.stringify({ draftSessionId: draft.sessionId, sourceMessageId: proposal.sourceMessageId, text: proposal.sourceText, operations: proposal.operations, originalOnly });
      let entry = captures.get(proposal.id);
      if (entry?.completed && entry.signature !== signature) return { outcome: 'rejected', error: '这次记录已经保存，请开始新记录后再修改。' };
      if (entry?.uncertain && entry.intent !== intent) return { outcome: 'unknown', error: '上一份记录的保存结果尚未确认，请先核查，不能覆盖它的输入。' };
      if (!entry || (entry.signature !== signature && !entry.uncertain)) {
        entry = { signature, intent, command: { op: 'commitCapture', space: 'work', draftSessionId: draft.sessionId, proposal, confirmedAt: Date.now(), ...(originalOnly ? { originalOnly: true } : {}) } };
        captures.set(proposal.id, entry);
      }
      if (entry.promise) return entry.promise;
      const owned = entry;
      const closureId = `closure-${proposal.id}`, eventId = `event-${proposal.id}`;
      owned.promise = (async () => {
        let reply: any;
        try {
          if (owned.uncertain) {
            const receipt = await backend.request({ op: 'get', space: 'work', kind: 'closure', id: closureId });
            if (epoch !== dataEpoch) return retiredCapture();
            if (receipt?.id === closureId) reply = { ok: true, closureId, eventId };
          }
          reply ||= await backend.request(owned.command);
        }
        catch {
          if (epoch !== dataEpoch) return retiredCapture();
          try {
            const receipt = await backend.request({ op: 'get', space: 'work', kind: 'closure', id: closureId });
            if (epoch !== dataEpoch) return retiredCapture();
            if (receipt?.id === closureId) reply = { ok: true, closureId, eventId };
          } catch { /* No acknowledgement is not evidence that the write was rejected. */ }
          if (epoch !== dataEpoch) return retiredCapture();
          if (!reply) { owned.uncertain = true; owned.promise = undefined; return { outcome: 'unknown', error: '保存结果暂时无法确认。草稿已保留，请核查本次记录后重试。' } as CaptureCommitResult; }
        }
        if (epoch !== dataEpoch) return retiredCapture();
        if (!reply?.ok) { captures.delete(proposal.id); return { outcome: 'rejected', error: reply?.error || '本次记录未提交，请核对后重试。' } as CaptureCommitResult; }
        let refreshWarning: string | undefined;
        owned.completed = true; owned.uncertain = false;
        try { await api.refresh('work'); } catch { refreshWarning = '本次记录已保存，但视图尚未刷新，请重试读取。'; }
        if (epoch !== dataEpoch) return retiredCapture();
        return { outcome: 'committed', closureId: reply.closureId || closureId, eventId: reply.eventId || eventId, ...(refreshWarning ? { refreshWarning } : {}) } as CaptureCommitResult;
      })();
      // Keep only the current working set; backend idempotency remains durable.
      if (captures.size > 100) for (const key of captures.keys()) { if (key !== proposal.id) { captures.delete(key); break; } }
      return owned.promise;
    },
    async setItemState(kind: 'task' | 'followup', item: ProjectTaskItem | FollowUpItem, done: boolean): Promise<CaptureCommitResult> {
      const batchId = newId('explicit-action');
      const after = kind === 'task' ? { ...item, done } : { ...item, status: done ? 'resolved' : 'open', updatedAt: Date.now() };
      try {
        const result: any = await api.transaction('work', [{ kind, id: item.id, before: item, after }], { id: batchId, event: true, sourceText: kind === 'task' ? done ? '用户明确标记行动完成' : '用户明确重新打开行动' : done ? '用户标记跟进项已处理' : '用户重新打开跟进项' });
        return result.ok ? { outcome: 'committed', eventId: `event-${batchId}`, refreshWarning: result.refreshWarning } : { outcome: 'rejected', error: result.error };
      } catch {
        try { const event: any = await api.get('work', 'event', `event-${batchId}`); if (event) return { outcome: 'committed', eventId: event.id, refreshWarning: '操作已保存，视图可能需要刷新。' }; } catch {}
        return { outcome: 'unknown', error: '操作结果暂时无法确认，请先重新读取，勿重复操作。' };
      }
    },
    async getWorkspaceMode(): Promise<WorkspaceMode> { await api.initialize(); return active; },
    async saveWorkspaceMode(space: WorkspaceMode) {
      await api.initialize(); const result = await backend.request({ op: 'mode', space });
      if (result?.ok === false) throw new Error(result.error);
      active = space; current = { ...current, activeMode: space }; await api.refresh(space);
    },
    async getSettings(): Promise<PublicAppSettings> { await api.initialize(); return current.settings; },
    async saveSettings(settings: AppSettings) { const result = await api.request({ op: 'settings', patch: onlyPublicSettings(settings) });
      if (result?.ok === false) throw new Error(result.error || '设置未保存。'); },
    async getMessages(space: WorkspaceMode): Promise<Message[]> { return (await api.query<Message>(space, 'message')).items.reverse(); },
    async saveMessages(messages: Message[], space: WorkspaceMode) {
      // Saving a short UI window only appends missing IDs; it cannot truncate or rewrite original history.
      const mutations: RecordMutation[] = [];
      for (const after of messages) if (!(await api.get(space, 'message', after.id))) mutations.push({ kind: 'message', id: after.id, before: null, after });
      const result = await api.transaction(space, mutations);
      if (!result.ok) throw new Error(result.error || '原文未保存。');
    },
    async getMemories(space: WorkspaceMode): Promise<MemoryItem[]> { return (await api.query<MemoryItem>(space, 'memory')).items; },
    async saveMemories(memories: MemoryItem[], space: WorkspaceMode) { await api.upsert(space, 'memory', memories.map(item => ({ ...item, mode: space })), true); },
    async addMemory(fact: string, category: MemoryItem['category'], space: WorkspaceMode): Promise<MemoryItem> {
      const item = { id: newId('memory'), mode: space, category, fact, createdAt: Date.now(), importance: 3, status: 'active' };
      await api.saveMemories([item], space); return item;
    },
    async deleteMemory(id: string, space: WorkspaceMode): Promise<void> {
      const before = await api.get(space, 'memory', id); if (!before) return;
      const result = await api.transaction(space, [{ kind: 'memory', id, before, after: { ...before, status: 'retracted' } }], { event: true, sourceText: '用户要求忘记事实；原始档案保留' });
      if (!result.ok) throw new Error(result.error);
    },
    async getWalletCard(): Promise<WalletCardState> { await api.initialize(); return copy(current.partitions.life.wallet); },
    async saveWalletCard(wallet: WalletCardState) {
      const { entries, ...config } = wallet;
      const before = await api.get('life', 'wallet', 'wallet');
      const mutations: RecordMutation[] = sameValue(before, config) ? [] : [{ kind: 'wallet', id: 'wallet', before, after: config }];
      for (const after of entries) { const previous = await api.get('life', 'expense', after.id); if (!sameValue(previous, after)) mutations.push({ kind: 'expense', id: after.id, before: previous, after }); }
      const result = await api.transaction('life', mutations, { event: true, sourceText: '用户确认账本编辑' }); if (!result.ok) throw new Error(result.error);
    },
    async getRpgStatusCard(): Promise<RpgStatusCardState> {
      await api.initialize(); const value = current.partitions.life.rpg;
      return value.dateKey !== shanghaiDateKey() ? { ...value, waterCups: 0, dateKey: shanghaiDateKey() } : copy(value);
    },
    async saveRpgStatusCard(value: RpgStatusCardState) { await api.upsert('life', 'rpg', [{ ...value, dateKey: shanghaiDateKey() }], true); },
    async getPersonProfiles(): Promise<PersonProfile[]> { return (await api.query<PersonProfile>('life', 'person')).items; },
    async savePersonProfiles(values: PersonProfile[]) { await api.upsert('life', 'person', values, true); },
    async getCrmDeals(): Promise<CrmDealItem[]> {
      const projects = (await api.query<any>('work', 'engagement')).items;
      return projects.map(item => ({ id: item.id, clientName: item.clientName, budgetAmount: item.budgetAmount, stage: item.stage,
        winProbability: 0, painPoints: item.internalContext, internalBottomLine: item.internalContext, nextAction: item.nextAction, updatedAt: item.updatedAt }));
    },
    async getProjectTasks(): Promise<ProjectTaskItem[]> { return (await api.query<ProjectTaskItem>('work', 'task')).items; },
    async saveProjectTasks(values: ProjectTaskItem[]) { await api.upsert('work', 'task', values, true); },
    async getCustomCards(space: WorkspaceMode): Promise<CustomLivingCard[]> { return (await api.query<CustomLivingCard>(space, 'custom')).items; },
    async saveCustomCards(values: CustomLivingCard[], space: WorkspaceMode) {
      const prior = current.partitions[space].customCards;
      const mutations: RecordMutation[] = [];
      for (const after of values.map(item => ({ ...item, mode: space }))) { const before = await api.get(space, 'custom', after.id); if (!sameValue(before, after)) mutations.push({ kind: 'custom', id: after.id, before, after }); }
      // Only an explicitly removed card in the loaded window is deleted; archived cards outside this window are untouched.
      for (const before of prior) if (!values.some(item => item.id === before.id)) mutations.push({ kind: 'custom', id: before.id, before, after: null });
      const result = await api.transaction(space, mutations, { event: true, sourceText: '用户确认自定义卡编辑' }); if (!result.ok) throw new Error(result.error);
    },
    async getJournals(space: WorkspaceMode): Promise<JournalArtifact[]> { return (await api.query<JournalArtifact>(space, 'journal')).items; },
    async saveJournals(values: JournalArtifact[], space: WorkspaceMode) { await api.upsert(space, 'journal', values.map(item => ({ ...item, mode: space }))); },
    async addJournal(journal: JournalArtifact, space: WorkspaceMode) { await api.saveJournals([journal], space); },
    async createProposal(space: WorkspaceMode, operations: WorkOperation[], sourceText: string, sourceMessageId = newId('manual')): Promise<ProposedChangeSet> {
      await api.refresh(space);
      return { id: newId('proposal'), mode: space, sourceText, sourceMessageId, operations: copy(operations), warnings: [], createdAt: Date.now(), baseRevision: current.partitions[space].revision };
    },
    async commit(proposal: ProposedChangeSet): Promise<MutationResult> {
      try {
        if (!proposal || !['life', 'work'].includes(proposal.mode)) return { ok: false, error: '候选空间无效。' };
        const result = await api.transaction(proposal.mode, proposal.operations.map(operation => ({ kind: operation.target, id: operation.entityId, before: operation.before, after: operation.after })),
          { id: proposal.id, baseRevision: proposal.baseRevision, sourceText: proposal.sourceText, sourceMessageId: proposal.sourceMessageId, event: true });
        if (!result.ok || result.receipts?.length === 0) return result;
        const receipts: StateMutationReceipt[] = proposal.operations.map((operation, index) => ({ id: `${proposal.id}-${index}`, mode: proposal.mode,
          targetCardType: operation.target === 'engagement' ? 'crm' : operation.target === 'task' ? 'projects' : 'custom',
          targetCardTitle: operation.target === 'engagement' ? '客户合作项目' : operation.target === 'task' ? '行动待办' : '已确认事实',
          summaryText: `${operation.after ? '已确认保存' : '已确认移除'}：${(operation.after as any)?.title || (operation.after as any)?.fact || operation.entityId}`,
          deltaBadge: '已确认', timestamp: Date.now() }));
        return { ...result, receipts };
      } catch { return { ok: false, error: '未能保存，原数据已保留。' }; }
    },
    async undo(space: WorkspaceMode, eventId?: string): Promise<MutationResult> { return api.request({ op: 'undo', space, ...(eventId ? { eventId } : {}) }); },
    async getParseContext(text: string, selectedId?: string): Promise<WorkPartition> {
      const partition: WorkPartition = { revision: 0, messages: [], memories: [], journals: [], customCards: [], events: [], processedProposalIds: [], engagements: [], tasks: [], followUps: [], closures: [] };
      const tokens = searchTerms(text).filter(term => [...term].length >= 2).slice(0, 24);
      const names = extractClientNames(text).slice(0, 200);
      const pages = await Promise.all([...(names.length ? [api.query('work', 'engagement', { names, limit: 200 })] : []), ...tokens.map(query => api.query('work', 'engagement', { query, limit: 20 }))]);
      const projects = new Map<string, any>(); for (const page of pages) for (const project of page.items) projects.set(project.id, project);
      if (selectedId) { const selected = await api.get('work', 'engagement', selectedId); if (selected) projects.set(selected.id, selected); }
      partition.engagements = [...projects.values()].slice(0, 100);
      const tasks = await Promise.all(partition.engagements.map(project => api.query('work', 'task', { relatedId: project.id, limit: 50 })));
      partition.tasks = tasks.flatMap(page => page.items).slice(0, 200);
      const followUps = await Promise.all(partition.engagements.map(project => api.query<FollowUpItem>('work', 'followup', { relatedId: project.id, limit: 50 })));
      partition.followUps = followUps.flatMap(page => page.items).slice(0, 200);
      await api.refresh('work'); partition.revision = current.partitions.work.revision; return partition;
    },
    async updateLifeAtomically(update: (life: LifePartition) => StateMutationReceipt[], sourceMessageId?: string, contextText?: string): Promise<StateMutationReceipt[]> {
      await api.refresh('life'); const before = copy(current.partitions.life);
      if (contextText) {
        const terms = searchTerms(contextText).filter(term => [...term].length >= 2).slice(0, 16);
        const related = await Promise.all(terms.map(query => api.query<PersonProfile>('life', 'person', { query, limit: 20 })));
        before.persons = [...new Map([...before.persons, ...related.flatMap(page => page.items)].map(person => [person.id, person])).values()];
      }
      const after = copy(before); const receipts = update(after);
      if (!receipts.length) return [];
      const mutations: RecordMutation[] = [];
      const add = (kind: RecordKind, id: string, previous: any, next: any) => { if (!sameValue(previous, next)) mutations.push({ kind, id, before: previous, after: next }); };
      const { entries: previousEntries, ...previousWallet } = before.wallet; const { entries: nextEntries, ...nextWallet } = after.wallet;
      add('wallet', 'wallet', previousWallet, nextWallet); add('rpg', 'rpg', before.rpg, after.rpg);
      for (const [kind, field] of [['expense', 'entries'], ['person', 'persons'], ['custom', 'customCards'], ['memory', 'memories']] as const) {
        const next = field === 'entries' ? nextEntries : after[field], previous = field === 'entries' ? previousEntries : before[field];
        for (const item of next) add(kind, item.id, previous.find(value => value.id === item.id) || null, item);
      }
      const result = await api.transaction('life', mutations, { id: sourceMessageId ? `life:${sourceMessageId}` : undefined,
        baseRevision: before.revision, sourceMessageId, sourceText: '用户生活态输入', event: true });
      if (!result.ok) throw new Error(result.error || '生活记录未保存。');
      return result.receipts?.length === 0 ? [] : receipts;
    },
    recordWorkIntensityBridge() { /* Work writes never bridge to life. */ },
    async exportAllData(): Promise<string> {
      await api.initialize();
      const data = await backend.request({ op: 'exportSnapshot' });
      if (data?.ok === false || !Array.isArray(data?.records)) throw new Error('完整备份读取失败。');
      return JSON.stringify({ version: 'looma-v5', ...data });
    },
    async importAllData(json: string): Promise<boolean> {
      restoreWarning = undefined;
      let acknowledged = false;
      try {
        const data = JSON.parse(json);
        const incoming = data?.schemaVersion === 3 ? flattenV3(data) : ['looma-v4', 'looma-v5'].includes(data?.version) ? data : null;
        if (!incoming) return false;
        // Recovery intentionally bypasses initialize: a corrupt legacy snapshot must not prevent restoring a valid backup.
        const result = await backend.request({ op: 'restore', records: incoming.records, applied: incoming.applied || [], settings: incoming.settings, mode: incoming.mode, revisions: incoming.revisions, snapshotRevision: incoming.snapshotRevision });
        if (!result.ok) return false;
        acknowledged = true;
        invalidateAfterRestore(); active = incoming.mode;
        await api.initialize(); return true;
      } catch {
        if (acknowledged) { restoreWarning = restoredReadWarning; return true; }
        return false;
      }
    },
  };
  return api;
}

const backend: PersistenceBackend = { request(command) {
  const native = typeof window !== 'undefined' ? (window.electronAPI as any)?.storeRequest : undefined;
  return native ? native(command) : webBackend.request(command);
} };
const webBackend = createIndexedDbBackend();
export const Repository = createRepository(backend);
