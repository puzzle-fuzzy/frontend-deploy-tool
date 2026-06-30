import type { Data, HistoryAction } from '@deploykit/shared';
import { createId } from '../utils/id';

interface HistoryEntity {
  id: string;
  name: string;
}

/** Prepends a history event to `data.history`, capping the log at 200 entries. */
export function appendHistoryEvent(
  data: Data,
  action: HistoryAction,
  project: HistoryEntity,
  version?: HistoryEntity
): void {
  data.history.unshift({
    id: createId(),
    action,
    projectId: project.id,
    projectName: project.name,
    versionId: version?.id ?? '',
    versionName: version?.name ?? '',
    timestamp: new Date().toISOString(),
  });
  if (data.history.length > 200) data.history.length = 200;
}
