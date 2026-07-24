import type {
  HistoryPage,
  HistoryPageQuery,
  Project,
  SafeUser,
  Settings,
} from '@deploykit/shared';

/**
 * A file that can be uploaded. A real browser `File` satisfies this; Electron
 * drag-drop Files additionally carry a non-standard `path` (absolute on-disk
 * path), and native-picked files set `path` + `webkitRelativePath` so the
 * main process can read bytes from disk instead of crossing IPC.
 */
export interface UploadableFile {
  name: string;
  size: number;
  type: string;
  webkitRelativePath?: string;
  path?: string;
}

export type UploadProgress = (percent: number) => void;

/**
 * Transport-agnostic server API. Mirrors the method set of the legacy web
 * `api` singleton 1:1 (same names, same return shapes). Web implements it with
 * `hono/client` + XHR; desktop implements it over IPC to the Electron main
 * process. Components consume it via `useApiClient()`.
 */
export interface ApiClient {
  /** Returns null on 401 (not authenticated). */
  getMe(): Promise<SafeUser | null>;
  login(email: string, password: string): Promise<SafeUser>;
  register(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<SafeUser>;
  logout(): Promise<void>;
  listProjects(): Promise<Project[]>;
  createProject(input: {
    name: string;
    slug: string;
    description: string;
  }): Promise<Project>;
  updateProject(
    id: string,
    updates: { name?: string; slug?: string; description?: string }
  ): Promise<Project>;
  deleteProject(id: string): Promise<{ ok: boolean }>;
  updateSettings(id: string, settings: Settings): Promise<Project>;
  uploadVersion(
    projectId: string,
    file: UploadableFile | null,
    folderFiles: UploadableFile[] | null,
    description: string,
    onProgress?: UploadProgress
  ): Promise<{ version: { id: string; name: string } }>;
  publishVersion(
    projectId: string,
    versionId: string
  ): Promise<{ ok: boolean }>;
  rollbackVersion(
    projectId: string,
    versionId: string
  ): Promise<{ ok: boolean }>;
  deleteVersion(projectId: string, versionId: string): Promise<{ ok: boolean }>;
  listProjectHistory(
    projectId: string,
    query?: HistoryPageQuery
  ): Promise<HistoryPage>;
  searchUsers(query: string): Promise<SafeUser[]>;
  addMember(
    projectId: string,
    email: string,
    role: string
  ): Promise<{ project: Project }>;
  removeMember(projectId: string, userId: string): Promise<{ ok: boolean }>;
  transferOwnership(
    projectId: string,
    targetUserId: string
  ): Promise<{ project: Project }>;
}
