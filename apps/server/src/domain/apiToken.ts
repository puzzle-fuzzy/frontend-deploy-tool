import type {
  ApiTokenMetadata,
  ApiTokenScope,
  ApiTokenSecurityEvent,
  ApiTokenSecurityReason,
} from '@deploykit/shared';

export const API_TOKEN_HASH_VERSION = 1;

/** Persistence-only token record. `secretDigest` is never API-visible. */
export interface ApiTokenRecord extends ApiTokenMetadata {
  hashVersion: number;
  secretDigest: string;
}

export interface CreateApiTokenRecordInput {
  token: ApiTokenRecord;
  projectName: string;
}

export interface RotateApiTokenRecordInput {
  currentTokenId: string;
  replacement: ApiTokenRecord;
  projectName: string;
  actorId: string;
  rotatedAt: string;
  previousExpiresAt: string;
  revokePrevious: boolean;
}

export interface RecordApiTokenAuthenticationFailureInput {
  token: Pick<ApiTokenRecord, 'id' | 'projectId' | 'prefix'>;
  projectName: string;
  reason: ApiTokenSecurityReason;
  occurredAt: string;
}

export interface ApiTokenLookup {
  id: string;
  projectId: string;
  hashVersion: number;
  secretDigest: string;
  scopes: ApiTokenScope[];
  expiresAt: string;
  revokedAt: string | null;
  prefix: string;
}

export type { ApiTokenMetadata, ApiTokenScope, ApiTokenSecurityEvent };
