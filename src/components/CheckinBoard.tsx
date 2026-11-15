import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, Pencil } from 'lucide-react';
import type { CustomLivingCard } from '../types';
import { Repository } from '../persistence/repository';
import { TodoService } from '../services/todos';
import { shanghaiDateKey } from '../services/dates';
import {
  DEFAULT_CHECKIN_REMINDER_TIME,
  MAX_ACTIVE_CHECKINS,
  MAX_CHECKIN_DAYS,
  computeNextCheckinReminderDueAt,
  createCheckinCard,
  deleteCheckinCard,
  getCheckedDates,
  hasCheckedToday,
  partitionCheckinCards,
  renameCheckinCard,
  syncCheckinReminders,
  toggleArchiveCheckinCard,
  toggleTodayCheckin,
  updateCheckinReminder,
} from '../services/checkins';
import './checkins.css';

interface Props {
  onCompanionToast?: (message: string) => void;
}

const PRESET_DAYS = [7, 14, 21, 30] as const;

export function CheckinBoard({ onCompanionToast }: Props) {
  const [cards, setCards] = useState<CustomLivingCard[]>(() => Repository.getCurrent().partitions.life.customCards);
  const [title, setTitle] = useState('');
  const [daysTarget, setDaysTarget] = useState<number>(7);
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderTime, setReminderTime] = useState(DEFAULT_CHECKIN_REMINDER_TIME);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now);

  const mountedRef = useRef(true);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const toastRef = useRef(onCompanionToast);
  toastRef.current = onCompanionToast;

  useEffect(() => {
    mountedRef.current = true;
    const syncFromStore = () => {
      if (!mountedRef.current) return;
      setCards(Repository.getCurrent().partitions.life.customCards);
    };
    void Repository.getCustomCards('life').then(list => {
      if (mountedRef.current) setCards(list);
    }).catch(() => syncFromStore());
    const unsubscribe = Repository.subscribe(syncFromStore);
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  function runMutation(
    transform: (latestAll: CustomLivingCard[]) => { nextAll: CustomLivingCard[]; feedback?: string; enableScheduler?: boolean },
  ) {
    queueRef.current = queueRef.current.then(async () => {
      if (!mountedRef.current) return;
      setBusy(true);
      setError('');
      try {
        const latest = await Repository.getCustomCards('life');
        const { nextAll, feedback, enableScheduler } = transform(latest);
        await Repository.saveCustomCards(nextAll, 'life');
        if (enableScheduler) {
          await TodoService.configure(true).catch(() => {});
        }
        await syncCheckinReminders(nextAll, TodoService);
        if (!mountedRef.current) return;
        setCards(nextAll);
        setNotice('');
        if (feedback) {
          toastRef.current?.(feedback);
        }
      } catch (failure) {
        if (mountedRef.current) {
          setError(failure instanceof Error ? failure.message : '打卡更新失败，原有记录仍保留。');
        }
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    });
  }

  const { active, completed, archived } = partitionCheckinCards(cards);
  const activeCount = active.length;
  const slotsFull = activeCount >= MAX_ACTIVE_CHECKINS;

  function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError('请先填写打卡名称。');
      return;
    }
    const cleanDays = Math.round(Number(daysTarget));
    if (!Number.isFinite(cleanDays) || cleanDays < 1 || cleanDays > MAX_CHECKIN_DAYS) {
      setError(`打卡天数需在 1 到 ${MAX_CHECKIN_DAYS} 天之间。`);
      return;
    }
    const desiredReminder = reminderEnabled ? reminderTime : undefined;
    runMutation(latest => {
      const { cards: nextAll, card } = createCheckinCard(latest, {
        title: nextTitle,
        daysTarget: cleanDays,
        dailyReminderTime: desiredReminder,
      });
      if (mountedRef.current) {
        setTitle('');
      }
      return {
        nextAll,
        enableScheduler: Boolean(card.dailyReminderTime),
        feedback: `已开启「${card.title}」${card.metricTarget} 天打卡${card.dailyReminderTime ? ` · 每日最晚 ${card.dailyReminderTime} 提醒` : ''}`,
      };
    });
  }

  function startRename(card: CustomLivingCard) {
    setEditingId(card.id);
    setEditingTitle(card.title);
    setError('');
  }

  function commitRename(card: CustomLivingCard) {
    if (editingId !== card.id) return;
    const next = editingTitle.trim();
    setEditingId(null);
    if (!next || next === card.title) {
      if (!next) setError('打卡名称不能为空，已保留原名称。');
      return;
    }
    runMutation(latest => ({
      nextAll: renameCheckinCard(latest, card.id, next),
      feedback: `已更名为「${next}」`,
    }));
  }

  function handleToggleToday(card: CustomLivingCard) {
    if (busy) return;
    runMutation(latest => {
      const res = toggleTodayCheckin(latest, card.id);
      return {
        nextAll: res.cards,
        feedback: res.action === 'checked'
          ? `已完成「${res.card.title}」今日打卡（${res.card.metricValue}/${res.card.metricTarget}）`
          : `已撤销「${res.card.title}」今日打卡`,
      };
    });
  }

  function handleReminderToggle(card: CustomLivingCard, enabled: boolean) {
    if (busy) return;
    const nextTime = enabled ? (card.dailyReminderTime || DEFAULT_CHECKIN_REMINDER_TIME) : undefined;
    runMutation(latest => ({
      nextAll: updateCheckinReminder(latest, card.id, nextTime),
      enableScheduler: enabled,
      feedback: enabled ? `已开启「${card.title}」每日最晚 ${nextTime} 提醒` : `已关闭「${card.title}」每日提醒`,
    }));
  }

  function handleReminderTimeChange(card: CustomLivingCard, nextTime: string) {
    if (busy || !nextTime) return;
    runMutation(latest => ({
      nextAll: updateCheckinReminder(latest, card.id, nextTime),
      enableScheduler: true,
      feedback: `已更新「${card.title}」提醒时间为每日 ${nextTime}`,
    }));
  }

  function handleArchiveToggle(card: CustomLivingCard) {
    if (busy) return;
    runMutation(latest => ({
      nextAll: toggleArchiveCheckinCard(latest, card.id),
      feedback: card.archived ? `已恢复「${card.title}」` : `已归档「${card.title}」`,
    }));
  }

  function handleDelete(card: CustomLivingCard) {
    if (busy) return;
    if (confirmDeleteId !== card.id) {
      setConfirmDeleteId(card.id);
      return;
    }
    setConfirmDeleteId(null);
    runMutation(latest => ({
      nextAll: deleteCheckinCard(latest, card.id),
      feedback: `已删除打卡「${card.title}」`,
    }));
  }

  function reminderHint(card: CustomLivingCard, checkedToday: boolean): string {
    if (!card.dailyReminderTime) return '未设每日提醒';
    const nextIso = computeNextCheckinReminderDueAt(card.dailyReminderTime, checkedToday, now);
    if (!nextIso) return `每日最晚 ${card.dailyReminderTime} 提醒`;
    const nextDay = shanghaiDateKey(Date.parse(nextIso));
    const today = shanghaiDateKey(now);
    if (nextDay === today) return `今日最晚 ${card.dailyReminderTime} 提醒`;
    return checkedToday ? `今日已打 · 下次 明天 ${card.dailyReminderTime}` : `今日时段已过 · 下次 明天 ${card.dailyReminderTime}`;
  }

  function renderCard(card: CustomLivingCard) {
    const checkedDates = getCheckedDates(card);
    const checkedCount = checkedDates.length;
    const checkedToday = hasCheckedToday(card, now);
    const doneAll = checkedCount >= card.metricTarget;
    const isEditing = editingId === card.id;

    return (
      <article
        key={card.id}
        data-checkin-id={card.id}
        className={`checkin-card${doneAll ? ' checkin-card--completed' : checkedToday ? ' checkin-card--checked-today' : ''}`}
      >
        <div className="checkin-card-top">
          <div className="checkin-title-wrap">
            {isEditing ? (
              <div className="checkin-rename-row">
                <input
                  type="text"
                  className="checkin-rename-input"
                  aria-label="修改打卡名称"
                  maxLength={40}
                  value={editingTitle}
                  autoFocus
                  onChange={e => setEditingTitle(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename(card);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingId(null);
                    }
                  }}
                  onBlur={() => commitRename(card)}
                />
                <button
                  type="button"
                  className="soft-btn"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => commitRename(card)}
                >
                  保存
                </button>
                <button
                  type="button"
                  className="text-btn"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => setEditingId(null)}
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="checkin-title-btn"
                title="点击修改标题"
                aria-label={`编辑名称 ${card.title}`}
                onClick={() => startRename(card)}
              >
                <span>{card.title}</span>
                <Pencil size={13} className="checkin-edit-icon" aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="checkin-card-meta">
            <span className="checkin-progress-pill">{checkedCount} / {card.metricTarget} 天</span>
            <span className={`checkin-today-chip ${checkedToday || doneAll ? 'checkin-today-chip--done' : 'checkin-today-chip--pending'}`}>
              {doneAll ? '已圆满' : checkedToday ? '今日已打' : '待打卡'}
            </span>
          </div>
        </div>

        <div className="checkin-squares" role="group" aria-label={`${card.title} 打卡方格`}>
          {Array.from({ length: card.metricTarget }, (_, idx) => {
            const isChecked = idx < checkedCount;
            const isTodayCheckedBox = checkedToday && idx === checkedCount - 1;
            const isTodayNextBox = !checkedToday && !doneAll && idx === checkedCount;

            let cls = 'checkin-square';
            let label = `第 ${idx + 1} 天未解锁`;
            if (isTodayCheckedBox) {
              cls += ' checkin-square--today-done';
              label = `${card.title} 第 ${idx + 1} 天（今日已打，点击可撤销）`;
            } else if (isChecked) {
              cls += ' checkin-square--past';
              label = `${card.title} 第 ${idx + 1} 天已打卡（${checkedDates[idx]}）`;
            } else if (isTodayNextBox) {
              cls += ' checkin-square--today-next';
              label = `${card.title} 第 ${idx + 1} 天今日打卡`;
            } else {
              cls += ' checkin-square--locked';
              label = `${card.title} 第 ${idx + 1} 天（每天限打 1 格）`;
            }

            return (
              <button
                key={idx}
                type="button"
                className={cls}
                aria-pressed={isChecked}
                aria-label={label}
                title={label}
                disabled={busy}
                onClick={() => {
                  if (isTodayCheckedBox || isTodayNextBox) {
                    handleToggleToday(card);
                  } else if (isChecked) {
                    setNotice(`历史第 ${idx + 1} 天已打卡（${checkedDates[idx]}），仅可操作今日这一格。`);
                  } else {
                    setNotice(
                      checkedToday
                        ? '每条打卡线每天限打 1 格，今天已经打过啦，明天再来。'
                        : `每条线每天限打 1 格，请点击第 ${checkedCount + 1} 格完成今日打卡。`,
                    );
                  }
                }}
              >
                {isChecked ? <Check size={16} strokeWidth={2.8} aria-hidden="true" /> : <span>{idx + 1}</span>}
              </button>
            );
          })}
        </div>

        <div className="checkin-card-footer">
          {!doneAll ? (
            <div className="checkin-reminder-inline">
              <Bell size={13} aria-hidden="true" />
              <label className="checkin-check-label">
                <input
                  type="checkbox"
                  checked={Boolean(card.dailyReminderTime)}
                  disabled={busy}
                  aria-label={`${card.title} 开启每日提醒`}
                  onChange={e => handleReminderToggle(card, e.target.checked)}
                />
                <span>每日</span>
              </label>
              <input
                type="time"
                className="checkin-time-input"
                aria-label={`${card.title} 每日最晚提醒时间`}
                value={card.dailyReminderTime || DEFAULT_CHECKIN_REMINDER_TIME}
                disabled={busy || !card.dailyReminderTime}
                onChange={e => handleReminderTimeChange(card, e.target.value)}
              />
              <span className="checkin-reminder-note">{reminderHint(card, checkedToday)}</span>
            </div>
          ) : (
            <span className="checkin-reminder-note">已完成全部 {card.metricTarget} 天目标，已自动腾出并行名额</span>
          )}

          <div className="checkin-card-actions">
            <button type="button" className="text-btn" disabled={busy} onClick={() => handleArchiveToggle(card)}>
              归档
            </button>
            <button
              type="button"
              className={`text-btn${confirmDeleteId === card.id ? ' checkin-danger-btn' : ''}`}
              disabled={busy}
              onBlur={() => { if (confirmDeleteId === card.id) setConfirmDeleteId(null); }}
              onClick={() => handleDelete(card)}
            >
              {confirmDeleteId === card.id ? '确认删除' : '删除'}
            </button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <section className="checkin-panel" aria-label="每日打卡">
      <header className="checkin-header">
        <div>
          <span className="eyebrow">DAILY CHECK-IN</span>
          <h2>每日打卡</h2>
          <p className="checkin-subtitle">专注当前想坚持的小习惯 · 最多 {MAX_ACTIVE_CHECKINS} 条并行 · 每日限打 1 格</p>
        </div>
        <span className={`checkin-slot-badge${slotsFull ? ' checkin-slot-badge--full' : ''}`}>
          进行中 {activeCount} / {MAX_ACTIVE_CHECKINS}
        </span>
      </header>

      {error && (
        <p className="checkin-alert checkin-alert--error" role="alert">
          <span>{error}</span>
          <button type="button" className="text-btn" onClick={() => setError('')}>收起</button>
        </p>
      )}
      {!error && notice && (
        <p className="checkin-alert checkin-alert--notice" role="status">
          <span>{notice}</span>
          <button type="button" className="text-btn" onClick={() => setNotice('')}>知道了</button>
        </p>
      )}

      <form className="checkin-creator" onSubmit={handleCreate}>
        <div className="checkin-creator-row">
          <input
            type="text"
            className="checkin-title-input"
            aria-label="新打卡名称"
            placeholder={slotsFull ? '当前 3 条并行已满，可先完成或归档其中一条' : '想完成什么打卡？（如：读书、背单词）'}
            maxLength={40}
            value={title}
            disabled={slotsFull}
            onChange={e => setTitle(e.target.value)}
          />
        </div>

        <div className="checkin-days-bar">
          <span className="checkin-days-label">目标天数：</span>
          {PRESET_DAYS.map(preset => (
            <button
              key={preset}
              type="button"
              className={`checkin-preset-btn${daysTarget === preset ? ' is-selected' : ''}`}
              disabled={slotsFull}
              onClick={() => setDaysTarget(preset)}
            >
              {preset}天
            </button>
          ))}
          <input
            type="number"
            className="checkin-custom-days"
            aria-label="自定义打卡天数"
            min={1}
            max={MAX_CHECKIN_DAYS}
            value={daysTarget}
            disabled={slotsFull}
            onChange={e => setDaysTarget(Math.max(1, Math.min(MAX_CHECKIN_DAYS, Number(e.target.value) || 1)))}
          />
        </div>

        <div className="checkin-creator-footer">
          <div className="checkin-reminder-inline">
            <label className="checkin-check-label">
              <input
                type="checkbox"
                checked={reminderEnabled}
                disabled={slotsFull}
                onChange={e => setReminderEnabled(e.target.checked)}
              />
              <span>每日最晚提醒</span>
            </label>
            <input
              type="time"
              className="checkin-time-input"
              aria-label="新打卡每日最晚提醒时间"
              value={reminderTime}
              disabled={slotsFull || !reminderEnabled}
              onChange={e => setReminderTime(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="checkin-create-btn"
            disabled={busy || slotsFull || !title.trim()}
          >
            {slotsFull ? '并行上限 3 条' : '+ 开启打卡'}
          </button>
        </div>
      </form>

      <div className="checkin-list">
        {active.length === 0 && completed.length === 0 && (
          <p className="checkin-empty">
            还没有开启任何打卡。
            <br />
            试试输入「读书」，选 7 天、最晚 21:30 提醒，每天随手点亮一格。
          </p>
        )}
        {active.map(renderCard)}
        {completed.length > 0 && (
          <>
            <p className="checkin-section-label">已完成目标（可归档或重开）</p>
            {completed.map(renderCard)}
          </>
        )}
      </div>

      {archived.length > 0 && (
        <details className="checkin-archived">
          <summary>已归档 · {archived.length}</summary>
          <div className="checkin-archived-list">
            {archived.map(card => (
              <div key={card.id} className="checkin-archived-row">
                <div className="checkin-archived-info">
                  <strong>{card.title}</strong>
                  <span>进度 {getCheckedDates(card).length} / {card.metricTarget} 天</span>
                </div>
                <div className="checkin-card-actions">
                  <button type="button" className="text-btn" disabled={busy} onClick={() => handleArchiveToggle(card)}>
                    恢复
                  </button>
                  <button
                    type="button"
                    className={`text-btn${confirmDeleteId === card.id ? ' checkin-danger-btn' : ''}`}
                    disabled={busy}
                    onBlur={() => { if (confirmDeleteId === card.id) setConfirmDeleteId(null); }}
                    onClick={() => handleDelete(card)}
                  >
                    {confirmDeleteId === card.id ? '确认删除' : '删除'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
