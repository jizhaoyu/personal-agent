import type { AppSettings, Message, MemoryItem, JournalArtifact, WorkspaceMode, StateMutationReceipt, Engagement, ProjectTaskItem, ProposedChangeSet, WorkPartition, AlignmentDraft, FollowUpItem } from '../types';
import { StateEngine, budgetIsUncertain, dateIsUncertain } from './stateEngine';
import { resolveDeadline, shanghaiDateKey } from './dates';

export function createAlignmentDraft(engagement: Engagement, tasks: ProjectTaskItem[], selectedIds: string[], includeBudget = false): AlignmentDraft {
  const draft: AlignmentDraft = { title: '沟通纪要草稿 / 待对方确认', clientName: engagement.clientName, projectTitle: engagement.title, summary: engagement.shareableSummary,
    actions: tasks.filter(t => t.engagementId === engagement.id && selectedIds.includes(t.id)).map(t => ({ title: t.title, ...(t.dueAt ? { dueAt: t.dueAt } : {}) })) };
  if (includeBudget && engagement.budgetAmount !== undefined) draft.budgetAmount = engagement.budgetAmount;
  return draft;
}

export function chinaTime(value: string | number): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

export function alignmentText(draft: AlignmentDraft): string {
  return [draft.title, `客户：${draft.clientName}`, `项目：${draft.projectTitle}`, draft.summary && `讨论摘要：\n${draft.summary}`, draft.budgetAmount !== undefined && `预算参考：¥${draft.budgetAmount.toLocaleString('zh-CN')}`, draft.actions.length > 0 && `待核对行动：\n${draft.actions.map(t => `• ${t.title}${t.dueAt ? `（${chinaTime(t.dueAt)}，北京时间）` : '（时间待确认）'}`).join('\n')}`, '请对方核对上述记录；如有偏差，以双方后续确认为准。', '由 Looma 整理 · 内容经发送者审阅'].filter(Boolean).join('\n\n');
}

export function getDueTasks(tasks: ProjectTaskItem[], now = Date.now()): ProjectTaskItem[] {
  return tasks.filter(t => !t.done && t.dueAt && Number.isFinite(Date.parse(t.dueAt)) && Date.parse(t.dueAt) <= now).sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
}

const stages = ['初步接触', '需求确认', '方案报价', '商务谈判', '赢单成交'];
function object(value: unknown): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型结构无效，请使用本地预览或重试。');
}
function fields(value: Record<string, any>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('模型包含不支持的字段，已拒绝该结果。');
}
function textField(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > 4000 || (required && !value.trim())) throw new Error(`模型的${name}无效，请重新核对。`);
  return value.trim();
}
const titleKey = (value: string) => value.replace(/发送/g, '发').replace(/补充/g, '补').replace(/[\s，,。；;]/g, '');
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTimestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const hasClock = (value: string) => /\d{1,2}(?:[:：]\d{2}|点(?:\d{1,2}分?)?)/.test(value);

export function parseModelProposal(content: string, base: ProposedChangeSet, partition: WorkPartition, selectedEngagementId?: string): ProposedChangeSet {
  if (base.mode !== 'work' || content.length > 50000) throw new Error('模型结果范围无效。');
  const clean = content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let data: Record<string, any>;
  try { data = JSON.parse(clean); } catch { throw new Error('模型没有返回有效 JSON，业务数据未修改。'); }
  object(data); fields(data, ['engagements', 'tasks', 'followups', 'warnings']);
  if (!Array.isArray(data.engagements) || !Array.isArray(data.tasks) || data.engagements.length > 20 || data.tasks.length > 40 ||
      (data.followups !== undefined && (!Array.isArray(data.followups) || data.followups.length > 40)) ||
      !Array.isArray(data.warnings) || data.warnings.some(w => typeof w !== 'string' || w.length > 1000)) throw new Error('模型候选列表无效。');
  if (base.clarification && (data.engagements.length || data.tasks.length || data.followups?.length)) throw new Error('请先明确沟通归属，模型不能替你猜测客户或项目。');
  if (/如果|假如|假设|倘若|可能会|或许会|也许会/.test(base.sourceText) && (data.engagements.length || data.tasks.length)) throw new Error('原文含假设，已保留本地候选，请只确认明确事实。');
  const operations: ProposedChangeSet['operations'] = [];
  const proposedEngagements: Engagement[] = [];
  for (const [i, item] of data.engagements.entries()) {
    object(item); fields(item, ['id', 'clientName', 'title', 'budgetAmount', 'stage', 'shareableSummary', 'nextAction']);
    const clientName = textField(item.clientName, '客户名称', true)!;
    const title = textField(item.title, '项目名称', true)!;
    const local = base.operations.find(operation => operation.target === 'engagement' && operation.after?.clientName === clientName);
    const localProject = local?.target === 'engagement' ? local.after : undefined;
    const candidates = partition.engagements.filter(e => e.clientName === clientName && e.title === title);
    const clientProjects = partition.engagements.filter(e => e.clientName === clientName);
    if (clientProjects.length > 1 && !selectedEngagementId && !base.sourceText.includes(title)) throw new Error('同一客户有多个项目，请先选择目标项目或在原文中明确新项目名称。');
    if (candidates.length > 1 && !item.id) throw new Error('存在同名项目，请先选择目标项目。');
    const before = item.id ? partition.engagements.find(e => e.id === item.id) : candidates[0] || clientProjects.find(e => e.id === selectedEngagementId);
    if (!before && !localProject) throw new Error('模型提出了本地归属核对之外的新客户项目，请先明确客户和项目。');
    if (item.id && ((!before && localProject?.id !== item.id) || (before && before.clientName !== clientName))) throw new Error('模型引用了未知或不匹配的客户项目。');
    if (selectedEngagementId && (before?.id || localProject?.id) !== selectedEngagementId) throw new Error('模型试图更新选定目标之外的项目。');
    if (item.budgetAmount !== undefined && (typeof item.budgetAmount !== 'number' || !Number.isFinite(item.budgetAmount) || item.budgetAmount < 0 || item.budgetAmount > 1e12)) throw new Error('模型预算金额无效。');
    if (item.budgetAmount !== undefined && budgetIsUncertain(base.sourceText)) throw new Error('原文预算尚未确认，已拒绝模型的确定金额。');
    if (item.budgetAmount !== undefined && item.budgetAmount !== before?.budgetAmount) {
      const hasUnit = /(?:\d+(?:\.\d+)?|[一二三四五六七八九十百千万两零]+)\s*(?:万元?|元|块钱?|[wk])|[¥￥]\s*\d+/i.test(base.sourceText);
      if (!hasUnit || base.warnings.some(w => /金额缺少单位/.test(w))) throw new Error('原文金额缺少明确单位，模型不能补全为人民币金额。');
      const local = base.operations.find(op => op.target === 'engagement' && op.after && op.after.clientName === clientName);
      if (local?.target === 'engagement' && local.after?.budgetAmount !== undefined && local.after.budgetAmount !== before?.budgetAmount && local.after.budgetAmount !== item.budgetAmount) throw new Error('模型金额与本地明确金额不一致，请使用本地预览核对。');
    }
    if (item.stage !== undefined && !stages.includes(item.stage)) throw new Error('模型项目阶段无效。');
    if (item.stage === '赢单成交' && /还没|尚未|未能|没有|不是|并非|没成交|未成交|未签|没签|未打款|可能|或许|也许|有望|预计|打算|计划|准备|下周|明天|后天/.test(base.sourceText)) throw new Error('原文尚未确认成交，已拒绝模型的成交推断。');
    const after: Engagement = { ...(before || localProject || { id: `${base.sourceMessageId}-model-e${i}`, clientName, title, stage: '初步接触', internalContext: '', shareableSummary: '', nextAction: '', updatedAt: base.createdAt }), clientName, title, updatedAt: base.createdAt };
    if (item.budgetAmount !== undefined) after.budgetAmount = item.budgetAmount;
    if (item.stage !== undefined) after.stage = item.stage;
    for (const key of ['shareableSummary', 'nextAction'] as const) { const value = textField(item[key], key); if (value !== undefined) after[key] = value; }
    if (operations.some(op => op.entityId === after.id)) throw new Error('模型重复修改同一项目，请重新核对。');
    operations.push({ target: 'engagement', entityId: after.id, before: before || null, after }); proposedEngagements.push(after);
  }
  for (const [i, item] of data.tasks.entries()) {
    object(item); fields(item, ['id', 'engagementId', 'title', 'dueAt', 'sourceDeadlineText']);
    const title = textField(item.title, '行动标题', true)!;
    if (base.operations.some(operation => operation.target === 'followup' && operation.after?.kind === 'waiting' && titleKey(operation.after.title) === titleKey(title))) throw new Error('模型把明确由客户处理的事项改成了我方行动，请使用本地候选核对责任。');
    const before = item.id ? partition.tasks.find(t => t.id === item.id) : undefined;
    if (item.id && !before) throw new Error('模型引用了未知待办。');
    let engagementId = item.engagementId ?? before?.engagementId;
    if (!engagementId && proposedEngagements.length === 1) engagementId = proposedEngagements[0].id;
    if (!engagementId) engagementId = selectedEngagementId;
    if (engagementId && ![...partition.engagements, ...proposedEngagements].some(e => e.id === engagementId)) throw new Error('模型待办缺少有效项目关联。');
    if (selectedEngagementId && engagementId !== selectedEngagementId) throw new Error('模型试图修改选中项目之外的行动。');
    if (before && before.engagementId !== engagementId) throw new Error('模型试图改变已有行动的项目归属。');
    if (item.dueAt !== undefined && !validTimestamp(item.dueAt)) throw new Error('模型待办日期无效，必须明确时区。');
    if (item.dueAt !== undefined && dateIsUncertain(base.sourceText)) throw new Error('原文时间尚未确认，模型不能生成确定的提醒时间。');
    const deadlineText = textField(item.sourceDeadlineText, '原始日期');
    const after: ProjectTaskItem = { ...(before || { id: `${base.sourceMessageId}-model-t${i}`, title, assignee: '我', deadline: '', priority: 'medium', done: false }), title, ...(engagementId ? { engagementId } : {}), ...(item.dueAt ? { dueAt: new Date(item.dueAt).toISOString() } : {}), ...(deadlineText !== undefined ? { sourceDeadlineText: deadlineText, deadline: deadlineText } : {}) };
    if (operations.some(op => op.entityId === after.id)) throw new Error('模型重复修改同一待办。');
    operations.push({ target: 'task', entityId: after.id, before: before || null, after });
  }
  for (const [index, item] of (data.followups || []).entries()) {
    object(item); fields(item, ['id', 'engagementId', 'kind', 'title', 'expectedDate', 'expectedAt', 'sourceDateText']);
    if (!['waiting', 'question'].includes(item.kind)) throw new Error('模型跟进事项类型无效。');
    const title = textField(item.title, '跟进内容', true)!;
    const local = base.operations.find(operation => operation.target === 'followup' && operation.after?.kind === item.kind && titleKey(operation.after.title) === titleKey(title));
    const localFollowup = local?.target === 'followup' ? local.after : undefined;
    const before = item.id ? partition.followUps?.find(followup => followup.id === item.id) : undefined;
    if (item.id && !before && localFollowup?.id !== item.id) throw new Error('模型引用了未知跟进事项。');
    const engagementId = item.engagementId || before?.engagementId || localFollowup?.engagementId || (proposedEngagements.length === 1 ? proposedEngagements[0].id : selectedEngagementId);
    const validProjects = [...partition.engagements, ...proposedEngagements, ...base.operations.filter(operation => operation.target === 'engagement' && operation.after).map(operation => operation.after as Engagement)];
    if (engagementId && !validProjects.some(project => project.id === engagementId)) throw new Error('模型跟进事项缺少有效项目关联。');
    if (selectedEngagementId && engagementId && engagementId !== selectedEngagementId) throw new Error('模型试图修改选中项目之外的跟进事项。');
    if (before && (before.kind !== item.kind || before.engagementId !== engagementId)) throw new Error('模型试图改变跟进事项归属。');
    const sourceDateText = textField(item.sourceDateText, '原日期表达');
    if (item.expectedDate !== undefined && !validDate(item.expectedDate)) throw new Error('模型的预计日期无效。');
    if (item.expectedAt !== undefined && !validTimestamp(item.expectedAt)) throw new Error('模型预计时间无效。');
    if (item.expectedDate !== undefined && item.expectedAt !== undefined) throw new Error('预计日期与具体时刻不能同时填写。');
    if (item.kind === 'question' && (item.expectedDate !== undefined || item.expectedAt !== undefined)) throw new Error('待确认问题不能由模型补出确定日期。');
    if ((item.expectedDate !== undefined || item.expectedAt !== undefined) && dateIsUncertain(base.sourceText)) throw new Error('原文时间尚未确认，模型不能补出确定的客户日期。');
    if (item.expectedAt !== undefined && (localFollowup?.expectedDate || !sourceDateText || !base.sourceText.includes(sourceDateText) || !hasClock(sourceDateText))) throw new Error('客户只给日期时，不能补具体时刻作为对方承诺。');
    if (item.expectedDate !== undefined) {
      if (localFollowup?.expectedAt) throw new Error('原文明确了具体时刻，请保留本地时间核对。');
      if (localFollowup?.expectedDate && item.expectedDate !== localFollowup.expectedDate) throw new Error('模型日期与原文日期不一致。');
      if (!localFollowup?.expectedDate) {
        if (!sourceDateText || !base.sourceText.includes(sourceDateText)) throw new Error('模型日期缺少原文依据。');
        const resolved = resolveDeadline(sourceDateText, base.createdAt);
        if (!resolved.dueAt || shanghaiDateKey(Date.parse(resolved.dueAt)) !== item.expectedDate) throw new Error('模型日期与原文日期不一致。');
      }
    }
    if (item.expectedAt !== undefined) {
      const resolved = resolveDeadline(sourceDateText!, base.createdAt);
      if (!resolved.dueAt || resolved.dueAt !== new Date(item.expectedAt).toISOString()) throw new Error('模型时间与原文时间不一致。');
    }
    const after: FollowUpItem = { ...(before || localFollowup || { id: `${base.sourceMessageId}-model-f${index}`, status: 'open', sourceMessageId: base.sourceMessageId, createdAt: base.createdAt }),
      kind: item.kind, title, ...(engagementId ? { engagementId } : {}), updatedAt: base.createdAt };
    if (item.expectedDate !== undefined) { after.expectedDate = item.expectedDate; delete after.expectedAt; }
    if (item.expectedAt !== undefined) { after.expectedAt = new Date(item.expectedAt).toISOString(); delete after.expectedDate; }
    if (sourceDateText !== undefined) after.sourceDateText = sourceDateText;
    if (operations.some(operation => operation.entityId === after.id)) throw new Error('模型重复修改同一跟进事项。');
    operations.push({ target: 'followup', entityId: after.id, before: before || null, after });
  }
  // A provider that has not adopted the optional field cannot erase local responsibility or unresolved facts.
  for (const local of base.operations) {
    if (operations.some(operation => operation.target === local.target && operation.entityId === local.entityId)) continue;
    if (local.target === 'task' && local.after && operations.some(operation => operation.target === 'task' && operation.after?.engagementId === local.after.engagementId && titleKey(operation.after.title) === titleKey(local.after.title))) continue;
    if (local.target === 'followup' && local.after && operations.some(operation => operation.target === 'followup' && operation.after?.engagementId === local.after.engagementId && operation.after.kind === local.after.kind && titleKey(operation.after.title) === titleKey(local.after.title))) continue;
    operations.push(JSON.parse(JSON.stringify(local)));
  }
  operations.sort((a, b) => Number(a.target !== 'engagement') - Number(b.target !== 'engagement'));
  return { ...base, operations, warnings: [...new Set(['模型结果需要逐项核对，尤其是人物、金额、责任和日期。', ...base.warnings, ...data.warnings])] };
}

export const AiService = {
  async sendMessage(messages: Message[], _settings: AppSettings, _memories: MemoryItem[], mode: WorkspaceMode): Promise<{reply: string; mutations: StateMutationReceipt[]}> {
    if (mode === 'work') return { reply: '请先核对候选变更，确认后才会写入工作记录。', mutations: [] };
    const last = messages[messages.length - 1];
    const mutations = StateEngine.sniffAndMutate(last?.content || '', 'life', last?.id);
    return { reply: mutations.length ? `已更新生活记录：\n${mutations.map(m => m.summaryText).join('\n')}` : '这句话已保留在当前生活对话中，尚未识别出可更新的生活卡片。', mutations };
  },
  async generateDailyJournal(messages: Message[], _settings: AppSettings, mode: WorkspaceMode): Promise<JournalArtifact> {
    const now = Date.now(); const users = messages.filter(m => m.role === 'user');
    return { id: `journal-${mode}-${now}`, mode, date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now), title: mode === 'life' ? '今日生活手记' : '今日工作回顾', mood: mode === 'life' ? '生活记录' : '工作记录', userGoldenQuote: users[users.length - 1]?.content.slice(0, 120) || '今天还没有对话记录。', aiReflection: mode === 'life' ? '这是一份由当前空间本地记录整理的手记，你可以按自己的节奏补充生活。' : '仅整理当前工作空间的记录，不代表客户已经确认。', stickers: mode === 'life' ? ['🌙', '☕'] : ['📋'], createdAt: now };
  },
};
