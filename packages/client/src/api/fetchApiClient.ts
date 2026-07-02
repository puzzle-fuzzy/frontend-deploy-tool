import type { ApiApp } from '@deploykit/server/api';
import type { Project, SafeUser, Settings } from '@deploykit/shared';
import { hc } from 'hono/client';
import type { ApiClient, UploadableFile, UploadProgress } from './ApiClient';
import { checkOk, extractMessage } from './errors';

// Same-origin API; the Vite dev server proxies `/api` to the backend in dev.
const client = hc<ApiApp>('');

export function createFetchApiClient(): ApiClient {
  return {
    async getMe(): Promise<SafeUser | null> {
      const res = await client.api.me.$get();
      if (res.status === 401) return null;
      await checkOk(res);
      return (await res.json()) as SafeUser;
    },

    async login(email: string, password: string): Promise<SafeUser> {
      const res = await client.api.auth.login.$post({
        json: { email, password },
      });
      await checkOk(res);
      const body = (await res.json()) as { user: SafeUser };
      return body.user;
    },

    async logout(): Promise<void> {
      const res = await client.api.auth.logout.$post();
      await checkOk(res);
    },

    async listProjects(): Promise<Project[]> {
      const res = await client.api.projects.$get();
      await checkOk(res);
      return (await res.json()) as Project[];
    },

    async createProject(input: {
      name: string;
      slug: string;
      description: string;
    }): Promise<Project> {
      const res = await client.api.projects.$post({ json: input });
      await checkOk(res);
      return (await res.json()) as Project;
    },

    async updateProject(
      id: string,
      updates: { name?: string; slug?: string; description?: string }
    ): Promise<Project> {
      const res = await client.api.projects[':id'].$patch({
        param: { id },
        json: updates,
      });
      await checkOk(res);
      return (await res.json()) as Project;
    },

    async deleteProject(id: string): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].$delete({ param: { id } });
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async updateSettings(id: string, settings: Settings): Promise<Project> {
      const res = await client.api.projects[':id'].settings.$patch({
        param: { id },
        json: settings,
      });
      await checkOk(res);
      return (await res.json()) as Project;
    },

    uploadVersion(
      projectId: string,
      file: UploadableFile | null,
      folderFiles: UploadableFile[] | null,
      description: string,
      onProgress?: UploadProgress
    ): Promise<{ version: { id: string; name: string } }> {
      return new Promise((resolve, reject) => {
        const form = new FormData();
        if (file) form.append('file', file as File);
        if (folderFiles) {
          for (const f of folderFiles) {
            form.append(
              'folderFiles',
              f as File,
              f.webkitRelativePath || f.name
            );
          }
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
      });
    },

    async publishVersion(
      projectId: string,
      versionId: string
    ): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].versions[
        ':versionId'
      ].publish.$post({ param: { id: projectId, versionId } });
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async rollbackVersion(
      projectId: string,
      versionId: string
    ): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].versions[
        ':versionId'
      ].rollback.$post({ param: { id: projectId, versionId } });
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async deleteVersion(
      projectId: string,
      versionId: string
    ): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].versions[
        ':versionId'
      ].$delete({
        param: { id: projectId, versionId },
      });
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },
  };
}
