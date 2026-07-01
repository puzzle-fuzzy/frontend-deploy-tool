import type { Data, HistoryAction } from '@deploykit/shared';
import { createId } from '../utils/id';

interface HistoryEntity {
  id: string;
  name: string;
}

/**
 * Structured, action-specific payload attached to a history event for future
 * filtering/analytics. Callers pass only the keys relevant to the action.
 */
export type HistoryMetadata = Record<string, unknown>;

/** Prepends a history event to `data.history`, capping the log at 200 entries. */
export function appendHistoryEvent(
  data: Data,
  action: HistoryAction,
  project: HistoryEntity,
  version?: HistoryEntity,
  metadata?: HistoryMetadata
): void {
  data.history.unshift({
    id: createId(),
    action,
    projectId: project.id,
    projectName: project.name,
    versionId: version?.id ?? '',
    versionName: version?.name ?? '',
    timestamp: new Date().toISOString(),
    ...(metadata && { metadata }),
  });
  if (data.history.length > 200) data.history.length = 200;
}
