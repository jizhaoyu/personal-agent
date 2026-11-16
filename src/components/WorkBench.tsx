import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, Plus, CornerDownLeft, History, CheckCircle2, Circle, RotateCcw, ChevronDown, Sparkles, ClipboardPaste, FolderPlus, ListPlus } from 'lucide-react';
import type { WorkPartition, WorkOperation, Engagement, ProposedChangeSet, CaptureDraft, WorkHome, ClosureRecord, FollowUpItem, ProjectTaskItem, ConditionIntent, Message, CommittedChangeEvent } from '../types';
import type { AmbiguousTargetItemCandidate, ItemClarificationResult } from '../services/stateEngine';
import { selectHighlightedReadyConditions, type ConditionLifecycleAction } from '../services/conditionIntents';
import { chinaTime } from '../services/aiService';
import { ProposalReview } from './ProposalReview';
import { ClosureReceipt } from './ClosureReceipt';
import { ProjectContinuation } from './ProjectContinuation';
import { canContinueProject } from '../services/projectContinuation';
import { Repository } from '../persistence/repository';
import { eventMutations } from '../../shared/persistence-core.mjs';
import { formatBudgetAmount, formatDealStage, useI18n } from '../i18n';
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

export function WorkBench(props: WorkBenchProps) {
  const { lang, t } = useI18n();
  const saveLabels = {
    idle: t('work.saveIdle'),
    unsaved: t('work.saveUnsaved'),
    saving: t('work.saveSaving'),
    saved: t('work.saveSaved'),
    error: t('work.saveError'),
  };
  const { work: cached, pending, draft, home, closure } = props;
  const [view, setView] = useState<View>(closure ? 'receipt' : 'home');
  const [query, setQuery] = useState('');
  const [bindingQuery, setBindingQuery] = useState('');
  const [bindingChanged, setBindingChanged] = useState(false);
  const [dueOnly, setDueOnly] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [itemsKey, setItemsKey] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [savingItem, setSavingItem] = useState('');
  const [showBinding, setShowBinding] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [homeOverride, setHomeOverride] = useState<WorkHome | null>(null);
  const [homeLoadTimedOut, setHomeLoadTimedOut] = useState(false);
  const [homeRetryError, setHomeRetryError] = useState('');
  const [retryingHome, setRetryingHome] = useState(false);
  const [itemClarifier, setItemClarifier] = useState<((text: string, partition: WorkPartition, engagementId?: string) => ItemClarificationResult | null) | null>(null);
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
  const activeHome = home || homeOverride;
  const hasBusiness = !!cached.engagements.length || !!cached.tasks.length || !!cached.followUps?.length || !!cached.conditions?.length || !!activeHome?.conditions?.length || !!activeHome?.recent.length || Number(props.stats?.counts?.message || 0) > 0;
  const kind = view === 'projects' || view === 'capture' || (view === 'home' && !hasBusiness) ? 'engagement' : view === 'tasks' ? 'task' : view === 'followups' ? 'followup' : view === 'history' ? 'event' : null;
  const key = `${kind}:${query}:${dueOnly}:${readIdentity}`;
  const visibleItems = itemsKey === key ? items : [];
  const projects = uniqueProjects([...cached.engagements, ...((kind === 'engagement' ? visibleItems : []) as Engagement[]), ...(detailProject?.identity === readIdentity ? [detailProject.project] : [])]);
  const hasClipboardRead = typeof window !== 'undefined' && typeof window.electronAPI?.readClipboard === 'function';

  useEffect(() => Repository.subscribe?.(() => setReadIdentity(Repository.getReadIdentity?.() || '')), []);
  useEffect(() => {
    let active = true;
    import('../services/stateEngine')
      .then(mod => {
        if (active && typeof mod.findAmbiguousTargetItems === 'function') {
          setItemClarifier(() => mod.findAmbiguousTargetItems);
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (home) {
      setHomeOverride(null);
      setHomeLoadTimedOut(false);
      setHomeRetryError('');
    }
  }, [home, readIdentity]);
  useEffect(() => {
    if (view !== 'home' || activeHome) {
      setHomeLoadTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setHomeLoadTimedOut(true), 4500);
    return () => clearTimeout(timer);
  }, [view, activeHome]);
  useEffect(() => {
    if (!text.trim()) setBindingChanged(false);
  }, [text]);
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
    }).catch(() => { if (active) setListError(t('work.readListError')); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; listSequence.current++; };
  }, [kind, query, dueOnly, cached.revision, readIdentity]);
  useEffect(() => {
    if (!closure || view !== 'receipt') return;
    let active = true; setReceiptData(null);
    async function referenced<T>(targetKind: 'engagement' | 'task' | 'followup', ids: string[]): Promise<T[]> {
      const rows: T[] = [];
      for (let offset = 0; offset < ids.length; offset += 200) {
        if (!active) break;
        rows.push(...(await Repository.query<T>('work', targetKind, { ids: ids.slice(offset, offset + 200), limit: 200 })).items);
      }
      return rows;
    }
    void Promise.all([
      Repository.get<Message>('work', 'message', closure.sourceMessageId), Repository.get<CommittedChangeEvent>('work', 'event', closure.eventId),
      referenced<Engagement>('engagement', closure.engagementIds), referenced<ProjectTaskItem>('task', closure.taskIds), referenced<FollowUpItem>('followup', closure.followUpIds),
    ]).then(([source, event, engagements, tasks, followUps]) => { if (active) setReceiptData({ source, event, engagements, tasks, followUps }); }).catch(() => { if (active) setListError(t('work.readReceiptError')); });
    return () => { active = false; };
  }, [view, closure?.id, closure?.revertedAt, cached.revision]);

  async function retryLoadHome() {
    if (retryingHome || typeof Repository.getWorkHome !== 'function') return;
    setRetryingHome(true);
    setHomeRetryError('');
    try {
      const next = await Repository.getWorkHome();
      setHomeOverride(next);
      setHomeLoadTimedOut(false);
    } catch {
      setHomeRetryError(t('work.homeLoadingDelayed'));
    } finally {
      setRetryingHome(false);
    }
  }
  async function more() {
    if (!kind || !cursor || loading) return;
    const sequence = listSequence.current; setLoading(true);
    try { const page = await Repository.query('work', kind, { query, cursor, limit: 50, ...(kind === 'task' ? { dueOnly } : {}) }); if (sequence === listSequence.current) { setItems(previous => [...previous, ...page.items]); setCursor(page.nextCursor || null); } }
    catch { if (sequence === listSequence.current) setListError(t('work.readMoreError')); }
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
    manual([{ target: 'engagement', entityId: engagement.id, before: null, after: engagement }], t('work.manualCreateProjectSource'));
  }
  function showProject(id: string) {
    setSelectedProjectId(id); openView('projects');
  }
  async function setItemState(itemKind: 'task' | 'followup', item: ProjectTaskItem | FollowUpItem, done: boolean) {
    if (props.busy || savingItem) return;
    setSavingItem(item.id); setListError('');
    try { await props.onSetItemState(itemKind, item, done); }
    catch { setListError(t('work.saveStateFailed')); }
    finally { setSavingItem(''); }
  }
  function taskRow(task: ProjectTaskItem) {
    const project = projects.find(item => item.id === task.engagementId);
    const canOpenProject = !!task.engagementId && !(view === 'projects' && selectedProjectId === task.engagementId);
    return <article className={`task-row ${task.done ? 'completed' : ''}`} key={task.id}><button className="icon-btn task-check-btn" disabled={props.busy || !!savingItem} aria-label={`${task.done ? t('work.reopenActionPrefix') : t('work.completeActionPrefix')}${task.title}`} onClick={() => setItemState('task', task, !task.done)}>{task.done ? <CheckCircle2 size={18}/> : <Circle size={18}/>}</button><div className="task-row-body"><h3>{task.title}</h3><p>{project ? `${project.clientName}${project.title ? ` · ${project.title}` : ''}` : t('work.unlinkedClient')} · {task.dueAt ? `${t('work.ourReminderPrefix')}${chinaTime(task.dueAt, lang)}` : t('work.noReminder')}</p></div><div className="followup-actions">{canOpenProject && <button className="text-btn" disabled={props.busy} onClick={() => showProject(task.engagementId!)}>{t('work.viewProject')}</button>}<button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'task', entityId: task.id, before: task, after: { ...task } }], t('work.manualEditTaskSource'))}>{t('work.editBtn')}</button></div></article>;
  }
  function followUpRow(item: FollowUpItem) {
    const resolved = item.status === 'resolved';
    const project = projects.find(row => row.id === item.engagementId);
    const canOpenProject = !!item.engagementId && !(view === 'projects' && selectedProjectId === item.engagementId);
    return <article className={`followup-row${resolved ? ' completed' : ''}`} key={item.id}><div className="followup-row-body"><span className={`followup-label followup-label--${item.kind}`}>{item.kind === 'waiting' ? t('work.labelWaiting') : t('work.labelQuestion')}{resolved ? t('work.labelResolvedSuffix') : ''}</span><h3>{item.title}</h3><p>{project ? `${project.clientName}${project.title ? ` · ${project.title}` : ''} · ` : ''}{item.expectedDate ? `${t('work.expectedDatePrefix')}${item.expectedDate}` : item.expectedAt ? `${t('work.expectedDatePrefix')}${chinaTime(item.expectedAt, lang)}` : item.kind === 'waiting' ? t('work.timeTbd') : t('work.timePendingConfirm')}{item.reviewAt ? `${t('work.reviewAtPrefix')}${chinaTime(item.reviewAt, lang)}` : ''}</p></div><div className="followup-actions">{canOpenProject && <button className="text-btn" disabled={props.busy} onClick={() => showProject(item.engagementId!)}>{t('work.viewProject')}</button>}<button className="soft-btn" disabled={props.busy || !!savingItem} onClick={() => setItemState('followup', item, !resolved)}>{resolved ? t('work.reopenBtn') : item.kind === 'waiting' ? t('work.markReceived') : t('work.markResolved')}</button><button className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'followup', entityId: item.id, before: item, after: { ...item } }], t('work.manualEditFollowUpSource'))}>{t('work.editBtn')}</button></div></article>;
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
    } catch { setListError(t('work.saveStateFailed')); }
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
    const statusLabel = item.status === 'ready' ? t('work.condReady') : item.status === 'watching' ? t('work.condWatching') : item.status === 'draft' ? t('work.condDraft') : item.status === 'paused' ? t('work.condPaused') : item.status === 'cancelled' ? t('work.condCancelled') : t('work.condCompleted');
    const primaryActions: React.ReactNode[] = [];
    const secondaryActions: React.ReactNode[] = [];

    if (item.status === 'ready') {
      primaryActions.push(<button key="convert" className="primary-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'convert_to_task')}>{t('work.condConvertToTask')}</button>);
      if (suggestionsEnabled && item.engagementId) {
        primaryActions.push(<button key="artifact" className="soft-btn" disabled={props.busy || !!savingItem} onClick={() => prepareArtifactFromCondition(item)}>{t('work.condPrepareArtifact')}</button>);
        if (canOpenProject) secondaryActions.push(<button key="proj" className="text-btn" disabled={props.busy} onClick={() => showProject(item.engagementId!)}>{t('work.viewProject')}</button>);
      } else if (canOpenProject) {
        primaryActions.push(<button key="proj" className="text-btn" disabled={props.busy} onClick={() => showProject(item.engagementId!)}>{t('work.viewProject')}</button>);
      }
      if (item.dismissedRevision !== item.revision) secondaryActions.push(<button key="dismiss" className="text-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'dismiss_highlight')}>{t('work.condDismiss')}</button>);
    } else if (item.status === 'watching' || item.status === 'draft') {
      primaryActions.push(<button key="ready" className="soft-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'confirm_ready')}>{t('work.condConfirmReady')}</button>);
      if (canOpenProject) primaryActions.push(<button key="proj" className="text-btn" disabled={props.busy} onClick={() => showProject(item.engagementId!)}>{t('work.viewProject')}</button>);
      if (item.status === 'draft') secondaryActions.push(<button key="watch" className="text-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'activate_watching')}>{t('work.condActivateWatching')}</button>);
    } else if (item.status === 'paused') {
      primaryActions.push(<button key="resume" className="soft-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'activate_watching')}>{t('work.condResumeWatching')}</button>);
      if (canOpenProject) primaryActions.push(<button key="proj" className="text-btn" disabled={props.busy} onClick={() => showProject(item.engagementId!)}>{t('work.viewProject')}</button>);
    } else {
      if (canOpenProject) primaryActions.push(<button key="proj" className="text-btn" disabled={props.busy} onClick={() => showProject(item.engagementId!)}>{t('work.viewProject')}</button>);
      primaryActions.push(<button key="edit" className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'condition', entityId: item.id, before: item, after: { ...item } }], t('work.manualEditConditionSource'))}>{t('work.editBtn')}</button>);
    }

    if (!closed) {
      if (item.status === 'watching' || item.status === 'ready') {
        secondaryActions.push(<button key="pause" className="text-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'pause')}>{t('work.condPause')}</button>);
      }
      secondaryActions.push(<button key="cancel" className="text-btn" disabled={props.busy || !!savingItem} onClick={() => void setConditionState(item, 'cancel')}>{t('common.cancel')}</button>);
      secondaryActions.push(<button key="edit" className="text-btn" disabled={props.busy} onClick={() => manual([{ target: 'condition', entityId: item.id, before: item, after: { ...item } }], t('work.manualEditConditionSource'))}>{t('work.editBtn')}</button>);
    }

    return <article className={`followup-row condition-row${closed ? ' completed' : ''}`} key={item.id}><div className="followup-row-body"><span className={`followup-label followup-label--${item.status === 'ready' ? 'waiting' : 'question'}`}>{statusLabel} · v{item.revision}</span><h3>{t('work.condTitlePrefix')}{item.conditionText}{t('work.condTitleArrow')}{item.actionTitle}</h3><p>{project ? `${project.clientName}${project.title ? ` · ${project.title}` : ''} · ` : ''}{item.conditionKind === 'followup_resolved' ? t('work.condKindFollowup') : t('work.condKindManual')}</p></div><div className="followup-actions">{primaryActions}{secondaryActions.length > 0 && <details className="card-more-menu"><summary>{t('work.moreActions')}</summary><div className="card-more-items">{secondaryActions}</div></details>}</div></article>;
  }
  async function submitCapture(originalOnly = false) {
    if (props.busy || submitting.current || !text.trim()) return;
    submitting.current = true; setCaptureError(''); setBindingChanged(false);
    try {
      if (originalOnly) await props.onOriginalOnly();
      else await props.onPropose(text);
    } catch {
      setCaptureError(t('work.captureRetrySaveError'));
    } finally { submitting.current = false; }
  }
  function candidateBadge(candidate: AmbiguousTargetItemCandidate): string {
    if (candidate.target === 'task') return t('work.itemClarifyTargetTask');
    return candidate.kind === 'question' ? t('work.itemClarifyTargetQuestion') : t('work.itemClarifyTargetWaiting');
  }
  function applyClarifiedCandidate(candidate: AmbiguousTargetItemCandidate, clarification: ItemClarificationResult) {
    const genericPattern = /(?:那个|这个|那件事|这件事|那条|这条|那项|这项|那事|这事|上面那个|前面那个)/g;
    let nextText = text.trim();
    if (genericPattern.test(nextText)) {
      nextText = nextText.replace(genericPattern, candidate.title);
    } else if (!nextText.includes(candidate.title)) {
      nextText = `${nextText} ${candidate.title}`;
    }
    const targetEngId = candidate.engagementId || clarification.engagementId;
    if (targetEngId && props.selectedId !== targetEngId) {
      props.onSelect(targetEngId);
    }
    props.onDraftChange({ text: nextText });
    setBindingChanged(true);
    captureInput.current?.focus();
  }
  function capturePanel() {
    const linkedProject = projects.find(project => project.id === props.selectedId);
    const trimmedBindingQuery = bindingQuery.trim().toLowerCase();
    const bindingProjects = trimmedBindingQuery
      ? projects.filter(project =>
          project.id === props.selectedId ||
          `${project.clientName} ${project.title}`.toLowerCase().includes(trimmedBindingQuery),
        )
      : projects;
    const itemClarification = text.trim() && itemClarifier
      ? itemClarifier(text, { ...cached, engagements: projects }, props.selectedId || undefined)
      : null;
    const hasCustomNewProject = Boolean(draft?.newClientName?.trim() || draft?.newProjectTitle?.trim());
    const showApplyReorganize = Boolean(
      text.trim() &&
      (bindingChanged || (!!pending?.clarification && (Boolean(props.selectedId) || hasCustomNewProject))),
    );
    return <div className={`capture-layout ${pending ? '' : 'capture-layout--single'}`}><div className="capture-column"><section className="capture-card">
      <div className="capture-card-header">
        <div className={`draft-save-state draft-save-state--${props.draftSaveState}`}><span className="status-dot" aria-hidden="true"/><span role="status">{saveLabels[props.draftSaveState]}</span>{props.draftSaveState === 'error' && props.onRetryDraft && <button className="text-btn" onClick={props.onRetryDraft}>{t('work.retryBtn')}</button>}<span className="draft-char-count">{text.length} / 12000</span></div>
        <details className="capture-advanced"><summary>{t('work.moreTools')}</summary><div className="capture-quick-tools">
          {hasClipboardRead && <button className="text-btn" type="button" disabled={props.busy} onClick={async () => {
            try {
              const clip = await window.electronAPI?.readClipboard?.();
              if (clip) props.onDraftChange({ text: text.trim() ? `${text.trimEnd()}\n${clip}` : clip });
            } catch {
              setCaptureError(t('work.clipboardReadFailed'));
            }
          }}><ClipboardPaste size={13}/>{t('work.pasteClipboard')}</button>}
          <button className="text-btn" disabled={props.busy} onClick={createProject}><FolderPlus size={13}/>{t('work.newProject')}</button>
          <button className="text-btn" disabled={props.busy} onClick={() => { const id = crypto.randomUUID(); manual([{ target: 'task', entityId: id, before: null, after: { id, title: '', assignee: '我', deadline: '', priority: 'medium', done: false, ...(props.selectedId ? { engagementId: props.selectedId } : {}) } }], t('work.manualAddTaskSource')); }}><ListPlus size={13}/>{t('work.addAction')}</button>
          {props.onPractice && <button className="text-btn" disabled={props.busy} onClick={props.onPractice}><Sparkles size={13}/>{t('work.practiceOnce')}</button>}
        </div></details>
      </div>
      {hasBusiness ? (
        <div className="capture-invitation capture-invitation--compact">
          <h2>{t('work.captureHeading')}</h2>
          <details className="capture-invitation-help"><summary>{t('work.captureHelpSummary')}</summary><p>{t('work.captureDesc')}</p></details>
        </div>
      ) : (
        <div className="capture-invitation"><p className="capture-kicker">{t('work.kicker')}</p><h2>{t('work.captureHeading')}</h2><p>{t('work.captureDesc')}</p></div>
      )}
      <textarea ref={captureInput} aria-label={t('work.captureAria')} aria-description={t('work.captureAriaDesc')} className="capture-input" rows={4} maxLength={12000} disabled={props.busy} value={text} onChange={event => { props.onDraftChange({ text: event.target.value }); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
        if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault(); void submitCapture();
      }} placeholder={t('work.capturePlaceholder')}/>
      {!text && !pending && <button type="button" className="capture-example" disabled={props.busy} onClick={() => {
        props.onDraftChange({ text: t('work.exampleSentence') });
        captureInput.current?.focus();
      }}><span>{t('work.fillExampleBadge')}</span>{t('work.exampleSentence')}</button>}
      {itemClarification && <div className="item-clarification-box" role="region" aria-label={t('work.itemClarifyHeading')}>
        <strong>{t('work.itemClarifyHeading')}</strong>
        <p>{itemClarification.message}</p>
        <div className="item-clarification-candidates">
          {itemClarification.candidates.map(candidate => (
            <button
              key={`${candidate.target}-${candidate.id}`}
              type="button"
              className="soft-btn"
              disabled={props.busy}
              onClick={() => applyClarifiedCandidate(candidate, itemClarification)}
            >
              {candidateBadge(candidate)} · {candidate.title}
            </button>
          ))}
        </div>
      </div>}
      <details className="capture-binding" open={!!pending?.clarification || showBinding} onToggle={event => setShowBinding(event.currentTarget.open)}><summary id="work-project-binding">{pending?.clarification ? t('work.bindingSelectOrCreate') : linkedProject ? `${t('work.bindingSelectedPrefix')}${linkedProject.clientName} · ${linkedProject.title}` : props.selectedId ? t('work.bindingSelectedGeneric') : t('work.bindingOptional')}</summary>
        <div className="capture-binding-body">
          {pending?.clarification && <p className="muted small">{pending.clarification.message}</p>}
          <div className="field-grid">
            <label>{t('work.findProjectLabel')}<input aria-label={t('work.findExistingAria')} value={bindingQuery} disabled={props.busy} onChange={event => setBindingQuery(event.target.value)} placeholder={t('work.findProjectPlaceholder')}/></label>
            <label className="context-select">{t('work.targetProjectLabel')}<select aria-label={t('work.targetProjectLabel')} value={props.selectedId} disabled={props.busy} onChange={event => { props.onSelect(event.target.value); setBindingChanged(true); }}><option value="">{t('work.autoDetectOption')}</option>{bindingProjects.map(project => <option key={project.id} value={project.id}>{project.clientName} · {project.title}</option>)}{trimmedBindingQuery && bindingProjects.length === 0 && <option disabled value="__empty">{t('work.noMatchingProjects')}</option>}</select></label>
          </div>
          {!props.selectedId ? <div className="field-grid"><label>{t('work.newClientLabel')}<input aria-label={t('work.newClientAria')} disabled={props.busy} maxLength={100} value={draft?.newClientName || ''} onChange={event => { props.onDraftChange({ newClientName: event.target.value }); setBindingChanged(true); }} placeholder={t('work.newClientPlaceholder')}/></label><label>{t('work.newProjectLabel')}<input aria-label={t('work.newProjectAria')} disabled={props.busy} maxLength={200} value={draft?.newProjectTitle || ''} onChange={event => { props.onDraftChange({ newProjectTitle: event.target.value }); setBindingChanged(true); }} placeholder={t('work.newProjectPlaceholder')}/></label></div> : <button className="text-btn" disabled={props.busy} onClick={() => { props.onSelect(''); setShowBinding(true); setBindingChanged(true); }}>{t('work.switchToNewProject')}</button>}
          {showApplyReorganize && <div className="capture-binding-actions">
            <span className="muted small">{t('work.bindingHintApply')}</span>
            <button type="button" className="primary-btn" disabled={props.busy || !text.trim()} onClick={() => void submitCapture()}>{t('work.applyAndReorganize')}</button>
          </div>}
        </div>
      </details>
      <div className="input-footer">
        <div className="input-footer-left">
          {props.modelBusy && <button className="text-btn danger" onClick={props.onCancel}>{t('work.cancelModelReq')}</button>}
        </div>
        <div className="input-footer-right">
          <button className="soft-btn" disabled={props.busy || !text.trim()} onClick={() => submitCapture(true)}>{t('work.saveOriginalOnly')}</button>
          <button className="primary-btn" disabled={props.busy || !text.trim()} onClick={() => submitCapture()}>{props.busy ? t('work.organizingBtn') : pending ? t('work.reorganizeBtn') : t('work.organizeRecordBtn')}<CornerDownLeft size={14}/></button>
        </div>
      </div>
      {pending && <a className="capture-review-link" href="#work-capture-review">{t('work.reviewLinkText')}<ArrowRight size={14}/></a>}
      <p className="capture-keyboard-hint">{t('work.keyboardHint')}</p>
      {captureError && <p className="notice" role="alert">{captureError}</p>}
    </section></div>
    {pending && <div className="review-column" id="work-capture-review" tabIndex={-1}><fieldset className="review-fieldset" disabled={props.busy}><ProposalReview proposal={pending} projectBindingId="work-project-binding" engagements={projects} conflicts={draft?.conflicts} onResolveConflict={props.onResolveConflict} onChange={props.onChange} onConfirm={props.onConfirm} onDiscard={props.onDiscard} onReparse={props.onRebase} busy={props.busy}/></fieldset></div>}</div>;
  }

  const showCapture = view === 'capture' || view === 'home';
  const suggestionsEnabled = props.workSuggestionsEnabled !== false;
  const homeConditions = activeHome?.conditions || [];
  const readyConditions = suggestionsEnabled ? selectHighlightedReadyConditions(homeConditions, activeHome?.waiting || []) : [];
  const activeConditions = homeConditions.filter(item => item.status === 'watching' || item.status === 'draft' || item.status === 'paused');
  const hasActiveSummary = !!activeHome && (activeHome.today.length > 0 || activeHome.waiting.length > 0 || activeHome.questions.length > 0);
  const hasSummary = !!activeHome && (hasActiveSummary || activeHome.overdue.length > 0 || activeHome.recent.length > 0 || readyConditions.length > 0 || activeConditions.length > 0);
  const taskList = (visibleItems as ProjectTaskItem[]);
  const openTasks = taskList.filter(item => !item.done);
  const completedTasks = taskList.filter(item => item.done);

  return <div className="work-v5">
    <div className="work-v5-toolbar">
      <nav className="work-v5-tabs" aria-label={t('work.navAria')}>
        {([['home', t('work.tabHome')], ['projects', t('work.tabProjects')], ['history', t('work.tabHistory')]] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-current={view === value || (value === 'home' && view === 'capture') || (value === 'projects' && (view === 'tasks' || view === 'followups')) ? 'page' : undefined}
            className={view === value || (value === 'home' && view === 'capture') || (value === 'projects' && (view === 'tasks' || view === 'followups')) ? 'active' : ''}
            onClick={() => openView(value)}
          >
            {label}
            {value === 'home' && hasDraft && <span className="tiny-dot" title={t('work.draftDotTitle')} aria-hidden="true"/>}
          </button>
        ))}
      </nav>
      <div className="work-v5-toolbar-actions">
        {(view === 'projects' || view === 'tasks' || view === 'followups' || view === 'history') && (
          <label className="toolbar-search">
            <input aria-label={t('work.findExistingAria')} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('work.searchPlaceholder')}/>
          </label>
        )}
        {(view === 'projects' || view === 'tasks' || view === 'followups') && <button className="soft-btn" disabled={props.busy} onClick={createProject}><Plus size={14}/>{t('work.newProject')}</button>}
        {view === 'history' && <button className="soft-btn" disabled={props.busy || !visibleItems.some(event => !event.revertedAt)} onClick={props.onUndo}><RotateCcw size={14}/>{t('work.undoBtn')}</button>}
        {view !== 'capture' && <button type="button" className={showCapture ? 'text-btn' : 'primary-btn'} onClick={start} disabled={props.busy}><Plus size={14}/>{t('work.srCapture')}</button>}
      </div>
    </div>

    {listError && <p className="notice" role="alert">{listError}</p>}
    {(view === 'projects' || view === 'tasks' || view === 'followups') && (
      <div className="work-sub-nav">
        <button type="button" className={`sub-tab ${view === 'projects' ? 'active' : ''}`} onClick={() => openView('projects')}>{`${t('work.subNavProjectsPrefix')}${projects.length}${t('work.subNavProjectsSuffix')}`}</button>
        <button type="button" className={`sub-tab ${view === 'tasks' ? 'active' : ''}`} onClick={() => openView('tasks')}>{t('work.subNavTasks')}</button>
        <button type="button" className={`sub-tab ${view === 'followups' ? 'active' : ''}`} onClick={() => openView('followups')}>{t('work.subNavFollowUps')}</button>
      </div>
    )}

    {showCapture && <div className={view === 'home' && !pending ? 'work-home-layout' : 'work-capture-page'}>
    {capturePanel()}
    {view === 'home' && <aside className="continuation-home" aria-label={t('work.summaryAria')}>
      <h2 className="home-summary-title">{t('work.summaryTitle')}</h2>
      {hasDraft && <article className="resume-draft"><div className="resume-draft-info"><span className="resume-badge">{t('work.unfinishedDraftBadge')}</span>{!text.trim() && <p>{t('work.unfinishedDraftFallback')}</p>}</div><button className="soft-btn" onClick={resume} disabled={props.busy}>{t('work.continueOrganize')}<ArrowRight size={14}/></button></article>}
      {!activeHome ? (
        (homeLoadTimedOut || homeRetryError) ? (
          <div className="home-loading-error" role="alert">
            <span>{homeRetryError || t('work.homeLoadingDelayed')}</span>
            <button type="button" className="soft-btn" disabled={retryingHome} onClick={() => void retryLoadHome()}>{retryingHome ? t('work.loadingText') : t('work.retryLoadSummaryBtn')}</button>
          </div>
        ) : <p className="muted small" role="status">{t('work.loadingText')}</p>
      ) : !hasSummary ? <div className="home-summary-empty">
        <span className="home-summary-empty-mark" aria-hidden="true"><FileText size={18}/></span>
        <div><h3>{hasBusiness ? t('work.homeEmptyIdleTitle') : t('work.homeEmptyNewTitle')}</h3><p>{hasBusiness ? t('work.homeEmptyIdleDesc') : t('work.homeEmptyNewDesc')}</p></div>
      </div> : <>
        {readyConditions.length > 0 && <section className="home-section home-section--ready-condition" aria-label={t('work.readySectionAria')}><div className="section-heading"><h2>{t('work.readySectionHeading')}<span>{readyConditions.length}</span></h2></div><div className="section-list">{readyConditions.slice(0, 3).map(conditionRow)}</div></section>}
        {activeHome.overdue.length > 0 && <section className="home-section home-section--overdue" aria-label={t('work.overdueSectionAria')}><div className="section-heading"><h2>{t('work.overdueSectionHeading')}<span>{activeHome.counts.overdue}</span></h2><button className="text-btn" onClick={() => { openView('tasks'); setDueOnly(true); }}>{t('work.viewBtn')}<ArrowRight size={13}/></button></div><div className="section-list">{activeHome.overdue.slice(0, 3).map(taskRow)}</div></section>}
        {hasActiveSummary && <div className="home-bento-grid">
          {activeHome.today.length > 0 && <section className="home-section" aria-label={t('work.todaySectionAria')}>
            <div className="section-heading"><h2>{t('work.todaySectionHeading')}<span>{activeHome.counts.today}</span></h2><button className="text-btn" onClick={() => openView('tasks')}>{t('work.allBtn')}<ArrowRight size={13}/></button></div>
            <div className="section-list">{activeHome.today.slice(0, 3).map(taskRow)}</div>
          </section>}
          {activeHome.waiting.length > 0 && <section className="home-section" aria-label={t('work.waitingSectionAria')}>
            <div className="section-heading"><h2>{t('work.waitingSectionHeading')}<span>{activeHome.counts.waiting}</span></h2><button className="text-btn" onClick={() => openView('followups')}>{t('work.allBtn')}<ArrowRight size={13}/></button></div>
            <div className="section-list">{activeHome.waiting.slice(0, 3).map(followUpRow)}</div>
          </section>}
          {activeHome.questions.length > 0 && <section className="home-section" aria-label={t('work.questionsSectionAria')}>
            <div className="section-heading"><h2>{t('work.questionsSectionHeading')}<span>{activeHome.counts.questions}</span></h2><button className="text-btn" onClick={() => openView('followups')}>{t('work.allBtn')}<ArrowRight size={13}/></button></div>
            <div className="section-list">{activeHome.questions.slice(0, 3).map(followUpRow)}</div>
          </section>}
        </div>}
        {activeConditions.length > 0 && <section className="home-section" aria-label={t('work.conditionsSectionAria')}><div className="section-heading"><h2>{t('work.conditionsSectionHeading')}<span>{activeConditions.length}</span></h2></div><div className="section-list">{activeConditions.slice(0, 3).map(conditionRow)}</div></section>}
        {activeHome.recent.length > 0 && <section className="home-section home-recent-section" aria-label={t('work.recentSectionAria')}>
          <div className="section-heading"><h2>{t('work.recentSectionHeading')}</h2><button className="text-btn" onClick={() => openView('history')}>{t('work.historyBtn')}<ArrowRight size={13}/></button></div>
          <div className="recent-closure-grid">{activeHome.recent.slice(0, 3).map(record => <button className="recent-closure" key={record.id} onClick={() => { props.onOpenClosure(record); setView('receipt'); }}><span><strong>{record.engagementIds.map(id => cached.engagements.find(project => project.id === id)?.clientName).filter(Boolean).slice(0, 3).join('、') || t('work.recentDefaultTitle')}</strong><small>{chinaTime(record.confirmedAt, lang)} · {record.originalOnly ? t('work.recentOriginalOnly') : record.revertedAt ? t('work.recentReverted') : t('work.recentReviewed')}</small></span><ArrowRight size={15}/></button>)}</div>
        </section>}
      </>}
    </aside>}
    </div>}

    {view === 'projects' && <section className="records-panel">{selectedProjectId && <ProjectContinuation projectId={selectedProjectId} revision={cached.revision} draft={draft} busy={props.busy} workSuggestionsEnabled={suggestionsEnabled} initialArtifactCondition={artifactRequest?.projectId === selectedProjectId ? artifactRequest : null} onConsumeArtifactRequest={() => setArtifactRequest(null)} onContinueProject={continueProject} onResumeDraft={resume} onEdit={project => manual([{ target: 'engagement', entityId: project.id, before: project, after: { ...project, updatedAt: Date.now() } }], t('work.manualEditProjectSource'))} onClose={() => { setArtifactRequest(null); setSelectedProjectId(null); }} onProjectLoaded={project => setDetailProject({ identity: Repository.getReadIdentity?.() || '', project })} onOpenClosure={record => { props.onOpenClosure(record); setView('receipt'); }} renderTask={taskRow} renderFollowUp={followUpRow} renderCondition={conditionRow}/>}{!visibleItems.length && !loading && <p className="empty-text">{t('work.emptyProjects')}</p>}<div className="project-grid">{(visibleItems as Engagement[]).map(project => <article className="project-card" key={project.id}><header><span className="project-client">{project.clientName || t('work.unnamedClient')}</span><span className={`tag tag--stage-${project.stage}`}>{formatDealStage(project.stage, lang)}</span></header><h3>{project.title || t('work.unnamedProject')}</h3><div className="project-action-box"><strong>{t('work.nextActionBoxTitle')}</strong><p className="project-next-action">{project.nextAction || t('work.noNextAction')}</p></div><span className="budget-label">{t('work.budgetScaleLabel')}</span><p className="project-budget">{project.budgetAmount === undefined ? t('work.budgetTbd') : formatBudgetAmount(project.budgetAmount, lang)}</p><footer className="button-row"><button className="soft-btn" onClick={() => showProject(project.id)}>{t('work.detailsBtn')}</button><button className="text-btn" onClick={() => props.onExport(project)}><FileText size={13}/>{t('work.notesBtn')}</button></footer><details className="card-more-menu"><summary>{t('work.notesAndStageSummary')}</summary>{project.shareableSummary && <p className="muted small">{project.shareableSummary}</p>}<p className="small">{project.internalContext || t('work.noInternalNotes')}</p><div className="card-more-items"><button className="text-btn" disabled={props.busy} onClick={() => { manual([{ target: 'engagement', entityId: project.id, before: project, after: { ...project, updatedAt: Date.now() } }], t('work.manualEditProjectSource')); }}>{t('work.editShortBtn')}</button><button className="text-btn" disabled={props.busy || project.stage === '赢单成交'} onClick={() => manual([{ target: 'engagement', entityId: project.id, before: project, after: { ...project, stage: stages[Math.min(4, stages.indexOf(project.stage) + 1)], updatedAt: Date.now() } }], t('work.manualAdvanceStageSource'))}>{t('work.advanceStageBtn')}</button></div></details></article>)}</div></section>}

    {view === 'tasks' && <section className="records-panel" aria-label={t('work.srTasks')}><div className="records-panel-bar action-list-heading"><div><h2>{t('work.srTasks')}</h2><p>{t('work.tasksPanelDesc')}</p></div><label className="check-label"><input type="checkbox" checked={dueOnly} onChange={event => setDueOnly(event.target.checked)}/>{t('work.dueOnlyCheckbox')}</label></div>{!taskList.length && !loading ? <p className="empty-text">{t('work.emptyTasks')}</p> : <>
      {openTasks.length > 0 ? <div className="records-list">{openTasks.map(taskRow)}</div> : completedTasks.length > 0 && <p className="empty-text">{t('work.openTasksEmptyHint')}</p>}
      {completedTasks.length > 0 && <details className="tasks-completed-details"><summary>{t('work.completedTasksSummary', { count: completedTasks.length })}</summary><div className="records-list">{completedTasks.map(taskRow)}</div></details>}
    </>}</section>}

    {view === 'followups' && <section className="records-panel">{!visibleItems.length && !loading && <p className="empty-text">{t('work.emptyFollowUps')}</p>}<div className="records-list">{(visibleItems as FollowUpItem[]).map(followUpRow)}</div></section>}

    {view === 'history' && <section className="records-panel">{!visibleItems.length && !loading && <p className="empty-text">{t('work.emptyHistory')}</p>}<div className="records-list">{visibleItems.map(event => <article className="history-row" key={event.id}><History size={16}/><div><div className="history-row-head"><strong>{event.revertedAt ? t('work.eventReverted') : t('work.eventSaved')}{t('work.eventChangesCount', { count: eventMutations(event).length })}</strong><time>{chinaTime(event.createdAt, lang)}</time>{!event.revertedAt && <button className="text-btn" disabled={props.busy} onClick={() => props.onUndoEvent(event.id)}>{t('work.undoBtn')}</button>}</div><p>{event.sourceText || t('work.noSourceText')}</p></div></article>)}</div></section>}

    {view === 'receipt' && (closure ? receiptData ? <ClosureReceipt closure={closure} {...receiptData} onProject={showProject} onContinue={start} onExport={props.onExport} onUndo={props.onUndoEvent}/> : <p className="receipt-loading" role="status">{t('work.loadingText')}</p> : <p className="empty-text">{t('work.noReceiptText')}</p>)}
    {kind && cursor && <button className="soft-btn work-more" disabled={loading} onClick={() => void more()}>{loading ? t('work.loadingText') : t('work.loadMoreBtn')}<ChevronDown size={14}/></button>}
    {loading && view !== 'home' && <p className="muted small" role="status">{t('work.loadingText')}</p>}
  </div>;
}
