import type { ConditionIntent, Engagement, FollowUpItem, ProjectTaskItem, WorkOperation } from '../types';
import { newId } from './storage';
import { sameValue } from '../../shared/persistence-core.mjs';

export type ConditionLifecycleAction =
  | 'confirm_ready'
  | 'activate_watching'
  | 'pause'
  | 'cancel'
  | 'complete'
  | 'dismiss_highlight';

/**
 * Deterministically evaluates condition intents when a FollowUpItem changes state.
 * - Open -> Resolved: watching conditions bound to this followUpId become ready (revision + 1).
 *   Paused, cancelled, completed, draft, or already-ready conditions are untouched.
 * - Resolved -> Open: ready conditions bound to this followUpId revert to watching (revision + 1).
 */
export function evaluateFollowUpTransition(
  conditions: ConditionIntent[],
  followUpBefore: FollowUpItem | null,
  followUpAfter: FollowUpItem | null,
  now = Date.now(),
  eventId?: string,
): WorkOperation[] {
  if (!followUpAfter || followUpAfter.kind !== 'waiting') return [];
  const becameResolved = followUpBefore?.status !== 'resolved' && followUpAfter.status === 'resolved';
  const reopened = followUpBefore?.status === 'resolved' && followUpAfter.status === 'open';
  if (!becameResolved && !reopened) return [];

  const operations: WorkOperation[] = [];
  for (const cond of conditions) {
    if (cond.conditionKind !== 'followup_resolved' || cond.followUpId !== followUpAfter.id) continue;
    if (becameResolved && cond.status === 'watching') {
      const after: ConditionIntent = {
        ...cond,
        status: 'ready',
        revision: cond.revision + 1,
        triggeredAt: now,
        ...(eventId ? { triggeredByEventId: eventId } : {}),
        updatedAt: now,
      };
      delete after.dismissedRevision;
      operations.push({ target: 'condition', entityId: cond.id, before: cond, after });
    } else if (reopened && cond.status === 'ready') {
      const after: ConditionIntent = {
        ...cond,
        status: 'watching',
        revision: cond.revision + 1,
        updatedAt: now,
      };
      delete after.triggeredAt;
      delete after.triggeredByEventId;
      delete after.dismissedRevision;
      operations.push({ target: 'condition', entityId: cond.id, before: cond, after });
    }
  }
  return operations;
}

/**
 * Applies an explicit user lifecycle action to a ConditionIntent.
 * Stopped/paused states never transition to ready unless explicitly resumed/confirmed.
 */
export function transitionConditionIntent(
  cond: ConditionIntent,
  action: ConditionLifecycleAction,
  now = Date.now(),
  eventId?: string,
): ConditionIntent {
  if (action === 'dismiss_highlight') {
    if (cond.status !== 'ready' || cond.dismissedRevision === cond.revision) return cond;
    return { ...cond, dismissedRevision: cond.revision, updatedAt: now };
  }

  if (action === 'confirm_ready') {
    if (cond.status === 'ready' || cond.status === 'completed' || cond.status === 'cancelled' || cond.status === 'paused') {
      return cond;
    }
    const next: ConditionIntent = {
      ...cond,
      status: 'ready',
      revision: cond.revision + 1,
      triggeredAt: now,
      ...(eventId ? { triggeredByEventId: eventId } : {}),
      updatedAt: now,
    };
    delete next.dismissedRevision;
    return next;
  }

  if (action === 'activate_watching') {
    if (cond.status === 'watching' || cond.status === 'completed' || cond.status === 'cancelled') return cond;
    const next: ConditionIntent = {
      ...cond,
      status: 'watching',
      revision: cond.revision + 1,
      updatedAt: now,
    };
    delete next.triggeredAt;
    delete next.triggeredByEventId;
    delete next.dismissedRevision;
    return next;
  }

  if (action === 'pause') {
    if (cond.status === 'paused' || cond.status === 'completed' || cond.status === 'cancelled') return cond;
    const next: ConditionIntent = {
      ...cond,
      status: 'paused',
      revision: cond.revision + 1,
      updatedAt: now,
    };
    delete next.triggeredAt;
    delete next.triggeredByEventId;
    delete next.dismissedRevision;
    return next;
  }

  if (action === 'cancel') {
    if (cond.status === 'cancelled') return cond;
    const next: ConditionIntent = {
      ...cond,
      status: 'cancelled',
      revision: cond.revision + 1,
      updatedAt: now,
    };
    delete next.triggeredAt;
    delete next.triggeredByEventId;
    delete next.dismissedRevision;
    return next;
  }

  if (action === 'complete') {
    if (cond.status === 'completed') return cond;
    const next: ConditionIntent = {
      ...cond,
      status: 'completed',
      revision: cond.revision + 1,
      updatedAt: now,
    };
    delete next.dismissedRevision;
    return next;
  }

  return cond;
}

/**
 * Revises a ConditionIntent's condition or action, bumping revision and invalidating any prior trigger.
 */
export function reviseConditionIntent(
  cond: ConditionIntent,
  patch: {
    conditionText?: string;
    actionTitle?: string;
    conditionKind?: 'followup_resolved' | 'manual_confirm';
    followUpId?: string;
    status?: ConditionIntent['status'];
    sourceMessageId?: string;
  },
  now = Date.now(),
): ConditionIntent {
  const next: ConditionIntent = {
    ...cond,
    ...(patch.conditionText !== undefined ? { conditionText: patch.conditionText } : {}),
    ...(patch.actionTitle !== undefined ? { actionTitle: patch.actionTitle } : {}),
    ...(patch.conditionKind !== undefined ? { conditionKind: patch.conditionKind } : {}),
    ...(patch.sourceMessageId !== undefined ? { sourceMessageId: patch.sourceMessageId } : {}),
  };
  if (patch.followUpId !== undefined) {
    if (patch.followUpId) next.followUpId = patch.followUpId;
    else delete next.followUpId;
  }
  if (next.conditionKind === 'manual_confirm') {
    delete next.followUpId;
  }
  const changedConditionOrAction =
    next.conditionText !== cond.conditionText ||
    next.actionTitle !== cond.actionTitle ||
    next.conditionKind !== cond.conditionKind ||
    next.followUpId !== cond.followUpId;

  if (patch.status !== undefined) {
    next.status = patch.status;
  } else if (changedConditionOrAction && cond.status === 'ready') {
    next.status = next.conditionKind === 'followup_resolved' && next.followUpId ? 'watching' : 'draft';
  }

  if (!sameValue({ ...next, updatedAt: cond.updatedAt, revision: cond.revision }, cond)) {
    next.revision = cond.revision + 1;
    next.updatedAt = now;
    if (changedConditionOrAction || next.status !== 'ready') {
      delete next.triggeredAt;
      delete next.triggeredByEventId;
      delete next.dismissedRevision;
    }
  }
  return next;
}

/**
 * Produces atomic operations to convert a ready ConditionIntent into an actionable ProjectTaskItem
 * and mark the ConditionIntent as completed (idempotent against existing open tasks with same title).
 */
export function convertConditionToTaskOperations(
  cond: ConditionIntent,
  existingTasks: ProjectTaskItem[],
  now = Date.now(),
): WorkOperation[] {
  const normalizedTitle = cond.actionTitle.trim();
  const duplicateOpenTask = existingTasks.find(
    t => !t.done && t.engagementId === cond.engagementId && t.title.trim() === normalizedTitle,
  );
  const completedCond = transitionConditionIntent(cond, 'complete', now);
  const operations: WorkOperation[] = [];
  if (!duplicateOpenTask) {
    const task: ProjectTaskItem = {
      id: newId('task'),
      title: normalizedTitle,
      assignee: '我',
      deadline: '',
      priority: 'medium',
      done: false,
      ...(cond.engagementId ? { engagementId: cond.engagementId } : {}),
    };
    operations.push({ target: 'task', entityId: task.id, before: null, after: task });
  }
  if (!sameValue(completedCond, cond)) {
    operations.push({ target: 'condition', entityId: cond.id, before: cond, after: completedCond });
  }
  return operations;
}

/**
 * Selects ready ConditionIntents worth highlighting on the WorkBench summary:
 * - Only status === 'ready'
 * - Not dismissed for the current revision (dismissedRevision !== revision)
 * - Project still exists (if engagementId is set)
 * - Bound followUp (if followup_resolved) still exists and is resolved
 * - At most 1 ready suggestion highlighted per project
 */
export function selectHighlightedReadyConditions(
  conditions: ConditionIntent[],
  followUps: FollowUpItem[] = [],
  engagements?: Engagement[],
): ConditionIntent[] {
  const projectIds = engagements && engagements.length > 0 ? new Set(engagements.map(e => e.id)) : null;
  const followUpMap = new Map(followUps.map(f => [f.id, f]));
  const eligible = conditions
    .filter(cond => {
      if (cond.status !== 'ready') return false;
      if (cond.dismissedRevision === cond.revision) return false;
      if (cond.engagementId && projectIds && !projectIds.has(cond.engagementId)) return false;
      if (cond.conditionKind === 'followup_resolved') {
        if (!cond.followUpId) return false;
        const bound = followUpMap.get(cond.followUpId);
        if (bound && bound.status !== 'resolved') return false;
      }
      return true;
    })
    .sort((a, b) => (b.triggeredAt || b.updatedAt) - (a.triggeredAt || a.updatedAt) || a.id.localeCompare(b.id));

  const seenProjects = new Set<string>();
  const highlighted: ConditionIntent[] = [];
  for (const cond of eligible) {
    const key = cond.engagementId || `unscoped:${cond.id}`;
    if (seenProjects.has(key)) continue;
    seenProjects.add(key);
    highlighted.push(cond);
  }
  return highlighted;
}
