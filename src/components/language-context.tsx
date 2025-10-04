"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getDictionary, locales, type Locale } from "@/lib/i18n";

type LanguageContextValue = {
  locale: Locale;
  dictionary: Record<string, string>;
  locales: readonly Locale[];
  setLocale: (next: Locale) => void;
};

const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

const STORAGE_KEY = "viprpg-locale";
const DEFAULT_LOCALE: Locale = "ja";

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const saved = window.localStorage?.getItem(STORAGE_KEY);
    if (saved && locales.includes(saved as Locale)) {
      setLocaleState(saved as Locale);
      return;
    }
    const fromNavigator = window.navigator?.language?.slice(0, 2).toLowerCase();
    const matched = locales.find((item) => item.startsWith(fromNavigator ?? ""));
    if (matched && matched !== DEFAULT_LOCALE) {
      setLocaleState(matched);
    }
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
    if (typeof window !== "undefined") {
      window.localStorage?.setItem(STORAGE_KEY, locale);
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    if (locales.includes(next)) {
      setLocaleState(next);
    }
  }, []);

  const dictionary = useMemo(() => getDictionary(locale), [locale]);

  const value = useMemo<LanguageContextValue>(
    () => ({ locale, dictionary, locales, setLocale }),
    [dictionary, locale, setLocale]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}
