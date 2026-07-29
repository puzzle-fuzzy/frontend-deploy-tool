import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SafeUser } from '@deploykit/shared';
import { Hono } from 'hono';
import { ApiError } from '../../src/errors';
import { createUploadGate } from '../../src/middleware/uploadLimits';
import type { AppEnv } from '../../src/services/contracts';
import { adminToken, createAuthApp, withBearer } from './helpers';

const user: SafeUser = {
  id: 'user-1',
  name: 'User',
  email: 'user@example.test',
  role: 'developer',
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
};

test('rejects a multipart request before formData parsing when it is oversized', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-upload-limit-'));
  try {
    const app = createAuthApp({
      dataFile: join(tempDir, 'data.json'),
      storageDir: join(tempDir, 'storage'),
      publicDir: join(tempDir, 'public'),
      maxUploadRequestSize: 32,
    });
    const token = await adminToken(app);
    const projectResponse = await app.request(
      '/api/projects',
      withBearer(
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Demo',
            slug: 'demo-app',
            description: '',
          }),
        },
        token
      )
    );
    const project = await projectResponse.json();

    const response = await app.request(
      `/api/projects/${project.id}/versions`,
      withBearer(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'multipart/form-data; boundary=test',
            'Content-Length': '33',
          },
          body: 'x'.repeat(33),
        },
        token
      )
    );

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('UPLOAD_TOO_LARGE');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('limits concurrent uploads globally and per project', async () => {
  let unblock: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const gate = createUploadGate({
    maxConcurrentUploads: 1,
    maxConcurrentUploadsPerUser: 1,
    maxConcurrentUploadsPerProject: 1,
  });
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', user);
      await next();
    })
    .post('/api/projects/:id/versions', gate, async (c) => {
      signalStarted?.();
      await blocked;
      return c.json({ ok: true });
    })
    .onError((error, c) => {
      if (error instanceof ApiError) {
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status
        );
      }
      throw error;
    });

  const first = app.request('/api/projects/project-1/versions', {
    method: 'POST',
  });
  await started;
  const second = await app.request('/api/projects/project-1/versions', {
    method: 'POST',
  });
  unblock?.();

  expect(second.status).toBe(429);
  expect((await second.json()).error.code).toBe('UPLOAD_BUSY');
  expect((await first).status).toBe(200);
});
