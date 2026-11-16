import { useEffect, useRef, useState } from 'react';
import { Archive, BookOpen, Check, ChevronDown, Database, Pin, Search, Sparkles, Trash2, X } from 'lucide-react';
import type { WorkspaceMode } from '../types';
import { newId } from '../services/storage';
import { Repository } from '../persistence/repository';
import type { RecordMutation } from '../persistence/repository';
import { confirmCorrection, memorySources, planForget, recall, reviewFact, summarizeEvents } from '../persistence/memory';
import type { ManagedMemory, MemorySummary, RecallEvidence } from '../persistence/memory';
import { formatBudgetAmount, useI18n } from '../i18n';
import '../persistence/memory.css';

export interface MemoryCenterProps {
  mode: WorkspaceMode;
  onNotice(message: string): void;
  modelEnabled?: boolean;
  connectionConfigured?: boolean;
  onModelRecall?(query: string, evidence: RecallEvidence): Promise<string>;
  onEditBusiness?(query: string): void;
}
type Tab = 'facts' | 'archive' | 'recall' | 'capacity';
type FactStatusFilter = 'all' | 'active' | 'superseded' | 'retracted';
type ArchiveKind = 'message' | 'event' | 'summary';
type DeletingTarget = { kind: 'memory' | ArchiveKind; rows: any[] };

const byteText = (value = 0) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(2)} MB`;

export function MemoryCenter({ mode, onNotice, modelEnabled = false, connectionConfigured = true, onModelRecall, onEditBusiness }: MemoryCenterProps) {
  const { lang, t } = useI18n();
  const time = (at: number) => at ? new Date(at).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { timeZone: 'Asia/Shanghai' }) : t('memory.timeUnknown');
  const labels = { message: t('memory.kindMessage'), event: t('memory.kindEvent'), summary: t('memory.kindSummary') };
  const spaceName = mode === 'work' ? t('memory.spaceWork') : t('memory.spaceLife');
  const canModelRecall = Boolean(modelEnabled && connectionConfigured && onModelRecall);

  const [tab, setTab] = useState<Tab>('facts');
  const [kind, setKind] = useState<ArchiveKind>('message');
  const [statusFilter, setStatusFilter] = useState<FactStatusFilter>('all');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sourceRows, setSourceRows] = useState<{ id: string; content: string; at: number }[] | null>(null);
  const [draft, setDraft] = useState({ subject: '', topic: '', fact: '', sourceId: '' });
  const [editing, setEditing] = useState<ManagedMemory | null>(null);
  const [review, setReview] = useState<{ candidate: ManagedMemory; conflicts: ManagedMemory[]; newSource?: any } | null>(null);
  const [deleting, setDeleting] = useState<DeletingTarget | null>(null);
  const [deleteSources, setDeleteSources] = useState(false);
  const [deleteAccepted, setDeleteAccepted] = useState(false);
  const [evidence, setEvidence] = useState<RecallEvidence | null>(null);
  const [modelReply, setModelReply] = useState('');
  const [evidenceQuery, setEvidenceQuery] = useState('');

  const generation = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const loadSequence = useRef(0);
  const composeRef = useRef<HTMLDetailsElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);
  const factInputRef = useRef<HTMLTextAreaElement>(null);
  const pendingComposeFocusRef = useRef<'subject' | 'fact' | null>(null);

  const listContextKey = tab === 'facts' ? `${mode}:memory` : tab === 'archive' ? `${mode}:${kind}` : `${mode}:${tab}`;
  const [loadedContextKey, setLoadedContextKey] = useState('');
  const visibleRows = loadedContextKey === listContextKey ? rows : [];
  const filteredFacts = statusFilter === 'all'
    ? visibleRows
    : visibleRows.filter((item: ManagedMemory) => (item.status || 'active') === statusFilter);
  const selectableRows: any[] = tab === 'facts'
    ? filteredFacts.filter((item: ManagedMemory) => !item.status || item.status === 'active')
    : tab === 'archive'
      ? visibleRows
      : [];
  const selectedSet = new Set(selectedIds);
  const selectedRows = selectableRows.filter(item => selectedSet.has(item.id));

  function focusComposeForm(target: 'subject' | 'fact' = 'fact') {
    if (composeRef.current) composeRef.current.open = true;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn: () => void) => setTimeout(fn, 0);
    schedule(() => {
      const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      composeRef.current?.scrollIntoView?.({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
      if (target === 'subject') subjectInputRef.current?.focus();
      else factInputRef.current?.focus();
    });
  }

  async function load(append = false) {
    if (tab === 'recall') return;
    const sequence = ++loadSequence.current;
    const ownedMode = mode;
    const targetContextKey = listContextKey;
    setBusy(true);
    setIssue('');
    try {
      if (tab === 'capacity') {
        const capacity = await Repository.request({ op: 'stats', space: ownedMode });
        if (sequence !== loadSequence.current || modeRef.current !== ownedMode) return;
        setStats(capacity);
        return;
      }
      const selected = tab === 'facts' ? 'memory' : kind;
      const [page, capacity] = await Promise.all([
        Repository.query(ownedMode, selected, { query: query || undefined, limit: 30, cursor: append ? cursor || undefined : undefined }),
        Repository.request({ op: 'stats', space: ownedMode }),
      ]);
      if (sequence !== loadSequence.current || modeRef.current !== ownedMode) return;
      setRows(previous => {
        if (!append || loadedContextKey !== targetContextKey) return page.items;
        const seen = new Set(previous.map(item => item.id));
        return [...previous, ...page.items.filter((item: any) => !seen.has(item.id))];
      });
      setLoadedContextKey(targetContextKey);
      setCursor(page.nextCursor || null);
      setStats(capacity);
    } catch (error) {
      if (sequence === loadSequence.current && modeRef.current === ownedMode) {
        setIssue(error instanceof Error ? error.message : t('memory.loadError'));
      }
    } finally {
      if (sequence === loadSequence.current && modeRef.current === ownedMode) setBusy(false);
    }
  }

  useEffect(() => {
    generation.current++;
    setRows([]);
    setLoadedContextKey('');
    setCursor(null);
    setSelectedIds([]);
    setSourceRows(null);
    setEvidence(null);
    setModelReply('');
    setReview(null);
    setDeleting(null);
    setDraft({ subject: '', topic: '', fact: '', sourceId: '' });
    setEditing(null);
  }, [mode]);

  useEffect(() => {
    setSelectedIds([]);
  }, [tab, kind, statusFilter]);

  useEffect(() => {
    if (tab === 'facts' && pendingComposeFocusRef.current) {
      const target = pendingComposeFocusRef.current;
      pendingComposeFocusRef.current = null;
      focusComposeForm(target);
    }
  }, [tab, draft.sourceId, editing?.id]);

  useEffect(() => {
    if (tab === 'recall') return;
    void load();
    return () => { loadSequence.current++; };
  }, [mode, tab, kind, query]);

  useEffect(() => Repository.subscribe(() => {
    if (tab !== 'recall') void load();
  }), [mode, tab, kind, query]);

  useEffect(() => {
    if (!review && !deleting && !sourceRows) return;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (sourceRows) { setSourceRows(null); return; }
      if (busy) return;
      if (deleting) { setDeleting(null); return; }
      if (review) setReview(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [review, deleting, sourceRows, busy]);

  async function perform(action: () => Promise<void>) {
    const ownedMode = mode;
    setBusy(true);
    setIssue('');
    try { await action(); }
    catch (error) { if (ownedMode === modeRef.current) setIssue(error instanceof Error ? error.message : t('memory.performError')); }
    finally { if (ownedMode === modeRef.current) setBusy(false); }
  }

  async function showSources(ids: string[]) {
    const ownedMode = mode;
    await perform(async () => {
      const output: { id: string; content: string; at: number }[] = [];
      for (const id of [...new Set(ids)]) {
        const message = await Repository.get(ownedMode, 'message', id);
        if (message) { output.push({ id, content: message.content, at: message.timestamp }); continue; }
        const event = await Repository.get(ownedMode, 'event', id);
        if (event) { output.push({ id, content: event.sourceText || t('memory.eventNoSourceText'), at: event.createdAt }); continue; }
        const project = ownedMode === 'work' ? await Repository.get(ownedMode, 'engagement', id) : null;
        output.push(project ? {
          id,
          content: t('memory.projectSourceSummary', {
            client: project.clientName,
            title: project.title,
            budget: project.budgetAmount !== undefined ? formatBudgetAmount(project.budgetAmount, lang) : t('memory.budgetUnconfirmed'),
            next: project.nextAction,
          }),
          at: project.updatedAt,
        } : { id, content: t('memory.sourceDeletedOrManual'), at: 0 });
      }
      if (modeRef.current === ownedMode) setSourceRows(output);
    });
  }

  async function prepareFact() {
    const ownedMode = mode;
    await perform(async () => {
      if (!draft.fact.trim()) throw new Error(t('memory.factRequiredError'));
      const sourceId = draft.sourceId || newId('memory-source');
      const candidate: ManagedMemory = {
        id: newId('memory'),
        mode: ownedMode,
        category: ownedMode === 'work' ? 'business' : 'experience',
        fact: draft.fact.trim(),
        subject: draft.subject.trim(),
        topic: draft.topic.trim(),
        importance: editing?.importance ?? 3,
        pinned: editing?.pinned || false,
        status: 'active',
        createdAt: Date.now(),
        sourceIds: [sourceId],
      };
      const pages = await Promise.all([
        candidate.subject ? Repository.query(ownedMode, 'memory', { names: [candidate.subject], limit: 200 }) : Promise.resolve({ items: [] }),
        Repository.query(ownedMode, 'memory', { query: candidate.fact.length >= 2 ? candidate.fact : undefined, limit: 200 }),
      ]);
      const existing = [...new Map<string, ManagedMemory>(pages.flatMap(page => page.items).map(item => [item.id, item])).values()];
      const result = reviewFact(candidate, existing);
      if (result.type === 'duplicate' && (!editing || editing.id !== result.duplicate.id)) {
        onNotice(t('memory.duplicateFactNotice'));
        return;
      }
      const conflicts = [...new Map([...result.conflicts, ...(editing ? [editing] : [])].map(item => [item.id, item])).values()];
      if (modeRef.current === ownedMode) {
        setReview({
          candidate,
          conflicts,
          newSource: draft.sourceId ? undefined : {
            id: sourceId,
            role: 'user',
            content: `${t('memory.manualSourcePrefix')}${candidate.subject} ${candidate.topic}\n${candidate.fact}`,
            timestamp: candidate.createdAt,
          },
        });
      }
    });
  }

  async function saveFact() {
    if (!review) return;
    const approved = review;
    const ownedMode = mode;
    await perform(async () => {
      const mutations: RecordMutation[] = [];
      for (const before of approved.conflicts) {
        mutations.push({ kind: 'memory', id: before.id, before, after: confirmCorrection(before, approved.candidate).previous });
      }
      const after = { ...approved.candidate, ...(approved.conflicts[0] ? { supersedesId: approved.conflicts[0].id, validFrom: Date.now() } : {}) };
      mutations.push({ kind: 'memory', id: after.id, before: null, after });
      if (approved.newSource) mutations.push({ kind: 'message', id: approved.newSource.id, before: null, after: approved.newSource });
      const result = await Repository.transaction(ownedMode, mutations, {
        event: true,
        sourceMessageId: after.sourceIds[0],
        sourceText: t('memory.manualSaveSourceText'),
      });
      if (!result.ok) throw new Error(result.error);
      if (ownedMode === modeRef.current) {
        setReview(null);
        setEditing(null);
        setDraft({ subject: '', topic: '', fact: '', sourceId: '' });
        onNotice(t('memory.factSavedNotice'));
      }
    });
  }

  async function derivedSummaries(space: WorkspaceMode, sourceIds: string[]): Promise<MemorySummary[]> {
    const queue = [...sourceIds];
    const seen = new Set<string>();
    const found = new Map<string, MemorySummary>();
    while (queue.length) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let next: string | undefined;
      do {
        const page = await Repository.query<MemorySummary>(space, 'summary', { relatedId: id, limit: 200, cursor: next });
        for (const summary of page.items) if (!found.has(summary.id)) { found.set(summary.id, summary); queue.push(summary.id); }
        next = page.nextCursor || undefined;
      } while (next);
    }
    return [...found.values()];
  }

  async function confirmDelete() {
    if (!deleting || !deleteAccepted || !deleting.rows.length) return;
    const target = deleting;
    const ownedMode = mode;
    await perform(async () => {
      const mutationMap = new Map<string, RecordMutation>();
      const addMutation = (m: RecordMutation) => {
        mutationMap.set(`${m.kind}:${m.id}`, m);
      };
      const targetRowIds = new Set(target.rows.map(row => row.id));

      for (const row of target.rows) {
        const sourceIds = target.kind === 'memory' ? memorySources(row) : [row.id];
        const summaries = await derivedSummaries(ownedMode, [row.id, ...sourceIds]);
        if (target.kind === 'memory') {
          const plan = planForget(row, summaries, deleteSources);
          addMutation({ kind: 'memory', id: row.id, before: row, after: plan.fact });
          if (deleteSources) {
            for (const sourceId of plan.sourceIdsToDelete) {
              const before = await Repository.get(ownedMode, 'message', sourceId);
              if (before) addMutation({ kind: 'message', id: sourceId, before, after: null });
              let next: string | undefined;
              do {
                const page = await Repository.query<ManagedMemory>(ownedMode, 'memory', { relatedId: sourceId, limit: 200, cursor: next });
                for (const fact of page.items) {
                  if (!targetRowIds.has(fact.id) && fact.status !== 'retracted' && !mutationMap.has(`memory:${fact.id}`)) {
                    addMutation({ kind: 'memory', id: fact.id, before: fact, after: { ...fact, status: 'retracted' } });
                  }
                }
                next = page.nextCursor || undefined;
              } while (next);
            }
          }
        } else {
          addMutation({ kind: target.kind, id: row.id, before: row, after: null });
          // Source removal also stops the automatic use of facts that directly depend on it.
          let next: string | undefined;
          do {
            const page = await Repository.query<ManagedMemory>(ownedMode, 'memory', { relatedId: row.id, limit: 200, cursor: next });
            for (const fact of page.items) {
              if (fact.status !== 'retracted' && !mutationMap.has(`memory:${fact.id}`)) {
                addMutation({ kind: 'memory', id: fact.id, before: fact, after: { ...fact, status: 'retracted' } });
              }
            }
            next = page.nextCursor || undefined;
          } while (next);
        }
        for (const before of summaries) {
          if (!(target.kind === 'summary' && targetRowIds.has(before.id))) {
            addMutation({ kind: 'summary', id: before.id, before, after: null });
          }
        }
      }

      const unique = [...mutationMap.values()];
      const redactSourceIds = unique.filter(m => m.kind === 'message' && m.after === null).map(m => m.id);
      const result = await Repository.transaction(ownedMode, unique, {
        sourceText: t('memory.cleanupSourceText'),
        event: false,
        ...(redactSourceIds.length ? { redactSourceIds } : {}),
      });
      if (!result.ok) throw new Error(result.error);
      if (ownedMode === modeRef.current) {
        const count = target.rows.length;
        setDeleting(null);
        setDeleteAccepted(false);
        setDeleteSources(false);
        setSelectedIds([]);
        setEvidence(null);
        setModelReply('');
        if (count > 1) {
          onNotice(target.kind === 'memory' && !deleteSources
            ? t('memory.bulkForgotNotice', { count })
            : t('memory.bulkDeletedNotice', { count }));
        } else {
          onNotice(target.kind === 'memory' && !deleteSources ? t('memory.forgotNotice') : t('memory.deletedNotice'));
        }
      }
    });
  }

  async function doRecall(withModel = false) {
    const ownedMode = mode;
    const requestGeneration = generation.current;
    await perform(async () => {
      if (!input.trim()) throw new Error(t('memory.recallQueryRequired'));
      if (withModel && (!evidence || evidenceQuery !== input.trim())) throw new Error(t('memory.recallVerifyFirst'));
      const result = withModel ? evidence! : await recall(input.trim(), ownedMode);
      if (ownedMode !== modeRef.current || requestGeneration !== generation.current) return;
      setEvidence(result);
      setEvidenceQuery(input.trim());
      setModelReply('');
      if (withModel && result.items.length && canModelRecall && onModelRecall) {
        const reply = await onModelRecall(input.trim(), result);
        if (ownedMode === modeRef.current && requestGeneration === generation.current) setModelReply(reply);
      }
    });
  }

  async function rebuildSummary() {
    const ownedMode = mode;
    await perform(async () => {
      const page = await Repository.query(ownedMode, 'event', { limit: 40 });
      const summary = summarizeEvents(ownedMode, page.items.reverse());
      if (!summary.sourceIds.length) throw new Error(t('memory.noEventsForSummary'));
      await Repository.upsert(ownedMode, 'summary', [summary]);
      if (ownedMode === modeRef.current) {
        onNotice(t('memory.summaryBuiltNotice'));
        setKind('summary');
        setTab('archive');
      }
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]));
  }

  function openSingleDelete(targetKind: 'memory' | ArchiveKind, row: any) {
    setDeleting({ kind: targetKind, rows: [row] });
    setDeleteAccepted(false);
    setDeleteSources(false);
  }

  function openBulkDelete() {
    if (!selectedRows.length) return;
    setDeleting({ kind: tab === 'facts' ? 'memory' : kind, rows: selectedRows });
    setDeleteAccepted(false);
    setDeleteSources(false);
  }

  const displayedListRows = tab === 'facts' ? filteredFacts : visibleRows;

  return (
    <section className="memory-center" aria-label={t('memory.sectionAria', { space: spaceName })} aria-busy={busy}>
      <div className="memory-heading">
        <div>
          <span className="memory-eyebrow">{t('memory.eyebrow')}</span>
          <h2>{t('memory.heading')}</h2>
          <p>{t('memory.subtitle', { space: spaceName })}</p>
        </div>
        <BookOpen size={28} />
      </div>

      <nav className="memory-tabs" aria-label={t('memory.tabsAria')}>
        {([
          ['facts', t('memory.tabFacts'), BookOpen],
          ['archive', t('memory.tabArchive'), Archive],
          ['recall', t('memory.tabRecall'), Sparkles],
          ['capacity', t('memory.tabCapacity'), Database],
        ] as const).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? 'active' : ''}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </nav>

      {issue && <p className="memory-error" role="alert">{issue}</p>}

      {tab !== 'capacity' && (
        <form
          className="memory-search"
          onSubmit={event => {
            event.preventDefault();
            if (tab === 'recall') void doRecall();
            else setQuery(input.trim());
          }}
        >
          <Search size={17} />
          <input
            aria-label={tab === 'recall' ? t('memory.searchRecallAria') : t('memory.searchArchiveAria')}
            value={input}
            onChange={event => setInput(event.target.value)}
            placeholder={tab === 'recall' ? t('memory.searchRecallPlaceholder') : t('memory.searchArchivePlaceholder')}
          />
          <button type="submit" disabled={busy}>
            {tab === 'recall' ? t('memory.recallBtn') : t('memory.searchBtn')}
          </button>
          {(query || input) && (
            <button type="button" onClick={() => { setQuery(''); setInput(''); }}>
              {t('memory.clearBtn')}
            </button>
          )}
        </form>
      )}

      {tab === 'facts' && (
        <>
          {mode === 'work' && onEditBusiness && (
            <p className="memory-hint">
              {t('memory.workFactsBoundaryHint')}
              <button type="button" onClick={() => onEditBusiness(query)}>{t('memory.goToProjectsBtn')}</button>
              {t('memory.workFactsBoundaryNote')}
            </p>
          )}

          <details ref={composeRef} className="memory-compose" open={!!editing || !!draft.sourceId}>
            <summary>{t('memory.composeSummary')}</summary>
            <p>{t('memory.composeHint')}</p>
            <div className="memory-two-cols">
              <label>
                {t('memory.subjectLabel')}
                <input
                  ref={subjectInputRef}
                  value={draft.subject}
                  onChange={event => setDraft({ ...draft, subject: event.target.value })}
                  placeholder={t('memory.subjectPlaceholder')}
                />
              </label>
              <label>
                {t('memory.topicLabel')}
                <input
                  value={draft.topic}
                  onChange={event => setDraft({ ...draft, topic: event.target.value })}
                  placeholder={t('memory.topicPlaceholder')}
                />
              </label>
            </div>
            <label>
              {t('memory.factLabel')}
              <textarea
                ref={factInputRef}
                value={draft.fact}
                onChange={event => setDraft({ ...draft, fact: event.target.value })}
                rows={3}
                placeholder={t('memory.factPlaceholder')}
              />
            </label>
            {draft.sourceId && <small className="memory-linked-hint">{t('memory.linkedSourceHint')}</small>}
            <div className="memory-actions">
              <button type="button" disabled={busy || !draft.fact.trim()} onClick={() => void prepareFact()}>
                {editing ? t('memory.previewUpdateBtn') : t('memory.previewCreateBtn')}
              </button>
              {(editing || draft.sourceId) && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setDraft({ subject: '', topic: '', fact: '', sourceId: '' });
                  }}
                >
                  {t('memory.cancelEditBtn')}
                </button>
              )}
            </div>
          </details>

          <div className="memory-status-filters" role="group" aria-label={t('memory.statusFilterLabel')}>
            <span className="memory-filter-label">{t('memory.statusFilterLabel')}</span>
            <div className="memory-filter-pills">
              {([
                ['all', t('memory.filterAll')],
                ['active', t('memory.filterActive')],
                ['superseded', t('memory.filterSuperseded')],
                ['retracted', t('memory.filterRetracted')],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={statusFilter === value ? 'active' : ''}
                  aria-pressed={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {selectableRows.length > 1 && selectedRows.length === 0 && (
              <button type="button" onClick={() => setSelectedIds(selectableRows.map(item => item.id))}>
                {t('memory.selectAllPageBtn')}
              </button>
            )}
          </div>

          {selectedRows.length > 0 && (
            <div className="memory-bulk-bar" role="region" aria-label={t('memory.selectedCountText', { count: selectedRows.length })}>
              <span>{t('memory.selectedCountText', { count: selectedRows.length })}</span>
              <div className="memory-bulk-actions">
                <button type="button" onClick={() => setSelectedIds(selectableRows.map(item => item.id))}>
                  {t('memory.selectAllPageBtn')}
                </button>
                <button type="button" onClick={() => setSelectedIds([])}>
                  {t('memory.clearSelectionBtn')}
                </button>
                <button type="button" className="memory-danger" disabled={busy} onClick={openBulkDelete}>
                  <Trash2 size={14} />
                  {t('memory.bulkForgetBtn', { count: selectedRows.length })}
                </button>
              </div>
            </div>
          )}

          <div className="memory-list">
            {filteredFacts.map((item: ManagedMemory) => {
              const isActive = !item.status || item.status === 'active';
              const isSelected = selectedSet.has(item.id);
              return (
                <article className={`memory-item ${!isActive ? 'memory-inactive' : ''} ${isSelected ? 'memory-item--selected' : ''}`} key={item.id}>
                  <div className="memory-item-top">
                    <div className="memory-item-head-meta">
                      {isActive && (
                        <label className="memory-select-check">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            aria-label={t('memory.selectItemAria')}
                            onChange={() => toggleSelected(item.id)}
                          />
                        </label>
                      )}
                      <span>{item.subject || t('memory.unspecifiedSubject')}{item.topic ? ` · ${item.topic}` : ''}</span>
                    </div>
                    <span>
                      {item.pinned && '📌 '}
                      {item.status === 'retracted' ? t('memory.statusRetracted') : item.status === 'superseded' ? t('memory.statusSuperseded') : t('memory.statusActive')}
                    </span>
                  </div>
                  <p>{item.fact}</p>
                  <small>{time(item.validFrom || item.createdAt)}</small>
                  <div className="memory-actions">
                    <button type="button" onClick={() => void showSources(memorySources(item))}>{t('memory.showSourcesBtn')}</button>
                    {isActive && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void perform(async () => { await Repository.upsert(mode, 'memory', [{ ...item, pinned: !item.pinned }]); })}
                        >
                          <Pin size={13} />
                          {item.pinned ? t('memory.unpinBtn') : t('memory.pinBtn')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(item);
                            setDraft({ subject: item.subject || '', topic: item.topic || '', fact: item.fact, sourceId: '' });
                            focusComposeForm('fact');
                          }}
                        >
                          {t('memory.editFactBtn')}
                        </button>
                        {mode === 'work' && onEditBusiness && (
                          <button type="button" onClick={() => onEditBusiness(item.subject || '')}>
                            {t('memory.editProjectBtn')}
                          </button>
                        )}
                        <button type="button" className="memory-danger" onClick={() => openSingleDelete('memory', item)}>
                          {t('memory.forgetBtn')}
                        </button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {tab === 'archive' && (
        <>
          <div className="memory-filter">
            <label>
              {t('memory.archiveTypeLabel')}
              <select aria-label={t('memory.archiveTypeLabel')} value={kind} onChange={event => setKind(event.target.value as ArchiveKind)}>
                <option value="message">{t('memory.kindMessage')}</option>
                <option value="event">{t('memory.kindEvent')}</option>
                <option value="summary">{t('memory.kindSummary')}</option>
              </select>
            </label>
            <div className="memory-bulk-actions">
              {selectableRows.length > 1 && selectedRows.length === 0 && (
                <button type="button" onClick={() => setSelectedIds(selectableRows.map(item => item.id))}>
                  {t('memory.selectAllPageBtn')}
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => void rebuildSummary()}>
                {t('memory.rebuildSummaryBtn')}
              </button>
            </div>
          </div>
          <p className="memory-hint">{t('memory.archiveHint')}</p>

          {selectedRows.length > 0 && (
            <div className="memory-bulk-bar" role="region" aria-label={t('memory.selectedCountText', { count: selectedRows.length })}>
              <span>{t('memory.selectedCountText', { count: selectedRows.length })}</span>
              <div className="memory-bulk-actions">
                <button type="button" onClick={() => setSelectedIds(selectableRows.map(item => item.id))}>
                  {t('memory.selectAllPageBtn')}
                </button>
                <button type="button" onClick={() => setSelectedIds([])}>
                  {t('memory.clearSelectionBtn')}
                </button>
                <button type="button" className="memory-danger" disabled={busy} onClick={openBulkDelete}>
                  <Trash2 size={14} />
                  {t('memory.bulkDeleteBtn', { count: selectedRows.length })}
                </button>
              </div>
            </div>
          )}

          <div className="memory-list">
            {visibleRows.map(item => {
              const isSelected = selectedSet.has(item.id);
              return (
                <article className={`memory-item ${isSelected ? 'memory-item--selected' : ''}`} key={item.id}>
                  <div className="memory-item-top">
                    <div className="memory-item-head-meta">
                      <label className="memory-select-check">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          aria-label={t('memory.selectItemAria')}
                          onChange={() => toggleSelected(item.id)}
                        />
                      </label>
                      <span>
                        {labels[kind]}
                        {kind === 'message' ? ` · ${item.role === 'user' ? t('memory.roleUser') : item.role === 'assistant' ? 'Looma' : t('memory.roleSystem')}` : ''}
                      </span>
                    </div>
                    <span>{time(item.timestamp || item.createdAt)}</span>
                  </div>
                  <p>{item.content || item.sourceText || t('memory.missingEventText')}</p>
                  {kind === 'event' && <small>{item.revertedAt ? t('memory.eventRevertedTag') : t('memory.eventConfirmedTag')}</small>}
                  {kind === 'summary' && <small>{t('memory.summaryMetaTag')}</small>}
                  <div className="memory-actions">
                    {kind === 'message' && item.role === 'user' && (
                      <button
                        type="button"
                        onClick={() => {
                          setDraft({ subject: '', topic: '', fact: item.content, sourceId: item.id });
                          setEditing(null);
                          pendingComposeFocusRef.current = 'subject';
                          setTab('facts');
                        }}
                      >
                        {t('memory.useAsFactSourceBtn')}
                      </button>
                    )}
                    {item.sourceIds?.length > 0 && (
                      <button type="button" onClick={() => void showSources(item.sourceIds)}>{t('memory.showSourcesBtn')}</button>
                    )}
                    <button type="button" className="memory-danger" onClick={() => openSingleDelete(kind, item)}>
                      <Trash2 size={13} />
                      {t('memory.deleteRecordBtn')}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {(tab === 'facts' || tab === 'archive') && (
        <>
          {!displayedListRows.length && !busy && (
            <div className="memory-empty">
              <BookOpen size={26} />
              <p>
                {tab === 'facts' && visibleRows.length > 0 && statusFilter !== 'all'
                  ? t('memory.emptyFilteredFacts')
                  : query
                    ? t('memory.emptySearch')
                    : tab === 'facts'
                      ? t('memory.emptyFacts')
                      : t('memory.emptyArchive')}
              </p>
              {tab === 'facts' && visibleRows.length > 0 && statusFilter !== 'all' && (
                <button type="button" onClick={() => setStatusFilter('all')}>
                  {t('memory.resetFilterBtn')}
                </button>
              )}
            </div>
          )}
          {cursor && (
            <button type="button" className="memory-more" disabled={busy} onClick={() => void load(true)}>
              <ChevronDown size={15} />
              {t('memory.loadMoreBtn')}
            </button>
          )}
        </>
      )}

      {tab === 'recall' && (
        <>
          <p className="memory-hint">{t('memory.recallHint')}</p>
          {canModelRecall && (
            <>
              <button
                type="button"
                disabled={busy || !evidence || evidenceQuery !== input.trim()}
                onClick={() => void doRecall(true)}
              >
                <Sparkles size={14} />
                {t('memory.recallModelBtn')}
              </button>
              {evidence && evidenceQuery !== input.trim() && (
                <p className="memory-hint">{t('memory.recallRefreshHint')}</p>
              )}
            </>
          )}
          {evidence && (
            <>
              <p className="memory-budget">
                {t('memory.recallBudget', { items: evidence.items.length, maxItems: evidence.maxItems, chars: evidence.estimatedChars, maxChars: evidence.maxChars })}
              </p>
              {evidence.boundaryProof && (
                <p className="memory-boundary-proof" aria-label={t('memory.boundaryProofAria')}>
                  {t('memory.boundaryProofText', {
                    space: spaceName,
                    retracted: evidence.boundaryProof.retractedFactCount,
                    superseded: evidence.boundaryProof.supersededFactCount,
                    summaries: evidence.boundaryProof.blockedSummaryCount,
                  })}
                </p>
              )}
              {!evidence.items.length && <p className="memory-empty">{t('memory.recallEmpty')}</p>}
              {modelReply && (
                <article className="memory-item">
                  <div className="memory-item-top">{t('memory.modelReplyHeading')}</div>
                  <p>{modelReply}</p>
                </article>
              )}
              <div className="memory-list">
                {evidence.items.map(item => (
                  <article className="memory-item" key={`${item.kind}-${item.id}`}>
                    <div className="memory-item-top">
                      <span>{{ current: t('memory.evidenceCurrent'), fact: t('memory.evidenceFact'), summary: t('memory.evidenceSummary'), archive: t('memory.evidenceArchive') }[item.kind]}</span>
                      <small>{time(item.at)}</small>
                    </div>
                    <p>{item.text}</p>
                    <button type="button" onClick={() => void showSources(item.sourceIds)}>{t('memory.checkSourcesBtn')}</button>
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {tab === 'capacity' && (
        <>
          <div className="memory-stat-grid">
            <article><strong>{stats?.counts?.message || 0}</strong><span>{t('memory.statMessages')}</span></article>
            <article><strong>{stats?.counts?.memory || 0}</strong><span>{t('memory.statFacts')}</span></article>
            <article><strong>{stats?.counts?.event || 0}</strong><span>{t('memory.statEvents')}</span></article>
            <article><strong>{byteText(stats?.storageBytes)}</strong><span>{stats?.storageBytesEstimated ? t('memory.statStorageEstimated') : t('memory.statStorageActual')}</span></article>
          </div>
          <div className="memory-item">
            <h3>{t('memory.capacityHeading')}</h3>
            <p>{t('memory.capacityPara1')}</p>
            <p>{t('memory.capacityPara2')}</p>
            <p>{t('memory.capacityPara3')}</p>
            <div className="memory-actions">
              <button type="button" disabled={busy} onClick={() => void rebuildSummary()}>
                {t('memory.rebuildSummaryFullBtn')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void perform(async () => {
                  const result = await Repository.request({ op: 'rebuildIndexes', space: mode });
                  if (!result.ok) throw new Error(result.error);
                  onNotice(t('memory.rebuildIndexDoneNotice'));
                })}
              >
                {t('memory.rebuildIndexBtn')}
              </button>
            </div>
          </div>
        </>
      )}

      {busy && <p className="memory-loading" role="status">{t('memory.busyStatus')}</p>}

      {review && (
        <div className="memory-dialog-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setReview(null); }}>
          <section className="memory-dialog memory-dialog-shell" role="dialog" aria-modal="true" aria-labelledby="memory-review-title">
            <div className="memory-dialog-header">
              <h3 id="memory-review-title">{review.conflicts.length ? t('memory.reviewConflictHeading') : t('memory.reviewNewHeading')}</h3>
              <button type="button" aria-label={t('common.close')} onClick={() => !busy && setReview(null)}><X size={18} /></button>
            </div>
            <div className="memory-dialog-body">
              {review.conflicts.map(item => <blockquote key={item.id}>{t('memory.reviewOldFactPrefix')}{item.fact}</blockquote>)}
              <p className="memory-candidate">{t('memory.reviewCandidatePrefix')}{review.candidate.fact}</p>
              <p>{review.conflicts.length ? t('memory.reviewConflictExplain') : t('memory.reviewNewExplain')}</p>
            </div>
            <div className="memory-dialog-footer memory-actions">
              <button type="button" disabled={busy} onClick={() => void saveFact()}>
                <Check size={14} />
                {review.conflicts.length ? t('memory.reviewConflictBtn') : t('memory.reviewNewBtn')}
              </button>
              <button type="button" onClick={() => setReview(null)}>{t('memory.reviewBackBtn')}</button>
            </div>
          </section>
        </div>
      )}

      {deleting && (
        <div className="memory-dialog-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setDeleting(null); }}>
          <section className="memory-dialog memory-dialog-shell" role="dialog" aria-modal="true" aria-labelledby="memory-delete-title">
            <div className="memory-dialog-header">
              <h3 id="memory-delete-title">
                {deleting.rows.length > 1
                  ? (deleting.kind === 'memory'
                    ? t('memory.bulkForgetTitle', { count: deleting.rows.length })
                    : t('memory.bulkDeleteTitle', { count: deleting.rows.length }))
                  : (deleting.kind === 'memory' ? t('memory.deleteMemoryTitle') : t('memory.deleteArchiveTitle'))}
              </h3>
              <button type="button" aria-label={t('common.close')} onClick={() => !busy && setDeleting(null)}><X size={18} /></button>
            </div>
            <div className="memory-dialog-body">
              <p>{deleting.kind === 'memory' ? t('memory.deleteMemoryDesc') : t('memory.deleteArchiveDesc')}</p>
              {deleting.kind === 'memory' && (
                <label className={`memory-check${deleteSources ? ' is-checked' : ''}`}>
                  <input type="checkbox" checked={deleteSources} onChange={event => setDeleteSources(event.target.checked)} />
                  <span>{t('memory.deleteSourcesCheckbox')}</span>
                </label>
              )}
              {deleting.kind === 'memory' && !deleteSources && <p>{t('memory.keepSourcesNote')}</p>}
              <p>{t('memory.deleteScopeNote', { space: spaceName })}</p>
              <label className={`memory-check memory-check--danger${deleteAccepted ? ' is-checked' : ''}`}>
                <input type="checkbox" checked={deleteAccepted} onChange={event => setDeleteAccepted(event.target.checked)} />
                <span>{t('memory.deleteAckCheckbox')}</span>
              </label>
            </div>
            <div className="memory-dialog-footer memory-actions">
              <button type="button" className="memory-danger" disabled={busy || !deleteAccepted} onClick={() => void confirmDelete()}>
                {deleting.kind === 'memory' ? t('memory.confirmForgetBtn') : t('memory.confirmDeleteBtn')}
              </button>
              <button type="button" onClick={() => setDeleting(null)}>{t('memory.cancelBtn')}</button>
            </div>
          </section>
        </div>
      )}

      {sourceRows && (
        <div className="memory-dialog-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setSourceRows(null); }}>
          <section className="memory-dialog memory-dialog-shell" role="dialog" aria-modal="true" aria-labelledby="memory-source-title">
            <div className="memory-dialog-header">
              <h3 id="memory-source-title">{t('memory.sourceDialogHeading')}</h3>
              <button type="button" aria-label={t('memory.sourceCloseAria')} onClick={() => setSourceRows(null)}><X size={18} /></button>
            </div>
            <div className="memory-dialog-body">
              {!sourceRows.length && <p>{t('memory.sourceEmptyNote')}</p>}
              {sourceRows.map(item => (
                <article key={item.id} className="memory-item">
                  <small>{time(item.at)}</small>
                  <p>{item.content}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
export default MemoryCenter;
