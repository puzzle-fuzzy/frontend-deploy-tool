import type {
  CreateProjectInput,
  HistoryEvent,
  Project,
  SafeUser,
  Settings,
  User,
} from '@deploykit/shared';

/**
 * Service contracts (interfaces only). This module is deliberately Bun-free so
 * it can be pulled into the frontend's type graph (via `src/api.ts`) without
 * requiring `bun-types`. Keep it free of any runtime/Bun import.
 */

/**
 * Hono environment shared by the API app and its routes. `user` is populated by
 * the session middleware (`null` when unauthenticated).
 */
export type AppEnv = {
  Variables: {
    user: SafeUser | null;
  };
};

export interface ProjectService {
  listProjects(): Project[];
  createProject(input: CreateProjectInput, actorId: string): Project;
  getProject(id: string): Project;
  findBySlug(slug: string): Project | undefined;
  updateProject(
    id: string,
    updates: { name?: string; slug?: string; description?: string }
  ): Project;
  updateProjectSettings(id: string, settings: Settings): Project;
  deleteProject(id: string, actorId: string): Project;
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
    input: UploadVersionInput,
    actorId: string
  ): Promise<{ version: { id: string; name: string } }>;
  activateVersion(projectId: string, versionId: string, actorId: string): void;
  deleteVersion(projectId: string, versionId: string, actorId: string): void;
}

export interface UserService {
  findByEmail(email: string): User | undefined;
  getSafeUser(id: string): SafeUser | undefined;
  verifyCredentials(email: string, password: string): Promise<SafeUser | null>;
  /** Returns the plaintext password if a new admin was seeded, else null. */
  seedAdminIfMissing(email: string, password: string): string | null;
}
