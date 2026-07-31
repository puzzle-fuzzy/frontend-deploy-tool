import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
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

function createCurrentAuditData() {
  const data = migrate(v0Payload).data;
  const project = data.projects[0];
  const version = project.versions[0];
  const policy = { ...project.auditPolicy };
  data.artifactAudits.push({
    id: 'report-1',
    projectId: project.id,
    versionId: version.id,
    artifactChecksum: version.checksum,
    status: 'warning',
    score: 90,
    createdAt: '2026-07-30T00:01:00.000Z',
    createdBy: 'system',
    engineVersion: 1,
    policy: { ...policy },
    context: { spaMode: false, routingType: 'path' },
    summary: {
      totalBytes: 10,
      fileCount: 1,
      largestFiles: [{ path: 'index.html', size: 10 }],
      extensions: [{ extension: '.html', bytes: 10, count: 1 }],
      assetBytes: {
        javascript: 0,
        stylesheet: 0,
        font: 0,
        image: 0,
      },
    },
    checks: [
      {
        id: 'seo.title',
        ruleVersion: 1,
        category: 'seo',
        severity: 'warning',
        passed: false,
        message: 'Title is missing',
      },
    ],
  });
  data.artifactAuditJobs.push({
    id: 'job-1',
    projectId: project.id,
    versionId: version.id,
    requestedBy: 'system',
    status: 'succeeded',
    priority: 0,
    attempts: 1,
    maxAttempts: 3,
    nextRunAt: '2026-07-30T00:00:00.000Z',
    lockedBy: null,
    lockedUntil: null,
    artifactChecksum: version.checksum,
    engineVersion: 1,
    policy: { ...policy },
    context: { spaMode: false, routingType: 'path' },
    reportId: 'report-1',
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:01:00.000Z',
    startedAt: '2026-07-30T00:00:05.000Z',
    completedAt: '2026-07-30T00:01:00.000Z',
  });
  return data;
}

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
    expect(version.integrityStatus).toBe('unknown');
    expect(version.integrityCheckedAt).toBeNull();
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
      versions: [{ id: 'v1', name: 'v1', description: '', createdAt: '' }],
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
  expect(data.projects[0].auditPolicy).toEqual({
    enforcement: 'advisory',
    maxTotalBytes: 50 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
    maxFileCount: 1_000,
    maxJavaScriptBytes: 10 * 1024 * 1024,
    maxStylesheetBytes: 2 * 1024 * 1024,
    maxFontBytes: 10 * 1024 * 1024,
  });
  expect(data.artifactAudits).toEqual([]);
  expect(data.artifactAuditJobs).toEqual([]);
});

test('migrate hydrates v8 audit snapshots to the v9 contract', () => {
  const policy = {
    enforcement: 'blocking',
    maxTotalBytes: 1_024,
    maxFileBytes: 512,
    maxFileCount: 10,
  } as const;
  const raw = {
    schemaVersion: 8,
    projects: [
      {
        id: 'p1',
        name: 'P',
        slug: 'project',
        description: '',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
        activeVersionId: null,
        versions: [
          {
            id: 'v1',
            name: 'v1',
            description: '',
            createdAt: '2026-07-30T00:00:00.000Z',
            size: 10,
            fileCount: 1,
            sourceType: 'folder',
            status: 'preview',
            publishedAt: null,
            publishedBy: null,
            checksum: 'checksum-1',
            integrityStatus: 'verified',
            integrityCheckedAt: '2026-07-30T00:00:00.000Z',
          },
        ],
        settings: { spaMode: true, routingType: 'hash' },
        auditPolicy: policy,
        createdBy: 'system',
        members: [],
      },
    ],
    users: [],
    history: [],
    artifactAudits: [
      {
        id: 'report-1',
        projectId: 'p1',
        versionId: 'v1',
        artifactChecksum: 'checksum-1',
        status: 'warning',
        score: 90,
        createdAt: '2026-07-30T00:01:00.000Z',
        createdBy: 'system',
        engineVersion: 1,
        policy,
        summary: {
          totalBytes: 10,
          fileCount: 1,
          largestFiles: [{ path: 'index.html', size: 10 }],
          extensions: [{ extension: '.html', bytes: 10, count: 1 }],
        },
        checks: [
          {
            id: 'seo.title',
            category: 'seo',
            severity: 'warning',
            passed: false,
            message: 'Title is missing',
          },
        ],
      },
    ],
    artifactAuditJobs: [
      {
        id: 'job-1',
        projectId: 'p1',
        versionId: 'v1',
        requestedBy: 'system',
        status: 'succeeded',
        priority: 0,
        attempts: 1,
        maxAttempts: 3,
        nextRunAt: '2026-07-30T00:00:00.000Z',
        lockedBy: null,
        lockedUntil: null,
        artifactChecksum: 'checksum-1',
        engineVersion: 1,
        policy,
        reportId: 'report-1',
        errorCode: null,
        errorMessage: null,
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:01:00.000Z',
        startedAt: '2026-07-30T00:00:05.000Z',
        completedAt: '2026-07-30T00:01:00.000Z',
      },
    ],
  };

  const { data, migrated } = migrate(raw);

  expect(migrated).toBe(true);
  expect(data.schemaVersion).toBe(9);
  expect(data.projects[0].auditPolicy).toMatchObject({
    ...policy,
    maxJavaScriptBytes: 10 * 1024 * 1024,
    maxStylesheetBytes: 2 * 1024 * 1024,
    maxFontBytes: 10 * 1024 * 1024,
  });
  expect(data.artifactAudits[0]).toMatchObject({
    engineVersion: 1,
    context: { spaMode: false, routingType: 'path' },
    summary: {
      assetBytes: {
        javascript: 0,
        stylesheet: 0,
        font: 0,
        image: 0,
      },
    },
    checks: [{ ruleVersion: 1 }],
  });
  expect(data.artifactAuditJobs[0]).toMatchObject({
    engineVersion: 1,
    context: { spaMode: false, routingType: 'path' },
  });
});

test('migrate fails closed when a declared v8 document is invalid', () => {
  expect(() =>
    migrate({
      schemaVersion: 8,
      projects: 'not-an-array',
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    })
  ).toThrow('Document schema v8 migration failed validation');
});

test('migrate leaves already-current data unchanged', () => {
  const current = migrate(v0Payload).data;
  const { data, migrated } = migrate(current);

  expect(migrated).toBe(false);
  expect(data).toEqual(current);
});

test('migrate rejects decoded values outside the supported document schemas', () => {
  expect(() => migrate(null)).toThrow('Document schema migration failed');
  expect(() =>
    migrate({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: 'not-an-array',
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    })
  ).toThrow('Document schema v9 failed validation');
});

test('migrate accepts supported declared versions and rejects every version boundary', () => {
  const current = createCurrentAuditData();
  for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const migrated = migrate({ ...current, schemaVersion });
    expect(migrated.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.migrated).toBe(true);
  }

  for (const schemaVersion of [-1, 1.5, CURRENT_SCHEMA_VERSION + 1]) {
    expect(() => migrate({ ...current, schemaVersion })).toThrow(
      `Unsupported document schema version ${schemaVersion}`
    );
  }
  expect(() => migrate({ ...current, schemaVersion: '9' })).toThrow(
    'Document schema migration failed'
  );
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

test('repository backs up a deployed v8 document before versioning audit snapshots', () => {
  const dataFile = join(tempDir, 'data.json');
  const current = migrate(v0Payload).data;
  const v8Payload = { ...current, schemaVersion: 8 };
  const original = JSON.stringify(v8Payload);
  writeFileSync(dataFile, original);

  const repo = createJsonProjectRepository(dataFile);
  const loaded = repo.load();

  expect(loaded.schemaVersion).toBe(9);
  expect(loaded.artifactAuditJobs).toEqual([]);
  expect(readFileSync(`${dataFile}.bak`, 'utf-8')).toBe(original);
  const persisted = JSON.parse(readFileSync(dataFile, 'utf-8'));
  expect(persisted.schemaVersion).toBe(9);
  expect(persisted.artifactAuditJobs).toEqual([]);
});

test('repository fails closed when an existing document contains malformed JSON', () => {
  const dataFile = join(tempDir, 'data.json');
  const original = Buffer.from('{"schemaVersion":8,"projects":[');
  writeFileSync(dataFile, original);

  const repo = createJsonProjectRepository(dataFile);

  expect(() => repo.load()).toThrow();
  expect(readFileSync(dataFile)).toEqual(original);
  expect(existsSync(`${dataFile}.bak`)).toBe(false);
});

test('repository preserves v8 bytes when the migration backup cannot be copied', () => {
  const dataFile = join(tempDir, 'data.json');
  const current = migrate(v0Payload).data;
  const original = Buffer.from(
    JSON.stringify({ ...current, schemaVersion: 8 })
  );
  writeFileSync(dataFile, original);
  mkdirSync(`${dataFile}.bak`);

  const repo = createJsonProjectRepository(dataFile);

  expect(() => repo.load()).toThrow();
  expect(readFileSync(dataFile)).toEqual(original);
  expect(JSON.parse(readFileSync(dataFile, 'utf-8')).schemaVersion).toBe(8);
});

test('repository rejects a schema-invalid current document without writing', () => {
  const dataFile = join(tempDir, 'data.json');
  const original = Buffer.from(
    JSON.stringify({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: 'not-an-array',
      users: [],
      history: [],
      artifactAudits: [],
      artifactAuditJobs: [],
    })
  );
  writeFileSync(dataFile, original);

  const repo = createJsonProjectRepository(dataFile);

  expect(() => repo.load()).toThrow('Document schema v9 failed validation');
  expect(readFileSync(dataFile)).toEqual(original);
  expect(existsSync(`${dataFile}.bak`)).toBe(false);
});

test('repository rejects an unknown document version without writing', () => {
  const dataFile = join(tempDir, 'data.json');
  const current = migrate(v0Payload).data;
  const original = Buffer.from(
    JSON.stringify({
      ...current,
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
    })
  );
  writeFileSync(dataFile, original);

  const repo = createJsonProjectRepository(dataFile);

  expect(() => repo.load()).toThrow('Unsupported document schema version 10');
  expect(readFileSync(dataFile)).toEqual(original);
  expect(existsSync(`${dataFile}.bak`)).toBe(false);
});

test('repository rejects a v8-shaped document mislabeled as v9 without writing', () => {
  const dataFile = join(tempDir, 'data.json');
  const current = createCurrentAuditData();
  const project = current.projects[0];
  const {
    members: _members,
    auditPolicy: currentProjectPolicy,
    ...projectWithoutCurrentFields
  } = project;
  const {
    maxJavaScriptBytes: _projectJavaScript,
    maxStylesheetBytes: _projectStylesheet,
    maxFontBytes: _projectFont,
    ...legacyProjectPolicy
  } = currentProjectPolicy;
  const report = current.artifactAudits[0];
  const {
    policy: currentReportPolicy,
    context: _reportContext,
    summary: currentSummary,
    checks: currentChecks,
    ...reportWithoutCurrentFields
  } = report;
  const {
    maxJavaScriptBytes: _reportJavaScript,
    maxStylesheetBytes: _reportStylesheet,
    maxFontBytes: _reportFont,
    ...legacyReportPolicy
  } = currentReportPolicy;
  const { assetBytes: _assetBytes, ...legacySummary } = currentSummary;
  const [{ ruleVersion: _ruleVersion, ...legacyCheck }] = currentChecks;
  const job = current.artifactAuditJobs[0];
  const {
    policy: currentJobPolicy,
    context: _jobContext,
    ...jobWithoutCurrentFields
  } = job;
  const {
    maxJavaScriptBytes: _jobJavaScript,
    maxStylesheetBytes: _jobStylesheet,
    maxFontBytes: _jobFont,
    ...legacyJobPolicy
  } = currentJobPolicy;
  const original = Buffer.from(
    JSON.stringify({
      ...current,
      projects: [
        {
          ...projectWithoutCurrentFields,
          auditPolicy: legacyProjectPolicy,
        },
      ],
      artifactAudits: [
        {
          ...reportWithoutCurrentFields,
          policy: legacyReportPolicy,
          summary: legacySummary,
          checks: [legacyCheck],
        },
      ],
      artifactAuditJobs: [
        {
          ...jobWithoutCurrentFields,
          policy: legacyJobPolicy,
        },
      ],
    })
  );
  writeFileSync(dataFile, original);

  const repo = createJsonProjectRepository(dataFile);

  expect(() => repo.load()).toThrow('Document schema v9 failed validation');
  expect(readFileSync(dataFile)).toEqual(original);
  expect(existsSync(`${dataFile}.bak`)).toBe(false);
});
