import type {
  CreateProjectInput,
  HistoryPage,
  Project,
  Role,
  SafeUser,
  Settings,
  User,
} from '@deploykit/shared';
import type { Actor } from '../domain/authorization';
import type { ReleaseCommand } from '../domain/version';

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
    /** Correlation id populated by Hono's request-id middleware. */
    requestId: string;
  };
};

export interface ProjectService {
  listProjects(actor: Actor): Project[];
  createProject(input: CreateProjectInput, actorId: string): Project;
  getProject(id: string): Project;
  getProjectForActor(id: string, actor: Actor): Project;
  findBySlug(slug: string): Project | undefined;
  updateProject(
    id: string,
    updates: { name?: string; slug?: string; description?: string },
    actorId: string
  ): Project;
  updateProjectSettings(
    id: string,
    settings: Settings,
    actorId: string
  ): Project;
  deleteProject(id: string, actorId: string): Project;
  addMember(
    projectId: string,
    email: string,
    role: 'owner' | 'member',
    actorId: string
  ): Project;
  removeMember(projectId: string, userId: string, actorId: string): Project;
  transferOwnership(
    projectId: string,
    targetUserId: string,
    actor: Actor
  ): Project;
  listHistory(actor: Actor, limit?: string, cursor?: string): HistoryPage;
  listProjectHistory(
    projectId: string,
    actor: Actor,
    limit?: string,
    cursor?: string
  ): HistoryPage;
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
  publishVersion(
    projectId: string,
    versionId: string,
    actorId: string,
    command: ReleaseCommand
  ): void;
  activateVersion(
    projectId: string,
    versionId: string,
    actorId: string,
    command: ReleaseCommand
  ): void;
  rollbackVersion(
    projectId: string,
    versionId: string,
    actorId: string,
    command: ReleaseCommand
  ): void;
  deleteVersion(projectId: string, versionId: string, actorId: string): void;
}

export interface UserService {
  findByEmail(email: string): User | undefined;
  getSafeUser(id: string): SafeUser | undefined;
  verifyCredentials(email: string, password: string): Promise<SafeUser | null>;
  /** Creates a user with the given role and returns the safe view. */
  createUser(input: {
    name: string;
    email: string;
    password: string;
    role: Role;
  }): SafeUser;
  /** Returns the plaintext password if a new admin was seeded, else null. */
  seedAdminIfMissing(email: string, password: string): string | null;
  /** Search users by email prefix (case-insensitive, max 10 results). */
  searchByEmail(query: string): SafeUser[];
}
