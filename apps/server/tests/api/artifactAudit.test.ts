import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArtifactAuditJob,
  ArtifactAuditPolicy,
  ArtifactAuditReport,
  Project,
} from '@deploykit/shared';
import { createDeployKitRuntime } from '../../src/app';
import { createSqliteProjectRepository } from '../../src/repositories/sqliteProjectRepository';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  adminToken,
  loginAs,
  withBearer,
} from './helpers';

let tempDir: string;
let runtime: ReturnType<typeof createDeployKitRuntime>;
let app: ReturnType<typeof createDeployKitRuntime>['app'];
let token: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-audit-api-'));
  runtime = createDeployKitRuntime({
    databaseFile: join(tempDir, 'deploykit.sqlite'),
    dataFile: join(tempDir, 'data.json'),
    storageDir: join(tempDir, 'storage'),
    publicDir: join(tempDir, 'public'),
    environment: 'test',
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: 'test-session-secret',
    secureCookies: false,
    registrationEnabled: true,
  });
  app = runtime.app;
  token = await adminToken(app);
});

afterEach(async () => {
  await runtime.artifactAuditWorker.stop();
  runtime.runtimeOwnership.release();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('artifact audit API', () => {
  test('runs, persists, retrieves, and records a version audit', async () => {
    const { project, versionId } = await createUploadedVersion('audit-api');

    const missing = await app.request(
      `/api/projects/${project.id}/versions/${versionId}/audit`,
      withBearer(undefined, token)
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('AUDIT_NOT_FOUND');

    const created = await app.request(
      `/api/projects/${project.id}/versions/${versionId}/audit`,
      withBearer({ method: 'POST' }, token)
    );
    expect(created.status).toBe(201);
    const report = (await created.json()) as ArtifactAuditReport;
    expect(report).toMatchObject({
      projectId: project.id,
      versionId,
      status: 'warning',
      engineVersion: 1,
      policy: project.auditPolicy,
    });

    const fetched = await app.request(
      `/api/projects/${project.id}/versions/${versionId}/audit`,
      withBearer(undefined, token)
    );
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(report);

    const history = await app.request(
      `/api/projects/${project.id}/history`,
      withBearer(undefined, token)
    );
    expect((await history.json()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'version.audit',
          versionId,
          metadata: expect.objectContaining({
            reportId: report.id,
            status: report.status,
            score: report.score,
          }),
        }),
      ])
    );
  });

  test('enqueues, deduplicates, polls, and completes a durable audit job', async () => {
    const { project, versionId } = await createUploadedVersion('audit-job-api');
    const endpoint = `/api/projects/${project.id}/versions/${versionId}/audit-jobs`;

    const enqueued = await app.request(
      endpoint,
      withBearer({ method: 'POST' }, token)
    );
    expect(enqueued.status).toBe(202);
    const first = (await enqueued.json()) as {
      job: ArtifactAuditJob;
      reused: boolean;
    };
    expect(first).toMatchObject({
      reused: false,
      job: {
        projectId: project.id,
        versionId,
        requestedBy: expect.any(String),
        status: 'queued',
      },
    });

    const duplicate = await app.request(
      endpoint,
      withBearer({ method: 'POST' }, token)
    );
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({
      reused: true,
      job: { id: first.job.id },
    });

    const queued = await app.request(
      `${endpoint}/${first.job.id}`,
      withBearer(undefined, token)
    );
    expect(queued.status).toBe(200);
    expect((await queued.json()).status).toBe('queued');

    expect(await runtime.artifactAuditWorker.runOnce()).toBe(true);
    const completed = await app.request(
      `${endpoint}/${first.job.id}`,
      withBearer(undefined, token)
    );
    expect(completed.status).toBe(200);
    const completedJob = (await completed.json()) as ArtifactAuditJob;
    expect(completedJob).toMatchObject({
      id: first.job.id,
      status: 'succeeded',
      reportId: expect.any(String),
      errorCode: null,
      errorMessage: null,
    });

    const report = await app.request(
      `/api/projects/${project.id}/versions/${versionId}/audit`,
      withBearer(undefined, token)
    );
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({
      id: completedJob.reportId,
      projectId: project.id,
      versionId,
    });
  });

  test('cancels queued jobs and validates every job path identifier', async () => {
    const { project, versionId } =
      await createUploadedVersion('cancel-audit-job');
    const endpoint = `/api/projects/${project.id}/versions/${versionId}/audit-jobs`;
    const enqueued = await app.request(
      endpoint,
      withBearer({ method: 'POST' }, token)
    );
    const { job } = (await enqueued.json()) as { job: ArtifactAuditJob };

    const canceled = await app.request(
      `${endpoint}/${job.id}`,
      withBearer({ method: 'DELETE' }, token)
    );
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toMatchObject({
      id: job.id,
      status: 'canceled',
      lockedBy: null,
      lockedUntil: null,
    });
    expect(await runtime.artifactAuditWorker.runOnce()).toBe(false);

    const malformed = await app.request(
      `${endpoint}/bad!job`,
      withBearer(undefined, token)
    );
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe('INVALID_PARAMS');
  });

  test('validates owner policy updates and records the policy event', async () => {
    const { project } = await createUploadedVersion('policy-api');
    const invalid = await app.request(
      `/api/projects/${project.id}/audit-policy`,
      withBearer(
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enforcement: 'blocking',
            maxTotalBytes: 0,
            maxFileBytes: 1,
            maxFileCount: 1,
          }),
        },
        token
      )
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe('INVALID_AUDIT_POLICY');

    const policy: ArtifactAuditPolicy = {
      enforcement: 'blocking',
      maxTotalBytes: 2_000_000,
      maxFileBytes: 1_000_000,
      maxFileCount: 100,
    };
    const updated = await updatePolicy(project.id, policy);
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as Project).auditPolicy).toEqual(policy);

    const history = await app.request(
      `/api/projects/${project.id}/history`,
      withBearer(undefined, token)
    );
    expect((await history.json()).items[0]).toMatchObject({
      action: 'project.update_audit_policy',
      metadata: {
        auditPolicy: policy,
        previousPolicy: project.auditPolicy,
      },
    });
  });

  test('enforces missing, failed, and stale reports only in blocking mode', async () => {
    const missing = await createUploadedVersion('missing-audit');
    await updatePolicy(missing.project.id, {
      ...missing.project.auditPolicy,
      enforcement: 'blocking',
    });
    expect(
      (
        await publish(
          missing.project.id,
          missing.versionId,
          missing.project.activeVersionId
        )
      ).status
    ).toBe(409);
    expect(
      (
        await (
          await publish(
            missing.project.id,
            missing.versionId,
            missing.project.activeVersionId
          )
        ).json()
      ).error.code
    ).toBe('AUDIT_REQUIRED');

    const failed = await createUploadedVersion('failed-audit');
    await updatePolicy(failed.project.id, {
      enforcement: 'blocking',
      maxTotalBytes: 1,
      maxFileBytes: 1,
      maxFileCount: 1,
    });
    const failedAudit = await app.request(
      `/api/projects/${failed.project.id}/versions/${failed.versionId}/audit`,
      withBearer({ method: 'POST' }, token)
    );
    expect((await failedAudit.json()).status).toBe('failed');
    const blocked = await publish(
      failed.project.id,
      failed.versionId,
      failed.project.activeVersionId
    );
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe('AUDIT_BLOCKED');

    const stale = await createUploadedVersion('stale-audit');
    await app.request(
      `/api/projects/${stale.project.id}/versions/${stale.versionId}/audit`,
      withBearer({ method: 'POST' }, token)
    );
    await updatePolicy(stale.project.id, {
      enforcement: 'blocking',
      maxTotalBytes: stale.project.auditPolicy.maxTotalBytes - 1,
      maxFileBytes: stale.project.auditPolicy.maxFileBytes,
      maxFileCount: stale.project.auditPolicy.maxFileCount,
    });
    const staleRelease = await publish(
      stale.project.id,
      stale.versionId,
      stale.project.activeVersionId
    );
    expect(staleRelease.status).toBe(409);
    expect((await staleRelease.json()).error.code).toBe('AUDIT_REQUIRED');
  });

  test('allows a warning report after switching from advisory to blocking', async () => {
    const { project, versionId } = await createUploadedVersion('warning-audit');
    const audited = await app.request(
      `/api/projects/${project.id}/versions/${versionId}/audit`,
      withBearer({ method: 'POST' }, token)
    );
    expect((await audited.json()).status).toBe('warning');
    await updatePolicy(project.id, {
      ...project.auditPolicy,
      enforcement: 'blocking',
    });

    const released = await publish(
      project.id,
      versionId,
      project.activeVersionId
    );
    expect(released.status).toBe(200);
  });

  test('keeps report reads project-scoped and audit writes member-scoped', async () => {
    const { project, versionId } = await createUploadedVersion('audit-access');
    const registration = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Outsider',
        email: 'outsider@example.com',
        password: 'outsider-password',
      }),
    });
    expect(registration.status).toBe(200);
    const outsiderToken = await loginAs(
      app,
      'outsider@example.com',
      'outsider-password'
    );

    for (const method of ['GET', 'POST']) {
      const response = await app.request(
        `/api/projects/${project.id}/versions/${versionId}/audit`,
        withBearer({ method }, outsiderToken)
      );
      expect(response.status).toBe(403);
    }
    const queued = await app.request(
      `/api/projects/${project.id}/versions/${versionId}/audit-jobs`,
      withBearer({ method: 'POST' }, token)
    );
    const { job } = (await queued.json()) as { job: ArtifactAuditJob };
    for (const [path, method] of [
      [
        `/api/projects/${project.id}/versions/${versionId}/audit-jobs/${job.id}`,
        'GET',
      ],
      [`/api/projects/${project.id}/versions/${versionId}/audit-jobs`, 'POST'],
    ] as const) {
      const response = await app.request(
        path,
        withBearer({ method }, outsiderToken)
      );
      expect(response.status).toBe(403);
    }

    const added = await app.request(
      `/api/projects/${project.id}/members`,
      withBearer(
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'outsider@example.com',
            role: 'member',
          }),
        },
        token
      )
    );
    expect(added.status).toBe(200);
    const audit = await app.request(
      `/api/projects/${project.id}/versions/${versionId}/audit`,
      withBearer({ method: 'POST' }, outsiderToken)
    );
    expect(audit.status).toBe(201);
    const memberJob = await app.request(
      `/api/projects/${project.id}/versions/${versionId}/audit-jobs`,
      withBearer({ method: 'POST' }, outsiderToken)
    );
    expect(memberJob.status).toBe(202);
    expect(await memberJob.json()).toMatchObject({
      reused: true,
      job: { id: job.id },
    });

    const repo = createSqliteProjectRepository({
      databaseFile: join(tempDir, 'deploykit.sqlite'),
      legacyDataFile: join(tempDir, 'data.json'),
    });
    repo.mutate((data) => {
      const outsider = data.users.find(
        (user) => user.email === 'outsider@example.com'
      );
      if (!outsider) throw new Error('outsider fixture missing');
      outsider.role = 'viewer';
    });
    const viewerRead = await app.request(
      `/api/projects/${project.id}/versions/${versionId}/audit-jobs/${job.id}`,
      withBearer(undefined, outsiderToken)
    );
    expect(viewerRead.status).toBe(200);
    for (const method of ['POST', 'DELETE']) {
      const path =
        method === 'POST'
          ? `/api/projects/${project.id}/versions/${versionId}/audit-jobs`
          : `/api/projects/${project.id}/versions/${versionId}/audit-jobs/${job.id}`;
      const response = await app.request(
        path,
        withBearer({ method }, outsiderToken)
      );
      expect(response.status).toBe(403);
    }
    const policy = await app.request(
      `/api/projects/${project.id}/audit-policy`,
      withBearer(
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(project.auditPolicy),
        },
        outsiderToken
      )
    );
    expect(policy.status).toBe(403);
  });
});

async function createUploadedVersion(slug: string): Promise<{
  project: Project;
  versionId: string;
}> {
  const created = await app.request(
    '/api/projects',
    withBearer(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: slug, slug, description: '' }),
      },
      token
    )
  );
  const project = (await created.json()) as Project;
  const form = new FormData();
  form.append(
    'folderFiles',
    new File(
      [
        '<html lang="en"><head><title>Preview</title><meta name="viewport" content="width=device-width"></head><body><h1>Preview</h1></body></html>',
      ],
      'index.html'
    )
  );
  form.append('versionDesc', 'audit candidate');
  const uploaded = await app.request(
    `/api/projects/${project.id}/versions`,
    withBearer({ method: 'POST', body: form }, token)
  );
  expect(uploaded.status).toBe(201);
  return {
    project,
    versionId: (await uploaded.json()).version.id as string,
  };
}

async function updatePolicy(
  projectId: string,
  policy: ArtifactAuditPolicy
): Promise<Response> {
  return await app.request(
    `/api/projects/${projectId}/audit-policy`,
    withBearer(
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      },
      token
    )
  );
}

async function publish(
  projectId: string,
  versionId: string,
  expectedActiveVersionId: string | null
): Promise<Response> {
  return await app.request(
    `/api/projects/${projectId}/versions/${versionId}/publish`,
    withBearer(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedActiveVersionId }),
      },
      token
    )
  );
}
