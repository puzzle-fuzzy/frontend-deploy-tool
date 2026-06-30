import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VersionList } from '@/features/versions/VersionList';
import type { Project } from '@/types';

const noop = () => {};

describe('VersionList', () => {
  it('badges the active version and offers activation for inactive ones', () => {
    const project = {
      id: 'p',
      name: 'P',
      slug: 'p',
      description: '',
      createdAt: '',
      updatedAt: '',
      settings: { spaMode: false, routingType: 'path' },
      activeVersionId: 'v1',
      versions: [
        { id: 'v1', name: 'v1', description: '', createdAt: '' },
        { id: 'v2', name: 'v2', description: '', createdAt: '' },
      ],
    } as Project;

    render(<VersionList project={project} onActivate={noop} onDelete={noop} />);

    expect(screen.getByText('versions.production')).toBeInTheDocument();
    expect(screen.getByText('versions.setProduction')).toBeInTheDocument();
  });

  it('renders the empty state when the project has no versions', () => {
    const project = {
      id: 'p',
      name: 'P',
      slug: 'p',
      description: '',
      createdAt: '',
      updatedAt: '',
      settings: { spaMode: false, routingType: 'path' },
      activeVersionId: null,
      versions: [],
    } as Project;

    render(<VersionList project={project} onActivate={noop} onDelete={noop} />);
    expect(screen.getByText('versions.empty')).toBeInTheDocument();
  });
});
