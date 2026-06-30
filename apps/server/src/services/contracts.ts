import type { HistoryEvent, Project, Settings } from '@deploykit/shared';

/**
 * Service contracts (interfaces only). This module is deliberately Bun-free so
 * it can be pulled into the frontend's type graph (via `src/api.ts`) without
 * requiring `bun-types`. Keep it free of any runtime/Bun import.
 */

export interface ProjectService {
  listProjects(): Project[];
  createProject(body: unknown): Project;
  getProject(id: string): Project;
  findBySlug(slug: string): Project | undefined;
  updateProjectSettings(id: string, settings: Settings): Project;
  deleteProject(id: string): Project;
  listHistory(limit?: string): HistoryEvent[];
}

export interface UploadVersionInput {
  versionDesc: string;
  file: File | null;
  folderFiles: File[];
}

export interface VersionService {
  uploadVersion(
    projectId: string,
    input: UploadVersionInput
  ): Promise<{ version: { id: string; name: string } }>;
  activateVersion(projectId: string, versionId: string): void;
  deleteVersion(projectId: string, versionId: string): void;
}
