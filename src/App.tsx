import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Settings, Minus, X, RotateCcw, BookOpen } from 'lucide-react';
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
import type { Engagement, ProjectTaskItem, ProposedChangeSet, WorkOperation, WorkspaceMode, CaptureDraft, ClosureRecord, WorkHome, WorkPartition, FollowUpItem, ConditionIntent, TodoRecord } from './types';
import type { ConditionLifecycleAction } from './services/conditionIntents';
import { TodoPanel } from './components/TodoPanel';
import { Companion } from './components/Companion';
import type { UpdateCheckResult, UpdatePlatform } from './services/appUpdate';
import buildInfo from '../shared/build-info.json';

const WorkBench = lazy(() => import('./components/WorkBench').then(m => ({ default: m.WorkBench })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then(m => ({ default: m.SettingsModal })));
const AlignmentModal = lazy(() => import('./components/AlignmentModal').then(m => ({ default: m.AlignmentModal })));
const TrialInfoModal = lazy(() => import('./components/TrialInfoModal').then(m => ({ default: m.TrialInfoModal })));
const PracticeModal = lazy(() => import('./components/PracticeModal').then(m => ({ default: m.PracticeModal })));
const ChatPill = lazy(() => import('./components/ChatPill').then(m => ({ default: m.ChatPill })));
const LivingCardsBoard = lazy(() => import('./components/LivingCardsBoard').then(m => ({ default: m.LivingCardsBoard })));
const CheckinBoard = lazy(() => import('./components/CheckinBoard').then(m => ({ default: m.CheckinBoard })));
const MemoryCenter = lazy(() => import('./components/MemoryCenter').then(m => ({ default: m.MemoryCenter })));
const id = () => crypto.randomUUID();

function hasActiveCheckinReminder() {
  return Repository.getCurrent().partitions.life.customCards.some(
    c => c.cardKind === 'checkin' && Boolean(c.dailyReminderTime) && !c.archived,
  );
}

declare global {
  interface Window {
    __loomaHandleBack?: () => boolean;
  }
}

export function App() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<AppSnapshotV5 | null>(null);
  const [startupError, setStartupError] = useState('');
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [home, setHome] = useState<WorkHome | null>(null);
  const [closure, setClosure] = useState<ClosureRecord | null>(null);
  const [projectLookup, setProjectLookup] = useState<{ query: string; requestId: string }>();
  const [committing, setCommitting] = useState(false);
  const [unknownCapture, setUnknownCapture] = useState(false);
  const [restoreNeedsRead, setRestoreNeedsRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issue, setIssueText] = useState('');
  const [issueReloadable, setIssueReloadable] = useState(false);
  const [toastState, setToastState] = useState<{ id: number; text: string; undoEventId: string } | null>(null);
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
  const [workDraftResumePending, setWorkDraftResumePending] = useState(false);
  const [workDraftDismissed, setWorkDraftDismissed] = useState(false);
  const [pendingTodoFloat, setPendingTodoFloat] = useState<TodoRecord | null>(null);
  const [todoFocus, setTodoFocus] = useState<{ space: WorkspaceMode; id: string; requestId: string }>();
  const [todoChoices, setTodoChoices] = useState<TodoRecord[]>([]);
  const [agentRetry, setAgentRetry] = useState<{ text: string; space: WorkspaceMode; sourceId: string; epoch: string; stage?: 'agent' | 'life-mutation' } | null>(null);
  const [todoChoiceAction, setTodoChoiceAction] = useState<'complete' | 'cancel' | 'time'>('complete');
  const [androidVersionInfo, setAndroidVersionInfo] = useState<{ versionCode?: number; versionName?: string }>({});
  const [updateCheck, setUpdateCheck] = useState<{ checking: boolean; result: UpdateCheckResult | null }>({ checking: false, result: null });
  const modeRef = useRef<WorkspaceMode>('life');
  const operation = useRef(0);
  const requestRef = useRef<string | null>(null);
  const controller = useRef<DraftController | null>(null);
  const unknownOriginalOnly = useRef(false);
  const controllerSubscription = useRef<(() => void) | null>(null);
  const homeSequence = useRef(0);
  const toastSeq = useRef(0);
  const lifeDraftRef = useRef('');
  lifeDraftRef.current = lifeDraft;

  const pending = draftState?.draft.proposal || null;
  const selectedId = draftState?.draft.selectedEngagementId || '';
  const mode = snapshot?.activeMode || 'life';
  modeRef.current = mode;

  function setIssue(message: string, reloadable = false) {
    setIssueText(message);
    setIssueReloadable(Boolean(message && reloadable));
  }

  function setToast(message: string) {
    setToastState(message ? { id: ++toastSeq.current, text: message, undoEventId: '' } : null);
  }

  function updateLifeDraft(text: string, expected?: string) {
    if (expected !== undefined && lifeDraftRef.current !== expected) return;
    lifeDraftRef.current = text;
    setLifeDraft(text);
    if (text) Repository.saveLifeDraft(text);
    else Repository.clearLifeDraft();
  }

  function installDraft(draft: CaptureDraft) {
    stopModelRequest();
    controllerSubscription.current?.();
    controller.current?.dispose();
    const next = createDraftController(draft, value => Repository.saveCaptureDraft(value));
    controller.current = next;
    setDraftState(next.getState());
    setWorkDraftResumePending(Boolean(draft.text.trim() || draft.proposal));
    controllerSubscription.current = next.subscribe(state => {
      setDraftState(state);
      setWorkDraftResumePending(Boolean(state.draft.text.trim() || state.draft.proposal));
    });
  }

  function changeDraft(patch: Partial<CaptureDraft>) {
    if (!controller.current || committing || unknownCapture) return;
    setSaved(false);
    controller.current.update(reviseCaptureDraft(controller.current.getState().draft, patch));
  }

  function setPending(value: ProposedChangeSet | null) {
    changeDraft({ proposal: value || undefined, conflicts: [], status: value ? 'review' : 'editing' });
  }

  function setSelectedId(value: string) {
    stopModelRequest();
    const hadClarification = !!controller.current?.getState().draft.proposal?.clarification;
    const currentText = controller.current?.getState().draft.text || '';
    changeDraft({ selectedEngagementId: value || undefined, ...(value ? { newClientName: undefined, newProjectTitle: undefined } : {}) });
    if (hadClarification && value && currentText.trim()) void propose(currentText);
  }

  async function refreshHome() {
    if (modeRef.current !== 'work') return;
    const sequence = ++homeSequence.current;
    try {
      const value = await Repository.getWorkHome();
      if (modeRef.current === 'work' && sequence === homeSequence.current) setHome(value);
    } catch {
      if (modeRef.current === 'work') setIssue(t('app.homeReadIncomplete'), true);
    }
  }

  const handleBackRef = useRef<() => boolean>(() => false);
  handleBackRef.current = () => {
    if (trialInfoOpen) { setTrialInfoOpen(false); return true; }
    if (practiceOpen) { setPracticeOpen(false); return true; }
    if (exportProject) { setExportProject(null); return true; }
    if (isSettingsOpen) { setSettingsOpen(false); return true; }
    if (memoryOpen) { void closeMemory(); return true; }
    return false;
  };

  useEffect(() => {
    window.__loomaHandleBack = () => handleBackRef.current();
    return () => { delete window.__loomaHandleBack; };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const root = document.documentElement;
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(hover: none) and (pointer: coarse)') : null;
    const syncPlatformAttrs = () => {
      const isAndroidHost = 'LoomaAndroid' in window;
      root.dataset.platform = isAndroidHost ? 'android' : window.electronAPI ? 'desktop' : 'web';
      root.dataset.touch = isAndroidHost || mq?.matches ? 'true' : 'false';
    };
    syncPlatformAttrs();
    window.addEventListener('resize', syncPlatformAttrs);
    if (mq?.addEventListener) mq.addEventListener('change', syncPlatformAttrs);
    else mq?.addListener?.(syncPlatformAttrs);
    return () => {
      window.removeEventListener('resize', syncPlatformAttrs);
      if (mq?.removeEventListener) mq.removeEventListener('change', syncPlatformAttrs);
      else mq?.removeListener?.(syncPlatformAttrs);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let ready = false;
    const update = () => { if (active && ready) setSnapshot(Repository.getCurrent()); };
    const unsubscribe = Repository.subscribe(update);
    void (async () => {
      try {
        const boot = await Repository.initialize();
        setLanguage(boot.snapshot.settings.language || 'zh-CN');
        // App contract: every launch boots into Life space (tested by tests/i18n-browser.test.cjs),
        // while unfinished Work drafts remain persisted and surface a non-intrusive resume pill.
        await Repository.saveWorkspaceMode('life');
        const storedWorkDraft = await Repository.getCaptureDraft();
        if (active) {
          setWorkDraftResumePending(Boolean(storedWorkDraft && (storedWorkDraft.text.trim() || storedWorkDraft.proposal)));
          if (boot.snapshot.activeMode === 'work') installDraft(storedWorkDraft || createCaptureDraft());
          const savedLifeDraft = Repository.getLifeDraft();
          if (savedLifeDraft) {
            lifeDraftRef.current = savedLifeDraft;
            setLifeDraft(savedLifeDraft);
          }
          ready = true;
          setSnapshot(Repository.getCurrent());
        }
        void window.electronAPI?.getAppVersionInfo?.().then(info => {
          if (active && info?.platform === 'android') {
            setAndroidVersionInfo({ versionCode: info.versionCode, versionName: info.versionName });
          }
        }).catch(() => {});
        try {
          const currentSettings = Repository.getCurrent().settings;
          await TodoService.configure(Boolean(currentSettings.remindersEnabled || hasActiveCheckinReminder()));
          await TodoService.syncLegacy();
          await syncCheckinReminders(Repository.getCurrent().partitions.life.customCards, TodoService);
        } catch {
          if (active) setIssue(translate(Repository.getCurrent().settings.language || 'zh-CN', 'app.reminderSyncSkipped'), true);
        }
      } catch {
        if (active) setStartupError(t('app.dbReadFailed'));
      }
    })();
    return () => {
      active = false;
      unsubscribe();
      controllerSubscription.current?.();
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);

  useEffect(() => { if (snapshot && mode === 'work') void refreshHome(); }, [mode, snapshot?.partitions.work.revision, !!snapshot]);

  useEffect(() => {
    const beforeLeave = (event: BeforeUnloadEvent) => {
      const value = controller.current?.getState();
      if (value && ['unsaved', 'saving', 'error'].includes(value.status)) {
        event.preventDefault();
        event.returnValue = '';
        void controller.current?.flush().catch(() => {});
      }
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
      try {
        await controller.current?.flush();
        await api.confirmClose(true, requestId);
      } catch {
        setIssue(t('app.draftNotSavedKeepInWindow'));
        await api.confirmClose(false, requestId);
      }
    });
  }, []);

  useEffect(() => {
    if (!toastState) return;
    const duration = toastState.undoEventId ? 8000 : 5000;
    const timer = setTimeout(() => setToastState(null), duration);
    return () => clearTimeout(timer);
  }, [toastState?.id]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3500);
    return () => clearTimeout(timer);
  }, [saved]);

  useEffect(() => {
    if (!snapshot || !window.electronAPI) return;
    let active = true;
    const api = window.electronAPI;
    void (async () => {
      try {
        const warning = await migrateLegacyCredential(api, localStorage, snapshot.settings);
        if (active && warning) setIssue(warning);
        const status = await api.modelStatus();
        if (active) setConnection(status);
        await api.setAlwaysOnTop(snapshot.settings.alwaysOnTop);
        if (!('LoomaAndroid' in window)) await api.setContentProtection?.(!!snapshot.settings.contentProtection);
      } catch {
        if (active) setIssue(t('app.desktopModelUnavailable'));
      }
    })();
    return () => { active = false; };
  }, [!!snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const unsubscribe = Repository.subscribe(() => {
      void TodoService.syncLegacy().catch(() => setIssue(t('app.legacySyncIncomplete'), true));
    });
    return unsubscribe;
  }, [!!snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const focus = (target: { space: WorkspaceMode; id: string }) => {
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
    window.addEventListener('looma:todo-focus', foregroundFocus);
    return () => {
      unsubscribe?.();
      window.removeEventListener('looma:todo-focus', foregroundFocus);
    };
  }, [!!snapshot, committing, unknownCapture]);

  function stopModelRequest() {
    invalidateAgentCaptures();
    operation.current++;
    const requestId = requestRef.current;
    requestRef.current = null;
    setBusy(false);
    if (requestId) void window.electronAPI?.cancelModel(requestId).catch(() => {});
  }

  function recorded(message: string, eventId?: string) {
    setSaved(true);
    setToastState(message ? { id: ++toastSeq.current, text: message, undoEventId: eventId || '' } : null);
  }

  async function toggleCompact(next = !compact) {
    try {
      await window.electronAPI?.setCompact?.(next);
      setCompact(next);
    } catch {
      setIssue(t('app.compactFailed'));
    }
  }

  async function flushDraft() { await controller.current?.flush(); }

  async function openMemory() {
    if (committing || unknownCapture) return;
    stopModelRequest();
    try {
      await flushDraft();
      await toggleCompact(false);
      setMemoryOpen(true);
    } catch {
      setIssue(t('app.leaveWithoutDraftSave'));
    }
  }

  async function closeMemory() {
    try {
      if (modeRef.current === 'work' && controller.current) {
        const stored = await Repository.getCaptureDraft();
        if (!stored && controller.current.getState().draft.text.trim()) {
          installDraft(createCaptureDraft());
          setToast(t('app.sourceDeletedClearedDraft'));
        }
      }
      setMemoryOpen(false);
      await refreshHome();
    } catch {
      setIssue(t('app.draftStatusUnavailable'));
    }
  }

  function toggleMemoryFromHeader() {
    if (memoryOpen) { void closeMemory(); return; }
    if (mode === 'life' && lifeTab === 'memory') { setLifeTab('chat'); return; }
    void openMemory();
  }

  async function handleCheckForUpdates() {
    if (updateCheck.checking) return;
    const runtimePlatform: UpdatePlatform = typeof window !== 'undefined' && 'LoomaAndroid' in window
      ? 'android'
      : typeof window !== 'undefined' && window.electronAPI
        ? 'desktop'
        : 'web';
    setUpdateCheck(prev => ({ ...prev, checking: true }));
    let currentCode = androidVersionInfo.versionCode;
    let currentVer = androidVersionInfo.versionName || buildInfo.productVersion;
    const { GITHUB_RELEASES_PAGE_URL, checkForAppUpdates } = await import('./services/appUpdate');
    try {
      if (runtimePlatform === 'android' && !currentCode && window.electronAPI?.getAppVersionInfo) {
        try {
          const nativeInfo = await window.electronAPI.getAppVersionInfo();
          if (nativeInfo?.versionCode) currentCode = nativeInfo.versionCode;
          if (nativeInfo?.versionName) currentVer = nativeInfo.versionName;
          setAndroidVersionInfo({ versionCode: currentCode, versionName: nativeInfo?.versionName });
        } catch { /* fallback to buildInfo.productVersion */ }
      }
      const result = await checkForAppUpdates({
        platform: runtimePlatform,
        currentVersion: currentVer,
        currentAndroidVersionCode: currentCode,
        electronAPI: typeof window !== 'undefined' ? window.electronAPI : undefined,
      });
      setUpdateCheck({ checking: false, result });
    } catch (error) {
      setUpdateCheck({
        checking: false,
        result: {
          outcome: 'error',
          platform: runtimePlatform,
          checkedAt: new Date().toISOString(),
          currentVersion: currentVer,
          ...(currentCode ? { currentVersionCode: currentCode } : {}),
          releaseUrl: GITHUB_RELEASES_PAGE_URL,
          errorMessage: error instanceof Error ? error.message : undefined,
        },
      });
    }
  }

  async function handleOpenUpdateUrl(url: string) {
    const { openReleaseExternalUrl } = await import('./services/appUpdate');
    return openReleaseExternalUrl(url, typeof window !== 'undefined' ? window.electronAPI : undefined);
  }

  async function openSettings() {
    if (committing || unknownCapture) return;
    stopModelRequest();
    try {
      await flushDraft();
      setSettingsOpen(true);
    } catch {
      setIssue(t('app.draftUnconfirmedBeforeAction'));
    }
  }

  async function openPractice() {
    if (committing || unknownCapture || restoreNeedsRead) return;
    stopModelRequest();
    try {
      await flushDraft();
      setPracticeOpen(true);
    } catch {
      setIssue(t('app.draftUnconfirmedBeforePractice'));
    }
  }

  async function switchMode(next: WorkspaceMode) {
    if (committing || unknownCapture) return false;
    stopModelRequest();
    setExportProject(null);
    setMemoryOpen(false);
    setIssue('');
    setToast('');
    setSaved(false);
    try {
      await flushDraft();
      if (next === 'work' && !controller.current) installDraft(await Repository.getCaptureDraft() || createCaptureDraft());
      await Repository.saveWorkspaceMode(next);
      modeRef.current = next;
      return true;
    } catch {
      setIssue(t('app.switchBlockedUnsaved'));
      return false;
    }
  }

  async function propose(text: string) {
    if ((busy && !requestRef.current) || committing || unknownCapture || !controller.current) return;
    if (requestRef.current) stopModelRequest();
    setIssue('');
    setClosure(null);
    let draft = controller.current.getState().draft;
    if (draft.text !== text) { changeDraft({ text }); draft = controller.current.getState().draft; }
    const generation = ++operation.current, sourceId = draft.sourceMessageId;
    setBusy(true);
    try {
      await flushDraft();
      await Repository.saveMessages([{ id: sourceId, role: 'user', content: text, timestamp: draft.updatedAt }], 'work');
      setSaved(true);
      const hasProjectContext = Boolean(draft.selectedEngagementId || draft.newClientName?.trim() || draft.newProjectTitle?.trim());
      const captureEpoch = Repository.getReadIdentity().split(':')[0];
      if (!hasProjectContext && connection?.enabled && connection.configured) requestRef.current = sourceId;
      const todo = hasProjectContext
        ? { handled: false, needsReview: true, created: undefined, needsTime: undefined, needsChoice: undefined, choiceAction: undefined, silent: false, message: undefined, warning: undefined }
        : await capturePersonalText({ text, space: 'work', sourceId, turns: Repository.getCurrent().partitions.work.messages, contextTaskId: todoFocus?.space === 'work' ? todoFocus.id : undefined }, !!connection?.enabled && !!connection?.configured);
      if (requestRef.current === sourceId) requestRef.current = null;
      if (captureEpoch !== Repository.getReadIdentity().split(':')[0]) return;
      if (operation.current !== generation || modeRef.current !== 'work') return;
      if (todo.handled && !todo.needsReview) {
        if (todo.warning) { setIssue(todo.warning); setAgentRetry({ text, space: 'work', sourceId, epoch: captureEpoch }); }
        const closed = await Repository.commitCapture(draft, true);
        if (closed.outcome !== 'committed') {
          setUnknownCapture(closed.outcome === 'unknown');
          unknownOriginalOnly.current = true;
          throw new Error(closed.error || t('app.saveFailedPrefix'));
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
      const local = StateEngine.propose(text, {
        mode: 'work',
        sourceMessageId: sourceId,
        partition,
        now: Date.now(),
        selectedEngagementId: draft.selectedEngagementId,
        newClientName: draft.newClientName,
        newProjectTitle: draft.newProjectTitle,
      });
      if (!local.operations.length && !todo.needsReview && !hasProjectContext && !extractClientNames(text).length && !/预算|成交|签约|需求确认|阶段|万元|客户.*项目/.test(text)) {
        if (todo.warning) { setIssue(todo.warning); setAgentRetry({ text, space: 'work', sourceId, epoch: captureEpoch }); }
        const closed = await Repository.commitCapture(draft, true);
        if (closed.outcome !== 'committed') {
          setUnknownCapture(closed.outcome === 'unknown');
          unknownOriginalOnly.current = true;
          throw new Error(closed.error || t('app.saveFailedPrefix'));
        }
        if (operation.current === generation && modeRef.current === 'work') {
          installDraft(createCaptureDraft());
          recorded(t('app.noteSaved'));
        }
        return;
      }
      setPending(local);
      if (!local.clarification && connection?.enabled && connection.configured && window.electronAPI) {
        const requestId = id();
        requestRef.current = requestId;
        try {
          const selected = partition.engagements.find(item => item.id === draft.selectedEngagementId);
          const context = selected ? {
            id: selected.id,
            clientName: selected.clientName,
            title: selected.title,
            budgetAmount: selected.budgetAmount,
            stage: selected.stage,
            shareableSummary: selected.shareableSummary,
            nextAction: selected.nextAction,
          } : null;
          const result = await window.electronAPI.proposeModel({ requestId, text, context, now: new Date().toISOString() });
          if (operation.current === generation && modeRef.current === 'work') {
            setPending(parseModelProposal(result.content, local, partition, draft.selectedEngagementId));
          }
        } catch (error) {
          if (operation.current === generation && modeRef.current === 'work') {
            setIssue(`${error instanceof Error ? error.message : t('app.modelFailedFallback')} ${t('app.localKeptSuffix')}`);
          }
        }
      }
    } catch (error) {
      if (operation.current === generation && modeRef.current === 'work') {
        setIssue(t('app.proposeIncompletePrefix') + ' ' + (error instanceof Error ? error.message : t('app.retryKeepingInput')));
      }
    } finally {
      if (operation.current === generation) { requestRef.current = null; setBusy(false); }
    }
  }

  async function manual(operations: WorkOperation[], sourceText: string) {
    if (committing || unknownCapture || !controller.current) return;
    stopModelRequest();
    setIssue('');
    if (controller.current.getState().draft.text.trim() || controller.current.getState().draft.proposal) {
      setIssue(t('app.unfinishedCaptureWarning'));
      return;
    }
    try {
      const generation = ++operation.current;
      const targetId = operations.find(item => item.target === 'engagement')?.entityId ||
        operations.find(item => item.target === 'task' || item.target === 'followup' || item.target === 'condition')?.after?.engagementId;
      changeDraft({ text: sourceText, selectedEngagementId: targetId });
      const draft = controller.current.getState().draft;
      const proposal = await Repository.createProposal('work', operations, sourceText, draft.sourceMessageId);
      if (operation.current !== generation || modeRef.current !== 'work' || controller.current?.getState().draft.draftVersion !== draft.draftVersion) return;
      setClosure(null);
      setPending(proposal);
    } catch {
      setIssue(t('app.projectReadFailed'), true);
    }
  }

  async function saveCapture(originalOnly = false) {
    if (committing || !controller.current) return;
    stopModelRequest();
    setCommitting(true);
    setIssue('');
    try {
      await flushDraft();
      const draft = controller.current.getState().draft;
      const result = await Repository.commitCapture(draft, originalOnly);
      if (result.outcome === 'committed') {
        setUnknownCapture(false);
        installDraft(createCaptureDraft());
        if (result.closureId) {
          try {
            const record = await Repository.get<ClosureRecord>('work', 'closure', result.closureId);
            if (modeRef.current === 'work') setClosure(record);
          } catch {
            setIssue(t('app.savedReceiptUnread'), true);
          }
        }
        if (result.refreshWarning) setIssue(result.refreshWarning, true);
        if (modeRef.current === 'work') recorded(originalOnly ? t('app.savedOriginalOnlyToast') : t('app.savedReviewedToast'), result.eventId);
        await refreshHome();
      } else {
        setUnknownCapture(result.outcome === 'unknown');
        unknownOriginalOnly.current = originalOnly;
        setIssue(result.error || t('app.saveUnconfirmedFallback'));
      }
    } catch (error) {
      setIssue(t('app.draftSaveErrorPrefix') + (error instanceof Error ? error.message : ''));
    } finally {
      setCommitting(false);
    }
  }

  async function undo(eventId?: string) {
    if (committing || unknownCapture) return;
    stopModelRequest();
    try {
      const result: any = await Repository.undo('work', eventId);
      if (modeRef.current !== 'work') return;
      if (!result.ok) { setIssue(result.error || t('app.undoFailedKeepOriginal')); return; }
      setIssue(result.refreshWarning || '', Boolean(result.refreshWarning));
      recorded(t('app.undoSuccessToast'));
      if (closure) setClosure(await Repository.get<ClosureRecord>('work', 'closure', closure.id));
      await refreshHome();
    } catch {
      setIssue(t('app.undoReadFailed'), true);
    }
  }

  async function setItemState(kind: 'task' | 'followup', item: ProjectTaskItem | FollowUpItem, done: boolean) {
    if (committing || unknownCapture) return;
    const result = await Repository.setItemState(kind, item, done);
    if (modeRef.current !== 'work') return;
    if (result.outcome !== 'committed') { setIssue(result.error || t('app.itemStateUnconfirmed')); throw new Error(result.error); }
    setIssue(result.refreshWarning || '', Boolean(result.refreshWarning));
    if (done) setToast(''); else recorded(t('app.reopenedToast'), result.eventId);
    try { await TodoService.syncLegacy(); } catch { setIssue(t('app.workSavedSyncFailed'), true); }
    await refreshHome();
  }

  async function setConditionState(item: ConditionIntent, action: ConditionLifecycleAction | 'convert_to_task') {
    if (committing || unknownCapture) return;
    const result = await Repository.setConditionState(item, action);
    if (modeRef.current !== 'work') return;
    if (result.outcome !== 'committed') { setIssue(result.error || t('app.conditionStateUnconfirmed')); throw new Error(result.error); }
    setIssue(result.refreshWarning || '', Boolean(result.refreshWarning));
    recorded(action === 'convert_to_task' ? t('app.conditionConvertedToast') : t('app.conditionUpdatedToast'), result.eventId);
    await refreshHome();
  }

  async function reparse() {
    const draft = controller.current?.getState().draft;
    if (!draft?.proposal || committing || unknownCapture) return;
    stopModelRequest();
    const generation = ++operation.current;
    try {
      await Repository.refresh('work');
      const partition: WorkPartition = { ...Repository.getCurrent().partitions.work, engagements: [], tasks: [], followUps: [], conditions: [], memories: [] };
      for (const target of ['engagement', 'task', 'followup', 'condition', 'memory'] as const) {
        const ids = draft.proposal.operations.filter(item => item.target === target).map(item => item.entityId);
        const rows: any[] = [];
        for (let index = 0; index < ids.length; index += 200) {
          rows.push(...(await Repository.query('work', target, { ids: ids.slice(index, index + 200), limit: 200 })).items);
        }
        if (target === 'engagement') partition.engagements = rows;
        else if (target === 'task') partition.tasks = rows;
        else if (target === 'followup') partition.followUps = rows;
        else if (target === 'condition') partition.conditions = rows;
        else partition.memories = rows;
      }
      const current = controller.current?.getState().draft;
      if (operation.current !== generation || modeRef.current !== 'work' || current?.sessionId !== draft.sessionId || current.draftVersion !== draft.draftVersion) return;
      const result = rebaseProposal(draft.proposal, partition);
      changeDraft({ proposal: result.proposal, conflicts: result.conflicts, status: 'review' });
      setIssue('');
    } catch {
      setIssue(t('app.reparseReadIncomplete'), true);
    }
  }

  function resolveConflict(conflictId: string, choice: 'current' | 'proposed') {
    const draft = controller.current?.getState().draft;
    if (!draft?.proposal) return;
    const result = resolveProposalConflict(draft.proposal, draft.conflicts || [], conflictId, choice);
    changeDraft({ proposal: result.proposal, conflicts: result.conflicts, status: 'review' });
  }

  function continueCapture() { if (!committing && !unknownCapture) { setClosure(null); setIssue(''); } }
  function editBusiness(query: string) { setClosure(null); setMemoryOpen(false); setProjectLookup({ query, requestId: id() }); }

  async function dataImported() {
    setAgentRetry(null);
    stopModelRequest();
    setUnknownCapture(false);
    setClosure(null);
    setHome(null);
    setExportProject(null);
    lifeDraftRef.current = '';
    setLifeDraft('');
    controllerSubscription.current?.();
    controller.current?.dispose();
    controller.current = null;
    setDraftState(null);
    try {
      const storedWorkDraft = await Repository.getCaptureDraft();
      installDraft(storedWorkDraft || createCaptureDraft());
      const importedSettings = Repository.getCurrent().settings;
      setLanguage(importedSettings.language || 'zh-CN');
      await TodoService.configure(Boolean(importedSettings.remindersEnabled || hasActiveCheckinReminder()));
      await syncCheckinReminders(Repository.getCurrent().partitions.life.customCards, TodoService).catch(() => {});
      setSnapshot(Repository.getCurrent());
      setRestoreNeedsRead(false);
      const warn = Repository.getRestoreWarning() || '';
      setIssue(warn, Boolean(warn));
      TodoService.refresh();
      await refreshHome();
    } catch {
      setRestoreNeedsRead(true);
      setSnapshot(Repository.getCurrent());
      setIssue(t('app.restoreViewUnread'), true);
    }
  }

  async function sendLife(text: string) {
    if (busy) throw new Error(t('app.previousSaveInFlight'));
    const sourceId = id(), generation = ++operation.current;
    setBusy(true);
    setIssue('');
    let originalSaved = false;
    let failureStage: 'agent' | 'life-mutation' = 'agent';
    const originalEpoch = Repository.getReadIdentity().split(':')[0];
    const routes = routeLifeInput(text);
    const hasFacts = routes.some(part => part.route === 'fact');
    const actionText = lifeActionText(text);
    try {
      await Repository.saveMessages([{ id: sourceId, role: 'user', content: text, timestamp: Date.now() }], 'life');
      originalSaved = true;
      setSaved(true);
      if (!actionText) clearLifeCaptureFocus();
      if (!actionText && !hasFacts) return;
      const captureEpoch = Repository.getReadIdentity().split(':')[0];
      if (actionText && connection?.enabled && connection.configured) requestRef.current = sourceId;
      const todo = actionText
        ? await capturePersonalText({ text: actionText, space: 'life', sourceId, turns: Repository.getCurrent().partitions.life.messages, contextTaskId: todoFocus?.space === 'life' ? todoFocus.id : undefined }, !!connection?.enabled && !!connection?.configured)
        : undefined;
      if (requestRef.current === sourceId) requestRef.current = null;
      if (captureEpoch !== Repository.getReadIdentity().split(':')[0]) return;
      if (operation.current !== generation || modeRef.current !== 'life') return;
      if (todo?.warning) {
        setAgentRetry({ text, space: 'life', sourceId, epoch: captureEpoch });
        if (modeRef.current === 'life') setIssue(todo.warning);
      }
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
      if (!hasFacts) return;
      failureStage = 'life-mutation';
      const mutations = await Repository.updateLifeAtomically(life => StateEngine.mutateLifeDraft(text, life), sourceId, text);
      if (!mutations.length) return;
      const lifeCards = Repository.getCurrent().partitions.life.customCards;
      if (lifeCards.some(c => c.cardKind === 'checkin')) {
        if (lifeCards.some(c => c.cardKind === 'checkin' && Boolean(c.dailyReminderTime) && !c.archived)) {
          await TodoService.configure(true).catch(() => {});
        }
        await syncCheckinReminders(lifeCards, TodoService).catch(() => {});
      }
      const reply = mutations.map(m => m.summaryText).join('\n');
      try {
        await Repository.saveMessages([{ id: id(), role: 'assistant', content: reply, timestamp: Date.now(), mutations }], 'life');
      } catch {
        if (modeRef.current === 'life') setIssue(t('app.lifeReplySaveFailed'));
      }
      if (modeRef.current === 'life') recorded(t('app.lifeSavedToast'));
    } catch (error) {
      if (originalSaved) {
        if (originalEpoch === Repository.getReadIdentity().split(':')[0]) {
          setAgentRetry({ text, space: 'life', sourceId, epoch: originalEpoch, stage: failureStage });
          if (modeRef.current === 'life') setIssue(t('app.lifeOriginalSavedPendingParse'));
        }
        return;
      }
      const message = t('app.lifeOriginalNotSaved');
      if (modeRef.current === 'life') setIssue(message);
      throw new Error(error instanceof Error ? `${message} ${error.message}` : message);
    } finally {
      if (generation === operation.current) setBusy(false);
    }
  }

  async function retryAgentCapture() {
    const input = agentRetry;
    if (!input || busy) return;
    if (input.epoch !== Repository.getReadIdentity().split(':')[0]) { setAgentRetry(null); return; }
    const generation = ++operation.current;
    if (input.stage !== 'life-mutation' && connection?.enabled && connection.configured) requestRef.current = input.sourceId;
    setBusy(true);
    try {
      if (input.stage === 'life-mutation') {
        const prior = await Repository.get('life', 'event', `event-life:${input.sourceId}`);
        if (input.epoch !== Repository.getReadIdentity().split(':')[0] || operation.current !== generation || modeRef.current !== 'life') return;
        if (!prior) await Repository.updateLifeAtomically(life => StateEngine.mutateLifeDraft(input.text, life), input.sourceId, input.text);
        if (operation.current === generation && modeRef.current === 'life') { setAgentRetry(null); setIssue(''); }
        return;
      }
      const retryText = input.space === 'life' ? lifeActionText(input.text) : input.text;
      if (!retryText) { setAgentRetry(null); return; }
      const result = await capturePersonalText({ ...input, text: retryText, turns: Repository.getCurrent().partitions[input.space].messages }, !!connection?.enabled && !!connection?.configured);
      if (input.epoch !== Repository.getReadIdentity().split(':')[0] || operation.current !== generation || modeRef.current !== input.space) return;
      if (result.warning) setIssue(result.warning);
      else {
        setAgentRetry(null);
        setIssue(result.needsReview ? t('app.reviewRequiredNotice') : '');
        if (result.silent) setToast('');
      }
      TodoService.refresh();
    } catch {
      if (operation.current === generation) setIssue(t('app.lifeRetryLater'));
    } finally {
      if (requestRef.current === input.sourceId) requestRef.current = null;
      if (operation.current === generation) setBusy(false);
    }
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
    if (!snapshot?.settings.memoryModelEnabled || !connection?.enabled || !connection?.configured || !window.electronAPI?.recallModel) {
      throw new Error(t('app.recallNeedEnable'));
    }
    const requestId = id(), sourceMode = modeRef.current;
    requestRef.current = requestId;
    setBusy(true);
    try {
      const result = await window.electronAPI.recallModel({ requestId, query, space: sourceMode, evidence: evidence.items });
      if (modeRef.current !== sourceMode || requestRef.current !== requestId) throw new Error(t('app.recallCancelledBySwitch'));
      return result.content;
    } finally {
      if (requestRef.current === requestId) { requestRef.current = null; setBusy(false); }
    }
  }

  if (!snapshot) return startupError ? <RecoveryScreen message={startupError} /> : <div className="recovery-screen" role="status">{t('common.loadingWorkspace')}</div>;

  const { settings } = snapshot, work = snapshot.partitions.work, life = snapshot.partitions.life, stats = Repository.getStats();
  const reminderCount = mode === 'work' ? (stats.dueTasks || 0) + (stats.dueFollowUps || 0) : 0;
  const state = deriveCompanionState({ busy: busy || committing, pending: mode === 'work' && !!pending, saved, error: issue, reminderCount });
  const companion = <Companion state={state} mode={mode} name={settings.personaName} reminderCount={reminderCount} onOpenMemory={mode === 'life' ? () => void openMemory() : undefined} />;
  const isMobileOrAndroid = typeof navigator !== 'undefined' && (/android|iphone|ipad|ipod/i.test(navigator.userAgent) || (typeof window !== 'undefined' && ('LoomaNative' in window || 'LoomaAndroid' in window)) || (typeof window !== 'undefined' && window.innerWidth < 768));

  const effectiveBuildInfo = {
    ...buildInfo,
    ...(androidVersionInfo.versionName ? { productVersion: androidVersionInfo.versionName } : {}),
    ...(androidVersionInfo.versionCode ? { androidVersionCode: androidVersionInfo.versionCode } : {}),
  };

  if (compact && !isMobileOrAndroid) {
    return (
      <div className="capsule-shell drag-region">
        <Companion compact state={state} mode={mode} name={settings.personaName} reminderCount={reminderCount} onToggle={() => void toggleCompact(false)} onOpenMemory={() => void openMemory()} />
      </div>
    );
  }

  const modalOpen = practiceOpen || trialInfoOpen || isSettingsOpen || Boolean(exportProject);
  const memoryModelReady = !!settings.memoryModelEnabled && !!connection?.enabled && !!connection?.configured;
  const trialContext = {
    mode,
    phase: memoryOpen || (mode === 'life' && lifeTab === 'memory')
      ? 'memory'
      : mode === 'life'
        ? (busy ? 'saving' : 'idle')
        : committing
          ? 'saving'
          : unknownCapture
            ? 'uncertain'
            : closure
              ? 'receipt'
              : pending
                ? 'review'
                : draftState?.draft.text.trim()
                  ? 'draft'
                  : 'idle',
    hasError: !!issue,
  } as const;

  const modalFallback = (
    <div className="modal-shade" role="status">
      <div className="sheet-shell">
        <div className="sheet-body">
          <p className="muted small">{t('common.loadingWorkspace')}</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className={`app-shell ${mode === 'life' ? 'life-shell' : 'work-shell'}`}>
      <div className="workspace-content" inert={modalOpen}>
        <header className="app-header drag-region">
          <div className="app-header-left no-drag">
            <a className="wordmark" href="#" onClick={e => e.preventDefault()}>looma</a>
            <div className={`space-switch ${mode === 'work' ? 'space-switch--work' : ''}`} aria-label={t('header.workspaceAria')}>
              <button type="button" className={mode === 'work' ? 'active' : ''} aria-label={t('header.workMode')} aria-pressed={mode === 'work'} onClick={() => void switchMode('work')}>{t('header.workModeShort')}</button>
              <button type="button" className={mode === 'life' ? 'active' : ''} aria-label={t('header.lifeMode')} aria-pressed={mode === 'life'} onClick={() => void switchMode('life')}>{t('header.lifeModeShort')}</button>
            </div>
          </div>
          <div className="header-tools no-drag">
            <button
              type="button"
              className="icon-btn"
              onClick={toggleMemoryFromHeader}
              aria-label={t('header.openMemory')}
              aria-pressed={memoryOpen || (mode === 'life' && lifeTab === 'memory')}
            >
              <BookOpen size={16} />
            </button>
            <button type="button" className="icon-btn" onClick={() => void openSettings()} aria-label={t('header.openSettings')}>
              <Settings size={16} />
            </button>
            {window.electronAPI && !isMobileOrAndroid && (
              <button type="button" className="icon-btn" onClick={() => void window.electronAPI!.minimizeWindow()} aria-label={t('header.minimize')}>
                <Minus size={16} />
              </button>
            )}
            {window.electronAPI && (
              <button type="button" className="icon-btn" onClick={() => void window.electronAPI!.closeWindow()} aria-label={t('header.quitApp')}>
                <X size={16} />
              </button>
            )}
          </div>
        </header>

        <main>
          {(issue || agentRetry?.space === mode) && (
            <div className="app-alert" role="alert">
              <span>{issue || t('app.agentRetryNotice')}</span>
              <div className="button-row">
                {unknownCapture ? (
                  <button type="button" className="text-btn" disabled={committing} onClick={() => void saveCapture(unknownOriginalOnly.current)}>
                    {t('app.checkSaveResult')}
                  </button>
                ) : (restoreNeedsRead || issueReloadable) && (
                  <button
                    type="button"
                    className="text-btn"
                    onClick={async () => {
                      try {
                        if (restoreNeedsRead) { await dataImported(); }
                        else { await Repository.refresh(mode); await refreshHome(); setIssue(''); }
                      } catch {
                        setIssue(t('app.reloadDataFailed'), true);
                      }
                    }}
                  >
                    {t('common.reload')}
                  </button>
                )}
                {agentRetry?.space === mode && (
                  <>
                    <button type="button" className="text-btn" disabled={busy} onClick={() => void retryAgentCapture()}>
                      {t('app.agentRetryBtn')}
                    </button>
                    <button type="button" className="text-btn" onClick={() => { setAgentRetry(null); if (!unknownCapture) setIssue(''); }}>
                      {t('app.agentLeaveLater')}
                    </button>
                  </>
                )}
                {!(agentRetry?.space === mode && !issue) && (
                  <button type="button" className="text-btn" disabled={unknownCapture} onClick={() => setIssue('')}>
                    {t('common.collapse')}
                  </button>
                )}
              </div>
            </div>
          )}

          {memoryOpen ? (
            <>
              <button type="button" className="text-btn" onClick={() => void closeMemory()}>{t('common.backToSpace')}</button>
              <Suspense fallback={<p>{t('common.openingMemory')}</p>}>
                <MemoryCenter
                  key={mode}
                  mode={mode}
                  onNotice={setToast}
                  modelEnabled={memoryModelReady}
                  connectionConfigured={!!connection?.configured}
                  onModelRecall={modelRecall}
                  onEditBusiness={mode === 'work' ? editBusiness : undefined}
                />
              </Suspense>
            </>
          ) : mode === 'work' ? (
            <Suspense fallback={<p className="muted small" role="status">{t('common.loadingWorkspace')}</p>}>
              <WorkBench
                onPractice={() => void openPractice()}
                onRetryDraft={() => { void flushDraft().then(() => setIssue('')).catch(() => setIssue(t('app.draftRetryError'))); }}
                projectLookup={projectLookup}
                draft={draftState?.draft || null}
                draftSaveState={draftState?.status || 'idle'}
                home={home}
                closure={closure}
                onDraftChange={patch => { stopModelRequest(); changeDraft(patch); }}
                onContinue={continueCapture}
                onResume={() => setClosure(null)}
                onOriginalOnly={() => saveCapture(true)}
                onRebase={() => void reparse()}
                onResolveConflict={resolveConflict}
                onSetItemState={setItemState}
                onSetConditionState={setConditionState}
                onUndoEvent={eventId => void undo(eventId)}
                onOpenMemory={() => void openMemory()}
                onOpenClosure={setClosure}
                modelBusy={busy && !!requestRef.current}
                work={work}
                stats={stats}
                companion={companion}
                pending={pending}
                busy={committing || unknownCapture || restoreNeedsRead || (busy && !pending)}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onPropose={propose}
                onChange={p => { stopModelRequest(); setPending(p); }}
                onConfirm={() => void saveCapture()}
                onDiscard={() => { stopModelRequest(); setPending(null); setIssue(''); }}
                onReparse={() => void reparse()}
                onManual={(ops, text) => void manual(ops, text)}
                onUndo={() => void undo()}
                onExport={async project => {
                  try {
                    const tasks: ProjectTaskItem[] = [];
                    let cursor: string | undefined;
                    do {
                      const page = await Repository.query<ProjectTaskItem>('work', 'task', { relatedId: project.id, limit: 200, cursor });
                      tasks.push(...page.items);
                      cursor = page.nextCursor || undefined;
                    } while (cursor);
                    if (modeRef.current === 'work') { setExportProject(project); setExportTasks(tasks); }
                  } catch {
                    setIssue(t('app.linkedActionsReadFailed'), true);
                  }
                }}
                modelEnabled={!!connection?.enabled && !!connection?.configured}
                workSuggestionsEnabled={settings.workSuggestionsEnabled ?? true}
                onCancel={() => { stopModelRequest(); setIssue(t('app.modelCancelled')); }}
              />
            </Suspense>
          ) : (
            <section className="life-workspace">
              {workDraftResumePending && !workDraftDismissed && (
                <div className="notice" role="region" aria-label={t('app.workDraftResumePill')} style={{ maxWidth: 450, margin: '0 auto 10px', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>{t('app.workDraftResumePill')}</span>
                  <div className="button-row">
                    <button type="button" className="soft-btn" onClick={() => void switchMode('work')}>{t('app.workDraftResumeBtn')}</button>
                    <button type="button" className="icon-btn" aria-label={t('app.dismissBannerAria')} onClick={() => setWorkDraftDismissed(true)}>
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}
              <div className="life-tabs-wrapper">
                <nav className="life-tabs" aria-label={t('app.lifeTabsAria')}>
                  {[['chat', t('app.lifeTabChat')], ['todos', t('app.lifeTabTodos')], ['checkins', t('app.lifeTabCheckins')], ['cards', t('app.lifeTabCards')], ['memory', t('app.lifeTabMemory')]].map(([tab, label]) => (
                    <button key={tab} type="button" className={lifeTab === tab ? 'active' : ''} onClick={() => setLifeTab(tab)}>{label}</button>
                  ))}
                </nav>
              </div>
              <div className="life-panel" key={lifeTab}>
                <Suspense fallback={<p className="muted small">{t('common.openingLifeSpace')}</p>}>
                  {lifeTab === 'chat' && (
                    <ChatPill
                      messages={life.messages}
                      settings={settings}
                      mode="life"
                      isLoading={busy}
                      onSendMessage={sendLife}
                      draftText={lifeDraft}
                      onDraftTextChange={updateLifeDraft}
                      onInspectMutation={() => setLifeTab('cards')}
                      onOpenCards={() => setLifeTab('cards')}
                      pendingTodo={pendingTodoFloat}
                      onApproveTodo={approveLifeTodo}
                      onDismissPendingTodo={() => setPendingTodoFloat(null)}
                      onOpenTodos={() => setLifeTab('todos')}
                    />
                  )}
                  {lifeTab === 'todos' && (
                    <TodoPanel
                      key="life"
                      space="life"
                      focusId={todoFocus?.space === 'life' ? todoFocus.id : undefined}
                      focusRequestId={todoFocus?.requestId}
                      choices={todoChoices.filter(todo => todo.space === 'life')}
                      choiceAction={todoChoiceAction}
                      onChoiceDone={() => setTodoChoices([])}
                      onError={setIssue}
                    />
                  )}
                  {lifeTab === 'checkins' && <CheckinBoard onCompanionToast={recorded} />}
                  {lifeTab === 'cards' && <LivingCardsBoard mode="life" onCompanionToast={recorded} />}
                  {lifeTab === 'memory' && (
                    <MemoryCenter
                      mode="life"
                      onNotice={setToast}
                      modelEnabled={memoryModelReady}
                      connectionConfigured={!!connection?.configured}
                      onModelRecall={modelRecall}
                    />
                  )}
                </Suspense>
              </div>
            </section>
          )}

          {mode === 'work' && (
            <TodoPanel
              key="work"
              space="work"
              focusId={todoFocus?.space === 'work' ? todoFocus.id : undefined}
              focusRequestId={todoFocus?.requestId}
              choices={todoChoices.filter(todo => todo.space === 'work')}
              choiceAction={todoChoiceAction}
              onChoiceDone={() => setTodoChoices([])}
              onError={setIssue}
            />
          )}
        </main>

        <footer className="app-footer">
          <span title={effectiveBuildInfo.buildId}>LOOMA · {effectiveBuildInfo.productVersion}</span>
          <button type="button" className="text-btn" onClick={() => setTrialInfoOpen(true)}>{t('footer.versionAndIssues')}</button>
        </footer>

        {toastState && (
          <div className="app-toast" role="status">
            <span>{toastState.text}</span>
            {mode === 'work' && toastState.undoEventId && (
              <button type="button" className="text-btn" onClick={() => void undo(toastState.undoEventId)}>{t('app.undoThisAction')}</button>
            )}
            <button type="button" className="text-btn" aria-label={t('common.close')} onClick={() => setToastState(null)}>
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {isSettingsOpen && (
        <Suspense fallback={modalFallback}>
          <SettingsModal
            isOpen={isSettingsOpen}
            settings={settings}
            onClose={() => setSettingsOpen(false)}
            onSaveSettings={async s => {
              await TodoService.configure(Boolean(s.remindersEnabled || hasActiveCheckinReminder()));
              await Repository.saveSettings(s);
            }}
            onConnectionChange={s => { stopModelRequest(); setConnection(s); }}
            onDataImported={dataImported}
            buildInfo={effectiveBuildInfo}
            updateCheck={updateCheck}
            onCheckForUpdates={handleCheckForUpdates}
            onOpenUpdateUrl={handleOpenUpdateUrl}
            onOpenTrialInfo={() => { setSettingsOpen(false); setTrialInfoOpen(true); }}
          />
        </Suspense>
      )}

      {exportProject && mode === 'work' && (
        <Suspense fallback={modalFallback}>
          <AlignmentModal engagement={exportProject} tasks={exportTasks} onClose={() => setExportProject(null)} onNotice={setToast} />
        </Suspense>
      )}

      {trialInfoOpen && (
        <Suspense fallback={modalFallback}>
          <TrialInfoModal isOpen={trialInfoOpen} onClose={() => setTrialInfoOpen(false)} buildInfo={effectiveBuildInfo} context={trialContext} />
        </Suspense>
      )}

      {practiceOpen && (
        <Suspense fallback={<div className="modal-shade" role="status">{t('common.openingPractice')}</div>}>
          <PracticeModal onClose={() => setPracticeOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

function RecoveryScreen({ message }: { message: string }) {
  const { t } = useI18n();
  const [file, setFile] = useState<File>();
  const [accepted, setAccepted] = useState(false);
  const [feedback, setFeedback] = useState('');
  async function restore() {
    try {
      if (window.electronAPI?.importDataBackup) {
        const result = await window.electronAPI.importDataBackup();
        if (!result.canceled) location.reload();
      } else if (file && await Repository.importAllData(await file.text())) {
        location.reload();
      } else {
        setFeedback(t('common.backupInvalidKeepOriginal'));
      }
    } catch {
      setFeedback(t('common.restoreFailedKeepOriginal'));
    }
  }
  return (
    <div className="recovery-screen">
      <h1>{t('common.recoveryTitle')}</h1>
      <p>{message} {t('common.recoveryHint')}</p>
      {!window.electronAPI?.importDataBackup && <label>{t('common.selectRestoreBackup')}<input type="file" accept=".json" onChange={e => setFile(e.target.files?.[0])} /></label>}
      <label className="check-label"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />{t('common.confirmReplaceSpaces')}</label>
      <div className="button-row">
        <button type="button" className="primary-btn" disabled={!accepted} onClick={() => void restore()}>{t('common.verifyAndRestore')}</button>
        <button type="button" className="soft-btn" onClick={() => location.reload()}><RotateCcw size={14} />{t('common.reload')}</button>
      </div>
      {feedback && <p role="status">{feedback}</p>}
    </div>
  );
}

export class AppBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <RecoveryScreen message={t('common.boundaryFallbackNotice')} /> : this.props.children; }
}

export default App;
