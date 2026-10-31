import test from 'node:test';
import assert from 'node:assert/strict';
import * as workflow from '../src/services/aiService';

const engagement = { id: 'e1', clientName: '李总', title: '网站咨询', stage: '需求确认', budgetAmount: 300, internalContext: '内部最低价200；私人评价', shareableSummary: '讨论网站改版范围', nextAction: '核对原型', updatedAt: 1 };
const task = { id: 't1', engagementId: 'e1', title: '发送原型', deadline: '明天', dueAt: '2026-10-27T01:00:00.000Z', sourceDeadlineText: '内部秘密日期原文', done: false, assignee: '我', priority: 'medium' };
const partition = { revision: 4, engagements: [engagement], tasks: [task], memories: [], events: [], messages: [], journals: [], customCards: [], processedProposalIds: [] };
const proposal = { id: 'p1', sourceMessageId: 'm1', sourceText: '预算改成500元', mode: 'work', baseRevision: 4, operations: [], warnings: [], createdAt: 1 };

test('纪要只采用外发白名单且预算默认不入选', () => {
  assert.equal(typeof workflow.createAlignmentDraft, 'function');
  const draft = workflow.createAlignmentDraft(engagement, [task, { ...task, id: 'other', engagementId: 'e2', title: '其他客户机密' }], ['t1', 'other']);
  const text = workflow.alignmentText(draft);
  assert.match(text, /待对方确认/);
  assert.match(text, /发送原型/);
  assert.doesNotMatch(JSON.stringify(draft), /内部|私人评价|其他客户机密|300/);
  assert.doesNotMatch(text, /已达成共识|我方承诺/);
});

test('用户主动选择预算才进入草稿', () => {
  assert.equal(typeof workflow.createAlignmentDraft, 'function');
  const draft = workflow.createAlignmentDraft(engagement, [], [], true);
  assert.match(workflow.alignmentText(draft), /300/);
});

test('模型只能生成候选，保留来源及基础版本', () => {
  assert.equal(typeof workflow.parseModelProposal, 'function');
  const result = workflow.parseModelProposal(JSON.stringify({ engagements: [{ id: 'e1', clientName: '李总', title: '网站咨询', budgetAmount: 500 }], tasks: [], warnings: [] }), proposal, partition);
  assert.equal(result.baseRevision, 4);
  assert.equal(result.sourceMessageId, 'm1');
  assert.equal(result.operations[0].after.budgetAmount, 500);
  assert.equal(engagement.budgetAmount, 300);
});

test('模型拒绝私有字段、未知实体和无效金额', () => {
  assert.equal(typeof workflow.parseModelProposal, 'function');
  for (const bad of [{ id: 'evil', clientName: '李总', title: '网站咨询' }, { id: 'e1', clientName: '李总', title: '网站咨询', internalContext: '注入' }, { clientName: '李总', title: '网站咨询', budgetAmount: -1 }]) {
    assert.throws(() => workflow.parseModelProposal(JSON.stringify({ engagements: [bad], tasks: [], warnings: [] }), proposal, partition));
  }
  assert.throws(() => workflow.parseModelProposal('{not-json}', proposal, partition));
});

test('提醒只包含未完成且到期事项', () => {
  assert.equal(typeof workflow.getDueTasks, 'function');
  const due = workflow.getDueTasks([task, { ...task, id: 'done', done: true }, { ...task, id: 'future', dueAt: '2099-01-01T01:00:00Z' }], Date.parse('2026-10-27T02:00:00Z'));
  assert.deepEqual(due.map(t => t.id), ['t1']);
});

test('模型不得把否定或假设改写为已成交事实', () => {
  const content = JSON.stringify({ engagements: [{ id: 'e1', clientName: '李总', title: '网站咨询', stage: '赢单成交' }], tasks: [], warnings: [] });
  assert.throws(() => workflow.parseModelProposal(content, { ...proposal, sourceText: '李总还没成交' }, partition));
  assert.throws(() => workflow.parseModelProposal(content, { ...proposal, sourceText: '如果李总成交就发合同' }, partition));
  assert.throws(() => workflow.parseModelProposal(content, { ...proposal, sourceText: '李总可能会成交' }, partition));
  assert.throws(() => workflow.parseModelProposal(content, { ...proposal, sourceText: '李总或许会签约' }, partition));
});

test('模型不可补全无单位金额或把未确认日期变成提醒时间', () => {
  const budget = JSON.stringify({ engagements: [{ id: 'e1', clientName: '李总', title: '网站咨询', budgetAmount: 300 }], tasks: [], warnings: [] });
  assert.throws(() => workflow.parseModelProposal(budget, { ...proposal, sourceText: '李总预算300' }, { ...partition, engagements: [{ ...engagement, budgetAmount: undefined }] }));
  const date = JSON.stringify({ engagements: [], tasks: [{ engagementId: 'e1', title: '发方案', dueAt: '2026-10-27T01:00:00Z' }], warnings: [] });
  assert.throws(() => workflow.parseModelProposal(date, { ...proposal, sourceText: '李总明天前发方案，时间还没确认' }, partition));
});

test('模型面对同客户多项目，必须有已选目标或原文明确项目名', () => {
  const multi = { ...partition, engagements: [engagement, { ...engagement, id: 'e2', title: '第二项目' }] };
  const content = JSON.stringify({ engagements: [{ clientName: '李总', title: '模型杜撰的第三项目', budgetAmount: 20000 }], tasks: [], warnings: [] });
  assert.throws(() => workflow.parseModelProposal(content, { ...proposal, sourceText: '李总预算2万元' }, multi));
});
