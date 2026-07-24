import type { ApiApp } from '@deploykit/server/api';
import type {
  HistoryEvent,
  Project,
  SafeUser,
  Settings,
} from '@deploykit/shared';
import { hc } from 'hono/client';
import type { ApiClient, UploadableFile, UploadProgress } from './ApiClient';
import { checkOk, createApiClientError } from './errors';

// Same-origin API; the Vite dev server proxies `/api` to the backend in dev.
const client = hc<ApiApp>('');
const STORAGE_KEY = 'deploykit.auth.token';

let authToken: string | null = null;

function readStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

function persistAuthToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) {
    window.localStorage.setItem(STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

function setAuthToken(token: string | null): void {
  authToken = token;
  persistAuthToken(token);
}

function hydrateAuthToken(): void {
  if (authToken) return;
  authToken = readStoredToken();
}

function getAuthHeaders(): Record<string, string> | undefined {
  const token = authToken ?? readStoredToken();
  if (!token) return undefined;
  authToken = token;
  return { Authorization: `Bearer ${token}` };
}

hydrateAuthToken();

export function createFetchApiClient(): ApiClient {
  return {
    async getMe(): Promise<SafeUser | null> {
      const res = await client.api.me.$get(undefined, {
        headers: getAuthHeaders(),
      });
      if (res.status === 401) {
        setAuthToken(null);
        return null;
      }
      await checkOk(res);
      return (await res.json()) as SafeUser;
    },

    async login(email: string, password: string): Promise<SafeUser> {
      const res = await client.api.auth.login.$post({
        json: { email, password },
      });
      await checkOk(res);
      const body = (await res.json()) as { user: SafeUser; token?: string };
      if (body.token) {
        setAuthToken(body.token);
      }
      return body.user;
    },

    async logout(): Promise<void> {
      const res = await client.api.auth.logout.$post(undefined, {
        headers: getAuthHeaders(),
      });
      await checkOk(res);
      setAuthToken(null);
    },

    async register(input: {
      name: string;
      email: string;
      password: string;
    }): Promise<SafeUser> {
      const res = await client.api.auth.register.$post({ json: input });
      await checkOk(res);
      const body = (await res.json()) as { user: SafeUser; token?: string };
      if (body.token) {
        setAuthToken(body.token);
      }
      return body.user;
    },

    async listProjects(): Promise<Project[]> {
      const res = await client.api.projects.$get(undefined, {
        headers: getAuthHeaders(),
      });
      await checkOk(res);
      return (await res.json()) as Project[];
    },

    async createProject(input: {
      name: string;
      slug: string;
      description: string;
    }): Promise<Project> {
      const res = await client.api.projects.$post(
        { json: input },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as Project;
    },

    async updateProject(
      id: string,
      updates: { name?: string; slug?: string; description?: string }
    ): Promise<Project> {
      const res = await client.api.projects[':id'].$patch(
        { param: { id }, json: updates },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as Project;
    },

    async deleteProject(id: string): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].$delete(
        { param: { id } },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async updateSettings(id: string, settings: Settings): Promise<Project> {
      const res = await client.api.projects[':id'].settings.$patch(
        { param: { id }, json: settings },
        { headers: getAuthHeaders() }
      );
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
        const token = authToken ?? readStoredToken();
        if (token) {
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }
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
              createApiClientError(
                xhr.status,
                xhr.responseText,
                xhr.statusText || 'Upload failed',
                xhr.getResponseHeader('X-Request-Id')
              )
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
      ].publish.$post(
        { param: { id: projectId, versionId } },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async rollbackVersion(
      projectId: string,
      versionId: string
    ): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].versions[
        ':versionId'
      ].rollback.$post(
        { param: { id: projectId, versionId } },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async deleteVersion(
      projectId: string,
      versionId: string
    ): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].versions[
        ':versionId'
      ].$delete(
        { param: { id: projectId, versionId } },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async listProjectHistory(
      projectId: string,
      limit = 50
    ): Promise<HistoryEvent[]> {
      const res = await client.api.projects[':id'].history.$get(
        {
          param: { id: projectId },
          query: { limit: String(limit) },
        },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as HistoryEvent[];
    },

    async searchUsers(query: string): Promise<SafeUser[]> {
      const res = await client.api.users.search.$get(
        { query: { q: query } },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as SafeUser[];
    },

    async addMember(
      projectId: string,
      email: string,
      role: string
    ): Promise<{ project: Project }> {
      const res = await client.api.projects[':id'].members.$post(
        {
          param: { id: projectId },
          json: { email, role: role as 'member' | 'owner' },
        },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as { project: Project };
    },

    async removeMember(
      projectId: string,
      userId: string
    ): Promise<{ ok: boolean }> {
      const res = await client.api.projects[':id'].members[':userId'].$delete(
        { param: { id: projectId, userId } },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as { ok: boolean };
    },

    async transferOwnership(
      projectId: string,
      targetUserId: string
    ): Promise<{ project: Project }> {
      const res = await client.api.projects[':id'].transfer.$post(
        { param: { id: projectId }, json: { targetUserId } },
        { headers: getAuthHeaders() }
      );
      await checkOk(res);
      return (await res.json()) as { project: Project };
    },
  };
}
