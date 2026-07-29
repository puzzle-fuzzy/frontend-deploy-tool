import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMemorySessionRepository,
  createSqliteSessionRepository,
  type SessionRecord,
} from '../../src/repositories/sessionRepository';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';

const session: SessionRecord = {
  id: 'session-1',
  userId: 'user-1',
  kind: 'browser',
  createdAt: '2026-07-30T00:00:00.000Z',
  expiresAt: 2_000,
  revokedAt: null,
};

test('memory sessions can be listed, revoked, and expired', () => {
  const repository = createMemorySessionRepository();
  repository.create(session);
  repository.create({
    ...session,
    id: 'session-2',
    kind: 'desktop',
    expiresAt: 1_000,
  });

  expect(repository.findActive('session-1', 1_500)).toEqual(session);
  expect(repository.findActive('session-2', 1_500)).toBeNull();
  expect(repository.listForUser('user-1').map((item) => item.id)).toEqual([
    'session-2',
    'session-1',
  ]);
  expect(
    repository.revokeForUser('session-1', 'user-1', '2026-07-30T01:00:00.000Z')
  ).toBe(true);
  expect(repository.findActive('session-1', 1_500)).toBeNull();
  expect(repository.deleteExpired(1_500)).toBe(1);
});

test('SQLite sessions persist across repository instances and enforce ownership', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-session-repo-'));
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const projectRepository = createSqliteProjectRepository({ databaseFile });
  projectRepository.mutate((data) => {
    data.users.push({
      id: 'user-1',
      name: 'Owner',
      email: 'owner@example.com',
      passwordHash: 'hash',
      role: 'developer',
      createdAt: '',
      updatedAt: '',
    });
  });

  try {
    createSqliteSessionRepository(databaseFile).create(session);
    const reopened = createSqliteSessionRepository(databaseFile);

    expect(reopened.findActive('session-1', 1_500)).toEqual(session);
    expect(
      reopened.revokeForUser(
        'session-1',
        'another-user',
        '2026-07-30T01:00:00.000Z'
      )
    ).toBe(false);
    expect(reopened.findActive('session-1', 1_500)).toEqual(session);
    expect(
      reopened.revokeAllForUser('user-1', '2026-07-30T01:00:00.000Z')
    ).toBe(1);
    expect(reopened.findActive('session-1', 1_500)).toBeNull();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
