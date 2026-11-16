import React, { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import type { TodoRecord, WorkspaceMode } from '../types';
import { TodoService } from '../services/todos';
import { useI18n } from '../i18n';
import './todos.css';

const shanghaiDay = (time: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);

function parseDateTimeInput(raw?: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    const fallback = Date.parse(raw);
    return Number.isFinite(fallback) ? new Date(fallback).toISOString() : undefined;
  }
  const [, y, m, d, hh, mm, ss] = match;
  const year = Number(y), month = Number(m) - 1, day = Number(d), hour = Number(hh), minute = Number(mm), second = Number(ss || 0);
  const parsed = new Date(year, month, day, hour, minute, second);
  if (!Number.isFinite(parsed.getTime()) || parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day) {
    return undefined;
  }
  return parsed.toISOString();
}

function toDateTimeInputValue(iso?: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function groupTodos(rows: TodoRecord[], now = Date.now()) {
  const groups = { today: [] as TodoRecord[], future: [] as TodoRecord[], overdue: [] as TodoRecord[], suggested: [] as TodoRecord[], completed: [] as TodoRecord[] };
  for (const todo of rows) {
    if (todo.status === 'completed') groups.completed.push(todo);
    else if (todo.status === 'suggested') groups.suggested.push(todo);
    else if (todo.status === 'pending') {
      const time = todo.dueAt ? Date.parse(todo.dueAt) : NaN;
      if (time < now) groups.overdue.push(todo);
      else if (Number.isFinite(time) && shanghaiDay(time) === shanghaiDay(now)) groups.today.push(todo);
      else groups.future.push(todo);
    }
  }
  for (const key of ['today', 'future', 'overdue'] as const) groups[key].sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
  groups.completed.sort((a, b) => (b.completedAt || b.updatedAt) - (a.completedAt || a.updatedAt));
  return groups;
}

interface Props {
  space: WorkspaceMode;
  focusId?: string;
  focusRequestId?: string;
  choices?: TodoRecord[];
  choiceAction?: 'complete' | 'cancel' | 'time';
  onChoiceDone?(): void;
  onError?(message: string): void;
}
type Capability = { background: boolean; notifications: string; exactAlarms: string; enabled: boolean };

export function TodoPanel({ space, focusId, focusRequestId, choices, choiceAction = 'complete', onChoiceDone, onError }: Props) {
  const { lang, t } = useI18n();
  const [data, setData] = useState<{ space: WorkspaceMode; todos: TodoRecord[] } | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [dates, setDates] = useState<Record<string, string>>({});
  const [editingTimeIds, setEditingTimeIds] = useState<Record<string, boolean>>({});
  const [capability, setCapability] = useState<Capability | null>(null);
  const [now, setNow] = useState(Date.now);
  const listSequence = useRef(0);
  const busy = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const processedFocus = useRef<string | undefined>(undefined);
  const pendingTimeFocusId = useRef<string | null>(null);
  const errorHandler = useRef(onError); errorHandler.current = onError;
  const rows = data?.space === space ? data.todos : [];

  const dueLabel = (todo: TodoRecord) => todo.dueAt
    ? new Date(todo.dueAt).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : todo.dueDate ? `${todo.dueDate} · ${t('todo.timeMissing')}` : t('todo.unscheduled');

  async function load() {
    const sequence = ++listSequence.current;
    try {
      const todos = await TodoService.list(space, true);
      if (sequence === listSequence.current) { setData({ space, todos }); setError(''); }
    } catch { if (sequence === listSequence.current) setError(t('todo.loadError')); }
  }
  useEffect(() => {
    void load();
    let active = true;
    const refreshCapability = () => { void TodoService.capabilities().then(value => { if (active) setCapability(value); }).catch(() => { if (active) setError(t('todo.capabilityReadError')); }); };
    refreshCapability();
    const unsubscribe = TodoService.subscribe(() => { void load(); refreshCapability(); });
    window.addEventListener?.('looma:todo-capabilities', refreshCapability);
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => { active = false; listSequence.current++; unsubscribe(); clearInterval(timer); window.removeEventListener?.('looma:todo-capabilities', refreshCapability); };
  }, [space]);
  useEffect(() => {
    if (focusId === undefined || !panelRef.current) return;
    const request = focusRequestId || focusId;
    if (processedFocus.current === request) return;
    if (!focusId) { processedFocus.current = request; panelRef.current.scrollIntoView({ block: 'nearest' }); panelRef.current.focus({ preventScroll: true }); return; }
    const row = Array.from(panelRef.current.querySelectorAll<HTMLElement>('[data-todo-id]')).find(element => element.dataset.todoId === focusId);
    if (row) { processedFocus.current = request; const details = row.closest('details'); if (details) details.open = true; row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); row.focus({ preventScroll: true }); }
  }, [focusId, focusRequestId, data]);
  useEffect(() => {
    const targetId = pendingTimeFocusId.current;
    if (!targetId || !panelRef.current) return;
    const rowEl = Array.from(panelRef.current.querySelectorAll<HTMLElement>('[data-todo-id]')).find(value => value.dataset.todoId === targetId);
    if (!rowEl) return;
    const input = rowEl.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    if (!input) return;
    const details = input.closest('details');
    if (details) details.open = true;
    pendingTimeFocusId.current = null;
    rowEl.scrollIntoView?.({ block: 'nearest' });
    input.focus();
  }, [editingTimeIds, data]);

  function openTimeEditor(todo: TodoRecord, seedExisting = true) {
    pendingTimeFocusId.current = todo.id;
    if (seedExisting && todo.dueAt && !dates[todo.id]) {
      setDates(prev => ({ ...prev, [todo.id]: toDateTimeInputValue(todo.dueAt) }));
    }
    setEditingTimeIds(prev => ({ ...prev, [todo.id]: true }));
  }

  async function act(todo: TodoRecord, action: 'complete' | 'cancel' | 'snooze' | 'approve', selected = false) {
    if (busy.current) return;
    const date = dates[todo.id];
    let dueAt: string | undefined;
    if (action === 'approve' && date) {
      dueAt = parseDateTimeInput(date);
      if (!dueAt) {
        const invalidMsg = t('todo.invalidDateTimeError');
        setError(invalidMsg);
        errorHandler.current?.(invalidMsg);
        return;
      }
    }
    // An item can be confirmed now and scheduled later.
    busy.current = true; setBusyId(todo.id); setError('');
    try {
      if (action === 'snooze') await TodoService.snooze(todo, 15);
      else if (action === 'approve') await TodoService.approve(todo, dueAt);
      else await TodoService[action](todo);
      if (action === 'approve') {
        setEditingTimeIds(prev => ({ ...prev, [todo.id]: false }));
      }
      if (selected) onChoiceDone?.();
      await load();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure) || t('todo.saveErrorFallback');
      setError(message); errorHandler.current?.(message);
    } finally { busy.current = false; setBusyId(''); }
  }
  async function permissions() {
    try { setCapability(await TodoService.requestPermissions()); }
    catch { setError(t('todo.permissionError')); }
  }
  function row(todo: TodoRecord) {
    const suggested = todo.status === 'suggested';
    const completed = todo.status === 'completed';
    const isEditingTime = !!editingTimeIds[todo.id];
    return <article key={todo.id} data-todo-id={todo.id} tabIndex={-1} className={`todo-row${completed ? ' todo-row--completed' : ''}${todo.id === focusId ? ' todo-row--focused' : ''}`}>
      <div className="todo-row-content"><strong>{todo.title}</strong><span className="todo-time">{completed ? t('todo.completedHistoryLabel') : dueLabel(todo)}</span>
        {!completed && !suggested && !todo.dueAt && <details className="todo-source" open={isEditingTime} onToggle={event => { const isOpen = (event.currentTarget as HTMLDetailsElement).open; setEditingTimeIds(prev => ({ ...prev, [todo.id]: isOpen })); }}><summary>{t('todo.setLaterSummary')}</summary><p>{t('todo.setLaterHint')}</p><input aria-label={t('todo.reminderTimeAria', { title: todo.title })} type="datetime-local" value={dates[todo.id] || ''} onChange={event => { const nextValue = event.target.value; setDates(value => ({ ...value, [todo.id]: nextValue })); }}/><button className="text-btn" disabled={!!busyId || !dates[todo.id]} onClick={() => act(todo, 'approve')}>{t('todo.setReminderBtn')}</button></details>}
        {!completed && !suggested && !!todo.dueAt && isEditingTime && <div className="todo-source todo-inline-editor">
          <label className="todo-date-label">{t('todo.adjustTimeSummary')}<input aria-label={t('todo.reminderTimeAria', { title: todo.title })} type="datetime-local" value={dates[todo.id] || ''} onChange={event => { const nextValue = event.target.value; setDates(value => ({ ...value, [todo.id]: nextValue })); }}/></label>
          <div className="button-row">
            <button type="button" className="soft-btn" disabled={!!busyId || !dates[todo.id]} onClick={() => act(todo, 'approve')}>{t('todo.updateReminderBtn')}</button>
            <button type="button" className="text-btn" onClick={() => setEditingTimeIds(prev => ({ ...prev, [todo.id]: false }))}>{t('common.cancel')}</button>
          </div>
        </div>}
        {todo.sourceText && <details className="todo-source"><summary>{t('todo.viewSourceSummary')}</summary><p>{todo.sourceText}</p></details>}
        {suggested && <details className="todo-source" open={isEditingTime} onToggle={event => { const isOpen = (event.currentTarget as HTMLDetailsElement).open; setEditingTimeIds(prev => ({ ...prev, [todo.id]: isOpen })); }}><summary>{t('todo.optionalScheduleSummary')}</summary><label className="todo-date-label">{t('todo.confirmWithoutTimeHint')}<input aria-label={t('todo.reminderTimeAria', { title: todo.title })} type="datetime-local" value={dates[todo.id] || ''} onChange={event => { const nextValue = event.target.value; setDates(value => ({ ...value, [todo.id]: nextValue })); }}/></label></details>}
      </div>
      {!completed && <div className="todo-actions">
        {suggested ? <>
          <button className="soft-btn" disabled={!!busyId} aria-label={t('todo.approveAria', { title: todo.title })} onClick={() => act(todo, 'approve')}>{t('todo.approveBtn')}</button>
          <button type="button" className="text-btn" disabled={!!busyId} onClick={() => openTimeEditor(todo, false)}>{dates[todo.id] ? t('todo.changeTimeBtn') : t('todo.pickTimeBtn')}</button>
        </> : <>
          <button className="soft-btn" disabled={!!busyId} aria-label={t('todo.completeAria', { title: todo.title })} onClick={() => act(todo, 'complete')}>{t('todo.completeBtn')}</button>
          <button className="text-btn" disabled={!!busyId} aria-label={t('todo.snoozeAria', { title: todo.title })} onClick={() => act(todo, 'snooze')}>{t('todo.snoozeBtn')}</button>
          {!!todo.dueAt && !isEditingTime && <button type="button" className="text-btn" disabled={!!busyId} onClick={() => openTimeEditor(todo)}>{t('todo.adjustTimeBtn')}</button>}
        </>}
        <button className="text-btn" disabled={!!busyId} aria-label={t('todo.cancelAria', { title: todo.title })} onClick={() => act(todo, 'cancel')}>{t('todo.cancelBtn')}</button>
      </div>}
    </article>;
  }
  const groups = groupTodos(rows, now);
  const isWork = space === 'work';
  const loaded = data?.space === space;
  const panelTitle = isWork ? t('todo.workTitle') : t('todo.lifeTitle');
  const groupLabels = [
    ['today', t('todo.groupToday')],
    ['future', isWork ? t('todo.groupFutureWork') : t('todo.groupFutureLife')],
    ['overdue', t('todo.groupOverdue')],
    ['suggested', t('todo.groupSuggested')],
  ] as const;
  const visibleGroups = isWork ? groupLabels.filter(([key]) => groups[key].length > 0) : groupLabels;
  const activeCount = groups.today.length + groups.future.length + groups.overdue.length;
  const choiceVerb = choiceAction === 'cancel' ? t('todo.verbCancel') : choiceAction === 'time' ? t('todo.verbTime') : t('todo.verbComplete');
  const needsNotifPerm = !!capability?.background && !['granted', 'unsupported'].includes(capability.notifications);
  const needsExactPerm = !!capability?.background && !['granted', 'not-required', 'unsupported'].includes(capability.exactAlarms);

  return <section className={`todo-panel${isWork ? ' todo-panel--work' : ''}`} tabIndex={-1} ref={panelRef} aria-label={panelTitle}>
    <header className="todo-header">
      <div className={isWork ? 'todo-work-title' : undefined}>
        {isWork && <span className="todo-work-mark" aria-hidden="true"><Bell size={19}/></span>}
        <div><span className="eyebrow">{isWork ? t('todo.workEyebrow') : t('todo.lifeEyebrow')}</span><h2>{panelTitle}</h2></div>
      </div>
      {(!isWork || activeCount > 0) && <span className="todo-total">{t('todo.totalCount', { count: activeCount })}</span>}
    </header>
    {isWork && <p className="todo-work-intro">{t('todo.workIntro')}</p>}
    {capability && <div className="todo-capability">
      <span>{!capability.background ? t('todo.capBrowser') : capability.enabled ? t('todo.capEnabled') : t('todo.capDisabled')}</span>
      {needsNotifPerm ? (
        <button type="button" className="text-btn" onClick={() => void permissions()}>{t('todo.enableNotificationsBtn')}</button>
      ) : needsExactPerm ? (
        <button type="button" className="text-btn" onClick={() => void permissions()}>{t('todo.enableExactAlarmsBtn')}</button>
      ) : null}
    </div>}
    {error && <p className="todo-error" role="alert">{error}<button className="text-btn" onClick={() => void load()}>{t('todo.retryLoadBtn')}</button></p>}
    {choices && choices.length > 0 && <div className="todo-choice" role="group" aria-label={t('todo.choiceAria', { verb: choiceVerb })}><p>{t('todo.choicePrompt', { verb: choiceVerb })}</p>{choices.filter(todo => todo.space === space).map(todo => <button key={todo.id} className="soft-btn" disabled={!!busyId} onClick={() => {
      if (choiceAction !== 'time') return act(todo, choiceAction, true);
      openTimeEditor(todo);
      onChoiceDone?.();
    }}>{todo.title} · {dueLabel(todo)}</button>)}<button className="text-btn" onClick={onChoiceDone}>{t('todo.choiceSkipBtn')}</button></div>}
    {visibleGroups.length > 0 ? <div className="todo-groups">{visibleGroups.map(([key, title]) => <section className={`todo-group todo-group--${key}`} key={key}><h3>{title}<span>{groups[key].length}</span></h3>{groups[key].length ? groups[key].map(row) : <p className="todo-empty">{loaded ? t('todo.groupEmpty') : t('todo.groupLoading')}</p>}</section>)}</div>
      : !error && (loaded ? <p className="todo-work-empty">{t('todo.workEmpty')}</p> : <p className="todo-work-empty" role="status">{t('todo.workLoading')}</p>)}
    {(!isWork || groups.completed.length > 0) && <details className="todo-history"><summary>{t('todo.completedSummary', { count: groups.completed.length })}</summary>{groups.completed.map(row)}</details>}
  </section>;
}
