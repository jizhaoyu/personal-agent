import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelProposal } from '../src/services/aiService';
import { StateEngine } from '../src/services/stateEngine';
import type { WorkPartition } from '../src/types';

const now = Date.parse('2026-10-27T04:00:00Z');
const empty = (): WorkPartition => ({ revision: 0, engagements: [], tasks: [], followUps: [], messages: [], memories: [], journals: [], customCards: [], events: [], processedProposalIds: [] });
const local = () => StateEngine.propose('张三预算300元', { mode: 'work', sourceMessageId: 'source', now, partition: empty(), newClientName: '张三', newProjectTitle: '官网' });

test('model cannot invent another client merely by omitting its entity ID', () => {
  assert.throws(() => parseModelProposal(JSON.stringify({ engagements: [{ clientName: '李四', title: '官网' }], tasks: [], warnings: [] }), local(), empty()), /客户|归属|项目/);
  const accepted = parseModelProposal(JSON.stringify({ engagements: [{ clientName: '张三', title: '官网' }], tasks: [], warnings: [] }), local(), empty());
  assert.equal(accepted.operations.filter(item => item.target === 'engagement').length, 1);
});

test('model task timestamps reject impossible calendar days without normalizing them', () => {
  assert.throws(() => parseModelProposal(JSON.stringify({ engagements: [], tasks: [{ title: '发原型', dueAt: '2026-02-31T01:00:00Z' }], warnings: [] }), local(), empty()), /日期|时间/);
});

test('model task updates stay within the selected project even when the model omits its ID', () => {
  const first = { id: 'one', clientName: '张三', title: '官网', stage: '需求确认', internalContext: '', shareableSummary: '', nextAction: '', updatedAt: 1 };
  const second = { ...first, id: 'two', title: '小程序' };
  const partition = { ...empty(), engagements: [first, second], tasks: [{ id: 'other-action', title: '审核页面', engagementId: 'two', assignee: '我', deadline: '', done: false, priority: 'medium' as const }] };
  const base = StateEngine.propose('我周五发原型', { mode: 'work', sourceMessageId: 'source', now, partition, selectedEngagementId: 'one' });
  for (const task of [{ title: '发原型', engagementId: 'two' }, { id: 'other-action', title: '发原型' }]) {
    assert.throws(() => parseModelProposal(JSON.stringify({ engagements: [], tasks: [task], warnings: [] }), base, partition, 'one'), /选中|选定|归属/);
  }
  const result = parseModelProposal(JSON.stringify({ engagements: [], tasks: [{ title: '发原型' }], warnings: [] }), base, partition, 'one');
  assert.equal(result.operations.find(item => item.target === 'task')?.after?.engagementId, 'one');
});
