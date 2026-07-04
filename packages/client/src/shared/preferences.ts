import { useEffect, useState } from 'react';

const THEME_STORAGE_KEY = 'theme';
const LANGUAGE_STORAGE_KEY = 'i18nextLng';

type Language = 'en' | 'zh';

function getStoredTheme() {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(THEME_STORAGE_KEY) === 'dark';
}

function getStoredLanguage(): Language {
  if (typeof localStorage === 'undefined') return 'zh';
  const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored?.startsWith('en') ? 'en' : 'zh';
}

export function useThemePreference() {
  const [dark, setDark] = useState(getStoredTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light');
  }, [dark]);

  return {
    dark,
    toggleTheme: () => setDark((current) => !current),
  };
}

export function useLanguagePreference() {
  const [language, setLanguage] = useState<Language>(getStoredLanguage);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  return {
    language,
    isZh: language === 'zh',
    toggleLanguage: () =>
      setLanguage((current) => (current === 'zh' ? 'en' : 'zh')),
  };
}
