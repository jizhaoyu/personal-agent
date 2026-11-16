import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, Pencil, X } from 'lucide-react';
import type { CustomLivingCard } from '../types';
import { Repository } from '../persistence/repository';
import { TodoService } from '../services/todos';
import { shanghaiDateKey } from '../services/dates';
import { useI18n, type I18nKey } from '../i18n';
import {
  DEFAULT_CHECKIN_REMINDER_TIME,
  MAX_ACTIVE_CHECKINS,
  MAX_CHECKIN_DAYS,
  computeNextCheckinReminderDueAt,
  createCheckinCard,
  deleteCheckinCard,
  getCheckedDates,
  getCheckinErrorCode,
  hasCheckedToday,
  partitionCheckinCards,
  renameCheckinCard,
  syncCheckinReminders,
  toggleArchiveCheckinCard,
  toggleTodayCheckin,
  updateCheckinReminder,
  type CheckinErrorCode,
} from '../services/checkins';
import './checkins.css';

interface Props {
  onCompanionToast?: (message: string) => void;
}

const PRESET_DAYS = [7, 14, 21, 30] as const;

// Keeps creator expanded across tab switches during the same session once a user opens or creates in it,
// while resetting to smart auto-collapse on fresh page/app reload when active tracks already exist.
let sessionCreatorPreference: boolean | null = null;

export function CheckinBoard({ onCompanionToast }: Props) {
  const { lang, t } = useI18n();
  const tr = (key: string, fallback: { zh: string; en: string }, params?: Record<string, string | number>): string => {
    const resolved = t(key as I18nKey, params);
    if (resolved !== key) return resolved;
    const tpl = lang === 'en' ? fallback.en : fallback.zh;
    if (!params) return tpl;
    return tpl.replace(/\{([A-Za-z0-9_]+)\}/g, (_, token) =>
      Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : `{${token}}`,
    );
  };

  const [cards, setCards] = useState<CustomLivingCard[]>(() => Repository.getCurrent().partitions.life.customCards);
  const [creatorOpen, setCreatorOpen] = useState(
    () => sessionCreatorPreference ?? partitionCheckinCards(Repository.getCurrent().partitions.life.customCards).active.length === 0,
  );
  const [title, setTitle] = useState('');
  const [daysTarget, setDaysTarget] = useState<number>(7);
  const [daysInput, setDaysInput] = useState<string>('7');
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderTime, setReminderTime] = useState(DEFAULT_CHECKIN_REMINDER_TIME);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const [now, setNow] = useState(Date.now);

  const mountedRef = useRef(true);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const toastRef = useRef(onCompanionToast);
  toastRef.current = onCompanionToast;
  const noticeSeqRef = useRef(0);

  const showNotice = (text: string) => {
    noticeSeqRef.current += 1;
    setNotice({ id: noticeSeqRef.current, text });
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      if (mountedRef.current) setNotice(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [notice?.id]);

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

  function formatCheckinFailure(failure: unknown): string {
    const rawCode = getCheckinErrorCode(failure)
      ?? (failure && typeof failure === 'object' && typeof (failure as { errorCode?: unknown }).errorCode === 'string'
        ? (failure as { errorCode: CheckinErrorCode }).errorCode
        : undefined);
    const codeMap: Record<CheckinErrorCode, () => string> = {
      NOT_FOUND: () => t('checkin.errNotFound'),
      ARCHIVED: () => t('checkin.errArchived'),
      TARGET_REACHED: () => t('checkin.errAlreadyCompleted'),
      MAX_ACTIVE_RESTORE: () => t('checkin.errMaxActiveRestore', { max: MAX_ACTIVE_CHECKINS }),
      MAX_ACTIVE_LIMIT: () => t('checkin.errMaxActiveCreate', { max: MAX_ACTIVE_CHECKINS }),
      CANNOT_UNDO_AT_CAP: () => t('checkin.errCannotUndoAtCap', { max: MAX_ACTIVE_CHECKINS }),
      INVALID_TIME: () => t('checkin.errBadReminderFormat'),
      EMPTY_TITLE: () => t('checkin.emptyTitleError'),
      INVALID_DAYS: () => t('checkin.daysRangeError', { max: MAX_CHECKIN_DAYS }),
      ALREADY_DONE_TODAY: () => t('checkin.alreadyCheckedNotice'),
    };
    if (rawCode && Object.prototype.hasOwnProperty.call(codeMap, rawCode)) {
      return codeMap[rawCode]();
    }
    if (failure instanceof Error && failure.message) return failure.message;
    if (failure && typeof failure === 'object' && typeof (failure as { message?: unknown }).message === 'string') {
      const msg = (failure as { message: string }).message;
      if (msg) return msg;
    }
    return t('checkin.saveErrorFallback');
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
        setNotice(null);
        if (feedback) {
          toastRef.current?.(feedback);
        }
      } catch (failure) {
        if (mountedRef.current) {
          setError(formatCheckinFailure(failure));
        }
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    });
  }

  const { active, completed, archived } = partitionCheckinCards(cards);
  const activeCount = active.length;
  const checkedTodayCount = active.filter(card => hasCheckedToday(card, now)).length;
  const slotsFull = activeCount >= MAX_ACTIVE_CHECKINS;
  const isEmptyBoard = activeCount === 0 && completed.length === 0;
  const showCreator = isEmptyBoard || creatorOpen;

  function handleCustomDaysBlur() {
    const trimmed = daysInput.trim();
    if (!trimmed) {
      const fallback = daysTarget >= 1 && daysTarget <= MAX_CHECKIN_DAYS ? daysTarget : 7;
      setDaysTarget(fallback);
      setDaysInput(String(fallback));
      return;
    }
    const parsed = Math.round(Number(trimmed));
    const clamped = Number.isFinite(parsed)
      ? Math.max(1, Math.min(MAX_CHECKIN_DAYS, parsed))
      : daysTarget || 7;
    setDaysTarget(clamped);
    setDaysInput(String(clamped));
  }

  function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      setError(t('checkin.titleRequiredError'));
      return;
    }
    const rawDays = daysInput.trim();
    const parsedDays = rawDays === '' ? NaN : Math.round(Number(rawDays));
    if (!Number.isFinite(parsedDays) || parsedDays < 1 || parsedDays > MAX_CHECKIN_DAYS) {
      const clamped = Number.isFinite(parsedDays)
        ? Math.max(1, Math.min(MAX_CHECKIN_DAYS, parsedDays))
        : daysTarget || 7;
      setDaysTarget(clamped);
      setDaysInput(String(clamped));
      setError(t('checkin.daysRangeError', { max: MAX_CHECKIN_DAYS }));
      return;
    }
    setDaysTarget(parsedDays);
    setDaysInput(String(parsedDays));
    const desiredReminder = reminderEnabled ? reminderTime : undefined;
    runMutation(latest => {
      const { cards: nextAll, card } = createCheckinCard(latest, {
        title: nextTitle,
        daysTarget: parsedDays,
        dailyReminderTime: desiredReminder,
      });
      if (mountedRef.current) {
        sessionCreatorPreference = true;
        setCreatorOpen(true);
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
    setConfirmDeleteId(null);
    setError('');
  }

  function commitRename(card: CustomLivingCard) {
    if (editingId !== card.id) return;
    const next = editingTitle.trim();
    if (!next) {
      setError(t('checkin.emptyTitleError'));
      return;
    }
    setEditingId(null);
    if (next === card.title) return;
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
    setConfirmDeleteId(null);
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

  function renderDeleteConfirmBar(card: CustomLivingCard) {
    return (
      <div
        className="checkin-delete-confirm"
        role="group"
        aria-label={tr('checkin.deleteConfirmAria', { zh: '确认删除打卡', en: 'Confirm deleting check-in' })}
      >
        <span className="checkin-delete-confirm-text">
          {tr('checkin.deleteConfirmPrompt', { zh: '确认删除「{title}」？', en: 'Delete "{title}"?' }, { title: card.title })}
        </span>
        <div className="checkin-delete-confirm-btns">
          <button
            type="button"
            className="checkin-danger-confirm-btn"
            disabled={busy}
            onClick={() => handleDelete(card)}
          >
            {t('checkin.confirmDeleteBtn')}
          </button>
          <button
            type="button"
            className="text-btn"
            disabled={busy}
            onClick={() => setConfirmDeleteId(null)}
          >
            {t('checkin.cancelBtn')}
          </button>
        </div>
      </div>
    );
  }

  function renderCard(card: CustomLivingCard) {
    const checkedDates = getCheckedDates(card);
    const checkedCount = checkedDates.length;
    const checkedToday = hasCheckedToday(card, now);
    const doneAll = checkedCount >= card.metricTarget;
    const pct = card.metricTarget > 0 ? Math.min(100, Math.round((checkedCount / card.metricTarget) * 100)) : 0;
    const isEditing = editingId === card.id;
    const isConfirmingDelete = confirmDeleteId === card.id;

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
                />
                <button
                  type="button"
                  className="soft-btn checkin-rename-action"
                  aria-label={t('checkin.saveBtn')}
                  title={t('checkin.saveBtn')}
                  onClick={() => commitRename(card)}
                >
                  <Check size={14} aria-hidden="true" />
                  <span>{t('checkin.saveBtn')}</span>
                </button>
                <button
                  type="button"
                  className="text-btn checkin-rename-action"
                  aria-label={t('checkin.cancelBtn')}
                  title={t('checkin.cancelBtn')}
                  onClick={() => setEditingId(null)}
                >
                  <X size={14} aria-hidden="true" />
                  <span>{t('checkin.cancelBtn')}</span>
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
            {!doneAll && !checkedToday ? (
              <button
                type="button"
                className="checkin-today-chip checkin-today-chip--pending"
                disabled={busy}
                onClick={() => handleToggleToday(card)}
              >
                {t('checkin.tapTodayBadge')}
              </button>
            ) : (
              <span className="checkin-today-chip checkin-today-chip--done">
                {doneAll ? t('checkin.statusDoneAll') : t('checkin.statusCheckedToday')}
              </span>
            )}
          </div>
        </div>

        <div className="checkin-progress-row">
          <div
            className="checkin-progress-track"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('checkin.progressDays', { done: checkedCount, target: card.metricTarget })}
          >
            <div className="checkin-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="checkin-progress-pct">{pct}%</span>
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
                    showNotice(t('checkin.pastBoxNotice', { day: idx + 1, date: checkedDates[idx] }));
                  } else {
                    showNotice(
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

          {isConfirmingDelete ? (
            renderDeleteConfirmBar(card)
          ) : (
            <div className="checkin-card-actions">
              <button type="button" className="text-btn" disabled={busy} onClick={() => handleArchiveToggle(card)}>
                {t('checkin.archiveBtn')}
              </button>
              <button
                type="button"
                className="text-btn checkin-danger-trigger"
                disabled={busy}
                onClick={() => handleDelete(card)}
              >
                {t('checkin.deleteBtn')}
              </button>
            </div>
          )}
        </div>
      </article>
    );
  }

  const creatorBarEl = !isEmptyBoard && (
    <div className="checkin-creator-bar">
      <button
        type="button"
        className={`checkin-toggle-btn${showCreator ? ' is-open' : ''}`}
        aria-expanded={showCreator}
        onClick={() => {
          const next = !showCreator;
          sessionCreatorPreference = next;
          setCreatorOpen(next);
        }}
      >
        {showCreator ? t('checkin.collapseTrackToggle') : t('checkin.newTrackToggle')}
      </button>
    </div>
  );

  const creatorFormEl = showCreator && (
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
            className={`checkin-preset-btn${daysTarget === preset && daysInput.trim() !== '' ? ' is-selected' : ''}`}
            disabled={slotsFull}
            onClick={() => {
              setDaysTarget(preset);
              setDaysInput(String(preset));
            }}
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
          value={daysInput}
          disabled={slotsFull}
          onChange={e => {
            const raw = e.target.value;
            setDaysInput(raw);
            if (raw.trim() !== '') {
              const parsed = Math.round(Number(raw));
              if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_CHECKIN_DAYS) {
                setDaysTarget(parsed);
              }
            }
          }}
          onBlur={handleCustomDaysBlur}
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
  );

  const listEl = (
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
  );

  return (
    <section className="checkin-panel" aria-label={t('checkin.panelAria')}>
      <header className="checkin-header">
        <div className="checkin-header-title">
          <span className="eyebrow">{t('checkin.eyebrow')}</span>
          <h2>{t('checkin.title')}</h2>
          <p className="checkin-subtitle">{t('checkin.subtitle', { max: MAX_ACTIVE_CHECKINS })}</p>
        </div>
        <div className="checkin-header-badges">
          <span className={`checkin-pulse-badge${activeCount > 0 && checkedTodayCount === activeCount ? ' checkin-pulse-badge--all-done' : activeCount === 0 ? ' checkin-pulse-badge--idle' : ''}`}>
            {t('checkin.todayPulse', { done: checkedTodayCount, active: activeCount })}
          </span>
          <span className={`checkin-slot-badge${slotsFull ? ' checkin-slot-badge--full' : ''}`}>
            {t('checkin.activeBadge', { count: activeCount, max: MAX_ACTIVE_CHECKINS })}
          </span>
        </div>
      </header>

      {error && (
        <p className="checkin-alert checkin-alert--error" role="alert">
          <span>{error}</span>
          <button type="button" className="text-btn" onClick={() => setError('')}>{t('checkin.dismissErrorBtn')}</button>
        </p>
      )}
      {!error && notice && (
        <p className="checkin-alert checkin-alert--notice" role="status">
          <span>{notice.text}</span>
          <button type="button" className="text-btn" onClick={() => setNotice(null)}>{t('checkin.dismissNoticeBtn')}</button>
        </p>
      )}

      {active.length > 0 ? (
        <>
          {listEl}
          {creatorBarEl}
          {creatorFormEl}
        </>
      ) : (
        <>
          {creatorBarEl}
          {creatorFormEl}
          {listEl}
        </>
      )}

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
                {confirmDeleteId === card.id ? (
                  renderDeleteConfirmBar(card)
                ) : (
                  <div className="checkin-card-actions">
                    <button type="button" className="text-btn" disabled={busy} onClick={() => handleArchiveToggle(card)}>
                      {t('checkin.restoreBtn')}
                    </button>
                    <button
                      type="button"
                      className="text-btn checkin-danger-trigger"
                      disabled={busy}
                      onClick={() => handleDelete(card)}
                    >
                      {t('checkin.deleteBtn')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
