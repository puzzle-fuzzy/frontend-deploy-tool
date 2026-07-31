import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ProjectSettingsForm } from '../../src/features/settings/ProjectSettingsForm';
import { mockApiClient, renderWithClient } from '../helpers/renderWithClient';

const project = {
  id: 'project-1',
  name: 'Signal Desk',
  slug: 'signal-desk',
  description: '',
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
  versions: [],
  activeVersionId: null,
  settings: { spaMode: false, routingType: 'path' as const },
  auditPolicy: {
    enforcement: 'advisory' as const,
    maxTotalBytes: 50 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
    maxFileCount: 1_000,
    maxJavaScriptBytes: 10 * 1024 * 1024,
    maxStylesheetBytes: 2 * 1024 * 1024,
    maxFontBytes: 10 * 1024 * 1024,
  },
  createdBy: 'user-1',
  members: [
    {
      userId: 'user-1',
      role: 'owner' as const,
      invitedAt: '2026-07-24T00:00:00.000Z',
    },
  ],
};

it('uses an accessible confirmation dialog before deleting a project', async () => {
  const deleteProject = vi.fn().mockResolvedValue({ ok: true });
  const onDeleted = vi.fn();
  const user = userEvent.setup();
  renderWithClient(
    <ProjectSettingsForm
      project={project}
      canManage
      onSaved={vi.fn()}
      onDeleted={onDeleted}
    />,
    mockApiClient({ deleteProject })
  );

  await user.click(
    screen.getByRole('button', { name: 'settings.deleteProject' })
  );

  const dialog = screen.getByRole('alertdialog');
  expect(
    within(dialog).getByText('settings.deleteProjectConfirm')
  ).toBeInTheDocument();
  expect(deleteProject).not.toHaveBeenCalled();

  await user.click(
    within(dialog).getByRole('button', { name: 'settings.deleteProject' })
  );

  await waitFor(() => {
    expect(deleteProject).toHaveBeenCalledWith('project-1');
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});
