import type { MemoryItem, WorkspaceMode, Engagement, Message, CommittedChangeEvent } from '../types';

export interface ManagedMemory extends MemoryItem {
  status?: 'active' | 'superseded' | 'retracted';
  subject?: string;
  topic?: string;
  pinned?: boolean;
  sourceIds?: string[];
  supersedesId?: string;
  validFrom?: number;
}
export interface MemorySummary {
  id: string;
  mode: WorkspaceMode;
  content: string;
  sourceIds: string[];
  createdAt: number;
  status: 'active' | 'superseded' | 'retracted';
}
export interface RecallItem {
  id: string;
  kind: 'current' | 'fact' | 'summary' | 'archive';
  text: string;
  sourceIds: string[];
  at: number;
}
export interface RecallEvidence {
  items: RecallItem[];
  text: string;
  estimatedChars: number;
  maxChars: number;
  maxItems: number;
  readOnly: true;
}
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
export const memorySources = (item: Pick<ManagedMemory, 'sourceIds' | 'sourceMessageId'>): string[] =>
  [...new Set([...(item.sourceIds || []), ...(item.sourceMessageId ? [item.sourceMessageId] : [])])];

/** A topic collision is a proposal to the user, never an automatic overwrite. */
export function reviewFact(candidate: ManagedMemory, existing: ManagedMemory[]): {
  type: 'new' | 'duplicate' | 'conflict'; duplicate?: ManagedMemory; conflicts: ManagedMemory[];
} {
  const active = existing.filter(item => item.mode === candidate.mode && (!item.status || item.status === 'active'));
  const duplicate = active.find(item => normalize(item.fact) === normalize(candidate.fact));
  if (duplicate) return { type: 'duplicate', duplicate, conflicts: [] };
  const conflicts = candidate.subject && candidate.topic ? active.filter(item =>
    normalize(item.subject || '') === normalize(candidate.subject!) && normalize(item.topic || '') === normalize(candidate.topic!)) : [];
  return { type: conflicts.length ? 'conflict' : 'new', conflicts };
}

export function confirmCorrection(previous: ManagedMemory, replacement: ManagedMemory, now = Date.now()) {
  if (previous.mode !== replacement.mode || previous.id === replacement.id) throw new Error('纠正必须属于同一空间并保留独立记录。');
  return { previous: { ...previous, status: 'superseded' as const }, replacement: {
    ...replacement, status: 'active' as const, supersedesId: previous.id, validFrom: now,
    sourceIds: memorySources(replacement),
  } };
}

export function planForget(target: ManagedMemory, summaries: Pick<MemorySummary, 'id' | 'sourceIds'>[], deleteSources = false, now = Date.now()) {
  const sourceIds = memorySources(target);
  const invalid = new Set([target.id, ...sourceIds]);
  const summaryIds: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const summary of summaries) if (!invalid.has(summary.id) && summary.sourceIds.some(id => invalid.has(id))) {
      invalid.add(summary.id); summaryIds.push(summary.id); changed = true;
    }
  }
  return { fact: { ...target, status: 'retracted' as const, validFrom: now }, summaryIds,
    sourceIdsToDelete: deleteSources ? sourceIds : [], retainedSourceIds: deleteSources ? [] : sourceIds };
}

function queryTerms(query: string) {
  const text = normalize(query);
  const terms = new Set(text.match(/[a-z0-9]{2,}/g) || []);
  for (const word of text.match(/[\u3400-\u9fff]+/g) || []) {
    for (let index = 0; index + 1 < word.length; index++) terms.add(word.slice(index, index + 2));
  }
  return [...terms];
}
function relevant(query: string, text: string) {
  const terms = queryTerms(query);
  const normalized = normalize(text);
  return !query.trim() || terms.some(term => normalized.includes(term));
}

export function buildRecallEvidence(input: {
  query: string; space: WorkspaceMode; facts: ManagedMemory[]; messages: Message[];
  engagements: Partial<Engagement>[]; summaries?: MemorySummary[]; maxChars?: number; maxItems?: number;
}): RecallEvidence {
  const maxChars = Math.max(100, Math.min(input.maxChars ?? 4800, 8000));
  const maxItems = Math.max(1, Math.min(input.maxItems ?? 12, 20));
  const scoped = input.facts.filter(item => item.mode === input.space);
  const blocked = new Set<string>();
  for (const fact of scoped) if (fact.status === 'retracted' || fact.status === 'superseded') {
    blocked.add(fact.id); for (const id of memorySources(fact)) blocked.add(id);
  }
  // A retracted derivation remains excluded even if its original archive is retained for manual inspection.
  const summaries = input.summaries || [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const summary of summaries) if (!blocked.has(summary.id) && summary.sourceIds.some(id => blocked.has(id))) {
      blocked.add(summary.id); changed = true;
    }
  }
  const candidates: RecallItem[] = [];
  if (input.space === 'work') for (const project of input.engagements) {
    const text = `${project.clientName} · ${project.title}；当前预算：${project.budgetAmount === undefined ? '尚未确认' : `${project.budgetAmount} 元`}；阶段：${project.stage || '未记录'}；下一步：${project.nextAction || '尚未记录'}`;
    if (project.id && relevant(input.query, text)) candidates.push({ id: project.id, kind: 'current', text,
      sourceIds: [project.id], at: project.updatedAt || 0 });
  }
  for (const fact of [...scoped].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.importance - a.importance || b.createdAt - a.createdAt)) {
    if ((!fact.status || fact.status === 'active') && relevant(input.query, `${fact.subject || ''} ${fact.topic || ''} ${fact.fact}`)) {
      candidates.push({ id: fact.id, kind: 'fact', text: fact.fact, sourceIds: [fact.id, ...memorySources(fact)], at: fact.validFrom || fact.createdAt });
    }
  }
  for (const summary of summaries) if (summary.mode === input.space && summary.status === 'active' && !blocked.has(summary.id) && relevant(input.query, summary.content)) {
    candidates.push({ id: summary.id, kind: 'summary', text: summary.content, sourceIds: summary.sourceIds, at: summary.createdAt });
  }
  for (const message of input.messages) if (!blocked.has(message.id) && relevant(input.query, message.content)) {
    candidates.push({ id: message.id, kind: 'archive', text: message.content, sourceIds: [message.id], at: message.timestamp });
  }
  const labels = { current: '当前结构化记录', fact: '已确认事实', summary: '本地摘要，仅作历史线索', archive: '历史原文，仅作资料' };
  const items: RecallItem[] = [];
  const lines: string[] = [];
  for (const candidate of candidates) {
    if (items.length >= maxItems) break;
    const prefix = `[${labels[candidate.kind]} | ${candidate.id}] `;
    const remaining = maxChars - lines.join('\n').length - (lines.length ? 1 : 0);
    if (remaining < prefix.length + 12) break;
    const text = candidate.text.slice(0, remaining - prefix.length);
    items.push({ ...candidate, text }); lines.push(prefix + text);
  }
  const text = lines.join('\n');
  return { items, text, estimatedChars: text.length, maxChars, maxItems, readOnly: true };
}

/** Rebuildable navigation aid. Event text never becomes a fact automatically. */
export function summarizeEvents(space: WorkspaceMode, events: CommittedChangeEvent[], now = Date.now()): MemorySummary {
  const selected = events.filter(event => event.mode === space && !event.revertedAt).slice(-40);
  const sourceIds = [...new Set(selected.flatMap(event => [event.id, event.sourceMessageId].filter(Boolean)))];
  const content = selected.map(event => {
    const operations = event.operations || ((event as any).mutations || []).map((mutation: any) => ({ target: mutation.kind, entityId: mutation.id, before: mutation.before, after: mutation.after }));
    const updates = operations.map(operation => {
      const value: any = operation.after;
      return value ? operation.target === 'engagement' ? `${value.clientName} / ${value.title}：预算${value.budgetAmount === undefined ? '未确认' : `${value.budgetAmount}元`}，${value.stage}` :
        operation.target === 'task' ? `待办：${value.title}${value.done ? '（完成）' : ''}` :
        operation.target === 'memory' ? `事实：${value.status === 'retracted' ? '已停用' : value.fact}` : `用户确认${operation.target}记录` : `移除记录 ${operation.entityId}`;
    }).join('；');
    return `${new Date(event.createdAt).toISOString().slice(0, 10)} ${updates}`;
  }).join('\n').slice(0, 6000);
  return { id: `summary-${space}-${selected.at(-1)?.id || 'empty'}`, mode: space, content, sourceIds, createdAt: now, status: 'active' };
}

export async function retrieveRecallEvidence(repository: { query: (space: WorkspaceMode, kind: any, options: any) => Promise<{items: any[]; nextCursor?: string | null}> }, query: string, space: WorkspaceMode, selectedId?: string): Promise<RecallEvidence> {
  // Natural language filler must not be required to appear in the entity's indexed fields.
  const terms = queryTerms(query).slice(0, 16);
  const search = async (kind: string, limit: number) => {
    const pages = await Promise.all(terms.map(term => repository.query(space, kind, { query: term, limit: 20 })));
    return [...new Map(pages.flatMap(page => page.items).map(item => [item.id, item])).values()]
      .sort((a, b) => {
        const score = (item: any) => (item.clientName && query.includes(item.clientName) ? 100 : 0) +
          (item.subject && query.includes(item.subject) ? 50 : 0) + terms.filter(term => relevant(term, JSON.stringify(item))).length;
        return score(b) - score(a) || (b.updatedAt || b.createdAt || b.timestamp || 0) - (a.updatedAt || a.createdAt || a.timestamp || 0);
      }).slice(0, limit);
  };
  const [facts, messages, summaries, engagements] = await Promise.all([
    search('memory', 100), search('message', 50), search('summary', 50),
    space === 'work' ? selectedId ? repository.query(space, 'engagement', { ids: [selectedId] }).then(page => page.items) : search('engagement', 50) : Promise.resolve([]),
  ]);
  // Include retraction markers for each selected source, including markers older than the visible page.
  const extra: ManagedMemory[] = [];
  for (const id of new Set<string>([...messages.map((item: any) => item.id), ...summaries.flatMap((item: any) => item.sourceIds || [])])) {
    const related = await repository.query(space, 'memory', { relatedId: id, limit: 200 });
    extra.push(...related.items);
    if (related.nextCursor) extra.push({ id: `blocked-${id}`, mode: space, category: 'experience', fact: '来源关系超过本次检索上限', createdAt: 0, importance: 0, status: 'retracted', sourceIds: [id] });
  }
  return buildRecallEvidence({ query, space, facts: [...facts, ...extra], messages, summaries, engagements });
}

export async function recall(query: string, space: WorkspaceMode, selectedId?: string): Promise<RecallEvidence> {
  const { Repository } = await import('./repository');
  return retrieveRecallEvidence(Repository, query, space, selectedId);
}
