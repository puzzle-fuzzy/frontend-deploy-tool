import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'theme';

/** Tracks the dark/light theme, persisting to localStorage and toggling the `dark` class on `<html>`. */
export function useTheme() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored === 'dark';
    return false;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light');
  }, [dark]);

  const toggle = useCallback(() => setDark((d) => !d), []);

  return { dark, toggle };
}
