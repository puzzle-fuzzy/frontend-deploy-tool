import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditPanel } from '@/features/audit/AuditPanel';
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

const project = (versions: Version[] = []): Project => ({
  id: 'p1',
  name: 'Project',
  slug: 'project',
  description: '',
  createdAt: '',
  updatedAt: '',
  versions,
  activeVersionId: versions[0]?.id ?? null,
  settings: { spaMode: false, routingType: 'path' },
});

const report: AuditReport = {
  projectId: 'p1',
  versionId: 'v1',
  profile: 'production-web',
  status: 'warning',
  score: 82,
  createdAt: '',
  checks: [
    {
      id: 'title',
      category: 'seo',
      severity: 'warning',
      title: 'Missing canonical URL',
      message: 'Add a canonical link to the document head.',
      location: 'index.html',
    },
  ],
};

describe('AuditPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the empty state when the project has no versions', () => {
    render(<AuditPanel project={project()} />);

    expect(screen.getByText('audit.empty')).toBeInTheDocument();
  });

  it('runs audit and renders score, check title, and message', async () => {
    vi.mocked(api.runVersionAudit).mockResolvedValue(report);
    const user = userEvent.setup();

    render(<AuditPanel project={project([version('v1')])} />);

    expect(
      screen.getByRole('combobox', { name: 'audit.versions' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'audit.profile' })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'audit.run' }));

    await waitFor(() => {
      expect(api.runVersionAudit).toHaveBeenCalledWith(
        'p1',
        'v1',
        'production-web'
      );
    });
    expect(screen.getByText('82')).toBeInTheDocument();
    expect(screen.getByText('Missing canonical URL')).toBeInTheDocument();
    expect(
      screen.getByText('Add a canonical link to the document head.')
    ).toBeInTheDocument();
  });
});
