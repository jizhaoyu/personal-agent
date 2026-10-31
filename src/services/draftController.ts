import type { CaptureDraft } from '../types';

export type DraftSaveState = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';
export interface DraftState { draft: CaptureDraft; status: DraftSaveState; error?: string }
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

/** Owns one editor across page changes. A saved draft is never a business confirmation. */
export function createDraftController(initial: CaptureDraft, save: (draft: CaptureDraft) => Promise<void>, options: { delayMs?: number } = {}) {
  let state: DraftState = { draft: copy(initial), status: initial.text.trim() || initial.proposal ? 'saved' : 'idle' };
  let generation = 0, savedVersion = initial.draftVersion;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue = Promise.resolve(); let disposed = false;
  const listeners = new Set<(state: DraftState) => void>();
  const emit = () => { if (!disposed) for (const listener of listeners) listener(state); };
  const cancelTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  async function flush(): Promise<void> {
    cancelTimer(); if (disposed) return;
    const ownedGeneration = generation, target = copy(state.draft);
    const operation = queue.then(async () => {
      if (disposed || ownedGeneration !== generation || target.draftVersion <= savedVersion) return;
      state = { ...state, status: 'saving', error: undefined }; emit();
      try {
        await save(target);
        if (disposed || generation !== ownedGeneration) return;
        savedVersion = Math.max(savedVersion, target.draftVersion);
        state = { ...state, status: state.draft.draftVersion <= savedVersion ? 'saved' : 'unsaved' }; emit();
      } catch (error) {
        if (disposed || generation !== ownedGeneration) return;
        state = { ...state, status: 'error', error: error instanceof Error ? error.message : '草稿未能保存，原文仍在当前输入中。' }; emit(); throw error;
      }
    });
    // A failed save must not poison the next explicitly requested retry.
    queue = operation.catch(() => undefined);
    await operation;
    if (!disposed && generation === ownedGeneration && state.draft.draftVersion > savedVersion) await flush();
  }
  return {
    getState: () => state,
    subscribe(listener: (value: DraftState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(draft: CaptureDraft) {
      if (disposed) return;
      state = { draft: copy(draft), status: 'unsaved' }; emit(); cancelTimer();
      timer = setTimeout(() => { void flush().catch(() => undefined); }, options.delayMs ?? 500);
    },
    flush,
    reset(draft: CaptureDraft) {
      cancelTimer(); generation++; savedVersion = draft.draftVersion;
      state = { draft: copy(draft), status: 'idle' }; emit();
    },
    dispose() { disposed = true; generation++; cancelTimer(); listeners.clear(); },
  };
}
export type DraftController = ReturnType<typeof createDraftController>;
