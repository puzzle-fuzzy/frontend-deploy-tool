import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadVersionDialog } from '@/features/versions/UploadVersionDialog';
import { api } from '@/lib/api';

vi.mock('@/lib/api');

const noop = () => {};

describe('UploadVersionDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('disables submit until a file is dropped, then uploads it', async () => {
    vi.mocked(api.uploadVersion).mockResolvedValue({
      version: { id: 'v1', name: 'v1' },
    });
    const user = userEvent.setup();
    render(
      <UploadVersionDialog
        open
        onOpenChange={noop}
        projectId="p"
        onUploaded={noop}
      />
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
    await waitFor(() => expect(api.uploadVersion).toHaveBeenCalled());
    expect(api.uploadVersion).toHaveBeenCalledWith(
      'p',
      file,
      null,
      '',
      expect.any(Function)
    );
  });
});
