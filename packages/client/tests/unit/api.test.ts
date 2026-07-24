import {
  ApiClientError,
  checkOk,
  createFetchApiClient,
} from '@deploykit/client';
import { ErrorCode } from '@deploykit/shared/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocalizedError } from '../../src/shared/error-messages';

describe('createFetchApiClient().uploadVersion', () => {
  const OriginalXMLHttpRequest = globalThis.XMLHttpRequest;

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.XMLHttpRequest = OriginalXMLHttpRequest;
  });

  it('preserves folder upload relative paths in multipart filenames', async () => {
    let sentBody: FormData | undefined;

    class XMLHttpRequestStub {
      status = 201;
      responseText = JSON.stringify({ version: { id: 'v1', name: 'v1' } });
      upload = {};
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      open = vi.fn();

      send(body: XMLHttpRequestBodyInit) {
        if (!(body instanceof FormData)) {
          throw new Error('Expected upload body to be FormData');
        }
        sentBody = body;
        this.onload?.();
      }
    }

    vi.stubGlobal('XMLHttpRequest', XMLHttpRequestStub);
    const file = new File(['console.log(1)'], 'app.js');
    Object.defineProperty(file, 'webkitRelativePath', {
      value: 'dist/assets/app.js',
    });

    const api = createFetchApiClient();
    await api.uploadVersion('project-1', null, [file], 'folder upload');

    if (!sentBody) {
      throw new Error('Expected upload body to be FormData');
    }
    const uploaded = sentBody.get('folderFiles');
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).name).toBe('dist/assets/app.js');
  });
});

describe('API error contract', () => {
  it('preserves status, stable code, and request id from an error response', async () => {
    let caught: unknown;
    try {
      await checkOk({
        ok: false,
        status: 409,
        statusText: 'Conflict',
        headers: new Headers({ 'X-Request-Id': 'request-web-01' }),
        text: async () =>
          JSON.stringify({
            error: {
              code: ErrorCode.PROJECT_SLUG_TAKEN,
              message: 'Server wording can change',
            },
          }),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiClientError);
    expect(caught).toMatchObject({
      status: 409,
      code: ErrorCode.PROJECT_SLUG_TAKEN,
      requestId: 'request-web-01',
      message: 'Server wording can change',
    });
  });

  it('localizes by stable code before considering server message wording', () => {
    const error = new ApiClientError(
      'Completely new server message',
      400,
      ErrorCode.INVALID_CREDENTIALS,
      'request-web-02'
    );

    expect(getLocalizedError(error, (key) => `translated:${key}`)).toBe(
      'translated:error.invalidCredentials'
    );
  });
});
