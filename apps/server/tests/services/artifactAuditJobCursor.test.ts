import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createArtifactAuditJobCursorCodec } from '../../src/domain/artifactAuditJobCursor';

const PAYLOAD = {
  projectId: 'project-1',
  versionId: 'version-1',
  anchorJobId: 'job-1',
  status: 'failed' as const,
};

test('round-trips one canonical authenticated audit-job cursor', () => {
  const codec = createArtifactAuditJobCursorCodec('cursor-test-secret');
  const cursor = codec.encode(PAYLOAD);
  const [encodedPayload, encodedSignature, extra] = cursor.split('.');

  expect(encodedPayload).toBeString();
  expect(encodedSignature).toBeString();
  expect(extra).toBeUndefined();
  expect(Buffer.from(encodedSignature ?? '', 'base64url')).toHaveLength(32);
  expect(codec.decode(cursor)).toEqual({ version: 1, ...PAYLOAD });
  expect(codec.encode(PAYLOAD)).toBe(cursor);
});

test('rejects payload, scope, status, signature, and secret tampering', () => {
  const codec = createArtifactAuditJobCursorCodec('cursor-test-secret');
  const cursor = codec.encode(PAYLOAD);

  for (const rewrite of [
    (payload: Record<string, unknown>) => ({
      ...payload,
      anchorJobId: 'job-2',
    }),
    (payload: Record<string, unknown>) => ({
      ...payload,
      projectId: 'project-2',
    }),
    (payload: Record<string, unknown>) => ({
      ...payload,
      versionId: 'version-2',
    }),
    (payload: Record<string, unknown>) => ({
      ...payload,
      status: 'canceled',
    }),
    (payload: Record<string, unknown>) => ({
      ...payload,
      unexpected: true,
    }),
  ]) {
    expect(codec.decode(rewriteCursorPayload(cursor, rewrite))).toBeNull();
  }
  expect(codec.decode(rewriteCursorSignature(cursor))).toBeNull();
  expect(
    createArtifactAuditJobCursorCodec('different-cursor-secret').decode(cursor)
  ).toBeNull();
});

function rewriteCursorPayload(
  cursor: string,
  rewrite: (payload: Record<string, unknown>) => Record<string, unknown>
): string {
  const [encodedPayload, signature] = cursor.split('.');
  if (!encodedPayload || !signature)
    throw new Error('signed cursor is invalid');
  const payload = JSON.parse(
    Buffer.from(encodedPayload, 'base64url').toString('utf8')
  ) as Record<string, unknown>;
  const rewritten = Buffer.from(JSON.stringify(rewrite(payload))).toString(
    'base64url'
  );
  return `${rewritten}.${signature}`;
}

function rewriteCursorSignature(cursor: string): string {
  const [encodedPayload, signature] = cursor.split('.');
  if (!encodedPayload || !signature)
    throw new Error('signed cursor is invalid');
  const first = signature.at(0);
  return `${encodedPayload}.${first === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
}
