import { describe, expect, it } from 'vitest';
import type { ApiClient } from '@/api/ApiClient';
import { createFetchApiClient } from '@/api/fetchApiClient';

const EXPECTED_METHODS = [
  'getMe',
  'login',
  'logout',
  'listProjects',
  'createProject',
  'updateProject',
  'deleteProject',
  'updateSettings',
  'uploadVersion',
  'publishVersion',
  'rollbackVersion',
  'deleteVersion',
] as const;

describe('createFetchApiClient', () => {
  it('implements every ApiClient method', () => {
    const client: ApiClient = createFetchApiClient();
    for (const name of EXPECTED_METHODS) {
      expect(typeof client[name]).toBe('function');
    }
  });
});
