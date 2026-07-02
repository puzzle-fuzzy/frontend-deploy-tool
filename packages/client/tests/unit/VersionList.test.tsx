import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VersionList } from '@/features/versions/VersionList';
import type { Project, Version } from '@/shared/types';

const noop = () => {};

const version = (
  id: string,
  status: Version['status'] = 'preview',
  createdAt = '2026-06-30T00:00:00.000Z'
): Version => ({
  id,
  name: id,
  description: '',
  createdAt,
  size: 0,
  fileCount: 0,
  sourceType: 'unknown',
  status,
  publishedAt: status === 'production' ? createdAt : null,
  publishedBy: status === 'production' ? 'user-1' : null,
  checksum: '',
});

const v1 = version('v1', 'production', '2026-06-30T00:00:00.000Z');
const v2 = version('v2', 'preview', '2026-06-30T00:01:00.000Z');

const makeProject = (versions: Version[] = [v1, v2]): Project =>
  ({
    id: 'p',
    name: 'P',
    slug: 'p',
    description: '',
    createdAt: '',
    updatedAt: '',
    settings: { spaMode: false, routingType: 'path' },
    activeVersionId: 'v1',
    versions,
  }) as Project;

describe('VersionList', () => {
  it('badges the active version and offers activation for inactive ones', () => {
    render(
      <VersionList
        project={makeProject()}
        pendingVersionId={null}
        onPublish={noop}
        onRollback={noop}
        onDelete={noop}
      />
    );

    expect(screen.getByText('versions.production')).toBeInTheDocument();
    expect(screen.getByText('versions.publish')).toBeInTheDocument();
  });

  it('uses activeVersionId as the production source of truth', () => {
    render(
      <VersionList
        project={makeProject([version('v1', 'preview')])}
        pendingVersionId={null}
        onPublish={noop}
        onRollback={noop}
        onDelete={noop}
      />
    );

    expect(screen.getByText('versions.production')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'versions.publish' })
    ).not.toBeInTheDocument();
  });

  it('renders the empty state when the project has no versions', () => {
    render(
      <VersionList
        project={makeProject([])}
        pendingVersionId={null}
        onPublish={noop}
        onRollback={noop}
        onDelete={noop}
      />
    );
    expect(screen.getByText('versions.empty')).toBeInTheDocument();
  });

  it('confirms before deleting a version', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <VersionList
        project={makeProject([v1])}
        pendingVersionId={null}
        onPublish={noop}
        onRollback={noop}
        onDelete={onDelete}
      />
    );

    await user.click(screen.getByRole('button', { name: 'common.delete' }));

    // The confirm dialog opens and nothing is deleted yet.
    expect(screen.getByText('common.deleteVersionConfirm')).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'common.confirm' }));
    expect(onDelete).toHaveBeenCalledWith('v1');
  });

  it('hides row actions while the version is pending', () => {
    render(
      <VersionList
        project={makeProject([v1])}
        pendingVersionId="v1"
        onPublish={noop}
        onRollback={noop}
        onDelete={noop}
      />
    );

    expect(
      screen.queryByRole('button', { name: 'common.delete' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'versions.publish' })
    ).not.toBeInTheDocument();
  });
});
