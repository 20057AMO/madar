import { createContext, type ComponentChildren } from 'preact';
import { useState, useEffect, useContext, useMemo, useCallback } from 'preact/hooks';
import { en } from './en';
import { ar } from './ar';
import type { Dict } from './en';

export type Lang = 'ar' | 'en';

export const LANG_KEY = 'wsd.lang';

/** Read the persisted language preference (defaults to Arabic — first visit). */
export function detectInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'ar' || stored === 'en') return stored;
    return 'ar';
  } catch {
    return 'ar';
  }
}

/** Direction for a language — Arabic is the only RTL locale for now. */
export function langDir(lang: Lang): 'rtl' | 'ltr' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

interface I18nState {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  /** Translate: t('nav.dashboard') or t('common.nProjects', { n: 5 }). */
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Bilingual inline helper: t2('مرحبا', 'Hello') — for quick UI copy. */
  t2: (ar: string, en: string) => string;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
}

const I18nContext = createContext<I18nState>({
  lang: 'ar',
  dir: 'rtl',
  t: (k) => k,
  t2: (a) => a,
  setLang: () => {},
  toggleLang: () => {},
});

export function useI18n(): I18nState {
  return useContext(I18nContext);
}

function lookup(dict: Dict, key: string): string | undefined {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function fill(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m,
  );
}

export function I18nProvider({ children }: { children: ComponentChildren }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);
  const dir = langDir(lang);

  // Keep <html dir/lang> in sync so pure-CSS :dir(rtl) rules and the
  // UA default font fallback follow the choice app-wide.
  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = lang;
  }, [dir, lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try { localStorage.setItem(LANG_KEY, next); } catch { /* private mode */ }
  }, []);

  const toggleLang = useCallback(() => {
    setLangState((cur) => {
      const next: Lang = cur === 'ar' ? 'en' : 'ar';
      try { localStorage.setItem(LANG_KEY, next); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const value = useMemo<I18nState>(() => ({
    lang,
    dir,
    t: (key, params) => {
      const hit = lookup(lang === 'ar' ? ar : en, key);
      const fallback = lookup(en, key);
      const template = hit ?? fallback ?? key;
      return fill(template, params);
    },
    // The bilingual inline helper ignores the dictionaries — the copy is
    // supplied at the call site (same pattern as studio-guide.tsx).
    t2: (a, e) => (lang === 'ar' ? a : e),
    setLang,
    toggleLang,
  }), [lang, dir, setLang, toggleLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
