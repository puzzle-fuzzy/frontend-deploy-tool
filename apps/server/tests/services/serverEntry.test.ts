import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployKitRuntime } from '../../src/app';
import type { ServerConfig } from '../../src/config';
import { createShutdownController } from '../../src/runtime';
import { startDeployKitServer } from '../../src/serverEntry';
import { acquireRuntimeOwnership } from '../../src/services/runtimeOwnership';

const config: ServerConfig = {
  environment: 'test',
  port: 4010,
  databaseFile: '/tmp/deploykit-entry.sqlite',
  dataFile: '/tmp/deploykit-entry.json',
  storageDir: '/tmp/deploykit-entry-storage',
  publicDir: '/tmp/deploykit-entry-public',
  adminEmail: 'admin@test.local',
  adminPassword: 'test-password',
  sessionSecret: 'server-entry-test-secret',
  secureCookies: false,
  registrationEnabled: false,
};

describe('startDeployKitServer', () => {
  test('releases ownership when serve throws synchronously', async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime(calls);

    await expect(
      startDeployKitServer(config, runtime, {
        serve: () => {
          calls.push('serve');
          throw new Error('serve failed');
        },
        installHandlers: () => {
          calls.push('install-handlers');
          return () => calls.push('dispose-handlers');
        },
        logger: () => {},
      })
    ).rejects.toThrow('serve failed');

    expect(calls).toEqual(['serve', 'worker-stop', 'release-ownership']);
  });

  test('starts serve, handlers, worker and startup logging in one boundary', async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime(calls);

    const started = await startDeployKitServer(config, runtime, {
      serve: ({ port }) => {
        calls.push(`serve:${port}`);
        return { stop: async () => {} };
      },
      installHandlers: () => {
        calls.push('install-handlers');
        return () => calls.push('dispose-handlers');
      },
      logger: (entry) => calls.push(`log:${entry.event}`),
    });

    expect(calls).toEqual([
      'serve:4010',
      'install-handlers',
      'worker-start',
      'log:server_started',
    ]);
    started.disposeSignalHandlers();
    expect(calls.at(-1)).toBe('dispose-handlers');
  });

  test('propagates an injected logger from server start through graceful shutdown', async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime(calls);
    const started = await startDeployKitServer(config, runtime, {
      serve: () => ({
        stop: async (force) => {
          calls.push(force ? 'force-stop' : 'drain');
        },
      }),
      installHandlers: () => () => calls.push('dispose-handlers'),
      createShutdown: (options) =>
        createShutdownController({
          ...options,
          checkpoint: () => calls.push('checkpoint'),
          exit: (code) => calls.push(`exit:${code}`),
        }),
      logger: (entry) => calls.push(`log:${entry.event}`),
    });

    await started.shutdown.shutdown('SIGTERM');

    expect(calls).toEqual([
      'worker-start',
      'log:server_started',
      'log:shutdown_started',
      'drain',
      'worker-stop',
      'checkpoint',
      'release-ownership',
      'log:shutdown_completed',
      'exit:0',
    ]);
  });

  test('cleans every post-serve resource when worker start fails', async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime(calls, {
      start() {
        calls.push('worker-start');
        throw new Error('worker start failed');
      },
    });

    await expect(
      startDeployKitServer(config, runtime, {
        serve: () => ({
          stop: async (force) => {
            calls.push(force ? 'force-stop' : 'drain');
          },
        }),
        installHandlers: () => {
          calls.push('install-handlers');
          return () => calls.push('dispose-handlers');
        },
        logger: () => {},
      })
    ).rejects.toThrow('worker start failed');

    expect(calls).toEqual([
      'install-handlers',
      'worker-start',
      'dispose-handlers',
      'force-stop',
      'worker-stop',
      'release-ownership',
    ]);
  });

  test('retains ownership when post-serve cleanup promises never settle', async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime(calls, {
      start() {
        calls.push('worker-start');
        throw new Error('worker start failed');
      },
      stop() {
        calls.push('worker-stop');
        return new Promise(() => {});
      },
    });

    await expect(
      startDeployKitServer(config, runtime, {
        serve: () => ({
          stop: (force) => {
            calls.push(force ? 'force-stop' : 'drain');
            return new Promise(() => {});
          },
        }),
        installHandlers: () => () => calls.push('dispose-handlers'),
        logger: () => {},
        cleanupTimeoutMs: 1,
        scheduleTimeout: (callback) => {
          queueMicrotask(callback);
          return 'timer';
        },
        cancelTimeout: () => {},
      })
    ).rejects.toThrow('worker start failed');

    expect(calls).toContain('force-stop');
    expect(calls).toContain('worker-stop');
    expect(calls).not.toContain('release-ownership');
  });

  test('retains a real ownership lock when startup cleanup times out', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-entry-lock-'));
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const storageDir = join(tempDir, 'storage');
    const runtimeConfig = { ...config, databaseFile, storageDir };
    const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
    const calls: string[] = [];
    const runtime = fakeRuntime(calls, {
      start() {
        throw new Error('worker start failed');
      },
      stop() {
        return new Promise(() => {});
      },
    });
    runtime.runtimeOwnership = ownership;

    try {
      await expect(
        startDeployKitServer(runtimeConfig, runtime, {
          serve: () => ({ stop: () => new Promise(() => {}) }),
          installHandlers: () => () => {},
          logger: () => {},
          cleanupTimeoutMs: 1,
          scheduleTimeout: (callback) => {
            queueMicrotask(callback);
            return 'timer';
          },
          cancelTimeout: () => {},
        })
      ).rejects.toThrow('worker start failed');

      expect(ownershipError(databaseFile, storageDir)).toContain(
        'RUNTIME_OWNERSHIP_HELD'
      );
    } finally {
      ownership.release();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('retains a real ownership lock when startup cleanup rejects', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-entry-lock-'));
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const storageDir = join(tempDir, 'storage');
    const runtimeConfig = { ...config, databaseFile, storageDir };
    const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
    const calls: string[] = [];
    const runtime = fakeRuntime(calls, {
      start() {
        throw new Error('worker start failed');
      },
    });
    runtime.runtimeOwnership = ownership;

    try {
      await expect(
        startDeployKitServer(runtimeConfig, runtime, {
          serve: () => ({
            stop: async () => {
              throw new Error('server stop failed');
            },
          }),
          installHandlers: () => () => {},
          logger: () => {},
        })
      ).rejects.toThrow('worker start failed');

      expect(ownershipError(databaseFile, storageDir)).toContain(
        'RUNTIME_OWNERSHIP_HELD'
      );
    } finally {
      ownership.release();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('cleans every started resource when startup logging fails', async () => {
    const calls: string[] = [];
    const runtime = fakeRuntime(calls);

    await expect(
      startDeployKitServer(config, runtime, {
        serve: () => ({
          stop: async (force) => {
            calls.push(force ? 'force-stop' : 'drain');
          },
        }),
        installHandlers: () => () => calls.push('dispose-handlers'),
        logger: () => {
          calls.push('startup-log');
          throw new Error('log failed');
        },
      })
    ).rejects.toThrow('log failed');

    expect(calls).toEqual([
      'worker-start',
      'startup-log',
      'dispose-handlers',
      'force-stop',
      'worker-stop',
      'release-ownership',
    ]);
  });
});

function fakeRuntime(
  calls: string[],
  workerOverrides: Partial<DeployKitRuntime['artifactAuditWorker']> = {}
): DeployKitRuntime {
  return {
    app: { fetch: (() => new Response()) as DeployKitRuntime['app']['fetch'] },
    artifactAuditWorker: {
      start: () => calls.push('worker-start'),
      stop: async () => {
        calls.push('worker-stop');
      },
      cancel: () => {},
      ...workerOverrides,
    },
    runtimeOwnership: {
      release: () => calls.push('release-ownership'),
    },
  } as unknown as DeployKitRuntime;
}

function ownershipError(databaseFile: string, storageDir: string): string {
  try {
    const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
    ownership.release();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
