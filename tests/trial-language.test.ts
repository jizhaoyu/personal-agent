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
test('budget corrections ignore scheduling numbers and retain the last valid amount', () => {
  const cases: [string, number | undefined][] = [
    ['李总预算5万，会议改到3点', 50000],
    ['李总预算5万，会议定在3点', 50000],
    ['李总预算5万，会议加到3点', 50000],
    ['李总预算5万，交付改到15号', 50000],
    ['李总预算5万，交付调整到15日', 50000],
    ['李总预算5万，会议改到三点', 50000],
    ['李总预算5万，会议改到￥3点', 50000],
    ['李总预算5万，交付改到3元号', 50000],
    ['李总预算5万，改为6万，会议改到3点', 60000],
    ['李总预算5万，改为￥60000', 60000],
    ['李总预算5万，改为六万', 60000],
    ['李总预算5万，改为6万，改为7万', 70000],
    ['李总预算5万，改到3', 50000],
    ['李总会议改到3点', undefined],
    ['李总预算300', undefined],
  ];
  for (const [text, expected] of cases) {
    const proposal = parse(text);
    assert.equal(proposal.operations.find(item => item.target === 'engagement')?.after?.budgetAmount, expected, text);
    assert.equal(proposal.warnings.some(warning => warning.includes('金额缺少单位')), text === '李总预算300', text);
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

test('trial language regressions cover client splits, mixed numerals, uncertain units, tasks, and stages', () => {
  // W-BIZ-04 & U-WCRM-01: no phantom total-price client split; mixed/sum amounts & stage advance
  const lin = parse('林工那单总价四千五，合同已经签好了，尾款已到账');
  const linEngs = lin.operations.filter(o => o.target === 'engagement').map(o => o.after);
  assert.equal(linEngs.length, 1);
  assert.equal(linEngs[0]?.clientName, '林工');
  assert.equal(linEngs[0]?.budgetAmount, 4500);
  assert.equal(linEngs[0]?.stage, '赢单成交');

  const liu = parse('刘总那笔总额六千八，尾款已经收到');
  const liuEng = liu.operations.find(o => o.target === 'engagement')?.after;
  assert.equal(liuEng?.budgetAmount, 6800);
  assert.equal(liuEng?.stage, '赢单成交');

  // W-BIZ-08: ambiguous unit keeps question and leaves budgetAmount undefined
  const zhou = parse('周总监报价350，还没说明白是万还是块');
  assert.equal(zhou.operations.find(o => o.target === 'engagement')?.after?.budgetAmount, undefined);
  assert.ok(zhou.operations.some(o => o.target === 'followup' && o.after?.kind === 'question' && o.after.title === '确认周总监报价350的金额单位'));

  // W-BIZ-03: digital wan/qian shorthand and inline project title
  const zheng = parse('郑老板电商小程序预算8万5，已发方案');
  const zhengEng = zheng.operations.find(o => o.target === 'engagement')?.after;
  assert.equal(zhengEng?.clientName, '郑老板');
  assert.equal(zhengEng?.title, '电商小程序');
  assert.equal(zhengEng?.budgetAmount, 85000);
  assert.equal(zhengEng?.stage, '方案报价');
  assert.equal(parse('李总预算1万2').operations.find(o => o.target === 'engagement')?.after?.budgetAmount, 12000);

  // W-BIZ-15: client callback waiting with uncertain clock sets neither expectedAt nor expectedDate
  const xu = parse('徐老师确认明天给我回电话，具体几点没定');
  assert.equal(xu.operations.filter(o => o.target === 'task').length, 0);
  const xuWait = xu.operations.find(o => o.target === 'followup' && o.after?.kind === 'waiting')?.after;
  assert.equal(xuWait?.title, '给我回电话');
  assert.equal(xuWait?.expectedAt, undefined);
  assert.equal(xuWait?.expectedDate, undefined);

  // W-BIZ-01, U-WFLOW-02, W-MP-03, W-BIZ-16: own tasks and scoped responsibility question
  const demo = parse('李总，下周二上午10点我过去演示原型');
  const demoTask = demo.operations.find(o => o.target === 'task')?.after;
  assert.equal(demoTask?.title, '演示原型');
  assert.ok(demoTask?.dueAt);

  const joint = parse('陈总，下周四下午三点我过去现场联调');
  const jointTask = joint.operations.find(o => o.target === 'task')?.after;
  assert.ok(jointTask?.title.includes('联调'));
  assert.ok(jointTask?.dueAt);

  const quoteTask = parse('李总，周五前我把报价表发过去').operations.find(o => o.target === 'task')?.after;
  assert.equal(quoteTask?.title, '把报价表发过去');
  assert.ok(quoteTask?.dueAt);

  const tian = parse('田院长那边谁来负责硬件采购还没确定，周五前对接一下采购流程');
  assert.ok(tian.operations.some(o => o.target === 'followup' && o.after?.kind === 'question' && o.after.title.includes('谁来负责硬件采购还没确定')));
  const tianTask = tian.operations.find(o => o.target === 'task')?.after;
  assert.equal(tianTask?.title, '对接一下采购流程');
  assert.ok(tianTask?.dueAt);

  // W-BIZ-02, W-BIZ-05, W-BIZ-09, U-WFLOW-04: stage transitions & W-BIZ-12 hypothetical guard
  assert.equal(parse('马经理的看板项目已经发报价单了').operations.find(o => o.target === 'engagement')?.after?.stage, '方案报价');
  assert.equal(parse('刘总方案报价阶段了').operations.find(o => o.target === 'engagement')?.after?.stage, '方案报价');
  assert.equal(parse('赵总需求已经聊清楚').operations.find(o => o.target === 'engagement')?.after?.stage, '需求确认');
  assert.equal(parse('如果客户能提前把资料发来，我就周五前出稿').operations.length, 0);
});
