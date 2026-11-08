import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { StorageService, SNAPSHOT_KEY } from '../src/services/storage';
import { StateEngine } from '../src/services/stateEngine';

class MemoryStorage {
  data = new Map<string, string>();
  fail = false;
  writes = 0;
  failAt = Infinity;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes++; if (this.fail || this.writes === this.failAt) throw new Error('QuotaExceededError'); this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}
let store: MemoryStorage;
beforeEach(() => { store = new MemoryStorage(); Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store }); });
function propose(text: string, selectedEngagementId?: string) {
  return StateEngine.propose(text, { mode: 'work', sourceMessageId: `m-${text}`, partition: StorageService.getSnapshot().partitions.work,
    now: new Date('2026-10-26T04:00:00Z').getTime(), selectedEngagementId });
}
function addClient(name = '王总', amount = 300) {
  const proposal = propose(`${name}预算${amount}元`);
  assert.equal(StorageService.commit(proposal).ok, true);
  return StorageService.getSnapshot().partitions.work.engagements[0];
}

test('fresh real workspace is empty and stores public settings only', () => {
  assert.equal(typeof StorageService.getSnapshot, 'function', 'versioned snapshot API is required');
  const snapshot = StorageService.getSnapshot();
  assert.equal(snapshot.schemaVersion, 3);
  assert.equal(snapshot.partitions.work.engagements.length, 0);
  assert.equal(snapshot.partitions.life.wallet.entries.length, 0);
  assert.equal(snapshot.partitions.life.memories.length, 0);
  assert.equal(snapshot.partitions.life.persons.length, 0);
  assert.ok(!('apiKey' in snapshot.settings));
});
test('proposal parser never persists and preserves explicit yuan units', () => {
  const proposal = propose('王总预算300元');
  assert.equal(proposal.operations[0].after.budgetAmount, 300);
  assert.equal(StorageService.getSnapshot().partitions.work.engagements.length, 0);
});
test('budget correction uses final amount rather than old amount', () => {
  const client = addClient('王总', 80000);
  const proposal = propose('王总预算从8万改为12万', client.id);
  assert.equal(proposal.operations.find(op => op.target === 'engagement').after.budgetAmount, 120000);
});
test('negative and hypothetical closing language never proposes a won stage', () => {
  addClient();
  for (const text of ['王总还没成交', '如果王总成交预算12万', '王总准备签合同', '王总没有打款', '王总可能成交了', '王总或许会签约', '王总也许已经打款']) {
    const proposal = propose(text);
    assert.ok(!proposal.operations.some(op => op.target === 'engagement' && op.after?.stage === '赢单成交'), text);
  }
});
test('missing unit is a warning and never invented budget', () => {
  const proposal = propose('王总预算300');
  assert.ok(proposal.warnings.length > 0);
  assert.equal(proposal.operations.find(op => op.target === 'engagement')?.after.budgetAmount, undefined);
});
test('missing person never silently updates first client', () => {
  addClient();
  const proposal = propose('预算12万');
  assert.equal(proposal.operations.length, 0);
  assert.ok(proposal.warnings.length > 0);
});
test('selected project supports a follow-up without repeating person', () => {
  const client = addClient();
  const proposal = propose('预算改为12万', client.id);
  assert.equal(proposal.operations[0].entityId, client.id);
  assert.equal(proposal.operations[0].after.budgetAmount, 120000);
});
test('same client with multiple projects requires an explicit selection', () => {
  const first = addClient();
  const second = { ...first, id: 'project-2', title: '第二个项目' };
  assert.equal(StorageService.commit(StorageService.createProposal('work', [{ target: 'engagement', entityId: second.id, before: null, after: second }], '手动新建项目')).ok, true);
  const ambiguous = propose('王总预算2万');
  assert.equal(ambiguous.operations.length, 0);
  assert.ok(ambiguous.warnings.some(item => item.includes('多个')));
  const selected = propose('王总预算2万', second.id);
  assert.equal(selected.operations[0].entityId, second.id);
});
test('future contract signing is a task, never a won deal', () => {
  const proposal = propose('王总预算8万，下周三签合同');
  assert.equal(proposal.operations.find(op => op.target === 'engagement').after.stage, '初步接触');
  assert.equal(proposal.operations.find(op => op.target === 'task')?.after.title, '签合同');
});
test('double negation and future plan do not assert confirmed stages', () => {
  const client = addClient();
  for (const sentence of ['王总不是需求确认阶段', '王总计划成交', '王总尚未签约']) {
    const proposal = propose(sentence, client.id);
    assert.ok(!proposal.operations.some(op => op.target === 'engagement' && op.after?.stage !== client.stage), sentence);
  }
});
test('unconfirmed or tentative budgets are warned about and never assigned a definite value', () => {
  for (const text of ['李总还没确认预算300元', '李总预算300元还没确认', '李总预算可能300元', '李总预算暂定300元', '李总预算约300元', '李总预算300元，金额待定']) {
    const proposal = propose(text);
    assert.ok(proposal.warnings.some(item => /金额|预算/.test(item)), text);
    assert.ok(!proposal.operations.some(op => op.target === 'engagement' && op.after?.budgetAmount !== undefined), text);
  }
});
test('budget uncertainty does not erase a known budget or mask an independently confirmed amount', () => {
  const client = addClient('李总', 1000);
  const uncertain = propose('李总还没确认预算300元', client.id);
  assert.ok(!uncertain.operations.some(op => op.target === 'engagement' && op.after?.budgetAmount !== 1000));
  const confirmed = propose('李总还没成交，已确认预算300元', client.id);
  assert.equal(confirmed.operations.find(op => op.target === 'engagement')?.after.budgetAmount, 300);
});
test('unconfirmed or tentative task dates retain source text but have no scheduled dueAt', () => {
  for (const text of ['李总明天前发方案，时间还没确认', '李总暂定明天前发方案', '李总明天前发方案，日期待定', '李总明天前发方案，时间可能调整']) {
    const proposal = propose(text);
    const task = proposal.operations.find(op => op.target === 'task')?.after;
    assert.ok(task, text);
    assert.equal(task.dueAt, undefined, text);
    assert.ok(task.sourceDeadlineText.includes('明天'), text);
    assert.ok(proposal.warnings.some(item => /时间|日期/.test(item)), text);
  }
  const confirmed = propose('李总明天前发方案，预算还没确认');
  assert.ok(confirmed.operations.find(op => op.target === 'task')?.after.dueAt);
});
test('a standalone negative closing tail refers only to the unique project in the current input', () => {
  const proposal = propose('李总预算300元，明天前发方案。还没成交');
  assert.equal(proposal.operations.filter(op => op.target === 'engagement').length, 1);
  assert.ok(proposal.warnings.some(item => item.includes('未推进成交')));
  assert.ok(!proposal.warnings.some(item => item.includes('未明确客户')));
  assert.equal(proposal.operations.find(op => op.target === 'engagement').after.stage, '初步接触');
  const ambiguous = propose('王总预算300元；李总预算500元；还没成交');
  assert.ok(ambiguous.warnings.some(item => item.includes('未明确客户')));
});
test('multiple clients are parsed separately in one atomic batch', () => {
  const proposal = propose('王总预算300元；李总预算2万，明天前交方案');
  assert.equal(proposal.operations.filter(op => op.target === 'engagement').length, 2);
  assert.equal(StorageService.commit(proposal).ok, true);
  assert.equal(StorageService.getSnapshot().partitions.work.engagements.length, 2);
  assert.equal(StorageService.getSnapshot().partitions.work.tasks.length, 1);
});
test('commit is idempotent and LIFO undo restores data', () => {
  const proposal = propose('王总预算300元，明天前交方案');
  assert.equal(StorageService.commit(proposal).ok, true);
  assert.equal(StorageService.commit(proposal).ok, true);
  const partition = StorageService.getSnapshot().partitions.work;
  assert.equal(partition.engagements.length, 1);
  assert.equal(partition.events.length, 1);
  assert.equal(StorageService.undo('work').ok, true);
  assert.equal(StorageService.getSnapshot().partitions.work.engagements.length, 0);
  assert.equal(StorageService.getSnapshot().partitions.work.tasks.length, 0);
});
test('stale proposal is rejected instead of overwriting later changes', () => {
  const first = propose('王总预算300元');
  const second = propose('李总预算500元');
  assert.equal(StorageService.commit(first).ok, true);
  assert.equal(StorageService.commit(second).ok, false);
});
test('storage write failure preserves previous snapshot', () => {
  const proposal = propose('王总预算300元');
  const before = store.getItem(SNAPSHOT_KEY);
  store.fail = true;
  assert.equal(StorageService.commit(proposal).ok, false);
  assert.equal(store.getItem(SNAPSHOT_KEY), before);
  assert.equal(StorageService.getSnapshot().partitions.work.engagements.length, 0);
});
test('working text never mutates life data or calls old direct mutation', () => {
  const before = StorageService.getSnapshot().partitions.life;
  const proposal = propose('王总预算300元，午饭花了35元');
  assert.equal(StorageService.commit(proposal).ok, true);
  assert.deepEqual(StorageService.getSnapshot().partitions.life, before);
  assert.deepEqual(StateEngine.sniffAndMutate('王总预算800元，午饭花了30元', 'work'), []);
});
test('life parser never mutates work even when text mentions client or budget', () => {
  const before = StorageService.getSnapshot().partitions.work;
  StateEngine.sniffAndMutate('王总预算300元，午饭花了35元', 'life');
  assert.deepEqual(StorageService.getSnapshot().partitions.work, before);
});
test('one life input aggregates cards, money, status and people into exactly one snapshot write', () => {
  const workBefore = StorageService.getSnapshot().partitions.work;
  store.writes = 0;
  store.failAt = 2;
  const receipts = StateEngine.sniffAndMutate('创建《读书》卡，目标10，午饭花了35元，今天跑步了，妈妈喜欢白茶', 'life', 'life-atomic-1');
  assert.ok(receipts.length >= 4);
  assert.equal(store.writes, 1);
  const snapshot = StorageService.getSnapshot();
  assert.equal(snapshot.partitions.life.customCards.length, 1);
  assert.equal(snapshot.partitions.life.wallet.entries.length, 1);
  assert.equal(snapshot.partitions.life.rpg.streakDays, 1);
  assert.equal(snapshot.partitions.life.persons.length, 1);
  assert.deepEqual(snapshot.partitions.work, workBefore);
});
test('failed life batch persists no business changes and retry with the same source ID applies once', () => {
  StorageService.getSnapshot();
  const before = store.getItem(SNAPSHOT_KEY);
  store.fail = true;
  assert.throws(() => StateEngine.sniffAndMutate('创建《读书》卡，午饭花了35元，喝水，妈妈喜欢白茶', 'life', 'life-retry-1'));
  assert.equal(store.getItem(SNAPSHOT_KEY), before);
  store.fail = false;
  assert.ok(StateEngine.sniffAndMutate('创建《读书》卡，午饭花了35元，喝水，妈妈喜欢白茶', 'life', 'life-retry-1').length);
  const committed = store.getItem(SNAPSHOT_KEY);
  assert.deepEqual(StateEngine.sniffAndMutate('创建《读书》卡，午饭花了35元，喝水，妈妈喜欢白茶', 'life', 'life-retry-1'), []);
  assert.equal(store.getItem(SNAPSHOT_KEY), committed);
  assert.equal(StorageService.getWalletCard().entries.length, 1);
});
test('life activity is counted once per Shanghai day and water resets on the next day', () => {
  StateEngine.sniffAndMutate('今天运动', 'life');
  StateEngine.sniffAndMutate('今天运动', 'life');
  assert.equal(StorageService.getRpgStatusCard().streakDays, 1);
  const rpg = StorageService.getRpgStatusCard();
  const snapshot = StorageService.getSnapshot();
  snapshot.partitions.life.rpg = { ...rpg, dateKey: '2020-01-01', waterCups: 7 };
  assert.equal(StorageService.importAllData(JSON.stringify(snapshot)), true);
  assert.equal(StorageService.getRpgStatusCard().waterCups, 0);
});
test('legacy migration only reads actual keys, protects private journals and excludes credentials', () => {
  store.setItem('looma_settings', JSON.stringify({ apiKey: 'test-secret-do-not-export', personaName: '旧伴侣' }));
  store.setItem('looma_work_crm', JSON.stringify([{ id: 'old', clientName: '王总', budgetAmount: 300, stage: '需求确认',
    winProbability: 50, painPoints: '旧诉求', internalBottomLine: '内部底线', nextAction: '跟进', updatedAt: 10 }]));
  store.setItem('looma_journals', JSON.stringify([{ id: 'j1', date: '2026-10-26', title: '旧手帐', mood: '平静',
    userGoldenQuote: '私密原文', aiReflection: '记录', stickers: [], createdAt: 10 }]));
  const snapshot = StorageService.getSnapshot();
  assert.equal(snapshot.partitions.work.engagements[0].internalContext.includes('内部底线'), true);
  assert.equal(snapshot.partitions.work.engagements[0].shareableSummary, '');
  assert.equal(snapshot.partitions.life.journals.length, 1);
  assert.equal(snapshot.partitions.work.journals.length, 0);
  assert.equal(snapshot.partitions.work.tasks.length, 0);
  assert.equal(store.getItem('looma_work_crm') !== null, true);
  assert.equal(StorageService.exportAllData().includes('test-secret'), false);
});
test('legacy mixed-mode receipts are filtered without discarding the original message', () => {
  store.setItem('looma_work_messages', JSON.stringify([{ id: 'old-message', role: 'assistant', content: '历史原文', timestamp: 1,
    mutations: [{ id: 'old-life-receipt', mode: 'life', targetCardType: 'wallet', targetCardTitle: '生活', summaryText: '旧跨区回执', deltaBadge: '1', timestamp: 1 }] }]));
  assert.equal(StorageService.getMessages('work')[0].content, '历史原文');
  assert.equal(StorageService.getMessages('work')[0].mutations.length, 0);
  assert.ok(store.getItem('looma_work_messages').includes('旧跨区回执'));
});
test('legacy life one-sentence custom card remains available without fabricated progress', () => {
  StateEngine.sniffAndMutate('创建《读书》卡，目标10', 'life');
  const card = StorageService.getCustomCards('life')[0];
  assert.equal(card.title, '读书');
  assert.equal(card.metricValue, 0);
  assert.equal(card.metricTarget, 10);
  assert.deepEqual(StorageService.getCustomCards('work'), []);
});
test('backup round trip includes cards and journals and never partially imports invalid data', () => {
  addClient();
  StorageService.saveCustomCards([{ id: 'card', mode: 'life', title: '保留卡', icon: '卡', metricLabel: '进度', metricValue: 0,
    metricTarget: 10, unit: '次', checklist: [] }], 'life');
  const backup = StorageService.exportAllData();
  store.clear();
  assert.equal(StorageService.importAllData(backup), true);
  assert.equal(StorageService.getCustomCards('life')[0].title, '保留卡');
  const before = store.getItem(SNAPSHOT_KEY);
  const bad = JSON.parse(backup);
  bad.partitions.work.tasks = [{ id: 'bad', title: '坏引用', engagementId: 'nonexistent', dueAt: 'not-a-date' }];
  assert.equal(StorageService.importAllData(JSON.stringify(bad)), false);
  assert.equal(store.getItem(SNAPSHOT_KEY), before);
});
test('backup rejects cross-space memory and unknown credential fields', () => {
  const backup = JSON.parse(StorageService.exportAllData());
  backup.partitions.work.memories.push({ id: 'leak', mode: 'life', category: 'business', fact: '私密', createdAt: 1, importance: 1 });
  assert.equal(StorageService.importAllData(JSON.stringify(backup)), false);
  backup.partitions.work.memories = [];
  backup.settings.apiKey = 'do-not-import';
  assert.equal(StorageService.importAllData(JSON.stringify(backup)), false);
});
test('incomplete legacy backup cannot erase a real workspace', () => {
  addClient();
  const before = store.getItem(SNAPSHOT_KEY);
  assert.equal(StorageService.importAllData('{"version":"2.0-looma-dual-vault"}'), false);
  assert.equal(store.getItem(SNAPSHOT_KEY), before);
});
test('backup rejects unsupported nested structural fields rather than retaining credentials', () => {
  const snapshot = StorageService.getSnapshot();
  snapshot.partitions.life.customCards = [{ id: 'card', mode: 'life', title: '卡', icon: '卡', metricLabel: '进度', metricValue: 0,
    metricTarget: 10, unit: '次', checklist: [{ id: 'item', text: '项', done: false, apiKey: 'secret' } as any] }];
  assert.equal(StorageService.importAllData(JSON.stringify(snapshot)), false);
});
test('legacy version 2 backup round trip restores both partitions, cards and journals', () => {
  const legacy = { version: '2.0-looma-dual-vault', settings: {}, lifeVault: { messages: [], memories: [], persons: [] },
    workVault: { messages: [], memories: [], crmDeals: [], projectTasks: [] },
    customCards: [{ id: 'work-card', mode: 'work', title: '自定义', icon: '卡', metricLabel: '数', metricValue: 0, metricTarget: 10, unit: '次', checklist: [] }],
    journals: [{ id: 'work-journal', mode: 'work', date: '2026-10-26', title: '商务日志', mood: '专注', userGoldenQuote: '原文', aiReflection: '记录', stickers: [], createdAt: 1 }] };
  assert.equal(StorageService.importAllData(JSON.stringify(legacy)), true);
  assert.equal(StorageService.getJournals('work')[0].title, '商务日志');
  assert.equal(StorageService.getCustomCards('work')[0].title, '自定义');
  assert.deepEqual(StorageService.getJournals('life'), []);
});
test('deadlines resolve relative dates in Shanghai and default to 09:00', () => {
  let dates: any = {};
  try { dates = require('../src/services/dates'); } catch { /* new module is the behavior under test */ }
  assert.equal(typeof dates.resolveDeadline, 'function', 'deterministic date resolver is required');
  const { resolveDeadline } = dates;
  const now = Date.parse('2026-10-26T04:00:00Z');
  assert.equal(resolveDeadline('明天', now).dueAt, '2026-10-27T01:00:00.000Z');
  assert.equal(resolveDeadline('下周三', now).dueAt, '2026-11-04T01:00:00.000Z');
  assert.equal(resolveDeadline('月底', now).dueAt, '2026-10-31T01:00:00.000Z');
  assert.equal(resolveDeadline('2026年11月5日 15:30', now).dueAt, '2026-11-05T07:30:00.000Z');
  assert.equal(resolveDeadline('2026年2月30日', now).dueAt, undefined);
  assert.equal(resolveDeadline('2月30日', now).dueAt, undefined);
});

test('explicit project title overrides selected project on multi-project client and prevents cross-project contamination', () => {
  const first = { ...addClient('陈总', 30000), title: '星河官网' };
  const second = { ...first, id: 'project-store', title: '门店改版', budgetAmount: 15000 };
  assert.equal(StorageService.commit(StorageService.createProposal('work', [
    { target: 'engagement', entityId: first.id, before: StorageService.getSnapshot().partitions.work.engagements[0], after: first },
    { target: 'engagement', entityId: second.id, before: null, after: second },
  ], '初始化双项目')).ok, true);
  const batch = propose('陈总的星河官网项目预算改为5万；陈总的门店改版项目周五前发新版方案', first.id);
  const firstOp = batch.operations.find(op => op.target === 'engagement' && op.entityId === first.id);
  const secondOp = batch.operations.find(op => op.target === 'engagement' && op.entityId === second.id);
  const taskOp = batch.operations.find(op => op.target === 'task');
  assert.equal(firstOp?.after?.budgetAmount, 50000);
  assert.equal(secondOp?.after?.nextAction, '周五 发新版方案');
  assert.equal(taskOp?.after?.engagementId, second.id);
});
test('next-day corrections update existing project task and waiting follow-up in place without creating duplicates', () => {
  const now = new Date('2026-10-26T04:00:00Z').getTime();
  let work = { ...StorageService.getSnapshot().partitions.work, followUps: [] as any[] };
  const apply = (p: ReturnType<typeof propose>) => {
    assert.deepEqual(StateEngine.validate(p, work), []);
    work = JSON.parse(JSON.stringify(work));
    work.revision += 1;
    for (const op of p.operations) {
      const list: any[] = op.target === 'engagement' ? work.engagements : op.target === 'task' ? work.tasks : op.target === 'followup' ? work.followUps : work.memories;
      const idx = list.findIndex(item => item.id === op.entityId);
      if (idx >= 0) list[idx] = op.after;
      else if (op.after) list.push(op.after);
    }
  };
  const initial = StateEngine.propose('陈总的项目名称是星河官网，预算5万，我周五前发新版方案，客户下周一补齐首页素材', { mode: 'work', sourceMessageId: 'm-init', partition: work, now });
  apply(initial);
  assert.equal(work.engagements.length, 1);
  assert.equal(work.tasks.length, 1);
  assert.equal(work.followUps.length, 1);
  const taskId = work.tasks[0].id;
  const followUpId = work.followUps[0].id;
  assert.equal(work.tasks[0].deadline, '周五');
  assert.equal(work.followUps[0].expectedDate, '2026-11-02');

  const correction = StateEngine.propose('陈总的星河官网项目，发新版方案改到周四前；首页素材先不用催，陈总说下周整理', { mode: 'work', sourceMessageId: 'm-corr', partition: work, now });
  const taskUpdate = correction.operations.find(op => op.target === 'task');
  const followUpUpdate = correction.operations.find(op => op.target === 'followup');
  assert.equal(taskUpdate?.entityId, taskId);
  assert.ok(taskUpdate?.before);
  assert.equal(taskUpdate?.after?.deadline, '周四');
  assert.equal(taskUpdate?.after?.dueAt, '2026-10-29T01:00:00.000Z');
  assert.equal(followUpUpdate?.entityId, followUpId);
  assert.ok(followUpUpdate?.before);
  assert.equal(followUpUpdate?.after?.expectedDate, undefined);
  assert.equal(followUpUpdate?.after?.sourceDateText, '下周');
  apply(correction);

  assert.equal(work.tasks.length, 1);
  assert.equal(work.tasks[0].id, taskId);
  assert.equal(work.tasks[0].deadline, '周四');
  assert.equal(work.followUps.length, 1);
  assert.equal(work.followUps[0].id, followUpId);
  assert.equal(work.followUps[0].expectedDate, undefined);

  const resolved = StateEngine.propose('星河官网的首页素材已经收到了，新版方案已经发过去了', { mode: 'work', sourceMessageId: 'm-res', partition: work, now });
  apply(resolved);
  assert.equal(work.tasks.length, 1);
  assert.equal(work.tasks[0].done, true);
  assert.equal(work.followUps.length, 1);
  assert.equal(work.followUps[0].status, 'resolved');
});
test('ambiguous generic reschedule across multiple open project tasks requires clarification instead of duplicating', () => {
  assert.equal(StorageService.commit(propose('陈总的星河官网项目，我周五前发新版方案，下周一前发合同草稿')).ok, true);
  const work = StorageService.getSnapshot().partitions.work;
  assert.equal(work.tasks.length, 2);
  const ambiguous = propose('陈总的星河官网项目，那条行动改到周四前', work.engagements[0].id);
  assert.equal(ambiguous.operations.filter(op => op.target === 'task').length, 0);
  assert.ok(ambiguous.clarification);
  assert.ok(ambiguous.warnings.some(w => w.includes('多条')));
});

test('US05-US06: conditional intent binds waiting item, transitions to ready on resolve, converts to task, and respects modification/pause/cancel', async () => {
  const {
    evaluateFollowUpTransition,
    transitionConditionIntent,
    convertConditionToTaskOperations,
    selectHighlightedReadyConditions,
  } = await import('../src/services/conditionIntents');
  const now = Date.parse('2026-10-27T02:00:00Z');
  const work: any = { engagements: [], tasks: [], followUps: [], conditions: [], memories: [], messages: [], summaries: [], journals: [], customCards: [], events: [], closures: [], processedProposalIds: [], revision: 1 };
  const apply = (proposal: any) => {
    for (const op of proposal.operations) {
      const list = op.target === 'engagement' ? work.engagements : op.target === 'task' ? work.tasks : op.target === 'followup' ? work.followUps : op.target === 'condition' ? work.conditions : work.memories;
      const idx = list.findIndex((item: any) => item.id === op.entityId);
      if (op.after === null) { if (idx >= 0) list.splice(idx, 1); }
      else if (idx >= 0) list[idx] = op.after;
      else list.push(op.after);
    }
    work.revision += 1;
  };

  // 1. US05: "等陈总把首页素材发过来后，再整理第二版报价" does not create immediate task, creates waiting followup + watching condition
  const initial = StateEngine.propose('陈总的项目名称是星河官网，等陈总把首页素材发过来后，再整理第二版报价', { mode: 'work', sourceMessageId: 'm-cond-1', partition: work, now });
  assert.equal(initial.operations.filter(op => op.target === 'task').length, 0);
  const waitingOp = initial.operations.find(op => op.target === 'followup');
  const condOp = initial.operations.find(op => op.target === 'condition');
  assert.ok(waitingOp && waitingOp.after?.kind === 'waiting');
  assert.ok(condOp && condOp.after);
  assert.equal(condOp.after.status, 'watching');
  assert.equal(condOp.after.conditionKind, 'followup_resolved');
  assert.equal(condOp.after.followUpId, waitingOp.entityId);
  assert.equal(condOp.after.actionTitle, '整理第二版报价');
  assert.equal(condOp.after.revision, 1);
  apply(initial);

  // 2. Vague condition is saved as draft (manual_confirm) and does not auto-trigger
  const vague = StateEngine.propose('陈总的星河官网项目，等时机成熟后再推进二期方案', { mode: 'work', sourceMessageId: 'm-cond-vague', partition: work, now: now + 1000 });
  const vagueCondOp = vague.operations.find(op => op.target === 'condition');
  assert.ok(vagueCondOp && vagueCondOp.after);
  assert.equal(vagueCondOp.after.status, 'draft');
  assert.equal(vagueCondOp.after.conditionKind, 'manual_confirm');
  assert.equal(vagueCondOp.after.followUpId, undefined);
  apply(vague);

  // 3. US06: Modify the first condition to wait for "确认函" instead of "首页素材"
  const modified = StateEngine.propose('陈总的星河官网项目，整理第二版报价的条件改成等陈总把确认函发过来', { mode: 'work', sourceMessageId: 'm-cond-mod', partition: work, now: now + 2000 });
  const modCondOp = modified.operations.find(op => op.target === 'condition');
  const newWaitOp = modified.operations.find(op => op.target === 'followup');
  assert.ok(modCondOp && modCondOp.after);
  assert.ok(newWaitOp && newWaitOp.after);
  assert.equal(modCondOp.entityId, condOp.entityId);
  assert.equal(modCondOp.after.revision, 2);
  assert.equal(modCondOp.after.followUpId, newWaitOp.entityId);
  assert.notEqual(modCondOp.after.followUpId, waitingOp.entityId);
  apply(modified);

  // 4. US06: Old waiting item ("首页素材") resolves -> modified condition MUST NOT trigger!
  const oldResolved = StateEngine.propose('星河官网的首页素材已经收到了', { mode: 'work', sourceMessageId: 'm-old-res', partition: work, now: now + 3000 });
  assert.equal(oldResolved.operations.filter(op => op.target === 'condition').length, 0);
  apply(oldResolved);
  assert.equal(work.conditions.find((c: any) => c.id === condOp.entityId).status, 'watching');

  // 5. US06: Pause condition -> resolving new waiting item ("确认函") MUST NOT trigger!
  const pausedCond = transitionConditionIntent(work.conditions.find((c: any) => c.id === condOp.entityId), 'pause', now + 3500);
  assert.equal(pausedCond.status, 'paused');
  assert.equal(pausedCond.revision, 3);
  assert.equal(evaluateFollowUpTransition([pausedCond], newWaitOp.after, { ...newWaitOp.after, status: 'resolved' }, now + 3600).length, 0);

  // 6. Resume watching -> resolving new waiting item ("确认函") transitions condition to ready (revision + 1)
  const resumedCond = transitionConditionIntent(pausedCond, 'activate_watching', now + 3700);
  assert.equal(resumedCond.status, 'watching');
  assert.equal(resumedCond.revision, 4);
  const condIdx = work.conditions.findIndex((c: any) => c.id === condOp.entityId);
  work.conditions[condIdx] = resumedCond;

  const newResolved = StateEngine.propose('星河官网的确认函已经收到了', { mode: 'work', sourceMessageId: 'm-new-res', partition: work, now: now + 4000 });
  const readyCondOp = newResolved.operations.find(op => op.target === 'condition');
  assert.ok(readyCondOp && readyCondOp.after);
  assert.equal(readyCondOp.after.status, 'ready');
  assert.equal(readyCondOp.after.revision, 5);
  assert.equal(readyCondOp.after.triggeredAt, now + 4000);
  apply(newResolved);

  // 7. Duplicate resolve event does not trigger again or bump revision
  const duplicateOps = evaluateFollowUpTransition(work.conditions, { ...newWaitOp.after, status: 'resolved' }, { ...newWaitOp.after, status: 'resolved' }, now + 5000);
  assert.equal(duplicateOps.length, 0);

  // 8. Highlight selection and dismiss highlight
  const highlighted = selectHighlightedReadyConditions(work.conditions, work.followUps.filter((f: any) => f.status === 'open'), work.engagements);
  assert.equal(highlighted.length, 1);
  assert.equal(highlighted[0].id, condOp.entityId);
  const dismissed = transitionConditionIntent(highlighted[0], 'dismiss_highlight', now + 5100);
  assert.equal(selectHighlightedReadyConditions([dismissed], [], work.engagements).length, 0);

  // 9. Convert ready condition to ProjectTaskItem (idempotent)
  const convertOps = convertConditionToTaskOperations(work.conditions[0], work.tasks, now + 6000);
  assert.equal(convertOps.length, 2);
  apply({ operations: convertOps });
  assert.equal(work.tasks.length, 1);
  assert.equal(work.tasks[0].title, '整理第二版报价');
  assert.equal(work.conditions[0].status, 'completed');
  assert.equal(work.conditions[0].revision, 6);
  // Calling convert again produces no duplicate task
  assert.equal(convertConditionToTaskOperations(work.conditions[0], work.tasks, now + 7000).length, 0);
});
