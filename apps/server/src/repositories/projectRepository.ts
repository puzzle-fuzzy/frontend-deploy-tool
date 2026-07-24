import type { Data } from '@deploykit/shared';

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
}
