import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  ApiTokenMetadata,
  ApiTokenScope,
  ApiTokenSecurityEvent,
} from '@deploykit/shared';
import {
  API_TOKEN_HASH_VERSION,
  type ApiTokenRecord,
} from '../domain/apiToken';
import { ApiError, ErrorCode } from '../errors';
import type { ApiTokenRepository } from '../repositories/apiTokenRepository';
import { createId } from '../utils/id';
import type {
  ApiTokenPrincipal,
  ApiTokenService,
  CreateApiTokenInput,
  IssuedApiToken,
  ProjectService,
  RotateApiTokenInput,
} from './contracts';

const TOKEN_VERSION = 'dpk_v1';
const TOKEN_HASH_DOMAIN = 'deploykit:project-api-token:v1\0';
const TOKEN_SECRET_BYTES = 32;
const DEFAULT_EXPIRY_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1_000;
const DEFAULT_ROTATION_OVERLAP_SECONDS = 15 * 60;
const MAX_ROTATION_OVERLAP_SECONDS = 24 * 60 * 60;
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1_000;
const FAILURE_EVENT_WRITE_INTERVAL_MS = 60 * 1_000;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface ApiTokenServiceOptions {
  repository: ApiTokenRepository;
  projectService: Pick<ProjectService, 'getProject'>;
  now?: () => number;
  createTokenId?: () => string;
  generateSecret?: () => string;
}

export function createApiTokenService({
  repository,
  projectService,
  now = Date.now,
  createTokenId = createId,
  generateSecret = () => randomBytes(TOKEN_SECRET_BYTES).toString('base64url'),
}: ApiTokenServiceOptions): ApiTokenService {
  const lastFailureEventAt = new Map<string, number>();
  const getProjectName = (projectId: string): string =>
    projectService.getProject(projectId).name;

  const createRecord = (
    projectId: string,
    name: string,
    expiresAt: string,
    actorId: string,
    createdAt: number
  ): { record: ApiTokenRecord; plaintextToken: string } => {
    const id = createUniqueTokenId(repository, createTokenId);
    const secret = generateSecret();
    if (!isCanonicalSecret(secret)) {
      throw new Error('API token generator returned an invalid secret');
    }
    const plaintextToken = `${TOKEN_VERSION}.${id}.${secret}`;
    const timestamp = new Date(createdAt).toISOString();
    return {
      plaintextToken,
      record: {
        id,
        projectId,
        name,
        hashVersion: API_TOKEN_HASH_VERSION,
        secretDigest: digestToken(plaintextToken).toString('hex'),
        prefix: `${TOKEN_VERSION}.${id}`,
        scopes: ['preview:upload'],
        createdAt: timestamp,
        createdBy: actorId,
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        replacedByTokenId: null,
      },
    };
  };
  const recordAuthenticationFailure = (
    token: { id: string; projectId: string; prefix: string },
    projectName: string,
    reason:
      | 'digest_mismatch'
      | 'expired'
      | 'revoked'
      | 'project_mismatch'
      | 'scope_missing',
    occurredAt: number
  ): void => {
    const key = `${token.id}\0${reason}`;
    const lastRecordedAt = lastFailureEventAt.get(key);
    if (
      lastRecordedAt !== undefined &&
      occurredAt - lastRecordedAt < FAILURE_EVENT_WRITE_INTERVAL_MS
    ) {
      return;
    }
    repository.recordAuthenticationFailure({
      token,
      projectName,
      reason,
      occurredAt: new Date(occurredAt).toISOString(),
    });
    lastFailureEventAt.set(key, occurredAt);
  };

  return {
    list(projectId: string): ApiTokenMetadata[] {
      getProjectName(projectId);
      return repository.list(projectId);
    },

    create(
      projectId: string,
      input: CreateApiTokenInput,
      actorId: string
    ): IssuedApiToken {
      const projectName = getProjectName(projectId);
      const name = normalizeTokenName(input.name);
      const createdAt = now();
      const expiresAt = resolveExpiry(input.expiresAt, createdAt);
      const issued = createRecord(
        projectId,
        name,
        expiresAt,
        actorId,
        createdAt
      );
      const token = repository.create({
        token: issued.record,
        projectName,
      });
      return { token, plaintextToken: issued.plaintextToken };
    },

    rotate(
      projectId: string,
      tokenId: string,
      input: RotateApiTokenInput,
      actorId: string
    ): IssuedApiToken {
      const projectName = getProjectName(projectId);
      const current = repository
        .list(projectId)
        .find((token) => token.id === tokenId);
      if (
        !current ||
        current.revokedAt !== null ||
        current.replacedByTokenId !== null
      ) {
        throw tokenNotFound();
      }
      const overlapSeconds = resolveOverlapSeconds(input.overlapSeconds);
      const timestamp = now();
      const expiresAt = resolveExpiry(input.expiresAt, timestamp);
      const issued = createRecord(
        projectId,
        current.name,
        expiresAt,
        actorId,
        timestamp
      );
      issued.record.scopes = [...current.scopes];
      const currentExpiry = Date.parse(current.expiresAt);
      const overlapExpiry = timestamp + overlapSeconds * 1_000;
      const previousExpiresAt = new Date(
        Number.isFinite(currentExpiry)
          ? Math.min(currentExpiry, overlapExpiry)
          : overlapExpiry
      ).toISOString();
      const token = repository.rotate({
        currentTokenId: current.id,
        replacement: issued.record,
        projectName,
        actorId,
        rotatedAt: new Date(timestamp).toISOString(),
        previousExpiresAt,
        revokePrevious: overlapSeconds === 0,
      });
      if (!token) throw tokenNotFound();
      return { token, plaintextToken: issued.plaintextToken };
    },

    revoke(
      projectId: string,
      tokenId: string,
      actorId: string
    ): ApiTokenMetadata {
      const projectName = getProjectName(projectId);
      const token = repository.revoke({
        projectId,
        projectName,
        tokenId,
        actorId,
        revokedAt: nowIso(now),
      });
      if (!token) throw tokenNotFound();
      return token;
    },

    listSecurityEvents(
      projectId: string,
      limit?: number
    ): ApiTokenSecurityEvent[] {
      getProjectName(projectId);
      return repository.listSecurityEvents(projectId, limit);
    },

    authenticate(
      plaintextToken: string,
      projectId: string,
      requiredScope: ApiTokenScope
    ): ApiTokenPrincipal {
      const parsed = parsePlaintextToken(plaintextToken);
      if (!parsed) throw invalidToken();
      const token = repository.findById(parsed.id);
      if (!token) throw invalidToken();

      let projectName: string;
      try {
        projectName = getProjectName(token.projectId);
      } catch {
        throw invalidToken();
      }
      const authenticatedAt = now();
      if (!matchesDigest(plaintextToken, token.secretDigest)) {
        recordAuthenticationFailure(
          token,
          projectName,
          'digest_mismatch',
          authenticatedAt
        );
        throw invalidToken();
      }
      if (token.projectId !== projectId) {
        recordAuthenticationFailure(
          token,
          projectName,
          'project_mismatch',
          authenticatedAt
        );
        throw invalidToken();
      }
      if (token.revokedAt !== null) {
        recordAuthenticationFailure(
          token,
          projectName,
          'revoked',
          authenticatedAt
        );
        throw new ApiError(
          ErrorCode.API_TOKEN_REVOKED,
          'API token is revoked',
          401
        );
      }
      const expiresAt = Date.parse(token.expiresAt);
      if (!Number.isFinite(expiresAt)) throw invalidToken();
      if (expiresAt <= authenticatedAt) {
        recordAuthenticationFailure(
          token,
          projectName,
          'expired',
          authenticatedAt
        );
        throw new ApiError(
          ErrorCode.API_TOKEN_EXPIRED,
          'API token is expired',
          401
        );
      }
      if (!token.scopes.includes(requiredScope)) {
        recordAuthenticationFailure(
          token,
          projectName,
          'scope_missing',
          authenticatedAt
        );
        throw new ApiError(
          ErrorCode.API_TOKEN_SCOPE_REQUIRED,
          'API token scope is required',
          403
        );
      }

      repository.touchLastUsed({
        tokenId: token.id,
        usedAt: new Date(authenticatedAt).toISOString(),
        onlyIfBefore: new Date(
          authenticatedAt - LAST_USED_WRITE_INTERVAL_MS
        ).toISOString(),
      });
      return {
        tokenId: token.id,
        projectId: token.projectId,
        prefix: token.prefix,
        scopes: [...token.scopes],
        actorId: `api-token:${token.id}`,
      };
    },
  };
}

function normalizeTokenName(value: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  const hasControlCharacter = [...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
  if (!name || name.length > 100 || hasControlCharacter) {
    throw new ApiError(
      ErrorCode.INVALID_REQUEST,
      'API token name must be between 1 and 100 characters',
      400
    );
  }
  return name;
}

function resolveExpiry(value: string | undefined, timestamp: number): string {
  const expiresAt =
    value === undefined ? timestamp + DEFAULT_EXPIRY_MS : Date.parse(value);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= timestamp ||
    expiresAt > timestamp + MAX_EXPIRY_MS
  ) {
    throw new ApiError(
      ErrorCode.INVALID_REQUEST,
      'API token expiry must be in the future and no more than one year away',
      400
    );
  }
  return new Date(expiresAt).toISOString();
}

function resolveOverlapSeconds(value: number | undefined): number {
  const overlap = value ?? DEFAULT_ROTATION_OVERLAP_SECONDS;
  if (
    !Number.isInteger(overlap) ||
    overlap < 0 ||
    overlap > MAX_ROTATION_OVERLAP_SECONDS
  ) {
    throw new ApiError(
      ErrorCode.INVALID_REQUEST,
      'Rotation overlap must be between 0 and 86400 seconds',
      400
    );
  }
  return overlap;
}

function createUniqueTokenId(
  repository: ApiTokenRepository,
  createTokenId: () => string
): string {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = createTokenId();
    if (TOKEN_ID_PATTERN.test(id) && !repository.findById(id)) return id;
  }
  throw new Error('Unable to allocate a unique API token id');
}

function parsePlaintextToken(value: string): { id: string } | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [version, id, secret] = parts;
  if (
    version !== TOKEN_VERSION ||
    !TOKEN_ID_PATTERN.test(id) ||
    !isCanonicalSecret(secret)
  ) {
    return null;
  }
  return { id };
}

function isCanonicalSecret(value: string): boolean {
  if (!TOKEN_SECRET_PATTERN.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return (
      decoded.length === TOKEN_SECRET_BYTES &&
      decoded.toString('base64url') === value
    );
  } catch {
    return false;
  }
}

function digestToken(value: string): Buffer {
  return createHash('sha256')
    .update(TOKEN_HASH_DOMAIN, 'utf8')
    .update(value, 'utf8')
    .digest();
}

function matchesDigest(value: string, storedHexDigest: string): boolean {
  const expected = Buffer.from(storedHexDigest, 'hex');
  const actual = digestToken(value);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function invalidToken(): ApiError {
  return new ApiError(ErrorCode.API_TOKEN_INVALID, 'Invalid API token', 401);
}

function tokenNotFound(): ApiError {
  return new ApiError(
    ErrorCode.API_TOKEN_NOT_FOUND,
    'API token not found',
    404
  );
}
