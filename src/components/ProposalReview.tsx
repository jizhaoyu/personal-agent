import React from 'react';
import { Check, X, AlertCircle, RotateCcw, ArrowRight, FileText, ShieldCheck } from 'lucide-react';
import type { ProposedChangeSet, Engagement, ProposalConflict, WorkOperation, FollowUpItem } from '../types';
import { formatBudgetAmount, formatConditionKind, formatConditionStatus, formatDealStage, formatShanghaiTime, useI18n } from '../i18n';

const stages = ['初步接触', '需求确认', '方案报价', '商务谈判', '赢单成交'];
const localTime = (iso?: string) => iso && Number.isFinite(Date.parse(iso)) ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16) : '';
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
const groupOf = (operation: WorkOperation): GroupName => operation.target === 'task' ? 'self' : operation.target === 'condition' ? 'condition' : operation.target === 'followup' ? operation.after?.kind === 'waiting' || operation.before?.kind === 'waiting' ? 'waiting' : 'question' : 'record';

export function ProposalReview({ proposal, engagements, conflicts = [], projectBindingId, onResolveConflict, onChange, onConfirm, onDiscard, onReparse, busy = false }: Props) {
  const { lang, t } = useI18n();
  const fieldNames: Record<string, string> = {
    clientName: t('proposal.fieldClientName'),
    title: t('proposal.fieldTitle'),
    budgetAmount: t('proposal.fieldBudgetAmount'),
    stage: t('proposal.fieldStage'),
    nextAction: t('proposal.fieldNextAction'),
    shareableSummary: t('proposal.fieldShareableSummary'),
    internalContext: t('proposal.fieldInternalContext'),
    done: t('proposal.fieldDone'),
    dueAt: t('proposal.fieldDueAt'),
    assignee: t('proposal.fieldAssignee'),
    fact: t('proposal.fieldFact'),
    status: t('proposal.fieldStatus'),
    expectedDate: t('proposal.fieldExpectedDate'),
    expectedAt: t('proposal.fieldExpectedAt'),
    reviewAt: t('proposal.fieldReviewAt'),
    kind: t('proposal.fieldKind'),
    engagementId: t('proposal.fieldEngagementId'),
    conditionText: t('proposal.fieldConditionText'),
    actionTitle: t('proposal.fieldActionTitle'),
    conditionKind: t('proposal.fieldConditionKind'),
    followUpId: t('proposal.fieldFollowUpId'),
  };
  const groupNames: Record<GroupName, string> = {
    record: t('proposal.groupRecord'),
    self: t('proposal.groupSelf'),
    waiting: t('proposal.groupWaiting'),
    condition: t('proposal.groupCondition'),
    question: t('proposal.groupQuestion'),
  };
  const countLabels = {
    engagement: t('proposal.countEngagement'),
    task: t('proposal.countTask'),
    followup: t('proposal.countFollowup'),
    condition: t('proposal.countCondition'),
    memory: t('proposal.countMemory'),
  } as const;
  const dateTime = (value?: string) => value && Number.isFinite(Date.parse(value)) ? formatShanghaiTime(value, lang) : t('proposal.timeTbd');
  const valueText = (value: unknown) => value === undefined || value === null || value === ''
    ? t('proposal.valueUnconfirmed')
    : typeof value === 'boolean'
      ? (value ? t('proposal.valueDone') : t('proposal.valuePending'))
      : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const operationVerb = (operation: WorkOperation) => !operation.after ? t('proposal.verbRemove') : operation.before ? t('proposal.verbUpdate') : t('proposal.verbAdd');

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
    const group = groups.get(projectId) || { name: project ? `${project.clientName} · ${project.title}` : t('proposal.thisCommunication'), operations: [] };
    group.operations.push({ operation, index }); groups.set(projectId, group);
  });
  function projectSelect(index: number, selected = '') {
    return <label>{t('proposal.linkedProjectLabel')}<select aria-label={t('proposal.linkedProjectAria', { index: index + 1 })} value={selected} onChange={event => edit(index, { engagementId: event.target.value || undefined })}><option value="">{t('proposal.unlinkedOption')}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.clientName} · {project.title}</option>)}</select></label>;
  }
  function changes(operation: WorkOperation) {
    if (!operation.after) return <p className="review-delete">{t('proposal.deleteRecordHint')}</p>;
    const before: any = operation.before, after: any = operation.after;
    const fields = operation.target === 'engagement' ? ['clientName', 'title', 'budgetAmount', 'stage', 'nextAction', 'shareableSummary'] : operation.target === 'task' ? ['title', 'done', 'dueAt'] : operation.target === 'followup' ? ['title', 'status', 'expectedDate', 'expectedAt', 'reviewAt'] : operation.target === 'condition' ? ['conditionText', 'actionTitle', 'status', 'conditionKind'] : ['fact'];
    const changed = fields.filter(field => JSON.stringify(before?.[field]) !== JSON.stringify(after[field]) && (before || ![undefined, '', false].includes(after[field])) && !(field === 'stage' && !before && after.stage === '初步接触') && !(field === 'status' && !before && after.status === 'open'));
    const display = (field: string, value: unknown) =>
      operation.target === 'engagement' && field === 'stage' && typeof value === 'string'
        ? formatDealStage(value, lang)
        : operation.target === 'engagement' && field === 'budgetAmount' && typeof value === 'number'
          ? formatBudgetAmount(value, lang)
          : operation.target === 'condition' && field === 'status' && typeof value === 'string'
            ? formatConditionStatus(value, lang)
            : operation.target === 'condition' && field === 'conditionKind' && typeof value === 'string'
              ? formatConditionKind(value, lang)
              : field.endsWith('At') && typeof value === 'string' && value ? dateTime(value) : valueText(value);
    return changed.length ? <dl className="review-differences">{changed.map(field => <div key={field} className={field === 'nextAction' ? 'review-difference-next' : undefined}><dt>{field === 'title' && operation.target !== 'engagement' ? t('proposal.fieldContent') : fieldNames[field] || field}</dt><dd>{before && <><span className="review-old">{display(field, before[field])}</span><ArrowRight size={12} aria-hidden="true"/></>}<strong>{display(field, after[field])}</strong></dd></div>)}</dl> : null;
  }
  function editor(operation: WorkOperation, index: number) {
    if (!operation.after) return null;
    if (operation.target === 'engagement') {
      const after = operation.after;
      const primaryBudget = !operation.before || after.budgetAmount !== operation.before.budgetAmount || proposal.sourceText === '核对项目预算';
      return <>
        {!operation.before && <div className="field-grid"><label>{t('proposal.clientNameLabel')}<input aria-label={t('proposal.clientNameAria', { index: index + 1 })} value={after.clientName} onChange={event => edit(index, { clientName: event.target.value })}/></label><label>{t('proposal.projectTitleLabel')}<input aria-label={t('proposal.projectTitleAria', { index: index + 1 })} value={after.title} onChange={event => edit(index, { title: event.target.value })}/></label></div>}
        {primaryBudget && <label className="review-budget-edit">{t('proposal.budgetPrimaryLabel')}<input aria-label={t('proposal.budgetAria', { index: index + 1 })} type="number" min="0" step="0.01" value={after.budgetAmount ?? ''} placeholder={t('proposal.valueUnconfirmed')} onChange={event => edit(index, { budgetAmount: event.target.value === '' ? undefined : Number(event.target.value) })}/></label>}
        <details className="review-full-editor"><summary>{t('proposal.viewEditFullProject')}</summary>
          {operation.before && <div className="field-grid"><label>{t('proposal.clientNameLabel')}<input aria-label={t('proposal.clientNameAria', { index: index + 1 })} value={after.clientName} onChange={event => edit(index, { clientName: event.target.value })}/></label><label>{t('proposal.projectTitleLabel')}<input aria-label={t('proposal.projectTitleAria', { index: index + 1 })} value={after.title} onChange={event => edit(index, { title: event.target.value })}/></label></div>}
          <div className="field-grid">{!primaryBudget && <label>{t('proposal.budgetSecondaryLabel')}<input aria-label={t('proposal.budgetAria', { index: index + 1 })} type="number" min="0" step="0.01" value={after.budgetAmount ?? ''} onChange={event => edit(index, { budgetAmount: event.target.value === '' ? undefined : Number(event.target.value) })}/></label>}<label>{t('proposal.projectStageLabel')}<select aria-label={t('proposal.projectStageAria', { index: index + 1 })} value={after.stage} onChange={event => edit(index, { stage: event.target.value })}>{stages.map(stage => <option key={stage} value={stage}>{formatDealStage(stage, lang)}</option>)}</select></label></div>
          <label>{t('proposal.nextActionLabel')}<input value={after.nextAction} onChange={event => edit(index, { nextAction: event.target.value })}/></label>
          <label>{t('proposal.shareableSummaryLabel')}<textarea rows={2} value={after.shareableSummary} onChange={event => edit(index, { shareableSummary: event.target.value })}/></label>
          <details><summary>{t('proposal.internalContextSummary')}</summary><textarea aria-label={t('proposal.internalContextAria', { index: index + 1 })} rows={2} value={after.internalContext} onChange={event => edit(index, { internalContext: event.target.value })}/></details>
        </details>
      </>;
    }
    if (operation.target === 'task') return <>
      <label>{t('proposal.actionTitleLabel')}<input aria-label={t('proposal.actionTitleAria', { index: index + 1 })} value={operation.after.title} onChange={event => edit(index, { title: event.target.value })}/></label>
      <label>{t('proposal.dueAtLabel')}<input aria-label={t('proposal.dueAtAria', { index: index + 1 })} type="datetime-local" value={localTime(operation.after.dueAt)} onChange={event => edit(index, { dueAt: event.target.value ? new Date(`${event.target.value}:00+08:00`).toISOString() : undefined })}/></label>
      <details className="review-full-editor"><summary>{t('proposal.editLinkedProject')}</summary>{projectSelect(index, operation.after.engagementId)}</details>
    </>;
    if (operation.target === 'followup') return <>
      <label>{operation.after.kind === 'waiting' ? t('proposal.waitingContentLabel') : t('proposal.questionContentLabel')}<input aria-label={`${operation.after.kind === 'waiting' ? t('proposal.waitingContentLabel') : t('proposal.questionContentLabel')} ${index + 1}`} value={operation.after.title} onChange={event => edit(index, { title: event.target.value })}/></label>
      <details className="review-full-editor"><summary>{t('proposal.followUpDetailsSummary')}</summary>
        <p className="muted small">{t('proposal.followUpReviewHint')}</p>
        <label>{t('proposal.reviewAtLabel')}<input aria-label={t('proposal.reviewAtAria', { index: index + 1 })} type="datetime-local" value={localTime(operation.after.reviewAt)} onChange={event => edit(index, { reviewAt: event.target.value ? new Date(`${event.target.value}:00+08:00`).toISOString() : undefined })}/></label>
        <label>{t('proposal.followUpKindLabel')}<select aria-label={t('proposal.followUpKindAria', { index: index + 1 })} value={operation.after.kind} onChange={event => edit(index, { kind: event.target.value })}><option value="waiting">{t('proposal.groupWaiting')}</option><option value="question">{t('proposal.groupQuestion')}</option></select></label>
        {projectSelect(index, operation.after.engagementId)}
        {operation.after.kind === 'waiting' && <><label>{t('proposal.expectedDateLabel')}<input aria-label={t('proposal.expectedDateAria', { index: index + 1 })} type="date" value={operation.after.expectedDate || ''} onChange={event => edit(index, { expectedDate: event.target.value || undefined, expectedAt: undefined })}/></label><label>{t('proposal.expectedAtLabel')}<input aria-label={t('proposal.expectedAtAria', { index: index + 1 })} type="datetime-local" value={localTime(operation.after.expectedAt)} onChange={event => edit(index, { expectedAt: event.target.value ? new Date(`${event.target.value}:00+08:00`).toISOString() : undefined, expectedDate: undefined })}/></label></>}
      </details>
    </>;
    if (operation.target === 'condition') {
      const projectWaitings = proposal.operations
        .filter((op): op is WorkOperation & { target: 'followup'; after: FollowUpItem } => op.target === 'followup' && op.after?.kind === 'waiting' && op.after.engagementId === operation.after?.engagementId)
        .map(op => op.after);
      return <>
        <label>{t('proposal.fieldConditionText')}<input aria-label={`${t('proposal.fieldConditionText')} ${index + 1}`} value={operation.after.conditionText} onChange={event => edit(index, { conditionText: event.target.value })}/></label>
        <label>{t('proposal.fieldActionTitle')}<input aria-label={`${t('proposal.fieldActionTitle')} ${index + 1}`} value={operation.after.actionTitle} onChange={event => edit(index, { actionTitle: event.target.value })}/></label>
        <details className="review-full-editor"><summary>{t('proposal.editConditionSummary')}</summary>
          <label>{t('proposal.fieldConditionKind')}<select aria-label={t('proposal.conditionKindAria', { index: index + 1 })} value={operation.after.conditionKind} onChange={event => {
            const kind = event.target.value as 'followup_resolved' | 'manual_confirm';
            const fallbackFollowUp = operation.after?.followUpId || projectWaitings[0]?.id;
            edit(index, {
              conditionKind: kind,
              followUpId: kind === 'followup_resolved' ? fallbackFollowUp : undefined,
              status: kind === 'followup_resolved' && fallbackFollowUp ? 'watching' : operation.after?.status === 'watching' ? 'watching' : 'draft',
            });
          }}><option value="followup_resolved">{formatConditionKind('followup_resolved', lang)}</option><option value="manual_confirm">{formatConditionKind('manual_confirm', lang)}</option></select></label>
          {operation.after.conditionKind === 'followup_resolved' && projectWaitings.length > 0 && (
            <label>{t('proposal.bindFollowUpLabel')}<select aria-label={t('proposal.bindFollowUpAria', { index: index + 1 })} value={operation.after.followUpId || ''} onChange={event => edit(index, { followUpId: event.target.value || undefined, status: event.target.value ? 'watching' : 'draft' })}>
              {projectWaitings.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}
            </select></label>
          )}
          <label>{t('proposal.statusLabel')}<select aria-label={t('proposal.conditionStatusAria', { index: index + 1 })} value={operation.after.status} onChange={event => edit(index, { status: event.target.value })}><option value="watching">{formatConditionStatus('watching', lang)}</option><option value="draft">{formatConditionStatus('draft', lang)}</option><option value="paused">{formatConditionStatus('paused', lang)}</option><option value="ready">{formatConditionStatus('ready', lang)}</option></select></label>
          {projectSelect(index, operation.after.engagementId)}
        </details>
      </>;
    }
    if (operation.target === 'memory') return <label>{t('proposal.memoryFactLabel')}<textarea value={operation.after.fact} onChange={event => edit(index, { fact: event.target.value })}/></label>;
    return null;
  }
  return <section className="proposal-box closure-review" aria-label={t('proposal.reviewBoxAria')}>
    <div className="section-heading"><h3>{t('proposal.reviewHeading')}</h3><span className="tag">{t('proposal.notWrittenTag')}</span></div>
    {counts.size > 0 && <ul className="review-overview" aria-label={t('proposal.overviewAria')}>{[...counts].map(([key, item]) => <li key={key}>{item.verb} {item.count} {item.label}</li>)}</ul>}
    <p className="muted small">{t('proposal.reviewBoundaryHint')}</p>
    {(proposal.clarification || conflicts.length > 0) && <div className="review-blockers" role="status">
      {proposal.clarification && <p>{proposal.clarification.message}{projectBindingId && <> <a href={`#${projectBindingId}`}>{t('proposal.chooseLinkedProjectLink')}</a></>}</p>}
      {conflicts.length > 0 && <p>{t('proposal.resolveConflictsHint', { count: conflicts.length })}</p>}
    </div>}
    {proposal.warnings.length > 0 && <div className="notice"><AlertCircle size={14}/><div>{proposal.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
    {conflicts.length > 0 && <section className="review-conflicts" aria-label={t('proposal.conflictsAria')}><h4>{t('proposal.conflictsHeading')}</h4>{conflicts.map(conflict => <article key={conflict.id}><strong>{fieldNames[conflict.field] || conflict.field}</strong><p>{t('proposal.conflictOriginal')}{valueText(conflict.original)}</p><p>{t('proposal.conflictCurrent')}{valueText(conflict.current)}</p><p>{t('proposal.conflictProposed')}{valueText(conflict.proposed)}</p><div className="button-row"><button className="soft-btn" onClick={() => onResolveConflict?.(conflict.id, 'current')}>{t('proposal.keepCurrentBtn')}</button><button className="soft-btn" onClick={() => onResolveConflict?.(conflict.id, 'proposed')}>{t('proposal.useProposedBtn')}</button></div></article>)}</section>}
    {[...groups].map(([id, group]) => <div className="review-project-group" key={id}><h4>{group.name}</h4>{(['record', 'self', 'waiting', 'condition', 'question'] as const).map(groupName => {
      const operations = group.operations.filter(item => groupOf(item.operation) === groupName);
      if (!operations.length) return null;
      return <section className={`review-category review-category--${groupName}`} key={groupName} aria-label={groupNames[groupName]}><div className="review-category-heading"><h4>{groupNames[groupName]}</h4><span>{operations.length}</span></div>{operations.map(({ operation, index }) => {
        const item = operation.after || operation.before;
        const title = item && ('title' in item ? item.title : 'actionTitle' in item ? `${t('proposal.conditionTitlePrefix')}${item.conditionText}${t('proposal.conditionTitleMid')}${item.actionTitle}` : item.fact);
        return <article className="operation-card" key={`${operation.target}-${operation.entityId}`}>
          <header><div><span className="eyebrow">{operationVerb(operation)}{t('proposal.recordEyebrowSuffix')}</span><p className="review-item-title">{title || t('proposal.unfilledTitle')}</p></div><button className="text-btn" onClick={() => onChange({ ...proposal, operations: proposal.operations.filter((_, i) => i !== index) })}>{t('proposal.ignoreItemBtn')}</button></header>
          {changes(operation)}
          {operation.target === 'task' && operation.after?.assignee && operation.after.assignee !== '我' && <p className="notice small">{t('proposal.originalAssigneeNotice', { name: operation.after.assignee })}</p>}
          {operation.target === 'task' && (operation.after?.sourceDeadlineText || operation.after?.deadline) && <p className="muted small">{t('proposal.sourceDateExprPrefix')}{operation.after.sourceDeadlineText || operation.after.deadline}</p>}
          {operation.target === 'followup' && operation.after?.sourceDateText && <p className="muted small">{t('proposal.sourceDateExprPrefix')}{operation.after.sourceDateText}</p>}
          {operation.after && <details className="review-item-editor"><summary>{title ? t('proposal.editThisItem') : t('proposal.fillContent')}</summary>{editor(operation, index)}</details>}
        </article>;
      })}</section>;
    })}</div>)}
    {!proposal.operations.length && <p className="empty-text">{t('proposal.noChangesEmpty')}</p>}
    <details className="review-source"><summary><FileText size={14}/>{t('proposal.sourceSectionSummary')}</summary><p>{proposal.sourceText}</p></details>
    <details className="review-boundary"><summary><ShieldCheck size={14}/>{t('proposal.isolationSummary')}</summary><p>{t('proposal.isolationBody', { count: isolatedInternalNoteCount })}</p></details>
    <footer className="button-row proposal-actions"><button className="primary-btn" onClick={onConfirm} disabled={busy || !!proposal.clarification || !proposal.operations.length || conflicts.length > 0}><Check size={15}/>{t('proposal.confirmAndSaveBtn')}</button><button className="text-btn" onClick={onDiscard}><X size={14}/>{t('proposal.discardAllBtn')}</button><button className="text-btn" onClick={onReparse} disabled={busy}><RotateCcw size={14}/>{t('proposal.reparseCurrentBtn')}</button></footer>
  </section>;
}
