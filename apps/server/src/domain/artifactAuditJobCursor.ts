import { Buffer } from 'node:buffer';
import type { ArtifactAuditJobStatus } from '@deploykit/shared';

const JOB_STATUSES = new Set<ArtifactAuditJobStatus>([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

export interface ArtifactAuditJobCursorPayload {
  version: 1;
  projectId: string;
  versionId: string;
  anchorJobId: string;
  status: ArtifactAuditJobStatus | null;
}

export function encodeArtifactAuditJobCursor(
  payload: Omit<ArtifactAuditJobCursorPayload, 'version'>
): string {
  return Buffer.from(JSON.stringify({ version: 1, ...payload })).toString(
    'base64url'
  );
}

export function decodeArtifactAuditJobCursor(
  cursor: string
): ArtifactAuditJobCursorPayload | null {
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) return null;
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Object.keys(parsed).sort().join(',') !==
        'anchorJobId,projectId,status,version,versionId' ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('projectId' in parsed) ||
      typeof parsed.projectId !== 'string' ||
      parsed.projectId.length === 0 ||
      !('versionId' in parsed) ||
      typeof parsed.versionId !== 'string' ||
      parsed.versionId.length === 0 ||
      !('anchorJobId' in parsed) ||
      typeof parsed.anchorJobId !== 'string' ||
      parsed.anchorJobId.length === 0 ||
      !('status' in parsed) ||
      !(
        parsed.status === null ||
        (typeof parsed.status === 'string' &&
          JOB_STATUSES.has(parsed.status as ArtifactAuditJobStatus))
      )
    ) {
      return null;
    }
    return parsed as ArtifactAuditJobCursorPayload;
  } catch {
    return null;
  }
}
