import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, Pencil } from 'lucide-react';
import type { CustomLivingCard } from '../types';
import { Repository } from '../persistence/repository';
import { TodoService } from '../services/todos';
import { shanghaiDateKey } from '../services/dates';
import { useI18n } from '../i18n';
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
  const { t } = useI18n();
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

  function formatCheckinError(message: string): string {
    if (message === '未找到对应的打卡项目。') return t('checkin.errNotFound');
    if (message === '该打卡已归档，请先恢复后再操作。') return t('checkin.errArchived');
    if (message === '这条打卡已经全部完成了，可先归档或新建一轮。') return t('checkin.errAlreadyCompleted');
    if (message.includes('请先归档或完成其他进行中的打卡')) return t('checkin.errMaxActiveRestore', { max: MAX_ACTIVE_CHECKINS });
    if (message.includes('最多同时进行')) return t('checkin.errMaxActiveCreate', { max: MAX_ACTIVE_CHECKINS });
    if (message.includes('无法撤销已完成打卡')) return t('checkin.errCannotUndoAtCap', { max: MAX_ACTIVE_CHECKINS });
    if (message.includes('每日提醒时间格式无效')) return t('checkin.errBadReminderFormat');
    return message;
  }

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
          setError(failure instanceof Error ? formatCheckinError(failure.message) : t('checkin.saveErrorFallback'));
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
      setError(t('checkin.titleRequiredError'));
      return;
    }
    const cleanDays = Math.round(Number(daysTarget));
    if (!Number.isFinite(cleanDays) || cleanDays < 1 || cleanDays > MAX_CHECKIN_DAYS) {
      setError(t('checkin.daysRangeError', { max: MAX_CHECKIN_DAYS }));
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
        feedback: card.dailyReminderTime
          ? t('checkin.createdFeedbackWithReminder', { title: card.title, days: card.metricTarget, time: card.dailyReminderTime })
          : t('checkin.createdFeedbackNoReminder', { title: card.title, days: card.metricTarget }),
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
      if (!next) setError(t('checkin.emptyTitleError'));
      return;
    }
    runMutation(latest => ({
      nextAll: renameCheckinCard(latest, card.id, next),
      feedback: t('checkin.renamedFeedback', { title: next }),
    }));
  }

  function handleToggleToday(card: CustomLivingCard) {
    if (busy) return;
    runMutation(latest => {
      const res = toggleTodayCheckin(latest, card.id);
      return {
        nextAll: res.cards,
        feedback: res.action === 'checked'
          ? t('checkin.checkedFeedback', { title: res.card.title, value: res.card.metricValue, target: res.card.metricTarget })
          : t('checkin.uncheckedFeedback', { title: res.card.title }),
      };
    });
  }

  function handleReminderToggle(card: CustomLivingCard, enabled: boolean) {
    if (busy) return;
    const nextTime = enabled ? (card.dailyReminderTime || DEFAULT_CHECKIN_REMINDER_TIME) : undefined;
    runMutation(latest => ({
      nextAll: updateCheckinReminder(latest, card.id, nextTime),
      enableScheduler: enabled,
      feedback: enabled && nextTime
        ? t('checkin.reminderOnFeedback', { title: card.title, time: nextTime })
        : t('checkin.reminderOffFeedback', { title: card.title }),
    }));
  }

  function handleReminderTimeChange(card: CustomLivingCard, nextTime: string) {
    if (busy || !nextTime) return;
    runMutation(latest => ({
      nextAll: updateCheckinReminder(latest, card.id, nextTime),
      enableScheduler: true,
      feedback: t('checkin.reminderTimeFeedback', { title: card.title, time: nextTime }),
    }));
  }

  function handleArchiveToggle(card: CustomLivingCard) {
    if (busy) return;
    runMutation(latest => ({
      nextAll: toggleArchiveCheckinCard(latest, card.id),
      feedback: card.archived ? t('checkin.restoredFeedback', { title: card.title }) : t('checkin.archivedFeedback', { title: card.title }),
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
      feedback: t('checkin.deletedFeedback', { title: card.title }),
    }));
  }

  function reminderHint(card: CustomLivingCard, checkedToday: boolean): string {
    if (!card.dailyReminderTime) return t('checkin.hintNoReminder');
    const nextIso = computeNextCheckinReminderDueAt(card.dailyReminderTime, checkedToday, now);
    if (!nextIso) return t('checkin.hintDaily', { time: card.dailyReminderTime });
    const nextDay = shanghaiDateKey(Date.parse(nextIso));
    const today = shanghaiDateKey(now);
    if (nextDay === today) return t('checkin.hintToday', { time: card.dailyReminderTime });
    return checkedToday
      ? t('checkin.hintDoneNext', { time: card.dailyReminderTime })
      : t('checkin.hintMissedNext', { time: card.dailyReminderTime });
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
                  aria-label={t('checkin.renameInputAria')}
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
                  {t('checkin.saveBtn')}
                </button>
                <button
                  type="button"
                  className="text-btn"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => setEditingId(null)}
                >
                  {t('checkin.cancelBtn')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="checkin-title-btn"
                title={t('checkin.editTitleTooltip')}
                aria-label={t('checkin.editTitleAria', { title: card.title })}
                onClick={() => startRename(card)}
              >
                <span>{card.title}</span>
                <Pencil size={13} className="checkin-edit-icon" aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="checkin-card-meta">
            <span className="checkin-progress-pill">{t('checkin.progressDays', { done: checkedCount, target: card.metricTarget })}</span>
            <span className={`checkin-today-chip ${checkedToday || doneAll ? 'checkin-today-chip--done' : 'checkin-today-chip--pending'}`}>
              {doneAll ? t('checkin.statusDoneAll') : checkedToday ? t('checkin.statusCheckedToday') : t('checkin.statusPending')}
            </span>
          </div>
        </div>

        <div className="checkin-squares" role="group" aria-label={t('checkin.squaresAria', { title: card.title })}>
          {Array.from({ length: card.metricTarget }, (_, idx) => {
            const isChecked = idx < checkedCount;
            const isTodayCheckedBox = checkedToday && idx === checkedCount - 1;
            const isTodayNextBox = !checkedToday && !doneAll && idx === checkedCount;

            let cls = 'checkin-square';
            let label = '';
            if (isTodayCheckedBox) {
              cls += ' checkin-square--today-done';
              label = t('checkin.squareLabelTodayDone', { title: card.title, day: idx + 1 });
            } else if (isChecked) {
              cls += ' checkin-square--past';
              label = t('checkin.squareLabelPast', { title: card.title, day: idx + 1, date: checkedDates[idx] });
            } else if (isTodayNextBox) {
              cls += ' checkin-square--today-next';
              label = t('checkin.squareLabelTodayNext', { title: card.title, day: idx + 1 });
            } else {
              cls += ' checkin-square--locked';
              label = t('checkin.squareLabelLocked', { title: card.title, day: idx + 1 });
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
                    setNotice(t('checkin.pastBoxNotice', { day: idx + 1, date: checkedDates[idx] }));
                  } else {
                    setNotice(
                      checkedToday
                        ? t('checkin.alreadyCheckedNotice')
                        : t('checkin.clickNextNotice', { day: checkedCount + 1 }),
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
                  aria-label={t('checkin.toggleReminderAria', { title: card.title })}
                  onChange={e => handleReminderToggle(card, e.target.checked)}
                />
                <span>{t('checkin.dailyLabel')}</span>
              </label>
              <input
                type="time"
                className="checkin-time-input"
                aria-label={t('checkin.reminderTimeInputAria', { title: card.title })}
                value={card.dailyReminderTime || DEFAULT_CHECKIN_REMINDER_TIME}
                disabled={busy || !card.dailyReminderTime}
                onChange={e => handleReminderTimeChange(card, e.target.value)}
              />
              <span className="checkin-reminder-note">{reminderHint(card, checkedToday)}</span>
            </div>
          ) : (
            <span className="checkin-reminder-note">{t('checkin.completedAllNote', { target: card.metricTarget })}</span>
          )}

          <div className="checkin-card-actions">
            <button type="button" className="text-btn" disabled={busy} onClick={() => handleArchiveToggle(card)}>
              {t('checkin.archiveBtn')}
            </button>
            <button
              type="button"
              className={`text-btn${confirmDeleteId === card.id ? ' checkin-danger-btn' : ''}`}
              disabled={busy}
              onBlur={() => { if (confirmDeleteId === card.id) setConfirmDeleteId(null); }}
              onClick={() => handleDelete(card)}
            >
              {confirmDeleteId === card.id ? t('checkin.confirmDeleteBtn') : t('checkin.deleteBtn')}
            </button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <section className="checkin-panel" aria-label={t('checkin.panelAria')}>
      <header className="checkin-header">
        <div>
          <span className="eyebrow">{t('checkin.eyebrow')}</span>
          <h2>{t('checkin.title')}</h2>
          <p className="checkin-subtitle">{t('checkin.subtitle', { max: MAX_ACTIVE_CHECKINS })}</p>
        </div>
        <span className={`checkin-slot-badge${slotsFull ? ' checkin-slot-badge--full' : ''}`}>
          {t('checkin.activeBadge', { count: activeCount, max: MAX_ACTIVE_CHECKINS })}
        </span>
      </header>

      {error && (
        <p className="checkin-alert checkin-alert--error" role="alert">
          <span>{error}</span>
          <button type="button" className="text-btn" onClick={() => setError('')}>{t('checkin.dismissErrorBtn')}</button>
        </p>
      )}
      {!error && notice && (
        <p className="checkin-alert checkin-alert--notice" role="status">
          <span>{notice}</span>
          <button type="button" className="text-btn" onClick={() => setNotice('')}>{t('checkin.dismissNoticeBtn')}</button>
        </p>
      )}

      <form className="checkin-creator" onSubmit={handleCreate}>
        <div className="checkin-creator-row">
          <input
            type="text"
            className="checkin-title-input"
            aria-label={t('checkin.newNameAria')}
            placeholder={slotsFull ? t('checkin.newNamePlaceholderFull') : t('checkin.newNamePlaceholder')}
            maxLength={40}
            value={title}
            disabled={slotsFull}
            onChange={e => setTitle(e.target.value)}
          />
        </div>

        <div className="checkin-days-bar">
          <span className="checkin-days-label">{t('checkin.targetDaysLabel')}</span>
          {PRESET_DAYS.map(preset => (
            <button
              key={preset}
              type="button"
              className={`checkin-preset-btn${daysTarget === preset ? ' is-selected' : ''}`}
              disabled={slotsFull}
              onClick={() => setDaysTarget(preset)}
            >
              {t('checkin.presetDaysLabel', { days: preset })}
            </button>
          ))}
          <input
            type="number"
            className="checkin-custom-days"
            aria-label={t('checkin.customDaysAria')}
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
              <span>{t('checkin.newReminderCheck')}</span>
            </label>
            <input
              type="time"
              className="checkin-time-input"
              aria-label={t('checkin.newReminderTimeAria')}
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
            {slotsFull ? t('checkin.createBtnFull') : t('checkin.createBtn')}
          </button>
        </div>
      </form>

      <div className="checkin-list">
        {active.length === 0 && completed.length === 0 && (
          <p className="checkin-empty">
            {t('checkin.emptyLine1')}
            <br />
            {t('checkin.emptyLine2')}
          </p>
        )}
        {active.map(renderCard)}
        {completed.length > 0 && (
          <>
            <p className="checkin-section-label">{t('checkin.completedSectionLabel')}</p>
            {completed.map(renderCard)}
          </>
        )}
      </div>

      {archived.length > 0 && (
        <details className="checkin-archived">
          <summary>{t('checkin.archivedSummary', { count: archived.length })}</summary>
          <div className="checkin-archived-list">
            {archived.map(card => (
              <div key={card.id} className="checkin-archived-row">
                <div className="checkin-archived-info">
                  <strong>{card.title}</strong>
                  <span>{t('checkin.archivedProgress', { done: getCheckedDates(card).length, target: card.metricTarget })}</span>
                </div>
                <div className="checkin-card-actions">
                  <button type="button" className="text-btn" disabled={busy} onClick={() => handleArchiveToggle(card)}>
                    {t('checkin.restoreBtn')}
                  </button>
                  <button
                    type="button"
                    className={`text-btn${confirmDeleteId === card.id ? ' checkin-danger-btn' : ''}`}
                    disabled={busy}
                    onBlur={() => { if (confirmDeleteId === card.id) setConfirmDeleteId(null); }}
                    onClick={() => handleDelete(card)}
                  >
                    {confirmDeleteId === card.id ? t('checkin.confirmDeleteBtn') : t('checkin.deleteBtn')}
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
