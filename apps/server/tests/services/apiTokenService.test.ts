import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Project } from '@deploykit/shared';
import { ApiError } from '../../src/errors';
import { createMemoryApiTokenRepository } from '../../src/repositories/apiTokenRepository';
import { createApiTokenService } from '../../src/services/apiTokenService';

const PROJECT_ID = 'project-1';
const NOW = Date.parse('2026-07-31T00:00:00.000Z');
const SECRET_A = Buffer.alloc(32, 1).toString('base64url');
const SECRET_B = Buffer.alloc(32, 2).toString('base64url');
const SECRET_C = Buffer.alloc(32, 3).toString('base64url');

describe('createApiTokenService', () => {
  test('issues a canonical token once and persists only its digest', () => {
    const fixture = createFixture();

    const issued = fixture.service.create(
      PROJECT_ID,
      { name: '  GitHub Actions  ' },
      'user-1'
    );

    expect(issued.plaintextToken).toBe(`dpk_v1.token-1.${SECRET_A}`);
    expect(issued.token).toMatchObject({
      id: 'token-1',
      projectId: PROJECT_ID,
      name: 'GitHub Actions',
      prefix: 'dpk_v1.token-1',
      scopes: ['preview:upload'],
      createdAt: '2026-07-31T00:00:00.000Z',
      createdBy: 'user-1',
      expiresAt: '2026-10-29T00:00:00.000Z',
    });
    expect(issued.token).not.toHaveProperty('secretDigest');
    expect(fixture.repository.findById('token-1')).toMatchObject({
      hashVersion: 1,
      secretDigest: createHash('sha256')
        .update('deploykit:project-api-token:v1\0')
        .update(issued.plaintextToken)
        .digest('hex'),
    });
    expect(JSON.stringify(fixture.service.list(PROJECT_ID))).not.toContain(
      SECRET_A
    );
  });

  test('authenticates only after a constant-shape digest check and records safe failures', () => {
    const fixture = createFixture();
    const issued = fixture.service.create(PROJECT_ID, { name: 'CI' }, 'user-1');

    const principal = fixture.service.authenticate(
      issued.plaintextToken,
      PROJECT_ID,
      'preview:upload'
    );
    expect(principal).toEqual({
      actorId: 'api-token:token-1',
      prefix: 'dpk_v1.token-1',
      projectId: PROJECT_ID,
      scopes: ['preview:upload'],
      tokenId: 'token-1',
    });
    expect(() =>
      fixture.service.revalidatePrincipal(
        principal,
        PROJECT_ID,
        'preview:upload'
      )
    ).not.toThrow();

    expectApiError(
      () =>
        fixture.service.authenticate(
          `dpk_v1.token-1.${SECRET_B}`,
          PROJECT_ID,
          'preview:upload'
        ),
      'API_TOKEN_INVALID',
      401
    );
    expectApiError(
      () =>
        fixture.service.authenticate(
          `dpk_v1.token-1.${SECRET_B}`,
          PROJECT_ID,
          'preview:upload'
        ),
      'API_TOKEN_INVALID',
      401
    );
    expectApiError(
      () =>
        fixture.service.authenticate(
          issued.plaintextToken,
          'project-2',
          'preview:upload'
        ),
      'API_TOKEN_INVALID',
      401
    );
    expectApiError(
      () =>
        fixture.service.authenticate(
          `dpk_v1.unknown.${SECRET_B}`,
          PROJECT_ID,
          'preview:upload'
        ),
      'API_TOKEN_INVALID',
      401
    );
    expectApiError(
      () =>
        fixture.service.authenticate(
          `dpk_v1.token-1.${SECRET_B}=`,
          PROJECT_ID,
          'preview:upload'
        ),
      'API_TOKEN_INVALID',
      401
    );

    const events = fixture.service.listSecurityEvents(PROJECT_ID);
    expect(
      events
        .filter((event) => event.action === 'api_token.authentication_failed')
        .map((event) => event.reason)
    ).toEqual(['project_mismatch', 'digest_mismatch']);
    expect(JSON.stringify(events)).not.toContain(SECRET_A);
    expect(JSON.stringify(events)).not.toContain(SECRET_B);
  });

  test('validates explicit expiry and defaults it to ninety days', () => {
    const fixture = createFixture();
    expectApiError(
      () =>
        fixture.service.create(
          PROJECT_ID,
          {
            name: 'Expired',
            expiresAt: '2026-07-30T23:59:59.999Z',
          },
          'user-1'
        ),
      'INVALID_REQUEST',
      400
    );
    expectApiError(
      () =>
        fixture.service.create(
          PROJECT_ID,
          {
            name: 'Too long',
            expiresAt: '2027-08-01T00:00:00.000Z',
          },
          'user-1'
        ),
      'INVALID_REQUEST',
      400
    );

    const explicit = fixture.service.create(
      PROJECT_ID,
      {
        name: 'Bounded',
        expiresAt: '2027-07-31T00:00:00.000Z',
      },
      'user-1'
    );
    expect(explicit.token.expiresAt).toBe('2027-07-31T00:00:00.000Z');
  });

  test('rotates once with bounded overlap and revokes idempotently', () => {
    const fixture = createFixture();
    const initial = fixture.service.create(
      PROJECT_ID,
      { name: 'CI' },
      'user-1'
    );
    fixture.setNow(Date.parse('2026-07-31T01:00:00.000Z'));

    const replacement = fixture.service.rotate(
      PROJECT_ID,
      'token-1',
      {},
      'user-1'
    );

    expect(replacement.plaintextToken).toBe(`dpk_v1.token-2.${SECRET_B}`);
    expect(replacement.token.scopes).toEqual(initial.token.scopes);
    expect(fixture.service.list(PROJECT_ID)).toContainEqual(
      expect.objectContaining({
        id: 'token-1',
        expiresAt: '2026-07-31T01:15:00.000Z',
        replacedByTokenId: 'token-2',
        revokedAt: null,
      })
    );
    expect(
      fixture.service.authenticate(
        initial.plaintextToken,
        PROJECT_ID,
        'preview:upload'
      ).tokenId
    ).toBe('token-1');
    expect(
      fixture.service.authenticate(
        replacement.plaintextToken,
        PROJECT_ID,
        'preview:upload'
      ).tokenId
    ).toBe('token-2');
    expectApiError(
      () => fixture.service.rotate(PROJECT_ID, 'token-1', {}, 'user-1'),
      'API_TOKEN_NOT_FOUND',
      404
    );

    fixture.setNow(Date.parse('2026-07-31T01:15:00.001Z'));
    expectApiError(
      () =>
        fixture.service.authenticate(
          initial.plaintextToken,
          PROJECT_ID,
          'preview:upload'
        ),
      'API_TOKEN_EXPIRED',
      401
    );

    const revoked = fixture.service.revoke(
      PROJECT_ID,
      replacement.token.id,
      'user-1'
    );
    expect(revoked.revokedAt).toBe('2026-07-31T01:15:00.001Z');
    expect(
      fixture.service.revoke(PROJECT_ID, replacement.token.id, 'user-1')
    ).toEqual(revoked);
    expectApiError(
      () =>
        fixture.service.authenticate(
          replacement.plaintextToken,
          PROJECT_ID,
          'preview:upload'
        ),
      'API_TOKEN_REVOKED',
      401
    );
  });

  test('supports immediate rotation and bounds overlap to twenty-four hours', () => {
    const fixture = createFixture();
    const initial = fixture.service.create(
      PROJECT_ID,
      { name: 'CI' },
      'user-1'
    );

    const replacement = fixture.service.rotate(
      PROJECT_ID,
      initial.token.id,
      { overlapSeconds: 0 },
      'user-1'
    );
    expect(
      fixture.service.list(PROJECT_ID).find(({ id }) => id === initial.token.id)
        ?.revokedAt
    ).toBe('2026-07-31T00:00:00.000Z');
    expectApiError(
      () =>
        fixture.service.rotate(
          PROJECT_ID,
          replacement.token.id,
          { overlapSeconds: 86_401 },
          'user-1'
        ),
      'INVALID_REQUEST',
      400
    );
  });

  test('touches last-used metadata at most once every five minutes', () => {
    const fixture = createFixture();
    const issued = fixture.service.create(PROJECT_ID, { name: 'CI' }, 'user-1');
    fixture.service.authenticate(
      issued.plaintextToken,
      PROJECT_ID,
      'preview:upload'
    );
    expect(fixture.service.list(PROJECT_ID)[0].lastUsedAt).toBe(
      '2026-07-31T00:00:00.000Z'
    );

    fixture.setNow(Date.parse('2026-07-31T00:02:00.000Z'));
    fixture.service.authenticate(
      issued.plaintextToken,
      PROJECT_ID,
      'preview:upload'
    );
    expect(fixture.service.list(PROJECT_ID)[0].lastUsedAt).toBe(
      '2026-07-31T00:00:00.000Z'
    );

    fixture.setNow(Date.parse('2026-07-31T00:05:00.001Z'));
    fixture.service.authenticate(
      issued.plaintextToken,
      PROJECT_ID,
      'preview:upload'
    );
    expect(fixture.service.list(PROJECT_ID)[0].lastUsedAt).toBe(
      '2026-07-31T00:05:00.001Z'
    );
  });
});

function createFixture() {
  const repository = createMemoryApiTokenRepository();
  let now = NOW;
  const tokenIds = ['token-1', 'token-2', 'token-3'];
  const secrets = [SECRET_A, SECRET_B, SECRET_C];
  const project = {
    id: PROJECT_ID,
    name: 'Signal Desk',
  } as Project;
  const service = createApiTokenService({
    repository,
    projectService: {
      getProject(id: string) {
        if (id !== PROJECT_ID) {
          throw new ApiError('PROJECT_NOT_FOUND', 'Project not found', 404);
        }
        return project;
      },
    },
    now: () => now,
    createTokenId: () => {
      const id = tokenIds.shift();
      if (!id) throw new Error('test token ids exhausted');
      return id;
    },
    generateSecret: () => {
      const secret = secrets.shift();
      if (!secret) throw new Error('test token secrets exhausted');
      return secret;
    },
  });
  return {
    repository,
    service,
    setNow(value: number) {
      now = value;
    },
  };
}

function expectApiError(
  work: () => unknown,
  code: ApiError['code'],
  status: ApiError['status']
): void {
  try {
    work();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    expect((error as ApiError).status).toBe(status);
    expect(error instanceof Error ? error.message : '').not.toContain(SECRET_A);
    expect(error instanceof Error ? error.message : '').not.toContain(SECRET_B);
  }
}
