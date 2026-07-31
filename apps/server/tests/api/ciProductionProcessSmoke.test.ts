import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

const repositoryRoot = join(import.meta.dir, '..', '..', '..', '..');
const schemaV5FixtureRoot = join(
  import.meta.dir,
  '..',
  'fixtures',
  'schema-v5-backup'
);
const activeServers = new Set<SpawnedServer>();
const activeOpsProcesses = new Set<ReturnType<typeof Bun.spawn>>();
const temporaryRoots: string[] = [];

interface SpawnedServer {
  child: ReturnType<typeof Bun.spawn>;
  stdout: Promise<string>;
  stderr: Promise<string>;
}

interface StoppedServerLogs {
  stdout: string;
  stderr: string;
}

interface OpsProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Session {
  cookie: string;
}

interface IssuedCredential {
  id: string;
  plaintextToken: string;
}

interface CiUploadResult {
  replayed: boolean;
  version: {
    id: string;
    name: string;
  };
}

interface AutomationState {
  activeVersionId: string | null;
  apiTokens: number;
  apiTokenSecurityEvents: number;
  artifactAuditJobs: number;
  artifactAudits: number;
  ciIdempotencyRecords: number;
  versions: number;
  schemaVersion: number;
  integrity: string;
  foreignKeyViolations: number;
}

interface ArtifactAuditPolicySnapshot {
  enforcement: 'advisory' | 'blocking';
  maxTotalBytes: number;
  maxFileBytes: number;
  maxFileCount: number;
  maxJavaScriptBytes: number;
  maxStylesheetBytes: number;
  maxFontBytes: number;
}

interface ArtifactAuditJobSnapshot {
  id: string;
  projectId: string;
  versionId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  engineVersion: number;
  policy: ArtifactAuditPolicySnapshot;
  reportId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface ArtifactAuditReportSnapshot {
  id: string;
  projectId: string;
  versionId: string;
  status: 'passed' | 'warning' | 'failed';
  engineVersion: number;
}

interface ReleaseInvariantState {
  activeVersionId: string | null;
  versionStatus: string;
  artifactFiles: Array<{ path: string; bytes: Buffer }>;
  artifactAuditJobs: number;
  artifactAudits: number;
}

afterEach(async () => {
  for (const server of activeServers) {
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
    await server.child.exited;
  }
  activeServers.clear();
  for (const child of activeOpsProcesses) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
  }
  activeOpsProcesses.clear();
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('production process preserves CI idempotency, credential lifecycle, and backup compatibility', async () => {
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), 'deploykit-ci-production-smoke-')
  );
  temporaryRoots.push(temporaryRoot);
  const databaseFile = join(temporaryRoot, 'deploykit.sqlite');
  const dataFile = join(temporaryRoot, 'legacy.json');
  const storageDir = join(temporaryRoot, 'storage');
  const publicDir = join(temporaryRoot, 'public');
  const backupDir = join(temporaryRoot, 'backup-v6');
  const liveBackupDir = join(temporaryRoot, 'live-backup');
  const legacyBackupDir = join(temporaryRoot, 'backup-v5');
  const legacyDatabaseFile = join(temporaryRoot, 'legacy-target.sqlite');
  const legacyStorageDir = join(temporaryRoot, 'legacy-target-storage');
  const legacyDataFile = join(temporaryRoot, 'legacy-target.json');
  const adminEmail = 'ci-smoke-admin@deploykit.local';
  const adminPassword = 'ci-smoke-admin-password-2026';
  const port = await reservePort();
  const managementOrigin = `http://console.localhost:${port}`;
  const deployOrigin = `http://deploy.localhost:${port}`;
  const capturedLogs: StoppedServerLogs[] = [];

  mkdirSync(publicDir, { recursive: true });
  writeFileSync(
    join(publicDir, 'index.html'),
    '<!doctype html><html><body>DeployKit smoke shell</body></html>'
  );

  const environment = {
    ...process.env,
    DEPLOYKIT_ENV: 'production',
    PORT: String(port),
    DATABASE_FILE: databaseFile,
    DATA_FILE: dataFile,
    STORAGE_DIR: storageDir,
    PUBLIC_DIR: publicDir,
    MANAGEMENT_BASE_URL: managementOrigin,
    DEPLOY_BASE_URL: deployOrigin,
    SESSION_SECRET: 's'.repeat(64),
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
    REGISTRATION_ENABLED: 'false',
    ARTIFACT_AUDIT_WORKER_ENABLED: 'false',
    SHUTDOWN_TIMEOUT_MS: '10000',
  };

  let server = await startServer(environment, managementOrigin);
  const session = await login(managementOrigin, adminEmail, adminPassword);
  const sessionRequest = createSessionRequest(managementOrigin, session);
  const projectResponse = await expectJson(
    await sessionRequest('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'CI Production Smoke',
        slug: 'ci-production-smoke',
        description: 'Real-process CI contract verification',
      }),
    }),
    201,
    'create project'
  );
  const projectId = requireString(projectResponse.id, 'project id');
  const issued = await createCredential(
    sessionRequest,
    projectId,
    'Primary CI'
  );

  const firstKey = 'production-smoke-run-1';
  const firstHtml =
    '<!doctype html><html><head><title>CI Preview</title></head><body>first-preview</body></html>';
  const first = await uploadZip(
    managementOrigin,
    projectId,
    issued.plaintextToken,
    firstKey,
    firstHtml
  );
  expect(first.response.status).toBe(201);
  expect(first.response.headers.get('Idempotency-Replayed')).toBe('false');
  const firstBody = requireCiUploadResult(first.body);
  expect(firstBody.replayed).toBe(false);

  const replay = await uploadZip(
    managementOrigin,
    projectId,
    issued.plaintextToken,
    firstKey,
    firstHtml
  );
  expect(replay.response.status).toBe(200);
  expect(replay.response.headers.get('Idempotency-Replayed')).toBe('true');
  expect(replay.body).toEqual({
    replayed: true,
    version: firstBody.version,
  });

  const conflict = await uploadZip(
    managementOrigin,
    projectId,
    issued.plaintextToken,
    firstKey,
    '<!doctype html><html><body>changed-preview</body></html>'
  );
  expect(conflict.response.status).toBe(409);
  expect((conflict.body as ErrorEnvelope).error.code).toBe(
    'IDEMPOTENCY_CONFLICT'
  );

  capturedLogs.push(await stopServer(server));
  server = await startServer(environment, managementOrigin);

  const replayAfterRestart = await uploadZip(
    managementOrigin,
    projectId,
    issued.plaintextToken,
    firstKey,
    firstHtml
  );
  expect(replayAfterRestart.response.status).toBe(200);
  expect(replayAfterRestart.body).toEqual({
    replayed: true,
    version: firstBody.version,
  });

  const rotationStartedAt = Date.now();
  const rotateResponse = await expectJson(
    await sessionRequest(
      `/api/projects/${projectId}/api-tokens/${issued.id}/rotate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overlapSeconds: 300 }),
      }
    ),
    201,
    'rotate API credential'
  );
  const replacement: IssuedCredential = {
    id: requireString(
      (rotateResponse.token as Record<string, unknown> | undefined)?.id,
      'replacement token id'
    ),
    plaintextToken: requireString(
      rotateResponse.plaintextToken,
      'replacement plaintext token'
    ),
  };
  const listedAfterRotation = await expectJson(
    await sessionRequest(`/api/projects/${projectId}/api-tokens`),
    200,
    'list credentials after rotation'
  );
  const previousMetadata = (
    listedAfterRotation.tokens as Array<Record<string, unknown>>
  ).find((token) => token.id === issued.id);
  if (!previousMetadata) {
    throw new Error('previous credential metadata is missing after rotation');
  }
  expect(previousMetadata.replacedByTokenId).toBe(replacement.id);
  const previousExpiresAt = Date.parse(
    requireString(previousMetadata.expiresAt, 'previous credential expiry')
  );
  expect(previousExpiresAt).toBeGreaterThan(rotationStartedAt);
  expect(previousExpiresAt).toBeLessThanOrEqual(rotationStartedAt + 305_000);

  const oldOverlap = await uploadZip(
    managementOrigin,
    projectId,
    issued.plaintextToken,
    'production-smoke-old-overlap',
    '<!doctype html><html><body>old-overlap-preview</body></html>'
  );
  expect(oldOverlap.response.status).toBe(201);

  const replacementHtml =
    '<!doctype html><html><body>replacement-preview</body></html>';
  const replacementOverlap = await uploadZip(
    managementOrigin,
    projectId,
    replacement.plaintextToken,
    'production-smoke-replacement',
    replacementHtml
  );
  expect(replacementOverlap.response.status).toBe(201);
  const replacementOverlapBody = requireCiUploadResult(replacementOverlap.body);

  await expectJson(
    await sessionRequest(`/api/projects/${projectId}/api-tokens/${issued.id}`, {
      method: 'DELETE',
    }),
    200,
    'revoke previous API credential'
  );
  const revoked = await uploadZip(
    managementOrigin,
    projectId,
    issued.plaintextToken,
    'production-smoke-revoked',
    '<!doctype html><html><body>must-not-commit</body></html>'
  );
  expect(revoked.response.status).toBe(401);
  expect((revoked.body as ErrorEnvelope).error.code).toBe('API_TOKEN_INVALID');

  const events = await expectJson(
    await sessionRequest(
      `/api/projects/${projectId}/api-tokens/security-events`
    ),
    200,
    'list API token security events'
  );
  expect(
    (events.events as Array<{ action: string }>).map((event) => event.action)
  ).toEqual(
    expect.arrayContaining([
      'api_token.authentication_failed',
      'api_token.revoke',
      'api_token.rotate',
      'api_token.create',
    ])
  );

  const auditProof = await proveArtifactAuditRecovery({
    server,
    environment,
    managementOrigin,
    sessionRequest,
    projectId,
    plaintextToken: replacement.plaintextToken,
    warningVersionId: replacementOverlapBody.version.id,
    databaseFile,
    storageDir,
  });
  server = auditProof.server;
  capturedLogs.push(...auditProof.logs);

  const liveBackup = await runOpsExpectFailure(environment, [
    'backup',
    liveBackupDir,
  ]);
  expect(liveBackup.stdout).toBe('');
  expect(liveBackup.stderr).toContain('RUNTIME_OWNERSHIP_HELD');
  expect(liveBackup.stderr).toContain(
    'Stop the DeployKit server and other operational commands before retrying'
  );
  expect(existsSync(liveBackupDir)).toBe(false);
  expect(
    readdirSync(temporaryRoot, { withFileTypes: true }).some((entry) =>
      entry.name.startsWith(`${basename(liveBackupDir)}.tmp-`)
    )
  ).toBe(false);

  capturedLogs.push(await stopServer(server));
  const beforeBackup = inspectAutomationState(databaseFile, projectId);
  expect(beforeBackup).toMatchObject({
    activeVersionId: replacementOverlapBody.version.id,
    apiTokens: 2,
    artifactAuditJobs: 2,
    artifactAudits: 4,
    ciIdempotencyRecords: 8,
    versions: 8,
    schemaVersion: 7,
    integrity: 'ok',
    foreignKeyViolations: 0,
  });

  const backup = await runOps(environment, ['backup', backupDir]);
  const backupBody = JSON.parse(backup.stdout) as {
    manifest: {
      schemaVersion: number;
      metadataCounts: {
        apiTokens: number;
        apiTokenSecurityEvents: number;
        artifactAuditJobs: number;
        artifactAudits: number;
        ciIdempotencyRecords: number;
      };
    };
  };
  expect(backupBody.manifest).toMatchObject({
    schemaVersion: 7,
    metadataCounts: {
      apiTokens: beforeBackup.apiTokens,
      apiTokenSecurityEvents: beforeBackup.apiTokenSecurityEvents,
      artifactAuditJobs: beforeBackup.artifactAuditJobs,
      artifactAudits: beforeBackup.artifactAudits,
      ciIdempotencyRecords: beforeBackup.ciIdempotencyRecords,
    },
  });
  const verified = await runOps(environment, ['verify', backupDir]);
  expect(
    (JSON.parse(verified.stdout) as { report: { valid: boolean } }).report.valid
  ).toBe(true);

  assertPathDoesNotContainSecrets(backupDir, [
    issued.plaintextToken,
    replacement.plaintextToken,
  ]);
  assertPathDoesNotContainSecrets(databaseFile, [
    issued.plaintextToken,
    replacement.plaintextToken,
  ]);

  const mutated = new Database(databaseFile);
  mutated.exec(`
      DELETE FROM ci_idempotency_records;
      DELETE FROM api_token_security_events;
      DELETE FROM project_api_tokens;
    `);
  mutated.close();
  await runOps(environment, ['restore', backupDir, '--force']);

  const restored = inspectAutomationState(databaseFile, projectId);
  expect(restored).toEqual(beforeBackup);
  server = await startServer(environment, managementOrigin);
  const replacementReplay = await uploadZip(
    managementOrigin,
    projectId,
    replacement.plaintextToken,
    'production-smoke-replacement',
    replacementHtml
  );
  expect(replacementReplay.response.status).toBe(200);
  expect(replacementReplay.body).toEqual({
    replayed: true,
    version: replacementOverlapBody.version,
  });
  const restoredOldCredential = await uploadZip(
    managementOrigin,
    projectId,
    issued.plaintextToken,
    'production-smoke-restored-old',
    '<!doctype html><html><body>still-revoked</body></html>'
  );
  expect(restoredOldCredential.response.status).toBe(401);
  capturedLogs.push(await stopServer(server));

  materializeSchemaV5Backup(legacyBackupDir);
  const legacyVerification = await runOps(environment, [
    'verify',
    legacyBackupDir,
  ]);
  expect(
    (
      JSON.parse(legacyVerification.stdout) as {
        report: { valid: boolean };
      }
    ).report.valid
  ).toBe(true);

  const legacyEnvironment = {
    ...environment,
    DATABASE_FILE: legacyDatabaseFile,
    DATA_FILE: legacyDataFile,
    STORAGE_DIR: legacyStorageDir,
  };
  await runOps(legacyEnvironment, ['restore', legacyBackupDir, '--force']);
  server = await startServer(legacyEnvironment, managementOrigin);
  await login(managementOrigin, adminEmail, adminPassword);
  capturedLogs.push(await stopServer(server));

  const migratedLegacy = inspectAutomationState(
    legacyDatabaseFile,
    'schema-v5-project'
  );
  expect(migratedLegacy).toMatchObject({
    activeVersionId: null,
    apiTokens: 0,
    apiTokenSecurityEvents: 0,
    ciIdempotencyRecords: 0,
    versions: 0,
    schemaVersion: 7,
    integrity: 'ok',
    foreignKeyViolations: 0,
  });

  const allLogs = capturedLogs
    .flatMap((logs) => [logs.stdout, logs.stderr])
    .join('\n');
  assertTextDoesNotContainSecrets(
    allLogs,
    [issued.plaintextToken, replacement.plaintextToken],
    'captured production logs'
  );
  assertPathDoesNotContainSecrets(legacyBackupDir, [
    issued.plaintextToken,
    replacement.plaintextToken,
  ]);
  assertPathDoesNotContainSecrets(legacyDatabaseFile, [
    issued.plaintextToken,
    replacement.plaintextToken,
  ]);
}, 180_000);

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

async function reservePort(): Promise<number> {
  const reservation = Bun.serve({
    port: 0,
    fetch: () => new Response('reserved'),
  });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined) throw new Error('could not reserve a TCP port');
  return port;
}

async function startServer(
  environment: Record<string, string | undefined>,
  managementOrigin: string
): Promise<SpawnedServer> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'apps/server/src/index.ts'],
    cwd: repositoryRoot,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const server: SpawnedServer = {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
  activeServers.add(server);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const [stdout, stderr] = await Promise.all([
        server.stdout,
        server.stderr,
      ]);
      throw new Error(
        `server exited during startup (${child.exitCode})\n${stdout}\n${stderr}`
      );
    }
    try {
      if ((await fetch(`${managementOrigin}/health/ready`)).status === 200) {
        return server;
      }
    } catch {
      // The production listener is not ready yet.
    }
    await Bun.sleep(50);
  }
  throw new Error('production server did not become ready within 15 seconds');
}

async function stopServer(server: SpawnedServer): Promise<StoppedServerLogs> {
  server.child.kill('SIGTERM');
  const exitCode = await withTimeout(
    server.child.exited,
    15_000,
    'graceful production shutdown'
  );
  const [stdout, stderr] = await Promise.all([server.stdout, server.stderr]);
  activeServers.delete(server);
  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain('"event":"shutdown_completed"');
  return { stdout, stderr };
}

async function login(
  managementOrigin: string,
  email: string,
  password: string
): Promise<Session> {
  const response = await fetch(`${managementOrigin}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: managementOrigin,
    },
    body: JSON.stringify({ email, password }),
  });
  await expectJson(response, 200, 'admin login');
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('admin login did not return a session cookie');
  return { cookie };
}

function createSessionRequest(
  managementOrigin: string,
  session: Session
): (path: string, init?: RequestInit) => Promise<Response> {
  return (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Cookie', session.cookie);
    const method = (init.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers.set('Origin', managementOrigin);
    }
    return fetch(`${managementOrigin}${path}`, { ...init, headers });
  };
}

async function proveArtifactAuditRecovery({
  server,
  environment,
  managementOrigin,
  sessionRequest,
  projectId,
  plaintextToken,
  warningVersionId,
  databaseFile,
  storageDir,
}: {
  server: SpawnedServer;
  environment: Record<string, string | undefined>;
  managementOrigin: string;
  sessionRequest: (path: string, init?: RequestInit) => Promise<Response>;
  projectId: string;
  plaintextToken: string;
  warningVersionId: string;
  databaseFile: string;
  storageDir: string;
}): Promise<{ server: SpawnedServer; logs: StoppedServerLogs[] }> {
  const logs: StoppedServerLogs[] = [];
  const advisoryPolicy: ArtifactAuditPolicySnapshot = {
    enforcement: 'advisory',
    maxTotalBytes: 2_000_000,
    maxFileBytes: 1_000_000,
    maxFileCount: 100,
    maxJavaScriptBytes: 900_000,
    maxStylesheetBytes: 300_000,
    maxFontBytes: 700_000,
  };
  const blockingPolicy: ArtifactAuditPolicySnapshot = {
    ...advisoryPolicy,
    enforcement: 'blocking',
  };
  const workerEnvironment = {
    ...environment,
    ARTIFACT_AUDIT_WORKER_ENABLED: 'true',
    ARTIFACT_AUDIT_POLL_INTERVAL_MS: '50',
  };
  const disabledWorkerEnvironment = {
    ...environment,
    ARTIFACT_AUDIT_WORKER_ENABLED: 'false',
    ARTIFACT_AUDIT_POLL_INTERVAL_MS: '50',
  };

  await updateAuditPolicy(sessionRequest, projectId, advisoryPolicy);
  const warningBeforeAudit = inspectReleaseInvariant(
    databaseFile,
    storageDir,
    projectId,
    warningVersionId
  );
  expect(warningBeforeAudit).toMatchObject({
    activeVersionId: null,
    versionStatus: 'preview',
    artifactAuditJobs: 0,
    artifactAudits: 0,
  });

  const jobEndpoint = `/api/projects/${projectId}/versions/${warningVersionId}/audit-jobs`;
  const enqueuedBody = await expectJson(
    await sessionRequest(jobEndpoint, { method: 'POST' }),
    202,
    'enqueue advisory artifact audit job'
  );
  expect(enqueuedBody.reused).toBe(false);
  const enqueuedJob = requireAuditJob(enqueuedBody.job, 'enqueued audit job');
  expect(enqueuedJob).toMatchObject({
    projectId,
    versionId: warningVersionId,
    status: 'queued',
    engineVersion: 2,
    policy: advisoryPolicy,
    reportId: null,
  });
  expect(
    inspectReleaseInvariant(
      databaseFile,
      storageDir,
      projectId,
      warningVersionId
    )
  ).toEqual({
    ...warningBeforeAudit,
    artifactAuditJobs: 1,
  });

  await updateAuditPolicy(sessionRequest, projectId, blockingPolicy);
  const queuedAfterToggle = requireAuditJob(
    await expectJson(
      await sessionRequest(`${jobEndpoint}/${enqueuedJob.id}`),
      200,
      'read queued audit job after enforcement-only update'
    ),
    'queued audit job after enforcement-only update'
  );
  expect(queuedAfterToggle).toEqual(enqueuedJob);
  const jobsAfterToggle = await expectJson(
    await sessionRequest(`${jobEndpoint}?limit=10`),
    200,
    'list audit jobs after enforcement-only update'
  );
  expect(jobsAfterToggle).toMatchObject({
    items: [{ id: enqueuedJob.id, status: 'queued' }],
    nextCursor: null,
  });
  expect((jobsAfterToggle.items as unknown[]).length).toBe(1);
  expect(
    inspectReleaseInvariant(
      databaseFile,
      storageDir,
      projectId,
      warningVersionId
    )
  ).toEqual({
    ...warningBeforeAudit,
    artifactAuditJobs: 1,
  });

  logs.push(await stopServer(server));
  server = await startServer(workerEnvironment, managementOrigin);
  const completedJob = await pollAuditJob(
    sessionRequest,
    jobEndpoint,
    enqueuedJob.id,
    30_000
  );
  const completedReportId = requireString(
    completedJob.reportId,
    'completed audit report id'
  );
  expect(completedJob).toMatchObject({
    id: enqueuedJob.id,
    projectId,
    versionId: warningVersionId,
    status: 'succeeded',
    engineVersion: 2,
    errorCode: null,
    errorMessage: null,
  });
  expect(completedJob.reportId).toBe(completedReportId);

  logs.push(await stopServer(server));
  server = await startServer(workerEnvironment, managementOrigin);
  const persistedJob = requireAuditJob(
    await expectJson(
      await sessionRequest(`${jobEndpoint}/${enqueuedJob.id}`),
      200,
      'read persisted audit job after second restart'
    ),
    'persisted audit job after second restart'
  );
  expect(persistedJob).toEqual(completedJob);
  const persistedReport = requireAuditReport(
    await expectJson(
      await sessionRequest(
        `/api/projects/${projectId}/versions/${warningVersionId}/audit`
      ),
      200,
      'read persisted audit report after second restart'
    ),
    'persisted audit report after second restart'
  );
  expect(persistedReport).toMatchObject({
    id: completedReportId,
    projectId,
    versionId: warningVersionId,
    status: 'warning',
    engineVersion: 2,
  });
  const persistedAssessment = await expectJson(
    await sessionRequest(
      `/api/projects/${projectId}/versions/${warningVersionId}/audit-assessment`
    ),
    200,
    'read persisted audit assessment after second restart'
  );
  expect(persistedAssessment).toMatchObject({
    freshness: 'current',
    staleReasons: [],
    currentEngineVersion: 2,
    release: { allowed: true, reason: 'current_report' },
    report: { id: completedReportId, status: 'warning', engineVersion: 2 },
  });
  const warningBeforePublish = inspectReleaseInvariant(
    databaseFile,
    storageDir,
    projectId,
    warningVersionId
  );
  expect(warningBeforePublish).toEqual({
    ...warningBeforeAudit,
    artifactAuditJobs: 1,
    artifactAudits: 1,
  });
  await expectJson(
    await publishVersion(
      sessionRequest,
      projectId,
      warningVersionId,
      warningBeforePublish.activeVersionId
    ),
    200,
    'publish current warning report under blocking policy'
  );
  expect(
    inspectReleaseInvariant(
      databaseFile,
      storageDir,
      projectId,
      warningVersionId
    )
  ).toEqual({
    ...warningBeforePublish,
    activeVersionId: warningVersionId,
    versionStatus: 'production',
  });

  const missingVersionId = await uploadAuditFixture(
    managementOrigin,
    projectId,
    plaintextToken,
    'production-smoke-audit-missing',
    'missing'
  );
  const missingBeforeAssessment = inspectReleaseInvariant(
    databaseFile,
    storageDir,
    projectId,
    missingVersionId
  );
  const missingAssessment = await expectJson(
    await sessionRequest(
      `/api/projects/${projectId}/versions/${missingVersionId}/audit-assessment`
    ),
    200,
    'assess missing audit report'
  );
  expect(missingAssessment).toMatchObject({
    report: null,
    freshness: 'missing',
    staleReasons: [],
    release: { allowed: false, reason: 'audit_required' },
  });
  expect(
    inspectReleaseInvariant(
      databaseFile,
      storageDir,
      projectId,
      missingVersionId
    )
  ).toEqual(missingBeforeAssessment);
  await expectAuditReleaseRejected(
    sessionRequest,
    projectId,
    missingVersionId,
    missingBeforeAssessment,
    databaseFile,
    storageDir,
    'AUDIT_REQUIRED'
  );

  logs.push(await stopServer(server));
  server = await startServer(disabledWorkerEnvironment, managementOrigin);
  const canceledVersionId = await uploadAuditFixture(
    managementOrigin,
    projectId,
    plaintextToken,
    'production-smoke-audit-canceled',
    'canceled'
  );
  const canceledBeforeEnqueue = inspectReleaseInvariant(
    databaseFile,
    storageDir,
    projectId,
    canceledVersionId
  );
  const canceledEndpoint = `/api/projects/${projectId}/versions/${canceledVersionId}/audit-jobs`;
  const cancelCandidate = requireAuditJob(
    (
      await expectJson(
        await sessionRequest(canceledEndpoint, { method: 'POST' }),
        202,
        'enqueue cancelable audit job'
      )
    ).job,
    'cancelable audit job'
  );
  const canceledJob = requireAuditJob(
    await expectJson(
      await sessionRequest(`${canceledEndpoint}/${cancelCandidate.id}`, {
        method: 'DELETE',
      }),
      200,
      'cancel queued audit job'
    ),
    'canceled audit job'
  );
  expect(canceledJob).toMatchObject({
    id: cancelCandidate.id,
    projectId,
    versionId: canceledVersionId,
    status: 'canceled',
    reportId: null,
  });
  expect(
    inspectReleaseInvariant(
      databaseFile,
      storageDir,
      projectId,
      canceledVersionId
    )
  ).toEqual({
    ...canceledBeforeEnqueue,
    artifactAuditJobs: canceledBeforeEnqueue.artifactAuditJobs + 1,
  });

  logs.push(await stopServer(server));
  server = await startServer(workerEnvironment, managementOrigin);
  const staleVersionId = await uploadAuditFixture(
    managementOrigin,
    projectId,
    plaintextToken,
    'production-smoke-audit-stale',
    'stale'
  );
  const staleBeforeAudit = inspectReleaseInvariant(
    databaseFile,
    storageDir,
    projectId,
    staleVersionId
  );
  expect(staleBeforeAudit).toMatchObject({
    activeVersionId: warningVersionId,
    versionStatus: 'preview',
  });
  const staleReport = requireAuditReport(
    await expectJson(
      await sessionRequest(
        `/api/projects/${projectId}/versions/${staleVersionId}/audit`,
        { method: 'POST' }
      ),
      201,
      'run synchronous stale-candidate audit'
    ),
    'stale-candidate audit report'
  );
  expect(staleReport).toMatchObject({
    projectId,
    versionId: staleVersionId,
    status: 'warning',
    engineVersion: 2,
  });
  const stalePolicy = {
    ...blockingPolicy,
    maxFontBytes: blockingPolicy.maxFontBytes - 1,
  };
  await updateAuditPolicy(sessionRequest, projectId, stalePolicy);
  const staleBeforePublish = {
    ...staleBeforeAudit,
    artifactAudits: staleBeforeAudit.artifactAudits + 1,
  };
  expect(
    inspectReleaseInvariant(databaseFile, storageDir, projectId, staleVersionId)
  ).toEqual(staleBeforePublish);
  const staleAssessment = await expectJson(
    await sessionRequest(
      `/api/projects/${projectId}/versions/${staleVersionId}/audit-assessment`
    ),
    200,
    'assess rule-config-stale audit report'
  );
  expect(staleAssessment).toMatchObject({
    freshness: 'stale',
    staleReasons: ['rule_config_changed'],
    release: { allowed: false, reason: 'audit_required' },
    report: { id: staleReport.id, engineVersion: 2 },
  });
  await expectAuditReleaseRejected(
    sessionRequest,
    projectId,
    staleVersionId,
    staleBeforePublish,
    databaseFile,
    storageDir,
    'AUDIT_REQUIRED'
  );

  const failedPolicy: ArtifactAuditPolicySnapshot = {
    enforcement: 'blocking',
    maxTotalBytes: 1,
    maxFileBytes: 1,
    maxFileCount: 1,
    maxJavaScriptBytes: 1,
    maxStylesheetBytes: 1,
    maxFontBytes: 1,
  };
  await updateAuditPolicy(sessionRequest, projectId, failedPolicy);
  const failedVersionId = await uploadAuditFixture(
    managementOrigin,
    projectId,
    plaintextToken,
    'production-smoke-audit-failed',
    'failed'
  );
  const failedBeforeAudit = inspectReleaseInvariant(
    databaseFile,
    storageDir,
    projectId,
    failedVersionId
  );
  expect(failedBeforeAudit).toMatchObject({
    activeVersionId: warningVersionId,
    versionStatus: 'preview',
  });
  const failedReport = requireAuditReport(
    await expectJson(
      await sessionRequest(
        `/api/projects/${projectId}/versions/${failedVersionId}/audit`,
        { method: 'POST' }
      ),
      201,
      'run synchronous audit with failed findings'
    ),
    'failed-findings audit report'
  );
  expect(failedReport).toMatchObject({
    projectId,
    versionId: failedVersionId,
    status: 'failed',
    engineVersion: 2,
  });
  const failedBeforePublish = {
    ...failedBeforeAudit,
    artifactAudits: failedBeforeAudit.artifactAudits + 1,
  };
  expect(
    inspectReleaseInvariant(
      databaseFile,
      storageDir,
      projectId,
      failedVersionId
    )
  ).toEqual(failedBeforePublish);
  await expectAuditReleaseRejected(
    sessionRequest,
    projectId,
    failedVersionId,
    failedBeforePublish,
    databaseFile,
    storageDir,
    'AUDIT_BLOCKED'
  );

  await updateAuditPolicy(sessionRequest, projectId, blockingPolicy);
  const historicVersionId = await uploadAuditFixture(
    managementOrigin,
    projectId,
    plaintextToken,
    'production-smoke-audit-engine-v1',
    'engine-v1'
  );
  const historicBeforeAudit = inspectReleaseInvariant(
    databaseFile,
    storageDir,
    projectId,
    historicVersionId
  );
  expect(historicBeforeAudit).toMatchObject({
    activeVersionId: warningVersionId,
    versionStatus: 'preview',
  });
  const historicReport = requireAuditReport(
    await expectJson(
      await sessionRequest(
        `/api/projects/${projectId}/versions/${historicVersionId}/audit`,
        { method: 'POST' }
      ),
      201,
      'persist historic-engine audit fixture'
    ),
    'historic-engine audit fixture'
  );
  expect(historicReport.engineVersion).toBe(2);
  logs.push(await stopServer(server));
  downgradeAuditReportEngine(databaseFile, historicReport.id);
  server = await startServer(workerEnvironment, managementOrigin);
  const historicBeforeReads = {
    ...historicBeforeAudit,
    artifactAudits: historicBeforeAudit.artifactAudits + 1,
  };
  expect(
    inspectReleaseInvariant(
      databaseFile,
      storageDir,
      projectId,
      historicVersionId
    )
  ).toEqual(historicBeforeReads);
  const historicRead = requireAuditReport(
    await expectJson(
      await sessionRequest(
        `/api/projects/${projectId}/versions/${historicVersionId}/audit`
      ),
      200,
      'read engine-v1 audit report'
    ),
    'engine-v1 audit report'
  );
  expect(historicRead).toMatchObject({
    id: historicReport.id,
    projectId,
    versionId: historicVersionId,
    status: 'warning',
    engineVersion: 1,
  });
  const historicAssessment = await expectJson(
    await sessionRequest(
      `/api/projects/${projectId}/versions/${historicVersionId}/audit-assessment`
    ),
    200,
    'assess engine-v1 audit report'
  );
  expect(historicAssessment).toMatchObject({
    freshness: 'stale',
    staleReasons: ['engine_changed'],
    currentEngineVersion: 2,
    release: { allowed: false, reason: 'audit_required' },
    report: { id: historicReport.id, engineVersion: 1 },
  });
  expect(
    inspectReleaseInvariant(
      databaseFile,
      storageDir,
      projectId,
      historicVersionId
    )
  ).toEqual(historicBeforeReads);

  return { server, logs };
}

async function updateAuditPolicy(
  sessionRequest: (path: string, init?: RequestInit) => Promise<Response>,
  projectId: string,
  policy: ArtifactAuditPolicySnapshot
): Promise<void> {
  const updated = await expectJson(
    await sessionRequest(`/api/projects/${projectId}/audit-policy`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    }),
    200,
    'update artifact audit policy'
  );
  expect(updated.auditPolicy).toEqual(policy);
}

async function uploadAuditFixture(
  managementOrigin: string,
  projectId: string,
  plaintextToken: string,
  idempotencyKey: string,
  marker: string
): Promise<string> {
  const uploaded = await uploadZip(
    managementOrigin,
    projectId,
    plaintextToken,
    idempotencyKey,
    `<!doctype html><html><head><title>${marker}</title></head><body>${marker}</body></html>`
  );
  expect(uploaded.response.status, `upload ${marker} audit fixture`).toBe(201);
  return requireCiUploadResult(uploaded.body).version.id;
}

async function publishVersion(
  sessionRequest: (path: string, init?: RequestInit) => Promise<Response>,
  projectId: string,
  versionId: string,
  expectedActiveVersionId: string | null
): Promise<Response> {
  return await sessionRequest(
    `/api/projects/${projectId}/versions/${versionId}/publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedActiveVersionId }),
    }
  );
}

async function expectAuditReleaseRejected(
  sessionRequest: (path: string, init?: RequestInit) => Promise<Response>,
  projectId: string,
  versionId: string,
  before: ReleaseInvariantState,
  databaseFile: string,
  storageDir: string,
  expectedCode: 'AUDIT_REQUIRED' | 'AUDIT_BLOCKED'
): Promise<void> {
  const body = await expectJson(
    await publishVersion(
      sessionRequest,
      projectId,
      versionId,
      before.activeVersionId
    ),
    409,
    `reject ${expectedCode} release`
  );
  expect((body.error as Record<string, unknown> | undefined)?.code).toBe(
    expectedCode
  );
  expect(
    inspectReleaseInvariant(databaseFile, storageDir, projectId, versionId)
  ).toEqual(before);
}

async function pollAuditJob(
  sessionRequest: (path: string, init?: RequestInit) => Promise<Response>,
  endpoint: string,
  jobId: string,
  timeoutMs: number
): Promise<ArtifactAuditJobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unread';
  while (Date.now() < deadline) {
    const job = requireAuditJob(
      await expectJson(
        await sessionRequest(`${endpoint}/${jobId}`),
        200,
        `poll exact audit job ${jobId}`
      ),
      `polled audit job ${jobId}`
    );
    expect(job.id).toBe(jobId);
    lastStatus = job.status;
    if (['succeeded', 'failed', 'canceled'].includes(job.status)) return job;
    await Bun.sleep(50);
  }
  throw new Error(
    `audit job ${jobId} did not complete within ${timeoutMs}ms (last status: ${lastStatus})`
  );
}

function inspectReleaseInvariant(
  databaseFile: string,
  storageDir: string,
  projectId: string,
  versionId: string
): ReleaseInvariantState {
  const database = new Database(databaseFile, { readonly: true });
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const project = database
      .query<{ active_version_id: string | null }, [string]>(
        'SELECT active_version_id FROM projects WHERE id = ?'
      )
      .get(projectId);
    const version = database
      .query<{ status: string }, [string, string]>(
        'SELECT status FROM versions WHERE project_id = ? AND id = ?'
      )
      .get(projectId, versionId);
    if (!project || !version) {
      throw new Error(
        `release invariant target ${projectId}/${versionId} missing`
      );
    }
    const count = (table: string): number => {
      const row = database
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
        .get();
      if (!row) throw new Error(`could not count ${table}`);
      return row.count;
    };
    const artifactRoot = join(storageDir, projectId, versionId);
    return {
      activeVersionId: project.active_version_id,
      versionStatus: version.status,
      artifactFiles: collectRegularFiles(artifactRoot)
        .sort()
        .map((path) => ({
          path: path.slice(artifactRoot.length + 1),
          bytes: readFileSync(path),
        })),
      artifactAuditJobs: count('artifact_audit_jobs'),
      artifactAudits: count('artifact_audits'),
    };
  } finally {
    database.close();
  }
}

function downgradeAuditReportEngine(
  databaseFile: string,
  reportId: string
): void {
  const database = new Database(databaseFile);
  try {
    const result = database
      .query('UPDATE artifact_audits SET engine_version = 1 WHERE id = ?')
      .run(reportId);
    expect(result.changes).toBe(1);
  } finally {
    database.close();
  }
}

function requireAuditJob(
  value: unknown,
  label: string
): ArtifactAuditJobSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} is missing`);
  }
  const job = value as ArtifactAuditJobSnapshot;
  requireString(job.id, `${label} id`);
  requireString(job.projectId, `${label} project id`);
  requireString(job.versionId, `${label} version id`);
  return job;
}

function requireAuditReport(
  value: unknown,
  label: string
): ArtifactAuditReportSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} is missing`);
  }
  const report = value as ArtifactAuditReportSnapshot;
  requireString(report.id, `${label} id`);
  requireString(report.projectId, `${label} project id`);
  requireString(report.versionId, `${label} version id`);
  return report;
}

async function createCredential(
  sessionRequest: (path: string, init?: RequestInit) => Promise<Response>,
  projectId: string,
  name: string
): Promise<IssuedCredential> {
  const body = await expectJson(
    await sessionRequest(`/api/projects/${projectId}/api-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
    201,
    'create API credential'
  );
  return {
    id: requireString(
      (body.token as Record<string, unknown> | undefined)?.id,
      'token id'
    ),
    plaintextToken: requireString(body.plaintextToken, 'plaintext token'),
  };
}

async function uploadZip(
  managementOrigin: string,
  projectId: string,
  plaintextToken: string,
  idempotencyKey: string,
  html: string
): Promise<{
  response: Response;
  body: CiUploadResult | ErrorEnvelope;
}> {
  const archive = zipSync(
    {
      'index.html': strToU8(html),
    },
    { level: 6 }
  );
  const form = new FormData();
  form.append(
    'file',
    new File([archive.buffer as ArrayBuffer], 'artifact.zip', {
      type: 'application/zip',
    })
  );
  form.append('versionDesc', 'production process smoke');
  const response = await fetch(
    `${managementOrigin}/api/ci/projects/${projectId}/versions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${plaintextToken}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: form,
    }
  );
  return {
    response,
    body: (await response.json()) as CiUploadResult | ErrorEnvelope,
  };
}

async function expectJson(
  response: Response,
  expectedStatus: number,
  label: string
): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status, label).toBe(expectedStatus);
  return body;
}

async function executeOps(
  environment: Record<string, string | undefined>,
  arguments_: string[]
): Promise<OpsProcessResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', 'ops', '--', ...arguments_],
    cwd: repositoryRoot,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  activeOpsProcesses.add(child);
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  try {
    const exitCode = await withTimeout(
      child.exited,
      15_000,
      `ops ${arguments_[0] ?? 'unknown'}`
    );
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    throw error;
  } finally {
    activeOpsProcesses.delete(child);
  }
}

async function runOps(
  environment: Record<string, string | undefined>,
  arguments_: string[]
): Promise<{ stdout: string; stderr: string }> {
  const result = await executeOps(environment, arguments_);
  expect(
    result.exitCode,
    `ops ${arguments_.join(' ')} failed\n${result.stdout}\n${result.stderr}`
  ).toBe(0);
  return result;
}

async function runOpsExpectFailure(
  environment: Record<string, string | undefined>,
  arguments_: string[]
): Promise<OpsProcessResult> {
  const result = await executeOps(environment, arguments_);
  expect(
    result.exitCode,
    `ops ${arguments_.join(' ')} unexpectedly succeeded\n${result.stdout}\n${result.stderr}`
  ).not.toBe(0);
  return result;
}

function inspectAutomationState(
  databaseFile: string,
  projectId: string
): AutomationState {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const project = database
      .query<{ active_version_id: string | null }, [string]>(
        'SELECT active_version_id FROM projects WHERE id = ?'
      )
      .get(projectId);
    if (!project) throw new Error(`project ${projectId} is missing`);
    const count = (table: string): number => {
      const row = database
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
        .get();
      if (!row) throw new Error(`could not count ${table}`);
      return row.count;
    };
    const schemaVersion = database
      .query<{ version: number | null }, []>(
        'SELECT MAX(version) AS version FROM schema_migrations'
      )
      .get()?.version;
    const integrity = database
      .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
      .get()?.integrity_check;
    return {
      activeVersionId: project.active_version_id,
      apiTokens: count('project_api_tokens'),
      apiTokenSecurityEvents: count('api_token_security_events'),
      artifactAuditJobs: count('artifact_audit_jobs'),
      artifactAudits: count('artifact_audits'),
      ciIdempotencyRecords: count('ci_idempotency_records'),
      versions: count('versions'),
      schemaVersion: schemaVersion ?? 0,
      integrity: integrity ?? 'missing',
      foreignKeyViolations: database
        .query<Record<string, unknown>, []>('PRAGMA foreign_key_check')
        .all().length,
    };
  } finally {
    database.close();
  }
}

function materializeSchemaV5Backup(destination: string): void {
  const databaseDirectory = join(destination, 'database');
  mkdirSync(databaseDirectory, { recursive: true });
  mkdirSync(join(destination, 'storage'), { recursive: true });
  copyFileSync(
    join(schemaV5FixtureRoot, 'manifest.json'),
    join(destination, 'manifest.json')
  );
  const database = new Database(
    join(databaseDirectory, 'deploykit-v5.sqlite'),
    { create: true }
  );
  try {
    database.exec(
      readFileSync(join(schemaV5FixtureRoot, 'schema.sql'), 'utf8')
    );
  } finally {
    database.close();
  }
}

function assertPathDoesNotContainSecrets(
  path: string,
  secrets: string[]
): void {
  const paths = statSync(path).isDirectory()
    ? collectRegularFiles(path)
    : [path];
  for (const file of paths) {
    const contents = readFileSync(file);
    for (const secret of secrets) {
      expect(
        contents.includes(Buffer.from(secret)),
        `plaintext credential found in ${file}`
      ).toBe(false);
    }
  }
}

function assertTextDoesNotContainSecrets(
  text: string,
  secrets: string[],
  source: string
): void {
  for (const secret of secrets) {
    expect(
      text.includes(secret),
      `plaintext credential found in ${source}`
    ).toBe(false);
  }
}

function collectRegularFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectRegularFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function requireCiUploadResult(
  body: CiUploadResult | ErrorEnvelope
): CiUploadResult {
  if (!('version' in body)) {
    throw new Error(`CI upload failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
