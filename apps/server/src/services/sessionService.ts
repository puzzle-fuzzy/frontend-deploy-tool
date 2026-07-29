import type {
  SessionIdentity,
  SessionInfo,
  SessionKind,
} from '../domain/session';
import {
  createSessionToken,
  SESSION_MAX_AGE_SECONDS,
  verifySessionToken,
} from '../middleware/session';
import type { SessionRepository } from '../repositories/sessionRepository';
import { createId } from '../utils/id';
import type { SessionService } from './contracts';

export interface SessionServiceOptions {
  repository: SessionRepository;
  secret: string;
  now?: () => number;
}

export function createSessionService({
  repository,
  secret,
  now = Date.now,
}: SessionServiceOptions): SessionService {
  const nowEpochSeconds = () => Math.floor(now() / 1000);
  const nowIso = () => new Date(now()).toISOString();

  return {
    issue(userId: string, kind: SessionKind): string {
      const id = createId();
      const expiresAt = nowEpochSeconds() + SESSION_MAX_AGE_SECONDS;
      repository.create({
        id,
        userId,
        kind,
        createdAt: nowIso(),
        expiresAt,
        revokedAt: null,
      });
      return createSessionToken(
        {
          sub: userId,
          jti: id,
          kind,
          exp: expiresAt,
        },
        secret
      );
    },

    authenticate(token: string): SessionIdentity | null {
      const payload = verifySessionToken(token, secret);
      if (!payload) return null;
      const session = repository.findActive(payload.jti, nowEpochSeconds());
      if (
        !session ||
        session.userId !== payload.sub ||
        session.kind !== payload.kind ||
        session.expiresAt !== payload.exp
      ) {
        return null;
      }
      return {
        id: session.id,
        userId: session.userId,
        kind: session.kind,
      };
    },

    listForUser(
      userId: string,
      currentSessionId: string | null
    ): SessionInfo[] {
      return repository.listForUser(userId).map((session) => ({
        ...session,
        current: session.id === currentSessionId,
      }));
    },

    revoke(sessionId: string, userId: string): boolean {
      return repository.revokeForUser(sessionId, userId, nowIso());
    },

    revokeAll(userId: string): number {
      return repository.revokeAllForUser(userId, nowIso());
    },

    cleanupExpired(): number {
      return repository.deleteExpired(nowEpochSeconds());
    },
  };
}
