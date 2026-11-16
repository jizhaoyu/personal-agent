import type { AppLanguage } from '../types';

const LANGUAGE_HINT_KEY = 'looma_language';
const VALID_LANGUAGES = new Set<AppLanguage>(['zh-CN', 'en']);

export function normalizeLanguage(value: unknown): AppLanguage {
  return value === 'en' ? 'en' : 'zh-CN';
}

function readLanguageHint(): AppLanguage {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(LANGUAGE_HINT_KEY);
      if (saved && VALID_LANGUAGES.has(saved as AppLanguage)) {
        return saved as AppLanguage;
      }
    }
  } catch {
    // Ignore storage read failures in restricted environments.
  }
  return 'zh-CN';
}

let currentLanguage: AppLanguage = readLanguageHint();
const listeners = new Set<() => void>();

function applyDocumentMetadata(lang: AppLanguage) {
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = lang;
      document.title = lang === 'en'
        ? 'Looma · Local Client Follow-Through Companion'
        : 'Looma · 可信客户跟进伴侣';
    }
  } catch {
    // Ignore non-DOM execution environments.
  }
}

export function getLanguage(): AppLanguage {
  return currentLanguage;
}

export function setLanguage(next: AppLanguage): AppLanguage {
  const normalized = normalizeLanguage(next);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LANGUAGE_HINT_KEY, normalized);
    }
  } catch {
    // Ignore storage write failures.
  }
  applyDocumentMetadata(normalized);
  if (normalized === currentLanguage) return currentLanguage;
  currentLanguage = normalized;
  for (const listener of listeners) {
    listener();
  }
  return currentLanguage;
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
