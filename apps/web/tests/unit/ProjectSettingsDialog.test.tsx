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
    vi.mocked(api.updateProject).mockResolvedValue(
      project({ spaMode: false, routingType: 'hash' })
    );
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectSettingsDialog
        open
        onOpenChange={noop}
        project={project({ spaMode: false, routingType: 'hash' })}
        onDeleted={noop}
        onSaved={onSaved}
      />
    );

    await user.click(screen.getByText('settings.save'));

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith('a', {
        spaMode: false,
        routingType: 'hash',
      })
    );
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('resets delete confirmation when the dialog closes', async () => {
    const user = userEvent.setup();
    const props = {
      onOpenChange: noop,
      project: project({ spaMode: false, routingType: 'hash' }),
      onDeleted: noop,
      onSaved: noop,
    };
    const { rerender } = render(<ProjectSettingsDialog open {...props} />);

    await user.click(screen.getByRole('button', { name: 'common.delete' }));
    expect(screen.getByRole('button', { name: 'common.confirm' }));

    rerender(<ProjectSettingsDialog open={false} {...props} />);
    rerender(<ProjectSettingsDialog open {...props} />);

    expect(screen.getByRole('button', { name: 'common.delete' }));
  });

  it('hides the project delete action when deletion is not allowed', () => {
    render(
      <ProjectSettingsDialog
        open
        onOpenChange={noop}
        project={project({ spaMode: false, routingType: 'hash' })}
        onDeleted={noop}
        onSaved={noop}
        canDeleteProject={false}
      />
    );

    expect(
      screen.queryByRole('button', { name: 'common.delete' })
    ).not.toBeInTheDocument();
  });

  it('resets unsaved edits when the dialog closes', async () => {
    const user = userEvent.setup();
    const props = {
      onOpenChange: noop,
      project: project({ spaMode: false, routingType: 'hash' }),
      onDeleted: noop,
      onSaved: noop,
    };
    const { rerender } = render(<ProjectSettingsDialog open {...props} />);

    await user.clear(screen.getByLabelText('create.name'));
    await user.type(screen.getByLabelText('create.name'), 'Unsaved');
    await user.clear(screen.getByLabelText('create.slug'));
    await user.type(screen.getByLabelText('create.slug'), 'unsaved');
    await user.click(screen.getByLabelText('settings.spaMode'));
    await user.click(
      screen.getByRole('button', { name: /settings.routingPath/ })
    );

    rerender(<ProjectSettingsDialog open={false} {...props} />);
    rerender(<ProjectSettingsDialog open {...props} />);

    expect(screen.getByLabelText('create.name')).toHaveValue('A');
    expect(screen.getByLabelText('create.slug')).toHaveValue('a');
    expect(screen.getByLabelText('settings.spaMode')).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: /settings.routingHash/ })
    ).toHaveAttribute('data-variant', 'default');
  });
});
