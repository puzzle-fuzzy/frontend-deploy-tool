import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/shared/api';

describe('api.uploadVersion', () => {
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

    await api.uploadVersion('project-1', null, [file], 'folder upload');

    if (!sentBody) {
      throw new Error('Expected upload body to be FormData');
    }
    const uploaded = sentBody.get('folderFiles');
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).name).toBe('dist/assets/app.js');
  });
});
