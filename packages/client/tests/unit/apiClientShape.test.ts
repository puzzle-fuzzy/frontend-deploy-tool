import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/api/ApiClient';

const { mockGetMe, mockListProjectHistory } = vi.hoisted(() => ({
  mockGetMe: vi.fn(),
  mockListProjectHistory: vi.fn(),
}));

vi.mock('hono/client', () => ({
  hc: vi.fn(() => ({
    api: {
      me: { $get: mockGetMe },
      auth: {
        login: { $post: vi.fn() },
        logout: { $post: vi.fn() },
        register: { $post: vi.fn() },
      },
      projects: {
        $get: vi.fn(),
        ':id': {
          $patch: vi.fn(),
          $delete: vi.fn(),
          history: { $get: mockListProjectHistory },
          settings: { $patch: vi.fn() },
          versions: {
            ':versionId': {
              publish: { $post: vi.fn() },
              rollback: { $post: vi.fn() },
              $delete: vi.fn(),
            },
          },
        },
      },
    },
  })),
}));

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
  'listProjectHistory',
] as const;

describe('createFetchApiClient', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    mockGetMe.mockReset();
    vi.restoreAllMocks();
  });

  it('implements every ApiClient method', async () => {
    const { createFetchApiClient } = await import(
      '../../src/api/fetchApiClient'
    );
    const client: ApiClient = createFetchApiClient();
    for (const name of EXPECTED_METHODS) {
      expect(typeof client[name]).toBe('function');
    }
  });

  it('rehydrates a stored bearer token for protected requests', async () => {
    window.localStorage.setItem('deploykit.auth.token', 'persisted-token');
    mockGetMe.mockResolvedValue(
      new Response(JSON.stringify({ id: 'u1', name: 'Ada' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { createFetchApiClient } = await import(
      '../../src/api/fetchApiClient'
    );
    const client: ApiClient = createFetchApiClient();
    const user = await client.getMe();

    expect(user).toMatchObject({ id: 'u1', name: 'Ada' });
    expect(mockGetMe).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer persisted-token',
        }),
      })
    );
  });

  it('loads project history with the requested limit and opaque cursor', async () => {
    mockListProjectHistory.mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const { createFetchApiClient } = await import(
      '../../src/api/fetchApiClient'
    );
    const client = createFetchApiClient();

    await client.listProjectHistory('project-1', {
      limit: 25,
      cursor: 'cursor/one',
    });

    expect(mockListProjectHistory).toHaveBeenCalledWith(
      {
        param: { id: 'project-1' },
        query: { limit: '25', cursor: 'cursor/one' },
      },
      expect.objectContaining({ headers: undefined })
    );
  });
});
