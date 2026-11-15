import type { CustomLivingCard, TodoRecord, WorkspaceMode } from '../types';
import { shanghaiDateKey } from './dates';
import { newId } from './storage';

export const MAX_ACTIVE_CHECKINS = 3;
export const MAX_CHECKIN_DAYS = 365;
export const DEFAULT_CHECKIN_REMINDER_TIME = '21:30';
export const CHECKIN_REMINDER_PREFIX = 'checkin-rem-';

export type CheckinReminderTodoPort = {
  list(space: WorkspaceMode, includeInactive?: boolean): Promise<TodoRecord[]>;
  create(input: Pick<TodoRecord, 'space' | 'title'> & Partial<TodoRecord>): Promise<TodoRecord>;
  update(todo: TodoRecord, patch: Partial<TodoRecord>): Promise<TodoRecord>;
  complete(todo: TodoRecord): Promise<TodoRecord>;
  cancel(todo: TodoRecord): Promise<TodoRecord>;
};

export const isCheckinCard = (card: CustomLivingCard): boolean => card.cardKind === 'checkin';

export function getCheckedDates(card: CustomLivingCard): string[] {
  if (!Array.isArray(card.checkedDates)) return [];
  return [...new Set(card.checkedDates)].sort();
}

export function isCheckinCompleted(card: CustomLivingCard): boolean {
  return isCheckinCard(card) && getCheckedDates(card).length >= card.metricTarget;
}

export function isCheckinActive(card: CustomLivingCard): boolean {
  return isCheckinCard(card) && !card.archived && !isCheckinCompleted(card);
}

export function activeCheckinCount(cards: CustomLivingCard[]): number {
  return cards.filter(isCheckinActive).length;
}

export function sortCheckinCards(cards: CustomLivingCard[]): CustomLivingCard[] {
  return [...cards].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
}

export function partitionCheckinCards(cards: CustomLivingCard[]): {
  active: CustomLivingCard[];
  completed: CustomLivingCard[];
  archived: CustomLivingCard[];
} {
  const ordered = sortCheckinCards(cards.filter(isCheckinCard));
  return {
    active: ordered.filter(c => !c.archived && !isCheckinCompleted(c)),
    completed: ordered.filter(c => !c.archived && isCheckinCompleted(c)),
    archived: ordered.filter(c => Boolean(c.archived)),
  };
}

export function hasCheckedToday(card: CustomLivingCard, now: number = Date.now()): boolean {
  const today = shanghaiDateKey(now);
  return getCheckedDates(card).includes(today);
}

export function normalizeReminderTime(raw?: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = raw.trim().match(/^(\d{1,2})[:：](\d{2})$/);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function shanghaiAddDays(dateKey: string, deltaDays: number): string {
  const utc = Date.parse(`${dateKey}T00:00:00Z`);
  return new Date(utc + deltaDays * 86400000).toISOString().slice(0, 10);
}

export function computeNextCheckinReminderDueAt(
  dailyReminderTime: string | undefined,
  checkedToday: boolean,
  now: number = Date.now(),
): string | undefined {
  const hhmm = normalizeReminderTime(dailyReminderTime);
  if (!hhmm) return undefined;
  const today = shanghaiDateKey(now);
  const todayDue = new Date(`${today}T${hhmm}:00+08:00`);
  if (!checkedToday && Number.isFinite(todayDue.getTime()) && todayDue.getTime() > now) {
    return todayDue.toISOString();
  }
  const tomorrow = shanghaiAddDays(today, 1);
  return new Date(`${tomorrow}T${hhmm}:00+08:00`).toISOString();
}

export function createCheckinCard(
  allCards: CustomLivingCard[],
  input: { title: string; daysTarget?: number; dailyReminderTime?: string },
  now: number = Date.now(),
): { cards: CustomLivingCard[]; card: CustomLivingCard } {
  const title = (input.title || '').trim().slice(0, 40);
  if (!title) throw new Error('请填写打卡名称。');
  const days = Math.round(Number(input.daysTarget ?? 7));
  if (!Number.isFinite(days) || days < 1 || days > MAX_CHECKIN_DAYS) {
    throw new Error(`打卡天数需在 1 到 ${MAX_CHECKIN_DAYS} 天之间。`);
  }
  if (activeCheckinCount(allCards) >= MAX_ACTIVE_CHECKINS) {
    throw new Error(`最多同时进行 ${MAX_ACTIVE_CHECKINS} 条打卡线，可先完成或归档其中一条。`);
  }
  const rawReminder = input.dailyReminderTime?.trim();
  const dailyReminderTime = rawReminder ? normalizeReminderTime(rawReminder) : undefined;
  if (rawReminder && !dailyReminderTime) {
    throw new Error('每日提醒时间格式无效，请使用 HH:mm（例如 21:30）。');
  }
  const card: CustomLivingCard = {
    id: newId('custom'),
    mode: 'life',
    title,
    icon: '✓',
    metricLabel: '累计打卡',
    metricValue: 0,
    metricTarget: days,
    unit: '天',
    checklist: [],
    cardKind: 'checkin',
    checkedDates: [],
    archived: false,
    createdAt: now,
    ...(dailyReminderTime ? { dailyReminderTime } : {}),
  };
  return { card, cards: [...allCards, card] };
}

function replaceCheckinCard(
  allCards: CustomLivingCard[],
  cardId: string,
  updater: (card: CustomLivingCard) => CustomLivingCard,
): CustomLivingCard[] {
  const index = allCards.findIndex(c => c.id === cardId && isCheckinCard(c));
  if (index === -1) throw new Error('未找到对应的打卡项目。');
  const next = [...allCards];
  next[index] = updater(allCards[index]);
  return next;
}

export function renameCheckinCard(allCards: CustomLivingCard[], cardId: string, nextTitle: string): CustomLivingCard[] {
  const title = nextTitle.trim().slice(0, 40);
  if (!title) throw new Error('打卡名称不能为空。');
  return replaceCheckinCard(allCards, cardId, card => ({ ...card, title }));
}

export function updateCheckinReminder(
  allCards: CustomLivingCard[],
  cardId: string,
  dailyReminderTime?: string,
): CustomLivingCard[] {
  const raw = dailyReminderTime?.trim();
  const normalized = raw ? normalizeReminderTime(raw) : undefined;
  if (raw && !normalized) {
    throw new Error('每日提醒时间格式无效，请使用 HH:mm（例如 21:30）。');
  }
  return replaceCheckinCard(allCards, cardId, card => {
    const next: CustomLivingCard = { ...card };
    if (normalized) next.dailyReminderTime = normalized;
    else delete next.dailyReminderTime;
    return next;
  });
}

export function toggleTodayCheckin(
  allCards: CustomLivingCard[],
  cardId: string,
  now: number = Date.now(),
): { cards: CustomLivingCard[]; card: CustomLivingCard; action: 'checked' | 'unchecked' } {
  const current = allCards.find(c => c.id === cardId && isCheckinCard(c));
  if (!current) throw new Error('未找到对应的打卡项目。');
  if (current.archived) throw new Error('该打卡已归档，请先恢复后再操作。');
  const today = shanghaiDateKey(now);
  const dates = getCheckedDates(current);
  let nextDates: string[];
  let action: 'checked' | 'unchecked';
  if (dates.includes(today)) {
    if (dates.length >= current.metricTarget && activeCheckinCount(allCards) >= MAX_ACTIVE_CHECKINS) {
      throw new Error(`当前已有 ${MAX_ACTIVE_CHECKINS} 条进行中的打卡线，无法撤销已完成打卡的今日记录。`);
    }
    nextDates = dates.filter(d => d !== today);
    action = 'unchecked';
  } else {
    if (dates.length >= current.metricTarget) {
      throw new Error('这条打卡已经全部完成了，可先归档或新建一轮。');
    }
    nextDates = [...dates, today].sort();
    action = 'checked';
  }
  const updated: CustomLivingCard = {
    ...current,
    checkedDates: nextDates,
    metricValue: nextDates.length,
  };
  return {
    action,
    card: updated,
    cards: allCards.map(c => (c.id === cardId ? updated : c)),
  };
}

export function toggleArchiveCheckinCard(allCards: CustomLivingCard[], cardId: string): CustomLivingCard[] {
  const current = allCards.find(c => c.id === cardId && isCheckinCard(c));
  if (!current) throw new Error('未找到对应的打卡项目。');
  const nextArchived = !current.archived;
  if (!nextArchived && !isCheckinCompleted(current) && activeCheckinCount(allCards) >= MAX_ACTIVE_CHECKINS) {
    throw new Error(`最多同时进行 ${MAX_ACTIVE_CHECKINS} 条打卡线，请先归档或完成其他进行中的打卡。`);
  }
  return replaceCheckinCard(allCards, cardId, card => ({ ...card, archived: nextArchived }));
}

export function deleteCheckinCard(allCards: CustomLivingCard[], cardId: string): CustomLivingCard[] {
  return allCards.filter(c => !(c.id === cardId && isCheckinCard(c)));
}

function parseChineseInt(raw: string): number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const map: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (trimmed in map) return map[trimmed];
  const hundredMatch = trimmed.match(/^(?:([一二两三四五六七八九])百)(?:(零)|([一二三四五六七八九])十)?([一二三四五六七八九])?$/);
  if (hundredMatch) {
    const h = map[hundredMatch[1]] * 100;
    const t = hundredMatch[3] ? map[hundredMatch[3]] * 10 : 0;
    const o = hundredMatch[4] ? map[hundredMatch[4]] : 0;
    return h + t + o;
  }
  if (trimmed.includes('十')) {
    const [a, b] = trimmed.split('十');
    const tens = a ? map[a] : 1;
    const ones = b ? map[b] : 0;
    if (Number.isInteger(tens) && Number.isInteger(ones)) return tens * 10 + ones;
  }
  return -1;
}

export function parseSpokenCheckinReminderTime(text: string): string | undefined {
  const clockMatch = text.match(
    /(?:每日|每天|每晚|最晚|晚上|夜间|傍晚|下午|早上|上午|凌晨)?\s*([零一二两三四五六七八九十\d]{1,3})\s*(?:([:：])(\d{2})|点(?:(半|[一三13]刻)|([零一二两三四五六七八九十\d]{1,3})分?)?)/,
  );
  if (!clockMatch) return undefined;
  let hour = parseChineseInt(clockMatch[1]);
  if (hour < 0 || hour > 23) return undefined;
  let minute = 0;
  if (clockMatch[3]) {
    minute = Number(clockMatch[3]);
  } else if (clockMatch[4] === '半') {
    minute = 30;
  } else if (clockMatch[4] === '一刻' || clockMatch[4] === '1刻') {
    minute = 15;
  } else if (clockMatch[4] === '三刻' || clockMatch[4] === '3刻') {
    minute = 45;
  } else if (clockMatch[5]) {
    const m = parseChineseInt(clockMatch[5]);
    if (m < 0 || m > 59) return undefined;
    minute = m;
  }
  const hasEveningPrefix = /(?:每晚|晚上|夜里|傍晚|下午)\s*[零一二两三四五六七八九十\d]/.test(clockMatch[0])
    || (hour >= 1 && hour <= 11 && /(?:每晚|晚上|夜里|最晚)/.test(text) && !/上午|早上|清晨|凌晨|AM|am/.test(text) && hour >= 5);
  if (hasEveningPrefix && hour >= 1 && hour <= 11) hour += 12;
  return normalizeReminderTime(`${hour}:${String(minute).padStart(2, '0')}`);
}

export interface SpokenCheckinResult {
  handled: boolean;
  kind?: 'created' | 'checked' | 'already-checked' | 'limit-reached';
  card?: CustomLivingCard;
  message?: string;
}

export function tryApplySpokenCheckin(
  factsText: string,
  allCards: CustomLivingCard[],
  now: number = Date.now(),
): SpokenCheckinResult {
  const clean = factsText.trim();
  if (!clean || /[《》「」]|目标\s*\d/.test(clean)) return { handled: false };

  const createMatch = clean.match(
    /(?:开启|开始|启动|新建|创建|加一?个|建一?个|完成|想完成|想要完成|连续|坚持)\s*(?:一个|一条)?\s*([一二两三四五六七八九十百\d]{1,5})\s*天(?:的)?\s*([^\s，,。；;！？!?"'《》「」“”]{1,20}?)\s*(?:的)?打卡(?![\s\S]*目标\s*\d)/,
  );
  if (createMatch) {
    const days = parseChineseInt(createMatch[1]);
    const rawTitle = createMatch[2].replace(/^(?:每日|每天|的|一个|一条)+/, '').trim();
    if (days >= 1 && days <= MAX_CHECKIN_DAYS && rawTitle && !/\d+(?:公里|km|米|ml|斤|kg|元|块)/i.test(rawTitle)) {
      const reminderTextMatch = clean.match(/(?:最晚|每日|每天|每晚)[^，,。；;]*$/);
      const reminder = reminderTextMatch ? parseSpokenCheckinReminderTime(reminderTextMatch[0]) : undefined;
      try {
        const { card, cards } = createCheckinCard(allCards, {
          title: rawTitle,
          daysTarget: days,
          dailyReminderTime: reminder,
        }, now);
        allCards.splice(0, allCards.length, ...cards);
        return {
          handled: true,
          kind: 'created',
          card,
          message: `已开启「${card.title}」${days}天打卡${reminder ? ` · 每日最晚 ${reminder} 提醒` : ''}`,
        };
      } catch (error) {
        return {
          handled: true,
          kind: 'limit-reached',
          message: error instanceof Error ? error.message : '当前无法开启新打卡。',
        };
      }
    }
  }

  if (/(?:还没|没有|未|别|不要|不|如果|假如|假设|[?？])/.test(clean)) return { handled: false };
  const checkins = allCards.filter(c => isCheckinCard(c) && !c.archived);
  for (const card of checkins) {
    const escaped = card.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hit = new RegExp(
      `(?:今日|今天|刚刚|刚才)?\\s*(?:已完成|已|完成了?|打(?:了)?)?\\s*${escaped}\\s*(?:已完成|已|完成了?|今日|今天)?\\s*打卡(?:完成了?|了)?|打卡\\s*${escaped}`,
    ).test(clean);
    if (!hit || /[+＋]\s*\d|完成了?\s*\d/.test(clean)) continue;
    if (hasCheckedToday(card, now)) {
      return { handled: true, kind: 'already-checked', card, message: `「${card.title}」今天已经打过卡了（每日限 1 格）` };
    }
    if (isCheckinCompleted(card)) return { handled: false };
    const result = toggleTodayCheckin(allCards, card.id, now);
    allCards.splice(0, allCards.length, ...result.cards);
    return {
      handled: true,
      kind: 'checked',
      card: result.card,
      message: `已完成「${result.card.title}」今日打卡（${result.card.metricValue}/${result.card.metricTarget}天）`,
    };
  }

  return { handled: false };
}

let syncChain: Promise<void> = Promise.resolve();

export function syncCheckinReminders(
  allCards: CustomLivingCard[],
  todoPort: CheckinReminderTodoPort,
  now?: number,
): Promise<void> {
  const run = async () => {
    const timestamp = now ?? Date.now();
    const existing = await todoPort.list('life', true);
    const byId = new Map(existing.filter(t => t.id.startsWith(CHECKIN_REMINDER_PREFIX)).map(t => [t.id, t]));
    const seen = new Set<string>();

    for (const card of allCards.filter(isCheckinCard)) {
      const todoId = CHECKIN_REMINDER_PREFIX + card.id;
      seen.add(todoId);
      const previous = byId.get(todoId);
      const isPendingOrSuggested = previous && (previous.status === 'pending' || previous.status === 'suggested');
      const reminder = card.dailyReminderTime ? normalizeReminderTime(card.dailyReminderTime) : undefined;

      if (!reminder || card.archived) {
        if (isPendingOrSuggested) await todoPort.cancel(previous);
        continue;
      }
      if (isCheckinCompleted(card)) {
        if (isPendingOrSuggested) await todoPort.complete(previous);
        continue;
      }

      const checkedToday = hasCheckedToday(card, timestamp);
      const dueAt = computeNextCheckinReminderDueAt(reminder, checkedToday, timestamp);
      if (!dueAt) continue;
      const dueDate = shanghaiDateKey(Date.parse(dueAt));
      const checkedCount = getCheckedDates(card).length;
      const title = `${card.title} · 每日打卡提醒`;
      const sourceText = `打卡「${card.title}」（${checkedCount}/${card.metricTarget}天）· 每日最晚 ${reminder} 提醒`;

      if (!previous) {
        await todoPort.create({
          id: todoId,
          space: 'life',
          title,
          status: 'pending',
          dueAt,
          dueDate,
          needsTime: false,
          sourceText,
        });
      } else if (
        previous.status !== 'pending'
        || previous.title !== title
        || previous.dueAt !== dueAt
        || previous.dueDate !== dueDate
        || previous.needsTime !== false
      ) {
        await todoPort.update(previous, {
          status: 'pending',
          title,
          dueAt,
          dueDate,
          needsTime: false,
          completedAt: undefined,
          sourceText,
        });
      }
    }

    for (const previous of existing) {
      if (!previous.id.startsWith(CHECKIN_REMINDER_PREFIX)) continue;
      if (seen.has(previous.id)) continue;
      if (previous.status === 'pending' || previous.status === 'suggested') {
        await todoPort.cancel(previous);
      }
    }
  };

  syncChain = syncChain.then(run, run);
  return syncChain;
}
