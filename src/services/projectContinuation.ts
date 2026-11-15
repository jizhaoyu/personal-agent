import type { ArtifactDraft, CaptureDraft, ClosureRecord, CommittedChangeEvent, ConditionIntent, Engagement, FollowUpItem, Message, ProjectTaskItem } from '../types';
import type { QueryOptions, QueryPage } from '../persistence/repository';
import type { RecordKind } from '../persistence/indexedDb';
import { eventMutations } from '../../shared/persistence-core.mjs';

/** Read-only projections: no persisted schema or model calls. */
export interface ContinuationReader {
  get<T>(space: 'work', kind: RecordKind, id: string): Promise<T | null>;
  query<T>(space: 'work', kind: RecordKind, options: QueryOptions): Promise<QueryPage<T>>;
  getReadIdentity?(): string;
}
export interface ProjectContinuationData {
  project: Engagement;
  tasks: QueryPage<ProjectTaskItem>;
  followUps: QueryPage<FollowUpItem>;
  conditions?: QueryPage<ConditionIntent>;
  artifacts?: QueryPage<ArtifactDraft>;
  recent: QueryPage<ClosureRecord>;
}
export interface EvidenceTarget { kind: 'engagement' | 'task' | 'followup' | 'condition'; id: string; field: string; label: string }
export interface FieldEvidenceEntry {
  closure: ClosureRecord;
  value: unknown;
  matchesCurrent: boolean;
  reverted: boolean;
  sourceStatus: 'available' | 'unavailable';
  original: string | null;
  sourceTime?: number;
}
export interface FieldEvidence {
  target: EvidenceTarget;
  currentValue: unknown;
  entries: FieldEvidenceEntry[];
  nextCursor?: string | null;
}
const evidenceFields = {
  engagement: ['stage', 'budgetAmount', 'shareableSummary', 'nextAction'],
  task: ['title', 'assignee', 'deadline', 'sourceDeadlineText', 'dueAt', 'done'],
  followup: ['title', 'expectedDate', 'expectedAt', 'reviewAt', 'status'],
  condition: ['conditionText', 'actionTitle', 'status', 'conditionKind', 'followUpId'],
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function guard(reader: ContinuationReader) {
  const identity = reader.getReadIdentity?.();
  return () => { if (reader.getReadIdentity?.() !== identity) throw new Error('资料已变化，请重新读取项目。'); };
}
export async function loadContinuationPage<T = any>(reader: ContinuationReader, projectId: string, kind: 'task' | 'followup' | 'condition' | 'artifact' | 'closure', cursor?: string): Promise<QueryPage<T>> {
  const check = guard(reader);
  const page = await reader.query<any>('work', kind, { relatedId: projectId, limit: 25, ...(cursor ? { cursor } : {}) });
  check();
  return { ...page, items: page.items.filter(row => kind === 'closure' ? row.engagementIds?.includes(projectId) : kind === 'artifact' ? row.projectId === projectId : row.engagementId === projectId) };
}
export async function loadProjectContinuation(reader: ContinuationReader, projectId: string): Promise<ProjectContinuationData> {
  const check = guard(reader);
  const [project, tasks, followUps, conditions, artifacts, recent] = await Promise.all([
    reader.get<Engagement>('work', 'engagement', projectId),
    loadContinuationPage<ProjectTaskItem>(reader, projectId, 'task'),
    loadContinuationPage<FollowUpItem>(reader, projectId, 'followup'),
    loadContinuationPage<ConditionIntent>(reader, projectId, 'condition'),
    loadContinuationPage<ArtifactDraft>(reader, projectId, 'artifact'),
    loadContinuationPage<ClosureRecord>(reader, projectId, 'closure'),
  ]);
  check();
  if (!project || project.id !== projectId) throw new Error('项目不存在或暂不可用。');
  return { project, tasks, followUps, conditions, artifacts, recent };
}
export function groupContinuation(tasks: ProjectTaskItem[], followUps: FollowUpItem[], conditions: ConditionIntent[] = []) {
  return {
    tasks: tasks.filter(item => !item.done), completed: tasks.filter(item => item.done),
    waiting: followUps.filter(item => item.status === 'open' && item.kind === 'waiting'),
    questions: followUps.filter(item => item.status === 'open' && item.kind === 'question'),
    resolved: followUps.filter(item => item.status === 'resolved'),
    readyConditions: conditions.filter(item => item.status === 'ready'),
    watchingConditions: conditions.filter(item => item.status === 'watching' || item.status === 'draft' || item.status === 'paused'),
    closedConditions: conditions.filter(item => item.status === 'completed' || item.status === 'cancelled'),
  };
}
export function canContinueProject(draft: CaptureDraft | null, projectId: string): boolean {
  if (!draft) return true;
  if (draft.selectedEngagementId) return draft.selectedEngagementId === projectId;
  return !draft.text?.trim() && !draft.proposal && !draft.newClientName && !draft.newProjectTitle;
}

/** A matching historical value is evidence of that change, not proof it is the latest write. */
export async function loadFieldEvidence(reader: ContinuationReader, projectId: string, target: EvidenceTarget, cursor?: string): Promise<FieldEvidence> {
  const check = guard(reader);
  if (!evidenceFields[target.kind]?.includes(target.field)) throw new Error('该字段不支持依据查询。');
  const current = await reader.get<any>('work', target.kind, target.id); check();
  if (!current || (target.kind === 'engagement' ? current.id !== projectId : current.engagementId !== projectId)) throw new Error('项目关联资料已变化，请重新读取。');
  const page = await reader.query<ClosureRecord>('work', 'closure', { relatedId: target.id, limit: 10, ...(cursor ? { cursor } : {}) }); check();
  const entries = await Promise.all(page.items.filter(record => record.engagementIds.includes(projectId) && !record.originalOnly &&
    (target.kind === 'engagement' || (target.kind === 'task' ? record.taskIds : target.kind === 'condition' ? (record.conditionIds || []) : record.followUpIds).includes(target.id))).map(async record => {
    const event = await reader.get<CommittedChangeEvent>('work', 'event', record.eventId); check();
    if (!event || event.sourceMessageId !== record.sourceMessageId) return null;
    const mutation = eventMutations(event).find(row => row?.kind === target.kind && row.id === target.id && row.after &&
      (target.kind === 'engagement' || row.after.engagementId === projectId) && !same(row.before?.[target.field], row.after[target.field]));
    if (!mutation) return null;
    const source = await reader.get<Message>('work', 'message', record.sourceMessageId); check();
    const reverted = !!record.revertedAt || !!event.revertedAt;
    return {
      closure: record, value: mutation.after[target.field], reverted,
      matchesCurrent: !reverted && same(current[target.field], mutation.after[target.field]),
      sourceStatus: source ? 'available' : 'unavailable', original: source?.content ?? null, sourceTime: source?.timestamp,
    } as FieldEvidenceEntry;
  }));
  check();
  return { target, currentValue: current[target.field], entries: entries.filter(Boolean), nextCursor: page.nextCursor };
}
