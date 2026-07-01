import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjects } from '@/features/projects/useProjects';
import { api } from '@/lib/api';
import type { Project, Version } from '@/types';

vi.mock('@/lib/api');

const version = (id: string): Version => ({
  id,
  name: id,
  description: '',
  createdAt: '',
  size: 0,
  fileCount: 0,
  sourceType: 'unknown',
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
});

describe('useProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('loads projects on mount', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([project('a'), project('b')]);
    const { result } = renderHook(() => useProjects());

    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(result.current.loading).toBe(false);
  });

  it('activates a version and refreshes the list', async () => {
    const target = project('a', {
      versions: [version('v1')],
      activeVersionId: 'v1',
    });
    vi.mocked(api.listProjects).mockResolvedValue([target]);
    vi.mocked(api.activateVersion).mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    act(() => {
      result.current.selectProject(result.current.projects[0]);
    });
    await act(async () => {
      await result.current.activateVersion('v1');
    });

    expect(api.activateVersion).toHaveBeenCalledWith('a', 'v1');
    expect(api.listProjects).toHaveBeenCalledTimes(2);
  });

  it('tracks the in-flight version id during activate', async () => {
    const target = project('a', {
      versions: [version('v1')],
      activeVersionId: 'v1',
    });
    vi.mocked(api.listProjects).mockResolvedValue([target]);
    let resolveActivate!: (value: { ok: boolean }) => void;
    vi.mocked(api.activateVersion).mockReturnValue(
      new Promise<{ ok: boolean }>((resolve) => {
        resolveActivate = resolve;
      })
    );

    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    act(() => {
      result.current.selectProject(result.current.projects[0]);
    });

    expect(result.current.pendingVersionId).toBeNull();
    act(() => {
      void result.current.activateVersion('v1');
    });
    expect(result.current.pendingVersionId).toBe('v1');

    await act(async () => {
      resolveActivate({ ok: true });
    });
    await waitFor(() => expect(result.current.pendingVersionId).toBeNull());
  });

  it('deletes a version and refreshes the list', async () => {
    const target = project('a', {
      versions: [version('v1')],
      activeVersionId: 'v1',
    });
    vi.mocked(api.listProjects).mockResolvedValue([target]);
    vi.mocked(api.deleteVersion).mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    act(() => {
      result.current.selectProject(result.current.projects[0]);
    });
    await act(async () => {
      await result.current.deleteVersion('v1');
    });

    expect(api.deleteVersion).toHaveBeenCalledWith('a', 'v1');
  });
});
