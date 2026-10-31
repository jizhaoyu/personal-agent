import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProposedChangeSet } from '../src/types';
let practice: any = {};
try { practice = require('../src/services/practice'); } catch {}
const now = Date.parse('2026-10-29T04:00:00Z');

test('practice can parse, edit and close a conversation entirely without persistence or desktop calls', () => {
  assert.equal(typeof practice.createPractice, 'function');
  let calls = 0;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const forbidden = new Proxy({}, { get() { calls++; throw new Error('Practice must not use real storage or desktop'); } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: forbidden });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: forbidden, indexedDB: forbidden } });
  try {
    const initial = practice.createPractice(now);
    assert.equal(initial.partition.engagements.length, 0);
    const reviewed = practice.proposePractice(initial, now);
    const proposal: ProposedChangeSet = structuredClone(reviewed.draft.proposal);
    const project = proposal.operations.find(item => item.target === 'engagement')!;
    project.after!.budgetAmount = 3600;
    const edited = practice.editPracticeProposal(reviewed, proposal);
    const committed = practice.commitPractice(edited, now + 1);
    assert.equal(committed.partition.engagements[0].budgetAmount, 3600);
    assert.equal(committed.partition.tasks.length, 1);
    assert.equal(committed.partition.followUps.length, 2);
    assert.ok(committed.partition.followUps.some((item: any) => item.kind === 'waiting' && item.expectedDate && !item.expectedAt && !item.reviewAt));
    assert.equal(committed.draft.text, ''); assert.ok(committed.closure);
    assert.equal(initial.partition.engagements.length, 0); assert.equal(calls, 0);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete (globalThis as any).localStorage;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete (globalThis as any).window;
  }
});

test('repeated practice confirmation is idempotent and undo never opens a finished draft', () => {
  assert.equal(typeof practice.createPractice, 'function');
  const committed = practice.commitPractice(practice.proposePractice(practice.createPractice(now), now), now + 1);
  const twice = practice.commitPractice(committed, now + 2);
  assert.equal(twice.closure.id, committed.closure.id); assert.equal(twice.partition.tasks.length, 1);
  const undone = practice.undoPractice(twice, now + 3);
  assert.equal(undone.partition.engagements.length, 0); assert.equal(undone.partition.tasks.length, 0); assert.equal(undone.partition.followUps.length, 0);
  assert.ok(undone.closure.revertedAt); assert.equal(undone.draft.text, ''); assert.equal(undone.draft.proposal, undefined);
  const restarted = practice.createPractice(now + 4); assert.equal(restarted.partition.engagements.length, 0);
});

test('practice source changes discard an old preview and malformed edits cannot commit', () => {
  assert.equal(typeof practice.createPractice, 'function');
  const reviewed = practice.proposePractice(practice.createPractice(now), now);
  const changed = practice.revisePractice(reviewed, '只练习一条不确定的费用', now + 1);
  assert.equal(changed.draft.proposal, undefined); assert.notEqual(changed.draft.sourceMessageId, reviewed.draft.sourceMessageId);
  assert.throws(() => practice.commitPractice(changed, now + 2), /核对|预览/);
  const invalid = structuredClone(reviewed); invalid.draft.proposal.operations.find((item: any) => item.target === 'engagement').after.budgetAmount = -1;
  assert.throws(() => practice.commitPractice(invalid, now + 3));
  assert.equal(reviewed.partition.engagements.length, 0);
});
