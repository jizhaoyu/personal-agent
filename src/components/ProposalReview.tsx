import React from 'react';
import { Check, X, AlertCircle, RotateCcw, ArrowRight, FileText, ShieldCheck } from 'lucide-react';
import type { ProposedChangeSet, Engagement, ProposalConflict, WorkOperation, FollowUpItem } from '../types';

const stages = ['初步接触', '需求确认', '方案报价', '商务谈判', '赢单成交'];
const localTime = (iso?: string) => iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16) : '';
const dateTime = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间待确认';
const fieldNames: Record<string, string> = { clientName: '客户', title: '项目', budgetAmount: '预算（元）', stage: '当前进展', nextAction: '下一步', shareableSummary: '可外发摘要', internalContext: '内部备注', done: '完成状态', dueAt: '我方提醒时间', assignee: '负责人', fact: '事实', status: '处理状态', expectedDate: '客户预计日期', expectedAt: '客户预计时间', reviewAt: '我方回访时间', kind: '事项归属', engagementId: '关联项目', conditionText: '触发条件', actionTitle: '满足后下一步', conditionKind: '判断方式', followUpId: '绑定等待项' };
const conditionStatusText: Record<string, string> = { draft: '草稿（待明确条件）', watching: '观察中', ready: '已就绪（可推进）', paused: '已暂停', completed: '已完成', cancelled: '已取消' };
const conditionKindText: Record<string, string> = { followup_resolved: '等待客户事项收到后就绪', manual_confirm: '由我人工确认满足' };
const valueText = (value: unknown) => value === undefined || value === null || value === '' ? '尚未确认' : typeof value === 'boolean' ? value ? '已完成' : '待完成' : typeof value === 'object' ? JSON.stringify(value) : String(value);
interface Props {
  proposal: ProposedChangeSet;
  engagements: Engagement[];
  conflicts?: ProposalConflict[];
  projectBindingId?: string;
  onResolveConflict?(id: string, choice: 'current' | 'proposed'): void;
  onChange(p: ProposedChangeSet): void;
  onConfirm(): void;
  onDiscard(): void;
  onReparse(): void;
  busy?: boolean;
}
type GroupName = 'record' | 'self' | 'waiting' | 'condition' | 'question';
const groupNames: Record<GroupName, string> = { record: '本次核对内容', self: '我方下一步', waiting: '等待客户', condition: '条件跟进', question: '仍待确认' };
const groupOf = (operation: WorkOperation): GroupName => operation.target === 'task' ? 'self' : operation.target === 'condition' ? 'condition' : operation.target === 'followup' ? operation.after?.kind === 'waiting' || operation.before?.kind === 'waiting' ? 'waiting' : 'question' : 'record';
const countLabels = { engagement: '个项目', task: '条行动', followup: '条跟进事项', condition: '条条件跟进', memory: '条工作事实' } as const;
const operationVerb = (operation: WorkOperation) => !operation.after ? '移除' : operation.before ? '更新' : '新增';

export function ProposalReview({ proposal, engagements, conflicts = [], projectBindingId, onResolveConflict, onChange, onConfirm, onDiscard, onReparse, busy = false }: Props) {
  function edit(index: number, patch: Record<string, unknown>) {
    onChange({ ...proposal, operations: proposal.operations.map((operation, i) => i === index ? { ...operation, after: { ...operation.after, ...patch } } as WorkOperation : operation) });
  }
  const projects = [...new Map([...engagements, ...proposal.operations.filter(operation => operation.target === 'engagement' && operation.after).map(operation => operation.after as Engagement)].map(project => [project.id, project])).values()];
  const isolatedInternalNoteCount = engagements.filter(item => (item.internalContext || '').trim().length > 0).length;
  const groups = new Map<string, { name: string; operations: { operation: WorkOperation; index: number }[] }>();
  const counts = new Map<string, { verb: string; label: string; count: number }>();
  proposal.operations.forEach((operation, index) => {
    const verb = operationVerb(operation);
    const label = countLabels[operation.target];
    const key = `${verb}:${operation.target}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { verb, label, count: 1 });
    const projectId = operation.target === 'engagement' ? operation.entityId : operation.target === 'task' || operation.target === 'followup' || operation.target === 'condition' ? operation.after?.engagementId || operation.before?.engagementId || '' : '';
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
    const fields = operation.target === 'engagement' ? ['clientName', 'title', 'budgetAmount', 'stage', 'nextAction', 'shareableSummary'] : operation.target === 'task' ? ['title', 'done', 'dueAt'] : operation.target === 'followup' ? ['title', 'status', 'expectedDate', 'expectedAt', 'reviewAt'] : operation.target === 'condition' ? ['conditionText', 'actionTitle', 'status', 'conditionKind'] : ['fact'];
    const changed = fields.filter(field => JSON.stringify(before?.[field]) !== JSON.stringify(after[field]) && (before || ![undefined, '', false].includes(after[field])) && !(field === 'stage' && !before && after.stage === '初步接触') && !(field === 'status' && !before && after.status === 'open'));
    const display = (field: string, value: unknown) => operation.target === 'condition' && field === 'status' && typeof value === 'string' ? (conditionStatusText[value] || value) : operation.target === 'condition' && field === 'conditionKind' && typeof value === 'string' ? (conditionKindText[value] || value) : field.endsWith('At') && typeof value === 'string' && value ? dateTime(value) : valueText(value);
    return changed.length ? <dl className="review-differences">{changed.map(field => <div key={field} className={field === 'nextAction' ? 'review-difference-next' : undefined}><dt>{field === 'title' && operation.target !== 'engagement' ? '内容' : fieldNames[field] || field}</dt><dd>{before && <><span className="review-old">{display(field, before[field])}</span><ArrowRight size={12} aria-hidden="true"/></>}<strong>{display(field, after[field])}</strong></dd></div>)}</dl> : null;
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
      <label>我方提醒时间（北京时间，可留空）<input aria-label={`提醒时间 ${index + 1}`} type="datetime-local" value={localTime(operation.after.dueAt)} onChange={event => edit(index, { dueAt: event.target.value ? new Date(`${event.target.value}:00+08:00`).toISOString() : undefined })}/></label>
      <details className="review-full-editor"><summary>修改关联项目</summary>{projectSelect(index, operation.after.engagementId)}</details>
    </>;
    if (operation.target === 'followup') return <>
      <label>{operation.after.kind === 'waiting' ? '等待内容' : '待确认内容'}<input aria-label={`${operation.after.kind === 'waiting' ? '等待内容' : '待确认内容'} ${index + 1}`} value={operation.after.title} onChange={event => edit(index, { title: event.target.value })}/></label>
      <details className="review-full-editor"><summary>设置我方回访时间或修改归属</summary>
        <p className="muted small">回访是你自己的安排，留空不会自动催促，也不代表客户承诺的截止时间。</p>
        <label>我方回访时间<input aria-label={`回访时间 ${index + 1}`} type="datetime-local" value={localTime(operation.after.reviewAt)} onChange={event => edit(index, { reviewAt: event.target.value ? new Date(`${event.target.value}:00+08:00`).toISOString() : undefined })}/></label>
        <label>内容类型<select aria-label={`内容类型 ${index + 1}`} value={operation.after.kind} onChange={event => edit(index, { kind: event.target.value })}><option value="waiting">等待客户</option><option value="question">仍待确认</option></select></label>
        {projectSelect(index, operation.after.engagementId)}
        {operation.after.kind === 'waiting' && <><label>客户预计日期（不补时刻）<input aria-label={`客户预计日期 ${index + 1}`} type="date" value={operation.after.expectedDate || ''} onChange={event => edit(index, { expectedDate: event.target.value || undefined, expectedAt: undefined })}/></label><label>客户已明确的具体时间（可留空）<input aria-label={`客户预计时间 ${index + 1}`} type="datetime-local" value={localTime(operation.after.expectedAt)} onChange={event => edit(index, { expectedAt: event.target.value ? new Date(`${event.target.value}:00+08:00`).toISOString() : undefined, expectedDate: undefined })}/></label></>}
      </details>
    </>;
    if (operation.target === 'condition') {
      const projectWaitings = proposal.operations
        .filter((op): op is WorkOperation & { target: 'followup'; after: FollowUpItem } => op.target === 'followup' && op.after?.kind === 'waiting' && op.after.engagementId === operation.after?.engagementId)
        .map(op => op.after);
      return <>
        <label>触发条件<input aria-label={`触发条件 ${index + 1}`} value={operation.after.conditionText} onChange={event => edit(index, { conditionText: event.target.value })}/></label>
        <label>满足后下一步<input aria-label={`满足后下一步 ${index + 1}`} value={operation.after.actionTitle} onChange={event => edit(index, { actionTitle: event.target.value })}/></label>
        <details className="review-full-editor"><summary>修改判断方式与关联</summary>
          <label>判断方式<select aria-label={`判断方式 ${index + 1}`} value={operation.after.conditionKind} onChange={event => {
            const kind = event.target.value as 'followup_resolved' | 'manual_confirm';
            const fallbackFollowUp = operation.after?.followUpId || projectWaitings[0]?.id;
            edit(index, {
              conditionKind: kind,
              followUpId: kind === 'followup_resolved' ? fallbackFollowUp : undefined,
              status: kind === 'followup_resolved' && fallbackFollowUp ? 'watching' : operation.after?.status === 'watching' ? 'watching' : 'draft',
            });
          }}><option value="followup_resolved">等待客户事项收到后就绪</option><option value="manual_confirm">由我人工确认满足</option></select></label>
          {operation.after.conditionKind === 'followup_resolved' && projectWaitings.length > 0 && (
            <label>绑定等待事项<select aria-label={`绑定等待事项 ${index + 1}`} value={operation.after.followUpId || ''} onChange={event => edit(index, { followUpId: event.target.value || undefined, status: event.target.value ? 'watching' : 'draft' })}>
              {projectWaitings.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}
            </select></label>
          )}
          <label>状态<select aria-label={`条件状态 ${index + 1}`} value={operation.after.status} onChange={event => edit(index, { status: event.target.value })}><option value="watching">观察中</option><option value="draft">草稿（待明确条件）</option><option value="paused">已暂停</option><option value="ready">已就绪</option></select></label>
          {projectSelect(index, operation.after.engagementId)}
        </details>
      </>;
    }
    if (operation.target === 'memory') return <label>待记住的工作事实<textarea value={operation.after.fact} onChange={event => edit(index, { fact: event.target.value })}/></label>;
    return null;
  }
  return <section className="proposal-box closure-review" aria-label="待确认变更">
    <div className="section-heading"><h3>核对待办与项目更新</h3><span className="tag">尚未写入业务记录</span></div>
    {counts.size > 0 && <ul className="review-overview" aria-label="本次拟保存的变更">{[...counts].map(([key, item]) => <li key={key}>{item.verb} {item.count} {item.label}</li>)}</ul>}
    <p className="muted small">看看安排是否准确。确认表示你核对了记录，不表示客户已确认共识。</p>
    {(proposal.clarification || conflicts.length > 0) && <div className="review-blockers" role="status">
      {proposal.clarification && <p>{proposal.clarification.message}{projectBindingId && <> <a href={`#${projectBindingId}`}>选择关联项目</a></>}</p>}
      {conflicts.length > 0 && <p>请先解决 {conflicts.length} 处冲突，再保存。</p>}
    </div>}
    {proposal.warnings.length > 0 && <div className="notice"><AlertCircle size={14}/><div>{proposal.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
    {conflicts.length > 0 && <section className="review-conflicts" aria-label="需要重新核对的冲突"><h4>这段时间资料有更新，请选择要保留的值</h4>{conflicts.map(conflict => <article key={conflict.id}><strong>{fieldNames[conflict.field] || conflict.field}</strong><p>原来：{valueText(conflict.original)}</p><p>当前：{valueText(conflict.current)}</p><p>本次修改：{valueText(conflict.proposed)}</p><div className="button-row"><button className="soft-btn" onClick={() => onResolveConflict?.(conflict.id, 'current')}>保留当前值</button><button className="soft-btn" onClick={() => onResolveConflict?.(conflict.id, 'proposed')}>使用本次修改</button></div></article>)}</section>}
    {[...groups].map(([id, group]) => <div className="review-project-group" key={id}><h4>{group.name}</h4>{(['record', 'self', 'waiting', 'condition', 'question'] as const).map(groupName => {
      const operations = group.operations.filter(item => groupOf(item.operation) === groupName);
      if (!operations.length) return null;
      return <section className={`review-category review-category--${groupName}`} key={groupName} aria-label={groupNames[groupName]}><div className="review-category-heading"><h4>{groupNames[groupName]}</h4><span>{operations.length}</span></div>{operations.map(({ operation, index }) => {
        const item = operation.after || operation.before;
        const title = item && ('title' in item ? item.title : 'actionTitle' in item ? `当「${item.conditionText}」后：${item.actionTitle}` : item.fact);
        return <article className="operation-card" key={`${operation.target}-${operation.entityId}`}>
          <header><div><span className="eyebrow">{operationVerb(operation)}记录</span><p className="review-item-title">{title || '尚未填写内容'}</p></div><button className="text-btn" onClick={() => onChange({ ...proposal, operations: proposal.operations.filter((_, i) => i !== index) })}>忽略此项</button></header>
          {changes(operation)}
          {operation.target === 'task' && operation.after?.assignee && operation.after.assignee !== '我' && <p className="notice small">原有负责人：{operation.after.assignee}，请核对这是否属于你的行动。</p>}
          {operation.target === 'task' && (operation.after?.sourceDeadlineText || operation.after?.deadline) && <p className="muted small">原日期表达：{operation.after.sourceDeadlineText || operation.after.deadline}</p>}
          {operation.target === 'followup' && operation.after?.sourceDateText && <p className="muted small">原日期表达：{operation.after.sourceDateText}</p>}
          {operation.after && <details className="review-item-editor"><summary>{title ? '编辑此项' : '填写内容'}</summary>{editor(operation, index)}</details>}
        </article>;
      })}</section>;
    })}</div>)}
    {!proposal.operations.length && <p className="empty-text">尚无明确的业务变化。可以补充归属，或先仅保存原文，稍后继续。</p>}
    <details className="review-source"><summary><FileText size={14}/>本次原文依据</summary><p>{proposal.sourceText}</p></details>
    <details className="review-boundary"><summary><ShieldCheck size={14}/>最小范围与隔离边界核验</summary><p>本次核对仅读取工作空间当前关联项目的公开字段；已自动隔离保护 {isolatedInternalNoteCount} 个项目的内部备注及全部生活空间资料，未确认前不会改写业务记录。</p></details>
    <footer className="button-row proposal-actions"><button className="primary-btn" onClick={onConfirm} disabled={busy || !!proposal.clarification || !proposal.operations.length || conflicts.length > 0}><Check size={15}/>确认并保存</button><button className="text-btn" onClick={onDiscard}><X size={14}/>忽略整批</button><button className="text-btn" onClick={onReparse} disabled={busy}><RotateCcw size={14}/>重新核对当前资料</button></footer>
  </section>;
}
