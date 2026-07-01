import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSettingsDialog } from '@/features/settings/ProjectSettingsDialog';
import { api } from '@/shared/api';
import type { Project } from '@/shared/types';

vi.mock('@/shared/api');

const noop = () => {};

const project = (settings: Project['settings']): Project => ({
  id: 'a',
  name: 'A',
  slug: 'a',
  description: '',
  createdAt: '',
  updatedAt: '',
  versions: [],
  activeVersionId: null,
  settings,
});

describe('ProjectSettingsDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves the current settings payload', async () => {
    vi.mocked(api.updateSettings).mockResolvedValue(
      project({ spaMode: false, routingType: 'hash' })
    );
    const user = userEvent.setup();
    render(
      <ProjectSettingsDialog
        open
        onOpenChange={noop}
        project={project({ spaMode: false, routingType: 'hash' })}
        onDeleted={noop}
      />
    );

    await user.click(screen.getByText('settings.save'));

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith('a', {
        spaMode: false,
        routingType: 'hash',
      })
    );
  });
});
