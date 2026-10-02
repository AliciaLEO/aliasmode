import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import enUS from "./locales/en-US.json";
import zhCN from "./locales/zh-CN.json";
import { fetchShellLanguage, saveShellLanguage } from "./api.ts";

export type Language = "en-US" | "zh-CN";

const LANGUAGE_KEY = "aliasmode.shell.language";

const catalogs: Record<Language, Record<string, string>> = {
  "en-US": enUS as Record<string, string>,
  "zh-CN": zhCN as Record<string, string>,
};

export function readLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved === "zh-CN" || saved === "en-US") return saved;
  } catch {}
  return "en-US";
}

type TranslationValues = Record<string, string | number>;
type TranslationContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (source: string, values?: TranslationValues) => string;
};

const I18nContext = createContext<TranslationContextValue | null>(null);

function format(source: string, values?: TranslationValues): string {
  if (!values) return source;
  return source.replace(/\{\{?(\w+)\}?\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match
  );
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readLanguage);
  // The desktop shell serves the UI from a random loopback port each launch,
  // and localStorage is origin-scoped, so a saved language never survives a
  // restart in localStorage alone. Hydrate from the server-persisted value.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    fetchShellLanguage()
      .then((saved) => {
        if (saved !== readLanguage()) {
          setLanguageState(saved);
          try {
            localStorage.setItem(LANGUAGE_KEY, saved);
            document.documentElement.lang = saved;
          } catch {}
        }
      })
      .catch(() => {});
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem(LANGUAGE_KEY, lang);
      document.documentElement.lang = lang;
    } catch {}
    // Persist server-side so the choice survives restarts (fire-and-forget).
    saveShellLanguage(lang).catch(() => {});
  };

  useEffect(() => {
    try {
      document.documentElement.lang = language;
      localStorage.setItem(LANGUAGE_KEY, language);
    } catch {}
  }, [language]);

  const value = useMemo<TranslationContextValue>(() => ({
    language,
    setLanguage,
    t: (source, values) => {
      const catalog = catalogs[language] || catalogs["en-US"];
      const translated = catalog[source] ?? source;
      return format(translated, values);
    },
  }), [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): TranslationContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    // Fall back to English when rendered outside a provider (e.g. in tests).
    return {
      language: "en-US",
      setLanguage: () => {},
      t: (source: string, values?: TranslationValues) => format(source, values),
    };
  }
  return value;
}

export function availableLanguages(): Language[] {
  return ["en-US", "zh-CN"];
}

export function languageNativeName(lang: string): string {
  switch (lang) {
    case "zh-CN": return "简体中文";
    case "en-US": return "English";
    default: return lang;
  }
}