import { expect, test } from 'bun:test';
import { ApiClientError } from '@deploykit/client/errors';
import { unwrapIpcResult } from '../src/renderer/ipcApiClient';

test('unwrapIpcResult reconstructs the shared client error in the renderer', async () => {
  const promise = unwrapIpcResult(
    Promise.resolve({
      ok: false as const,
      error: {
        message: 'Authentication required',
        status: 401,
        code: 'UNAUTHORIZED' as const,
        requestId: 'request-ipc-01',
      },
    })
  );

  await expect(promise).rejects.toBeInstanceOf(ApiClientError);
  await expect(promise).rejects.toMatchObject({
    message: 'Authentication required',
    status: 401,
    code: 'UNAUTHORIZED',
    requestId: 'request-ipc-01',
  });
});
