import { useEffect, useState } from 'react';
import type { AppLanguage } from '../types';
import { getLanguage, setLanguage, subscribeLanguage } from './store';
import { zh, type TranslationDictionary } from './zh';
import { en } from './en';

export * from './store';
export * from './domain';

type LeafKeys<T> = {
  [S in keyof T & string]: {
    [K in keyof T[S] & string]: `${S}.${K}`;
  }[keyof T[S] & string];
}[keyof T & string];

export type I18nKey = LeafKeys<TranslationDictionary>;

const DICTIONARIES: Record<AppLanguage, TranslationDictionary> = {
  'zh-CN': zh,
  en,
};

function lookup(dict: TranslationDictionary, key: string): string | undefined {
  const parts = key.split('.');
  let node: unknown = dict;
  for (const part of parts) {
    if (!node || typeof node !== 'object' || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export function translate(
  lang: AppLanguage,
  key: I18nKey,
  params?: Record<string, string | number>,
): string {
  const template = lookup(DICTIONARIES[lang], key) ?? lookup(zh, key) ?? key;
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, token) =>
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : `{${token}}`,
  );
}

export function t(key: I18nKey, params?: Record<string, string | number>): string {
  return translate(getLanguage(), key, params);
}

/**
 * Uses only useState + useEffect (never useContext / useSyncExternalStore)
 * so components run cleanly in both React DOM trees and direct-call VM test harnesses.
 */
export function useI18n() {
  let lang: AppLanguage = getLanguage();
  try {
    const [stateLang, setLang] = useState<AppLanguage>(getLanguage);
    useEffect(() => subscribeLanguage(() => setLang(getLanguage())), []);
    lang = stateLang;
  } catch {
    // Fallback cleanly if a component test invokes the function directly outside a React dispatcher.
  }
  return {
    lang,
    isEn: lang === 'en',
    t: (key: I18nKey, params?: Record<string, string | number>) => translate(lang, key, params),
  };
}

export { zh, en };
export type { TranslationDictionary };
