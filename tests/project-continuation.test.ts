import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadProjectContinuation, loadContinuationPage, groupContinuation, loadFieldEvidence, canContinueProject } from '../src/services/projectContinuation';

const project: any = { id: 'p', clientName: '陈总', title: '商城', stage: '需求确认', budgetAmount: 300, internalContext: '内部秘密', shareableSummary: '页面改版', nextAction: '', updatedAt: 10 };
const task: any = { id: 't', engagementId: 'p', title: '发原型', assignee: '我', done: false, deadline: '', priority: 'medium' };
const closure: any = { id: 'c', mode: 'work', engagementIds: ['p'], taskIds: ['t'], followUpIds: ['f'], eventId: 'e', sourceMessageId: 'm', confirmedAt: 10 };
const event: any = { id: 'e', sourceMessageId: 'm', sourceText: '事件里的正文不能作为备用原文', createdAt: 10, operations: [{ target: 'engagement', entityId: 'p', before: null, after: project }, { target: 'task', entityId: 't', before: null, after: task }] };
function fixture(overrides: any = {}) {
  const calls: any[] = [];
  const rows: any = { engagement: { p: project }, task: { t: task }, followup: {}, event: { e: event }, message: { m: { id: 'm', role: 'user', content: '当时原文', timestamp: 9 } } };
  const reader: any = {
    getReadIdentity: () => 'stable',
    get: async (space: string, kind: string, id: string) => { calls.push({ op: 'get', space, kind, id }); return rows[kind]?.[id] || null; },
    query: async (space: string, kind: string, options: any) => { calls.push({ op: 'query', space, kind, ...options }); return { items: kind === 'closure' ? [closure] : kind === 'task' ? [task] : [], nextCursor: null }; },
    ...overrides,
  };
  return { reader, rows, calls };
}
const budget: any = { kind: 'engagement', id: 'p', field: 'budgetAmount', label: '预算' };

test('continuation reads selected project from storage with bounded project-scoped pages, not cached rows', async () => {
  const { reader, calls } = fixture();
  const result = await loadProjectContinuation(reader, 'p');
  assert.equal(result.project.id, 'p'); assert.equal(result.tasks.items.length, 1);
  assert.ok(calls.filter(c => c.op === 'query').every(c => c.space === 'work' && c.relatedId === 'p' && c.limit <= 50));
  assert.equal(calls.some(c => c.kind === 'message' || c.kind === 'event'), false);
});
test('subsequent project pages preserve cursor and isolate same-name projects', async () => {
  const { reader, calls } = fixture({ query: async (space: any, kind: any, options: any) => { calls.push({ space, kind, ...options }); return { items: [task, { ...task, id: 'other', engagementId: 'other' }], nextCursor: 'next' }; } });
  const result = await loadContinuationPage(reader, 'p', 'task', 'cursor');
  assert.deepEqual(result.items.map((t: any) => t.id), ['t']); assert.equal(result.nextCursor, 'next'); assert.equal(calls[0].cursor, 'cursor');
});
test('missing project and failed reads are errors, not empty projects', async () => {
  const { reader } = fixture({ get: async () => null });
  await assert.rejects(loadProjectContinuation(reader, 'missing'), /项目.*不存在|不可用/);
  reader.get = async () => project; reader.query = async () => { throw new Error('读取失败'); };
  await assert.rejects(loadProjectContinuation(reader, 'p'), /读取失败/);
});
test('completed tasks and resolved followups are separate from current next steps', () => {
  const groups = groupContinuation([task, { ...task, id: 'done', done: true }], [
    { id: 'w', kind: 'waiting', status: 'open' }, { id: 'q', kind: 'question', status: 'open' }, { id: 'r', kind: 'waiting', status: 'resolved' },
  ] as any);
  assert.deepEqual(groups.tasks.map(t => t.id), ['t']); assert.equal(groups.completed.length, 1);
  assert.deepEqual(groups.waiting.map(t => t.id), ['w']); assert.deepEqual(groups.questions.map(t => t.id), ['q']); assert.equal(groups.resolved.length, 1);
});
test('field evidence matches entity and field, and reads original message rather than event sourceText', async () => {
  const { reader } = fixture(); const result = await loadFieldEvidence(reader, 'p', budget);
  assert.equal(result.currentValue, 300); assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].original, '当时原文'); assert.equal(result.entries[0].matchesCurrent, true);
  assert.equal(JSON.stringify(result).includes('内部秘密'), false);
  assert.equal(JSON.stringify(result).includes('事件里的正文'), false);
});
test('deleted original never falls back to event sourceText', async () => {
  const { reader, rows } = fixture(); delete rows.message.m;
  const result = await loadFieldEvidence(reader, 'p', budget);
  assert.equal(result.entries[0].original, null); assert.equal(result.entries[0].sourceStatus, 'unavailable');
  assert.equal(JSON.stringify(result).includes('事件里的正文'), false);
});
test('original deadline and own reminder are distinct evidence fields', async () => {
  const { reader, rows } = fixture();
  const dated = { ...task, deadline: '月底前提交', sourceDeadlineText: '月底前', dueAt: '2026-11-23T01:00:00Z' };
  rows.task.t = dated;
  rows.event.e = { ...event, operations: [{ target: 'task', entityId: 't', before: null, after: dated }] };
  for (const [field, expected] of [['deadline', '月底前提交'], ['sourceDeadlineText', '月底前'], ['dueAt', '2026-11-23T01:00:00Z']]) {
    const result = await loadFieldEvidence(reader, 'p', { kind: 'task', id: 't', field, label: '日期' });
    assert.equal(result.currentValue, expected); assert.equal(result.entries[0].value, expected);
  }
});
test('historical and reverted field values are not current facts', async () => {
  const { reader, rows } = fixture(); rows.engagement.p = { ...project, budgetAmount: 500 };
  let result = await loadFieldEvidence(reader, 'p', budget); assert.equal(result.entries[0].matchesCurrent, false); assert.equal(result.currentValue, 500);
  rows.event.e = { ...event, revertedAt: 12 };
  result = await loadFieldEvidence(reader, 'p', budget); assert.equal(result.entries[0].reverted, true); assert.equal(result.entries[0].matchesCurrent, false);
});
test('unrelated entity or unchanged field never becomes field evidence', async () => {
  const { reader, rows } = fixture();
  rows.event.e = { ...event, operations: [{ target: 'engagement', entityId: 'other', before: null, after: project }] };
  assert.equal((await loadFieldEvidence(reader, 'p', budget)).entries.length, 0);
  rows.event.e = { ...event, operations: [{ target: 'engagement', entityId: 'p', before: project, after: { ...project, title: '新标题' } }] };
  assert.equal((await loadFieldEvidence(reader, 'p', budget)).entries.length, 0);
});
test('original-only closures and mismatched event source links are not confirmation evidence', async () => {
  const { reader, rows } = fixture({ query: async () => ({ items: [{ ...closure, originalOnly: true }], nextCursor: null }) });
  assert.equal((await loadFieldEvidence(reader, 'p', budget)).entries.length, 0);
  reader.query = async () => ({ items: [closure], nextCursor: null }); rows.event.e = { ...event, sourceMessageId: 'another' };
  assert.equal((await loadFieldEvidence(reader, 'p', budget)).entries.length, 0);
});
test('legacy and manual records without field provenance remain usable with an empty evidence result', async () => {
  const { reader } = fixture({ query: async () => ({ items: [], nextCursor: null }) });
  const result = await loadFieldEvidence(reader, 'p', budget); assert.equal(result.currentValue, 300); assert.deepEqual(result.entries, []);
});
test('evidence is project-scoped and lazy-paged rather than a whole archive scan', async () => {
  const { reader, calls } = fixture(); await loadFieldEvidence(reader, 'p', { kind: 'task', id: 't', field: 'title', label: '行动' }, 'older');
  const query = calls.find(c => c.op === 'query'); assert.equal(query.relatedId, 't'); assert.equal(query.cursor, 'older'); assert.ok(query.limit <= 20);
  await assert.rejects(loadFieldEvidence(reader, 'other', { kind: 'task', id: 't', field: 'title', label: '行动' }), /项目/);
});
test('changing revision or restoring equal-revision backup invalidates pending reads', async () => {
  let identity = 'before'; const { reader } = fixture({ getReadIdentity: () => identity });
  const oldGet = reader.get; reader.get = async (...args: any[]) => { const result = await oldGet(...args); identity = 'after'; return result; };
  await assert.rejects(loadProjectContinuation(reader, 'p'), /资料已变化/);
});
test('continuing a project never silently replaces another draft or new-project binding', () => {
  assert.equal(canContinueProject(null, 'p'), true);
  assert.equal(canContinueProject({ text: '未完成', selectedEngagementId: 'p' } as any, 'p'), true);
  for (const draft of [{ text: '未完成', selectedEngagementId: 'other' }, { text: '尚未归属' }, { text: '', newClientName: '新客户' }, { text: '', proposal: { id: 'proposal' } }, { text: '', selectedEngagementId: 'other' }]) {
    assert.equal(canContinueProject(draft as any, 'p'), false);
  }
});
