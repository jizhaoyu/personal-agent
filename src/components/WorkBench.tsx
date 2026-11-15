import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, Plus, CornerDownLeft, History, CheckCircle2, Circle, RotateCcw, ChevronDown, Sparkles, ClipboardPaste, FolderPlus, ListPlus } from 'lucide-react';
import type { WorkPartition, WorkOperation, Engagement, ProposedChangeSet, CaptureDraft, WorkHome, ClosureRecord, FollowUpItem, ProjectTaskItem, ConditionIntent, Message, CommittedChangeEvent } from '../types';
import { selectHighlightedReadyConditions, type ConditionLifecycleAction } from '../services/conditionIntents';
import { chinaTime } from '../services/aiService';
import { ProposalReview } from './ProposalReview';
import { ClosureReceipt } from './ClosureReceipt';
import { ProjectContinuation } from './ProjectContinuation';
import { canContinueProject } from '../services/projectContinuation';
import { Repository } from '../persistence/repository';
import { eventMutations } from '../../shared/persistence-core.mjs';
import './work-v5.css';

export interface WorkBenchProps {
  work: WorkPartition;
  pending: ProposedChangeSet | null;
  busy: boolean;
  modelBusy?: boolean;
  selectedId: string;
  onSelect(id: string): void;
  onPropose(text: string): Promise<void>;
  onChange(proposal: ProposedChangeSet): void;
  onConfirm(): void;
  onDiscard(): void;
  onReparse(): void;
  onManual(operations: WorkOperation[], label: string): void;
  onUndo(): void;
  onExport(engagement: Engagement): void;
  modelEnabled: boolean;
  workSuggestionsEnabled?: boolean;
  onCancel(): void;
  onPrepareArtifactFromCondition?(item: ConditionIntent): void;
  stats?: any;
  companion?: React.ReactNode;
  draft: CaptureDraft | null;
  draftSaveState: 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';
  home: WorkHome | null;
  closure: ClosureRecord | null;
  onDraftChange(patch: Partial<CaptureDraft>): void;
  onRetryDraft?(): void;
  onContinue(): void;
  onResume(): void;
  onOriginalOnly(): void | Promise<void>;
  onRebase(): void;
  onResolveConflict(id: string, choice: 'current' | 'proposed'): void;
  onSetItemState(kind: 'task' | 'followup', item: ProjectTaskItem | FollowUpItem, done: boolean): Promise<void>;
  onSetConditionState?(item: ConditionIntent, action: ConditionLifecycleAction | 'convert_to_task'): Promise<void>;
  onUndoEvent(eventId: string): void;
  onOpenMemory(): void;
  onPractice?(): void;
  onOpenClosure(closure: ClosureRecord): void;
  projectLookup?: { query: string; requestId: string };
}
type View = 'home' | 'capture' | 'projects' | 'tasks' | 'followups' | 'history' | 'receipt';
const stages: Engagement['stage'][] = ['初步接触', '需求确认', '方案报价', '商务谈判', '赢单成交'];
const uniqueProjects = (rows: Engagement[]) => [...new Map(rows.map(row => [row.id, row])).values()];
const shortText = (value: string, length = 72) => value.length > length ? `${value.slice(0, length)}…` : value;
const saveLabels = { idle: '就绪', unsaved: '未保存', saving: '保存中…', saved: '已保存', error: '保存失败' };

export function WorkBench(props: WorkBenchProps) {
  const { work: cached, pending, draft, home, closure } = props;
  const [view, setView] = useState<View>(closure ? 'receipt' : 'home');
  const [query, setQuery] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [itemsKey, setItemsKey] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [savingItem, setSavingItem] = useState('');
  const [showBinding, setShowBinding] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const composing = useRef(false);
  const submitting = useRef(false);
  const captureInput = useRef<HTMLTextAreaElement>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [artifactRequest, setArtifactRequest] = useState<{ projectId: string; conditionId: string; requestId: string } | null>(null);
  const [readIdentity, setReadIdentity] = useState(() => Repository.getReadIdentity?.() || '');
  const [detailProject, setDetailProject] = useState<{ identity: string; project: Engagement } | null>(null);
  const [receiptData, setReceiptData] = useState<{ source: Message | null; event: CommittedChangeEvent | null; engagements: Engagement[]; tasks: ProjectTaskItem[]; followUps: FollowUpItem[] } | null>(null);
  const listSequence = useRef(0);
  const text = draft?.text || '';
  const hasDraft = !!text.trim() || !!draft?.proposal;
  const hasBusiness = !!cached.engagements.length || !!cached.tasks.length || !!cached.followUps?.length || !!cached.conditions?.length || !!home?.conditions?.length || !!home?.recent.length || Number(props.stats?.counts?.message || 0) > 0;
  const kind = view === 'projects' || view === 'capture' || (view === 'home' && !hasBusiness) ? 'engagement' : view === 'tasks' ? 'task' : view === 'followups' ? 'followup' : view === 'history' ? 'event' : null;
  const key = `${kind}:${query}:${dueOnly}:${readIdentity}`;
  const visibleItems = itemsKey === key ? items : [];
  const projects = uniqueProjects([...cached.engagements, ...((kind === 'engagement' ? visibleItems : []) as Engagement[]), ...(detailProject?.identity === readIdentity ? [detailProject.project] : [])]);

  useEffect(() => Repository.subscribe?.(() => setReadIdentity(Repository.getReadIdentity?.() || '')), []);
  useEffect(() => { if (closure) { setReceiptData(null); setView('receipt'); } }, [closure?.id]);
  useEffect(() => {
    if (props.projectLookup) { setSelectedProjectId(null); setQuery(props.projectLookup.query); setView('projects'); }
  }, [props.projectLookup?.requestId]);
  useEffect(() => {
    const sequence = ++listSequence.current; let active = true;
    if (!kind) { setLoading(false); setCursor(null); return () => { active = false; listSequence.current++; }; }
    setLoading(true); setListError('');
    Repository.query('work', kind, { query, limit: 50, ...(kind === 'task' ? { dueOnly } : {}) }).then(page => {
      if (active && sequence === listSequence.current && (Repository.getReadIdentity?.() || '') === readIdentity) { setItems(page.items); setItemsKey(key); setCursor(page.nextCursor || null); }
    }).catch(() => { if (active) setListError('记录读取失败，请重试。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; listSequence.current++; };
  }, [kind, query, dueOnly, cached.revision, readIdentity]);
  useEffect(() => {
    if (!closure || view !== 'receipt') return;
    let active = true; setReceiptData(null);
    async function referenced<T>(kind: 'engagement' | 'task' | 'followup', ids: string[]): Promise<T[]> {
      const rows: T[] = [];
      for (let offset = 0; offset < ids.length; offset += 200) {
        if (!active) break;
        rows.push(...(await Repository.query<T>('work', kind, { ids: ids.slice(offset, offset + 200), limit: 200 })).items);
      }
      return rows;
    }
    void Promise.all([
      Repository.get<Message>('work', 'message', closure.sourceMessageId), Repository.get<CommittedChangeEvent>('work', 'event', closure.eventId),
      referenced<Engagement>('engagement', closure.engagementIds), referenced<ProjectTaskItem>('task', closure.taskIds), referenced<FollowUpItem>('followup', closure.followUpIds),
    ]).then(([source, event, engagements, tasks, followUps]) => { if (active) setReceiptData({ source, event, engagements, tasks, followUps }); }).catch(() => { if (active) setListError('关联资料暂未读全，请稍后重试。'); });
    return () => { active = false; };
  }, [view, closure?.id, closure?.revertedAt, cached.revision]);

  async function more() {
    if (!kind || !cursor || loading) return;
    const sequence = listSequence.current; setLoading(true);
    try { const page = await Repository.query('work', kind, { query, cursor, limit: 50, ...(kind === 'task' ? { dueOnly } : {}) }); if (sequence === listSequence.current) { setItems(previous => [...previous, ...page.items]); setCursor(page.nextCursor || null); } }
    catch { if (sequence === listSequence.current) setListError('后续记录暂未读到，可以重试。'); }
    finally { if (sequence === listSequence.current) setLoading(false); }
  }
  function openView(next: View) { setQuery(''); setDueOnly(false); setListError(''); setView(next); }
  function start() { props.onContinue(); openView('capture'); }
  function resume() { props.onResume(); openView('capture'); }
  function continueProject(projectId: string) {
    if (props.busy || !canContinueProject(draft, projectId)) return;
    props.onContinue();
    if (draft?.selectedEngagementId !== projectId) props.onSelect(projectId);
    openView('capture');
  }
  function manual(operations: WorkOperation[], label: string) { props.onManual(operations, label); openView('capture'); }
  function createProject() {
    const engagement: Engagement = { id: crypto.randomUUID(), clientName: '', title: '', stage: '初步接触', internalContext: '', shareableSummary: '', nextAction: '', updatedAt: Date.now() };
    manual([{ target: 'engagement', entityId: engagement.id, before: null, after: engagement }], '手动新建客户合作项目');
  }
  function showProject(id: string) {
    setSelectedProjectId(id); openView('projects');
  }
  async function setItemState(kind: 'task' | 'followup', item: ProjectTaskItem | FollowUpItem, done: boolean) {
    if (props.busy || savingItem) return;
    setSavingItem(item.id); setListError('');
    try { await props.onSetItemState(kind, item, done); }
    catch { setListError('状态尚未保存，请重试。'); }
    finally { setSavingItem(''); }
  }
  function taskRow(task: ProjectTaskItem) {
    const project = projects.find(item => item.id === task.engagementId);
    const canOpenProject = !!task.engagementId && !(view === 'projects' && selectedProjectId === task.engagementId);
    return <article className={`task-row ${task.done ? 'completed' : ''}`} key={task.id}><button className="icon-btn task-check-btn" disabled={props.busy || !!savingItem} aria-label={`${task.done ? '重新打开' : '完成'}${task.title}`} onClick={() => setItemState('task', task, !task.done)}>{task.done ? <CheckCircle2 size={18}/> : <Circle size={18}/>}</button><div className="task-row-body"><h3>{task.title}</h3><p>{project ? `${project.clientName}${project.title ? ` · ${project.title}` : ''}` : '未关联客户'} · {task.dueAt ? `我方提醒 ${chinaTime(task.dueAt)}` : '无提醒'}</p></div><div className="followup-actions">{canOpenProject && <button className="text-btn" disabled={props.busy} onClick={() => showProject(task.engagementId!)}>查看项目</button>}<button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'task', entityId: task.id, before: task, after: { ...task } }], '修改跟进行动')}>修改</button></div></article>;
  }
  function followUpRow(item: FollowUpItem) {
    const resolved = item.status === 'resolved';
    const project = projects.find(row => row.id === item.engagementId);
    const canOpenProject = !!item.engagementId && !(view === 'projects' && selectedProjectId === item.engagementId);
    return <article className={`followup-row${resolved ? ' completed' : ''}`} key={item.id}><div className="followup-row-body"><span className={`followup-label followup-label--${item.kind}`}>{item.kind === 'waiting' ? '等待客户' : '仍待确认'}{resolved ? ' · 已处理' : ''}</span><h3>{item.title}</h3><p>{project ? `${project.clientName}${project.title ? ` · ${project.title}` : ''} · ` : ''}{item.expectedDate ? `预计 ${item.expectedDate}` : item.expectedAt ? `预计 ${chinaTime(item.expectedAt)}` : item.kind === 'waiting' ? '时间未定' : '待确认'}{item.reviewAt ? ` · 回访 ${chinaTime(item.reviewAt)}` : ''}</p></div><div className="followup-actions">{canOpenProject && <button className="text-btn" disabled={props.busy} onClick={() => showProject(item.engagementId!)}>查看项目</button>}<button className="soft-btn" disabled={props.busy || !!savingItem} onClick={() => setItemState('followup', item, !resolved)}>{resolved ? '重新打开' : item.kind === 'waiting' ? '已收到' : '已处理'}</button><button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'followup', entityId: item.id, before: item, after: { ...item } }], '核对等待或未定事项')}>修改</button></div></article>;
  }
  async function setConditionState(item: ConditionIntent, action: ConditionLifecycleAction | 'convert_to_task') {
    if (props.busy || savingItem) return;
    setSavingItem(item.id); setListError('');
    try {
      if (props.onSetConditionState) await props.onSetConditionState(item, action);
      else {
        const res = await Repository.setConditionState(item, action);
        if (res.outcome !== 'committed') throw new Error(res.error);
      }
    } catch { setListError('状态尚未保存，请重试。'); }
    finally { setSavingItem(''); }
  }
  function prepareArtifactFromCondition(item: ConditionIntent) {
    if (props.onPrepareArtifactFromCondition) {
      props.onPrepareArtifactFromCondition(item);
      return;
    }
    if (!item.engagementId) return;
    setArtifactRequest({ projectId: item.engagementId, conditionId: item.id, requestId: crypto.randomUUID() });
    showProject(item.engagementId);
  }
  function conditionRow(item: ConditionIntent) {
    const project = projects.find(row => row.id === item.engagementId);
    const canOpenProject = !!item.engagementId && !(view === 'projects' && selectedProjectId === item.engagementId);
    const closed = item.status === 'cancelled' || item.status === 'completed';
    const suggestionsEnabled = props.workSuggestionsEnabled !== false;
    const statusLabel = item.status === 'ready' ? '条件已就绪' : item.status === 'watching' ? '观察中' : item.status === 'draft' ? '待绑定' : item.status === 'paused' ? '已暂停' : item.status === 'cancelled' ? '已取消' : '已完成';
    return <article className={`followup-row condition-row${closed ? ' completed' : ''}`} key={item.id}><div className="followup-row-body"><span className={`followup-label followup-label--${item.status === 'ready' ? 'waiting' : 'question'}`}>{statusLabel} · v{item.revision}</span><h3>当 {item.conditionText} → {item.actionTitle}</h3><p>{project ? `${project.clientName}${project.title ? ` · ${project.title}` : ''} · ` : ''}{item.conditionKind === 'followup_resolved' ? '绑定等待事项收到后触发' : '由我方明确确认满足'}</p></div><div className="followup-actions">{canOpenProject && <button className="text-btn" disabled={props.busy} onClick={() => showProject(item.engagementId!)}>查看项目</button>}{item.status === 'ready' && <button className="primary-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'convert_to_task')}>转为项目行动</button>}{item.status === 'ready' && suggestionsEnabled && item.engagementId && <button className="soft-btn" disabled={props.busy || !!savingItem} onClick={() => prepareArtifactFromCondition(item)}>准备交付草稿</button>}{item.status === 'ready' && item.dismissedRevision !== item.revision && <button className="text-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'dismiss_highlight')}>稍后看</button>}{(item.status === 'watching' || item.status === 'draft') && <button className="soft-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'confirm_ready')}>确认条件满足</button>}{item.status === 'draft' && <button className="text-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'activate_watching')}>设为观察中</button>}{item.status === 'paused' && <button className="soft-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'activate_watching')}>恢复观察</button>}{(item.status === 'watching' || item.status === 'ready') && <button className="text-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'pause')}>暂停</button>}{!closed && <button className="text-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'cancel')}>取消</button>}<button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'condition', entityId: item.id, before: item, after: { ...item } }], '修改条件跟进')}>修改</button></div></article>;
  }
  async function submitCapture(originalOnly = false) {
    if (props.busy || submitting.current || !text.trim()) return;
    submitting.current = true; setCaptureError('');
    try {
      if (originalOnly) await props.onOriginalOnly();
      else await props.onPropose(text);
    } catch {
      setCaptureError('这段话还在这里，保存未完成。请再试一次。');
    } finally { submitting.current = false; }
  }
  function capturePanel() {
    const linkedProject = projects.find(project => project.id === props.selectedId);
    return <div className={`capture-layout ${pending ? '' : 'capture-layout--single'}`}><div className="capture-column"><section className="capture-card">
      <div className="capture-card-header">
        <div className={`draft-save-state draft-save-state--${props.draftSaveState}`} role="status"><span className="status-dot"/><span>{saveLabels[props.draftSaveState]}</span>{props.draftSaveState === 'error' && props.onRetryDraft && <button className="text-btn" onClick={props.onRetryDraft}>重试</button>}<span className="draft-char-count">{text.length} / 12000</span></div>
        <details className="capture-advanced"><summary>更多工具</summary><div className="capture-quick-tools">
          <button className="text-btn" type="button" disabled={props.busy} onClick={async () => { const clip = await window.electronAPI?.readClipboard?.(); if (clip) props.onDraftChange({ text: clip }); }}><ClipboardPaste size={13}/>粘贴剪贴板</button>
          <button className="text-btn" disabled={props.busy} onClick={createProject}><FolderPlus size={13}/>新建项目</button>
          <button className="text-btn" disabled={props.busy} onClick={() => { const id = crypto.randomUUID(); manual([{ target: 'task', entityId: id, before: null, after: { id, title: '', assignee: '我', deadline: '', priority: 'medium', done: false, ...(props.selectedId ? { engagementId: props.selectedId } : {}) } }], '手动新增跟进行动'); }}><ListPlus size={13}/>新增行动</button>
          {props.onPractice && <button className="text-btn" disabled={props.busy} onClick={props.onPractice}><Sparkles size={13}/>放心练习一次</button>}
        </div></details>
      </div>
      <div className="capture-invitation"><p className="capture-kicker">工作日志</p><h2>记一条工作进展</h2><p>直接写，不用先选项目。Looma 会尝试整理待办和项目更新，重要变更由你核对。</p></div>
      <textarea ref={captureInput} aria-label="客户沟通记录" aria-description="不用先选项目。Enter 整理，Shift+Enter 换行。" className="capture-input" rows={4} maxLength={12000} disabled={props.busy} value={text} onChange={event => { props.onDraftChange({ text: event.target.value }); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
        if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault(); void submitCapture();
      }} placeholder="例如：刚和谁聊了什么，接下来要做什么？"/>
      {!text && !pending && <button type="button" className="capture-example" disabled={props.busy} onClick={() => {
        props.onDraftChange({ text: '刚和客户确认了首页方向，周五前发新版报价。' });
        captureInput.current?.focus();
      }}><span>填入例句</span>刚和客户确认了首页方向，周五前发新版报价。</button>}
      <details className="capture-binding" open={!!pending?.clarification || showBinding}><summary id="work-project-binding">{pending?.clarification ? '选择或新建关联项目' : linkedProject ? `已关联项目 · ${linkedProject.clientName} · ${linkedProject.title}` : props.selectedId ? '已关联项目' : '关联项目（可选）'}</summary>
        <div className="capture-binding-body">
          {pending?.clarification && <p className="muted small">{pending.clarification.message}</p>}
          <div className="field-grid">
            <label>查找项目<input aria-label="查找已有记录" value={query} disabled={props.busy} onChange={event => setQuery(event.target.value)} placeholder="客户名或项目关键词"/></label>
            <label className="context-select">目标项目<select aria-label="目标项目" value={props.selectedId} disabled={props.busy} onChange={event => props.onSelect(event.target.value)}><option value="">自动识别</option>{projects.map(project => <option key={project.id} value={project.id}>{project.clientName} · {project.title}</option>)}</select></label>
          </div>
          {!props.selectedId ? <div className="field-grid"><label>新客户<input aria-label="明确新客户姓名" disabled={props.busy} maxLength={100} value={draft?.newClientName || ''} onChange={event => props.onDraftChange({ newClientName: event.target.value })} placeholder="客户姓名"/></label><label>新项目<input aria-label="新项目名称" disabled={props.busy} maxLength={200} value={draft?.newProjectTitle || ''} onChange={event => props.onDraftChange({ newProjectTitle: event.target.value })} placeholder="项目名称"/></label></div> : <button className="text-btn" disabled={props.busy} onClick={() => { props.onSelect(''); setShowBinding(true); }}>切换到新建合作</button>}
        </div>
      </details>
      <div className="input-footer">
        <div className="input-footer-left">
          {props.modelBusy && <button className="text-btn danger" onClick={props.onCancel}>取消模型请求</button>}
        </div>
        <div className="input-footer-right">
          <button className="soft-btn" disabled={props.busy || !text.trim()} onClick={() => submitCapture(true)}>只保存原文</button>
          <button className="primary-btn" disabled={props.busy || !text.trim()} onClick={() => submitCapture()}>{props.busy ? '整理中…' : pending ? '重新整理' : '整理这条记录'}<CornerDownLeft size={14}/></button>
        </div>
      </div>
      {pending && <a className="capture-review-link" href="#work-capture-review">已整理，查看待核对内容 <ArrowRight size={14}/></a>}
      <p className="capture-keyboard-hint">Enter 整理 · Shift+Enter 换行</p>
      {captureError && <p className="notice" role="alert">{captureError}</p>}
    </section></div>
    {pending && <div className="review-column" id="work-capture-review" tabIndex={-1}><fieldset className="review-fieldset" disabled={props.busy}><ProposalReview proposal={pending} projectBindingId="work-project-binding" engagements={projects} conflicts={draft?.conflicts} onResolveConflict={props.onResolveConflict} onChange={props.onChange} onConfirm={props.onConfirm} onDiscard={props.onDiscard} onReparse={props.onRebase} busy={props.busy}/></fieldset></div>}</div>;
  }

  const showCapture = view === 'capture' || view === 'home';
  const suggestionsEnabled = props.workSuggestionsEnabled !== false;
  const homeConditions = home?.conditions || [];
  const readyConditions = suggestionsEnabled ? selectHighlightedReadyConditions(homeConditions, home?.waiting || []) : [];
  const activeConditions = homeConditions.filter(item => item.status === 'watching' || item.status === 'draft' || item.status === 'paused');
  const hasActiveSummary = !!home && (home.today.length > 0 || home.waiting.length > 0 || home.questions.length > 0);
  const hasSummary = !!home && (hasActiveSummary || home.overdue.length > 0 || home.recent.length > 0 || readyConditions.length > 0 || activeConditions.length > 0);
  return <div className="work-v5">
    <div className="work-v5-toolbar">
      <nav className="work-v5-tabs" aria-label="工作台导航">
        {([['home', '工作台'], ['projects', '项目'], ['history', '变更记录']] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-current={view === value || (value === 'home' && view === 'capture') || (value === 'projects' && (view === 'tasks' || view === 'followups')) ? 'page' : undefined}
            className={view === value || (value === 'home' && view === 'capture') || (value === 'projects' && (view === 'tasks' || view === 'followups')) ? 'active' : ''}
            onClick={() => openView(value)}
          >
            {label}
            {value === 'home' && hasDraft && <span className="tiny-dot" title="存在未完成草稿" aria-hidden="true"/>}
          </button>
        ))}
        <span className="sr-only">
          <button type="button" onClick={() => openView('capture')}>随心记下</button>
          <button type="button" onClick={() => openView('tasks')}>项目行动</button>
          <button type="button" onClick={() => openView('followups')}>等待与未定</button>
        </span>
      </nav>
      <div className="work-v5-toolbar-actions">
        {(view === 'projects' || view === 'tasks' || view === 'followups' || view === 'history') && (
          <label className="toolbar-search">
            <input aria-label="查找已有记录" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索记录…"/>
          </label>
        )}
        {(view === 'projects' || view === 'tasks' || view === 'followups') && <button className="soft-btn" disabled={props.busy} onClick={createProject}><Plus size={14}/>新建项目</button>}
        {view === 'history' && <button className="soft-btn" disabled={props.busy || !visibleItems.some(event => !event.revertedAt)} onClick={props.onUndo}><RotateCcw size={14}/>撤销</button>}
        {!showCapture && <button className="primary-btn" onClick={start} disabled={props.busy}><Plus size={14}/>随心记下</button>}
      </div>
    </div>

    {listError && <p className="notice" role="alert">{listError}</p>}
    {(view === 'projects' || view === 'tasks' || view === 'followups') && (
      <div className="work-sub-nav">
        <button type="button" className={`sub-tab ${view === 'projects' ? 'active' : ''}`} onClick={() => openView('projects')}>客户项目 ({projects.length})</button>
        <button type="button" className={`sub-tab ${view === 'tasks' ? 'active' : ''}`} onClick={() => openView('tasks')}>项目行动</button>
        <button type="button" className={`sub-tab ${view === 'followups' ? 'active' : ''}`} onClick={() => openView('followups')}>等待与未定</button>
      </div>
    )}

    {showCapture && <div className={view === 'home' && !pending ? 'work-home-layout' : 'work-capture-page'}>
    {capturePanel()}
    {view === 'home' && <aside className="continuation-home" aria-label="工作摘要">
      <h2 className="home-summary-title">工作摘要</h2>
      {hasDraft && <article className="resume-draft"><div className="resume-draft-info"><span className="resume-badge">未完成草稿</span><p>{shortText(text || '存在待确认的更改草稿', 90)}</p></div><button className="soft-btn" onClick={resume} disabled={props.busy}>继续整理 <ArrowRight size={14}/></button></article>}
      {!home ? <p className="muted small" role="status">读取中…</p> : !hasSummary ? <div className="home-summary-empty">
        <span className="home-summary-empty-mark" aria-hidden="true"><FileText size={18}/></span>
        <div><h3>{hasBusiness ? '目前没有需要跟进的工作' : '从第一条工作进展开始'}</h3><p>{hasBusiness ? '新的行动、待回复和最近沟通会汇总在这里。' : '第一条记录保存后，相关行动、待回复和沟通记录会汇总在这里。'}</p></div>
      </div> : <>
        {readyConditions.length > 0 && <section className="home-section home-section--ready-condition" aria-label="条件已就绪"><div className="section-heading"><h2>条件已就绪，可推进 <span>{readyConditions.length}</span></h2></div><div className="section-list">{readyConditions.slice(0, 3).map(conditionRow)}</div></section>}
        {home.overdue.length > 0 && <section className="home-section home-section--overdue" aria-label="早前安排"><div className="section-heading"><h2>逾期未完 <span>{home.counts.overdue}</span></h2><button className="text-btn" onClick={() => { openView('tasks'); setDueOnly(true); }}>查看 <ArrowRight size={13}/></button></div><div className="section-list">{home.overdue.slice(0, 3).map(taskRow)}</div></section>}
        {hasActiveSummary && <div className="home-bento-grid">
          {home.today.length > 0 && <section className="home-section" aria-label="今天要处理">
            <div className="section-heading"><h2>今日行动 <span>{home.counts.today}</span></h2><button className="text-btn" onClick={() => openView('tasks')}>全部 <ArrowRight size={13}/></button></div>
            <div className="section-list">{home.today.slice(0, 3).map(taskRow)}</div>
          </section>}
          {home.waiting.length > 0 && <section className="home-section" aria-label="等待客户">
            <div className="section-heading"><h2>等待客户 <span>{home.counts.waiting}</span></h2><button className="text-btn" onClick={() => openView('followups')}>全部 <ArrowRight size={13}/></button></div>
            <div className="section-list">{home.waiting.slice(0, 3).map(followUpRow)}</div>
          </section>}
          {home.questions.length > 0 && <section className="home-section" aria-label="仍待确认">
            <div className="section-heading"><h2>待确认项 <span>{home.counts.questions}</span></h2><button className="text-btn" onClick={() => openView('followups')}>全部 <ArrowRight size={13}/></button></div>
            <div className="section-list">{home.questions.slice(0, 3).map(followUpRow)}</div>
          </section>}
        </div>}
        {activeConditions.length > 0 && <section className="home-section" aria-label="条件跟进"><div className="section-heading"><h2>条件跟进 <span>{activeConditions.length}</span></h2></div><div className="section-list">{activeConditions.slice(0, 3).map(conditionRow)}</div></section>}
        {home.recent.length > 0 && <section className="home-section home-recent-section" aria-label="最近沟通">
          <div className="section-heading"><h2>最近沟通</h2><button className="text-btn" onClick={() => openView('history')}>历史 <ArrowRight size={13}/></button></div>
          <div className="recent-closure-grid">{home.recent.slice(0, 3).map(record => <button className="recent-closure" key={record.id} onClick={() => { props.onOpenClosure(record); setView('receipt'); }}><span><strong>{record.engagementIds.map(id => cached.engagements.find(project => project.id === id)?.clientName).filter(Boolean).slice(0, 3).join('、') || '沟通记录'}</strong><small>{chinaTime(record.confirmedAt)} · {record.originalOnly ? '仅原文' : record.revertedAt ? '已撤销' : '已核对'}</small></span><ArrowRight size={15}/></button>)}</div>
        </section>}
      </>}
    </aside>}
    </div>}

    {view === 'projects' && <section className="records-panel">{selectedProjectId && <ProjectContinuation projectId={selectedProjectId} revision={cached.revision} draft={draft} busy={props.busy} workSuggestionsEnabled={suggestionsEnabled} initialArtifactCondition={artifactRequest?.projectId === selectedProjectId ? artifactRequest : null} onConsumeArtifactRequest={() => setArtifactRequest(null)} onContinueProject={continueProject} onResumeDraft={resume} onEdit={project => manual([{ target: 'engagement', entityId: project.id, before: project, after: { ...project, updatedAt: Date.now() } }], '编辑客户合作项目')} onClose={() => { setArtifactRequest(null); setSelectedProjectId(null); }} onProjectLoaded={project => setDetailProject({ identity: Repository.getReadIdentity?.() || '', project })} onOpenClosure={record => { props.onOpenClosure(record); setView('receipt'); }} renderTask={taskRow} renderFollowUp={followUpRow} renderCondition={conditionRow}/>}{!visibleItems.length && !loading && <p className="empty-text">暂无客户项目</p>}<div className="project-grid">{(visibleItems as Engagement[]).map(project => <article className="project-card" key={project.id}><header><span className="project-client">{project.clientName || '未命名客户'}</span><span className={`tag tag--stage-${project.stage}`}>{project.stage}</span></header><h3>{project.title || '未命名项目'}</h3><div className="project-action-box"><strong>卡点 / 下一步</strong><p className="project-next-action">{project.nextAction || '暂无下一步安排'}</p></div><span className="budget-label">预算规模</span><p className="project-budget">{project.budgetAmount === undefined ? '预算待定' : `¥${project.budgetAmount.toLocaleString('zh-CN')}`}</p><footer className="button-row"><button className="soft-btn" onClick={() => showProject(project.id)}>详情</button><button className="text-btn" disabled={props.busy} onClick={() => { manual([{ target: 'engagement', entityId: project.id, before: project, after: { ...project, updatedAt: Date.now() } }], '编辑客户合作项目'); }}>编辑</button><button className="text-btn" onClick={() => props.onExport(project)}><FileText size={13}/>纪要</button></footer><details><summary>备注与阶段推进</summary>{project.shareableSummary && <p className="muted small">{project.shareableSummary}</p>}<p className="small">{project.internalContext || '无内部备注'}</p><button className="text-btn" disabled={props.busy || project.stage === '赢单成交'} onClick={() => manual([{ target: 'engagement', entityId: project.id, before: project, after: { ...project, stage: stages[Math.min(4, stages.indexOf(project.stage) + 1)], updatedAt: Date.now() } }], '核对项目进展')}>推进至下一阶段 →</button></details></article>)}</div></section>}

    {view === 'tasks' && <section className="records-panel" aria-label="项目行动"><div className="records-panel-bar action-list-heading"><div><h2>项目行动</h2><p>在这里跟进我方要完成的事，没设提醒也能记录和完成。</p></div><label className="check-label"><input type="checkbox" checked={dueOnly} onChange={event => setDueOnly(event.target.checked)}/>只看到期未完成</label></div>{!visibleItems.length && !loading && <p className="empty-text">暂无项目行动</p>}<div className="records-list">{[...(visibleItems as ProjectTaskItem[])].sort((a, b) => Number(a.done) - Number(b.done)).map(taskRow)}</div></section>}

    {view === 'followups' && <section className="records-panel">{!visibleItems.length && !loading && <p className="empty-text">暂无等待或未定事项</p>}<div className="records-list">{(visibleItems as FollowUpItem[]).map(followUpRow)}</div></section>}

    {view === 'history' && <section className="records-panel">{!visibleItems.length && !loading && <p className="empty-text">暂无变更记录</p>}<div className="records-list">{visibleItems.map(event => <article className="history-row" key={event.id}><History size={16}/><div><div className="history-row-head"><strong>{event.revertedAt ? '已撤销' : '已保存'} · {eventMutations(event).length} 项变更</strong><time>{chinaTime(event.createdAt)}</time>{!event.revertedAt && <button className="text-btn" disabled={props.busy} onClick={() => props.onUndoEvent(event.id)}>撤销</button>}</div><p>{event.sourceText || '无原文'}</p></div></article>)}</div></section>}

    {view === 'receipt' && (closure ? receiptData ? <ClosureReceipt closure={closure} {...receiptData} onProject={showProject} onContinue={start} onExport={props.onExport} onUndo={props.onUndoEvent}/> : <p className="receipt-loading" role="status">读取中…</p> : <p className="empty-text">暂无记录</p>)}
    {kind && cursor && <button className="soft-btn work-more" disabled={loading} onClick={() => void more()}>{loading ? '读取中…' : '加载更多'}<ChevronDown size={14}/></button>}
    {loading && view !== 'home' && <p className="muted small" role="status">读取中…</p>}
  </div>;
}
