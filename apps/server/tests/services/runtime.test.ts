import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, linkSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkpointSqlite,
  createShutdownController,
  installShutdownHandlers,
  type RuntimeLogEntry,
} from '../../src/runtime';
import {
  acquireRuntimeOwnership,
  getRuntimeOwnershipPaths,
} from '../../src/services/runtimeOwnership';

describe('shutdown runtime', () => {
  test('drains once, checkpoints SQLite, and exits cleanly', async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const controller = createShutdownController({
      server: {
        stop: async (force) => {
          calls.push(force ? 'force-stop' : 'drain');
        },
      },
      databaseFile: '/tmp/deploykit.sqlite',
      timeoutMs: 1000,
      drainBackground: async () => {
        calls.push('worker-stop');
      },
      releaseOwnership: () => calls.push('release-ownership'),
      logger: () => {},
      checkpoint: (path) => calls.push(`checkpoint:${path}`),
      exit: (code) => exits.push(code),
    });

    await Promise.all([
      controller.shutdown('SIGTERM'),
      controller.shutdown('SIGINT'),
    ]);

    expect(calls).toEqual([
      'drain',
      'worker-stop',
      'checkpoint:/tmp/deploykit.sqlite',
      'release-ownership',
    ]);
    expect(exits).toEqual([0]);
    expect(controller.isShuttingDown()).toBe(true);
  });

  test('force-closes and exits non-zero after the drain timeout', async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const logs: RuntimeLogEntry[] = [];
    const controller = createShutdownController({
      server: {
        stop: (force) => {
          calls.push(force ? 'force-stop' : 'drain');
          return force ? Promise.resolve() : new Promise(() => {});
        },
      },
      databaseFile: '/tmp/deploykit.sqlite',
      timeoutMs: 25,
      logger: (entry) => logs.push(entry),
      checkpoint: () => calls.push('checkpoint'),
      releaseOwnership: () => calls.push('release-ownership'),
      exit: (code) => exits.push(code),
      scheduleTimeout: (callback) => {
        queueMicrotask(callback);
        return 'timer';
      },
      cancelTimeout: () => {},
    });

    await controller.shutdown('SIGTERM');

    expect(calls).toEqual(['drain', 'force-stop', 'checkpoint']);
    expect(exits).toEqual([1]);
    expect(logs.map((entry) => entry.event)).toEqual([
      'shutdown_started',
      'shutdown_timeout',
    ]);
  });

  test('stops background claims while active HTTP requests are still draining', async () => {
    const calls: string[] = [];
    let finishHttpDrain: (() => void) | undefined;
    const controller = createShutdownController({
      server: {
        stop: (force) => {
          calls.push(force ? 'force-stop' : 'drain');
          return force
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                finishHttpDrain = resolve;
              });
        },
      },
      drainBackground: async () => {
        calls.push('worker-stop');
      },
      releaseOwnership: () => calls.push('release-ownership'),
      timeoutMs: 1000,
      logger: () => {},
      exit: () => {},
    });

    const shutdown = controller.shutdown('SIGTERM');
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['drain', 'worker-stop']);
    finishHttpDrain?.();
    await shutdown;
    expect(calls).toEqual(['drain', 'worker-stop', 'release-ownership']);
  });

  test('force-closes and exits non-zero when the drain fails', async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const controller = createShutdownController({
      server: {
        stop: async (force) => {
          calls.push(force ? 'force-stop' : 'drain');
          if (!force) throw new Error('drain failed');
        },
      },
      timeoutMs: 1000,
      logger: () => {},
      releaseOwnership: () => calls.push('release-ownership'),
      exit: (code) => exits.push(code),
    });

    await controller.shutdown('SIGINT');
    expect(calls).toEqual(['drain', 'force-stop']);
    expect(exits).toEqual([1]);
  });

  test('force-closes and exits non-zero when background draining fails', async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const controller = createShutdownController({
      server: {
        stop: async (force) => {
          calls.push(force ? 'force-stop' : 'drain');
        },
      },
      drainBackground: async () => {
        calls.push('worker-stop');
        throw new Error('worker drain failed');
      },
      timeoutMs: 1000,
      logger: () => {},
      releaseOwnership: () => calls.push('release-ownership'),
      exit: (code) => exits.push(code),
    });

    await controller.shutdown('SIGTERM');
    expect(calls).toEqual(['drain', 'worker-stop', 'force-stop']);
    expect(exits).toEqual([1]);
  });

  test('checkpoints, retains ownership, and exits when force stop never settles', async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const controller = createShutdownController({
      server: {
        stop: (force) => {
          calls.push(force ? 'force-stop' : 'drain');
          return new Promise(() => {});
        },
      },
      databaseFile: '/tmp/deploykit.sqlite',
      timeoutMs: 25,
      forceCloseTimeoutMs: 25,
      logger: () => {},
      checkpoint: () => calls.push('checkpoint'),
      releaseOwnership: () => calls.push('release-ownership'),
      exit: (code) => exits.push(code),
      scheduleTimeout: (callback) => {
        queueMicrotask(callback);
        return 'timer';
      },
      cancelTimeout: () => {},
    });

    await controller.shutdown('SIGTERM');

    expect(calls).toEqual(['drain', 'force-stop', 'checkpoint']);
    expect(exits).toEqual([1]);
  });

  test('retains ownership when force stop rejects', async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const controller = createShutdownController({
      server: {
        stop: async (force) => {
          calls.push(force ? 'force-stop' : 'drain');
          if (force) throw new Error('force stop failed');
          throw new Error('drain failed');
        },
      },
      timeoutMs: 1000,
      logger: () => {},
      releaseOwnership: () => calls.push('release-ownership'),
      exit: (code) => exits.push(code),
    });

    await controller.shutdown('SIGTERM');

    expect(calls).toEqual(['drain', 'force-stop']);
    expect(exits).toEqual([1]);
  });

  test('runtime logging is best effort and cannot skip graceful cleanup', async () => {
    const calls: string[] = [];
    const exits: number[] = [];
    const controller = createShutdownController({
      server: {
        stop: async () => {
          calls.push('drain');
        },
      },
      databaseFile: '/tmp/deploykit.sqlite',
      timeoutMs: 1000,
      logger: () => {
        throw new Error('logger unavailable');
      },
      checkpoint: () => calls.push('checkpoint'),
      releaseOwnership: () => calls.push('release-ownership'),
      exit: (code) => exits.push(code),
    });

    await controller.shutdown('SIGTERM');

    expect(calls).toEqual(['drain', 'checkpoint', 'release-ownership']);
    expect(exits).toEqual([0]);
  });

  test('a fatal timeout keeps the real runtime lock until process exit', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-shutdown-lock-'));
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const storageDir = join(tempDir, 'storage');
    const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
    const exits: number[] = [];

    try {
      const controller = createShutdownController({
        server: {
          stop: (force) => (force ? Promise.resolve() : new Promise(() => {})),
        },
        databaseFile,
        timeoutMs: 25,
        releaseOwnership: () => ownership.release(),
        logger: () => {},
        exit: (code) => exits.push(code),
        scheduleTimeout: (callback) => {
          queueMicrotask(callback);
          return 'timer';
        },
        cancelTimeout: () => {},
      });

      await controller.shutdown('SIGTERM');

      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_HELD'
      );
      expect(exits).toEqual([1]);
    } finally {
      ownership.release();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('installs one-shot SIGINT and SIGTERM handlers', async () => {
    const emitter = new EventEmitter();
    const signals: string[] = [];
    const dispose = installShutdownHandlers(
      {
        shutdown: async (signal) => {
          signals.push(signal);
        },
        isShuttingDown: () => false,
      },
      emitter
    );

    emitter.emit('SIGTERM');
    emitter.emit('SIGTERM');
    emitter.emit('SIGINT');
    await Promise.resolve();
    expect(signals).toEqual(['SIGTERM', 'SIGINT']);
    dispose();
  });

  test('removes a partially installed signal handler when registration fails', () => {
    const calls: string[] = [];
    const signalProcess = {
      once(signal: 'SIGINT' | 'SIGTERM') {
        calls.push(`once:${signal}`);
        if (signal === 'SIGTERM') throw new Error('registration failed');
      },
      off(signal: 'SIGINT' | 'SIGTERM') {
        calls.push(`off:${signal}`);
      },
    };

    expect(() =>
      installShutdownHandlers(
        {
          shutdown: async () => {},
          isShuttingDown: () => false,
        },
        signalProcess
      )
    ).toThrow('registration failed');
    expect(calls).toEqual(['once:SIGINT', 'once:SIGTERM', 'off:SIGINT']);
  });
});

describe('runtime ownership', () => {
  test('atomically rejects a second live owner and can be acquired after release', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-ownership-'));
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const storageDir = join(tempDir, 'storage');
    try {
      const first = acquireRuntimeOwnership(databaseFile, storageDir);
      expect(() => acquireRuntimeOwnership(databaseFile, storageDir)).toThrow(
        'RUNTIME_OWNERSHIP_HELD'
      );
      first.release();

      const second = acquireRuntimeOwnership(databaseFile, storageDir);
      second.release();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('locks database and storage resources independently and uses sidecars', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-ownership-'));
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const storageDir = join(tempDir, 'storage');
    const otherDatabaseFile = join(tempDir, 'other.sqlite');
    const otherStorageDir = join(tempDir, 'other-storage');
    try {
      const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
      expect(() =>
        acquireRuntimeOwnership(databaseFile, otherStorageDir)
      ).toThrow('RUNTIME_OWNERSHIP_HELD');
      expect(() =>
        acquireRuntimeOwnership(otherDatabaseFile, storageDir)
      ).toThrow('RUNTIME_OWNERSHIP_HELD');
      expect(getRuntimeOwnershipPaths(databaseFile, storageDir)).toEqual(
        [...getRuntimeOwnershipPaths(databaseFile, storageDir)].sort()
      );
      for (const path of getRuntimeOwnershipPaths(databaseFile, storageDir)) {
        expect(path.startsWith(`${storageDir}/`)).toBe(false);
        expect(existsSync(path)).toBe(true);
      }

      ownership.release();
      const databaseReuse = acquireRuntimeOwnership(
        databaseFile,
        otherStorageDir
      );
      databaseReuse.release();
      const storageReuse = acquireRuntimeOwnership(
        otherDatabaseFile,
        storageDir
      );
      storageReuse.release();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects a hard-linked database alias without disturbing an existing owner', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-ownership-'));
    const databaseFile = join(tempDir, 'deploykit.sqlite');
    const databaseAlias = join(tempDir, 'deploykit-alias.sqlite');
    const storageDir = join(tempDir, 'storage');
    const aliasStorageDir = join(tempDir, 'alias-storage');
    let first: ReturnType<typeof acquireRuntimeOwnership> | undefined;

    try {
      first = acquireRuntimeOwnership(databaseFile, storageDir);
      const database = new Database(databaseFile, { create: true });
      database.exec('CREATE TABLE state (value TEXT NOT NULL)');
      database.close();
      linkSync(databaseFile, databaseAlias);

      const aliasError = acquireError(databaseAlias, aliasStorageDir);
      expect(errorMessage(aliasError)).toContain(
        'RUNTIME_DATABASE_HARDLINK_UNSAFE'
      );
      for (const lockPath of getRuntimeOwnershipPaths(
        databaseAlias,
        aliasStorageDir
      )) {
        expect(existsSync(lockPath)).toBe(false);
      }

      unlinkSync(databaseAlias);
      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_HELD'
      );
      first.release();
      first = undefined;

      const replacement = acquireRuntimeOwnership(databaseFile, storageDir);
      replacement.release();
    } finally {
      first?.release();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('checkpointSqlite flushes and truncates an existing WAL', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-checkpoint-'));
  const databaseFile = join(tempDir, 'deploykit.sqlite');
  try {
    const database = new Database(databaseFile, { create: true });
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('CREATE TABLE state (value TEXT NOT NULL)');
    database.query('INSERT INTO state (value) VALUES (?)').run('ready');
    expect(existsSync(`${databaseFile}-wal`)).toBe(true);

    checkpointSqlite(databaseFile);
    database.close();

    const reopened = new Database(databaseFile);
    expect(
      reopened.query<{ value: string }, []>('SELECT value FROM state').get()
    ).toEqual({ value: 'ready' });
    reopened.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function acquireError(databaseFile: string, storageDir: string): unknown {
  try {
    const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
    ownership.release();
    return null;
  } catch (error) {
    return error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
