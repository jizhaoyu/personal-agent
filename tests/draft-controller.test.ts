import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureDraft } from '../src/types';
let createDraftController: any;
try { ({ createDraftController } = require('../src/services/draftController')); } catch {}
const draft = (text = '', version = 0): CaptureDraft => ({ id: 'active-work', sessionId: 'test-session', mode: 'work', text,
  sourceVersion: version, draftVersion: version, sourceMessageId: `source-test-session-${version}`, status: 'editing', updatedAt: version });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('a restored draft starts with an accurate saved status while a new empty editor stays idle', () => {
  const restored = createDraftController(draft('从本机恢复的原文', 3), async () => {});
  assert.equal(restored.getState().status, 'saved'); restored.dispose();
  const empty = createDraftController(draft(), async () => {});
  assert.equal(empty.getState().status, 'idle'); empty.dispose();
});

test('draft controller saves the latest edit after debounce without claiming business confirmation', async () => {
  assert.equal(typeof createDraftController, 'function');
  let stored: CaptureDraft | null = null;
  const controller = createDraftController(draft(), async (value: CaptureDraft) => { stored = value; }, { delayMs: 20 });
  controller.update(draft('第一句', 1)); controller.update(draft('完整的原文', 2));
  assert.equal(controller.getState().status, 'unsaved'); assert.equal(stored, null);
  await delay(45);
  assert.equal(stored?.text, '完整的原文'); assert.equal(controller.getState().status, 'saved');
  controller.dispose();
});

test('flush serializes pending saves so a slow older write cannot replace newer text', async () => {
  assert.equal(typeof createDraftController, 'function');
  let release: () => void; let started: () => void; let stored: CaptureDraft;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const controller = createDraftController(draft(), async (value: CaptureDraft) => {
    if (value.draftVersion === 1) { started(); await blocked; } stored = value;
  }, { delayMs: 5 });
  controller.update(draft('旧稿', 1)); await begun;
  controller.update(draft('最新稿', 2)); const flush = controller.flush(); release(); await flush;
  assert.equal(stored.text, '最新稿'); assert.equal(controller.getState().status, 'saved'); controller.dispose();
});

test('a failed local save keeps unsaved text and retry can recover it', async () => {
  assert.equal(typeof createDraftController, 'function');
  let failed = true; let stored: CaptureDraft;
  const controller = createDraftController(draft(), async (value: CaptureDraft) => { if (failed) throw new Error('disk full'); stored = value; }, { delayMs: 100 });
  controller.update(draft('不能丢掉的原文', 1)); await assert.rejects(controller.flush(), /disk full/);
  assert.equal(controller.getState().status, 'error'); assert.equal(controller.getState().draft.text, '不能丢掉的原文');
  failed = false; await controller.flush(); assert.equal(stored.text, '不能丢掉的原文'); assert.equal(controller.getState().status, 'saved'); controller.dispose();
});

test('finishing a committed session prevents a late save result from replacing the next draft', async () => {
  assert.equal(typeof createDraftController, 'function');
  let release: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const controller = createDraftController(draft(), async () => { await blocked; }, { delayMs: 5 });
  controller.update(draft('已完成原文', 1)); const pending = controller.flush();
  const next = { ...draft(), sessionId: 'next-session', sourceMessageId: 'source-next-session-0' };
  controller.reset(next); release(); await pending;
  assert.equal(controller.getState().draft.sessionId, 'next-session'); assert.equal(controller.getState().status, 'idle'); controller.dispose();
});
