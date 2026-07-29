import type { Data, HistoryPage } from '@deploykit/shared';

export interface HistoryPageRequest {
  /** null means every project; an empty array means no visible projects. */
  projectIds: string[] | null;
  limit?: string;
  cursor?: string;
}

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
   * Optional direct history query. Durable repositories implement this so the
   * service never loads an unbounded audit log; isolated test repositories may
   * fall back to the aggregate compatibility window.
   */
  listHistoryPage?(request: HistoryPageRequest): HistoryPage | undefined;
}
