import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_SCHEMA_VERSION, migrate } from '../../src/domain/schema';
import { createJsonProjectRepository } from '../../src/repositories/jsonProjectRepository';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-migration-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Old (schemaVersion-less) shape: the active flag lives on each version. */
const v0Payload = {
  projects: [
    {
      id: 'p1',
      name: 'P',
      slug: 'p',
      description: '',
      createdAt: '',
      updatedAt: '',
      versions: [
        { id: 'v1', name: 'v1', description: '', createdAt: '', active: true },
        { id: 'v2', name: 'v2', description: '', createdAt: '', active: false },
      ],
    },
  ],
  history: [],
};

test('migrate derives activeVersionId from the per-version active flag (v0 -> current)', () => {
  const { data, migrated } = migrate(v0Payload);

  expect(migrated).toBe(true);
  expect(data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  const project = data.projects[0];
  expect(project.activeVersionId).toBe('v1');
  for (const version of project.versions) {
    expect(version).not.toHaveProperty('active');
  }
});

test('migrate backfills upload metadata defaults for legacy versions', () => {
  const { data, migrated } = migrate(v0Payload);
  expect(migrated).toBe(true);

  for (const version of data.projects[0].versions) {
    expect(version.size).toBe(0);
    expect(version.fileCount).toBe(0);
    expect(version.sourceType).toBe('unknown');
  }
});

/** A pre-metadata v1 payload: schemaVersion is set but versions lack size/fileCount/sourceType. */
const v1PreMetadataPayload = {
  schemaVersion: 1,
  projects: [
    {
      id: 'p1',
      name: 'P',
      slug: 'p',
      description: '',
      createdAt: '',
      updatedAt: '',
      activeVersionId: 'v1',
      versions: [
        { id: 'v1', name: 'v1', description: '', createdAt: '' },
      ],
    },
  ],
  history: [],
};

test('migrate upgrades a pre-metadata v1 payload to the current schema', () => {
  const { data, migrated } = migrate(v1PreMetadataPayload);

  expect(migrated).toBe(true);
  expect(data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  const version = data.projects[0].versions[0];
  expect(version.size).toBe(0);
  expect(version.fileCount).toBe(0);
  expect(version.sourceType).toBe('unknown');
});

test('migrate leaves already-current data unchanged', () => {
  const current = migrate(v0Payload).data;
  const { data, migrated } = migrate(current);

  expect(migrated).toBe(false);
  expect(data).toEqual(current);
});

test('migrate is null-safe on an empty or malformed payload', () => {
  expect(migrate(null).data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  expect(migrate({}).data).toEqual({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    history: [],
  });
});

test('repository backs up and persists a migrated v0 file on first load', () => {
  const dataFile = join(tempDir, 'data.json');
  writeFileSync(dataFile, JSON.stringify(v0Payload));

  const repo = createJsonProjectRepository(dataFile);
  const loaded = repo.load();

  // The migrated shape is returned...
  const project = loaded.projects[0];
  expect(project.activeVersionId).toBe('v1');
  expect(project.versions[0]).not.toHaveProperty('active');

  // ...a backup of the pre-migration file was created...
  expect(existsSync(`${dataFile}.bak`)).toBe(true);

  // ...and the on-disk file now carries the current schema with no active flag.
  const persisted = JSON.parse(readFileSync(dataFile, 'utf-8'));
  expect(persisted.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  expect(persisted.projects[0].versions[0]).not.toHaveProperty('active');

  // A second load no longer treats it as a migration (no extra writes needed).
  expect(repo.load()).toEqual(loaded);
});
