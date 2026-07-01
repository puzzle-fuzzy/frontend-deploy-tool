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
});
