import type { ApiApp } from '@deploykit/server/api';
import { hc } from 'hono/client';
import type { Project, SafeUser, Settings } from './types';

// Same-origin API; the Vite dev server proxies `/api` to the backend in dev.
const client = hc<ApiApp>('');

/** Extracts the human-readable message from a `{ error: { message } }` body. */
function extractMessage(text: string): string {
  try {
    return JSON.parse(text)?.error?.message ?? text;
  } catch {
    return text;
  }
}

/** Throws the server's error message when the response is not ok. */
async function checkOk(res: {
  ok: boolean;
  statusText: string;
  text: () => Promise<string>;
}): Promise<void> {
  if (res.ok) return;
  const text = await res.text();
  throw new Error(extractMessage(text) || res.statusText);
}

export const api = {
  getMe: async (): Promise<SafeUser | null> => {
    // hono/client uses same-origin fetch, so the session cookie is sent.
    const res = await client.api.me.$get();
    if (res.status === 401) return null;
    await checkOk(res);
    return res.json();
  },

  login: async (email: string, password: string): Promise<SafeUser> => {
    const res = await client.api.auth.login.$post({
      json: { email, password },
    });
    await checkOk(res);
    const body = await res.json();
    return body.user;
  },

  logout: async (): Promise<void> => {
    const res = await client.api.auth.logout.$post();
    await checkOk(res);
  },

  listProjects: async (): Promise<Project[]> => {
    const res = await client.api.projects.$get();
    await checkOk(res);
    return res.json();
  },

  createProject: async (data: {
    name: string;
    slug: string;
    description: string;
  }): Promise<Project> => {
    const res = await client.api.projects.$post({ json: data });
    await checkOk(res);
    return res.json();
  },

  updateProject: async (
    id: string,
    data: {
      name?: string;
      slug?: string;
      description?: string;
    }
  ): Promise<Project> => {
    const res = await client.api.projects[':id'].$patch({
      param: { id },
      json: data,
    });
    await checkOk(res);
    return res.json();
  },

  deleteProject: async (id: string): Promise<{ ok: boolean }> => {
    const res = await client.api.projects[':id'].$delete({ param: { id } });
    await checkOk(res);
    return res.json();
  },

  updateSettings: async (id: string, settings: Settings): Promise<Project> => {
    const res = await client.api.projects[':id'].settings.$patch({
      param: { id },
      json: settings,
    });
    await checkOk(res);
    return res.json();
  },

  uploadVersion: (
    projectId: string,
    file: File | null,
    folderFiles: File[] | null,
    description: string,
    onProgress?: (pct: number) => void
  ): Promise<{ version: { id: string; name: string } }> =>
    new Promise((resolve, reject) => {
      const form = new FormData();
      if (file) form.append('file', file);
      if (folderFiles) {
        for (const f of folderFiles) form.append('folderFiles', f);
      }
      form.append('versionDesc', description);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/projects/${projectId}/versions`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(
            new Error(extractMessage(xhr.responseText) || 'Upload failed')
          );
        }
      };

      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(form);
    }),

  activateVersion: async (
    projectId: string,
    versionId: string
  ): Promise<{ ok: boolean }> => {
    const res = await client.api.projects[':id'].versions[
      ':versionId'
    ].activate.$put({ param: { id: projectId, versionId } });
    await checkOk(res);
    return res.json();
  },

  deleteVersion: async (
    projectId: string,
    versionId: string
  ): Promise<{ ok: boolean }> => {
    const res = await client.api.projects[':id'].versions[':versionId'].$delete(
      { param: { id: projectId, versionId } }
    );
    await checkOk(res);
    return res.json();
  },
};
