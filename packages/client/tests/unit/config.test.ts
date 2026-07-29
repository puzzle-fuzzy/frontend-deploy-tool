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

  it('prefers the dedicated deploy base URL', () => {
    vi.stubEnv('VITE_DEPLOY_BASE_URL', 'https://assets.example.net///');
    vi.stubEnv('VITE_PUBLIC_BASE_URL', 'https://legacy.example.com');

    expect(getPublicBaseURL()).toBe('https://assets.example.net');
  });
});
