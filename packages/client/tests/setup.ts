import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom does not implement ResizeObserver (used by Radix ScrollArea/Tooltip).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

// Components use useTranslation; render with the i18n key as the label so tests
// stay locale-independent. Keep the real `initReactI18next` export so the i18n
// side-effect init pulled in via App.tsx does not crash on the missing export.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: 'en', changeLanguage: () => {} },
    }),
  };
});

// Toast is a side-effect channel; no-op it in tests.
vi.mock('@/shared/ui/toast-context', () => ({
  useToast: () => ({ toast: () => {} }),
}));
