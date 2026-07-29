export type SessionKind = 'browser' | 'desktop';

export interface SessionRecord {
  id: string;
  userId: string;
  kind: SessionKind;
  createdAt: string;
  /** Unix timestamp in seconds. */
  expiresAt: number;
  revokedAt: string | null;
}

export interface SessionIdentity {
  id: string;
  userId: string;
  kind: SessionKind;
}

export interface SessionInfo extends SessionRecord {
  current: boolean;
}
