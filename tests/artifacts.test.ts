import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactDraft, ConditionIntent, Engagement, FollowUpItem, ProjectTaskItem } from '../src/types';
import {
  buildArtifactDraft,
  computeSourceSnapshot,
  inspectArtifactStaleness,
  confirmArtifactReady,
  applyArtifactRebuild,
} from '../src/services/artifacts';

const baseProject = (overrides: Partial<Engagement> = {}): Engagement => ({
  id: 'proj-1',
  clientName: '林总',
  title: '品牌官网重构',
  stage: '方案报价',
  budgetAmount: 80000,
  internalContext: '底价最低可让到65000，仅内部评估用，绝不外发',
  shareableSummary: '首期含视觉改版、前端响应式落地与CMS对接',
  nextAction: '周五前发新版结构清单与分期里程碑',
  updatedAt: 1000,
  ...overrides,
});

const sampleTasks: ProjectTaskItem[] = [
  { id: 't1', engagementId: 'proj-1', title: '输出首页与产品页交互原型', assignee: '我', deadline: '周五前', priority: 'high', done: false },
  { id: 't2', engagementId: 'proj-1', title: '收集上期线上性能基线', assignee: '李工', deadline: '已完成', priority: 'medium', done: true },
  { id: 't-other', engagementId: 'proj-other', title: '其他项目行动', assignee: '我', deadline: '明天', priority: 'low', done: false },
];

const sampleFollowUps: FollowUpItem[] = [
  { id: 'f1', engagementId: 'proj-1', kind: 'waiting', title: '客户确认VI配色与Logo矢量文件', status: 'open', expectedDate: '2026-11-20', sourceMessageId: 'm1', createdAt: 100, updatedAt: 200 },
  { id: 'f2', engagementId: 'proj-1', kind: 'question', title: '是否包含多语言英文站首期开发', status: 'open', sourceMessageId: 'm1', createdAt: 100, updatedAt: 200 },
  { id: 'f3', engagementId: 'proj-1', kind: 'waiting', title: '旧版域名ICP备案主体证明', status: 'resolved', sourceMessageId: 'm1', createdAt: 100, updatedAt: 250 },
];

const sampleConditions: ConditionIntent[] = [
  {
    id: 'c1',
    space: 'work',
    conditionText: '客户发送VI配色与Logo文件',
    actionTitle: '出具两套首页视觉方案并附排期',
    conditionKind: 'followup_resolved',
    status: 'ready',
    engagementId: 'proj-1',
    followUpId: 'f1',
    sourceMessageId: 'm1',
    revision: 2,
    triggeredAt: 300,
    createdAt: 100,
    updatedAt: 300,
  },
];

test('builds all three ArtifactType drafts offline while isolating internalContext and never exposing unrelated projects', () => {
  const project = baseProject();
  for (const type of ['proposal_brief', 'material_checklist', 'meeting_brief'] as const) {
    const draft = buildArtifactDraft({
      type,
      project,
      tasks: sampleTasks,
      followUps: sampleFollowUps,
      conditions: sampleConditions,
      condition: sampleConditions[0],
      now: 5000,
    });
    assert.equal(draft.space, 'work');
    assert.equal(draft.projectId, 'proj-1');
    assert.equal(draft.conditionId, 'c1');
    assert.equal(draft.type, type);
    assert.equal(draft.version, 1);
    assert.equal(draft.status, 'draft');
    assert.ok(draft.title.includes('林总'));
    assert.match(draft.content, /仅基于本机已核对事实生成/);
    assert.match(draft.content, /(不|不会)自动发送/);
    assert.doesNotMatch(draft.content, /65000|底价|仅内部评估/);
    assert.doesNotMatch(draft.content, /其他项目行动/);
    assert.deepEqual(draft.sourceSnapshot, {
      projectUpdatedAt: 1000,
      tasksCount: 2,
      followUpsCount: 3,
      conditionsCount: 1,
    });
  }
});

test('unknown budget stays explicitly blank/unknown and missing details are listed as explicit gaps', () => {
  const sparseProject = baseProject({
    budgetAmount: undefined,
    shareableSummary: '',
    nextAction: '',
  });
  const draft = buildArtifactDraft({
    type: 'proposal_brief',
    project: sparseProject,
    tasks: [],
    followUps: [],
    conditions: [],
    now: 6000,
  });
  assert.match(draft.content, /预算[：:]\s*待定/);
  assert.doesNotMatch(draft.content, /¥\s*\d+/);
  assert.match(draft.content, /缺口与待核对/);
  assert.match(draft.content, /尚未记录公开摘要/);
});

test('computeSourceSnapshot and inspectArtifactStaleness detect both persisted needs_review and snapshot drift after restore', () => {
  const project = baseProject();
  const initialDraft = buildArtifactDraft({
    type: 'meeting_brief',
    project,
    tasks: sampleTasks,
    followUps: sampleFollowUps,
    conditions: sampleConditions,
    now: 5000,
  });
  const cleanState = inspectArtifactStaleness(initialDraft, project, sampleTasks, sampleFollowUps, sampleConditions);
  assert.equal(cleanState.stale, false);
  assert.deepEqual(cleanState.reasons, []);

  // Snapshot drift only (simulating backup restore or external project edit without persisted needs_review yet)
  const mutatedProject = { ...project, updatedAt: 2000 };
  const extraTasks = [...sampleTasks, { id: 't3', engagementId: 'proj-1', title: '新增联调', assignee: '我', deadline: '下周', priority: 'medium', done: false } as ProjectTaskItem];
  const driftState = inspectArtifactStaleness(initialDraft, mutatedProject, extraTasks, sampleFollowUps, sampleConditions);
  assert.equal(driftState.stale, true);
  assert.equal(driftState.snapshotChanged, true);
  assert.ok(driftState.reasons.some(r => /项目概况已更新/.test(r)));
  assert.ok(driftState.reasons.some(r => /行动数量变化（2 → 3）/.test(r)));

  // Persisted needs_review surfaces explicit reviewReason alongside snapshot checks
  const persistedReviewDraft: ArtifactDraft = {
    ...initialDraft,
    status: 'needs_review',
    reviewReason: '关联来源原文已删除',
  };
  const persistedState = inspectArtifactStaleness(persistedReviewDraft, project, sampleTasks, sampleFollowUps, sampleConditions);
  assert.equal(persistedState.stale, true);
  assert.equal(persistedState.persistedReview, true);
  assert.ok(persistedState.reasons.includes('关联来源原文已删除'));
});

test('confirmArtifactReady and applyArtifactRebuild support keeping user edits or rebuilding fresh versions cleanly', () => {
  const project = baseProject();
  const initialDraft = buildArtifactDraft({
    type: 'material_checklist',
    project,
    tasks: sampleTasks,
    followUps: sampleFollowUps,
    conditions: sampleConditions,
    now: 5000,
  });
  const ready = confirmArtifactReady({ ...initialDraft, status: 'needs_review', reviewReason: '旧变更' }, 6000);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.reviewReason, undefined);
  assert.equal(ready.updatedAt, 6000);

  const edited: ArtifactDraft = {
    ...ready,
    title: '用户定制标题',
    content: '用户手工精修的正文内容',
    status: 'needs_review',
    reviewReason: '关联行动已变更',
  };
  const updatedProject = { ...project, updatedAt: 9000 };
  const snapshot = computeSourceSnapshot(updatedProject, sampleTasks, sampleFollowUps, sampleConditions);

  // Mode keep_content preserves manual title & content while syncing snapshot to v2
  const synced = applyArtifactRebuild(edited, { project: updatedProject, tasks: sampleTasks, followUps: sampleFollowUps, conditions: sampleConditions }, 'keep_content', 9500);
  assert.equal(synced.version, 2);
  assert.equal(synced.status, 'draft');
  assert.equal(synced.reviewReason, undefined);
  assert.equal(synced.title, '用户定制标题');
  assert.equal(synced.content, '用户手工精修的正文内容');
  assert.deepEqual(synced.sourceSnapshot, snapshot);

  // Mode rebuild regenerates template text from updated facts as v3
  const rebuilt = applyArtifactRebuild(synced, { project: { ...updatedProject, nextAction: '周一同步新原型' }, tasks: sampleTasks, followUps: sampleFollowUps, conditions: sampleConditions }, 'rebuild', 9900);
  assert.equal(rebuilt.version, 3);
  assert.equal(rebuilt.status, 'draft');
  assert.match(rebuilt.content, /周一同步新原型/);
});
