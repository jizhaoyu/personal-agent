import React, { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import type { TodoRecord, WorkspaceMode } from '../types';
import { TodoService } from '../services/todos';
import { useI18n } from '../i18n';
import './todos.css';

const shanghaiDay = (time: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);

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
  const [capability, setCapability] = useState<Capability | null>(null);
  const [now, setNow] = useState(Date.now);
  const listSequence = useRef(0);
  const busy = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const processedFocus = useRef<string | undefined>(undefined);
  const errorHandler = useRef(onError); errorHandler.current = onError;
  const rows = data?.space === space ? data.todos : [];

  const dueLabel = (todo: TodoRecord) => todo.dueAt
    ? new Date(todo.dueAt).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
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

  async function act(todo: TodoRecord, action: 'complete' | 'cancel' | 'snooze' | 'approve', selected = false) {
    if (busy.current) return;
    const date = dates[todo.id];
    // An item can be confirmed now and scheduled later.
    busy.current = true; setBusyId(todo.id); setError('');
    try {
      if (action === 'snooze') await TodoService.snooze(todo, 15);
      else if (action === 'approve') {
        const dueAt = date ? new Date(`${date}:00+08:00`).toISOString() : undefined;
        await TodoService.approve(todo, dueAt);
      } else await TodoService[action](todo);
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
    return <article key={todo.id} data-todo-id={todo.id} tabIndex={-1} className={`todo-row${completed ? ' todo-row--completed' : ''}${todo.id === focusId ? ' todo-row--focused' : ''}`}>
      <div className="todo-row-content"><strong>{todo.title}</strong><span className="todo-time">{completed ? t('todo.completedHistoryLabel') : dueLabel(todo)}</span>
        {!completed && !suggested && !todo.dueAt && <details className="todo-source"><summary>{t('todo.setLaterSummary')}</summary><p>{t('todo.setLaterHint')}</p><input aria-label={t('todo.reminderTimeAria', { title: todo.title })} type="datetime-local" value={dates[todo.id] || ''} onChange={event => setDates(value => ({...value,[todo.id]:event.target.value}))}/><button className="text-btn" disabled={!!busyId || !dates[todo.id]} onClick={() => act(todo,'approve')}>{t('todo.setReminderBtn')}</button></details>}
        {todo.sourceText && <details className="todo-source"><summary>{t('todo.viewSourceSummary')}</summary><p>{todo.sourceText}</p></details>}
        {suggested && <details className="todo-source"><summary>{t('todo.optionalScheduleSummary')}</summary><label className="todo-date-label">{t('todo.confirmWithoutTimeHint')}<input aria-label={t('todo.reminderTimeAria', { title: todo.title })} type="datetime-local" value={dates[todo.id] || ''} onChange={event => setDates(value => ({ ...value, [todo.id]: event.target.value }))}/></label></details>}
      </div>
      {!completed && <div className="todo-actions">
        {suggested ? <button className="soft-btn" disabled={!!busyId} aria-label={t('todo.approveAria', { title: todo.title })} onClick={() => act(todo, 'approve')}>{t('todo.approveBtn')}</button> : <><button className="soft-btn" disabled={!!busyId} aria-label={t('todo.completeAria', { title: todo.title })} onClick={() => act(todo, 'complete')}>{t('todo.completeBtn')}</button><button className="text-btn" disabled={!!busyId} aria-label={t('todo.snoozeAria', { title: todo.title })} onClick={() => act(todo, 'snooze')}>{t('todo.snoozeBtn')}</button></>}
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
  return <section className={`todo-panel${isWork ? ' todo-panel--work' : ''}`} tabIndex={-1} ref={panelRef} aria-label={panelTitle}>
    <header className="todo-header">
      <div className={isWork ? 'todo-work-title' : undefined}>
        {isWork && <span className="todo-work-mark" aria-hidden="true"><Bell size={19}/></span>}
        <div><span className="eyebrow">{isWork ? t('todo.workEyebrow') : t('todo.lifeEyebrow')}</span><h2>{panelTitle}</h2></div>
      </div>
      {(!isWork || activeCount > 0) && <span className="todo-total">{t('todo.totalCount', { count: activeCount })}</span>}
    </header>
    {isWork && <p className="todo-work-intro">{t('todo.workIntro')}</p>}
    {capability && <p className="todo-capability">{!capability.background ? t('todo.capBrowser') : capability.enabled ? t('todo.capEnabled') : t('todo.capDisabled')}{capability.background && !['granted', 'unsupported'].includes(capability.notifications) && <button className="text-btn" onClick={() => void permissions()}>{t('todo.enableNotificationsBtn')}</button>}{capability.background && !['granted', 'not-required', 'unsupported'].includes(capability.exactAlarms) && <button className="text-btn" onClick={() => void permissions()}>{t('todo.enableExactAlarmsBtn')}</button>}</p>}
    {error && <p className="todo-error" role="alert">{error}<button className="text-btn" onClick={() => void load()}>{t('todo.retryLoadBtn')}</button></p>}
    {choices && choices.length > 0 && <div className="todo-choice" role="group" aria-label={t('todo.choiceAria', { verb: choiceVerb })}><p>{t('todo.choicePrompt', { verb: choiceVerb })}</p>{choices.filter(todo => todo.space === space).map(todo => <button key={todo.id} className="soft-btn" disabled={!!busyId} onClick={() => {
      if (choiceAction !== 'time') return act(todo, choiceAction, true);
      const element = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[data-todo-id]') || []).find(value => value.dataset.todoId === todo.id);
      element?.scrollIntoView({ block: 'nearest' }); element?.querySelector<HTMLInputElement>('input')?.focus(); onChoiceDone?.();
    }}>{todo.title} · {dueLabel(todo)}</button>)}<button className="text-btn" onClick={onChoiceDone}>{t('todo.choiceSkipBtn')}</button></div>}
    {visibleGroups.length > 0 ? <div className="todo-groups">{visibleGroups.map(([key, title]) => <section className={`todo-group todo-group--${key}`} key={key}><h3>{title}<span>{groups[key].length}</span></h3>{groups[key].length ? groups[key].map(row) : <p className="todo-empty">{loaded ? t('todo.groupEmpty') : t('todo.groupLoading')}</p>}</section>)}</div>
      : !error && (loaded ? <p className="todo-work-empty">{t('todo.workEmpty')}</p> : <p className="todo-work-empty" role="status">{t('todo.workLoading')}</p>)}
    {(!isWork || groups.completed.length > 0) && <details className="todo-history"><summary>{t('todo.completedSummary', { count: groups.completed.length })}</summary>{groups.completed.map(row)}</details>}
  </section>;
}
