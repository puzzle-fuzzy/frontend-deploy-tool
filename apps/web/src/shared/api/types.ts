import type { Project, SafeUser, Settings } from '@deploykit/shared';

export interface UploadableFile {
  name: string;
  size: number;
  type: string;
  webkitRelativePath?: string;
}

export type UploadProgress = (percent: number) => void;

export interface ApiClient {
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
  searchUsers(query: string): Promise<SafeUser[]>;
  addMember(
    projectId: string,
    email: string,
    role: 'owner' | 'member'
  ): Promise<{ project: Project }>;
  removeMember(projectId: string, userId: string): Promise<{ ok: boolean }>;
  transferOwnership(
    projectId: string,
    targetUserId: string
  ): Promise<{ project: Project }>;
}
