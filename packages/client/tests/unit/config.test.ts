import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPublicBaseURL } from '../../src/shared/config';

describe('getPublicBaseURL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('removes trailing slashes from the configured public base URL', () => {
    vi.stubEnv('VITE_PUBLIC_BASE_URL', 'https://deploy.example.com///');

    expect(getPublicBaseURL()).toBe('https://deploy.example.com');
  });
});
