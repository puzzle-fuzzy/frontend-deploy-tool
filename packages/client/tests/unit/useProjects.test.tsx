import type { ApiClient } from '@deploykit/client';
import { ApiClientProvider } from '@deploykit/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjects } from '../../src/features/projects/useProjects';
import type { Project, Version } from '../../src/shared/types';
import { mockApiClient } from '../helpers/renderWithClient';

const version = (id: string): Version => ({
  id,
  name: id,
  description: '',
  createdAt: '',
  size: 0,
  fileCount: 0,
  sourceType: 'unknown',
  status: 'preview',
  publishedAt: null,
  publishedBy: null,
  checksum: '',
});

const project = (id: string, overrides: Partial<Project> = {}): Project => ({
  id,
  name: id,
  slug: id,
  description: '',
  createdAt: '',
  updatedAt: '',
  versions: [],
  activeVersionId: null,
  settings: { spaMode: false, routingType: 'path' },
  ...overrides,
  createdBy: overrides.createdBy ?? '',
  members: overrides.members ?? [],
});

function wrapper(client: ApiClient) {
  return ({ children }: { children: ReactNode }) => (
    <ApiClientProvider client={client}>{children}</ApiClientProvider>
  );
}

describe('useProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('loads projects on mount', async () => {
    const client = mockApiClient({
      listProjects: vi.fn().mockResolvedValue([project('a'), project('b')]),
    });
    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(result.current.loading).toBe(false);
  });

  it('clears a stale project hash when the project no longer exists', async () => {
    window.location.hash = '#/projects/missing';
    const client = mockApiClient({
      listProjects: vi.fn().mockResolvedValue([project('a')]),
    });

    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.selectedProject).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('publishes a version and refreshes the list', async () => {
    const target = project('a', {
      versions: [version('v1')],
      activeVersionId: 'v1',
    });
    const client = mockApiClient({
      listProjects: vi.fn().mockResolvedValue([target]),
      publishVersion: vi.fn().mockResolvedValue({ ok: true }),
    });

    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    act(() => {
      result.current.selectProject(result.current.projects[0]);
    });
    await act(async () => {
      await result.current.publishVersion('v1');
    });

    expect(client.publishVersion).toHaveBeenCalledWith('a', 'v1');
    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it('tracks the in-flight version id during publish', async () => {
    const target = project('a', {
      versions: [version('v1')],
      activeVersionId: 'v1',
    });
    let resolvePublish!: (value: { ok: boolean }) => void;
    const client = mockApiClient({
      listProjects: vi.fn().mockResolvedValue([target]),
      publishVersion: vi.fn().mockReturnValue(
        new Promise<{ ok: boolean }>((resolve) => {
          resolvePublish = resolve;
        })
      ),
    });

    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    act(() => {
      result.current.selectProject(result.current.projects[0]);
    });

    expect(result.current.pendingVersionId).toBeNull();
    act(() => {
      void result.current.publishVersion('v1');
    });
    expect(result.current.pendingVersionId).toBe('v1');

    await act(async () => {
      resolvePublish({ ok: true });
    });
    await waitFor(() => expect(result.current.pendingVersionId).toBeNull());
  });

  it('deletes a version and refreshes the list', async () => {
    const target = project('a', {
      versions: [version('v1')],
      activeVersionId: 'v1',
    });
    const client = mockApiClient({
      listProjects: vi.fn().mockResolvedValue([target]),
      deleteVersion: vi.fn().mockResolvedValue({ ok: true }),
    });

    const { result } = renderHook(() => useProjects(), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    act(() => {
      result.current.selectProject(result.current.projects[0]);
    });
    await act(async () => {
      await result.current.deleteVersion('v1');
    });

    expect(client.deleteVersion).toHaveBeenCalledWith('a', 'v1');
  });
});
