import React, { useEffect, useRef, useState } from 'react';
import type { CaptureDraft, ClosureRecord, ConditionIntent, Engagement, FollowUpItem, ProjectTaskItem } from '../types';
import { Repository } from '../persistence/repository';
import { canContinueProject, groupContinuation, loadContinuationPage, loadFieldEvidence, loadProjectContinuation } from '../services/projectContinuation';
import type { EvidenceTarget, FieldEvidence, ProjectContinuationData } from '../services/projectContinuation';

interface Props {
  projectId: string;
  revision: number;
  draft: CaptureDraft | null;
  busy: boolean;
  onContinueProject(projectId: string): void;
  onResumeDraft(): void;
  onEdit(project: Engagement): void;
  onClose(): void;
  onProjectLoaded?(project: Engagement): void;
  onOpenClosure(closure: ClosureRecord): void;
  renderTask(task: ProjectTaskItem): React.ReactNode;
  renderFollowUp(item: FollowUpItem): React.ReactNode;
  renderCondition?(item: ConditionIntent): React.ReactNode;
}
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const valueText = (field: string, value: unknown) => {
  if (value === undefined || value === null || value === '') return field === 'budgetAmount' ? '预算待定' : '尚未明确';
  if (field === 'budgetAmount') return `¥${Number(value).toLocaleString('zh-CN')}`;
  if (field === 'done') return value ? '已完成' : '未完成';
  if (field === 'status') {
    if (value === 'resolved') return '已处理';
    if (value === 'open') return '未处理';
    if (value === 'draft') return '待绑定（草稿）';
    if (value === 'watching') return '观察中';
    if (value === 'ready') return '已就绪';
    if (value === 'paused') return '已暂停';
    if (value === 'cancelled') return '已取消';
    if (value === 'completed') return '已完成';
    return '未处理';
  }
  return String(value);
};

export function ProjectContinuation(props: Props) {
  const [identity, setIdentity] = useState(() => Repository.getReadIdentity());
  const [retry, setRetry] = useState(0);
  const viewKey = `${props.projectId}:${identity.split(':')[0]}:${retry}`;
  const key = `${props.projectId}:${identity}:${props.revision}:${retry}`;
  const liveViewKey = useRef(viewKey); liveViewKey.current = viewKey;
  const loadedViewKey = useRef(viewKey);
  const liveKey = useRef(key); liveKey.current = key;
  const [state, setState] = useState<{ viewKey: string; key: string; data?: ProjectContinuationData; error?: string } | null>(null);
  const [pageBusy, setPageBusy] = useState('');
  const [pageError, setPageError] = useState('');
  const [source, setSource] = useState<{ viewKey: string; key: string; target: EvidenceTarget; result?: FieldEvidence; error?: string; loading: boolean } | null>(null);
  const sourceSequence = useRef(0);
  const sourceTrigger = useRef<HTMLButtonElement | null>(null);
  const sourcePanel = useRef<HTMLElement | null>(null);
  const data = state?.viewKey === viewKey ? state.data : null;
  const error = state?.viewKey === viewKey ? state.error : null;
  const visibleSource = source?.viewKey === viewKey ? source : null;

  useEffect(() => Repository.subscribe(() => setIdentity(Repository.getReadIdentity())), []);
  useEffect(() => {
    let active = true;
    setPageBusy(''); setPageError('');
    if (loadedViewKey.current !== viewKey) { loadedViewKey.current = viewKey; setSource(null); sourceSequence.current++; }
    void loadProjectContinuation(Repository, props.projectId).then(data => {
      if (active && liveKey.current === key && Repository.getReadIdentity() === identity) { setState({ viewKey, key, data }); props.onProjectLoaded?.(data.project); }
    }).catch(() => {
      if (active && liveKey.current === key) setState({ viewKey, key, error: '项目关联资料暂未读全，原数据仍保留。' });
    });
    return () => { active = false; if (liveViewKey.current !== viewKey) sourceSequence.current++; };
  }, [key]);
  useEffect(() => { if (visibleSource) sourcePanel.current?.focus(); }, [visibleSource?.target, visibleSource?.key]);

  async function more(section: 'tasks' | 'followUps' | 'conditions' | 'recent') {
    if (!data || pageBusy || !data[section]?.nextCursor) return;
    const requestKey = key;
    setPageBusy(section); setPageError('');
    try {
      const kind = section === 'tasks' ? 'task' : section === 'followUps' ? 'followup' : section === 'conditions' ? 'condition' : 'closure';
      const currentSection = data[section];
      if (!currentSection) return;
      const page = await loadContinuationPage(Repository, props.projectId, kind, currentSection.nextCursor);
      if (liveKey.current !== requestKey || Repository.getReadIdentity() !== identity) return;
      setState(previous => {
        if (previous?.key !== requestKey || !previous.data || !previous.data[section]) return previous;
        const items = [...new Map([...previous.data[section]!.items, ...page.items].map(item => [item.id, item])).values()];
        return { viewKey: previous.viewKey, key: requestKey, data: { ...previous.data, [section]: { ...page, items } } };
      });
    } catch { if (liveKey.current === requestKey) setPageError('后续记录暂未读到，可再次点击加载重试。'); }
    finally { if (liveKey.current === requestKey) setPageBusy(''); }
  }
  async function evidence(target: EvidenceTarget, trigger?: HTMLButtonElement, older = false) {
    const requestViewKey = viewKey, requestKey = key, sequence = ++sourceSequence.current;
    if (trigger) sourceTrigger.current = trigger;
    const previous = older ? visibleSource?.result : undefined;
    setSource({ viewKey: requestViewKey, key: requestKey, target, result: previous, loading: true });
    try {
      const result = await loadFieldEvidence(Repository, props.projectId, target, older ? previous?.nextCursor || undefined : undefined);
      if (liveViewKey.current !== requestViewKey || liveKey.current !== requestKey || Repository.getReadIdentity() !== identity || sourceSequence.current !== sequence) return;
      if (previous) result.entries = [...new Map([...previous.entries, ...result.entries].map(entry => [entry.closure.id, entry])).values()];
      setSource({ viewKey: requestViewKey, key: requestKey, target, result, loading: false });
    } catch {
      if (liveKey.current === requestKey && sourceSequence.current === sequence) setSource({ viewKey: requestViewKey, key: requestKey, target, result: previous, loading: false, error: '依据暂未读全，请重试。' });
    }
  }
  function closeSource() { sourceSequence.current++; setSource(null); sourceTrigger.current?.focus(); }
  function sourceButton(kind: EvidenceTarget['kind'], id: string, field: string, label: string) {
    return <button className="text-btn" aria-label={`查看${label}依据`} onClick={event => void evidence({ kind, id, field, label }, event.currentTarget)}>查看{label}依据</button>;
  }
  function moreButton(section: 'tasks' | 'followUps' | 'conditions' | 'recent', label: string) {
    return data?.[section]?.nextCursor ? <button className="soft-btn continuation-more" disabled={!!pageBusy} onClick={() => void more(section)}>{pageBusy === section ? '读取中…' : `还有更多，加载${label}`}</button> : null;
  }
  if (!data) return <section className="project-continuation" aria-label="项目接续"><button className="text-btn" onClick={props.onClose}>收起</button>{error ? <div role="alert"><p>{error}</p><button className="soft-btn" onClick={() => setRetry(value => value + 1)}>重试读取项目</button></div> : <p role="status">正在读取项目接续…</p>}</section>;

  const { project } = data;
  const groups = groupContinuation(data.tasks.items, data.followUps.items, data.conditions?.items || []);
  const canContinue = canContinueProject(props.draft, project.id);
  const task = (item: ProjectTaskItem) => <div className="continuation-item" key={item.id}>{props.renderTask(item)}<p className="continuation-meta">责任：{item.assignee || '尚未明确'} · 原日期表达：{item.sourceDeadlineText || item.deadline || '尚未明确'}</p><div className="continuation-evidence-actions">{sourceButton('task', item.id, 'title', '行动')}{sourceButton('task', item.id, 'assignee', '责任')}{sourceButton('task', item.id, item.sourceDeadlineText ? 'sourceDeadlineText' : 'deadline', '原日期')}{item.dueAt && sourceButton('task', item.id, 'dueAt', '提醒时间')}{item.done && sourceButton('task', item.id, 'done', '完成状态')}</div></div>;
  const followUp = (item: FollowUpItem) => <div className="continuation-item" key={item.id}>{props.renderFollowUp(item)}<div className="continuation-evidence-actions">{sourceButton('followup', item.id, 'title', '事项')}{item.expectedDate && sourceButton('followup', item.id, 'expectedDate', '预计日期')}{item.expectedAt && sourceButton('followup', item.id, 'expectedAt', '预计时间')}{item.reviewAt && sourceButton('followup', item.id, 'reviewAt', '回访时间')}{item.status === 'resolved' && sourceButton('followup', item.id, 'status', '处理状态')}</div></div>;
  const condition = (item: ConditionIntent) => <div className="continuation-item" key={item.id}>{props.renderCondition ? props.renderCondition(item) : <div><h4>当 {item.conditionText}</h4><p>则：{item.actionTitle} · 状态：{valueText('status', item.status)} · v{item.revision}</p></div>}<div className="continuation-evidence-actions">{sourceButton('condition', item.id, 'conditionText', '触发条件')}{sourceButton('condition', item.id, 'actionTitle', '下一步行动')}{sourceButton('condition', item.id, 'status', '条件状态')}</div></div>;
  return <section className="project-continuation" aria-label={`${project.clientName} · ${project.title}项目接续`}>
    <header className="section-heading continuation-heading"><div><p className="continuation-eyebrow">项目接续 · 本地事实</p><h2>{project.clientName} · {project.title}</h2></div><div className="button-row"><button className="text-btn" disabled={props.busy} onClick={() => props.onEdit(project)}>编辑项目</button><button className="soft-btn" onClick={props.onClose}>收起</button></div></header>
    <section className="continuation-overview" aria-label="当前项目概况"><h3>当前保存值</h3><p className="muted small">来自本机记录，不等于客户确认；历史原文在依据面板单独展示。</p>
      <dl className="continuation-facts"><div><dt>阶段</dt><dd>{project.stage}</dd>{sourceButton('engagement', project.id, 'stage', '阶段')}</div><div><dt>预算</dt><dd>{valueText('budgetAmount', project.budgetAmount)}</dd>{sourceButton('engagement', project.id, 'budgetAmount', '预算')}</div><div><dt>公开摘要</dt><dd>{project.shareableSummary || '尚未记录公开摘要'}</dd>{sourceButton('engagement', project.id, 'shareableSummary', '公开摘要')}</div></dl>
      <details className="continuation-private"><summary>内部备注（不进入公开摘要）</summary><p>{project.internalContext || '无内部备注'}</p></details>
      {canContinue ? <button className="primary-btn" disabled={props.busy} onClick={() => props.onContinueProject(project.id)}>继续记录此项目</button> : <div className="continuation-draft-notice" role="status"><p>已有其他归属或尚未归属的草稿，本次不会覆盖或更改它。</p><button className="soft-btn" disabled={props.busy} onClick={props.onResumeDraft}>继续现有草稿</button></div>}
    </section>
    {visibleSource && <section className="continuation-source" aria-label="字段依据" tabIndex={-1} ref={sourcePanel} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeSource(); } }}>
      <div className="section-heading"><h3>{visibleSource.target.label} · 依据</h3><button className="soft-btn" onClick={closeSource}>关闭依据</button></div>
      <p className="muted small">历史记录说明当时怎样核对，不证明它是当前值的唯一来源。手动修改或旧资料可能没有对应原文。</p>
      {visibleSource.result && <><p>当前保存值：<strong>{valueText(visibleSource.target.field, visibleSource.result.currentValue)}</strong></p>{!visibleSource.result.entries.length && <p>尚未找到对应依据。{visibleSource.result.nextCursor ? '还有更早记录可继续查找。' : '可能为手动录入、旧资料或来源关联不可用。'}</p>}
        {visibleSource.result.entries.map(entry => <article className="continuation-source-entry" key={entry.closure.id}><p><strong>{entry.reverted ? '已撤销的历史变更' : entry.matchesCurrent ? '历史记录中的相同值' : '历史值（与当前不同）'}</strong> · {time(entry.closure.confirmedAt)}</p><p>当时核对值：{valueText(visibleSource.target.field, entry.value)}</p><p className="muted small">来源记录：{entry.closure.sourceMessageId}{entry.sourceTime ? ` · ${time(entry.sourceTime)}` : ''}</p>{entry.original !== null ? <details><summary>查看当时原文</summary><p className="continuation-original">{entry.original}</p></details> : <p>来源原文已删除或不可用，不从事件副本恢复正文。</p>}<button className="text-btn" onClick={() => props.onOpenClosure(entry.closure)}>打开相关回执</button></article>)}
        {visibleSource.result.nextCursor && <button className="soft-btn" disabled={visibleSource.loading} onClick={() => void evidence(visibleSource.target, undefined, true)}>查找更早依据</button>}</>}
      {visibleSource.loading && <p role="status">正在读取依据…</p>}{visibleSource.error && <div role="alert"><p>{visibleSource.error}</p><button className="soft-btn" onClick={() => void evidence(visibleSource.target)}>重试读取依据</button></div>}
    </section>}
    {pageError && <p role="alert">{pageError}</p>}
    <div className="continuation-columns"><section aria-label="项目我方下一步"><h3>我方下一步</h3>{project.nextAction && <div className="continuation-item continuation-next-action"><h4>项目级下一步</h4><p>{project.nextAction}</p><p className="muted small">项目保存的安排，不自动创建独立行动或提醒。</p>{sourceButton('engagement', project.id, 'nextAction', '项目级下一步')}</div>}{groups.tasks.length ? groups.tasks.map(task) : <p className="home-empty">本页暂无独立的未完成行动</p>}{groups.completed.length > 0 && <details><summary>已完成行动（本次已加载 {groups.completed.length} 条）</summary>{groups.completed.map(task)}</details>}{moreButton('tasks', '行动')}</section>
      <section aria-label="项目等待客户"><h3>等待客户</h3>{groups.waiting.length ? groups.waiting.map(followUp) : <p className="home-empty">本页暂无等待客户事项</p>}</section>
      <section aria-label="项目仍待确认"><h3>仍待确认</h3>{groups.questions.length ? groups.questions.map(followUp) : <p className="home-empty">本页暂无未定问题</p>}</section></div>
    {groups.resolved.length > 0 && <details className="continuation-resolved"><summary>已处理的等待与未定（本次已加载 {groups.resolved.length} 条）</summary>{groups.resolved.map(followUp)}</details>}{moreButton('followUps', '等待与未定')}
    {(groups.readyConditions.length > 0 || groups.watchingConditions.length > 0 || groups.closedConditions.length > 0 || data.conditions?.nextCursor) && <section className="continuation-conditions" aria-label="项目条件跟进"><h3>条件跟进</h3>{groups.readyConditions.length > 0 && <div className="continuation-ready-conditions"><h4>条件已就绪，可推进</h4>{groups.readyConditions.map(condition)}</div>}{groups.watchingConditions.map(condition)}{groups.closedConditions.length > 0 && <details><summary>已暂停、取消或完成的条件（本次已加载 {groups.closedConditions.length} 条）</summary>{groups.closedConditions.map(condition)}</details>}{moreButton('conditions', '条件跟进')}</section>}
    <section className="continuation-history" aria-label="项目最近变化"><h3>最近变化</h3>{data.recent.items.length ? data.recent.items.map(record => <button className="recent-closure" key={record.id} onClick={() => props.onOpenClosure(record)}><span>{time(record.confirmedAt)} · {record.revertedAt ? '已撤销' : record.originalOnly ? '仅存原文，未确认业务结论' : '用户已核对'}<small>打开回执查看当时变更</small></span></button>) : <p className="home-empty">本页暂无沟通收尾记录；手动变更请查看工作台变更记录。</p>}{moreButton('recent', '最近变化')}</section>
  </section>;
}
