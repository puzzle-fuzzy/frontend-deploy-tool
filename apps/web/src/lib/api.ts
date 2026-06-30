import type { Project, Settings } from '../types';

const BASE = '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || res.statusText);
  }
  return res.json();
}

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),

  createProject: (data: { name: string; slug: string; description: string }) =>
    request<Project>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  updateSettings: (id: string, settings: Settings) =>
    request<Project>(`/api/projects/${id}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }),

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
      xhr.open('POST', `${BASE}/api/projects/${projectId}/versions`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error(xhr.responseText || 'Upload failed'));
        }
      };

      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(form);
    }),

  activateVersion: (projectId: string, versionId: string) =>
    request<{ ok: boolean }>(
      `/api/projects/${projectId}/versions/${versionId}/activate`,
      { method: 'PUT' }
    ),

  deleteVersion: (projectId: string, versionId: string) =>
    request<{ ok: boolean }>(
      `/api/projects/${projectId}/versions/${versionId}`,
      { method: 'DELETE' }
    ),
};
