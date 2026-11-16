import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Settings, Briefcase, Moon, Minus, X, ArrowUpRight, RotateCcw, BookOpen } from 'lucide-react';
import { Repository } from './persistence/repository';
import type { AppSnapshotV5 } from './persistence/repository';
import type { RecallEvidence } from './persistence/memory';
import { setLanguage, t, translate, useI18n } from './i18n';
import { StateEngine, extractClientNames } from './services/stateEngine';
import { parseModelProposal } from './services/aiService';
import { migrateLegacyCredential } from './services/legacyConnection';
import { deriveCompanionState } from './services/companionState';
import { createCaptureDraft, reviseCaptureDraft, rebaseProposal, resolveProposalConflict } from './services/capture';
import { createDraftController } from './services/draftController';
import { TodoService } from './services/todos';
import { CHECKIN_REMINDER_PREFIX, syncCheckinReminders } from './services/checkins';
import { capturePersonalText, clearLifeCaptureFocus, invalidateAgentCaptures } from './services/agentCapture';
import { lifeActionText, routeLifeInput } from './services/lifeRouting';
import type { DraftController, DraftState } from './services/draftController';
import type { AppLanguage, Engagement, ProjectTaskItem, ProposedChangeSet, WorkOperation, WorkspaceMode, CaptureDraft, ClosureRecord, WorkHome, WorkPartition, FollowUpItem, ConditionIntent, TodoRecord } from './types';
import type { ConditionLifecycleAction } from './services/conditionIntents';
import { TodoPanel } from './components/TodoPanel';
import { WorkBench } from './components/WorkBench';
import { Companion } from './components/Companion';
import { SettingsModal } from './components/SettingsModal';
import { AlignmentModal } from './components/AlignmentModal';
import { TrialInfoModal } from './components/TrialInfoModal';
import buildInfo from '../shared/build-info.json';
const PracticeModal = lazy(() => import('./components/PracticeModal').then(m => ({ default: m.PracticeModal })));
const ChatPill = lazy(() => import('./components/ChatPill').then(m => ({ default: m.ChatPill })));
const LivingCardsBoard = lazy(() => import('./components/LivingCardsBoard').then(m => ({ default: m.LivingCardsBoard })));
const CheckinBoard = lazy(() => import('./components/CheckinBoard').then(m => ({ default: m.CheckinBoard })));
const MemoryCenter = lazy(() => import('./components/MemoryCenter').then(m => ({ default: m.MemoryCenter })));
const id = () => crypto.randomUUID();

export function App() {
  const { lang, t } = useI18n();
  const [snapshot, setSnapshot] = useState<AppSnapshotV5 | null>(null);
  const [startupError, setStartupError] = useState('');
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [home, setHome] = useState<WorkHome | null>(null);
  const [closure, setClosure] = useState<ClosureRecord | null>(null);
  const [projectLookup, setProjectLookup] = useState<{ query: string; requestId: string }>();
  const [committing, setCommitting] = useState(false);
  const [unknownCapture, setUnknownCapture] = useState(false);
  const [restoreNeedsRead, setRestoreNeedsRead] = useState(false);
  const [undoEventId, setUndoEventId] = useState('');
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState('');
  const [toast, setToastValue] = useState('');
  const [saved, setSaved] = useState(false);
  const [compact, setCompact] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [isSettingsOpen, setSettingsOpen] = useState(false);
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [trialInfoOpen, setTrialInfoOpen] = useState(false);
  const [connection, setConnection] = useState<ModelConnectionStatus | null>(null);
  const [exportProject, setExportProject] = useState<Engagement | null>(null);
  const [exportTasks, setExportTasks] = useState<ProjectTaskItem[]>([]);
  const [lifeTab, setLifeTab] = useState('chat');
  const [lifeDraft, setLifeDraft] = useState('');
  const [pendingTodoFloat, setPendingTodoFloat] = useState<TodoRecord | null>(null);
  const [todoFocus, setTodoFocus] = useState<{ space: WorkspaceMode; id: string; requestId: string }>();
  const [todoChoices, setTodoChoices] = useState<TodoRecord[]>([]);
  const [agentRetry,setAgentRetry]=useState<{text:string;space:WorkspaceMode;sourceId:string;epoch:string;stage?:'agent'|'life-mutation'}|null>(null);
  const [todoChoiceAction, setTodoChoiceAction] = useState<'complete' | 'cancel' | 'time'>('complete');
  const modeRef = useRef<WorkspaceMode>('life');
  const operation = useRef(0);
  const requestRef = useRef<string | null>(null);
  const controller = useRef<DraftController | null>(null);
  const unknownOriginalOnly = useRef(false);
  const controllerSubscription = useRef<(() => void) | null>(null);
  const homeSequence = useRef(0);
  const pending = draftState?.draft.proposal || null;
  const selectedId = draftState?.draft.selectedEngagementId || '';
  const mode = snapshot?.activeMode || 'life'; modeRef.current = mode;
  function setToast(message: string) { setToastValue(message); setUndoEventId(''); }
  function installDraft(draft: CaptureDraft) {
    stopModelRequest();
    controllerSubscription.current?.(); controller.current?.dispose();
    const next = createDraftController(draft, value => Repository.saveCaptureDraft(value));
    controller.current = next; setDraftState(next.getState());
    controllerSubscription.current = next.subscribe(setDraftState);
  }
  function changeDraft(patch: Partial<CaptureDraft>) {
    if (!controller.current || committing || unknownCapture) return;
    setSaved(false);
    controller.current.update(reviseCaptureDraft(controller.current.getState().draft, patch));
  }
  function setPending(value: ProposedChangeSet | null) { changeDraft({ proposal: value || undefined, conflicts: [], status: value ? 'review' : 'editing' }); }
  function setSelectedId(value: string) {
    stopModelRequest();
    const hadClarification = !!controller.current?.getState().draft.proposal?.clarification;
    const currentText = controller.current?.getState().draft.text || '';
    changeDraft({ selectedEngagementId: value || undefined, ...(value ? { newClientName: undefined, newProjectTitle: undefined } : {}) });
    if (hadClarification && value && currentText.trim()) void propose(currentText);
  }
  async function refreshHome() {
    if (modeRef.current !== 'work') return; const sequence = ++homeSequence.current;
    try { const value = await Repository.getWorkHome(); if (modeRef.current === 'work' && sequence === homeSequence.current) setHome(value); }
    catch { if (modeRef.current === 'work') setIssue(t('app.homeReadIncomplete')); }
  }
  async function toggleLanguage() {
    if (!snapshot) return;
    const next: AppLanguage = lang === 'en' ? 'zh-CN' : 'en';
    setLanguage(next);
    setToastValue(translate(next, next === 'en' ? 'app.languageSavedEn' : 'app.languageSavedZh'));
    setUndoEventId('');
    try {
      await Repository.saveSettings({ ...snapshot.settings, language: next });
    } catch {
      setIssue(translate(next, 'app.languagePersistFailed'));
    }
  }
  useEffect(() => {
    let active = true;
    let ready = false;
    const update = () => { if (active && ready) setSnapshot(Repository.getCurrent()); };
    const unsubscribe = Repository.subscribe(update);
    void (async () => { try {
      const boot = await Repository.initialize();
      setLanguage(boot.snapshot.settings.language || 'zh-CN');
      await Repository.saveWorkspaceMode('life');
      if (boot.snapshot.activeMode === 'work') { const stored = await Repository.getCaptureDraft(); if (active) installDraft(stored || createCaptureDraft()); }
      if (active) { ready = true; setSnapshot(Repository.getCurrent()); }
      try {
        const currentSettings = Repository.getCurrent().settings;
        const hasCheckinReminder = Repository.getCurrent().partitions.life.customCards.some(c => c.cardKind === 'checkin' && Boolean(c.dailyReminderTime) && !c.archived);
        await TodoService.configure(Boolean(currentSettings.remindersEnabled || hasCheckinReminder));
        await TodoService.syncLegacy();
        await syncCheckinReminders(Repository.getCurrent().partitions.life.customCards, TodoService);
      }
      catch { if (active) setIssue(translate(Repository.getCurrent().settings.language || 'zh-CN', 'app.reminderSyncSkipped')); }
    } catch { if (active) setStartupError(t('app.dbReadFailed')); } })();
    return () => { active = false; unsubscribe(); controllerSubscription.current?.(); controller.current?.dispose(); controller.current = null; };
  }, []);
  useEffect(() => { if (snapshot && mode === 'work') void refreshHome(); }, [mode, snapshot?.partitions.work.revision, !!snapshot]);
  useEffect(() => {
    const beforeLeave = (event: BeforeUnloadEvent) => {
      const value = controller.current?.getState();
      if (value && ['unsaved', 'saving', 'error'].includes(value.status)) { event.preventDefault(); event.returnValue = ''; void controller.current?.flush().catch(() => {}); }
    };
    window.addEventListener('beforeunload', beforeLeave);
    return () => window.removeEventListener('beforeunload', beforeLeave);
  }, []);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onQuickCapture) return;
    return api.onQuickCapture(text => {
      if (!text || modeRef.current !== 'work') return;
      if (compact) void toggleCompact(false);
      changeDraft({ text });
      setToast(t('app.clipboardLoaded'));
    });
  }, [compact]);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onBeforeClose) return;
    return api.onBeforeClose(async requestId => {
      try { await controller.current?.flush(); await api.confirmClose(true, requestId); }
      catch { setIssue(t('app.draftNotSavedKeepInWindow')); await api.confirmClose(false, requestId); }
    });
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(false), 3500); return () => clearTimeout(timer); }, [saved]);
  useEffect(() => {
    if (!snapshot || !window.electronAPI) return;
    let active = true; const api = window.electronAPI;
    void (async () => {
      try {
        const warning = await migrateLegacyCredential(api, localStorage, snapshot.settings);
        if (active && warning) setIssue(warning);
        const status = await api.modelStatus(); if (active) setConnection(status);
        await api.setAlwaysOnTop(snapshot.settings.alwaysOnTop);
        if (!('LoomaAndroid' in window)) await api.setContentProtection?.(!!snapshot.settings.contentProtection);
      } catch { if (active) setIssue(t('app.desktopModelUnavailable')); }
    })(); return () => { active = false; };
  }, [!!snapshot]);
  useEffect(() => {
    if (!snapshot) return;
    const unsubscribe = Repository.subscribe(() => { void TodoService.syncLegacy().catch(() => setIssue(t('app.legacySyncIncomplete'))); });
    return unsubscribe;
  }, [!!snapshot]);
  useEffect(() => {
    if (!snapshot) return;
    const focus = (target: {space: WorkspaceMode; id: string}) => {
      if (!target || !['work', 'life'].includes(target.space) || typeof target.id !== 'string') return;
      void (async () => {
        if (!await switchMode(target.space)) return;
        if (target.space === 'life') setLifeTab(target.id.startsWith(CHECKIN_REMINDER_PREFIX) ? 'checkins' : 'todos');
        setTodoFocus({ space: target.space, id: target.id, requestId: id() });
        await toggleCompact(false);
      })();
    };
    const unsubscribe = window.electronAPI?.onTodoFocus?.(focus);
    const foregroundFocus = (event: Event) => focus((event as CustomEvent).detail);
    window.addEventListener('looma:todo-focus',foregroundFocus);
    return () => { unsubscribe?.(); window.removeEventListener('looma:todo-focus',foregroundFocus); };
  }, [!!snapshot, committing, unknownCapture]);
  function stopModelRequest() {
    invalidateAgentCaptures();
    operation.current++; const requestId = requestRef.current; requestRef.current = null; setBusy(false);
    if (requestId) void window.electronAPI?.cancelModel(requestId).catch(() => {});
  }
  function recorded(message: string, eventId?: string) { setSaved(true); setToast(message); setUndoEventId(eventId || ''); }
  async function toggleCompact(next = !compact) {
    try { await window.electronAPI?.setCompact?.(next); setCompact(next); } catch { setIssue(t('app.compactFailed')); }
  }
  async function flushDraft() { await controller.current?.flush(); }
  async function openMemory() {
    if (committing || unknownCapture) return;
    stopModelRequest();
    try { await flushDraft(); await toggleCompact(false); setMemoryOpen(true); }
    catch { setIssue(t('app.leaveWithoutDraftSave')); }
  }
  async function closeMemory() {
    try {
      if (modeRef.current === 'work' && controller.current) {
        const stored = await Repository.getCaptureDraft();
        if (!stored && controller.current.getState().draft.text.trim()) { installDraft(createCaptureDraft()); setToast(t('app.sourceDeletedClearedDraft')); }
      }
      setMemoryOpen(false); await refreshHome();
    } catch { setIssue(t('app.draftStatusUnavailable')); }
  }
  async function openSettings() {
    if (committing || unknownCapture) return;
    stopModelRequest();
    try { await flushDraft(); setSettingsOpen(true); } catch { setIssue(t('app.draftUnconfirmedBeforeAction')); }
  }
  async function openPractice() {
    if (committing || unknownCapture || restoreNeedsRead) return;
    stopModelRequest();
    try { await flushDraft(); setPracticeOpen(true); }
    catch { setIssue(t('app.draftUnconfirmedBeforePractice')); }
  }
  async function switchMode(next: WorkspaceMode) {
    if (committing || unknownCapture) return false;
    stopModelRequest(); setExportProject(null); setMemoryOpen(false); setIssue(''); setToast(''); setSaved(false);
    try {
      await flushDraft();
      if (next === 'work' && !controller.current) installDraft(await Repository.getCaptureDraft() || createCaptureDraft());
      await Repository.saveWorkspaceMode(next); modeRef.current = next;
      return true;
    } catch { setIssue(t('app.switchBlockedUnsaved')); return false; }
  }
  async function propose(text: string) {
    if ((busy && !requestRef.current) || committing || unknownCapture || !controller.current) return;
    if (requestRef.current) stopModelRequest();
    setIssue(''); setClosure(null);
    let draft = controller.current.getState().draft;
    if (draft.text !== text) { changeDraft({ text }); draft = controller.current.getState().draft; }
    const generation = ++operation.current, sourceId = draft.sourceMessageId; setBusy(true);
    try {
      await flushDraft();
      await Repository.saveMessages([{ id: sourceId, role: 'user', content: text, timestamp: draft.updatedAt }], 'work');
      setSaved(true);
      const hasProjectContext = Boolean(draft.selectedEngagementId || draft.newClientName?.trim() || draft.newProjectTitle?.trim());
      const captureEpoch=Repository.getReadIdentity().split(':')[0];
      if(!hasProjectContext&&connection?.enabled&&connection.configured)requestRef.current=sourceId;
      const todo = hasProjectContext
        ? { handled: false, needsReview: true, created: undefined, needsTime: undefined, needsChoice: undefined, choiceAction: undefined, silent: false, message: undefined, warning: undefined }
        : await capturePersonalText({text,space:'work',sourceId,turns:Repository.getCurrent().partitions.work.messages,contextTaskId:todoFocus?.space==='work'?todoFocus.id:undefined},!!connection?.enabled&&!!connection?.configured);
      if(requestRef.current===sourceId)requestRef.current=null;
      if(captureEpoch!==Repository.getReadIdentity().split(':')[0])return;
      if(operation.current!==generation||modeRef.current!=='work')return;
      if (todo.handled && !todo.needsReview) {
        if(todo.warning){setIssue(todo.warning);setAgentRetry({text,space:'work',sourceId,epoch:captureEpoch});}
        const closed=await Repository.commitCapture(draft,true);
        if(closed.outcome!=='committed'){
          setUnknownCapture(closed.outcome==='unknown');unknownOriginalOnly.current=true;
          throw new Error(closed.error||t('app.saveFailedPrefix'));
        }
        if (!todo.silent && todo.message) await Repository.saveMessages([{ id: id(), role: 'assistant', content: todo.message, timestamp: Date.now() }], 'work');
        if (operation.current !== generation || modeRef.current !== 'work') return;
        setTodoChoices(todo.needsChoice || []);
        setTodoChoiceAction(todo.choiceAction || 'complete');
        const target = todo.needsTime || todo.created;
        if (target) setTodoFocus({ space: 'work', id: target.id, requestId: id() });
        if (todo.silent) setToast('');
        installDraft(createCaptureDraft());
        return;
      }
      const partition = await Repository.getParseContext(text, draft.selectedEngagementId);
      if (operation.current !== generation || modeRef.current !== 'work') return;
      const local = StateEngine.propose(text, { mode: 'work', sourceMessageId: sourceId, partition, now: Date.now(),
        selectedEngagementId: draft.selectedEngagementId, newClientName: draft.newClientName, newProjectTitle: draft.newProjectTitle });
      if(!local.operations.length&&!todo.needsReview&&!hasProjectContext&&!extractClientNames(text).length&&!/预算|成交|签约|需求确认|阶段|万元|客户.*项目/.test(text)){
        if(todo.warning){setIssue(todo.warning);setAgentRetry({text,space:'work',sourceId,epoch:captureEpoch});}
        const closed=await Repository.commitCapture(draft,true);
        if(closed.outcome!=='committed'){
          setUnknownCapture(closed.outcome==='unknown');unknownOriginalOnly.current=true;
          throw new Error(closed.error||t('app.saveFailedPrefix'));
        }
        if(operation.current===generation&&modeRef.current==='work'){installDraft(createCaptureDraft());recorded(t('app.noteSaved'));}
        return;
      }
      setPending(local);
      if (!local.clarification && connection?.enabled && connection.configured && window.electronAPI) {
        const requestId = id(); requestRef.current = requestId;
        try {
          const selected = partition.engagements.find(item => item.id === draft.selectedEngagementId);
          const context = selected ? { id: selected.id, clientName: selected.clientName, title: selected.title, budgetAmount: selected.budgetAmount,
            stage: selected.stage, shareableSummary: selected.shareableSummary, nextAction: selected.nextAction } : null;
          const result = await window.electronAPI.proposeModel({ requestId, text, context, now: new Date().toISOString() });
          if (operation.current === generation && modeRef.current === 'work') setPending(parseModelProposal(result.content, local, partition, draft.selectedEngagementId));
        } catch (error) { if (operation.current === generation && modeRef.current === 'work') setIssue(`${error instanceof Error ? error.message : t('app.modelFailedFallback')} ${t('app.localKeptSuffix')}`); }
      }
    } catch (error) { if (operation.current === generation && modeRef.current === 'work') setIssue(t('app.proposeIncompletePrefix') + ' ' + (error instanceof Error ? error.message : t('app.retryKeepingInput'))); }
    finally { if (operation.current === generation) { requestRef.current = null; setBusy(false); } }
  }
  async function manual(operations: WorkOperation[], sourceText: string) {
    if (committing || unknownCapture || !controller.current) return;
    stopModelRequest(); setIssue('');
    if (controller.current.getState().draft.text.trim() || controller.current.getState().draft.proposal) {
      setIssue(t('app.unfinishedCaptureWarning')); return;
    }
    try {
      const generation = ++operation.current;
      const targetId = operations.find(item => item.target === 'engagement')?.entityId ||
        operations.find(item => item.target === 'task' || item.target === 'followup' || item.target === 'condition')?.after?.engagementId;
      changeDraft({ text: sourceText, selectedEngagementId: targetId }); const draft = controller.current.getState().draft;
      const proposal = await Repository.createProposal('work', operations, sourceText, draft.sourceMessageId);
      if (operation.current !== generation || modeRef.current !== 'work' || controller.current?.getState().draft.draftVersion !== draft.draftVersion) return;
      setClosure(null); setPending(proposal);
    } catch { setIssue(t('app.projectReadFailed')); }
  }
  async function saveCapture(originalOnly = false) {
    if (committing || !controller.current) return;
    stopModelRequest(); setCommitting(true); setIssue('');
    try {
      await flushDraft(); const draft = controller.current.getState().draft;
      const result = await Repository.commitCapture(draft, originalOnly);
      if (result.outcome === 'committed') {
        setUnknownCapture(false); installDraft(createCaptureDraft());
        setUndoEventId(result.eventId || '');
        if (result.closureId) {
          try { const record = await Repository.get<ClosureRecord>('work', 'closure', result.closureId); if (modeRef.current === 'work') setClosure(record); }
          catch { setIssue(t('app.savedReceiptUnread')); }
        }
        if (result.refreshWarning) setIssue(result.refreshWarning);
        if (modeRef.current === 'work') recorded(originalOnly ? t('app.savedOriginalOnlyToast') : t('app.savedReviewedToast'), result.eventId);
        await refreshHome();
      } else {
        setUnknownCapture(result.outcome === 'unknown'); unknownOriginalOnly.current = originalOnly;
        setIssue(result.error || t('app.saveUnconfirmedFallback'));
      }
    } catch (error) { setIssue(t('app.draftSaveErrorPrefix') + (error instanceof Error ? error.message : '')); }
    finally { setCommitting(false); }
  }
  async function undo(eventId?: string) {
    if (committing || unknownCapture) return;
    stopModelRequest();
    try {
      const result: any = await Repository.undo('work', eventId); if (modeRef.current !== 'work') return;
      if (!result.ok) { setIssue(result.error || t('app.undoFailedKeepOriginal')); return; }
      setIssue(result.refreshWarning || ''); setUndoEventId(''); recorded(t('app.undoSuccessToast'));
      if (closure) setClosure(await Repository.get<ClosureRecord>('work', 'closure', closure.id));
      await refreshHome();
    } catch { setIssue(t('app.undoReadFailed')); }
  }
  async function setItemState(kind: 'task' | 'followup', item: ProjectTaskItem | FollowUpItem, done: boolean) {
    if (committing || unknownCapture) return;
    const result = await Repository.setItemState(kind, item, done);
    if (modeRef.current !== 'work') return;
    if (result.outcome !== 'committed') { setIssue(result.error || t('app.itemStateUnconfirmed')); throw new Error(result.error); }
    setIssue(result.refreshWarning || ''); setUndoEventId(result.eventId || '');
    if (done) setToast(''); else recorded(t('app.reopenedToast'), result.eventId);
    try { await TodoService.syncLegacy(); } catch { setIssue(t('app.workSavedSyncFailed')); }
    await refreshHome();
  }
  async function setConditionState(item: ConditionIntent, action: ConditionLifecycleAction | 'convert_to_task') {
    if (committing || unknownCapture) return;
    const result = await Repository.setConditionState(item, action);
    if (modeRef.current !== 'work') return;
    if (result.outcome !== 'committed') { setIssue(result.error || t('app.conditionStateUnconfirmed')); throw new Error(result.error); }
    setIssue(result.refreshWarning || ''); setUndoEventId(result.eventId || '');
    recorded(action === 'convert_to_task' ? t('app.conditionConvertedToast') : t('app.conditionUpdatedToast'), result.eventId);
    await refreshHome();
  }
  async function reparse() {
    const draft = controller.current?.getState().draft; if (!draft?.proposal || committing || unknownCapture) return;
    stopModelRequest();
    const generation = ++operation.current;
    try {
      await Repository.refresh('work'); const partition: WorkPartition = { ...Repository.getCurrent().partitions.work, engagements: [], tasks: [], followUps: [], conditions: [], memories: [] };
      for (const target of ['engagement', 'task', 'followup', 'condition', 'memory'] as const) {
        const ids = draft.proposal.operations.filter(item => item.target === target).map(item => item.entityId); const rows: any[] = [];
        for (let index = 0; index < ids.length; index += 200) rows.push(...(await Repository.query('work', target, { ids: ids.slice(index, index + 200), limit: 200 })).items);
        if (target === 'engagement') partition.engagements = rows; else if (target === 'task') partition.tasks = rows; else if (target === 'followup') partition.followUps = rows; else if (target === 'condition') partition.conditions = rows; else partition.memories = rows;
      }
      const current = controller.current?.getState().draft;
      if (operation.current !== generation || modeRef.current !== 'work' || current?.sessionId !== draft.sessionId || current.draftVersion !== draft.draftVersion) return;
      const result = rebaseProposal(draft.proposal, partition); changeDraft({ proposal: result.proposal, conflicts: result.conflicts, status: 'review' }); setIssue('');
    } catch { setIssue(t('app.reparseReadIncomplete')); }
  }
  function resolveConflict(conflictId: string, choice: 'current' | 'proposed') {
    const draft = controller.current?.getState().draft; if (!draft?.proposal) return;
    const result = resolveProposalConflict(draft.proposal, draft.conflicts || [], conflictId, choice);
    changeDraft({ proposal: result.proposal, conflicts: result.conflicts, status: 'review' });
  }
  function continueCapture() { if (!committing && !unknownCapture) { setClosure(null); setIssue(''); } }
  function editBusiness(query: string) { setClosure(null); setMemoryOpen(false); setProjectLookup({ query, requestId: id() }); }
  async function dataImported() {
    setAgentRetry(null);
    stopModelRequest(); setUnknownCapture(false); setClosure(null); setHome(null); setExportProject(null);
    controllerSubscription.current?.(); controller.current?.dispose(); controller.current = null; setDraftState(null);
    try {
      installDraft(await Repository.getCaptureDraft() || createCaptureDraft());
      const importedSettings = Repository.getCurrent().settings;
      setLanguage(importedSettings.language || 'zh-CN');
      const importedHasCheckinReminder = Repository.getCurrent().partitions.life.customCards.some(c => c.cardKind === 'checkin' && Boolean(c.dailyReminderTime) && !c.archived);
      await TodoService.configure(Boolean(importedSettings.remindersEnabled || importedHasCheckinReminder));
      await syncCheckinReminders(Repository.getCurrent().partitions.life.customCards, TodoService).catch(() => {});
      setSnapshot(Repository.getCurrent()); setRestoreNeedsRead(false); setIssue(Repository.getRestoreWarning() || ''); TodoService.refresh(); await refreshHome();
    } catch {
      setRestoreNeedsRead(true); setSnapshot(Repository.getCurrent());
      setIssue(t('app.restoreViewUnread'));
    }
  }
  async function sendLife(text: string) {
    if (busy) throw new Error(t('app.previousSaveInFlight')); const sourceId = id(), generation = ++operation.current; setBusy(true); setIssue('');
    let originalSaved=false;
    let failureStage:'agent'|'life-mutation'='agent';
    const originalEpoch=Repository.getReadIdentity().split(':')[0];
    const routes=routeLifeInput(text);
    const hasFacts=routes.some(part=>part.route==='fact');
    const actionText=lifeActionText(text);
    try {
      await Repository.saveMessages([{ id: sourceId, role: 'user', content: text, timestamp: Date.now() }], 'life');
      originalSaved=true;
      setSaved(true);
      if(!actionText)clearLifeCaptureFocus();
      if(!actionText&&!hasFacts)return;
      const captureEpoch=Repository.getReadIdentity().split(':')[0];
      if(actionText&&connection?.enabled&&connection.configured)requestRef.current=sourceId;
      const todo = actionText?await capturePersonalText({text:actionText,space:'life',sourceId,turns:Repository.getCurrent().partitions.life.messages,contextTaskId:todoFocus?.space==='life'?todoFocus.id:undefined},!!connection?.enabled&&!!connection?.configured):undefined;
      if(requestRef.current===sourceId)requestRef.current=null;
      if(captureEpoch!==Repository.getReadIdentity().split(':')[0])return;
      if(operation.current!==generation||modeRef.current!=='life')return;
      if(todo?.warning){setAgentRetry({text,space:'life',sourceId,epoch:captureEpoch});if(modeRef.current==='life')setIssue(todo.warning);}
      if (todo?.handled && !todo.needsChoice) {
        if (!todo.silent && todo.message) await Repository.saveMessages([{ id: id(), role: 'assistant', content: todo.message, timestamp: Date.now() }], 'life');
        if (modeRef.current === 'life') {
          setTodoChoices(todo.needsChoice || []);
          setTodoChoiceAction(todo.choiceAction || 'complete');
          const target = todo.needsTime || todo.created;
          if (target) {
            setTodoFocus({ space: 'life', id: target.id, requestId: id() });
            setPendingTodoFloat(target);
          } else {
            const inactiveIds = new Set((todo.changed || []).filter(item => item.status !== 'pending' && item.status !== 'suggested').map(item => item.id));
            if (inactiveIds.size > 0) {
              setTodoFocus(current => current && current.space === 'life' && inactiveIds.has(current.id) ? undefined : current);
              setPendingTodoFloat(current => current && inactiveIds.has(current.id) ? null : current);
            }
          }
          if (todo.silent) setToast('');
        }
      }
      if(!hasFacts)return;
      failureStage='life-mutation';
      const mutations = await Repository.updateLifeAtomically(life => StateEngine.mutateLifeDraft(text, life), sourceId, text);
      if(!mutations.length)return;
      const lifeCards = Repository.getCurrent().partitions.life.customCards;
      if (lifeCards.some(c => c.cardKind === 'checkin')) {
        if (lifeCards.some(c => c.cardKind === 'checkin' && Boolean(c.dailyReminderTime) && !c.archived)) {
          await TodoService.configure(true).catch(() => {});
        }
        await syncCheckinReminders(lifeCards, TodoService).catch(() => {});
      }
      const reply = mutations.map(m => m.summaryText).join('\n');
      try { await Repository.saveMessages([{ id: id(), role: 'assistant', content: reply, timestamp: Date.now(), mutations }], 'life'); }
      catch { if (modeRef.current === 'life') setIssue(t('app.lifeReplySaveFailed')); }
      if (modeRef.current === 'life') recorded(t('app.lifeSavedToast'));
    } catch (error) {
      if(originalSaved){
        if(originalEpoch===Repository.getReadIdentity().split(':')[0]){
          setAgentRetry({text,space:'life',sourceId,epoch:originalEpoch,stage:failureStage});
          if(modeRef.current==='life')setIssue(t('app.lifeOriginalSavedPendingParse'));
        }
        return;
      }
      const message=t('app.lifeOriginalNotSaved');if(modeRef.current==='life')setIssue(message);throw new Error(error instanceof Error?`${message} ${error.message}`:message);
    }
    finally { if (generation === operation.current) setBusy(false); }
  }
  async function retryAgentCapture(){
    const input=agentRetry;if(!input||busy)return;
    if(input.epoch!==Repository.getReadIdentity().split(':')[0]){setAgentRetry(null);return;}
    const generation=++operation.current;
    if(input.stage!=='life-mutation'&&connection?.enabled&&connection.configured)requestRef.current=input.sourceId;
    setBusy(true);
    try{
      if(input.stage==='life-mutation'){
        const prior=await Repository.get('life','event',`event-life:${input.sourceId}`);
        if(input.epoch!==Repository.getReadIdentity().split(':')[0]||operation.current!==generation||modeRef.current!=='life')return;
        if(!prior)await Repository.updateLifeAtomically(life=>StateEngine.mutateLifeDraft(input.text,life),input.sourceId,input.text);
        if(operation.current===generation&&modeRef.current==='life'){setAgentRetry(null);setIssue('');}
        return;
      }
      const retryText=input.space==='life'?lifeActionText(input.text):input.text;
      if(!retryText){setAgentRetry(null);return;}
      const result=await capturePersonalText({...input,text:retryText,turns:Repository.getCurrent().partitions[input.space].messages},!!connection?.enabled&&!!connection?.configured);
      if(input.epoch!==Repository.getReadIdentity().split(':')[0]||operation.current!==generation||modeRef.current!==input.space)return;
      if(result.warning)setIssue(result.warning);
      else{setAgentRetry(null);setIssue(result.needsReview?t('app.reviewRequiredNotice'):'');if(result.silent)setToast('');}
      TodoService.refresh();
    }catch{if(operation.current===generation)setIssue(t('app.lifeRetryLater'));}
    finally{if(requestRef.current===input.sourceId)requestRef.current=null;if(operation.current===generation)setBusy(false);}
  }
  async function approveLifeTodo(todo: TodoRecord) {
    try {
      await TodoService.approve(todo);
      recorded(t('app.todoApprovedToast'));
    } catch (e) {
      setIssue(e instanceof Error ? e.message : t('app.todoApproveFailed'));
    }
  }
  async function modelRecall(query: string, evidence: RecallEvidence) {
    if (!snapshot?.settings.memoryModelEnabled || !window.electronAPI?.recallModel) throw new Error(t('app.recallNeedEnable'));
    const requestId = id(), sourceMode = modeRef.current; requestRef.current = requestId; setBusy(true);
    try { const result = await window.electronAPI.recallModel({ requestId, query, space: sourceMode, evidence: evidence.items });
      if (modeRef.current !== sourceMode || requestRef.current !== requestId) throw new Error(t('app.recallCancelledBySwitch')); return result.content;
    } finally { if (requestRef.current === requestId) { requestRef.current = null; setBusy(false); } }
  }
  if (!snapshot) return startupError ? <RecoveryScreen message={startupError}/> : <div className="recovery-screen" role="status">{t('common.loadingWorkspace')}</div>;
  const { settings } = snapshot, work = snapshot.partitions.work, life = snapshot.partitions.life, stats = Repository.getStats();
  const reminderCount = mode === 'work' ? (stats.dueTasks || 0) + (stats.dueFollowUps || 0) : 0;
  const state = deriveCompanionState({ busy: busy || committing, pending: mode === 'work' && !!pending, saved, error: issue, reminderCount });
  const companion = <Companion state={state} mode={mode} name={settings.personaName} reminderCount={reminderCount} onOpenMemory={mode === 'life' ? () => void openMemory() : undefined}/>;
  const isMobileOrAndroid = typeof navigator !== 'undefined' && (/android|iphone|ipad|ipod/i.test(navigator.userAgent) || (typeof window !== 'undefined' && 'LoomaNative' in window) || (typeof window !== 'undefined' && window.innerWidth < 768));
  if (compact && !isMobileOrAndroid) return <div className="capsule-shell drag-region"><Companion compact state={state} mode={mode} name={settings.personaName} reminderCount={reminderCount} onToggle={() => void toggleCompact(false)} onOpenMemory={() => void openMemory()}/></div>;
  return <div className={`app-shell ${mode === 'life' ? 'life-shell' : 'work-shell'}`}>
    <div className="workspace-content" inert={practiceOpen || trialInfoOpen}>
    <header className="app-header drag-region"><div className="app-header-left no-drag"><a className="wordmark" href="#" onClick={e => e.preventDefault()}>looma</a><div className={`space-switch ${mode === 'work' ? 'space-switch--work' : ''}`} aria-label={t('header.workspaceAria')}><button className={mode === 'work' ? 'active' : ''} onClick={() => void switchMode('work')}><Briefcase size={11}/>{t('header.workMode')}</button><button className={mode === 'life' ? 'active' : ''} onClick={() => void switchMode('life')}><Moon size={11}/>{t('header.lifeMode')}</button></div></div><div className="header-tools no-drag"><button className="icon-btn lang-switch-btn" onClick={() => void toggleLanguage()} aria-label={t('header.switchLangAria')} title={t('header.switchLangAria')}>{t('header.switchLangLabel')}</button><button className="icon-btn" onClick={() => void openMemory()} aria-label={t('header.openMemory')}><BookOpen size={16}/></button><button className="icon-btn" onClick={() => void openSettings()} aria-label={t('header.openSettings')}><Settings size={16}/></button>{window.electronAPI && !isMobileOrAndroid && <button className="icon-btn" onClick={() => void window.electronAPI!.minimizeWindow()} aria-label={t('header.minimize')}><Minus size={16}/></button>}{window.electronAPI && <button className="icon-btn" onClick={() => void window.electronAPI!.closeWindow()} aria-label={t('header.quitApp')}><X size={16}/></button>}</div></header>
    <main>{issue && <div className="app-alert" role="alert">{issue}{unknownCapture ? <button className="text-btn" disabled={committing} onClick={() => void saveCapture(unknownOriginalOnly.current)}>{t('app.checkSaveResult')}</button> : <button className="text-btn" onClick={async () => { try { if (restoreNeedsRead) { await dataImported(); } else { await Repository.refresh(mode); await refreshHome(); setIssue(''); } } catch { setIssue(t('app.reloadDataFailed')); } }}>{t('common.reload')}</button>}<button className="text-btn" disabled={unknownCapture} onClick={() => setIssue('')}>{t('common.collapse')}</button></div>}
      {memoryOpen ? <><button className="text-btn" onClick={() => void closeMemory()}>{t('common.backToSpace')}</button><Suspense fallback={<p>{t('common.openingMemory')}</p>}><MemoryCenter key={mode} mode={mode} onNotice={setToast} modelEnabled={!!settings.memoryModelEnabled && !!connection?.enabled} onModelRecall={modelRecall} onEditBusiness={mode === 'work' ? editBusiness : undefined}/></Suspense></> : mode === 'work' ? <WorkBench onPractice={() => void openPractice()} onRetryDraft={() => { void flushDraft().then(() => setIssue('')).catch(() => setIssue(t('app.draftRetryError'))); }} projectLookup={projectLookup} draft={draftState?.draft || null} draftSaveState={draftState?.status || 'idle'} home={home} closure={closure} onDraftChange={patch => { stopModelRequest(); changeDraft(patch); }} onContinue={continueCapture} onResume={() => setClosure(null)} onOriginalOnly={() => saveCapture(true)} onRebase={() => void reparse()} onResolveConflict={resolveConflict} onSetItemState={setItemState} onSetConditionState={setConditionState} onUndoEvent={eventId => void undo(eventId)} onOpenMemory={() => void openMemory()} onOpenClosure={setClosure} modelBusy={busy && !!requestRef.current} work={work} stats={stats} companion={companion} pending={pending} busy={committing || unknownCapture || restoreNeedsRead || (busy && !pending)} selectedId={selectedId} onSelect={setSelectedId} onPropose={propose} onChange={p => { stopModelRequest(); setPending(p); }} onConfirm={() => void saveCapture()} onDiscard={() => { stopModelRequest(); setPending(null); setIssue(''); }} onReparse={() => void reparse()} onManual={(ops, text) => void manual(ops, text)} onUndo={() => void undo()} onExport={async project => { try { const tasks: ProjectTaskItem[] = []; let cursor: string | undefined; do { const page = await Repository.query<ProjectTaskItem>('work', 'task', { relatedId: project.id, limit: 200, cursor }); tasks.push(...page.items); cursor = page.nextCursor || undefined; } while (cursor); if (modeRef.current === 'work') { setExportProject(project); setExportTasks(tasks); } } catch { setIssue(t('app.linkedActionsReadFailed')); } }} modelEnabled={!!connection?.enabled && !!connection?.configured} workSuggestionsEnabled={settings.workSuggestionsEnabled ?? true} onCancel={() => { stopModelRequest(); setIssue(t('app.modelCancelled')); }}/>
        : <section className="life-workspace"><div className="life-tabs-wrapper"><nav className="life-tabs" aria-label={t('app.lifeTabsAria')}>{[['chat', t('app.lifeTabChat')], ['todos', t('app.lifeTabTodos')], ['checkins', t('app.lifeTabCheckins')], ['cards', t('app.lifeTabCards')], ['memory', t('app.lifeTabMemory')]].map(([tab, label]) => <button key={tab} className={lifeTab === tab ? 'active' : ''} onClick={() => setLifeTab(tab)}>{label}</button>)}</nav></div><div className="life-panel" key={lifeTab}><Suspense fallback={<p className="muted small">{t('common.openingLifeSpace')}</p>}>
          {lifeTab === 'chat' && <ChatPill messages={life.messages} settings={settings} mode="life" isLoading={busy} onSendMessage={sendLife} draftText={lifeDraft} onDraftTextChange={(text, expected) => setLifeDraft(current => expected === undefined || current === expected ? text : current)} onInspectMutation={() => setLifeTab('cards')} onOpenCards={() => setLifeTab('cards')} pendingTodo={pendingTodoFloat} onApproveTodo={approveLifeTodo} onDismissPendingTodo={() => setPendingTodoFloat(null)} onOpenTodos={() => setLifeTab('todos')}/>}
          {lifeTab === 'todos' && <TodoPanel key="life" space="life" focusId={todoFocus?.space === 'life' ? todoFocus.id : undefined} focusRequestId={todoFocus?.requestId} choices={todoChoices.filter(todo => todo.space === 'life')} choiceAction={todoChoiceAction} onChoiceDone={() => setTodoChoices([])} onError={setIssue}/>}
          {lifeTab === 'checkins' && <CheckinBoard onCompanionToast={recorded}/>}
          {lifeTab === 'cards' && <LivingCardsBoard mode="life" onCompanionToast={recorded}/>}
          {lifeTab === 'memory' && <MemoryCenter mode="life" onNotice={setToast} modelEnabled={!!settings.memoryModelEnabled && !!connection?.enabled} onModelRecall={modelRecall}/>}
        </Suspense></div></section>}
      {agentRetry?.space===mode&&<div className="notice"><span>{t('app.agentRetryNotice')}</span><button className="text-btn" disabled={busy} onClick={()=>void retryAgentCapture()}>{t('app.agentRetryBtn')}</button><button className="text-btn" onClick={()=>setAgentRetry(null)}>{t('app.agentLeaveLater')}</button></div>}
      {mode === 'work' && <TodoPanel key="work" space="work" focusId={todoFocus?.space === 'work' ? todoFocus.id : undefined} focusRequestId={todoFocus?.requestId} choices={todoChoices.filter(todo => todo.space === 'work')} choiceAction={todoChoiceAction} onChoiceDone={() => setTodoChoices([])} onError={setIssue}/>}
    </main>
    <footer className="app-footer"><span title={buildInfo.buildId}>LOOMA · {buildInfo.productVersion}</span><button className="text-btn" onClick={() => setTrialInfoOpen(true)}>{t('footer.versionAndIssues')}</button><button className="text-btn" onClick={() => void openSettings()}>{t('footer.settingsAndBackup')} <ArrowUpRight size={12}/></button></footer>
    {toast && <div className="app-toast" role="status">{toast}{mode === 'work' && undoEventId && <button className="text-btn" onClick={() => void undo(undoEventId)}>{t('app.undoThisAction')}</button>}</div>}
    <SettingsModal isOpen={isSettingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} onSaveSettings={async s => { await TodoService.configure(!!s.remindersEnabled); await Repository.saveSettings(s); }} onConnectionChange={s => { stopModelRequest(); setConnection(s); }} onDataImported={dataImported}/>
    {exportProject && mode === 'work' && <AlignmentModal engagement={exportProject} tasks={exportTasks} onClose={() => setExportProject(null)} onNotice={setToast}/>}
    </div>
    <TrialInfoModal isOpen={trialInfoOpen} onClose={() => setTrialInfoOpen(false)} buildInfo={buildInfo} context={{ mode, phase: memoryOpen || (mode === 'life' && lifeTab === 'memory') ? 'memory' : mode === 'life' ? busy ? 'saving' : 'idle' : committing ? 'saving' : unknownCapture ? 'uncertain' : closure ? 'receipt' : pending ? 'review' : draftState?.draft.text.trim() ? 'draft' : 'idle', hasError: !!issue }}/>
    {practiceOpen && <Suspense fallback={<div className="modal-shade" role="status">{t('common.openingPractice')}</div>}><PracticeModal onClose={() => setPracticeOpen(false)}/></Suspense>}
  </div>;
}

function RecoveryScreen({ message }: { message: string }) {
  const { t } = useI18n();
  const [file, setFile] = useState<File>(); const [accepted, setAccepted] = useState(false); const [feedback, setFeedback] = useState('');
  async function restore() {
    try {
      if (window.electronAPI?.importDataBackup) { const result = await window.electronAPI.importDataBackup(); if (!result.canceled) location.reload(); }
      else if (file && await Repository.importAllData(await file.text())) location.reload(); else setFeedback(t('common.backupInvalidKeepOriginal'));
    } catch { setFeedback(t('common.restoreFailedKeepOriginal')); }
  }
  return <div className="recovery-screen"><h1>{t('common.recoveryTitle')}</h1><p>{message} {t('common.recoveryHint')}</p>{!window.electronAPI?.importDataBackup && <label>{t('common.selectRestoreBackup')}<input type="file" accept=".json" onChange={e => setFile(e.target.files?.[0])}/></label>}<label className="check-label"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)}/>{t('common.confirmReplaceSpaces')}</label><div className="button-row"><button className="primary-btn" disabled={!accepted} onClick={() => void restore()}>{t('common.verifyAndRestore')}</button><button className="soft-btn" onClick={() => location.reload()}><RotateCcw size={14}/>{t('common.reload')}</button></div>{feedback && <p role="status">{feedback}</p>}</div>;
}
export class AppBoundary extends React.Component<{children: React.ReactNode}, {failed: boolean}> {
  state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <RecoveryScreen message={t('common.boundaryFallbackNotice')}/> : this.props.children; }
}
export default App;
