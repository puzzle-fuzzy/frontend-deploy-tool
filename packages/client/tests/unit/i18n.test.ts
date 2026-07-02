import { describe, expect, it } from 'vitest';

const sourceModules = import.meta.glob('../../src/**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const localeModules = import.meta.glob('../../src/i18n/locales/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

function flattenKeys(
  value: unknown,
  prefix = '',
  out: Set<string> = new Set()
): Set<string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenKeys(child, nextKey, out);
    } else {
      out.add(nextKey);
    }
  }
  return out;
}

function staticTranslationKeys(): string[] {
  const keys = new Set<string>();
  for (const source of Object.values(sourceModules)) {
    for (const match of source.matchAll(/\bt\(\s*['"]([^'"`]+)['"]/g)) {
      keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

describe('i18n locales', () => {
  it('defines every statically referenced translation key', () => {
    const keys = staticTranslationKeys();
    for (const [locale, messages] of Object.entries(localeModules)) {
      const defined = flattenKeys(messages);
      const missing = keys.filter((key) => !defined.has(key));
      expect(missing, `${locale} missing keys`).toEqual([]);
    }
  });
});
