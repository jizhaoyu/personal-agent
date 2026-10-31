import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateEngine } from '../src/services/stateEngine';
import { parseModelProposal } from '../src/services/aiService';
import type { Engagement, ProposedChangeSet, WorkPartition } from '../src/types';

let capture: any = {};
try { capture = require('../src/services/capture'); } catch { /* RED: assert missing behavior, not import syntax. */ }
const now = Date.parse('2026-10-27T04:00:00Z');
const project: Engagement = { id: 'project-1', clientName: '张三', title: '网站设计', budgetAmount: 80000,
  stage: '需求确认', internalContext: '', shareableSummary: '', nextAction: '', updatedAt: 10 };
const partition = (projects: Engagement[] = []): WorkPartition => ({ revision: 4, engagements: projects, tasks: [], followUps: [],
  messages: [], memories: [], journals: [], customCards: [], events: [], processedProposalIds: [] });
const propose = (text: string, extra: any = {}) => StateEngine.propose(text, { mode: 'work', sourceMessageId: 'source-1', now,
  partition: partition([project]), selectedEngagementId: 'project-1', ...extra });

test('capture draft keeps an independent source version across review edits and changes it with input or binding', () => {
  assert.equal(typeof capture.createCaptureDraft, 'function');
  const empty = capture.createCaptureDraft(now);
  assert.equal(empty.id, 'active-work'); assert.equal(empty.mode, 'work'); assert.equal(empty.status, 'editing');
  const input = capture.reviseCaptureDraft(empty, { text: '张三的网站' }, now + 1);
  assert.equal(input.sourceVersion, empty.sourceVersion + 1);
  assert.notEqual(input.sourceMessageId, empty.sourceMessageId);
  const review = capture.reviseCaptureDraft(input, { proposal: propose('预算300元'), status: 'review' }, now + 2);
  assert.equal(review.sourceMessageId, input.sourceMessageId); assert.equal(review.sourceVersion, input.sourceVersion);
  assert.equal(review.draftVersion, input.draftVersion + 1);
  const changed = capture.reviseCaptureDraft(review, { newClientName: '李四' }, now + 3);
  assert.equal(changed.status, 'editing'); assert.equal(changed.proposal, undefined); assert.equal(changed.conflicts, undefined);
  assert.notEqual(changed.sourceMessageId, input.sourceMessageId);
  assert.equal(empty.text, '');
});

test('ordinary name requires an explicit binding instead of guessing a person', () => {
  const unknown = StateEngine.propose('张三预算300元', { mode: 'work', sourceMessageId: 'm', now, partition: partition() });
  assert.equal(unknown.operations.length, 0); assert.equal(unknown.clarification?.kind, 'project');
  const bound = StateEngine.propose('张三预算300元', { mode: 'work', sourceMessageId: 'm', now, partition: partition(),
    newClientName: '张三', newProjectTitle: '官网' } as any);
  const operation = bound.operations.find(item => item.target === 'engagement');
  assert.equal(operation?.after?.clientName, '张三'); assert.equal(operation?.after?.title, '官网');
  assert.equal(operation?.after?.budgetAmount, 300); assert.equal(operation?.before, null);
  assert.equal(partition().engagements.length, 0);
});

test('closure extraction separates my deadline, customer waiting date and unconfirmed fee', () => {
  const result = propose('我周五发原型，客户下周一补素材，新增页面费用还没有确定');
  const tasks = result.operations.filter(item => item.target === 'task').map(item => item.after);
  const followups = result.operations.filter(item => item.target === 'followup').map(item => item.after);
  assert.deepEqual(tasks.map(item => item?.title), ['发原型']);
  assert.equal(tasks[0]?.dueAt, '2026-10-30T01:00:00.000Z');
  const waiting = followups.find(item => item?.kind === 'waiting');
  assert.equal(waiting?.title, '补素材'); assert.equal(waiting?.expectedDate, '2026-11-02');
  assert.equal(waiting?.expectedAt, undefined); assert.equal(waiting?.reviewAt, undefined);
  assert.equal(waiting?.sourceMessageId, 'source-1');
  assert.ok(followups.some(item => item?.kind === 'question' && /费用/.test(item.title)));
  assert.ok(!result.operations.some(item => item.target === 'engagement' && item.after?.budgetAmount !== 80000));
});
test('one explicit client carries the same conversation across a full stop without losing the closing actions', () => {
  const result = StateEngine.propose('李总的网站改版，预算300元。我周五发首页原型，客户下周一补素材，新增页面费用还没谈定。', {
    mode: 'work', sourceMessageId: 'source', now, partition: partition(),
  });
  assert.equal(result.clarification, undefined);
  assert.equal(result.operations.filter(item => item.target === 'engagement').length, 1);
  assert.ok(result.operations.some(item => item.target === 'task' && item.after?.title === '发首页原型'));
  assert.ok(result.operations.some(item => item.target === 'followup' && item.after?.kind === 'waiting'));
  assert.ok(result.operations.some(item => item.target === 'followup' && item.after?.kind === 'question'));
});

test('customer explicit clock is kept without silently scheduling my follow-up reminder', () => {
  const result = propose('客户下周一下午3点发素材');
  const waiting = result.operations.find(item => item.target === 'followup')?.after;
  assert.equal(waiting?.kind, 'waiting'); assert.equal(waiting?.expectedAt, '2026-11-02T07:00:00.000Z');
  assert.equal(waiting?.expectedDate, undefined); assert.equal(waiting?.reviewAt, undefined);
  assert.equal(result.operations.filter(item => item.target === 'task').length, 0);
});

test('uncertain responsibility is kept as a question rather than assigned to me', () => {
  const result = propose('周五发原型，负责人还没确定');
  assert.equal(result.operations.filter(item => item.target === 'task').length, 0);
  assert.ok(result.operations.some(item => item.target === 'followup' && item.after?.kind === 'question'));
});

test('a selected client name in a later clause is customer work, while my action stays mine', () => {
  const result = propose('我周五发原型，张三下周一发素材');
  assert.deepEqual(result.operations.filter(item => item.target === 'task').map(item => item.after?.title), ['发原型']);
  assert.ok(result.operations.some(item => item.target === 'followup' && item.after?.kind === 'waiting' && item.after.title === '发素材'));
});

test('explicit new-client binding stays one project across sentences and keeps missing-unit questions', () => {
  const result = StateEngine.propose('我周五发原型。客户下周一补素材。预算300，单位还没说清。', { mode: 'work', sourceMessageId: 'm', now,
    partition: partition(), newClientName: '张三', newProjectTitle: '官网' } as any);
  const projects = result.operations.filter(item => item.target === 'engagement');
  assert.equal(projects.length, 1);
  assert.ok(result.operations.filter(item => item.target === 'followup').every(item => item.after?.engagementId === projects[0].entityId));
  assert.ok(result.operations.some(item => item.target === 'followup' && item.after?.kind === 'question' && /单位/.test(item.after.title)));
  assert.deepEqual(StateEngine.validate(result, partition()), []);
});

test('three-way rebase keeps user edits, adopts unrelated new fields and exposes real conflicts', () => {
  assert.equal(typeof capture.rebaseProposal, 'function');
  const proposal: ProposedChangeSet = { id: 'p', sourceMessageId: 's', sourceText: '预算改为12万', mode: 'work', baseRevision: 4,
    operations: [{ target: 'engagement', entityId: project.id, before: project, after: { ...project, budgetAmount: 120000, title: '人工修正标题' } }], warnings: [], createdAt: now };
  const current = { ...project, budgetAmount: 100000, nextAction: '已更新的后续', updatedAt: 11 };
  const result = capture.rebaseProposal(proposal, { ...partition([current]), revision: 5 });
  assert.equal(result.proposal.baseRevision, 5); assert.equal(result.conflicts.length, 1);
  assert.deepEqual({ field: result.conflicts[0].field, original: result.conflicts[0].original, current: result.conflicts[0].current, proposed: result.conflicts[0].proposed },
    { field: 'budgetAmount', original: 80000, current: 100000, proposed: 120000 });
  assert.equal(result.proposal.operations[0].after.title, '人工修正标题');
  assert.equal(result.proposal.operations[0].after.nextAction, '已更新的后续');
  const resolved = capture.resolveProposalConflict(result.proposal, result.conflicts, result.conflicts[0].id, 'current');
  assert.equal(resolved.conflicts.length, 0); assert.equal(resolved.proposal.operations[0].after.budgetAmount, 100000);
  assert.equal(project.budgetAmount, 80000);
});

test('rebase does not silently recreate a deleted entity and a current choice drops that old update', () => {
  const proposal = propose('预算改为12万元');
  const result = capture.rebaseProposal(proposal, { ...partition(), revision: 5 });
  assert.equal(result.conflicts[0].field, '$entity');
  const resolved = capture.resolveProposalConflict(result.proposal, result.conflicts, result.conflicts[0].id, 'current');
  assert.equal(resolved.proposal.operations.length, 0); assert.equal(resolved.conflicts.length, 0);
});

test('legacy model response retains local waiting and questions, with valid remapped new-project links', () => {
  const local = StateEngine.propose('我周五发原型，客户下周一补素材，新增页面费用未定', { mode: 'work', sourceMessageId: 'm', now,
    partition: partition(), newClientName: '张三', newProjectTitle: '官网' } as any);
  const result = parseModelProposal(JSON.stringify({ engagements: [{ clientName: '张三', title: '官网' }], tasks: [], warnings: [] }), local, partition());
  const created = result.operations.find(item => item.target === 'engagement')!;
  const waiting = result.operations.find(item => item.target === 'followup' && item.after?.kind === 'waiting')!;
  assert.ok(waiting); assert.equal(waiting.after?.engagementId, created.entityId);
  assert.ok(result.operations.some(item => item.target === 'followup' && item.after?.kind === 'question'));
});

test('model cannot reassign explicit customer work to me or invent a clock for a date-only promise', () => {
  const local = propose('客户下周一发素材');
  assert.throws(() => parseModelProposal(JSON.stringify({ engagements: [], tasks: [{ engagementId: project.id, title: '发素材' }], warnings: [] }), local, partition([project]), project.id), /客户|责任|我方/);
  assert.throws(() => parseModelProposal(JSON.stringify({ engagements: [], tasks: [], followups: [{ kind: 'waiting', engagementId: project.id, title: '发素材', expectedAt: '2026-11-02T01:00:00Z', sourceDateText: '下周一' }], warnings: [] }), local, partition([project]), project.id), /时刻|日期|时间/);
});

test('model customer dates must match their quoted source rather than an arbitrary valid calendar value', () => {
  const local = propose('客户下周一发素材');
  assert.throws(() => parseModelProposal(JSON.stringify({ engagements: [], tasks: [], followups: [{ kind: 'waiting', engagementId: project.id, title: '发素材', expectedDate: '2099-01-01' }], warnings: [] }), local, partition([project]), project.id), /日期|原文/);
  const clock = propose('客户下周一下午3点发素材');
  assert.throws(() => parseModelProposal(JSON.stringify({ engagements: [], tasks: [], followups: [{ kind: 'waiting', engagementId: project.id, title: '发素材', expectedAt: '2099-01-01T07:00:00Z', sourceDateText: '下周一下午3点' }], warnings: [] }), clock, partition([project]), project.id), /时间|原文/);
});
