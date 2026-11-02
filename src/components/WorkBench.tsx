import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, Plus, CornerDownLeft, History, CheckCircle2, Circle, RotateCcw, ChevronDown, Sparkles, ClipboardPaste, FolderPlus, ListPlus } from 'lucide-react';
import type { WorkPartition, WorkOperation, Engagement, ProposedChangeSet, CaptureDraft, WorkHome, ClosureRecord, FollowUpItem, ProjectTaskItem, Message, CommittedChangeEvent } from '../types';
import { chinaTime } from '../services/aiService';
import { ProposalReview } from './ProposalReview';
import { ClosureReceipt } from './ClosureReceipt';
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
  onCancel(): void;
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
  onOriginalOnly(): void;
  onRebase(): void;
  onResolveConflict(id: string, choice: 'current' | 'proposed'): void;
  onSetItemState(kind: 'task' | 'followup', item: ProjectTaskItem | FollowUpItem, done: boolean): Promise<void>;
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
  const [selectedProject, setSelectedProject] = useState<Engagement | null>(null);
  const [projectDetail, setProjectDetail] = useState<{ tasks: ProjectTaskItem[]; followUps: FollowUpItem[]; recent: ClosureRecord[]; more: boolean } | null>(null);
  const [receiptData, setReceiptData] = useState<{ source: Message | null; event: CommittedChangeEvent | null; engagements: Engagement[]; tasks: ProjectTaskItem[]; followUps: FollowUpItem[] } | null>(null);
  const listSequence = useRef(0);
  const text = draft?.text || '';
  const hasDraft = !!text.trim() || !!draft?.proposal;
  const hasBusiness = !!cached.engagements.length || !!cached.tasks.length || !!cached.followUps?.length || !!home?.recent.length || Number(props.stats?.counts?.message || 0) > 0;
  const kind = view === 'projects' || view === 'capture' || (view === 'home' && !hasBusiness) ? 'engagement' : view === 'tasks' ? 'task' : view === 'followups' ? 'followup' : view === 'history' ? 'event' : null;
  const key = `${kind}:${query}:${dueOnly}`;
  const visibleItems = itemsKey === key ? items : [];
  const projects = uniqueProjects([...cached.engagements, ...((kind === 'engagement' ? visibleItems : []) as Engagement[]), ...(selectedProject ? [selectedProject] : [])]);

  useEffect(() => { if (closure) { setReceiptData(null); setView('receipt'); } }, [closure?.id]);
  useEffect(() => {
    if (props.projectLookup) { setSelectedProject(null); setQuery(props.projectLookup.query); setView('projects'); }
  }, [props.projectLookup?.requestId]);
  useEffect(() => {
    const sequence = ++listSequence.current; let active = true;
    if (!kind) { setLoading(false); setCursor(null); return () => { active = false; listSequence.current++; }; }
    setLoading(true); setListError('');
    Repository.query('work', kind, { query, limit: 50, ...(kind === 'task' ? { dueOnly } : {}) }).then(page => {
      if (active && sequence === listSequence.current) { setItems(page.items); setItemsKey(key); setCursor(page.nextCursor || null); }
    }).catch(() => { if (active) setListError('记录读取失败，请重试。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; listSequence.current++; };
  }, [kind, query, dueOnly, cached.revision]);
  useEffect(() => {
    if (!selectedProject || view !== 'projects') return;
    let active = true; setProjectDetail(null);
    void Promise.all([
      Repository.get<Engagement>('work', 'engagement', selectedProject.id),
      Repository.query<ProjectTaskItem>('work', 'task', { relatedId: selectedProject.id, limit: 50 }),
      Repository.query<FollowUpItem>('work', 'followup', { relatedId: selectedProject.id, limit: 50 }),
      Repository.query<ClosureRecord>('work', 'closure', { relatedId: selectedProject.id, limit: 3 }),
    ]).then(([project, tasks, followUps, recent]) => { if (active) { setSelectedProject(project); setProjectDetail({ tasks: tasks.items, followUps: followUps.items, recent: recent.items, more: !!tasks.nextCursor || !!followUps.nextCursor }); } }).catch(() => { if (active) setListError('项目关联资料暂未读全，请重试。'); });
    return () => { active = false; };
  }, [view, selectedProject?.id, cached.revision]);
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
  function manual(operations: WorkOperation[], label: string) { props.onManual(operations, label); openView('capture'); }
  function createProject() {
    const engagement: Engagement = { id: crypto.randomUUID(), clientName: '', title: '', stage: '初步接触', internalContext: '', shareableSummary: '', nextAction: '', updatedAt: Date.now() };
    manual([{ target: 'engagement', entityId: engagement.id, before: null, after: engagement }], '手动新建客户合作项目');
  }
  function showProject(id: string) {
    const project = projects.find(item => item.id === id) || receiptData?.engagements.find(item => item.id === id);
    setSelectedProject(project || null); openView('projects');
    if (!project) void Repository.get<Engagement>('work', 'engagement', id).then(value => { if (value) setSelectedProject(value); }).catch(() => setListError('项目读取失败，请稍后再试。'));
  }
  async function setItemState(kind: 'task' | 'followup', item: ProjectTaskItem | FollowUpItem, done: boolean) {
    if (props.busy || savingItem) return;
    setSavingItem(item.id); setListError('');
    try { await props.onSetItemState(kind, item, done); }
    catch { setListError('状态尚未保存，请重试。'); }
    finally { setSavingItem(''); }
  }
  function taskRow(task: ProjectTaskItem) {
    return <article className={`task-row ${task.done ? 'completed' : ''}`} key={task.id}><button className="icon-btn task-check-btn" disabled={props.busy || !!savingItem} aria-label={`${task.done ? '重新打开' : '完成'}${task.title}`} onClick={() => setItemState('task', task, !task.done)}>{task.done ? <CheckCircle2 size={18}/> : <Circle size={18}/>}</button><div className="task-row-body"><h3>{task.title}</h3><p>{projects.find(project => project.id === task.engagementId)?.clientName || '未关联客户'} · {task.dueAt ? chinaTime(task.dueAt) : '无提醒'}</p></div><button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'task', entityId: task.id, before: task, after: { ...task } }], '修改跟进行动')}>修改</button></article>;
  }
  function followUpRow(item: FollowUpItem) {
    const resolved = item.status === 'resolved';
    return <article className={`followup-row${resolved ? ' completed' : ''}`} key={item.id}><div className="followup-row-body"><span className={`followup-label followup-label--${item.kind}`}>{item.kind === 'waiting' ? '等待客户' : '仍待确认'}{resolved ? ' · 已处理' : ''}</span><h3>{item.title}</h3><p>{item.expectedDate ? `预计 ${item.expectedDate}` : item.expectedAt ? `预计 ${chinaTime(item.expectedAt)}` : item.kind === 'waiting' ? '时间未定' : '待确认'}{item.reviewAt ? ` · 回访 ${chinaTime(item.reviewAt)}` : ''}</p></div><div className="followup-actions"><button className="soft-btn" disabled={props.busy || !!savingItem} onClick={() => setItemState('followup', item, !resolved)}>{resolved ? '重新打开' : item.kind === 'waiting' ? '已收到' : '已处理'}</button><button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'followup', entityId: item.id, before: item, after: { ...item } }], '核对等待或未定事项')}>修改</button></div></article>;
  }
  function capturePanel() {
    return <div className={`capture-layout ${pending ? '' : 'capture-layout--single'}`}><div className="capture-column"><section className="capture-card">
      <div className="capture-card-header">
        <div className={`draft-save-state draft-save-state--${props.draftSaveState}`} role="status"><span className="status-dot"/><span>{saveLabels[props.draftSaveState]}</span>{props.draftSaveState === 'error' && props.onRetryDraft && <button className="text-btn" onClick={props.onRetryDraft}>重试</button>}<span className="draft-char-count">{text.length} / 12000</span></div>
        <div className="capture-quick-tools">
          <button className="text-btn" type="button" disabled={props.busy} onClick={async () => { const clip = await window.electronAPI?.readClipboard?.(); if (clip) props.onDraftChange({ text: clip }); }}><ClipboardPaste size={13}/>粘贴剪贴板</button>
          <button className="text-btn" disabled={props.busy} onClick={createProject}><FolderPlus size={13}/>新建项目</button>
          <button className="text-btn" disabled={props.busy} onClick={() => { const id = crypto.randomUUID(); manual([{ target: 'task', entityId: id, before: null, after: { id, title: '', assignee: '我', deadline: '', priority: 'medium', done: false, ...(props.selectedId ? { engagementId: props.selectedId } : {}) } }], '手动新增跟进行动'); }}><ListPlus size={13}/>新增行动</button>
          {props.onPractice && <button className="text-btn" disabled={props.busy} onClick={props.onPractice}><Sparkles size={13}/>放心练习一次</button>}
        </div>
      </div>
      <textarea aria-label="客户沟通记录" className="capture-input" rows={6} maxLength={12000} disabled={props.busy} value={text} onChange={event => { setView('capture'); props.onDraftChange({ text: event.target.value }); }} placeholder="输入或粘贴沟通记录（如：陈姐的商城改版，预算2.5w，我周五下午3点发原型，客户下周一补素材）…"/>
      <details className="capture-binding" open={!!pending?.clarification || !!props.selectedId || showBinding || !!draft?.newClientName}><summary>{pending?.clarification ? '选择或新建关联项目' : '关联客户项目（可选，默认自动识别）'}</summary>
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
          <button className="soft-btn" disabled={props.busy || !text.trim()} onClick={props.onOriginalOnly}>仅存原文</button>
          <button className="primary-btn" disabled={props.busy || !text.trim()} onClick={() => void props.onPropose(text)}>{props.busy ? '整理中…' : pending ? '重新整理' : '整理并核对'}<CornerDownLeft size={14}/></button>
        </div>
      </div>
    </section></div>
    {pending && <div className="review-column"><fieldset className="review-fieldset" disabled={props.busy}><ProposalReview proposal={pending} engagements={projects} conflicts={draft?.conflicts} onResolveConflict={props.onResolveConflict} onChange={props.onChange} onConfirm={props.onConfirm} onDiscard={props.onDiscard} onReparse={props.onRebase} busy={props.busy}/></fieldset></div>}</div>;
  }

  const showCapture = view === 'capture' || (view === 'home' && !hasBusiness && !hasDraft);
  return <div className="work-v5">
    <div className="work-v5-toolbar">
      <nav className="work-v5-tabs" aria-label="工作台导航">
        {([['home', '待办'], ['capture', '随口记录'], ['projects', '项目'], ['tasks', '跟进行动'], ['followups', '等待与未定'], ['history', '变更记录']] as const).map(([value, label]) => (
          <button key={value} type="button" className={view === value ? 'active' : ''} onClick={() => openView(value)}>
            {label}
            {value === 'capture' && hasDraft && <span className="tiny-dot"/>}
          </button>
        ))}
      </nav>
      <div className="work-v5-toolbar-actions">
        {(view === 'projects' || view === 'tasks' || view === 'followups' || view === 'history') && (
          <label className="toolbar-search">
            <input aria-label="查找已有记录" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索记录…"/>
          </label>
        )}
        {view === 'projects' && <button className="soft-btn" disabled={props.busy} onClick={createProject}><Plus size={14}/>新建项目</button>}
        {view === 'history' && <button className="soft-btn" disabled={props.busy || !visibleItems.some(event => !event.revertedAt)} onClick={props.onUndo}><RotateCcw size={14}/>撤销</button>}
        {!showCapture && <button className="primary-btn" onClick={start} disabled={props.busy}><Plus size={14}/>记下一段沟通</button>}
      </div>
    </div>

    {listError && <p className="notice" role="alert">{listError}</p>}

    {view === 'home' && (hasBusiness || hasDraft) && <section className="continuation-home" aria-label="继续处理工作">
      {hasDraft && <article className="resume-draft"><div className="resume-draft-info"><span className="resume-badge">未完成草稿</span><p>{shortText(text || '存在待确认的更改草稿', 90)}</p></div><button className="soft-btn" onClick={resume} disabled={props.busy}>继续整理 <ArrowRight size={14}/></button></article>}
      {!home ? <p className="muted small" role="status">读取中…</p> : <>
        {home.counts.overdue > 0 && <section className="home-section home-section--overdue" aria-label="早前安排"><div className="section-heading"><h2>逾期未完 <span>{home.counts.overdue}</span></h2><button className="text-btn" onClick={() => { openView('tasks'); setDueOnly(true); }}>查看 <ArrowRight size={13}/></button></div><div className="section-list">{home.overdue.slice(0, 3).map(taskRow)}</div></section>}
        <div className="home-bento-grid">
          <section className="home-section" aria-label="今天要处理">
            <div className="section-heading"><h2>今日行动 <span>{home.counts.today}</span></h2><button className="text-btn" onClick={() => openView('tasks')}>全部 <ArrowRight size={13}/></button></div>
            <div className="section-list">{home.today.length ? home.today.slice(0, 3).map(taskRow) : <p className="home-empty">今日暂无待办行动</p>}</div>
          </section>
          <section className="home-section" aria-label="等待客户">
            <div className="section-heading"><h2>等待客户 <span>{home.counts.waiting}</span></h2><button className="text-btn" onClick={() => openView('followups')}>全部 <ArrowRight size={13}/></button></div>
            <div className="section-list">{home.waiting.length ? home.waiting.slice(0, 3).map(followUpRow) : <p className="home-empty">暂无等待客户事项</p>}</div>
          </section>
          <section className="home-section" aria-label="仍待确认">
            <div className="section-heading"><h2>待确认项 <span>{home.counts.questions}</span></h2><button className="text-btn" onClick={() => openView('followups')}>全部 <ArrowRight size={13}/></button></div>
            <div className="section-list">{home.questions.length ? home.questions.slice(0, 3).map(followUpRow) : <p className="home-empty">暂无未定事项</p>}</div>
          </section>
        </div>
        <section className="home-section home-recent-section" aria-label="最近沟通">
          <div className="section-heading"><h2>最近沟通</h2><button className="text-btn" onClick={() => openView('history')}>历史 <ArrowRight size={13}/></button></div>
          {home.recent.length ? <div className="recent-closure-grid">{home.recent.slice(0, 3).map(record => <button className="recent-closure" key={record.id} onClick={() => { props.onOpenClosure(record); setView('receipt'); }}><span><strong>{record.engagementIds.map(id => cached.engagements.find(project => project.id === id)?.clientName).filter(Boolean).slice(0, 3).join('、') || '沟通记录'}</strong><small>{chinaTime(record.confirmedAt)} · {record.originalOnly ? '仅原文' : record.revertedAt ? '已撤销' : '已核对'}</small></span><ArrowRight size={15}/></button>)}</div> : <p className="home-empty">暂无最近沟通记录</p>}
        </section>
      </>}
    </section>}

    {showCapture && capturePanel()}

    {view === 'projects' && <section className="records-panel">{selectedProject && <section className="project-continuation" aria-label={`${selectedProject.clientName}项目详情`}><div className="section-heading"><h2>{selectedProject.clientName} · {selectedProject.title}</h2><div className="button-row"><button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'engagement', entityId: selectedProject.id, before: selectedProject, after: { ...selectedProject, updatedAt: Date.now() } }], '核对项目预算')}>编辑项目</button><button className="text-btn" onClick={props.onOpenMemory}>记忆档案 <ArrowRight size={13}/></button><button className="soft-btn" onClick={() => setSelectedProject(null)}>收起</button></div></div><p className="project-detail-budget">预算：{selectedProject.budgetAmount === undefined ? '待定' : `¥${selectedProject.budgetAmount.toLocaleString('zh-CN')}`}</p>{projectDetail ? <div className="project-detail-columns"><div><h3>我方下一步</h3>{projectDetail.tasks.length ? projectDetail.tasks.map(taskRow) : <p className="home-empty">无</p>}</div><div><h3>等待与待确认</h3>{projectDetail.followUps.length ? projectDetail.followUps.map(followUpRow) : <p className="home-empty">无</p>}</div><div><h3>最近记录</h3>{projectDetail.recent.length ? projectDetail.recent.map(record => <button className="recent-closure" key={record.id} onClick={() => { props.onOpenClosure(record); setView('receipt'); }}><span>{chinaTime(record.confirmedAt)}</span><ArrowRight size={14}/></button>) : <p className="home-empty">无</p>}</div></div> : <p className="muted small" role="status">读取中…</p>}</section>}{!visibleItems.length && !loading && <p className="empty-text">暂无客户项目</p>}<div className="project-grid">{(visibleItems as Engagement[]).map(project => <article className="project-card" key={project.id}><header><span className="project-client">{project.clientName || '未命名客户'}</span><span className="tag">{project.stage}</span></header><h3>{project.title || '未命名项目'}</h3><p className="project-budget">{project.budgetAmount === undefined ? '预算待定' : `¥${project.budgetAmount.toLocaleString('zh-CN')}`}</p><p className="project-next-action">{project.nextAction || '暂无下一步安排'}</p><footer className="button-row"><button className="soft-btn" onClick={() => showProject(project.id)}>详情</button><button className="text-btn" disabled={props.busy} onClick={() => { manual([{ target: 'engagement', entityId: project.id, before: project, after: { ...project, updatedAt: Date.now() } }], '编辑客户合作项目'); }}>编辑</button><button className="text-btn" onClick={() => props.onExport(project)}><FileText size={13}/>纪要</button></footer><details><summary>备注与阶段推进</summary>{project.shareableSummary && <p className="muted small">{project.shareableSummary}</p>}<p className="small">{project.internalContext || '无内部备注'}</p><button className="text-btn" disabled={props.busy || project.stage === '赢单成交'} onClick={() => manual([{ target: 'engagement', entityId: project.id, before: project, after: { ...project, stage: stages[Math.min(4, stages.indexOf(project.stage) + 1)], updatedAt: Date.now() } }], '核对项目进展')}>推进至下一阶段 →</button></details></article>)}</div></section>}

    {view === 'tasks' && <section className="records-panel"><div className="records-panel-bar"><label className="check-label"><input type="checkbox" checked={dueOnly} onChange={event => setDueOnly(event.target.checked)}/>只看到期未完成</label></div>{!visibleItems.length && !loading && <p className="empty-text">暂无跟进行动</p>}<div className="records-list">{[...(visibleItems as ProjectTaskItem[])].sort((a, b) => Number(a.done) - Number(b.done)).map(taskRow)}</div></section>}

    {view === 'followups' && <section className="records-panel">{!visibleItems.length && !loading && <p className="empty-text">暂无等待或未定事项</p>}<div className="records-list">{(visibleItems as FollowUpItem[]).map(followUpRow)}</div></section>}

    {view === 'history' && <section className="records-panel">{!visibleItems.length && !loading && <p className="empty-text">暂无变更记录</p>}<div className="records-list">{visibleItems.map(event => <article className="history-row" key={event.id}><History size={16}/><div><div className="history-row-head"><strong>{event.revertedAt ? '已撤销' : '已保存'} · {eventMutations(event).length} 项变更</strong><time>{chinaTime(event.createdAt)}</time>{!event.revertedAt && <button className="text-btn" disabled={props.busy} onClick={() => props.onUndoEvent(event.id)}>撤销</button>}</div><p>{event.sourceText || '无原文'}</p></div></article>)}</div></section>}

    {view === 'receipt' && (closure ? receiptData ? <ClosureReceipt closure={closure} {...receiptData} onProject={showProject} onContinue={start} onExport={props.onExport} onUndo={props.onUndoEvent}/> : <p className="receipt-loading" role="status">读取中…</p> : <p className="empty-text">暂无记录</p>)}
    {kind && cursor && <button className="soft-btn work-more" disabled={loading} onClick={() => void more()}>{loading ? '读取中…' : '加载更多'}<ChevronDown size={14}/></button>}
    {loading && view !== 'home' && <p className="muted small" role="status">读取中…</p>}
  </div>;
}
