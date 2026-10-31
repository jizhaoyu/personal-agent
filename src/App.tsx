import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Settings, Briefcase, Moon, Minus, X, ArrowUpRight, RotateCcw, BookOpen, ChevronsDown } from 'lucide-react';
import { Repository } from './persistence/repository';
import type { AppSnapshotV5 } from './persistence/repository';
import type { RecallEvidence } from './persistence/memory';
import { StateEngine } from './services/stateEngine';
import { parseModelProposal } from './services/aiService';
import { migrateLegacyCredential } from './services/legacyConnection';
import { deriveCompanionState } from './services/companionState';
import { createCaptureDraft, reviseCaptureDraft, rebaseProposal, resolveProposalConflict } from './services/capture';
import { createDraftController } from './services/draftController';
import type { DraftController, DraftState } from './services/draftController';
import type { Engagement, ProjectTaskItem, ProposedChangeSet, WorkOperation, WorkspaceMode, CaptureDraft, ClosureRecord, WorkHome, WorkPartition, FollowUpItem } from './types';
import { WorkBench } from './components/WorkBench';
import { Companion } from './components/Companion';
import { SettingsModal } from './components/SettingsModal';
import { AlignmentModal } from './components/AlignmentModal';
import { TrialInfoModal } from './components/TrialInfoModal';
import buildInfo from '../shared/build-info.json';
const PracticeModal = lazy(() => import('./components/PracticeModal').then(m => ({ default: m.PracticeModal })));
const ChatPill = lazy(() => import('./components/ChatPill').then(m => ({ default: m.ChatPill })));
const LivingCardsBoard = lazy(() => import('./components/LivingCardsBoard').then(m => ({ default: m.LivingCardsBoard })));
const MemoryCenter = lazy(() => import('./components/MemoryCenter').then(m => ({ default: m.MemoryCenter })));
const ArtifactJournal = lazy(() => import('./components/ArtifactJournal').then(m => ({ default: m.ArtifactJournal })));
const ArtifactGomoku = lazy(() => import('./components/ArtifactGomoku').then(m => ({ default: m.ArtifactGomoku })));
const id = () => crypto.randomUUID();

export function App() {
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
  const modeRef = useRef<WorkspaceMode>('work');
  const operation = useRef(0);
  const requestRef = useRef<string | null>(null);
  const notified = useRef(new Set<string>());
  const controller = useRef<DraftController | null>(null);
  const unknownOriginalOnly = useRef(false);
  const controllerSubscription = useRef<(() => void) | null>(null);
  const homeSequence = useRef(0);
  const pending = draftState?.draft.proposal || null;
  const selectedId = draftState?.draft.selectedEngagementId || '';
  const mode = snapshot?.activeMode || 'work'; modeRef.current = mode;
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
  function setSelectedId(value: string) { stopModelRequest(); changeDraft({ selectedEngagementId: value || undefined, ...(value ? { newClientName: undefined, newProjectTitle: undefined } : {}) }); }
  async function refreshHome() {
    if (modeRef.current !== 'work') return; const sequence = ++homeSequence.current;
    try { const value = await Repository.getWorkHome(); if (modeRef.current === 'work' && sequence === homeSequence.current) setHome(value); }
    catch { if (modeRef.current === 'work') setIssue('本地资料仍保留，今天的接续暂时没有读全，请重新读取。'); }
  }
  useEffect(() => {
    let active = true;
    let ready = false;
    const update = () => { if (active && ready) setSnapshot(Repository.getCurrent()); };
    const unsubscribe = Repository.subscribe(update);
    void (async () => { try {
      const boot = await Repository.initialize();
      if (boot.snapshot.activeMode === 'work') { const stored = await Repository.getCaptureDraft(); if (active) installDraft(stored || createCaptureDraft()); }
      if (active) { ready = true; setSnapshot(Repository.getCurrent()); }
    } catch { if (active) setStartupError('本地数据库读取或迁移失败，旧资料已保留。'); } })();
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
    if (!api?.onBeforeClose) return;
    return api.onBeforeClose(async requestId => {
      try { await controller.current?.flush(); await api.confirmClose(true, requestId); }
      catch { setIssue('草稿尚未保存，输入仍保留在此窗口。'); await api.confirmClose(false, requestId); }
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
      } catch { if (active) setIssue('桌面模型配置暂不可用，仍可使用本地流程。'); }
    })(); return () => { active = false; };
  }, [!!snapshot]);
  useEffect(() => {
    if (!snapshot) return;
    async function check() {
      try {
        const result = await Repository.request({ op: 'stats', space: mode });
        if (modeRef.current !== mode) return;
        if (mode === 'work' && snapshot!.settings.remindersEnabled && (result.dueTasks || result.dueFollowUps)) {
          const [due, followUps] = await Promise.all([
            Repository.query<ProjectTaskItem>('work', 'task', { dueOnly: true, limit: 200 }),
            Repository.query<FollowUpItem>('work', 'followup', { dueOnly: true, limit: 200 }),
          ]);
          if (modeRef.current !== mode) return;
          const keys = [...due.items.map(item => `${item.id}:${item.dueAt}`), ...followUps.items.map(item => `${item.id}:${item.reviewAt}`)];
          const fresh = keys.filter(key => !notified.current.has(key));
          if (fresh.length) { await window.electronAPI?.notifyDue({ count: Math.min(9999, (result.dueTasks || 0) + (result.dueFollowUps || 0)) }); fresh.forEach(key => notified.current.add(key)); }
        }
        await Repository.refresh(mode);
      } catch { /* In-app records remain available if notifications fail. */ }
    }
    void check(); const timer = setInterval(check, 30000); return () => clearInterval(timer);
  }, [mode, !!snapshot, snapshot?.settings.remindersEnabled]);
  function stopModelRequest() {
    operation.current++; const requestId = requestRef.current; requestRef.current = null; setBusy(false);
    if (requestId) void window.electronAPI?.cancelModel(requestId).catch(() => {});
  }
  function recorded(message: string, eventId?: string) { setSaved(true); setToast(message); setUndoEventId(eventId || ''); }
  async function toggleCompact(next = !compact) {
    try { await window.electronAPI?.setCompact?.(next); setCompact(next); } catch { setIssue('窗口暂时无法收起，请重试。'); }
  }
  async function flushDraft() { await controller.current?.flush(); }
  async function openMemory() {
    if (committing || unknownCapture) return;
    stopModelRequest();
    try { await flushDraft(); await toggleCompact(false); setMemoryOpen(true); }
    catch { setIssue('草稿尚未保存，原文仍保留在输入中，请重试后再离开。'); }
  }
  async function closeMemory() {
    try {
      if (modeRef.current === 'work' && controller.current) {
        const stored = await Repository.getCaptureDraft();
        if (!stored && controller.current.getState().draft.text.trim()) { installDraft(createCaptureDraft()); setToast('关联草稿已随来源删除清理。'); }
      }
      setMemoryOpen(false); await refreshHome();
    } catch { setIssue('草稿状态暂未读到，原有输入仍保留。'); }
  }
  async function openSettings() {
    if (committing || unknownCapture) return;
    stopModelRequest();
    try { await flushDraft(); setSettingsOpen(true); } catch { setIssue('草稿尚未保存，请先重试保存。'); }
  }
  async function openPractice() {
    if (committing || unknownCapture || restoreNeedsRead) return;
    stopModelRequest();
    try { await flushDraft(); setPracticeOpen(true); }
    catch { setIssue('真实草稿尚未保存，请先重试保存，再进入演练。'); }
  }
  async function switchMode(next: WorkspaceMode) {
    if (committing || unknownCapture) return;
    stopModelRequest(); setExportProject(null); setMemoryOpen(false); setIssue(''); setToast(''); setSaved(false);
    try {
      await flushDraft();
      if (next === 'work' && !controller.current) installDraft(await Repository.getCaptureDraft() || createCaptureDraft());
      await Repository.saveWorkspaceMode(next); modeRef.current = next;
    } catch { setIssue('草稿或空间切换尚未保存，当前输入仍保留。'); }
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
      const partition = await Repository.getParseContext(text, draft.selectedEngagementId);
      if (operation.current !== generation || modeRef.current !== 'work') return;
      const local = StateEngine.propose(text, { mode: 'work', sourceMessageId: sourceId, partition, now: Date.now(),
        selectedEngagementId: draft.selectedEngagementId, newClientName: draft.newClientName, newProjectTitle: draft.newProjectTitle });
      setPending(local);
      if (!local.clarification && connection?.enabled && connection.configured && window.electronAPI) {
        const requestId = id(); requestRef.current = requestId;
        try {
          const selected = partition.engagements.find(item => item.id === draft.selectedEngagementId);
          const context = selected ? { id: selected.id, clientName: selected.clientName, title: selected.title, budgetAmount: selected.budgetAmount,
            stage: selected.stage, shareableSummary: selected.shareableSummary, nextAction: selected.nextAction } : null;
          const result = await window.electronAPI.proposeModel({ requestId, text, context, now: new Date().toISOString() });
          if (operation.current === generation && modeRef.current === 'work') setPending(parseModelProposal(result.content, local, partition, draft.selectedEngagementId));
        } catch (error) { if (operation.current === generation && modeRef.current === 'work') setIssue((error instanceof Error ? error.message : '模型请求失败。') + ' 已保留本地候选与原文。'); }
      }
    } catch (error) { if (operation.current === generation && modeRef.current === 'work') setIssue('本次整理尚未完成，业务数据未更新。' + (error instanceof Error ? error.message : '请保留输入后重试。')); }
    finally { if (operation.current === generation) { requestRef.current = null; setBusy(false); } }
  }
  async function manual(operations: WorkOperation[], sourceText: string) {
    if (committing || unknownCapture || !controller.current) return;
    stopModelRequest(); setIssue('');
    if (controller.current.getState().draft.text.trim() || controller.current.getState().draft.proposal) {
      setIssue('当前还有一段未结束的整理。原文和修改已保留，可先核对或仅保存原文，再编辑项目。'); return;
    }
    try {
      const generation = ++operation.current;
      const targetId = operations.find(item => item.target === 'engagement')?.entityId ||
        operations.find(item => item.target === 'task' || item.target === 'followup')?.after?.engagementId;
      changeDraft({ text: sourceText, selectedEngagementId: targetId }); const draft = controller.current.getState().draft;
      const proposal = await Repository.createProposal('work', operations, sourceText, draft.sourceMessageId);
      if (operation.current !== generation || modeRef.current !== 'work' || controller.current?.getState().draft.draftVersion !== draft.draftVersion) return;
      setClosure(null); setPending(proposal);
    } catch { setIssue('未能读取当前项目，原文仍保留。'); }
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
          catch { setIssue('本次记录已保存，回执暂未读到，请重新读取。'); }
        }
        if (result.refreshWarning) setIssue(result.refreshWarning);
        if (modeRef.current === 'work') recorded(originalOnly ? '原文已保存，未更新项目或安排提醒。' : '已核对并保存，可在本次回执中查看和撤销。', result.eventId);
        await refreshHome();
      } else {
        setUnknownCapture(result.outcome === 'unknown'); unknownOriginalOnly.current = originalOnly;
        setIssue(result.error || '这次记录尚未确认保存，草稿仍保留。');
      }
    } catch (error) { setIssue('草稿尚未保存，原文和核对内容仍保留。' + (error instanceof Error ? error.message : '')); }
    finally { setCommitting(false); }
  }
  async function undo(eventId?: string) {
    if (committing || unknownCapture) return;
    stopModelRequest();
    try {
      const result: any = await Repository.undo('work', eventId); if (modeRef.current !== 'work') return;
      if (!result.ok) { setIssue(result.error || '撤销失败，原数据保留。'); return; }
      setIssue(result.refreshWarning || ''); setUndoEventId(''); recorded('最近一次变更已撤销，原文仍保留。');
      if (closure) setClosure(await Repository.get<ClosureRecord>('work', 'closure', closure.id));
      await refreshHome();
    } catch { setIssue('撤销结果暂时未能读取，请重新核对记录。'); }
  }
  async function setItemState(kind: 'task' | 'followup', item: ProjectTaskItem | FollowUpItem, done: boolean) {
    if (committing || unknownCapture) return;
    const result = await Repository.setItemState(kind, item, done);
    if (modeRef.current !== 'work') return;
    if (result.outcome !== 'committed') { setIssue(result.error || '状态未确认保存，原状态保留。'); throw new Error(result.error); }
    setIssue(result.refreshWarning || ''); setUndoEventId(result.eventId || '');
    recorded(done ? '已标记完成，可撤销这次操作。' : '已重新打开，可撤销这次操作。', result.eventId); await refreshHome();
  }
  async function reparse() {
    const draft = controller.current?.getState().draft; if (!draft?.proposal || committing || unknownCapture) return;
    stopModelRequest();
    const generation = ++operation.current;
    try {
      await Repository.refresh('work'); const partition: WorkPartition = { ...Repository.getCurrent().partitions.work, engagements: [], tasks: [], followUps: [], memories: [] };
      for (const target of ['engagement', 'task', 'followup', 'memory'] as const) {
        const ids = draft.proposal.operations.filter(item => item.target === target).map(item => item.entityId); const rows: any[] = [];
        for (let index = 0; index < ids.length; index += 200) rows.push(...(await Repository.query('work', target, { ids: ids.slice(index, index + 200), limit: 200 })).items);
        if (target === 'engagement') partition.engagements = rows; else if (target === 'task') partition.tasks = rows; else if (target === 'followup') partition.followUps = rows; else partition.memories = rows;
      }
      const current = controller.current?.getState().draft;
      if (operation.current !== generation || modeRef.current !== 'work' || current?.sessionId !== draft.sessionId || current.draftVersion !== draft.draftVersion) return;
      const result = rebaseProposal(draft.proposal, partition); changeDraft({ proposal: result.proposal, conflicts: result.conflicts, status: 'review' }); setIssue('');
    } catch { setIssue('当前资料暂未读取完整，原预览和编辑仍保留。'); }
  }
  function resolveConflict(conflictId: string, choice: 'current' | 'proposed') {
    const draft = controller.current?.getState().draft; if (!draft?.proposal) return;
    const result = resolveProposalConflict(draft.proposal, draft.conflicts || [], conflictId, choice);
    changeDraft({ proposal: result.proposal, conflicts: result.conflicts, status: 'review' });
  }
  function continueCapture() { if (!committing && !unknownCapture) { setClosure(null); setIssue(''); } }
  function editBusiness(query: string) { setClosure(null); setMemoryOpen(false); setProjectLookup({ query, requestId: id() }); }
  async function dataImported() {
    stopModelRequest(); setUnknownCapture(false); setClosure(null); setHome(null); setExportProject(null);
    controllerSubscription.current?.(); controller.current?.dispose(); controller.current = null; setDraftState(null);
    try {
      installDraft(await Repository.getCaptureDraft() || createCaptureDraft());
      setSnapshot(Repository.getCurrent()); setRestoreNeedsRead(false); setIssue(Repository.getRestoreWarning() || ''); await refreshHome();
    } catch {
      setRestoreNeedsRead(true); setSnapshot(Repository.getCurrent());
      setIssue('业务数据已恢复，但视图暂未读取，请重新读取。恢复前的输入不会覆盖已恢复资料。');
    }
  }
  async function sendLife(text: string) {
    if (busy) return; const sourceId = id(), generation = ++operation.current; setBusy(true); setIssue('');
    try {
      await Repository.saveMessages([{ id: sourceId, role: 'user', content: text, timestamp: Date.now() }], 'life');
      const mutations = await Repository.updateLifeAtomically(life => StateEngine.mutateLifeDraft(text, life), sourceId, text);
      const reply = mutations.length ? `已更新生活记录：\n${mutations.map(m => m.summaryText).join('\n')}` : '这句话已保留在当前生活对话中，尚未识别出可更新的生活卡片。';
      try { await Repository.saveMessages([{ id: id(), role: 'assistant', content: reply, timestamp: Date.now(), mutations }], 'life'); }
      catch { if (modeRef.current === 'life') setIssue('生活记录已保存，但回复未保存，请查看生活卡片，勿重复提交。'); }
      if (modeRef.current === 'life') recorded(mutations.length ? '生活记录已保存。' : '生活原文已本地归档。');
    } catch { if (modeRef.current === 'life') setIssue('本次生活变更未能完整保存，原文可能已保留。请检查后重试。'); }
    finally { if (generation === operation.current) setBusy(false); }
  }
  async function modelRecall(query: string, evidence: RecallEvidence) {
    if (!snapshot?.settings.memoryModelEnabled || !window.electronAPI?.recallModel) throw new Error('请先在设置中单独开启模型回忆增强。');
    const requestId = id(), sourceMode = modeRef.current; requestRef.current = requestId; setBusy(true);
    try { const result = await window.electronAPI.recallModel({ requestId, query, space: sourceMode, evidence: evidence.items });
      if (modeRef.current !== sourceMode || requestRef.current !== requestId) throw new Error('空间已切换，旧回忆结果已取消。'); return result.content;
    } finally { if (requestRef.current === requestId) { requestRef.current = null; setBusy(false); } }
  }
  if (!snapshot) return startupError ? <RecoveryScreen message={startupError}/> : <div className="recovery-screen" role="status">正在打开本地工作区…</div>;
  const { settings } = snapshot, work = snapshot.partitions.work, life = snapshot.partitions.life, stats = Repository.getStats();
  const reminderCount = mode === 'work' ? (stats.dueTasks || 0) + (stats.dueFollowUps || 0) : 0;
  const state = deriveCompanionState({ busy: busy || committing, pending: mode === 'work' && !!pending, saved, error: issue, reminderCount });
  const companion = <Companion state={state} mode={mode} name={settings.personaName} reminderCount={reminderCount} onToggle={mode === 'life' ? () => void toggleCompact() : undefined} onOpenMemory={mode === 'life' ? () => void openMemory() : undefined}/>;
  if (compact) return <div className="capsule-shell drag-region"><Companion compact state={state} mode={mode} name={settings.personaName} reminderCount={reminderCount} onToggle={() => void toggleCompact(false)} onOpenMemory={() => void openMemory()}/></div>;
  return <div className={`app-shell ${mode === 'life' ? 'life-shell' : ''}`}>
    <div className="workspace-content" inert={practiceOpen || trialInfoOpen}>
    <header className="app-header drag-region"><a className="wordmark no-drag" href="#" onClick={e => e.preventDefault()}>looma<span>灵犀胶囊</span></a><div className="header-tools no-drag"><button className="icon-btn" onClick={() => void openMemory()} aria-label="打开记忆中心"><BookOpen size={18}/></button><button className="icon-btn" onClick={() => void toggleCompact(true)} aria-label="收起为伴侣胶囊"><ChevronsDown size={18}/></button><button className="icon-btn" onClick={() => void openSettings()} aria-label="打开设置"><Settings size={18}/></button>{window.electronAPI && <><button className="icon-btn" onClick={() => void window.electronAPI!.minimizeWindow()} aria-label="最小化"><Minus size={18}/></button><button className="icon-btn" onClick={() => void window.electronAPI!.closeWindow()} aria-label="退出应用"><X size={18}/></button></>}</div></header>
    <div className="workspace-bar"><div className={`space-switch ${mode === 'work' ? 'space-switch--work' : ''}`} aria-label="工作空间"><button className={mode === 'work' ? 'active' : ''} onClick={() => void switchMode('work')}><Briefcase size={14}/>工作态</button><button className={mode === 'life' ? 'active' : ''} onClick={() => void switchMode('life')}><Moon size={14}/>生活态</button></div><span className="local-label"><span className="status-dot"/>本地逻辑分区</span></div>
    <main>{issue && <div className="app-alert" role="alert">{issue}{unknownCapture ? <button className="text-btn" disabled={committing} onClick={() => void saveCapture(unknownOriginalOnly.current)}>核查本次保存结果</button> : <button className="text-btn" onClick={async () => { try { if (restoreNeedsRead) { await dataImported(); } else { await Repository.refresh(mode); await refreshHome(); setIssue(''); } } catch { setIssue('暂未读取成功，资料仍保留。'); } }}>重新读取</button>}<button className="text-btn" disabled={unknownCapture} onClick={() => setIssue('')}>收起</button></div>}
      {memoryOpen ? <><button className="text-btn" onClick={() => void closeMemory()}>← 返回当前空间</button><Suspense fallback={<p>正在打开记忆中心…</p>}><MemoryCenter key={mode} mode={mode} onNotice={setToast} modelEnabled={!!settings.memoryModelEnabled && !!connection?.enabled} onModelRecall={modelRecall} onEditBusiness={mode === 'work' ? editBusiness : undefined}/></Suspense></> : mode === 'work' ? <WorkBench onPractice={() => void openPractice()} onRetryDraft={() => { void flushDraft().then(() => setIssue('')).catch(() => setIssue('草稿暂未保存，原文仍在输入框中。')); }} projectLookup={projectLookup} draft={draftState?.draft || null} draftSaveState={draftState?.status || 'idle'} home={home} closure={closure} onDraftChange={patch => { stopModelRequest(); changeDraft(patch); }} onContinue={continueCapture} onResume={() => setClosure(null)} onOriginalOnly={() => void saveCapture(true)} onRebase={() => void reparse()} onResolveConflict={resolveConflict} onSetItemState={setItemState} onUndoEvent={eventId => void undo(eventId)} onOpenMemory={() => void openMemory()} onOpenClosure={setClosure} modelBusy={busy && !!requestRef.current} work={work} stats={stats} companion={companion} pending={pending} busy={committing || unknownCapture || restoreNeedsRead || (busy && !pending)} selectedId={selectedId} onSelect={setSelectedId} onPropose={propose} onChange={p => { stopModelRequest(); setPending(p); }} onConfirm={() => void saveCapture()} onDiscard={() => { stopModelRequest(); setPending(null); setIssue(''); }} onReparse={() => void reparse()} onManual={(ops, text) => void manual(ops, text)} onUndo={() => void undo()} onExport={async project => { try { const tasks: ProjectTaskItem[] = []; let cursor: string | undefined; do { const page = await Repository.query<ProjectTaskItem>('work', 'task', { relatedId: project.id, limit: 200, cursor }); tasks.push(...page.items); cursor = page.nextCursor || undefined; } while (cursor); if (modeRef.current === 'work') { setExportProject(project); setExportTasks(tasks); } } catch { setIssue('关联行动读取失败，请重试。'); } }} modelEnabled={!!connection?.enabled && !!connection?.configured} onCancel={() => { stopModelRequest(); setIssue('模型请求已取消，本地候选与原文已保留。'); }}/>
        : <section className="life-workspace"><div className="life-intro"><div><span className="eyebrow">A LITTLE SPACE FOR YOURSELF</span><h1>留一点空间，给生活。</h1><p className="muted">生活记录只在此空间查看。工作态不会自动读取或修改它们。</p></div>{companion}</div><nav className="work-tabs" aria-label="生活导航">{[['chat', '随口说'], ['cards', '生活卡片'], ['journal', '手记'], ['memory', '记忆'], ['gomoku', '五子棋']].map(([tab, label]) => <button key={tab} className={lifeTab === tab ? 'active' : ''} onClick={() => setLifeTab(tab)}>{label}</button>)}</nav><div className="life-panel" key={lifeTab}><Suspense fallback={<p className="muted small">正在打开生活空间…</p>}>
          {lifeTab === 'chat' && <ChatPill messages={life.messages} settings={settings} mode="life" isLoading={busy} onSendMessage={sendLife} onInspectMutation={() => setLifeTab('cards')} onOpenCards={() => setLifeTab('cards')}/>}
          {lifeTab === 'cards' && <LivingCardsBoard mode="life" onCompanionToast={recorded}/>}
          {lifeTab === 'memory' && <MemoryCenter mode="life" onNotice={setToast} modelEnabled={!!settings.memoryModelEnabled && !!connection?.enabled} onModelRecall={modelRecall}/>}
          {lifeTab === 'journal' && <ArtifactJournal mode="life" journals={life.journals} messages={life.messages} settings={settings} onJournalsChange={() => setSnapshot(Repository.getCurrent())}/>}
          {lifeTab === 'gomoku' && <ArtifactGomoku settings={settings}/>}
        </Suspense></div></section>}
    </main>
    <footer className="app-footer"><span title={buildInfo.buildId}>LOOMA · {buildInfo.productVersion}</span><button className="text-btn" onClick={() => setTrialInfoOpen(true)}>版本与问题记录</button><button className="text-btn" onClick={() => void openSettings()}>设置与备份 <ArrowUpRight size={12}/></button></footer>
    {toast && <div className="app-toast" role="status">{toast}{mode === 'work' && undoEventId && <button className="text-btn" onClick={() => void undo(undoEventId)}>撤销这次操作</button>}</div>}
    <SettingsModal isOpen={isSettingsOpen} settings={settings} onClose={() => setSettingsOpen(false)} onSaveSettings={s => Repository.saveSettings(s)} onConnectionChange={s => { stopModelRequest(); setConnection(s); }} onDataImported={dataImported}/>
    {exportProject && mode === 'work' && <AlignmentModal engagement={exportProject} tasks={exportTasks} onClose={() => setExportProject(null)} onNotice={setToast}/>}
    </div>
    <TrialInfoModal isOpen={trialInfoOpen} onClose={() => setTrialInfoOpen(false)} buildInfo={buildInfo} context={{ mode, phase: memoryOpen || (mode === 'life' && lifeTab === 'memory') ? 'memory' : mode === 'life' ? busy ? 'saving' : 'idle' : committing ? 'saving' : unknownCapture ? 'uncertain' : closure ? 'receipt' : pending ? 'review' : draftState?.draft.text.trim() ? 'draft' : 'idle', hasError: !!issue }}/>
    {practiceOpen && <Suspense fallback={<div className="modal-shade" role="status">正在打开独立演练…</div>}><PracticeModal onClose={() => setPracticeOpen(false)}/></Suspense>}
  </div>;
}

function RecoveryScreen({ message }: { message: string }) {
  const [file, setFile] = useState<File>(); const [accepted, setAccepted] = useState(false); const [feedback, setFeedback] = useState('');
  async function restore() {
    try {
      if (window.electronAPI?.importDataBackup) { const result = await window.electronAPI.importDataBackup(); if (!result.canceled) location.reload(); }
      else if (file && await Repository.importAllData(await file.text())) location.reload(); else setFeedback('备份校验或写入失败，原数据未替换。');
    } catch { setFeedback('恢复失败，原数据已保留。'); }
  }
  return <div className="recovery-screen"><h1>暂时无法打开工作区</h1><p>{message} 可重新读取，或选择已保存的完整业务备份。</p>{!window.electronAPI?.importDataBackup && <label>选择恢复备份<input type="file" accept=".json" onChange={e => setFile(e.target.files?.[0])}/></label>}<label className="check-label"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)}/>确认用完整备份替换两个空间</label><div className="button-row"><button className="primary-btn" disabled={!accepted} onClick={() => void restore()}>校验并恢复工作区</button><button className="soft-btn" onClick={() => location.reload()}><RotateCcw size={14}/>重新读取</button></div>{feedback && <p role="status">{feedback}</p>}</div>;
}
export class AppBoundary extends React.Component<{children: React.ReactNode}, {failed: boolean}> {
  state = { failed: false }; static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <RecoveryScreen message="界面暂时无法读取本地资料，原数据未被自动清除。"/> : this.props.children; }
}
export default App;
