import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CustomLivingCard, LifePartition, TodoRecord, WorkspaceMode } from '../src/types';
import {
  CHECKIN_REMINDER_PREFIX,
  MAX_ACTIVE_CHECKINS,
  activeCheckinCount,
  computeNextCheckinReminderDueAt,
  createCheckinCard,
  deleteCheckinCard,
  getCheckedDates,
  hasCheckedToday,
  renameCheckinCard,
  syncCheckinReminders,
  toggleArchiveCheckinCard,
  toggleTodayCheckin,
  updateCheckinReminder,
} from '../src/services/checkins';
import { lifeActionText, routeLifeInput } from '../src/services/lifeRouting';
import { StateEngine } from '../src/services/stateEngine';
import type { CheckinReminderTodoPort } from '../src/services/checkins';

const emptyLife = (): LifePartition => ({
  revision: 0,
  messages: [],
  memories: [],
  journals: [],
  customCards: [],
  events: [],
  processedProposalIds: [],
  wallet: { monthlyBudget: 3000, wishTitle: '心愿小金库', wishTarget: 10000, wishSaved: 0, entries: [] },
  rpg: { level: 1, exp: 0, waterCups: 0, dateKey: '2026-11-15' },
  persons: [],
});

function createFakeTodoPort() {
  const rows = new Map<string, TodoRecord>();
  const ops: { op: string; id: string; dueAt?: string; status?: string }[] = [];
  const port: CheckinReminderTodoPort = {
    async list(space: WorkspaceMode, includeInactive = false) {
      return [...rows.values()].filter(
        t => t.space === space && (includeInactive || t.status === 'pending' || t.status === 'suggested'),
      );
    },
    async create(input) {
      const id = input.id || `todo-${rows.size + 1}`;
      const record: TodoRecord = {
        id,
        space: input.space,
        title: input.title,
        status: input.status || 'pending',
        dueAt: input.dueAt,
        dueDate: input.dueDate,
        needsTime: input.needsTime ?? false,
        sourceText: input.sourceText,
        createdAt: 1000,
        updatedAt: 1000,
        revision: 1,
      };
      rows.set(id, record);
      ops.push({ op: 'create', id, dueAt: record.dueAt, status: record.status });
      return record;
    },
    async update(todo, patch) {
      const prev = rows.get(todo.id) || todo;
      const next: TodoRecord = { ...prev, ...patch, updatedAt: Date.now(), revision: prev.revision + 1 };
      rows.set(todo.id, next);
      ops.push({ op: 'update', id: next.id, dueAt: next.dueAt, status: next.status });
      return next;
    },
    async complete(todo) {
      return port.update(todo, { status: 'completed', completedAt: Date.now() });
    },
    async cancel(todo) {
      return port.update(todo, { status: 'cancelled' });
    },
  };
  return { port, rows, ops };
}

test('persistence-core validates legacy custom cards and check-in extensions strictly', async () => {
  const { validateRecord } = await import('../shared/persistence-core.mjs');
  const legacyCard: CustomLivingCard = {
    id: 'custom-legacy-1',
    mode: 'life',
    title: '英语单词打卡',
    icon: '🌱',
    metricLabel: '进度',
    metricValue: 5,
    metricTarget: 30,
    unit: '次',
    checklist: [],
  };
  assert.equal(validateRecord('life', 'custom', legacyCard), true);

  const validCheckin: CustomLivingCard = {
    id: 'custom-checkin-1',
    mode: 'life',
    title: '读书',
    icon: '✓',
    metricLabel: '累计打卡',
    metricValue: 1,
    metricTarget: 7,
    unit: '天',
    checklist: [],
    cardKind: 'checkin',
    checkedDates: ['2026-11-15'],
    dailyReminderTime: '21:30',
    archived: false,
    createdAt: 1700000000000,
  };
  assert.equal(validateRecord('life', 'custom', validCheckin), true);

  assert.equal(validateRecord('life', 'custom', { ...validCheckin, checkedDates: ['2026-11-15', '2026-11-15'] }), false);
  assert.equal(validateRecord('life', 'custom', { ...validCheckin, checkedDates: ['2026-02-30'] }), false);
  assert.equal(validateRecord('life', 'custom', { ...validCheckin, dailyReminderTime: '25:00' }), false);
  assert.equal(validateRecord('life', 'custom', { ...validCheckin, cardKind: 'unknown' }), false);
  assert.equal(validateRecord('life', 'custom', { ...validCheckin, extraField: 123 }), false);
});

test('check-in concurrency cap of 3, inline rename, archive restore guard, and deletion', () => {
  const legacyMetric: CustomLivingCard = {
    id: 'metric-1',
    mode: 'life',
    title: '跑步累计',
    icon: '🏃',
    metricLabel: '距离',
    metricValue: 10,
    metricTarget: 100,
    unit: 'km',
    checklist: [],
  };
  let cards: CustomLivingCard[] = [legacyMetric];

  const r1 = createCheckinCard(cards, { title: '读书', daysTarget: 7, dailyReminderTime: '21:30' }, 1000);
  cards = r1.cards;
  const r2 = createCheckinCard(cards, { title: '背单词', daysTarget: 14 }, 2000);
  cards = r2.cards;
  const r3 = createCheckinCard(cards, { title: '早睡', daysTarget: 21, dailyReminderTime: '22:30' }, 3000);
  cards = r3.cards;

  assert.equal(activeCheckinCount(cards), MAX_ACTIVE_CHECKINS);
  assert.throws(() => createCheckinCard(cards, { title: '冥想', daysTarget: 7 }, 4000), /最多同时进行 3 条打卡线/);

  // Renaming preserves data and rejects blank names
  cards = renameCheckinCard(cards, r1.card.id, '睡前读书');
  assert.equal(cards.find(c => c.id === r1.card.id)?.title, '睡前读书');
  assert.throws(() => renameCheckinCard(cards, r1.card.id, '   '), /不能为空/);

  // Archiving a track frees one concurrent slot cleanly
  cards = toggleArchiveCheckinCard(cards, r3.card.id);
  assert.equal(activeCheckinCount(cards), 2);
  const r4 = createCheckinCard(cards, { title: '冥想', daysTarget: 7 }, 5000);
  cards = r4.cards;
  assert.equal(activeCheckinCount(cards), 3);

  // Restoring archived incomplete track fails when already at 3 active tracks
  assert.throws(() => toggleArchiveCheckinCard(cards, r3.card.id), /最多同时进行 3 条打卡线/);

  // Deleting removes only that check-in card and preserves legacy metric card untouched
  cards = deleteCheckinCard(cards, r2.card.id);
  assert.equal(cards.some(c => c.id === legacyMetric.id), true);
  assert.equal(cards.some(c => c.id === r2.card.id), false);
});

test('daily 1-step pacing allows checking and undoing today without double-counting', () => {
  const day1Morning = Date.parse('2026-11-15T10:00:00+08:00');
  const day2Morning = Date.parse('2026-11-16T09:00:00+08:00');

  let { cards, card } = createCheckinCard([], { title: '读书', daysTarget: 2 }, day1Morning);

  const step1 = toggleTodayCheckin(cards, card.id, day1Morning);
  cards = step1.cards;
  assert.equal(step1.action, 'checked');
  assert.deepEqual(getCheckedDates(step1.card), ['2026-11-15']);
  assert.equal(step1.card.metricValue, 1);
  assert.equal(hasCheckedToday(step1.card, day1Morning), true);

  // Second tap on same day undoes today's step rather than completing day 2 early
  const undoSameDay = toggleTodayCheckin(cards, card.id, day1Morning + 3600000);
  cards = undoSameDay.cards;
  assert.equal(undoSameDay.action, 'unchecked');
  assert.deepEqual(getCheckedDates(undoSameDay.card), []);
  assert.equal(undoSameDay.card.metricValue, 0);

  // Re-check day 1, then complete day 2 on the next calendar day
  cards = toggleTodayCheckin(cards, card.id, day1Morning + 7200000).cards;
  const day2Check = toggleTodayCheckin(cards, card.id, day2Morning);
  cards = day2Check.cards;
  assert.equal(day2Check.action, 'checked');
  assert.deepEqual(getCheckedDates(day2Check.card), ['2026-11-15', '2026-11-16']);
  assert.equal(day2Check.card.metricValue, 2);

  // Completing 2/2 automatically opens an active slot
  assert.equal(activeCheckinCount(cards), 0);
});

test('reminder scheduling and TodoService synchronization react cleanly to checks, rollover, and completion', async () => {
  const before2130 = Date.parse('2026-11-15T20:00:00+08:00');
  const after2130 = Date.parse('2026-11-15T22:00:00+08:00');
  const todayDue = new Date('2026-11-15T21:30:00+08:00').toISOString();
  const tomorrowDue = new Date('2026-11-16T21:30:00+08:00').toISOString();

  assert.equal(computeNextCheckinReminderDueAt('21:30', false, before2130), todayDue);
  assert.equal(computeNextCheckinReminderDueAt('21:30', true, before2130), tomorrowDue);
  assert.equal(computeNextCheckinReminderDueAt('21:30', false, after2130), tomorrowDue);

  const { port, rows, ops } = createFakeTodoPort();
  let { cards, card } = createCheckinCard([], { title: '读书', daysTarget: 2, dailyReminderTime: '21:30' }, before2130);
  const todoId = CHECKIN_REMINDER_PREFIX + card.id;

  // Initial sync creates pending todo due tonight 21:30
  await syncCheckinReminders(cards, port, before2130);
  assert.equal(rows.get(todoId)?.dueAt, todayDue);
  assert.equal(rows.get(todoId)?.status, 'pending');

  // Idempotent sync emits zero additional mutations
  const countBefore = ops.length;
  await syncCheckinReminders(cards, port, before2130);
  assert.equal(ops.length, countBefore);

  // Checking today pushes reminder dueAt to tomorrow 21:30 immediately
  cards = toggleTodayCheckin(cards, card.id, before2130).cards;
  await syncCheckinReminders(cards, port, before2130);
  assert.equal(rows.get(todoId)?.dueAt, tomorrowDue);
  assert.equal(rows.get(todoId)?.status, 'pending');

  // Finishing all days completes the reminder todo
  const day2 = Date.parse('2026-11-16T10:00:00+08:00');
  cards = toggleTodayCheckin(cards, card.id, day2).cards;
  await syncCheckinReminders(cards, port, day2);
  assert.equal(rows.get(todoId)?.status, 'completed');

  // New card: disabling reminder or deleting card cancels its reminder todo
  const second = createCheckinCard([], { title: '背单词', daysTarget: 7, dailyReminderTime: '20:00' }, before2130);
  const secondTodoId = CHECKIN_REMINDER_PREFIX + second.card.id;
  await syncCheckinReminders(second.cards, port, before2130);
  assert.equal(rows.get(secondTodoId)?.status, 'pending');

  const disabledCards = updateCheckinReminder(second.cards, second.card.id, undefined);
  await syncCheckinReminders(disabledCards, port, before2130);
  assert.equal(rows.get(secondTodoId)?.status, 'cancelled');

  // Re-enabling reminder resurrects deterministic todo
  const reenabled = updateCheckinReminder(disabledCards, second.card.id, '22:00');
  await syncCheckinReminders(reenabled, port, before2130);
  assert.equal(rows.get(secondTodoId)?.status, 'pending');
  assert.equal(rows.get(secondTodoId)?.dueAt, new Date('2026-11-15T22:00:00+08:00').toISOString());

  // Deleting card cancels pending reminder cleanly
  const afterDelete = deleteCheckinCard(reenabled, second.card.id);
  await syncCheckinReminders(afterDelete, port, before2130);
  assert.equal(rows.get(secondTodoId)?.status, 'cancelled');
});

test('spoken check-in commands integrate cleanly without regressing metric cards', () => {
  const input = '开启7天读书打卡，最晚21点半提醒我';
  const fragments = routeLifeInput(input);
  assert.equal(fragments.length, 1);
  assert.equal(fragments[0].route, 'fact');
  assert.equal(lifeActionText(input), '');

  const life = emptyLife();
  const createdReceipts = StateEngine.mutateLifeDraft(input, life);
  assert.equal(createdReceipts.length, 1);
  assert.equal(life.customCards.length, 1);
  assert.equal(life.customCards[0].cardKind, 'checkin');
  assert.equal(life.customCards[0].title, '读书');
  assert.equal(life.customCards[0].metricTarget, 7);
  assert.equal(life.customCards[0].dailyReminderTime, '21:30');

  // Spoken check-in marks today once and blocks duplicate check-in on the same day
  const step1 = StateEngine.mutateLifeDraft('今天读书已完成打卡', life);
  assert.equal(step1.length, 1);
  assert.equal(life.customCards[0].metricValue, 1);
  assert.equal(life.customCards[0].checkedDates?.length, 1);

  const duplicateStep = StateEngine.mutateLifeDraft('读书打卡', life);
  assert.equal(duplicateStep.length, 0);
  assert.equal(life.customCards[0].metricValue, 1);

  // Spoken creation also enforces MAX_ACTIVE_CHECKINS = 3
  StateEngine.mutateLifeDraft('新建14天背单词打卡', life);
  StateEngine.mutateLifeDraft('开始21天早睡打卡', life);
  assert.equal(activeCheckinCount(life.customCards), 3);
  const blocked = StateEngine.mutateLifeDraft('加一个7天冥想打卡', life);
  assert.equal(blocked.length, 0);
  assert.equal(activeCheckinCount(life.customCards), 3);

  // Legacy metric card behavior (L-PH-20) remains unaffected
  const legacyLife = emptyLife();
  StateEngine.mutateLifeDraft('新建《英语单词打卡》卡，目标30', legacyLife);
  assert.equal(legacyLife.customCards[0].cardKind, undefined);
  assert.equal(legacyLife.customCards[0].metricTarget, 30);
  StateEngine.mutateLifeDraft('英语单词打卡 +5', legacyLife);
  assert.equal(legacyLife.customCards[0].metricValue, 5);
});
