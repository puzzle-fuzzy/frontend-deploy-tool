import type { ApiTokenScope, Data, HistoryPage } from '@deploykit/shared';

export interface HistoryPageRequest {
  /** null means every project; an empty array means no visible projects. */
  projectIds: string[] | null;
  limit?: string;
  cursor?: string;
}

export interface CommitVersionUploadInput {
  projectId: string;
  tokenId: string;
  requiredScope: ApiTokenScope;
  idempotencyKey: string;
  requestDigest: string;
  version: { id: string; name: string };
  committedAt: string;
  expiresAt: string;
}

export type CommitVersionUploadResult =
  | { outcome: 'created'; version: { id: string; name: string } }
  | { outcome: 'replayed'; version: { id: string; name: string } }
  | { outcome: 'conflict' }
  | {
      outcome: 'token-inactive';
      reason:
        | 'missing'
        | 'project_mismatch'
        | 'revoked'
        | 'expired'
        | 'scope_missing';
    };

/** Persistence interface for the project/version metadata store. */
export interface ProjectRepository {
  load(): Data;
  save(data: Data): void;
  /**
   * Reads the latest state, applies a synchronous domain change, and persists
   * it as one repository-owned atomic operation.
   *
   * Implementations must not persist callback changes when the callback
   * throws. Keeping the callback synchronous prevents transaction ownership
   * from leaking across awaited I/O.
   */
  mutate<T>(operation: (data: Data) => T): T;
  /**
   * Commits CI upload metadata and its idempotency snapshot together.
   *
   * Durable implementations must re-read token state inside the same write
   * transaction. The callback is synchronous so no revocation can interleave
   * with the metadata mutation in the JSON test adapter.
   */
  commitVersionUpload?(
    input: CommitVersionUploadInput,
    operation: (data: Data) => void
  ): CommitVersionUploadResult;
  /**
   * Optional direct history query. Durable repositories implement this so the
   * service never loads an unbounded audit log; isolated test repositories may
   * fall back to the aggregate compatibility window.
   */
  listHistoryPage?(request: HistoryPageRequest): HistoryPage | undefined;
}
