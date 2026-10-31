import { useEffect, useRef, useState } from 'react';
import { Archive, BookOpen, Check, ChevronDown, Database, Pin, Search, Sparkles, Trash2, X } from 'lucide-react';
import type { WorkspaceMode } from '../types';
import { newId } from '../services/storage';
import { Repository } from '../persistence/repository';
import type { RecordMutation } from '../persistence/repository';
import { confirmCorrection, memorySources, planForget, recall, reviewFact, summarizeEvents } from '../persistence/memory';
import type { ManagedMemory, MemorySummary, RecallEvidence } from '../persistence/memory';
import '../persistence/memory.css';

export interface MemoryCenterProps {
  mode: WorkspaceMode;
  onNotice(message: string): void;
  modelEnabled?: boolean;
  onModelRecall?(query: string, evidence: RecallEvidence): Promise<string>;
  onEditBusiness?(query: string): void;
}
type Tab = 'facts' | 'archive' | 'recall' | 'capacity';
const time = (at: number) => at ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '时间未记录';
const byteText = (value = 0) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(2)} MB`;
const labels = { message: '原始沟通', event: '确认变更', summary: '阶段摘要' };

export function MemoryCenter({ mode, onNotice, modelEnabled = false, onModelRecall, onEditBusiness }: MemoryCenterProps) {
  const [tab, setTab] = useState<Tab>('facts');
  const [kind, setKind] = useState<'message' | 'event' | 'summary'>('message');
  const [input, setInput] = useState(''); const [query, setQuery] = useState('');
  const [rows, setRows] = useState<any[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<any>(); const [busy, setBusy] = useState(false); const [issue, setIssue] = useState('');
  const [sourceRows, setSourceRows] = useState<{ id: string; content: string; at: number }[] | null>(null);
  const [draft, setDraft] = useState({ subject: '', topic: '', fact: '', sourceId: '' });
  const [editing, setEditing] = useState<ManagedMemory | null>(null);
  const [review, setReview] = useState<{ candidate: ManagedMemory; conflicts: ManagedMemory[]; newSource?: any } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'memory' | 'message' | 'event' | 'summary'; row: any } | null>(null);
  const [deleteSources, setDeleteSources] = useState(false); const [deleteAccepted, setDeleteAccepted] = useState(false);
  const [evidence, setEvidence] = useState<RecallEvidence | null>(null); const [modelReply, setModelReply] = useState('');
  const [evidenceQuery, setEvidenceQuery] = useState('');
  const generation = useRef(0); const modeRef = useRef(mode); modeRef.current = mode;
  const loadSequence = useRef(0);
  const [loadedKey, setLoadedKey] = useState('');
  const viewKey = `${mode}:${tab}:${kind}:${query}`;
  const visibleRows = loadedKey === viewKey ? rows : [];

  async function load(append = false) {
    const sequence = ++loadSequence.current; const ownedMode = mode; setBusy(true); setIssue('');
    try {
      const selected = tab === 'facts' ? 'memory' : kind;
      const [page, capacity] = await Promise.all([
        Repository.query(ownedMode, selected, { query: query || undefined, limit: 30, cursor: append ? cursor || undefined : undefined }),
        Repository.request({ op: 'stats', space: ownedMode }),
      ]);
      if (sequence !== loadSequence.current || modeRef.current !== ownedMode) return;
      setRows(previous => append ? [...previous, ...page.items] : page.items); setLoadedKey(viewKey); setCursor(page.nextCursor || null); setStats(capacity);
    } catch (error) { if (sequence === loadSequence.current && modeRef.current === ownedMode) setIssue(error instanceof Error ? error.message : '档案读取失败，原数据保留。'); }
    finally { if (sequence === loadSequence.current && modeRef.current === ownedMode) setBusy(false); }
  }
  useEffect(() => { generation.current++; setRows([]); setCursor(null); setSourceRows(null); setEvidence(null); setModelReply(''); setReview(null); setDeleting(null); setDraft({ subject: '', topic: '', fact: '', sourceId: '' }); setEditing(null); }, [mode]);
  useEffect(() => { void load(); return () => { loadSequence.current++; }; }, [mode, tab, kind, query]);
  useEffect(() => Repository.subscribe(() => { void load(); }), [mode, tab, kind, query]);

  async function perform(action: () => Promise<void>) {
    const ownedMode = mode; setBusy(true); setIssue('');
    try { await action(); }
    catch (error) { if (ownedMode === modeRef.current) setIssue(error instanceof Error ? error.message : '操作未完成，原数据保留。'); }
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
        if (event) { output.push({ id, content: event.sourceText || '已确认变更（原文未记录）', at: event.createdAt }); continue; }
        const project = ownedMode === 'work' ? await Repository.get(ownedMode, 'engagement', id) : null;
        output.push(project ? { id, content: `${project.clientName} · ${project.title}；当前预算：${project.budgetAmount ?? '未确认'}；下一步：${project.nextAction}`, at: project.updatedAt } : { id, content: '来源已删除，或这是用户手动确认的事实标记。', at: 0 });
      }
      if (modeRef.current === ownedMode) setSourceRows(output);
    });
  }

  async function prepareFact() {
    const ownedMode = mode;
    await perform(async () => {
      if (!draft.fact.trim()) throw new Error('请先写下需要确认的事实。');
      const sourceId = draft.sourceId || newId('memory-source');
      const candidate: ManagedMemory = { id: newId('memory'), mode: ownedMode, category: ownedMode === 'work' ? 'business' : 'experience',
        fact: draft.fact.trim(), subject: draft.subject.trim(), topic: draft.topic.trim(), importance: editing?.importance ?? 3,
        pinned: editing?.pinned || false, status: 'active', createdAt: Date.now(), sourceIds: [sourceId] };
      const pages = await Promise.all([
        candidate.subject ? Repository.query(ownedMode, 'memory', { names: [candidate.subject], limit: 200 }) : Promise.resolve({ items: [] }),
        Repository.query(ownedMode, 'memory', { query: candidate.fact.length >= 2 ? candidate.fact : undefined, limit: 200 }),
      ]);
      const existing = [...new Map<string, ManagedMemory>(pages.flatMap(page => page.items).map(item => [item.id, item])).values()];
      const result = reviewFact(candidate, existing);
      if (result.type === 'duplicate' && (!editing || editing.id !== result.duplicate.id)) { onNotice('完全相同的事实已经保存，未重复添加。'); return; }
      const conflicts = [...new Map([...result.conflicts, ...(editing ? [editing] : [])].map(item => [item.id, item])).values()];
      if (modeRef.current === ownedMode) setReview({ candidate, conflicts, newSource: draft.sourceId ? undefined : {
        id: sourceId, role: 'user', content: `用户手动确认事实：${candidate.subject} ${candidate.topic}\n${candidate.fact}`, timestamp: candidate.createdAt,
      } });
    });
  }
  async function saveFact() {
    if (!review) return;
    const approved = review; const ownedMode = mode;
    await perform(async () => {
      const mutations: RecordMutation[] = [];
      for (const before of approved.conflicts) mutations.push({ kind: 'memory', id: before.id, before, after: confirmCorrection(before, approved.candidate).previous });
      const after = { ...approved.candidate, ...(approved.conflicts[0] ? { supersedesId: approved.conflicts[0].id, validFrom: Date.now() } : {}) };
      mutations.push({ kind: 'memory', id: after.id, before: null, after });
      if (approved.newSource) mutations.push({ kind: 'message', id: approved.newSource.id, before: null, after: approved.newSource });
      const result = await Repository.transaction(ownedMode, mutations, { event: true, sourceMessageId: after.sourceIds[0], sourceText: '用户核对并确认长期事实' });
      if (!result.ok) throw new Error(result.error);
      if (ownedMode === modeRef.current) { setReview(null); setEditing(null); setDraft({ subject: '', topic: '', fact: '', sourceId: '' }); onNotice('事实已确认保存，来源可以随时核查。'); await load(); }
    });
  }

  async function derivedSummaries(space: WorkspaceMode, sourceIds: string[]): Promise<MemorySummary[]> {
    const queue = [...sourceIds]; const seen = new Set<string>(); const found = new Map<string, MemorySummary>();
    while (queue.length) {
      const id = queue.shift(); if (seen.has(id)) continue; seen.add(id);
      let next: string | undefined;
      do { const page = await Repository.query<MemorySummary>(space, 'summary', { relatedId: id, limit: 200, cursor: next });
        for (const summary of page.items) if (!found.has(summary.id)) { found.set(summary.id, summary); queue.push(summary.id); }
        next = page.nextCursor || undefined;
      } while (next);
    }
    return [...found.values()];
  }
  async function confirmDelete() {
    if (!deleting || !deleteAccepted) return;
    const target = deleting; const ownedMode = mode;
    await perform(async () => {
      const mutations: RecordMutation[] = [];
      const sourceIds = target.kind === 'memory' ? memorySources(target.row) : [target.row.id];
      const summaries = await derivedSummaries(ownedMode, [target.row.id, ...sourceIds]);
      if (target.kind === 'memory') {
        const plan = planForget(target.row, summaries, deleteSources);
        mutations.push({ kind: 'memory', id: target.row.id, before: target.row, after: plan.fact });
        if (deleteSources) for (const id of plan.sourceIdsToDelete) {
          const before = await Repository.get(ownedMode, 'message', id);
          if (before) mutations.push({ kind: 'message', id, before, after: null });
          let next: string | undefined;
          do {
            const page = await Repository.query<ManagedMemory>(ownedMode, 'memory', { relatedId: id, limit: 200, cursor: next });
            for (const fact of page.items) if (fact.id !== target.row.id && fact.status !== 'retracted') mutations.push({ kind: 'memory', id: fact.id, before: fact, after: { ...fact, status: 'retracted' } });
            next = page.nextCursor || undefined;
          } while (next);
        }
      } else {
        mutations.push({ kind: target.kind, id: target.row.id, before: target.row, after: null });
        // Source removal also stops the automatic use of facts that directly depend on it.
        let next: string | undefined;
        do { const page = await Repository.query<ManagedMemory>(ownedMode, 'memory', { relatedId: target.row.id, limit: 200, cursor: next });
          for (const fact of page.items) if (fact.status !== 'retracted') mutations.push({ kind: 'memory', id: fact.id, before: fact, after: { ...fact, status: 'retracted' } });
          next = page.nextCursor || undefined;
        } while (next);
      }
      for (const before of summaries) if (!(target.kind === 'summary' && before.id === target.row.id)) mutations.push({ kind: 'summary', id: before.id, before, after: null });
      const unique = [...new Map(mutations.map(mutation => [`${mutation.kind}:${mutation.id}`, mutation])).values()];
      const redactSourceIds = unique.filter(m => m.kind === 'message' && m.after === null).map(m => m.id);
      const result = await Repository.transaction(ownedMode, unique, { sourceText: '用户主动清理记忆及派生资料', event: false, ...(redactSourceIds.length ? { redactSourceIds } : {}) });
      if (!result.ok) throw new Error(result.error);
      if (ownedMode === modeRef.current) { setDeleting(null); setDeleteAccepted(false); setDeleteSources(false); setEvidence(null); setModelReply(''); onNotice(target.kind === 'memory' && !deleteSources ? '已停止默认回忆，并清理关联摘要；原文仍可在历史档案手动查阅。' : '已删除选定资料和关联索引、摘要；已导出的备份副本不受影响。'); await load(); }
    });
  }
  async function doRecall(withModel = false) {
    const ownedMode = mode; const requestGeneration = generation.current;
    await perform(async () => {
      if (input.trim().length < 2) throw new Error('请用至少两个字描述想回忆的内容。');
      if (withModel && (!evidence || evidenceQuery !== input.trim())) throw new Error('请先查找并核对本次依据，再使用模型整理。');
      const result = withModel ? evidence! : await recall(input.trim(), ownedMode);
      if (ownedMode !== modeRef.current || requestGeneration !== generation.current) return;
      setEvidence(result); setEvidenceQuery(input.trim()); setModelReply('');
      if (withModel && result.items.length && modelEnabled && onModelRecall) {
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
      if (!summary.sourceIds.length) throw new Error('当前空间没有可整理的已确认变更。');
      await Repository.upsert(ownedMode, 'summary', [summary]);
      if (ownedMode === modeRef.current) { onNotice('已整理最近40项以内的确认变更；摘要只用于定位历史。'); setKind('summary'); setTab('archive'); }
    });
  }

  return <section className="memory-center" aria-label={`${mode === 'work' ? '工作' : '生活'}记忆与档案`}>
    <div className="memory-heading"><div><span className="memory-eyebrow">LOOMA · LOCAL MEMORY</span><h2>记忆与档案</h2><p>{mode === 'work' ? '工作' : '生活'}空间 · 本地归档，保留原文，由你决定记住和删除。</p></div><BookOpen size={28}/></div>
    <nav className="memory-tabs" aria-label="记忆分类">{([['facts', '长期事实', BookOpen], ['archive', '历史档案', Archive], ['recall', '只读回忆', Sparkles], ['capacity', '容量概况', Database]] as const).map(([value, label, Icon]) =>
      <button key={value} type="button" className={tab === value ? 'active' : ''} aria-pressed={tab === value} onClick={() => { setTab(value); setQuery(''); setInput(''); }}><Icon size={15}/>{label}</button>)}</nav>
    {issue && <p className="memory-error" role="alert">{issue}</p>}
    {tab !== 'capacity' && <form className="memory-search" onSubmit={event => { event.preventDefault(); tab === 'recall' ? void doRecall() : setQuery(input.trim()); }}>
      <Search size={17}/><input aria-label={tab === 'recall' ? '想回忆什么' : '搜索当前空间'} value={input} onChange={event => setInput(event.target.value)} placeholder={tab === 'recall' ? '例如：张三的预算、上次讨论的绿茶…' : '搜索姓名、项目或至少两个字的关键词'}/>
      <button type="submit" disabled={busy}>{tab === 'recall' ? '查找依据' : '搜索'}</button>{query && <button type="button" onClick={() => { setQuery(''); setInput(''); }}>清空</button>}
    </form>}
    {tab === 'facts' && <>
      {mode === 'work' && onEditBusiness && <p className="memory-hint">预算、项目进展和行动以项目记录为准。<button type="button" onClick={() => onEditBusiness(query)}>去项目核对业务资料</button>修改长期事实不会同步改写当前项目。</p>}
      <details className="memory-compose" open={!!editing || !!draft.sourceId}><summary>明确记住一条事实</summary><p>仅保存你在此核对确认的内容。同一主体、同一主题出现不同值时，会先请你核对。</p>
        <div className="memory-two-cols"><label>主体<input value={draft.subject} onChange={event => setDraft({ ...draft, subject: event.target.value })} placeholder="例如：张三／我"/></label><label>主题<input value={draft.topic} onChange={event => setDraft({ ...draft, topic: event.target.value })} placeholder="例如：沟通偏好"/></label></div>
        <label>需要确认的事实<textarea value={draft.fact} onChange={event => setDraft({ ...draft, fact: event.target.value })} rows={3} placeholder="原文、临时情绪和模型推测不会自动成为长期事实。"/></label>
        {draft.sourceId && <small>来源：{draft.sourceId}</small>}<div className="memory-actions"><button type="button" disabled={busy || !draft.fact.trim()} onClick={() => void prepareFact()}>{editing ? '核对纠正内容' : '预览待确认事实'}</button>{editing && <button type="button" onClick={() => { setEditing(null); setDraft({ subject: '', topic: '', fact: '', sourceId: '' }); }}>取消纠正</button>}</div>
      </details>
      <div className="memory-list">{visibleRows.map((item: ManagedMemory) => <article className={`memory-item ${item.status && item.status !== 'active' ? 'memory-inactive' : ''}`} key={item.id}>
        <div className="memory-item-top"><span>{item.subject || '未指定主体'}{item.topic ? ` · ${item.topic}` : ''}</span><span>{item.pinned && '📌 '}{item.status === 'retracted' ? '已忘记／不默认回忆' : item.status === 'superseded' ? '已被后续事实替代' : '已确认'}</span></div>
        <p>{item.fact}</p><small>{time(item.validFrom || item.createdAt)}</small>
        <div className="memory-actions"><button type="button" onClick={() => void showSources(memorySources(item))}>查看来源</button>{(!item.status || item.status === 'active') && <>
          <button type="button" disabled={busy} onClick={() => void perform(async () => { await Repository.upsert(mode, 'memory', [{ ...item, pinned: !item.pinned }]); })}><Pin size={13}/>{item.pinned ? '取消置顶' : '置顶'}</button>
          <button type="button" onClick={() => { setEditing(item); setDraft({ subject: item.subject || '', topic: item.topic || '', fact: item.fact, sourceId: '' }); }}>纠正事实文本</button>
          {mode === 'work' && onEditBusiness && <button type="button" onClick={() => onEditBusiness(item.subject || '')}>修改对应项目或行动</button>}
          <button type="button" className="memory-danger" onClick={() => { setDeleting({ kind: 'memory', row: item }); setDeleteAccepted(false); setDeleteSources(false); }}>忘记</button></>}</div>
      </article>)}</div>
    </>}
    {tab === 'archive' && <><div className="memory-filter"><label>资料类型<select aria-label="资料类型" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="message">原始沟通</option><option value="event">确认变更</option><option value="summary">阶段摘要</option></select></label><button type="button" disabled={busy} onClick={() => void rebuildSummary()}>整理最近确认记录</button></div>
      <p className="memory-hint">原文按需分页加载；历史金额与表达仅作来源，当前业务值以项目卡为准。</p>
      <div className="memory-list">{visibleRows.map(item => <article className="memory-item" key={item.id}><div className="memory-item-top"><span>{labels[kind]}{kind === 'message' ? ` · ${item.role === 'user' ? '你' : item.role === 'assistant' ? 'Looma' : '系统'}` : ''}</span><span>{time(item.timestamp || item.createdAt)}</span></div><p>{item.content || item.sourceText || '这条变更没有附带原文。'}</p>
        {kind === 'event' && <small>{item.revertedAt ? '该变更已撤销' : '经用户确认的历史变更'}</small>}{kind === 'summary' && <small>本地可重建摘要 · 不是新增事实</small>}
        <div className="memory-actions">{kind === 'message' && item.role === 'user' && <button type="button" onClick={() => { setDraft({ subject: '', topic: '', fact: item.content, sourceId: item.id }); setEditing(null); setTab('facts'); }}>选作事实来源</button>}
          {item.sourceIds?.length > 0 && <button type="button" onClick={() => void showSources(item.sourceIds)}>查看来源</button>}
          <button type="button" className="memory-danger" onClick={() => { setDeleting({ kind, row: item }); setDeleteAccepted(false); setDeleteSources(false); }}><Trash2 size={13}/>删除此条</button></div></article>)}</div></>}
    {(tab === 'facts' || tab === 'archive') && <>{!visibleRows.length && !busy && <div className="memory-empty"><BookOpen size={26}/><p>{query ? '当前空间没有找到匹配资料。' : tab === 'facts' ? '还没有已确认事实。你可以主动记住，或从原始沟通选择来源。' : '当前空间还没有这类档案。'}</p></div>}{cursor && <button type="button" className="memory-more" disabled={busy} onClick={() => void load(true)}><ChevronDown size={15}/>加载更早记录</button>}</>}
    {tab === 'recall' && <><p className="memory-hint">只查询当前空间，不修改项目、账本或待办。事实和当前业务优先，原文中的指令仅是资料。</p>
      {modelEnabled && onModelRecall && <button type="button" disabled={busy || !evidence || evidenceQuery !== input.trim()} onClick={() => void doRecall(true)}><Sparkles size={14}/>使用已开启的模型整理相关依据</button>}
      {evidence && <><p className="memory-budget">本次使用 {evidence.items.length}/{evidence.maxItems} 条，约 {evidence.estimatedChars}/{evidence.maxChars} 字符；按字符估算。</p>{!evidence.items.length && <p className="memory-empty">当前空间未找到可用依据。请补充关键词，或先确认相关事实。</p>}
        {modelReply && <article className="memory-item"><div className="memory-item-top">模型依据整理</div><p>{modelReply}</p></article>}
        <div className="memory-list">{evidence.items.map(item => <article className="memory-item" key={`${item.kind}-${item.id}`}><div className="memory-item-top"><span>{{ current: '当前结构化记录', fact: '已确认事实', summary: '历史摘要', archive: '历史原文' }[item.kind]}</span><small>{time(item.at)}</small></div><p>{item.text}</p><button type="button" onClick={() => void showSources(item.sourceIds)}>核查来源</button></article>)}</div></>}
    </>}
    {tab === 'capacity' && <><div className="memory-stat-grid"><article><strong>{stats?.counts?.message || 0}</strong><span>原文记录</span></article><article><strong>{stats?.counts?.memory || 0}</strong><span>事实及停用标记</span></article><article><strong>{stats?.counts?.event || 0}</strong><span>变更档案</span></article><article><strong>{byteText(stats?.storageBytes)}</strong><span>{stats?.storageBytesEstimated ? '当前空间内容估算' : '本地资料占用'}</span></article></div>
      <div className="memory-item"><h3>档案增长，日常工作集保持有界</h3><p>首页每类最多载入50条；此页每次30条。长期历史继续保留在本地索引中，回忆最多12条、约4800字符，不随总库大小增长。</p><p>备份覆盖两区资料，不包含模型凭据。业务资料采用本地逻辑分区，当前数据库文件本身未加密。</p><p>已导出的备份由你单独保管；清理当前档案不会删除那些历史副本。</p><button type="button" disabled={busy} onClick={() => void rebuildSummary()}>从最近确认记录重建本地摘要</button><button type="button" disabled={busy} onClick={() => void perform(async () => { const result = await Repository.request({ op: 'rebuildIndexes', space: mode }); if (!result.ok) throw new Error(result.error); onNotice('当前空间的检索索引已重建，业务记录未改变。'); })}>重建当前空间检索索引</button></div></>}
    {busy && <p className="memory-loading" role="status">正在读取或保存本地资料…</p>}
    {review && <div className="memory-dialog-backdrop"><section className="memory-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-review-title"><h3 id="memory-review-title">{review.conflicts.length ? '同一主题出现不同内容，请核对' : '确认记住这条事实'}</h3>
      {review.conflicts.map(item => <blockquote key={item.id}>原事实：{item.fact}</blockquote>)}<p className="memory-candidate">待确认：{review.candidate.fact}</p><p>{review.conflicts.length ? '确认后旧事实保留为已被替代记录，新的内容进入默认回忆。原文仍保留。' : '该事实来自你的明确确认，随时可以纠正或忘记。'}</p><div className="memory-actions"><button type="button" disabled={busy} onClick={() => void saveFact()}><Check size={14}/>{review.conflicts.length ? '确认纠正并替代旧事实' : '确认保存'}</button><button type="button" onClick={() => setReview(null)}>返回修改</button></div></section></div>}
    {deleting && <div className="memory-dialog-backdrop"><section className="memory-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-delete-title"><h3 id="memory-delete-title">{deleting.kind === 'memory' ? '忘记这条事实' : '删除选定档案'}</h3><p>{deleting.kind === 'memory' ? '停止这条事实及相关派生内容的默认回忆，清理关联摘要和索引；保留停用标记。' : '删除这一条原始资料，同时清理索引和相关摘要，停用直接依赖它的事实。业务项目和金额不会被此操作删除。'}</p>
      {deleting.kind === 'memory' && <label className="memory-check"><input type="checkbox" checked={deleteSources} onChange={event => setDeleteSources(event.target.checked)}/>同时删除这条事实引用的原始沟通</label>}
      {deleting.kind === 'memory' && !deleteSources && <p>原文仍会保留，可在历史档案中手动查阅。</p>}<p>范围仅限当前{mode === 'work' ? '工作' : '生活'}空间；已导出的备份副本由你另行处理。</p>
      <label className="memory-check"><input type="checkbox" checked={deleteAccepted} onChange={event => setDeleteAccepted(event.target.checked)}/>已了解范围，确认执行</label><div className="memory-actions"><button type="button" className="memory-danger" disabled={busy || !deleteAccepted} onClick={() => void confirmDelete()}>确认{deleting.kind === 'memory' ? '忘记' : '删除'}</button><button type="button" onClick={() => setDeleting(null)}>取消</button></div></section></div>}
    {sourceRows && <div className="memory-dialog-backdrop"><section className="memory-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-source-title"><div className="memory-heading"><h3 id="memory-source-title">原文依据</h3><button type="button" aria-label="关闭来源" onClick={() => setSourceRows(null)}><X size={18}/></button></div>{!sourceRows.length && <p>这条事实由用户手动确认，旧记录未保存来源ID。</p>}{sourceRows.map(item => <article key={item.id} className="memory-item"><small>{time(item.at)} · {item.id}</small><p>{item.content}</p></article>)}</section></div>}
  </section>;
}
export default MemoryCenter;
