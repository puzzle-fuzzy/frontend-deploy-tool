import { existsSync, writeFileSync } from 'node:fs';
import { createSqliteArtifactAuditJobRepository } from '../../src/repositories/sqliteArtifactAuditJobRepository';

const [command, databaseFile, identity, readyFile, goFile] =
  process.argv.slice(2);
if (!command || !databaseFile || !identity || !readyFile || !goFile) {
  throw new Error(
    'Expected command, database, identity, ready, and barrier paths'
  );
}

const repository = createSqliteArtifactAuditJobRepository({ databaseFile });
writeFileSync(readyFile, identity);
while (!existsSync(goFile)) {
  await Bun.sleep(5);
}
if (command === 'claim') {
  const result = repository.recoverAndClaim({
    workerId: identity,
    now: '2026-07-30T00:00:00.000Z',
    leaseMs: 90_000,
    engineVersion: 1,
    retryBaseDelayMs: 2_000,
  });
  process.stdout.write(
    JSON.stringify({
      identity,
      kind: result.job ? 'claimed' : 'empty',
      jobId: result.job?.id ?? null,
    })
  );
} else if (command === 'enqueue') {
  const result = repository.enqueue({
    projectId: 'project-1',
    versionId: 'version-1',
    requestedBy: 'user-1',
    priority: 0,
    maxAttempts: 3,
    now: '2026-07-30T00:00:00.000Z',
    jobId: `job-${identity}`,
    engineVersion: 1,
    artifactPresent: true,
    limits: { global: 10, requester: 10, project: 10 },
  });
  process.stdout.write(
    JSON.stringify({
      identity,
      kind: result.kind,
      jobId: 'job' in result ? result.job.id : null,
    })
  );
} else {
  throw new Error(`Unsupported process command: ${command}`);
}
