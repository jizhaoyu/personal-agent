import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, Plus, CornerDownLeft, History, CheckCircle2, Circle, RotateCcw, BookOpen, Clock3, ChevronDown } from 'lucide-react';
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
const shortText = (value: string, length = 60) => value.length > length ? `${value.slice(0, length)}…` : value;
const saveLabels = { idle: '原文先留在这里', unsaved: '草稿有未保存的修改', saving: '正在保存草稿…', saved: '草稿已保存在本机', error: '草稿暂未保存，请保留输入' };

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
    }).catch(() => { if (active) setListError('记录暂时没能读取，可以重新打开此列表。'); }).finally(() => { if (active) setLoading(false); });
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
    ]).then(([project, tasks, followUps, recent]) => { if (active) { setSelectedProject(project); setProjectDetail({ tasks: tasks.items, followUps: followUps.items, recent: recent.items, more: !!tasks.nextCursor || !!followUps.nextCursor }); } }).catch(() => { if (active) setListError('项目的关联资料暂未读全，可以重试打开。'); });
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
    ]).then(([source, event, engagements, tasks, followUps]) => { if (active) setReceiptData({ source, event, engagements, tasks, followUps }); }).catch(() => { if (active) setListError('本次已经保存，关联资料暂未读全。可稍后重新打开这条收尾记录。'); });
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
    catch { setListError('本次状态尚未确认保存，原状态仍保留。请查看提示后重试。'); }
    finally { setSavingItem(''); }
  }
  function taskRow(task: ProjectTaskItem) {
    return <article className={`task-row ${task.done ? 'completed' : ''}`} key={task.id}><button className="icon-btn" disabled={props.busy || !!savingItem} aria-label={`${task.done ? '重新打开' : '完成'}${task.title}`} onClick={() => setItemState('task', task, !task.done)}>{task.done ? <CheckCircle2 size={21}/> : <Circle size={21}/>}</button><div><h3>{task.title}</h3><p>{projects.find(project => project.id === task.engagementId)?.clientName || '未关联客户'} · {task.dueAt ? chinaTime(task.dueAt) : '提醒时间未设置'}</p></div><button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'task', entityId: task.id, before: task, after: { ...task } }], '修改跟进行动')}>修改</button></article>;
  }
  function followUpRow(item: FollowUpItem) {
    const resolved = item.status === 'resolved';
    return <article className={`followup-row${resolved ? ' completed' : ''}`} key={item.id}><div><span className={`followup-label followup-label--${item.kind}`}>{item.kind === 'waiting' ? '等待客户' : '仍待确认'}{resolved ? ' · 已处理' : ''}</span><h3>{item.title}</h3><p>{item.expectedDate ? `客户预计 ${item.expectedDate}（未约定时刻）` : item.expectedAt ? `客户预计 ${chinaTime(item.expectedAt)}` : item.kind === 'waiting' ? '对方时间尚未确定' : '未作为确定的预算、日期或承诺'}</p>{item.reviewAt && <p>我方回访：{chinaTime(item.reviewAt)}</p>}</div><div className="followup-actions"><button className="soft-btn" disabled={props.busy || !!savingItem} onClick={() => setItemState('followup', item, !resolved)}>{resolved ? '重新打开' : item.kind === 'waiting' ? '标记已收到' : '标记已处理'}</button><button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'followup', entityId: item.id, before: item, after: { ...item } }], '核对等待或未定事项')}>修改</button></div></article>;
  }
  function capturePanel() {
    return <div className="capture-layout"><div className="capture-column"><section className="capture-card">
      <div className="section-heading"><span className="eyebrow">先接住这次沟通</span><span className="tag">{props.modelEnabled ? '桌面模型增强' : '本地基础整理'}</span></div>
      <h2>记下刚才的沟通</h2><p className="muted small">原话、修改意见或一段聊天都可以先放在这里。安排由你核对。</p>
      <textarea aria-label="客户沟通记录" className="capture-input" rows={6} maxLength={12000} disabled={props.busy} value={text} onChange={event => { setView('capture'); props.onDraftChange({ text: event.target.value }); }} placeholder="例如：李总的网站改版，预算300元。我周五发首页原型，客户下周一补素材，新增页面费用还没谈定。"/>
      <div className={`draft-save-state draft-save-state--${props.draftSaveState}`} role="status"><span className="status-dot"/>{saveLabels[props.draftSaveState]}{props.draftSaveState === 'error' && props.onRetryDraft && <button className="text-btn" onClick={props.onRetryDraft}>重试保存草稿</button>}<span>{text.length} / 12000</span></div>
      <details className="capture-binding" open={!!pending?.clarification || !!props.selectedId || showBinding || !!draft?.newClientName}><summary>{pending?.clarification ? '这段沟通属于哪个合作项目？' : '选择已有项目，或新建合作'}</summary>
        {pending?.clarification && <p className="muted small">{pending.clarification.message}原文已经保留。已有合作可选择项目，首次合作可填写客户和项目名称。</p>}
        <label>查找已有项目<input aria-label="查找已有记录" value={query} disabled={props.busy} onChange={event => setQuery(event.target.value)} placeholder="客户名或项目关键词"/></label>
        <label className="context-select">选择已有合作<select aria-label="目标项目" value={props.selectedId} disabled={props.busy} onChange={event => props.onSelect(event.target.value)}><option value="">从沟通内容识别</option>{projects.map(project => <option key={project.id} value={project.id}>{project.clientName} · {project.title}</option>)}</select></label>
        {!props.selectedId ? <div className="field-grid"><label>新合作的客户姓名<input aria-label="明确新客户姓名" disabled={props.busy} maxLength={100} value={draft?.newClientName || ''} onChange={event => props.onDraftChange({ newClientName: event.target.value })} placeholder="例如：张三"/></label><label>合作项目名称<input aria-label="新项目名称" disabled={props.busy} maxLength={200} value={draft?.newProjectTitle || ''} onChange={event => props.onDraftChange({ newProjectTitle: event.target.value })} placeholder="例如：官网改版"/></label></div> : <button className="text-btn" disabled={props.busy} onClick={() => { props.onSelect(''); setShowBinding(true); }}>这是一次新合作</button>}
      </details>
      <div className="input-footer"><button className="text-btn" disabled={props.busy || !text.trim()} onClick={props.onOriginalOnly}>仅保存原文</button><button className="primary-btn" disabled={props.busy || !text.trim()} onClick={() => void props.onPropose(text)}>{props.busy ? '正在整理…' : pending ? '按当前输入重新整理' : '整理并核对'}<CornerDownLeft size={14}/></button></div>
      {props.modelBusy && <p className="muted small">模型仍在整理，你可以先核对本地结果。<button className="text-btn" onClick={props.onCancel}>取消模型请求，保留本地预览</button></p>}
      {!props.modelEnabled && <p className="muted small">无需配置模型即可开始。本地整理只识别部分表达，结果请逐项核对。</p>}
      {props.onPractice && <div className="practice-entry"><span>想先熟悉流程？演练不会写入真实资料。</span><button className="text-btn" disabled={props.busy} onClick={props.onPractice}>放心练习一次 <ArrowRight size={13}/></button></div>}
    </section><div className="capture-secondary-actions"><button className="text-btn" disabled={props.busy} onClick={createProject}><Plus size={14}/>手动新建项目</button><button className="text-btn" disabled={props.busy} onClick={() => { const id = crypto.randomUUID(); manual([{ target: 'task', entityId: id, before: null, after: { id, title: '', assignee: '我', deadline: '', priority: 'medium', done: false, ...(props.selectedId ? { engagementId: props.selectedId } : {}) } }], '手动新增跟进行动'); }}><Plus size={14}/>手动新增行动</button></div></div>
    <div className="review-column">{pending ? <fieldset className="review-fieldset" disabled={props.busy}><ProposalReview proposal={pending} engagements={projects} conflicts={draft?.conflicts} onResolveConflict={props.onResolveConflict} onChange={props.onChange} onConfirm={props.onConfirm} onDiscard={props.onDiscard} onReparse={props.onRebase} busy={props.busy}/></fieldset> : <div className="capture-expectation"><BookOpen size={24}/><h3>核对清楚，再接着走。</h3><p>整理结果会分清楚：</p><ul><li>这次记下了什么</li><li>我方下一步</li><li>在等待客户什么</li><li>还有哪些没谈定</li></ul><p className="muted small">不确定的内容会保留下来，暂不当成确定的预算或承诺。</p></div>}</div></div>;
  }

  const showCapture = view === 'capture' || (view === 'home' && !hasBusiness && !hasDraft);
  return <div className="work-v5">
    <section className="work-v5-intro"><div><span className="eyebrow">LOOMA · 留下依据，接上下一步</span><h1>{view === 'home' && hasBusiness ? '从上次的事情，接着往前。' : '聊完，先把下一步放好。'}</h1><p>{hasDraft ? '有一段尚未结束的整理，原文和修改会留在当前工作空间。' : '分清要做的、在等的和没定的，核对后留在这里。'}</p></div>{props.companion}</section>
    <nav className="work-tabs work-v5-tabs" aria-label="工作台导航">{([['home', '接着处理'], ['capture', '随口记录'], ['projects', '客户项目'], ['tasks', '跟进行动'], ['followups', '等待与未定'], ['history', '变更记录']] as const).map(([value, label]) => <button key={value} className={view === value ? 'active' : ''} onClick={() => openView(value)}>{label}{value === 'capture' && hasDraft && <span className="tiny-dot"/>}</button>)}</nav>
    {listError && <p className="notice" role="alert">{listError}</p>}
    {view === 'home' && (hasBusiness || hasDraft) && <section className="continuation-home" aria-label="继续处理工作">
      <div className="home-primary-action"><div><h2>今天，从哪件事开始？</h2><p>先看自己的安排，也给等待和未定内容留个位置。</p></div><button className="primary-btn" onClick={start} disabled={props.busy}>记下一段沟通 <Plus size={15}/></button></div>
      {hasDraft && <article className="resume-draft"><div><span className="eyebrow">继续未完成的整理</span><p>{shortText(text || '有一份尚未核对完成的记录。', 110)}</p><small>{saveLabels[props.draftSaveState]}</small></div><button className="soft-btn" onClick={resume} disabled={props.busy}>继续整理 <ArrowRight size={14}/></button></article>}
      {!home ? <p className="muted small" role="status">正在读取今天的安排…</p> : <>
        <section className="home-section" aria-label="今天要处理"><div className="section-heading"><h2>今天要处理 <span>{home.counts.today}</span></h2><button className="text-btn" onClick={() => openView('tasks')}>查看全部行动 <ArrowRight size={13}/></button></div>{home.today.length ? home.today.slice(0, 3).map(taskRow) : <p className="home-empty">暂时没有已安排在今天的行动。</p>}</section>
        {home.counts.overdue > 0 && <section className="home-section home-section--overdue" aria-label="早前安排"><div className="section-heading"><h2>早前安排，回来核对 <span>{home.counts.overdue}</span></h2><button className="text-btn" onClick={() => { openView('tasks'); setDueOnly(true); }}>查看到期行动 <ArrowRight size={13}/></button></div>{home.overdue.slice(0, 3).map(taskRow)}</section>}
        <div className="home-followup-grid"><section className="home-section" aria-label="等待客户"><div className="section-heading"><h2>等待客户 <span>{home.counts.waiting}</span></h2><button className="text-btn" onClick={() => openView('followups')}>查看全部</button></div>{home.waiting.length ? home.waiting.slice(0, 3).map(followUpRow) : <p className="home-empty">暂时没有记录等待客户的内容。</p>}</section><section className="home-section" aria-label="仍待确认"><div className="section-heading"><h2>仍待确认 <span>{home.counts.questions}</span></h2><button className="text-btn" onClick={() => openView('followups')}>查看全部</button></div>{home.questions.length ? home.questions.slice(0, 3).map(followUpRow) : <p className="home-empty">暂时没有记录待确认的问题。</p>}</section></div>
        <section className="home-section" aria-label="最近沟通"><div className="section-heading"><h2>最近沟通</h2><button className="text-btn" onClick={() => openView('history')}>查看历史 <ArrowRight size={13}/></button></div>{home.recent.length ? home.recent.slice(0, 3).map(record => <button className="recent-closure" key={record.id} onClick={() => { props.onOpenClosure(record); setView('receipt'); }}><span><strong>{record.engagementIds.map(id => cached.engagements.find(project => project.id === id)?.clientName).filter(Boolean).slice(0, 3).join('、') || '沟通收尾记录'}</strong><small>{chinaTime(record.confirmedAt)} · {record.originalOnly ? '仅原文' : record.revertedAt ? '已撤销' : '已核对记录'}</small></span><ArrowRight size={16}/></button>) : <p className="home-empty">确认一段沟通后，可以从这里接着找回。</p>}</section>
      </>}
    </section>}
    {showCapture && capturePanel()}
    {(view === 'projects' || view === 'tasks' || view === 'followups' || view === 'history') && <label className="archive-search">搜索当前列表<input aria-label="查找已有记录" value={query} onChange={event => setQuery(event.target.value)} placeholder="姓名、项目或至少两个字的关键词"/></label>}
    {view === 'projects' && <section className="records-panel"><div className="section-heading"><h2>客户合作项目</h2><button className="soft-btn" disabled={props.busy} onClick={createProject}><Plus size={14}/>新建项目</button></div>{selectedProject && <section className="project-continuation" aria-label={`${selectedProject.clientName}项目详情`}><div className="section-heading"><h2>{selectedProject.clientName} · {selectedProject.title}</h2><button className="text-btn" onClick={() => setSelectedProject(null)}>收起详情</button></div><p>当前预算：{selectedProject.budgetAmount === undefined ? '尚未确认' : `¥${selectedProject.budgetAmount.toLocaleString('zh-CN')}`}<button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'engagement', entityId: selectedProject.id, before: selectedProject, after: { ...selectedProject, updatedAt: Date.now() } }], '核对项目预算')}>核对预算与项目资料</button></p>{projectDetail ? <><h3>我方下一步</h3>{projectDetail.tasks.length ? projectDetail.tasks.map(taskRow) : <p className="muted small">尚未记录我方行动。</p>}<h3>等待客户与仍待确认</h3>{projectDetail.followUps.length ? projectDetail.followUps.map(followUpRow) : <p className="muted small">尚未记录等待或未定内容。</p>}{projectDetail.more && <p className="muted small">此处显示近期50条，请到完整行动或等待列表搜索和加载更早内容。</p>}<h3>最近沟通依据</h3>{projectDetail.recent.map(record => <button className="recent-closure" key={record.id} onClick={() => { props.onOpenClosure(record); setView('receipt'); }}><span>{chinaTime(record.confirmedAt)} · 查看这次收尾记录</span><ArrowRight size={14}/></button>)}<button className="text-btn" onClick={props.onOpenMemory}>进入记忆与来源档案 <ArrowRight size={13}/></button></> : <p className="muted small" role="status">正在读取这个项目的关联安排…</p>}</section>}{!visibleItems.length && !loading && <p className="empty-text">还没有找到客户项目。先记下一段沟通，再核对保存。</p>}<div className="project-grid">{(visibleItems as Engagement[]).map(project => <article className="project-card" key={project.id}><header><span className="project-client">{project.clientName}</span><span className="tag">{project.stage}</span></header><h3>{project.title}</h3><p className="project-budget">{project.budgetAmount === undefined ? '预算待确认' : `¥${project.budgetAmount.toLocaleString('zh-CN')}`}<span>预算参考</span></p><p className="small">下一步：{project.nextAction || '尚未记录'}</p><footer className="button-row"><button className="soft-btn" onClick={() => showProject(project.id)}>打开项目</button><button className="text-btn" disabled={props.busy} onClick={() => { manual([{ target: 'engagement', entityId: project.id, before: project, after: { ...project, updatedAt: Date.now() } }], '编辑客户合作项目'); }}>编辑</button><button className="text-btn" onClick={() => props.onExport(project)}><FileText size={14}/>准备纪要</button></footer><details><summary>更多资料与进展</summary>{project.shareableSummary && <p className="muted small">可外发摘要：{project.shareableSummary}</p>}<details><summary>内部备注</summary><p className="small">{project.internalContext || '暂无内部备注'}</p></details><button className="text-btn" disabled={props.busy || project.stage === '赢单成交'} onClick={() => manual([{ target: 'engagement', entityId: project.id, before: project, after: { ...project, stage: stages[Math.min(4, stages.indexOf(project.stage) + 1)], updatedAt: Date.now() } }], '核对项目进展')}>核对下一阶段</button></details></article>)}</div></section>}
    {view === 'tasks' && <section className="records-panel"><div className="section-heading"><h2>跟进行动</h2><span className="tag">明确勾选直接保存 · 可撤销</span></div><label className="check-label"><input type="checkbox" checked={dueOnly} onChange={event => setDueOnly(event.target.checked)}/>只看已到提醒时间的未完成行动（包含早期记录）</label>{!visibleItems.length && !loading && <p className="empty-text">这里还没有匹配的行动。</p>}{[...(visibleItems as ProjectTaskItem[])].sort((a, b) => Number(a.done) - Number(b.done)).map(taskRow)}</section>}
    {view === 'followups' && <section className="records-panel"><div className="section-heading"><h2>等待与未定</h2><span className="tag">与我方待办分开</span></div><p className="muted small">标记已收到或已处理，只表示由你记录；不会替客户确认预算或承诺。</p>{!visibleItems.length && !loading && <p className="empty-text">这里还没有等待客户或待确认内容。</p>}{(visibleItems as FollowUpItem[]).map(followUpRow)}</section>}
    {view === 'history' && <section className="records-panel"><div className="section-heading"><h2>变更记录</h2><button className="soft-btn" disabled={props.busy || !visibleItems.some(event => !event.revertedAt)} onClick={props.onUndo}><RotateCcw size={14}/>撤销最近变更</button></div><p className="muted small">核对后的变化保留修改前后值。撤销按最近一次变更进行，原文继续留在当前工作空间。</p>{!visibleItems.length && !loading && <p className="empty-text">尚无已确认变更。</p>}{visibleItems.map(event => <article className="history-row" key={event.id}><History size={16}/><div><strong>{event.revertedAt ? '已撤销' : '已核对'} · {eventMutations(event).length} 项变更</strong><p>{event.sourceText || '该变更的来源原文已删除或未附带原文。'}</p><time>{chinaTime(event.createdAt)}</time>{!event.revertedAt && <button className="text-btn" disabled={props.busy} onClick={() => props.onUndoEvent(event.id)}>撤销这次变更</button>}</div></article>)}</section>}
    {view === 'receipt' && (closure ? receiptData ? <ClosureReceipt closure={closure} {...receiptData} onProject={showProject} onContinue={start} onExport={props.onExport} onUndo={props.onUndoEvent}/> : <p className="receipt-loading" role="status">本次已经保存，正在读取这次收尾记录…</p> : <p className="empty-text">选择一条最近沟通，可以查看当时的收尾记录。</p>)}
    {kind && cursor && <button className="soft-btn work-more" disabled={loading} onClick={() => void more()}>{loading ? '正在读取…' : '加载更早记录'}<ChevronDown size={14}/></button>}
    {loading && view !== 'home' && <p className="muted small" role="status">正在读取当前列表…</p>}
    <p className="work-runtime-boundary"><Clock3 size={12}/>提醒只在Looma开启时生效，退出后不提醒；重开可继续处理。</p>
  </div>;
}
