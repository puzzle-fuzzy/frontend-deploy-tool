import { Buffer } from 'node:buffer';
import type {
  Data,
  HistoryAction,
  HistoryEvent,
  HistoryPage,
} from '@deploykit/shared';
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

/** Parses and clamps a history query limit. Invalid/nonpositive input defaults. */
export function parseHistoryLimit(limit?: string): number {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 200);
}

interface HistoryCursorPayload {
  version: 1;
  eventId: string;
}

export function encodeHistoryCursor(eventId: string): string {
  const payload: HistoryCursorPayload = { version: 1, eventId };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeHistoryCursor(cursor: string): string | undefined {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as unknown;
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      Object.keys(decoded).length !== 2 ||
      !('version' in decoded) ||
      decoded.version !== 1 ||
      !('eventId' in decoded) ||
      typeof decoded.eventId !== 'string' ||
      decoded.eventId.length === 0
    ) {
      return undefined;
    }
    return decoded.eventId;
  } catch {
    return undefined;
  }
}

/**
 * Returns a stable page from a newest-first, bounded event list.
 *
 * The cursor identifies the last event previously delivered instead of an
 * array offset, so newly prepended events cannot shift or duplicate the next
 * page. `undefined` means the cursor is malformed or has left the retention
 * window.
 */
export function paginateHistory(
  events: HistoryEvent[],
  limit?: string,
  cursor?: string
): HistoryPage | undefined {
  const pageSize = parseHistoryLimit(limit);
  let start = 0;

  if (cursor) {
    const eventId = decodeHistoryCursor(cursor);
    if (!eventId) return undefined;
    const cursorIndex = events.findIndex((event) => event.id === eventId);
    if (cursorIndex === -1) return undefined;
    start = cursorIndex + 1;
  }

  const items = events.slice(start, start + pageSize);
  const hasMore = start + items.length < events.length;
  const lastItem = items.at(-1);
  return {
    items,
    nextCursor: hasMore && lastItem ? encodeHistoryCursor(lastItem.id) : null,
  };
}

/** Prepends a history event to `data.history`, capping the log at 200 entries. */
export function appendHistoryEvent(
  data: Data,
  action: HistoryAction,
  project: HistoryEntity,
  actorId: string,
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
    actorId,
    ...(metadata && { metadata }),
  });
  if (data.history.length > 200) data.history.length = 200;
}
