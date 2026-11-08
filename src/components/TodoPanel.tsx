import React, { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import type { TodoRecord, WorkspaceMode } from '../types';
import { TodoService } from '../services/todos';
import './todos.css';

const shanghaiDay = (time: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
const dueLabel = (todo: TodoRecord) => todo.dueAt
  ? new Date(todo.dueAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  : todo.dueDate ? `${todo.dueDate} · 时刻待补充` : '尚未安排时间';

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

  async function load() {
    const sequence = ++listSequence.current;
    try {
      const todos = await TodoService.list(space, true);
      if (sequence === listSequence.current) { setData({ space, todos }); setError(''); }
    } catch { if (sequence === listSequence.current) setError('待办读取失败，原记录仍保留，请重试。'); }
  }
  useEffect(() => {
    void load();
    let active = true;
    const refreshCapability = () => { void TodoService.capabilities().then(value => { if (active) setCapability(value); }).catch(() => { if (active) setError('提醒能力暂未读到，请重试。'); }); };
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
      const message = failure instanceof Error ? failure.message : String(failure) || '待办未保存，请重试。';
      setError(message); errorHandler.current?.(message);
    } finally { busy.current = false; setBusyId(''); }
  }
  async function permissions() {
    try { setCapability(await TodoService.requestPermissions()); }
    catch { setError('权限请求未完成，请在系统设置中核对后重试。'); }
  }
  function row(todo: TodoRecord) {
    const suggested = todo.status === 'suggested';
    const completed = todo.status === 'completed';
    return <article key={todo.id} data-todo-id={todo.id} tabIndex={-1} className={`todo-row${completed ? ' todo-row--completed' : ''}${todo.id === focusId ? ' todo-row--focused' : ''}`}>
      <div className="todo-row-content"><strong>{todo.title}</strong><span className="todo-time">{completed ? '已完成 · 历史保留' : dueLabel(todo)}</span>
        {!completed && !suggested && !todo.dueAt && <details className="todo-source"><summary>以后再设提醒</summary><p>已经记下，不填时间也可以。当前尚未安排准确提醒。</p><input aria-label={`${todo.title}提醒时间`} type="datetime-local" value={dates[todo.id] || ''} onChange={event => setDates(value => ({...value,[todo.id]:event.target.value}))}/><button className="text-btn" disabled={!!busyId || !dates[todo.id]} onClick={() => act(todo,'approve')}>设置提醒</button></details>}
        {todo.sourceText && <details className="todo-source"><summary>查看原文</summary><p>{todo.sourceText}</p></details>}
        {suggested && <details className="todo-source"><summary>可选：安排提醒</summary><label className="todo-date-label">不填时间也能确认待办<input aria-label={`${todo.title}提醒时间`} type="datetime-local" value={dates[todo.id] || ''} onChange={event => setDates(value => ({ ...value, [todo.id]: event.target.value }))}/></label></details>}
      </div>
      {!completed && <div className="todo-actions">
        {suggested ? <button className="soft-btn" disabled={!!busyId} aria-label={`确认${todo.title}`} onClick={() => act(todo, 'approve')}>确认待办</button> : <><button className="soft-btn" disabled={!!busyId} aria-label={`完成${todo.title}`} onClick={() => act(todo, 'complete')}>完成</button><button className="text-btn" disabled={!!busyId} aria-label={`稍后15分钟${todo.title}`} onClick={() => act(todo, 'snooze')}>稍后15分钟</button></>}
        <button className="text-btn" disabled={!!busyId} aria-label={`取消${todo.title}`} onClick={() => act(todo, 'cancel')}>取消</button>
      </div>}
    </article>;
  }
  const groups = groupTodos(rows, now);
  const isWork = space === 'work';
  const loaded = data?.space === space;
  const panelTitle = isWork ? '工作提醒' : '生活待办';
  const groupLabels = [['today', '今天'], ['future', isWork ? '稍后或未定时间' : '即将到期'], ['overdue', '已逾期'], ['suggested', '待确认建议']] as const;
  const visibleGroups = isWork ? groupLabels.filter(([key]) => groups[key].length > 0) : groupLabels;
  const activeCount = groups.today.length + groups.future.length + groups.overdue.length;
  const choiceVerb = choiceAction === 'cancel' ? '取消' : choiceAction === 'time' ? '补充时间' : '完成';
  return <section className={`todo-panel${isWork ? ' todo-panel--work' : ''}`} tabIndex={-1} ref={panelRef} aria-label={panelTitle}>
    <header className="todo-header">
      <div className={isWork ? 'todo-work-title' : undefined}>
        {isWork && <span className="todo-work-mark" aria-hidden="true"><Bell size={19}/></span>}
        <div><span className="eyebrow">{isWork ? '定时与通知' : 'FOLLOW THROUGH'}</span><h2>{panelTitle}</h2></div>
      </div>
      {(!isWork || activeCount > 0) && <span className="todo-total">{activeCount} 项待办</span>}
    </header>
    {isWork && <p className="todo-work-intro">提醒时间可以稍后补。项目进度请到「项目 → 项目行动」查看。</p>}
    {capability && <p className="todo-capability">{!capability.background ? '浏览器仅管理本地待办，不支持系统后台提醒。' : capability.enabled ? '后台提醒已开启 · 退出、关机或权限受限时可能无法送达。' : '提醒已关闭，待办仍会保存。'}{capability.background && !['granted', 'unsupported'].includes(capability.notifications) && <button className="text-btn" onClick={() => void permissions()}>开启通知权限</button>}{capability.background && !['granted', 'not-required', 'unsupported'].includes(capability.exactAlarms) && <button className="text-btn" onClick={() => void permissions()}>开启精确闹钟权限</button>}</p>}
    {error && <p className="todo-error" role="alert">{error}<button className="text-btn" onClick={() => void load()}>重试读取</button></p>}
    {choices && choices.length > 0 && <div className="todo-choice" role="group" aria-label={`选择要${choiceVerb}的待办`}><p>找到多项相似待办，请选择要{choiceVerb}的一项：</p>{choices.filter(todo => todo.space === space).map(todo => <button key={todo.id} className="soft-btn" disabled={!!busyId} onClick={() => {
      if (choiceAction !== 'time') return act(todo, choiceAction, true);
      const element = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[data-todo-id]') || []).find(value => value.dataset.todoId === todo.id);
      element?.scrollIntoView({ block: 'nearest' }); element?.querySelector<HTMLInputElement>('input')?.focus(); onChoiceDone?.();
    }}>{todo.title} · {dueLabel(todo)}</button>)}<button className="text-btn" onClick={onChoiceDone}>暂不处理</button></div>}
    {visibleGroups.length > 0 ? <div className="todo-groups">{visibleGroups.map(([key, title]) => <section className={`todo-group todo-group--${key}`} key={key}><h3>{title}<span>{groups[key].length}</span></h3>{groups[key].length ? groups[key].map(row) : <p className="todo-empty">{loaded ? '暂无事项' : '读取中…'}</p>}</section>)}</div>
      : !error && (loaded ? <p className="todo-work-empty">目前没有需要处理的提醒</p> : <p className="todo-work-empty" role="status">正在读取工作提醒…</p>)}
    {(!isWork || groups.completed.length > 0) && <details className="todo-history"><summary>已完成历史 · {groups.completed.length}</summary>{groups.completed.map(row)}</details>}
  </section>;
}
