import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVersionAudit } from '@/features/audit/useVersionAudit';
import { api } from '@/shared/api';
import type { AuditReport, Project, Version } from '@/shared/types';

vi.mock('@/shared/api');

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

const report = (
  projectId: string,
  versionId: string,
  overrides: Partial<AuditReport> = {}
): AuditReport => ({
  projectId,
  versionId,
  profile: 'production-web',
  status: 'passed',
  score: 100,
  checks: [],
  createdAt: '',
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('useVersionAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects active version by default and profile production-web', () => {
    const target = project('p1', {
      versions: [version('v1'), version('v2')],
      activeVersionId: 'v2',
    });

    const { result } = renderHook(() => useVersionAudit(target));

    expect(result.current.selectedVersionId).toBe('v2');
    expect(result.current.profile).toBe('production-web');
  });

  it('runs audit and stores report', async () => {
    const target = project('p1', {
      versions: [version('v1')],
      activeVersionId: 'v1',
    });
    const auditReport = report('p1', 'v1');
    vi.mocked(api.runVersionAudit).mockResolvedValue(auditReport);

    const { result } = renderHook(() => useVersionAudit(target));

    await act(async () => {
      await result.current.runAudit();
    });

    expect(api.runVersionAudit).toHaveBeenCalledWith(
      'p1',
      'v1',
      'production-web'
    );
    expect(result.current.report).toBe(auditReport);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('resets selected version and report when project changes', async () => {
    const first = project('p1', {
      versions: [version('v1')],
      activeVersionId: 'v1',
    });
    const second = project('p2', {
      versions: [version('v2')],
      activeVersionId: 'v2',
    });
    vi.mocked(api.runVersionAudit).mockResolvedValue(report('p1', 'v1'));

    const { result, rerender } = renderHook(
      ({ selectedProject }) => useVersionAudit(selectedProject),
      { initialProps: { selectedProject: first } }
    );

    await act(async () => {
      await result.current.runAudit();
    });
    expect(result.current.report).not.toBeNull();

    rerender({ selectedProject: second });

    await waitFor(() => {
      expect(result.current.selectedVersionId).toBe('v2');
      expect(result.current.report).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });

  it('clears an existing report and error when selected version changes', async () => {
    const target = project('p1', {
      versions: [version('v1'), version('v2')],
      activeVersionId: 'v1',
    });
    vi.mocked(api.runVersionAudit)
      .mockResolvedValueOnce(report('p1', 'v1'))
      .mockRejectedValueOnce(new Error('Audit failed'));

    const { result } = renderHook(() => useVersionAudit(target));

    await act(async () => {
      await result.current.runAudit();
    });
    await act(async () => {
      await result.current.runAudit();
    });
    expect(result.current.report).not.toBeNull();
    expect(result.current.error).toBe('Audit failed');

    act(() => {
      result.current.setSelectedVersionId('v2');
    });

    expect(result.current.selectedVersionId).toBe('v2');
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('clears an existing report and error when profile changes', async () => {
    const target = project('p1', {
      versions: [version('v1')],
      activeVersionId: 'v1',
    });
    vi.mocked(api.runVersionAudit)
      .mockResolvedValueOnce(report('p1', 'v1'))
      .mockRejectedValueOnce(new Error('Audit failed'));

    const { result } = renderHook(() => useVersionAudit(target));

    await act(async () => {
      await result.current.runAudit();
    });
    await act(async () => {
      await result.current.runAudit();
    });
    expect(result.current.report).not.toBeNull();
    expect(result.current.error).toBe('Audit failed');

    act(() => {
      result.current.setProfile('demo');
    });

    expect(result.current.profile).toBe('demo');
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('prevents a stale slower audit response from overwriting a newer successful response', async () => {
    const target = project('p1', {
      versions: [version('v1'), version('v2')],
      activeVersionId: 'v1',
    });
    const first = deferred<AuditReport>();
    const second = deferred<AuditReport>();
    vi.mocked(api.runVersionAudit)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useVersionAudit(target));

    act(() => {
      void result.current.runAudit();
    });
    act(() => {
      result.current.setSelectedVersionId('v2');
    });
    act(() => {
      void result.current.runAudit();
    });

    await act(async () => {
      second.resolve(report('p1', 'v2', { score: 90 }));
    });
    expect(result.current.report?.versionId).toBe('v2');
    expect(result.current.loading).toBe(false);

    await act(async () => {
      first.resolve(report('p1', 'v1', { score: 10 }));
    });

    expect(result.current.report?.versionId).toBe('v2');
    expect(result.current.report?.score).toBe(90);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('ignores an audit response after the selected version changes', async () => {
    const target = project('p1', {
      versions: [version('v1'), version('v2')],
      activeVersionId: 'v1',
    });
    const pending = deferred<AuditReport>();
    vi.mocked(api.runVersionAudit).mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() => useVersionAudit(target));

    act(() => {
      void result.current.runAudit();
    });
    expect(result.current.loading).toBe(true);

    act(() => {
      result.current.setSelectedVersionId('v2');
    });
    expect(result.current.loading).toBe(false);

    await act(async () => {
      pending.resolve(report('p1', 'v1'));
    });

    expect(result.current.selectedVersionId).toBe('v2');
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('keeps no-op behavior when no project or selected version exists', async () => {
    const { result } = renderHook(() => useVersionAudit(null));

    await act(async () => {
      await result.current.runAudit();
    });

    expect(api.runVersionAudit).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});
