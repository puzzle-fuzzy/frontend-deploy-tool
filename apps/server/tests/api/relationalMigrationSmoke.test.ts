import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Data, Project } from '@deploykit/shared';
import { createApp } from '../../src/app';
import { acquireRuntimeOwnership } from '../../src/services/runtimeOwnership';
import { withBearer } from './helpers';

test('legacy database supports login, release, restart, and session revocation after migration', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-relational-smoke-'));
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  const password = 'legacy-password';
  const legacyData: Data = {
    schemaVersion: 5,
    projects: [],
    users: [
      {
        id: 'legacy-admin',
        name: 'Legacy Admin',
        email: 'legacy@example.com',
        passwordHash: Bun.password.hashSync(password),
        role: 'admin',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ],
    history: [],
    artifactAudits: [],
    artifactAuditJobs: [],
  };

  const legacyDatabase = new Database(databaseFile, { create: true });
  legacyDatabase.exec(`
    CREATE TABLE deploykit_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  legacyDatabase
    .query(
      `INSERT INTO deploykit_state
         (id, schema_version, payload, updated_at)
       VALUES (1, 5, ?, ?)`
    )
    .run(JSON.stringify(legacyData), '2026-07-01T00:00:00.000Z');
  legacyDatabase.close();

  const config = {
    databaseFile,
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
    adminEmail: 'legacy@example.com',
    adminPassword: password,
    sessionSecret: 'migration-smoke-session-secret',
    secureCookies: false,
    registrationEnabled: false,
  };
  const originalDatabase = readFileSync(databaseFile);
  expect(() => createApp(config)).toThrow(
    'RUNTIME_MIGRATION_OWNERSHIP_REQUIRED'
  );
  expect(readFileSync(databaseFile)).toEqual(originalDatabase);
  expect(existsSync(`${databaseFile}.pre-relational-v1.bak`)).toBe(false);

  const ownership = acquireRuntimeOwnership(databaseFile, config.storageDir);

  try {
    const app = createApp(config, {
      migrationGuard: ownership.migrationGuard,
    });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'legacy@example.com', password }),
    });
    expect(login.status).toBe(200);
    const token = (await login.json()).token as string;

    const created = await app.request(
      '/api/projects',
      withBearer(
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Migrated Project',
            slug: 'migrated-project',
            description: '',
          }),
        },
        token
      )
    );
    expect(created.status).toBe(201);
    const project = (await created.json()) as Project;

    const form = new FormData();
    form.append(
      'folderFiles',
      new File(['<html><title>Migrated</title></html>'], 'index.html')
    );
    form.append('versionDesc', 'migration smoke');
    const uploaded = await app.request(
      `/api/projects/${project.id}/versions`,
      withBearer({ method: 'POST', body: form }, token)
    );
    expect(uploaded.status).toBe(201);
    const versionId = (await uploaded.json()).version.id as string;

    const published = await app.request(
      `/api/projects/${project.id}/versions/${versionId}/publish`,
      withBearer(
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedActiveVersionId: null }),
        },
        token
      )
    );
    expect(published.status).toBe(200);

    const restarted = createApp(config, {
      migrationGuard: ownership.migrationGuard,
    });
    expect(
      (await restarted.request('/api/me', withBearer(undefined, token))).status
    ).toBe(200);
    expect(
      (
        await restarted.request(
          '/api/auth/logout',
          withBearer({ method: 'POST' }, token)
        )
      ).status
    ).toBe(200);
    expect(
      (await restarted.request('/api/me', withBearer(undefined, token))).status
    ).toBe(401);

    const verify = new Database(databaseFile);
    const integrity = verify
      .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
      .get();
    const foreignKeyErrors = verify.query('PRAGMA foreign_key_check').all();
    const releases = verify
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM releases')
      .get();
    const events = verify
      .query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM audit_events'
      )
      .get();
    verify.close();

    expect(integrity?.integrity_check).toBe('ok');
    expect(foreignKeyErrors).toEqual([]);
    expect(releases?.count).toBe(1);
    expect(events?.count).toBe(3);
    expect(existsSync(`${databaseFile}.pre-relational-v1.bak`)).toBe(true);
  } finally {
    ownership.release();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
