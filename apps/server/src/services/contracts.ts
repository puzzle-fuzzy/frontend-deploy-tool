import type {
  ApiTokenMetadata,
  ApiTokenScope,
  ApiTokenSecurityEvent,
  ArtifactAuditAssessment,
  ArtifactAuditJob,
  ArtifactAuditJobPage,
  ArtifactAuditPolicyUpdate,
  ArtifactAuditReport,
  CreateProjectInput,
  HistoryPage,
  Project,
  Role,
  SafeUser,
  Settings,
  User,
} from '@deploykit/shared';
import type { Actor } from '../domain/authorization';
import type {
  SessionIdentity,
  SessionInfo,
  SessionKind,
} from '../domain/session';
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
    /** Redacted automation identity populated only on the dedicated CI API. */
    apiToken: ApiTokenPrincipal | null;
    /** Validated CI idempotency key; never written to logs or history. */
    ciIdempotencyKey: string | null;
    /** Durable session id for the authenticated request. */
    sessionId: string | null;
    /** Correlation id populated by Hono's request-id middleware. */
    requestId: string;
  };
};

export interface SessionService {
  issue(userId: string, kind: SessionKind): string;
  authenticate(token: string): SessionIdentity | null;
  listForUser(userId: string, currentSessionId: string | null): SessionInfo[];
  revoke(sessionId: string, userId: string): boolean;
  revokeAll(userId: string): number;
  cleanupExpired(): number;
}

export interface CreateApiTokenInput {
  name: string;
  expiresAt?: string;
}

export interface RotateApiTokenInput {
  expiresAt?: string;
  overlapSeconds?: number;
}

export interface IssuedApiToken {
  token: ApiTokenMetadata;
  /** Complete credential, returned only by create/rotate. */
  plaintextToken: string;
}

export interface ApiTokenPrincipal {
  tokenId: string;
  projectId: string;
  prefix: string;
  scopes: ApiTokenScope[];
  actorId: string;
}

export interface ApiTokenService {
  list(projectId: string): ApiTokenMetadata[];
  create(
    projectId: string,
    input: CreateApiTokenInput,
    actorId: string
  ): IssuedApiToken;
  rotate(
    projectId: string,
    tokenId: string,
    input: RotateApiTokenInput,
    actorId: string
  ): IssuedApiToken;
  revoke(projectId: string, tokenId: string, actorId: string): ApiTokenMetadata;
  listSecurityEvents(
    projectId: string,
    limit?: number
  ): ApiTokenSecurityEvent[];
  authenticate(
    plaintextToken: string,
    projectId: string,
    requiredScope: ApiTokenScope
  ): ApiTokenPrincipal;
  /**
   * Re-reads current token state after long-running artifact processing.
   * Durable commits still repeat this check inside their SQLite transaction.
   */
  revalidatePrincipal(
    principal: ApiTokenPrincipal,
    projectId: string,
    requiredScope: ApiTokenScope
  ): void;
}

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
  updateProjectAuditPolicy(
    id: string,
    auditPolicy: ArtifactAuditPolicyUpdate,
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
  uploadCiVersion(
    projectId: string,
    input: UploadVersionInput,
    principal: ApiTokenPrincipal,
    idempotencyKey: string
  ): Promise<{
    version: { id: string; name: string };
    replayed: boolean;
  }>;
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

export interface ArtifactAuditService {
  runArtifactAudit(
    projectId: string,
    versionId: string,
    actorId: string
  ): ArtifactAuditReport;
  getArtifactAudit(projectId: string, versionId: string): ArtifactAuditReport;
  getArtifactAuditAssessment(
    projectId: string,
    versionId: string
  ): ArtifactAuditAssessment;
}

export interface ArtifactAuditJobApiService {
  enqueue(
    projectId: string,
    versionId: string,
    actorId: string
  ): { job: ArtifactAuditJob; reused: boolean };
  get(projectId: string, versionId: string, jobId: string): ArtifactAuditJob;
  list(
    projectId: string,
    versionId: string,
    query?: { limit?: string; cursor?: string; status?: string }
  ): ArtifactAuditJobPage;
  cancel(
    projectId: string,
    versionId: string,
    jobId: string,
    actorId: string
  ): ArtifactAuditJob;
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
