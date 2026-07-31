import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  ciIdempotencyRecords: number;
  versions: number;
  schemaVersion: number;
  integrity: string;
  foreignKeyViolations: number;
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

  capturedLogs.push(await stopServer(server));
  const beforeBackup = inspectAutomationState(databaseFile, projectId);
  expect(beforeBackup).toMatchObject({
    activeVersionId: null,
    apiTokens: 2,
    ciIdempotencyRecords: 3,
    versions: 3,
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
        ciIdempotencyRecords: number;
      };
    };
  };
  expect(backupBody.manifest).toMatchObject({
    schemaVersion: 7,
    metadataCounts: {
      apiTokens: beforeBackup.apiTokens,
      apiTokenSecurityEvents: beforeBackup.apiTokenSecurityEvents,
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
}, 60_000);

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

async function runOps(
  environment: Record<string, string | undefined>,
  arguments_: string[]
): Promise<{ stdout: string; stderr: string }> {
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
    expect(
      exitCode,
      `ops ${arguments_.join(' ')} failed\n${stdout}\n${stderr}`
    ).toBe(0);
    return { stdout, stderr };
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await child.exited;
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    throw error;
  } finally {
    activeOpsProcesses.delete(child);
  }
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
