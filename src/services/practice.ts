import type { CaptureDraft, ClosureRecord, CommittedChangeEvent, Message, ProposedChangeSet, WorkPartition } from '../types';
import { StateEngine } from './stateEngine';
import { createCaptureDraft, reviseCaptureDraft } from './capture';
import { captureRows, eventMutations, sameValue, validateCaptureCommand } from '../../shared/persistence-core.mjs';

export interface PracticeState {
  partition: WorkPartition;
  draft: CaptureDraft;
  closure: ClosureRecord | null;
  event: CommittedChangeEvent | null;
  source: Message | null;
}
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const example = '练习客户的官网改版，预算3000元。我周五发首页原型，客户下周一补素材，新增页面费用未定。';
const fieldFor = (kind: string): 'engagements' | 'tasks' | 'followUps' | 'memories' => {
  if (kind === 'engagement') return 'engagements';
  if (kind === 'task') return 'tasks';
  if (kind === 'followup') return 'followUps';
  if (kind === 'memory') return 'memories';
  throw new Error('演练变更类型无效。');
};

/** A disposable state machine. It never imports the repository or owns any storage or desktop resource. */
export function createPractice(now = Date.now()): PracticeState {
  return {
    partition: { revision: 0, engagements: [], tasks: [], followUps: [], closures: [], events: [], messages: [], memories: [], journals: [], customCards: [], processedProposalIds: [] },
    draft: reviseCaptureDraft(createCaptureDraft(now), { text: example, newClientName: '练习客户', newProjectTitle: '示例官网改版' }, now),
    closure: null, event: null, source: null,
  };
}
export function revisePractice(state: PracticeState, text: string, now = Date.now()): PracticeState {
  return { ...state, draft: reviseCaptureDraft(state.draft, { text }, now), closure: null };
}
export function proposePractice(state: PracticeState, now = Date.now()): PracticeState {
  if (!state.draft.text.trim()) throw new Error('请先输入一段合成演练内容。');
  const proposal = StateEngine.propose(state.draft.text, { mode: 'work', sourceMessageId: state.draft.sourceMessageId, partition: state.partition, now,
    selectedEngagementId: state.partition.engagements[0]?.id, newClientName: '练习客户', newProjectTitle: '示例官网改版' });
  return { ...state, closure: null, draft: reviseCaptureDraft(state.draft, { proposal, status: 'review' }, now) };
}
export function editPracticeProposal(state: PracticeState, proposal: ProposedChangeSet): PracticeState {
  if (proposal.sourceMessageId !== state.draft.sourceMessageId || proposal.sourceText !== state.draft.text) throw new Error('输入已改变，请重新整理演练内容。');
  return { ...state, draft: reviseCaptureDraft(state.draft, { proposal, status: 'review' }) };
}
export function commitPractice(state: PracticeState, now = Date.now()): PracticeState {
  if (state.closure && !state.draft.text.trim()) return state;
  const proposal = state.draft.proposal;
  if (!proposal) throw new Error('请先整理并核对演练预览。');
  const command = { op: 'commitCapture', space: 'work', draftSessionId: state.draft.sessionId, proposal, confirmedAt: now };
  if (proposal.sourceMessageId !== state.draft.sourceMessageId || proposal.sourceText !== state.draft.text || !validateCaptureCommand(command)) throw new Error('演练内容仍有无效或待核对字段，请修改后再确认。');
  const errors = StateEngine.validate(proposal, state.partition);
  if (errors.length) throw new Error(errors.join(' '));
  const next = copy(state); const { mutations, source, closure } = captureRows(command);
  for (const mutation of mutations) {
    const field = fieldFor(mutation.kind); const rows: any[] = next.partition[field] ||= [];
    const index = rows.findIndex(item => item.id === mutation.id);
    if (mutation.after === null) { if (index >= 0) rows.splice(index, 1); }
    else if (index >= 0) rows[index] = copy(mutation.after); else rows.push(copy(mutation.after));
  }
  const event: CommittedChangeEvent = { id: closure.eventId, proposalId: proposal.id, mode: 'work', sourceMessageId: source.id, sourceText: source.content, operations: copy(proposal.operations), createdAt: now };
  next.partition.revision++; next.partition.events.push(event); next.partition.closures!.push(closure); next.partition.messages.push(source);
  next.closure = closure; next.event = event; next.source = source; next.draft = createCaptureDraft(now);
  return next;
}
export function undoPractice(state: PracticeState, now = Date.now()): PracticeState {
  if (!state.event || state.event.revertedAt || !state.closure) throw new Error('没有可撤销的演练记录。');
  const next = copy(state);
  for (const mutation of [...eventMutations(state.event)].reverse()) {
    const rows: any[] = next.partition[fieldFor(mutation.kind)] ||= [];
    const index = rows.findIndex(item => item.id === mutation.id);
    if (!sameValue(rows[index] || null, mutation.after)) throw new Error('演练记录已改变，请重新开始练习。');
    if (mutation.before === null) { if (index >= 0) rows.splice(index, 1); }
    else if (index >= 0) rows[index] = copy(mutation.before); else rows.push(copy(mutation.before));
  }
  next.event = { ...next.event!, revertedAt: now }; next.closure = { ...next.closure!, revertedAt: now };
  next.partition.events = next.partition.events.map(event => event.id === next.event!.id ? next.event! : event);
  next.partition.closures = next.partition.closures!.map(record => record.id === next.closure!.id ? next.closure! : record);
  next.partition.revision++;
  return next;
}
