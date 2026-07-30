import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ArtifactAuditJobStatus } from '@deploykit/shared';

const CURSOR_VERSION = 1;
const SIGNATURE_BYTES = 32;
const SIGNING_KEY_PURPOSE = 'deploykit:artifact-audit-job-cursor:v1';
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

export interface ArtifactAuditJobCursorCodec {
  encode(payload: Omit<ArtifactAuditJobCursorPayload, 'version'>): string;
  decode(cursor: string): ArtifactAuditJobCursorPayload | null;
}

export function createArtifactAuditJobCursorCodec(
  sessionSecret: string
): ArtifactAuditJobCursorCodec {
  if (sessionSecret.length === 0) {
    throw new Error('Artifact audit job cursor secret must not be empty');
  }
  const signingKey = createHmac('sha256', sessionSecret)
    .update(SIGNING_KEY_PURPOSE)
    .digest();

  return {
    encode(input) {
      const payload = canonicalPayload(input);
      const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
      return `${payloadBytes.toString('base64url')}.${sign(
        payloadBytes,
        signingKey
      ).toString('base64url')}`;
    },
    decode(cursor) {
      try {
        const parts = cursor.split('.');
        if (parts.length !== 2) return null;
        const [encodedPayload, encodedSignature] = parts;
        if (!encodedPayload || !encodedSignature) return null;
        const payloadBytes = decodeCanonicalBase64Url(encodedPayload);
        const signature = decodeCanonicalBase64Url(encodedSignature);
        if (!payloadBytes || !signature) return null;
        if (signature.length !== SIGNATURE_BYTES) return null;
        const expectedSignature = sign(payloadBytes, signingKey);
        if (!timingSafeEqual(signature, expectedSignature)) return null;

        const parsed = parsePayload(payloadBytes);
        if (!parsed) return null;
        const canonicalBytes = Buffer.from(JSON.stringify(parsed), 'utf8');
        if (!payloadBytes.equals(canonicalBytes)) return null;
        return parsed;
      } catch {
        return null;
      }
    },
  };
}

function canonicalPayload(
  payload: Omit<ArtifactAuditJobCursorPayload, 'version'>
): ArtifactAuditJobCursorPayload {
  return {
    version: CURSOR_VERSION,
    projectId: payload.projectId,
    versionId: payload.versionId,
    anchorJobId: payload.anchorJobId,
    status: payload.status,
  };
}

function parsePayload(bytes: Buffer): ArtifactAuditJobCursorPayload | null {
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Object.keys(parsed).sort().join(',') !==
      'anchorJobId,projectId,status,version,versionId' ||
    !('version' in parsed) ||
    parsed.version !== CURSOR_VERSION ||
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
  return canonicalPayload({
    projectId: parsed.projectId,
    versionId: parsed.versionId,
    anchorJobId: parsed.anchorJobId,
    status: parsed.status as ArtifactAuditJobStatus | null,
  });
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

function sign(payload: Buffer, signingKey: Buffer): Buffer {
  return createHmac('sha256', signingKey).update(payload).digest();
}
