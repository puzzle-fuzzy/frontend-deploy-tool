import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CreateProjectDialog } from '../../src/features/projects/CreateProjectDialog';
import { mockApiClient, renderWithClient } from '../helpers/renderWithClient';

const noop = () => {};

describe('CreateProjectDialog', () => {
  it('clears draft fields when closed without creating a project', async () => {
    const user = userEvent.setup();
    const client = mockApiClient();
    const { rerender } = renderWithClient(
      <CreateProjectDialog open onOpenChange={noop} onCreated={noop} />,
      client
    );

    await user.type(screen.getByLabelText('create.name'), 'Demo Site');
    await user.type(screen.getByLabelText('create.slug'), 'demo-site');
    await user.type(screen.getByLabelText('create.description'), 'Preview');

    rerender(
      <CreateProjectDialog open={false} onOpenChange={noop} onCreated={noop} />
    );
    rerender(<CreateProjectDialog open onOpenChange={noop} onCreated={noop} />);

    expect(screen.getByLabelText('create.name')).toHaveValue('');
    expect(screen.getByLabelText('create.slug')).toHaveValue('');
    expect(screen.getByLabelText('create.description')).toHaveValue('');
    expect(screen.getByText('create.create')).toBeDisabled();
  });
});
