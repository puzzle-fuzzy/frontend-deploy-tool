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

afterEach(() => {
  cleanup();
});

// Components use useTranslation; render with the i18n key as the label so tests
// stay locale-independent.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: () => {} },
  }),
}));

// Toast is a side-effect channel; no-op it in tests.
vi.mock('@/lib/toast-context', () => ({
  useToast: () => ({ toast: () => {} }),
}));
