import type {
  AppLanguage,
  ArtifactDraft,
  ArtifactType,
  ConditionIntent,
  Engagement,
  FollowUpItem,
  ProjectTaskItem,
} from '../types';
import { newId } from './storage';
import { formatBudgetAmount, formatConditionStatus, formatDealStage } from '../i18n/domain';

export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  proposal_brief: '方案简报',
  material_checklist: '材料清单',
  meeting_brief: '沟通纪要',
};

export const ARTIFACT_STATUS_LABELS: Record<ArtifactDraft['status'], string> = {
  draft: '草稿',
  needs_review: '需核对',
  ready: '已可查看',
};

export interface ArtifactBuildInput {
  type: ArtifactType;
  project: Engagement;
  tasks?: ProjectTaskItem[];
  followUps?: FollowUpItem[];
  conditions?: ConditionIntent[];
  condition?: ConditionIntent;
  existing?: ArtifactDraft;
  now?: number;
  lang?: AppLanguage;
}

export interface ArtifactStaleness {
  stale: boolean;
  persistedReview: boolean;
  snapshotChanged: boolean;
  reasons: string[];
  liveSnapshot: ArtifactDraft['sourceSnapshot'];
}

function projectScoped(
  projectId: string,
  tasks: ProjectTaskItem[] = [],
  followUps: FollowUpItem[] = [],
  conditions: ConditionIntent[] = [],
) {
  return {
    tasks: tasks.filter(item => item.engagementId === projectId),
    followUps: followUps.filter(item => item.engagementId === projectId),
    conditions: conditions.filter(item => item.engagementId === projectId),
  };
}

export function computeSourceSnapshot(
  project: Engagement,
  tasks: ProjectTaskItem[] = [],
  followUps: FollowUpItem[] = [],
  conditions: ConditionIntent[] = [],
): ArtifactDraft['sourceSnapshot'] {
  const scoped = projectScoped(project.id, tasks, followUps, conditions);
  return {
    projectUpdatedAt: project.updatedAt,
    tasksCount: scoped.tasks.length,
    followUpsCount: scoped.followUps.length,
    conditionsCount: scoped.conditions.length,
  };
}

function formatBudgetLine(budgetAmount: number | undefined, lang: AppLanguage): string {
  if (lang === 'en') {
    return budgetAmount === undefined
      ? 'Budget: TBD (no confirmed amount recorded; do not guess pricing)'
      : `Budget Range: ${formatBudgetAmount(budgetAmount, 'en')} (internal verification only; confirm before sharing)`;
  }
  return budgetAmount === undefined
    ? '预算：待定（尚未录入明确金额，切勿自行猜测报价）'
    : `预算范围：¥${budgetAmount.toLocaleString('zh-CN')}（仅作内部核对参考，是否对外报价需由你确认）`;
}

function collectGaps(
  project: Engagement,
  openTasks: ProjectTaskItem[],
  openWaiting: FollowUpItem[],
  openQuestions: FollowUpItem[],
  lang: AppLanguage,
): string[] {
  const gaps: string[] = [];
  if (lang === 'en') {
    if (!project.shareableSummary?.trim()) {
      gaps.push('No public summary recorded yet (add reviewed scope only; never paste internal notes)');
    }
    if (project.budgetAmount === undefined) {
      gaps.push('Budget TBD (left blank because no figure has been confirmed)');
    }
    if (!project.nextAction?.trim() && openTasks.length === 0) {
      gaps.push('No next step or open action recorded on our side yet');
    }
    if (openWaiting.length === 0 && openQuestions.length === 0) {
      gaps.push('No pending client items or open questions recorded');
    }
    return gaps;
  }
  if (!project.shareableSummary?.trim()) {
    gaps.push('尚未记录公开摘要（请核对后再补充背景范围，切勿带入内部备注）');
  }
  if (project.budgetAmount === undefined) {
    gaps.push('预算待定（尚未确认预算金额，草稿已按事实留空）');
  }
  if (!project.nextAction?.trim() && openTasks.length === 0) {
    gaps.push('暂无我方下一步或未完成行动（请确认后续推进节奏）');
  }
  if (openWaiting.length === 0 && openQuestions.length === 0) {
    gaps.push('暂无待客户反馈或待定问题记录');
  }
  return gaps;
}

function formatTaskLine(task: ProjectTaskItem, lang: AppLanguage): string {
  if (lang === 'en') {
    const who = task.assignee?.trim() || 'Assignee TBD';
    const dateText = task.sourceDeadlineText || task.deadline || 'Time TBD';
    return `- [ ] ${task.title} (Owner: ${who}; Timing: ${dateText})`;
  }
  const who = task.assignee?.trim() || '待明确责任人';
  const dateText = task.sourceDeadlineText || task.deadline || '时间尚未明确';
  return `- [ ] ${task.title}（责任：${who}；时间表达：${dateText}）`;
}

function formatFollowUpLine(item: FollowUpItem, lang: AppLanguage): string {
  if (lang === 'en') {
    const kindLabel = item.kind === 'waiting' ? 'Waiting on Client' : 'Open Question';
    const dateLabel = item.expectedDate
      ? `Expected ${item.expectedDate}`
      : item.sourceDateText
        ? `Mentioned "${item.sourceDateText}"`
        : 'Date TBD';
    return `- [ ] [${kindLabel}] ${item.title} (${dateLabel})`;
  }
  const kindLabel = item.kind === 'waiting' ? '等待客户' : '仍待确认';
  const dateLabel = item.expectedDate
    ? `预计 ${item.expectedDate}`
    : item.sourceDateText
      ? `原表达「${item.sourceDateText}」`
      : '时间未定';
  return `- [ ] [${kindLabel}] ${item.title}（${dateLabel}）`;
}

function buildContent(
  type: ArtifactType,
  project: Engagement,
  tasks: ProjectTaskItem[],
  followUps: FollowUpItem[],
  conditions: ConditionIntent[],
  condition?: ConditionIntent,
  lang: AppLanguage = 'zh-CN',
): { title: string; content: string } {
  const openTasks = tasks.filter(item => !item.done);
  const doneTasks = tasks.filter(item => item.done);
  const openWaiting = followUps.filter(item => item.kind === 'waiting' && item.status === 'open');
  const openQuestions = followUps.filter(item => item.kind === 'question' && item.status === 'open');
  const activeConditions = conditions.filter(item => item.status === 'ready' || item.status === 'watching');
  const gaps = collectGaps(project, openTasks, openWaiting, openQuestions, lang);

  if (lang === 'en') {
    const projectLabel = `${project.clientName || 'Unnamed Client'} · ${project.title || 'Untitled Project'}`;
    const disclaimer = '[Generated solely from locally verified facts · For manual review and copying only · Does not imply client agreement · Never sent automatically]';
    const summaryText = project.shareableSummary?.trim() || '(No shareable summary recorded yet)';
    const conditionNote = condition
      ? `\nLinked Trigger: When "${condition.conditionText}" -> ${condition.actionTitle} (Status: ${formatConditionStatus(condition.status, 'en')})`
      : '';
    if (type === 'material_checklist') {
      const sections = [
        disclaimer,
        '',
        `# ${projectLabel} · Materials & Prerequisites Checklist`,
        `Current Stage: ${formatDealStage(project.stage, 'en')}`,
        formatBudgetLine(project.budgetAmount, 'en'),
        conditionNote ? conditionNote.trim() : '',
        '',
        '## 1. Requested from Client / Open Questions',
        ...(openWaiting.length || openQuestions.length
          ? [...openWaiting, ...openQuestions].map(item => formatFollowUpLine(item, 'en'))
          : ['- No pending client materials or open questions recorded']),
        '',
        '## 2. Our Next Preparations & Deliverables',
        ...(project.nextAction?.trim() ? [`- [ ] Project Next Step: ${project.nextAction.trim()}`] : []),
        ...(openTasks.length ? openTasks.map(item => formatTaskLine(item, 'en')) : (!project.nextAction?.trim() ? ['- No open actions on our side'] : [])),
        '',
        '## 3. Conditional Triggers',
        ...(activeConditions.length
          ? activeConditions.map(item => `- When "${item.conditionText}" -> ${item.actionTitle} (${formatConditionStatus(item.status, 'en')})`)
          : ['- No active conditional triggers']),
        '',
        '## 4. Gaps & Items to Verify',
        ...(gaps.length ? gaps.map(gap => `- ${gap}`) : ['- Core fields are covered; verify dates and terms before sharing']),
      ].filter((line, index, arr) => !(line === '' && arr[index - 1] === ''));
      return { title: `${projectLabel} · Materials Checklist`, content: sections.join('\n') };
    }
    if (type === 'meeting_brief') {
      const sections = [
        disclaimer,
        '',
        `# ${projectLabel} · Meeting Brief & Alignment Summary`,
        `Current Stage: ${formatDealStage(project.stage, 'en')}`,
        formatBudgetLine(project.budgetAmount, 'en'),
        `Shareable Context: ${summaryText}`,
        conditionNote ? conditionNote.trim() : '',
        '',
        '## 1. Topics Requiring Client Confirmation',
        ...(openQuestions.length || openWaiting.length
          ? [...openQuestions, ...openWaiting].map(item => formatFollowUpLine(item, 'en'))
          : ['- No open questions or client dependencies recorded']),
        '',
        '## 2. Our Proposed Commitments & Timeline',
        ...(project.nextAction?.trim() ? [`- Project Next Step: ${project.nextAction.trim()}`] : []),
        ...(openTasks.length ? openTasks.map(item => formatTaskLine(item, 'en')) : []),
        ...(doneTasks.length ? [`- Completed Reference (${doneTasks.length}): ${doneTasks.slice(0, 3).map(t => t.title).join('; ')}`] : []),
        ...(!project.nextAction?.trim() && !openTasks.length && !doneTasks.length ? ['- No actions recorded yet'] : []),
        '',
        '## 3. Gaps & Items to Verify',
        ...(gaps.length ? gaps.map(gap => `- ${gap}`) : ['- Records look complete; review before alignment']),
      ].filter((line, index, arr) => !(line === '' && arr[index - 1] === ''));
      return { title: `${projectLabel} · Meeting Brief`, content: sections.join('\n') };
    }
    const sections = [
      disclaimer,
      '',
      `# ${projectLabel} · Proposal Brief`,
      `Current Stage: ${formatDealStage(project.stage, 'en')}`,
      formatBudgetLine(project.budgetAmount, 'en'),
      `Public Scope Summary: ${summaryText}`,
      conditionNote ? conditionNote.trim() : '',
      '',
      '## 1. Near-Term Execution Plan',
      ...(project.nextAction?.trim() ? [`- Project Next Step: ${project.nextAction.trim()}`] : []),
      ...(openTasks.length ? openTasks.map(item => formatTaskLine(item, 'en')) : (!project.nextAction?.trim() ? ['- No separate open action'] : [])),
      ...(doneTasks.length ? [`- Completed Prep (${doneTasks.length}): ${doneTasks.slice(0, 3).map(t => t.title).join('; ')}`] : []),
      '',
      '## 2. Client Dependencies & Open Boundaries',
      ...(openWaiting.length || openQuestions.length
        ? [...openWaiting, ...openQuestions].map(item => formatFollowUpLine(item, 'en'))
        : ['- No pending client dependencies or open questions']),
      '',
      '## 3. Gaps & Items to Verify',
      ...(gaps.length ? gaps.map(gap => `- ${gap}`) : ['- Key fields covered; double-check pricing terms and latest dates before sending']),
    ].filter((line, index, arr) => !(line === '' && arr[index - 1] === ''));
    return { title: `${projectLabel} · Proposal Brief`, content: sections.join('\n') };
  }

  const projectLabel = `${project.clientName || '未命名客户'} · ${project.title || '未命名项目'}`;
  const disclaimer = '【本草稿仅基于本机已核对事实生成 · 仅供人工审阅与手动复制 · 不代表客户已确认 · 系统不会自动发送】';
  const summaryText = project.shareableSummary?.trim() || '（尚未记录公开摘要）';
  const conditionNote = condition
    ? `\n关联触发条件：当「${condition.conditionText}」→ ${condition.actionTitle}（状态：${condition.status}）`
    : '';

  if (type === 'material_checklist') {
    const sections = [
      disclaimer,
      '',
      `# ${projectLabel} · 材料与前置清单`,
      `当前阶段：${project.stage}`,
      formatBudgetLine(project.budgetAmount, 'zh-CN'),
      conditionNote ? conditionNote.trim() : '',
      '',
      '## 一、待向客户索取与确认',
      ...(openWaiting.length || openQuestions.length
        ? [...openWaiting, ...openQuestions].map(item => formatFollowUpLine(item, 'zh-CN'))
        : ['- 暂无已记录的待客户材料或待定问题']),
      '',
      '## 二、我方待准备与交付动作',
      ...(project.nextAction?.trim() ? [`- [ ] 项目级下一步：${project.nextAction.trim()}`] : []),
      ...(openTasks.length ? openTasks.map(item => formatTaskLine(item, 'zh-CN')) : (!project.nextAction?.trim() ? ['- 暂无未完成的我方行动'] : [])),
      '',
      '## 三、前置条件跟踪',
      ...(activeConditions.length
        ? activeConditions.map(item => `- 当「${item.conditionText}」→ ${item.actionTitle}（${item.status === 'ready' ? '已就绪' : '观察中'}）`)
        : ['- 暂无进行中的条件触发项']),
      '',
      '## 四、缺口与待核对项',
      ...(gaps.length ? gaps.map(gap => `- ${gap}`) : ['- 关键字段已齐备，请复制前再次核对时效与口径']),
    ].filter((line, index, arr) => !(line === '' && arr[index - 1] === ''));
    return {
      title: `${projectLabel} · 材料清单`,
      content: sections.join('\n'),
    };
  }

  if (type === 'meeting_brief') {
    const sections = [
      disclaimer,
      '',
      `# ${projectLabel} · 沟通纪要与对齐简报`,
      `当前阶段：${project.stage}`,
      formatBudgetLine(project.budgetAmount, 'zh-CN'),
      `公开背景摘要：${summaryText}`,
      conditionNote ? conditionNote.trim() : '',
      '',
      '## 一、待当面拍板与待确认议题',
      ...(openQuestions.length || openWaiting.length
        ? [...openQuestions, ...openWaiting].map(item => formatFollowUpLine(item, 'zh-CN'))
        : ['- 暂无待当面拍板或等待客户事项']),
      '',
      '## 二、我方推进承诺与排期参考',
      ...(project.nextAction?.trim() ? [`- 项目级安排：${project.nextAction.trim()}`] : []),
      ...(openTasks.length ? openTasks.map(item => formatTaskLine(item, 'zh-CN')) : []),
      ...(doneTasks.length ? [`- 已完成参考（${doneTasks.length} 项）：${doneTasks.slice(0, 3).map(t => t.title).join('；')}`] : []),
      ...(!project.nextAction?.trim() && !openTasks.length && !doneTasks.length ? ['- 暂无行动记录'] : []),
      '',
      '## 三、缺口与待核对项',
      ...(gaps.length ? gaps.map(gap => `- ${gap}`) : ['- 当前资料完整，仅供对齐前人工复核']),
    ].filter((line, index, arr) => !(line === '' && arr[index - 1] === ''));
    return {
      title: `${projectLabel} · 沟通纪要`,
      content: sections.join('\n'),
    };
  }

  const sections = [
    disclaimer,
    '',
    `# ${projectLabel} · 方案简报`,
    `当前阶段：${project.stage}`,
    formatBudgetLine(project.budgetAmount, 'zh-CN'),
    `公开范围摘要：${summaryText}`,
    conditionNote ? conditionNote.trim() : '',
    '',
    '## 一、我方近期推进计划',
    ...(project.nextAction?.trim() ? [`- 项目级下一步：${project.nextAction.trim()}`] : []),
    ...(openTasks.length ? openTasks.map(item => formatTaskLine(item, 'zh-CN')) : (!project.nextAction?.trim() ? ['- 暂无独立未完成行动'] : [])),
    ...(doneTasks.length ? [`- 已完成准备（${doneTasks.length} 项）：${doneTasks.slice(0, 3).map(t => t.title).join('；')}`] : []),
    '',
    '## 二、客户侧依赖与待确认边界',
    ...(openWaiting.length || openQuestions.length
      ? [...openWaiting, ...openQuestions].map(item => formatFollowUpLine(item, 'zh-CN'))
      : ['- 暂无等待客户或待定边界记录']),
    '',
    '## 三、缺口与待核对项',
    ...(gaps.length ? gaps.map(gap => `- ${gap}`) : ['- 关键字段已覆盖，使用前请人工确认报价口径与最新日期']),
  ].filter((line, index, arr) => !(line === '' && arr[index - 1] === ''));
  return {
    title: `${projectLabel} · 方案简报`,
    content: sections.join('\n'),
  };
}

export function buildArtifactDraft(input: ArtifactBuildInput): ArtifactDraft {
  const now = input.now ?? Date.now();
  const lang = input.lang ?? 'zh-CN';
  const scoped = projectScoped(input.project.id, input.tasks, input.followUps, input.conditions);
  const { title, content } = buildContent(
    input.type,
    input.project,
    scoped.tasks,
    scoped.followUps,
    scoped.conditions,
    input.condition,
    lang,
  );
  const sourceSnapshot = computeSourceSnapshot(input.project, scoped.tasks, scoped.followUps, scoped.conditions);
  const conditionId = input.condition?.id || input.existing?.conditionId;
  return {
    id: input.existing?.id || newId('artifact'),
    space: 'work',
    projectId: input.project.id,
    ...(conditionId ? { conditionId } : {}),
    type: input.type,
    title,
    content,
    sourceSnapshot,
    version: input.existing ? input.existing.version + 1 : 1,
    status: 'draft',
    createdAt: input.existing?.createdAt || now,
    updatedAt: Math.max(now, input.existing ? input.existing.updatedAt + 1 : now),
  };
}

export function inspectArtifactStaleness(
  artifact: ArtifactDraft,
  project: Engagement,
  tasks: ProjectTaskItem[] = [],
  followUps: FollowUpItem[] = [],
  conditions: ConditionIntent[] = [],
  lang: AppLanguage = 'zh-CN',
): ArtifactStaleness {
  const liveSnapshot = computeSourceSnapshot(project, tasks, followUps, conditions);
  const reasons: string[] = [];
  const persistedReview = artifact.status === 'needs_review';
  if (persistedReview) {
    reasons.push(
      artifact.reviewReason?.trim()
        || (lang === 'en' ? 'Linked project facts updated; review needed' : '关联项目资料已更新，需重新核对'),
    );
  }

  let snapshotChanged = false;
  if (liveSnapshot.projectUpdatedAt !== artifact.sourceSnapshot.projectUpdatedAt) {
    snapshotChanged = true;
    reasons.push(lang === 'en' ? 'Project overview updated' : '项目概况已更新');
  }
  if (liveSnapshot.tasksCount !== artifact.sourceSnapshot.tasksCount) {
    snapshotChanged = true;
    reasons.push(lang === 'en'
      ? `Actions count changed (${artifact.sourceSnapshot.tasksCount} → ${liveSnapshot.tasksCount})`
      : `行动数量变化（${artifact.sourceSnapshot.tasksCount} → ${liveSnapshot.tasksCount}）`);
  }
  if (liveSnapshot.followUpsCount !== artifact.sourceSnapshot.followUpsCount) {
    snapshotChanged = true;
    reasons.push(lang === 'en'
      ? `Waiting/open items changed (${artifact.sourceSnapshot.followUpsCount} → ${liveSnapshot.followUpsCount})`
      : `等待/待定事项变化（${artifact.sourceSnapshot.followUpsCount} → ${liveSnapshot.followUpsCount}）`);
  }
  if (liveSnapshot.conditionsCount !== artifact.sourceSnapshot.conditionsCount) {
    snapshotChanged = true;
    reasons.push(lang === 'en'
      ? `Conditions count changed (${artifact.sourceSnapshot.conditionsCount} → ${liveSnapshot.conditionsCount})`
      : `条件数量变化（${artifact.sourceSnapshot.conditionsCount} → ${liveSnapshot.conditionsCount}）`);
  }

  return {
    stale: persistedReview || snapshotChanged,
    persistedReview,
    snapshotChanged,
    reasons: [...new Set(reasons)],
    liveSnapshot,
  };
}

export function confirmArtifactReady(artifact: ArtifactDraft, now = Date.now()): ArtifactDraft {
  const next: ArtifactDraft = {
    ...artifact,
    status: 'ready',
    updatedAt: Math.max(now, artifact.updatedAt + 1),
  };
  delete next.reviewReason;
  return next;
}

export function applyArtifactRebuild(
  existing: ArtifactDraft,
  facts: {
    project: Engagement;
    tasks?: ProjectTaskItem[];
    followUps?: FollowUpItem[];
    conditions?: ConditionIntent[];
    condition?: ConditionIntent;
  },
  mode: 'rebuild' | 'keep_content',
  now = Date.now(),
  lang: AppLanguage = 'zh-CN',
): ArtifactDraft {
  if (mode === 'rebuild') {
    return buildArtifactDraft({
      type: existing.type,
      project: facts.project,
      tasks: facts.tasks,
      followUps: facts.followUps,
      conditions: facts.conditions,
      condition: facts.condition,
      existing,
      now,
      lang,
    });
  }
  const sourceSnapshot = computeSourceSnapshot(facts.project, facts.tasks, facts.followUps, facts.conditions);
  const next: ArtifactDraft = {
    ...existing,
    sourceSnapshot,
    version: existing.version + 1,
    status: 'draft',
    updatedAt: Math.max(now, existing.updatedAt + 1),
  };
  delete next.reviewReason;
  return next;
}
