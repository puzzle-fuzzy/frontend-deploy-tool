import { expect, mock, test } from 'bun:test';
import { ApiClientError } from '@deploykit/client/errors';
import {
  createIpcApiClient,
  unwrapIpcResult,
} from '../src/renderer/ipcApiClient';

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

test('forwards the history page query through the desktop bridge', async () => {
  const listProjectHistory = mock(async () => ({
    ok: true as const,
    data: { items: [], nextCursor: null },
  }));
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      deploykit: {
        api: { listProjectHistory },
      },
    },
  });

  try {
    const client = createIpcApiClient();
    await client.listProjectHistory('project-1', {
      limit: 25,
      cursor: 'cursor-one',
    });

    expect(listProjectHistory).toHaveBeenCalledWith('project-1', {
      limit: 25,
      cursor: 'cursor-one',
    });
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: previousWindow,
    });
  }
});
