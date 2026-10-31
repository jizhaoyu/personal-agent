import React from 'react';
import { Check, X, AlertCircle, RotateCcw, ArrowRight, FileText } from 'lucide-react';
import type { ProposedChangeSet, Engagement, ProposalConflict, WorkOperation } from '../types';

const stages = ['初步接触', '需求确认', '方案报价', '商务谈判', '赢单成交'];
const localTime = (iso?: string) => iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16) : '';
const dateTime = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间待确认';
const fieldNames: Record<string, string> = { clientName: '客户', title: '项目', budgetAmount: '预算（元）', stage: '当前进展', nextAction: '下一步', shareableSummary: '可外发摘要', internalContext: '内部备注', done: '完成状态', dueAt: '我方提醒时间', assignee: '负责人', fact: '事实', status: '处理状态', expectedDate: '客户预计日期', expectedAt: '客户预计时间', reviewAt: '我方回访时间', kind: '事项归属', engagementId: '关联项目' };
const valueText = (value: unknown) => value === undefined || value === null || value === '' ? '尚未确认' : typeof value === 'boolean' ? value ? '已完成' : '待完成' : typeof value === 'object' ? JSON.stringify(value) : String(value);
interface Props {
  proposal: ProposedChangeSet;
  engagements: Engagement[];
  conflicts?: ProposalConflict[];
  onResolveConflict?(id: string, choice: 'current' | 'proposed'): void;
  onChange(p: ProposedChangeSet): void;
  onConfirm(): void;
  onDiscard(): void;
  onReparse(): void;
  busy?: boolean;
}
type GroupName = 'record' | 'self' | 'waiting' | 'question';
const groupNames: Record<GroupName, string> = { record: '本次核对内容', self: '我方下一步', waiting: '等待客户', question: '仍待确认' };
const groupOf = (operation: WorkOperation): GroupName => operation.target === 'task' ? 'self' : operation.target === 'followup' ? operation.after?.kind === 'waiting' || operation.before?.kind === 'waiting' ? 'waiting' : 'question' : 'record';

export function ProposalReview({ proposal, engagements, conflicts = [], onResolveConflict, onChange, onConfirm, onDiscard, onReparse, busy = false }: Props) {
  function edit(index: number, patch: Record<string, unknown>) {
    onChange({ ...proposal, operations: proposal.operations.map((operation, i) => i === index ? { ...operation, after: { ...operation.after, ...patch } } as WorkOperation : operation) });
  }
  const projects = [...new Map([...engagements, ...proposal.operations.filter(operation => operation.target === 'engagement' && operation.after).map(operation => operation.after as Engagement)].map(project => [project.id, project])).values()];
  const groups = new Map<string, { name: string; operations: { operation: WorkOperation; index: number }[] }>();
  proposal.operations.forEach((operation, index) => {
    const projectId = operation.target === 'engagement' ? operation.entityId : operation.target === 'task' || operation.target === 'followup' ? operation.after?.engagementId || operation.before?.engagementId || '' : '';
    const project = projects.find(item => item.id === projectId);
    const group = groups.get(projectId) || { name: project ? `${project.clientName} · ${project.title}` : '本次沟通', operations: [] };
    group.operations.push({ operation, index }); groups.set(projectId, group);
  });
  function projectSelect(index: number, selected = '') {
    return <label>关联项目<select aria-label={`关联项目 ${index + 1}`} value={selected} onChange={event => edit(index, { engagementId: event.target.value || undefined })}><option value="">暂不关联</option>{projects.map(project => <option key={project.id} value={project.id}>{project.clientName} · {project.title}</option>)}</select></label>;
  }
  function changes(operation: WorkOperation) {
    if (!operation.after) return <p className="review-delete">将移除该记录，请核对原有内容。</p>;
    const before: any = operation.before, after: any = operation.after;
    const fields = operation.target === 'engagement' ? ['clientName', 'title', 'budgetAmount', 'stage', 'nextAction', 'shareableSummary'] : operation.target === 'task' ? ['title', 'done', 'dueAt'] : operation.target === 'followup' ? ['title', 'status', 'expectedDate', 'expectedAt', 'reviewAt'] : ['fact'];
    const changed = fields.filter(field => JSON.stringify(before?.[field]) !== JSON.stringify(after[field]) && (before || ![undefined, '', false].includes(after[field])) && !(field === 'stage' && !before && after.stage === '初步接触') && !(field === 'status' && !before && after.status === 'open'));
    return <dl className="review-differences">{changed.map(field => <div key={field}><dt>{fieldNames[field] || field}</dt><dd>{before && <><span className="review-old">{valueText(before[field])}</span><ArrowRight size={12} aria-hidden="true"/></>}<strong>{field.endsWith('At') ? dateTime(after[field]) : valueText(after[field])}</strong></dd></div>)}</dl>;
  }
  function editor(operation: WorkOperation, index: number) {
    if (!operation.after) return null;
    if (operation.target === 'engagement') {
      const after = operation.after;
      const primaryBudget = !operation.before || after.budgetAmount !== operation.before.budgetAmount || proposal.sourceText === '核对项目预算';
      return <>
        {!operation.before && <div className="field-grid"><label>客户名称<input aria-label={`客户名称 ${index + 1}`} value={after.clientName} onChange={event => edit(index, { clientName: event.target.value })}/></label><label>合作项目<input aria-label={`合作项目 ${index + 1}`} value={after.title} onChange={event => edit(index, { title: event.target.value })}/></label></div>}
        {primaryBudget && <label className="review-budget-edit">预算（元；未定可留空）<input aria-label={`预算 ${index + 1}`} type="number" min="0" step="0.01" value={after.budgetAmount ?? ''} placeholder="尚未确认" onChange={event => edit(index, { budgetAmount: event.target.value === '' ? undefined : Number(event.target.value) })}/></label>}
        <details className="review-full-editor"><summary>查看与修改完整项目字段</summary>
          {operation.before && <div className="field-grid"><label>客户名称<input aria-label={`客户名称 ${index + 1}`} value={after.clientName} onChange={event => edit(index, { clientName: event.target.value })}/></label><label>合作项目<input aria-label={`合作项目 ${index + 1}`} value={after.title} onChange={event => edit(index, { title: event.target.value })}/></label></div>}
          <div className="field-grid">{!primaryBudget && <label>预算（元；可留空）<input aria-label={`预算 ${index + 1}`} type="number" min="0" step="0.01" value={after.budgetAmount ?? ''} onChange={event => edit(index, { budgetAmount: event.target.value === '' ? undefined : Number(event.target.value) })}/></label>}<label>项目阶段<select aria-label={`项目阶段 ${index + 1}`} value={after.stage} onChange={event => edit(index, { stage: event.target.value })}>{stages.map(stage => <option key={stage}>{stage}</option>)}</select></label></div>
          <label>下一步行动<input value={after.nextAction} onChange={event => edit(index, { nextAction: event.target.value })}/></label>
          <label>可外发摘要（仍需分享前审核）<textarea rows={2} value={after.shareableSummary} onChange={event => edit(index, { shareableSummary: event.target.value })}/></label>
          <details><summary>内部备注 · 不进入外发纪要</summary><textarea aria-label={`内部备注 ${index + 1}`} rows={2} value={after.internalContext} onChange={event => edit(index, { internalContext: event.target.value })}/></details>
        </details>
      </>;
    }
    if (operation.target === 'task') return <>
      <label>行动内容<input aria-label={`行动内容 ${index + 1}`} value={operation.after.title} onChange={event => edit(index, { title: event.target.value })}/></label>
      {operation.after.assignee && operation.after.assignee !== '我' && <p className="notice small">原有负责人：{operation.after.assignee}，请核对这是否属于你的行动。</p>}
      <label>我方提醒时间（北京时间，可留空）<input aria-label={`提醒时间 ${index + 1}`} type="datetime-local" value={localTime(operation.after.dueAt)} onChange={event => edit(index, { dueAt: event.target.value ? new Date(`${event.target.value}:00+08:00`).toISOString() : undefined })}/></label>
      <p className="muted small">原日期表达：{operation.after.sourceDeadlineText || operation.after.deadline || '未提供'}</p>
      <details className="review-full-editor"><summary>修改关联项目</summary>{projectSelect(index, operation.after.engagementId)}</details>
    </>;
    if (operation.target === 'followup') return <>
      <label>{operation.after.kind === 'waiting' ? '等待内容' : '待确认内容'}<input aria-label={`${operation.after.kind === 'waiting' ? '等待内容' : '待确认内容'} ${index + 1}`} value={operation.after.title} onChange={event => edit(index, { title: event.target.value })}/></label>
      {operation.after.expectedDate && <p className="review-date-note">客户预计 {operation.after.expectedDate}（日期，未约定具体时刻）</p>}
      {operation.after.expectedAt && <p className="review-date-note">客户预计 {dateTime(operation.after.expectedAt)}</p>}
      {operation.after.sourceDateText && <p className="muted small">原日期表达：{operation.after.sourceDateText}</p>}
      <details className="review-full-editor"><summary>设置我方回访时间或修改归属</summary>
        <p className="muted small">回访是你自己的安排，留空不会自动催促，也不代表客户承诺的截止时间。</p>
        <label>我方回访时间<input aria-label={`回访时间 ${index + 1}`} type="datetime-local" value={localTime(operation.after.reviewAt)} onChange={event => edit(index, { reviewAt: event.target.value ? new Date(`${event.target.value}:00+08:00`).toISOString() : undefined })}/></label>
        <label>内容类型<select aria-label={`内容类型 ${index + 1}`} value={operation.after.kind} onChange={event => edit(index, { kind: event.target.value })}><option value="waiting">等待客户</option><option value="question">仍待确认</option></select></label>
        {projectSelect(index, operation.after.engagementId)}
        {operation.after.kind === 'waiting' && <><label>客户预计日期（不补时刻）<input aria-label={`客户预计日期 ${index + 1}`} type="date" value={operation.after.expectedDate || ''} onChange={event => edit(index, { expectedDate: event.target.value || undefined, expectedAt: undefined })}/></label><label>客户已明确的具体时间（可留空）<input aria-label={`客户预计时间 ${index + 1}`} type="datetime-local" value={localTime(operation.after.expectedAt)} onChange={event => edit(index, { expectedAt: event.target.value ? new Date(`${event.target.value}:00+08:00`).toISOString() : undefined, expectedDate: undefined })}/></label></>}
      </details>
    </>;
    return <label>待记住的工作事实<textarea value={operation.after.fact} onChange={event => edit(index, { fact: event.target.value })}/></label>;
  }
  return <section className="proposal-box closure-review" aria-label="待确认变更">
    <div className="section-heading"><span className="status-dot amber"/><h3>核对这次沟通</h3><span className="tag">尚未写入业务记录</span></div>
    <p className="muted small">看看安排是否准确。确认表示你核对了记录，不表示客户已确认共识。</p>
    {proposal.warnings.length > 0 && <div className="notice"><AlertCircle size={14}/><div>{proposal.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
    {conflicts.length > 0 && <section className="review-conflicts" aria-label="需要重新核对的冲突"><h4>这段时间资料有更新，请选择要保留的值</h4>{conflicts.map(conflict => <article key={conflict.id}><strong>{fieldNames[conflict.field] || conflict.field}</strong><p>原来：{valueText(conflict.original)}</p><p>当前：{valueText(conflict.current)}</p><p>本次修改：{valueText(conflict.proposed)}</p><div className="button-row"><button className="soft-btn" onClick={() => onResolveConflict?.(conflict.id, 'current')}>保留当前值</button><button className="soft-btn" onClick={() => onResolveConflict?.(conflict.id, 'proposed')}>使用本次修改</button></div></article>)}</section>}
    {[...groups].map(([id, group]) => <div className="review-project-group" key={id}><h4>{group.name}</h4>{(['record', 'self', 'waiting', 'question'] as const).map(groupName => {
      const operations = group.operations.filter(item => groupOf(item.operation) === groupName);
      return <section className={`review-category review-category--${groupName}`} key={groupName} aria-label={groupNames[groupName]}><div className="review-category-heading"><h4>{groupNames[groupName]}</h4><span>{operations.length}</span></div>{operations.length ? operations.map(({ operation, index }) => <article className="operation-card" key={`${operation.target}-${operation.entityId}`}>
        <header><span className="eyebrow">{operation.before ? '修改记录' : '新增记录'}</span><button className="text-btn" onClick={() => onChange({ ...proposal, operations: proposal.operations.filter((_, i) => i !== index) })}>忽略此项</button></header>
        {changes(operation)}{editor(operation, index)}
      </article>) : <p className="review-category-empty">本次没有新增内容</p>}</section>;
    })}</div>)}
    {!proposal.operations.length && <p className="empty-text">尚无明确的业务变化。可以补充归属，或先仅保存原文，稍后继续。</p>}
    <details className="review-source"><summary><FileText size={14}/>本次原文依据</summary><p>{proposal.sourceText}</p></details>
    <footer className="button-row proposal-actions"><button className="primary-btn" onClick={onConfirm} disabled={busy || !!proposal.clarification || !proposal.operations.length || conflicts.length > 0}><Check size={15}/>确认并保存</button><button className="soft-btn" onClick={onReparse} disabled={busy}><RotateCcw size={14}/>重新核对当前资料</button><button className="text-btn" onClick={onDiscard}><X size={14}/>忽略整批</button></footer>
  </section>;
}
