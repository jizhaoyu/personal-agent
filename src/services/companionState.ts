export type CompanionState = 'idle' | 'thinking' | 'review' | 'saved' | 'reminder' | 'error';

export interface CompanionSignals {
  busy?: boolean;
  pending?: boolean;
  /** Set only after persistence succeeds; the caller controls the brief receipt lifetime. */
  saved?: boolean;
  error?: boolean | string | null;
  reminderCount?: number;
}

export function deriveCompanionState(signals: CompanionSignals): CompanionState {
  if (signals.error) return 'error';
  if (signals.busy) return 'thinking';
  if (signals.pending) return 'review';
  if (signals.saved) return 'saved';
  if (Number.isFinite(signals.reminderCount) && signals.reminderCount >= 1) return 'reminder';
  return 'idle';
}
