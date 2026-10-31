import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateEngine } from '../src/services/stateEngine';
import type { WorkPartition } from '../src/types';
const now = Date.parse('2026-10-29T04:00:00Z');
const empty = (): WorkPartition => ({ revision: 0, engagements: [], tasks: [], followUps: [], events: [], messages: [], memories: [], journals: [], customCards: [], processedProposalIds: [] });
const parse = (text: string, extra = {}) => StateEngine.propose(text, { mode: 'work', sourceMessageId: 'synthetic-language-check', partition: empty(), now, ...extra });

test('trial language matrix preserves units and corrections across new synthetic budget expressions', () => {
  const cases: [string, number | undefined][] = [
    ['李总预算300元', 300], ['李总报价1.2万', 12000], ['李总预算5k', 5000],
    ['李总预算从8万改为12万', 120000], ['李总预算300，单位还没说清', undefined],
    ['李总预算8万先别定', undefined], ['李总预算8万还没拍板', undefined],
    ['李总预算可能是8万', undefined], ['李总预算8万待确认', undefined],
  ];
  for (const [text, expected] of cases) {
    const proposal = parse(text);
    const amount = proposal.operations.find(item => item.target === 'engagement')?.after?.budgetAmount;
    assert.equal(amount, expected, text);
  }
});
test('trial language matrix never turns negative, hypothetical or future plans into a won deal', () => {
  for (const text of ['李总目前还没成交', '李总没有签合同', '如果李总成交预算12万', '李总预计下周签约', '李总明天签合同']) {
    assert.equal(parse(text).operations.some(item => item.target === 'engagement' && item.after?.stage === '赢单成交'), false, text);
  }
});
test('trial language keeps ordinary-name ambiguity and explicit customer date separate from my reminder', () => {
  const ambiguous = parse('张三预算300元'); assert.equal(ambiguous.clarification?.kind, 'project'); assert.equal(ambiguous.operations.length, 0);
  const explicit = parse('我周五发原型，客户下周一补素材', { newClientName: '张三', newProjectTitle: '合成官网' });
  const own = explicit.operations.find(item => item.target === 'task')?.after;
  const waiting = explicit.operations.find(item => item.target === 'followup' && item.after?.kind === 'waiting')?.after;
  assert.equal(own?.dueAt, '2026-10-30T01:00:00.000Z'); assert.equal(waiting?.expectedDate, '2026-11-02');
  assert.equal(waiting?.expectedAt, undefined); assert.equal(waiting?.reviewAt, undefined);
});
