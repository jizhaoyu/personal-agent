import React, { useEffect, useRef, useState } from 'react';
import type { ArtifactDraft, ArtifactType, CaptureDraft, ClosureRecord, ConditionIntent, Engagement, FollowUpItem, ProjectTaskItem } from '../types';
import { Repository } from '../persistence/repository';
import { canContinueProject, groupContinuation, loadContinuationPage, loadFieldEvidence, loadProjectContinuation } from '../services/projectContinuation';
import type { EvidenceTarget, FieldEvidence, ProjectContinuationData } from '../services/projectContinuation';
import {
  applyArtifactRebuild,
  buildArtifactDraft,
  confirmArtifactReady,
  inspectArtifactStaleness,
} from '../services/artifacts';
import {
  formatArtifactStatus,
  formatArtifactType,
  formatBudgetAmount,
  formatConditionStatus,
  formatDealStage,
  formatShanghaiTime,
  useI18n,
} from '../i18n';

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
  workSuggestionsEnabled?: boolean;
  initialArtifactCondition?: { projectId: string; conditionId: string; requestId: string } | null;
  onConsumeArtifactRequest?(): void;
  renderTask(task: ProjectTaskItem): React.ReactNode;
  renderFollowUp(item: FollowUpItem): React.ReactNode;
  renderCondition?(item: ConditionIntent): React.ReactNode;
}
export function ProjectContinuation(props: Props) {
  const { lang, t } = useI18n();
  const time = (value: number) => formatShanghaiTime(value, lang);
  const valueText = (field: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return field === 'budgetAmount' ? t('continuation.budgetTbd') : t('continuation.unsetValue');
    if (field === 'budgetAmount') return formatBudgetAmount(Number(value), lang);
    if (field === 'stage' && typeof value === 'string') return formatDealStage(value, lang);
    if (field === 'done') return value ? t('continuation.doneTrue') : t('continuation.doneFalse');
    if (field === 'status') {
      if (value === 'resolved') return t('continuation.statusResolved');
      if (value === 'open') return t('continuation.statusOpen');
      return formatConditionStatus(String(value), lang);
    }
    return String(value);
  };
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
  const [composer, setComposer] = useState<{ viewKey: string; draft: ArtifactDraft; isNew: boolean; dirty: boolean; reviewChecked: boolean } | null>(null);
  const [artifactBusy, setArtifactBusy] = useState(false);
  const [artifactError, setArtifactError] = useState('');
  const [readyChecks, setReadyChecks] = useState<Record<string, boolean>>({});
  const [copyNotice, setCopyNotice] = useState<Record<string, string>>({});
  const handledArtifactRequest = useRef('');
  const data = state?.viewKey === viewKey ? state.data : null;
  const error = state?.viewKey === viewKey ? state.error : null;
  const visibleSource = source?.viewKey === viewKey ? source : null;
  const visibleComposer = composer?.viewKey === viewKey ? composer : null;

  useEffect(() => Repository.subscribe(() => setIdentity(Repository.getReadIdentity())), []);
  useEffect(() => {
    let active = true;
    setPageBusy(''); setPageError('');
    if (loadedViewKey.current !== viewKey) { loadedViewKey.current = viewKey; setSource(null); sourceSequence.current++; }
    void loadProjectContinuation(Repository, props.projectId).then(data => {
      if (active && liveKey.current === key && Repository.getReadIdentity() === identity) { setState({ viewKey, key, data }); props.onProjectLoaded?.(data.project); }
    }).catch(() => {
      if (active && liveKey.current === key) setState({ viewKey, key, error: t('continuation.readIncomplete') });
    });
    return () => { active = false; if (liveViewKey.current !== viewKey) sourceSequence.current++; };
  }, [key]);
  useEffect(() => { if (visibleSource) sourcePanel.current?.focus(); }, [visibleSource?.target, visibleSource?.key]);
  useEffect(() => {
    if (!data || !props.initialArtifactCondition) return;
    const req = props.initialArtifactCondition;
    if (req.projectId !== data.project.id || handledArtifactRequest.current === req.requestId) return;
    handledArtifactRequest.current = req.requestId;
    const bound = data.conditions?.items.find(item => item.id === req.conditionId);
    openComposer(undefined, bound, data);
    props.onConsumeArtifactRequest?.();
  }, [data, props.initialArtifactCondition?.requestId]);

  function openComposer(existing?: ArtifactDraft, boundCondition?: ConditionIntent, targetData = data) {
    if (!targetData) return;
    setArtifactError('');
    if (existing) {
      setComposer({ viewKey, draft: { ...existing }, isNew: false, dirty: true, reviewChecked: existing.status === 'ready' });
      return;
    }
    const generated = buildArtifactDraft({
      type: 'proposal_brief',
      project: targetData.project,
      tasks: targetData.tasks.items,
      followUps: targetData.followUps.items,
      conditions: targetData.conditions?.items || [],
      condition: boundCondition,
      lang,
    });
    setComposer({ viewKey, draft: generated, isNew: true, dirty: false, reviewChecked: false });
  }
  function switchComposerType(type: ArtifactType) {
    if (!visibleComposer || !data) return;
    if (visibleComposer.isNew && !visibleComposer.dirty) {
      const bound = visibleComposer.draft.conditionId ? data.conditions?.items.find(c => c.id === visibleComposer.draft.conditionId) : undefined;
      const fresh = buildArtifactDraft({ type, project: data.project, tasks: data.tasks.items, followUps: data.followUps.items, conditions: data.conditions?.items || [], condition: bound, lang });
      setComposer({ ...visibleComposer, draft: fresh });
      return;
    }
    setComposer({ ...visibleComposer, draft: { ...visibleComposer.draft, type } });
  }
  function mergeArtifactState(saved: ArtifactDraft) {
    setState(prev => {
      if (!prev?.data || prev.viewKey !== viewKey) return prev;
      const prevItems = prev.data.artifacts?.items || [];
      const items = [saved, ...prevItems.filter(item => item.id !== saved.id)];
      return { ...prev, data: { ...prev.data, artifacts: { items, nextCursor: prev.data.artifacts?.nextCursor || null } } };
    });
  }
  async function saveComposer(asReady: boolean) {
    if (!visibleComposer || artifactBusy) return;
    setArtifactBusy(true); setArtifactError('');
    try {
      const candidate = asReady ? confirmArtifactReady(visibleComposer.draft) : { ...visibleComposer.draft, updatedAt: Date.now() };
      if (!asReady) delete candidate.reviewReason;
      const res = await Repository.saveArtifactDraft(candidate);
      if (res?.ok === false) throw new Error(res.error || t('continuation.draftSaveFailed'));
      mergeArtifactState(candidate);
      setComposer(null);
    } catch (err) {
      setArtifactError(err instanceof Error ? err.message : t('continuation.draftSaveErrorKeep'));
    } finally { setArtifactBusy(false); }
  }
  async function rebuildArtifact(art: ArtifactDraft, mode: 'rebuild' | 'keep_content') {
    if (!data || artifactBusy) return;
    setArtifactBusy(true); setArtifactError('');
    try {
      const bound = art.conditionId ? data.conditions?.items.find(c => c.id === art.conditionId) : undefined;
      const next = applyArtifactRebuild(art, { project: data.project, tasks: data.tasks.items, followUps: data.followUps.items, conditions: data.conditions?.items || [], condition: bound }, mode, Date.now(), lang);
      const res = await Repository.saveArtifactDraft(next);
      if (res?.ok === false) throw new Error(res.error || t('continuation.updateDraftFailed'));
      mergeArtifactState(next);
      setReadyChecks(prev => ({ ...prev, [art.id]: false }));
    } catch (err) {
      setArtifactError(err instanceof Error ? err.message : t('continuation.updateDraftRetry'));
    } finally { setArtifactBusy(false); }
  }
  async function markArtifactReady(art: ArtifactDraft) {
    if (artifactBusy) return;
    setArtifactBusy(true); setArtifactError('');
    try {
      const next = confirmArtifactReady(art);
      const res = await Repository.saveArtifactDraft(next);
      if (res?.ok === false) throw new Error(res.error || t('continuation.updateStatusFailed'));
      mergeArtifactState(next);
    } catch (err) {
      setArtifactError(err instanceof Error ? err.message : t('continuation.updateStatusRetry'));
    } finally { setArtifactBusy(false); }
  }
  async function deleteArtifact(id: string) {
    if (artifactBusy) return;
    setArtifactBusy(true); setArtifactError('');
    try {
      const res = await Repository.deleteArtifactDraft(id);
      if (res?.ok === false) throw new Error(res.error || t('continuation.deleteFailed'));
      setState(prev => {
        if (!prev?.data || prev.viewKey !== viewKey) return prev;
        const items = (prev.data.artifacts?.items || []).filter(item => item.id !== id);
        return { ...prev, data: { ...prev.data, artifacts: { items, nextCursor: prev.data.artifacts?.nextCursor || null } } };
      });
      if (visibleComposer?.draft.id === id) setComposer(null);
    } catch (err) {
      setArtifactError(err instanceof Error ? err.message : t('continuation.deleteRetry'));
    } finally { setArtifactBusy(false); }
  }
  async function copyArtifact(art: ArtifactDraft) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(`${art.title}\n\n${art.content}`);
        setCopyNotice(prev => ({ ...prev, [art.id]: t('continuation.copiedArtifact') }));
      } else {
        setCopyNotice(prev => ({ ...prev, [art.id]: t('continuation.clipboardUnsupported') }));
      }
    } catch {
      setCopyNotice(prev => ({ ...prev, [art.id]: t('continuation.copyFailed') }));
    }
  }

  async function more(section: 'tasks' | 'followUps' | 'conditions' | 'artifacts' | 'recent') {
    if (!data || pageBusy || !data[section]?.nextCursor) return;
    const requestKey = key;
    setPageBusy(section); setPageError('');
    try {
      const kind = section === 'tasks' ? 'task' : section === 'followUps' ? 'followup' : section === 'conditions' ? 'condition' : section === 'artifacts' ? 'artifact' : 'closure';
      const currentSection = data[section];
      if (!currentSection) return;
      const page = await loadContinuationPage(Repository, props.projectId, kind, currentSection.nextCursor);
      if (liveKey.current !== requestKey || Repository.getReadIdentity() !== identity) return;
      setState(previous => {
        if (previous?.key !== requestKey || !previous.data || !previous.data[section]) return previous;
        const items = [...new Map([...previous.data[section]!.items, ...page.items].map(item => [item.id, item])).values()];
        return { viewKey: previous.viewKey, key: requestKey, data: { ...previous.data, [section]: { ...page, items } } };
      });
    } catch { if (liveKey.current === requestKey) setPageError(t('continuation.loadMoreFailed')); }
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
      if (liveKey.current === requestKey && sourceSequence.current === sequence) setSource({ viewKey: requestViewKey, key: requestKey, target, result: previous, loading: false, error: t('continuation.evidenceFailed') });
    }
  }
  function closeSource() { sourceSequence.current++; setSource(null); sourceTrigger.current?.focus(); }
  function sourceButton(kind: EvidenceTarget['kind'], id: string, field: string, label: string) {
    return <button className="text-btn" aria-label={t('continuation.viewEvidenceAria', { label })} onClick={event => void evidence({ kind, id, field, label }, event.currentTarget)}>{t('continuation.viewEvidenceBtn', { label })}</button>;
  }
  function moreButton(section: 'tasks' | 'followUps' | 'conditions' | 'artifacts' | 'recent', label: string) {
    return data?.[section]?.nextCursor ? <button className="soft-btn continuation-more" disabled={!!pageBusy} onClick={() => void more(section)}>{pageBusy === section ? t('continuation.loadingText') : `${t('continuation.loadMorePrefix')}${label}`}</button> : null;
  }
  if (!data) return <section className="project-continuation" aria-label={t('continuation.ariaRootFallback')}><button className="text-btn" onClick={props.onClose}>{t('common.collapse')}</button>{error ? <div role="alert"><p>{error}</p><button className="soft-btn" onClick={() => setRetry(value => value + 1)}>{t('continuation.retryReadProject')}</button></div> : <p role="status">{t('continuation.loadingContinuation')}</p>}</section>;

  const { project } = data;
  const groups = groupContinuation(data.tasks.items, data.followUps.items, data.conditions?.items || []);
  const suggestionsEnabled = props.workSuggestionsEnabled !== false;
  const factualConditions = suggestionsEnabled ? groups.watchingConditions : [...groups.readyConditions, ...groups.watchingConditions];
  const canContinue = canContinueProject(props.draft, project.id);
  const task = (item: ProjectTaskItem) => <div className="continuation-item" key={item.id}>{props.renderTask(item)}<p className="continuation-meta">{t('continuation.metaAssignee')}{item.assignee || t('continuation.unsetValue')}{t('continuation.metaDateExpr')}{item.sourceDeadlineText || item.deadline || t('continuation.unsetValue')}</p><div className="continuation-evidence-actions">{sourceButton('task', item.id, 'title', t('continuation.evAction'))}{sourceButton('task', item.id, 'assignee', t('continuation.evAssignee'))}{sourceButton('task', item.id, item.sourceDeadlineText ? 'sourceDeadlineText' : 'deadline', t('continuation.evSourceDate'))}{item.dueAt && sourceButton('task', item.id, 'dueAt', t('continuation.evDueAt'))}{item.done && sourceButton('task', item.id, 'done', t('continuation.evDone'))}</div></div>;
  const followUp = (item: FollowUpItem) => <div className="continuation-item" key={item.id}>{props.renderFollowUp(item)}<div className="continuation-evidence-actions">{sourceButton('followup', item.id, 'title', t('continuation.evItem'))}{item.expectedDate && sourceButton('followup', item.id, 'expectedDate', t('continuation.evExpectedDate'))}{item.expectedAt && sourceButton('followup', item.id, 'expectedAt', t('continuation.evExpectedAt'))}{item.reviewAt && sourceButton('followup', item.id, 'reviewAt', t('continuation.evReviewAt'))}{item.status === 'resolved' && sourceButton('followup', item.id, 'status', t('continuation.evHandleStatus'))}</div></div>;
  const condition = (item: ConditionIntent) => <div className="continuation-item" key={item.id}>{props.renderCondition ? props.renderCondition(item) : <div><h4>{t('work.condTitlePrefix')}{item.conditionText}</h4><p>{t('closure.condThenPrefix')}{item.actionTitle}{t('continuation.condStatusPrefix')}{valueText('status', item.status)} · v{item.revision}</p></div>}<div className="continuation-evidence-actions">{sourceButton('condition', item.id, 'conditionText', t('continuation.evCondTrigger'))}{sourceButton('condition', item.id, 'actionTitle', t('continuation.evCondNext'))}{sourceButton('condition', item.id, 'status', t('continuation.evCondStatus'))}</div></div>;
  return <section className="project-continuation" aria-label={`${project.clientName} · ${project.title}${t('continuation.rootAriaSuffix')}`}>
    <header className="section-heading continuation-heading"><div><p className="continuation-eyebrow">{t('continuation.eyebrow')}</p><h2>{project.clientName} · {project.title}</h2></div><div className="button-row"><button className="text-btn" disabled={props.busy} onClick={() => props.onEdit(project)}>{t('continuation.editProjectBtn')}</button><button className="soft-btn" onClick={props.onClose}>{t('common.collapse')}</button></div></header>
    <section className="continuation-overview" aria-label={t('continuation.overviewAria')}><h3>{t('continuation.currentSavedTitle')}</h3><p className="muted small">{t('continuation.overviewNote')}</p>
      <dl className="continuation-facts"><div><dt>{t('continuation.stageLabel')}</dt><dd>{formatDealStage(project.stage, lang)}</dd>{sourceButton('engagement', project.id, 'stage', t('continuation.stageLabel'))}</div><div><dt>{t('continuation.budgetLabel')}</dt><dd>{valueText('budgetAmount', project.budgetAmount)}</dd>{sourceButton('engagement', project.id, 'budgetAmount', t('continuation.budgetLabel'))}</div><div><dt>{t('continuation.summaryLabel')}</dt><dd>{project.shareableSummary || t('continuation.noPublicSummary')}</dd>{sourceButton('engagement', project.id, 'shareableSummary', t('continuation.summaryLabel'))}</div></dl>
      <details className="continuation-private"><summary>{t('continuation.internalPrivateSummary')}</summary><p>{project.internalContext || t('continuation.noInternalNotes')}</p></details>
      {canContinue ? <button className="primary-btn" disabled={props.busy} onClick={() => props.onContinueProject(project.id)}>{t('continuation.continueThisProjectBtn')}</button> : <div className="continuation-draft-notice" role="status"><p>{t('continuation.otherDraftNotice')}</p><button className="soft-btn" disabled={props.busy} onClick={props.onResumeDraft}>{t('continuation.resumeDraftBtn')}</button></div>}
    </section>
    {visibleSource && <section className="continuation-source" aria-label={t('continuation.sourcePanelAria')} tabIndex={-1} ref={sourcePanel} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeSource(); } }}>
      <div className="section-heading"><h3>{visibleSource.target.label}{t('continuation.sourcePanelTitleSuffix')}</h3><button className="soft-btn" onClick={closeSource}>{t('continuation.closeSourceBtn')}</button></div>
      <p className="muted small">{t('continuation.sourceDisclaimer')}</p>
      {visibleSource.result && <><p>{t('continuation.currentValuePrefix')}<strong>{valueText(visibleSource.target.field, visibleSource.result.currentValue)}</strong></p>{!visibleSource.result.entries.length && <p>{t('continuation.noEvidenceFound')}{visibleSource.result.nextCursor ? t('continuation.moreHistoryAvailable') : t('continuation.maybeManualInput')}</p>}
        {visibleSource.result.entries.map(entry => <article className="continuation-source-entry" key={entry.closure.id}><p><strong>{entry.reverted ? t('continuation.entryReverted') : entry.matchesCurrent ? t('continuation.entryMatches') : t('continuation.entryChanged')}</strong> · {time(entry.closure.confirmedAt)}</p><p>{t('continuation.verifiedValuePrefix')}{valueText(visibleSource.target.field, entry.value)}</p><p className="muted small">{t('continuation.sourceRecordPrefix')}{entry.closure.sourceMessageId}{entry.sourceTime ? ` · ${time(entry.sourceTime)}` : ''}</p>{entry.original !== null ? <details><summary>{t('continuation.viewOriginalSummary')}</summary><p className="continuation-original">{entry.original}</p></details> : <p>{t('continuation.sourceUnavailable')}</p>}<button className="text-btn" onClick={() => props.onOpenClosure(entry.closure)}>{t('continuation.openClosureBtn')}</button></article>)}
        {visibleSource.result.nextCursor && <button className="soft-btn" disabled={visibleSource.loading} onClick={() => void evidence(visibleSource.target, undefined, true)}>{t('continuation.findOlderEvidenceBtn')}</button>}</>}
      {visibleSource.loading && <p role="status">{t('continuation.loadingEvidence')}</p>}{visibleSource.error && <div role="alert"><p>{visibleSource.error}</p><button className="soft-btn" onClick={() => void evidence(visibleSource.target)}>{t('continuation.retryEvidenceBtn')}</button></div>}
    </section>}
    {pageError && <p role="alert">{pageError}</p>}
    <div className="continuation-columns"><section aria-label={t('continuation.colSelfAria')}><h3>{t('continuation.colSelfHeading')}</h3>{project.nextAction && <div className="continuation-item continuation-next-action"><h4>{t('continuation.projectNextStepTitle')}</h4><p>{project.nextAction}</p><p className="muted small">{t('continuation.projectNextStepNote')}</p>{sourceButton('engagement', project.id, 'nextAction', t('continuation.projectNextStepTitle'))}</div>}{groups.tasks.length ? groups.tasks.map(task) : <p className="home-empty">{t('continuation.noOpenTasksOnPage')}</p>}{groups.completed.length > 0 && <details><summary>{t('continuation.completedTasksSummary', { count: groups.completed.length })}</summary>{groups.completed.map(task)}</details>}{moreButton('tasks', t('continuation.evAction'))}</section>
      <section aria-label={t('continuation.colWaitingAria')}><h3>{t('continuation.colWaitingHeading')}</h3>{groups.waiting.length ? groups.waiting.map(followUp) : <p className="home-empty">{t('continuation.noWaitingOnPage')}</p>}</section>
      <section aria-label={t('continuation.colQuestionsAria')}><h3>{t('continuation.colQuestionsHeading')}</h3>{groups.questions.length ? groups.questions.map(followUp) : <p className="home-empty">{t('continuation.noQuestionsOnPage')}</p>}</section></div>
    {groups.resolved.length > 0 && <details className="continuation-resolved"><summary>{t('continuation.resolvedFollowUpsSummary', { count: groups.resolved.length })}</summary>{groups.resolved.map(followUp)}</details>}{moreButton('followUps', t('continuation.sectionWaitingsLabel'))}
    {(groups.readyConditions.length > 0 || groups.watchingConditions.length > 0 || groups.closedConditions.length > 0 || data.conditions?.nextCursor) && <section className="continuation-conditions" aria-label={t('continuation.colConditionsAria')}><h3>{t('continuation.colConditionsHeading')}</h3>{suggestionsEnabled && groups.readyConditions.length > 0 && <div className="continuation-ready-conditions"><h4>{t('continuation.readyConditionsHeading')}</h4>{groups.readyConditions.map(condition)}</div>}{factualConditions.map(condition)}{groups.closedConditions.length > 0 && <details><summary>{t('continuation.closedConditionsSummary', { count: groups.closedConditions.length })}</summary>{groups.closedConditions.map(condition)}</details>}{moreButton('conditions', t('continuation.colConditionsHeading'))}</section>}
    <section className="continuation-artifacts" aria-label={t('continuation.artifactsAria')}>
      <div className="section-heading"><div><h3>{t('continuation.artifactsHeading')}</h3><p className="muted small">{t('continuation.artifactsDesc')}</p></div><button type="button" className="soft-btn" disabled={props.busy || artifactBusy} onClick={() => openComposer()}>{t('continuation.createArtifactBtn')}</button></div>
      {artifactError && <p className="notice" role="alert">{artifactError}</p>}
      {visibleComposer && <div className="artifact-composer" role="region" aria-label={t('continuation.composerAria')}>
        <div className="section-heading"><strong>{visibleComposer.isNew ? t('continuation.composerNewTitle') : `${t('continuation.composerEditPrefix')}${visibleComposer.draft.version}`}</strong></div>
        <label>{t('continuation.artifactTypeLabel')}<select aria-label={t('continuation.artifactTypeAria')} value={visibleComposer.draft.type} disabled={artifactBusy} onChange={event => switchComposerType(event.target.value as ArtifactType)}>
          {(['proposal_brief', 'material_checklist', 'meeting_brief'] as const).map(type => <option key={type} value={type}>{formatArtifactType(type, lang)}</option>)}
        </select></label>
        <label>{t('continuation.artifactTitleLabel')}<input aria-label={t('continuation.artifactTitleAria')} value={visibleComposer.draft.title} disabled={artifactBusy} onChange={event => setComposer({ ...visibleComposer, dirty: true, draft: { ...visibleComposer.draft, title: event.target.value, status: visibleComposer.draft.status === 'ready' ? 'draft' : visibleComposer.draft.status } })}/></label>
        <label>{t('continuation.artifactContentLabel')}<textarea aria-label={t('continuation.artifactContentAria')} rows={10} value={visibleComposer.draft.content} disabled={artifactBusy} onChange={event => setComposer({ ...visibleComposer, dirty: true, draft: { ...visibleComposer.draft, content: event.target.value, status: visibleComposer.draft.status === 'ready' ? 'draft' : visibleComposer.draft.status } })}/></label>
        <p className="muted small">{t('continuation.composerDisclaimer')}</p>
        <label className="check-label"><input type="checkbox" checked={visibleComposer.reviewChecked} onChange={event => setComposer({ ...visibleComposer, reviewChecked: event.target.checked })}/>{t('continuation.artifactReviewCheck')}</label>
        <div className="button-row">
          <button type="button" className="primary-btn" disabled={artifactBusy || !visibleComposer.draft.title.trim()} onClick={() => void saveComposer(false)}>{t('continuation.saveArtifactDraftBtn')}</button>
          <button type="button" className="soft-btn" disabled={artifactBusy || !visibleComposer.reviewChecked || !visibleComposer.draft.title.trim()} onClick={() => void saveComposer(true)}>{t('continuation.saveArtifactReadyBtn')}</button>
          <button type="button" className="text-btn" disabled={artifactBusy} onClick={() => setComposer(null)}>{t('common.cancel')}</button>
        </div>
      </div>}
      {(data.artifacts?.items || []).length === 0 && !visibleComposer ? <p className="home-empty">{t('continuation.emptyArtifacts')}</p> : (data.artifacts?.items || []).map(art => {
        const staleness = inspectArtifactStaleness(art, project, data.tasks.items, data.followUps.items, data.conditions?.items || [], lang);
        const statusText = staleness.stale ? formatArtifactStatus('needs_review', lang) : formatArtifactStatus(art.status, lang);
        return <article className="continuation-item artifact-card" key={art.id}>
          <div className="artifact-card-head"><span className="followup-label">{formatArtifactType(art.type, lang)}</span><span className={`followup-label ${staleness.stale ? 'followup-label--question' : 'followup-label--waiting'}`}>{statusText} · v{art.version}</span></div>
          <h4>{art.title}</h4>
          {staleness.stale && <div className="artifact-stale-banner" role="status"><p><strong>{t('continuation.staleBannerTitle')}</strong>{staleness.reasons.join('；')}</p><div className="button-row"><button type="button" className="soft-btn" disabled={artifactBusy} onClick={() => void rebuildArtifact(art, 'keep_content')}>{t('continuation.keepContentSyncBtn')}</button><button type="button" className="soft-btn" disabled={artifactBusy} onClick={() => void rebuildArtifact(art, 'rebuild')}>{t('continuation.rebuildFreshBtn')}</button></div></div>}
          {art.status === 'ready' && !staleness.stale && <p className="muted small">{t('continuation.readyBadgeNote')}</p>}
          <pre className="artifact-preview-content">{art.content}</pre>
          {art.status !== 'ready' && <div className="button-row"><label className="check-label"><input type="checkbox" checked={!!readyChecks[art.id]} onChange={event => setReadyChecks(prev => ({ ...prev, [art.id]: event.target.checked }))}/>{t('continuation.artifactReviewCheck')}</label><button type="button" className="soft-btn" disabled={!readyChecks[art.id] || artifactBusy} onClick={() => void markArtifactReady(art)}>{t('continuation.markReadyBtn')}</button></div>}
          <div className="button-row"><button type="button" className="text-btn" disabled={artifactBusy} onClick={() => void copyArtifact(art)}>{t('continuation.copyFullArtifactBtn')}</button><button type="button" className="text-btn" disabled={artifactBusy} onClick={() => openComposer(art)}>{t('work.editShortBtn')}</button><button type="button" className="text-btn danger" disabled={artifactBusy} onClick={() => void deleteArtifact(art.id)}>{t('continuation.deleteDraftBtn')}</button></div>
          {copyNotice[art.id] && <p className="muted small" role="status">{copyNotice[art.id]}</p>}
        </article>;
      })}
      {moreButton('artifacts', t('continuation.artifactsHeading'))}
    </section>
    <section className="continuation-history" aria-label={t('continuation.recentAria')}><h3>{t('continuation.recentHeading')}</h3>{data.recent.items.length ? data.recent.items.map(record => <button className="recent-closure" key={record.id} onClick={() => props.onOpenClosure(record)}><span>{time(record.confirmedAt)} · {record.revertedAt ? t('work.recentReverted') : record.originalOnly ? t('continuation.recentOriginalOnly') : t('continuation.recentReviewed')}<small>{t('continuation.openReceiptHint')}</small></span></button>) : <p className="home-empty">{t('continuation.emptyRecent')}</p>}{moreButton('recent', t('continuation.recentHeading'))}</section>
  </section>;
}
