import type { ApiClient } from '@deploykit/client';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadVersionDialog } from '../../src/features/versions/UploadVersionDialog';
import { mockApiClient, renderWithClient } from '../helpers/renderWithClient';

const noop = () => {};

describe('UploadVersionDialog', () => {
  let client: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = mockApiClient({
      uploadVersion: vi.fn().mockResolvedValue({
        version: { id: 'v1', name: 'v1' },
      }),
    });
  });

  it('disables submit until a file is dropped, then uploads it', async () => {
    const user = userEvent.setup();
    renderWithClient(
      <UploadVersionDialog
        open
        onOpenChange={noop}
        projectId="p"
        onUploaded={noop}
      />,
      client
    );

    const submit = screen.getByText('upload.submit');
    expect(submit).toBeDisabled();

    // Simulate dropping a zip onto the dropzone.
    const dropzone = screen.getByText('upload.dropzone');
    const file = new File(['x'], 'test.zip', { type: 'application/zip' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });

    // The filename label appears and submit is now enabled.
    expect(await screen.findByText('test.zip')).toBeInTheDocument();
    expect(submit).not.toBeDisabled();

    await user.click(submit);
    await waitFor(() => expect(client.uploadVersion).toHaveBeenCalled());
    expect(client.uploadVersion).toHaveBeenCalledWith(
      'p',
      file,
      null,
      '',
      expect.any(Function)
    );
  });

  it('clears selected upload state when closed', async () => {
    const { rerender } = renderWithClient(
      <UploadVersionDialog
        open
        onOpenChange={noop}
        projectId="p"
        onUploaded={noop}
      />,
      client
    );
    const submit = screen.getByText('upload.submit');
    const dropzone = screen.getByText('upload.dropzone');
    const file = new File(['x'], 'test.zip', { type: 'application/zip' });

    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
    expect(await screen.findByText('test.zip')).toBeInTheDocument();
    expect(submit).not.toBeDisabled();

    // The `wrapper` option on render re-applies the provider on rerender.
    rerender(
      <UploadVersionDialog
        open={false}
        onOpenChange={noop}
        projectId="p"
        onUploaded={noop}
      />
    );
    rerender(
      <UploadVersionDialog
        open
        onOpenChange={noop}
        projectId="p"
        onUploaded={noop}
      />
    );

    expect(screen.getByText('upload.dropzone')).toBeInTheDocument();
    expect(screen.getByText('upload.submit')).toBeDisabled();
  });
});
