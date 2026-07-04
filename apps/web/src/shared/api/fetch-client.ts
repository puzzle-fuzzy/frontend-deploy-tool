import type { ApiApp } from '@deploykit/server/api';
import type { Project, SafeUser, Settings } from '@deploykit/shared';
import { hc } from 'hono/client';
import { checkOk, extractMessage } from './errors';
import type { ApiClient, UploadableFile, UploadProgress } from './types';

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

    async register(input: {
      name: string;
      email: string;
      password: string;
    }): Promise<SafeUser> {
      const res = await client.api.auth.register.$post({ json: input });
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
          for (const folderFile of folderFiles) {
            form.append(
              'folderFiles',
              folderFile as File,
              folderFile.webkitRelativePath || folderFile.name
            );
          }
        }
        form.append('versionDesc', description);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/projects/${projectId}/versions`);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && onProgress) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
            return;
          }
          reject(
            new Error(extractMessage(xhr.responseText) || 'Upload failed')
          );
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

    async searchUsers(query: string): Promise<SafeUser[]> {
      const res = await client.api.users.search.$get({ query: { q: query } });
      await checkOk(res);
      return (await res.json()) as SafeUser[];
    },

    async addMember(
      projectId: string,
      email: string,
      role: 'owner' | 'member'
    ): Promise<{ project: Project }> {
      const res = await client.api.projects[':id'].members.$post({
        param: { id: projectId },
        json: { email, role },
      });
      await checkOk(res);
      return (await res.json()) as { project: Project };
    },

    async removeMember(
      projectId: string,
      userId: string
    ): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].members[':userId'].$delete({
        param: { id: projectId, userId },
      });
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async transferOwnership(
      projectId: string,
      targetUserId: string
    ): Promise<{ project: Project }> {
      const res = await client.api.projects[':id'].transfer.$post({
        param: { id: projectId },
        json: { targetUserId },
      });
      await checkOk(res);
      return (await res.json()) as { project: Project };
    },
  };
}
