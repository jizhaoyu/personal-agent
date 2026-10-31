import type { CaptureDraft, ProposedChangeSet, ProposalConflict, WorkOperation, WorkPartition } from '../types';
import { newId } from './storage';
import { sameValue } from '../../shared/persistence-core.mjs';

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (a: unknown, b: unknown) => sameValue(a, b);
const sourceId = (sessionId: string, version: number) => `source-${sessionId}-${version}`;
const wireValue = (value: unknown) => value === undefined ? null : copy(value);
const meaningful = (value: any) => value && Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'updatedAt'));

export function createCaptureDraft(now = Date.now()): CaptureDraft {
  const sessionId = newId('capture');
  return { id: 'active-work', sessionId, mode: 'work', text: '', sourceVersion: 0, draftVersion: 0,
    sourceMessageId: sourceId(sessionId, 0), status: 'editing', updatedAt: now };
}

export function reviseCaptureDraft(draft: CaptureDraft, patch: Partial<CaptureDraft>, now = Date.now()): CaptureDraft {
  const allowed = ['text', 'selectedEngagementId', 'newClientName', 'newProjectTitle', 'proposal', 'conflicts', 'status'] as const;
  const next = copy(draft);
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) {
    if (patch[key] === undefined) delete next[key];
    else (next as any)[key] = copy(patch[key]);
  }
  if (allowed.every(key => equal(next[key], draft[key]))) return next;
  const changedInput = ['text', 'selectedEngagementId', 'newClientName', 'newProjectTitle'].some(key => !equal(next[key], draft[key]));
  next.draftVersion = draft.draftVersion + 1; next.updatedAt = now;
  if (changedInput) {
    next.sourceVersion = draft.sourceVersion + 1;
    next.sourceMessageId = sourceId(draft.sessionId, next.sourceVersion);
    delete next.proposal; delete next.conflicts; next.status = 'editing';
  }
  return next;
}

function currentFor(partition: WorkPartition, operation: WorkOperation): any {
  const rows = operation.target === 'engagement' ? partition.engagements : operation.target === 'task' ? partition.tasks :
    operation.target === 'followup' ? partition.followUps || [] : partition.memories;
  return rows.find(row => row.id === operation.entityId) || null;
}
function conflict(operation: WorkOperation, field: string, original: unknown, current: unknown, proposed: unknown): ProposalConflict {
  return { id: `${operation.target}:${operation.entityId}:${field}`, target: operation.target, entityId: operation.entityId,
    field, original: wireValue(original), current: wireValue(current), proposed: wireValue(proposed) };
}
export function rebaseProposal(proposal: ProposedChangeSet, partition: WorkPartition): { proposal: ProposedChangeSet; conflicts: ProposalConflict[] } {
  const conflicts: ProposalConflict[] = [];
  const operations: WorkOperation[] = [];
  for (const original of proposal.operations) {
    const operation = copy(original); const current = currentFor(partition, operation);
    if (!operation.before || !operation.after || !current) {
      if (equal(current, operation.after)) continue;
      if (!equal(current, operation.before)) conflicts.push(conflict(operation, '$entity', operation.before, current, operation.after));
      operation.before = copy(current); operations.push(operation); continue;
    }
    const before: any = operation.before, proposed: any = operation.after;
    const after: any = copy(current);
    for (const field of new Set([...Object.keys(before), ...Object.keys(proposed)])) {
      if (field === 'id' || field === 'updatedAt' || equal(before[field], proposed[field])) continue;
      if (!equal(current[field], before[field]) && !equal(current[field], proposed[field])) {
        conflicts.push(conflict(operation, field, before[field], current[field], proposed[field]));
      }
      if (proposed[field] === undefined) delete after[field]; else after[field] = copy(proposed[field]);
    }
    if ('updatedAt' in after) after.updatedAt = Math.max(current.updatedAt || 0, proposed.updatedAt || 0);
    if (!equal(meaningful(after), meaningful(current))) operations.push({ ...operation, before: copy(current), after } as WorkOperation);
  }
  return { proposal: { ...copy(proposal), baseRevision: partition.revision, operations }, conflicts };
}

export function resolveProposalConflict(proposal: ProposedChangeSet, conflicts: ProposalConflict[], id: string, choice: 'current' | 'proposed') {
  const selected = conflicts.find(item => item.id === id);
  if (!selected || !['current', 'proposed'].includes(choice)) return { proposal: copy(proposal), conflicts: copy(conflicts) };
  const operations = proposal.operations.flatMap(operation => {
    if (operation.target !== selected.target || operation.entityId !== selected.entityId) return [copy(operation)];
    if (selected.field === '$entity') {
      if (choice === 'current') return [];
      return [{ ...copy(operation), before: copy(selected.current), after: copy(selected.proposed) } as WorkOperation];
    }
    const after: any = copy(operation.after);
    const value = selected[choice];
    if (value === null) delete after[selected.field]; else after[selected.field] = copy(value);
    if (equal(meaningful(operation.before), meaningful(after))) return [];
    return [{ ...copy(operation), after } as WorkOperation];
  });
  return { proposal: { ...copy(proposal), operations }, conflicts: conflicts.filter(item => item.id !== id).map(copy) };
}
