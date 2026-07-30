import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

  test('rejects a database leaf symlink before touching its target or sidecars', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-database-link-'));
    try {
      const databaseTarget = join(tempDir, 'target.sqlite');
      const databaseFile = join(tempDir, 'deploykit.sqlite');
      const storageDir = join(tempDir, 'storage');
      createMarkerDatabase(databaseTarget);
      const targetBytes = readFileSync(databaseTarget);
      symlinkSync(databaseTarget, databaseFile);

      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(readFileSync(databaseTarget)).toEqual(targetBytes);
      expect(listDatabaseTables(databaseTarget)).toEqual(['marker']);
      expect(lstatSync(databaseFile).isSymbolicLink()).toBe(true);
      expect(existsSync(`${databaseFile}.runtime-lock.sqlite`)).toBe(false);
      expect(existsSync(`${storageDir}.runtime-lock.sqlite`)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects a storage leaf symlink before touching its target or sidecars', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-storage-link-'));
    try {
      const databaseFile = join(tempDir, 'deploykit.sqlite');
      const storageTarget = join(tempDir, 'storage-target');
      const storageDir = join(tempDir, 'storage');
      mkdirSync(storageTarget);
      symlinkSync(storageTarget, storageDir);

      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(lstatSync(storageDir).isSymbolicLink()).toBe(true);
      expect(existsSync(databaseFile)).toBe(false);
      expect(existsSync(`${databaseFile}.runtime-lock.sqlite`)).toBe(false);
      expect(existsSync(`${storageDir}.runtime-lock.sqlite`)).toBe(false);
      expect(existsSync(`${storageTarget}.runtime-lock.sqlite`)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects derived sidecar collisions before mutating the database or storage', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-ownership-layout-'));
    try {
      const storageDir = join(tempDir, 'storage');
      const databaseFile = `${storageDir}.runtime-lock.sqlite`;
      createMarkerDatabase(databaseFile);
      const databaseBytes = readFileSync(databaseFile);

      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(readFileSync(databaseFile)).toEqual(databaseBytes);
      expect(listDatabaseTables(databaseFile)).toEqual(['marker']);
      expect(existsSync(storageDir)).toBe(false);
      expect(existsSync(`${databaseFile}.runtime-lock.sqlite`)).toBe(false);

      const reverseDatabaseFile = join(tempDir, 'reverse.sqlite');
      const reverseStorageDir = `${reverseDatabaseFile}.runtime-lock.sqlite`;
      createMarkerDatabase(reverseDatabaseFile);
      const reverseDatabaseBytes = readFileSync(reverseDatabaseFile);

      expect(
        errorMessage(acquireError(reverseDatabaseFile, reverseStorageDir))
      ).toContain('RUNTIME_OWNERSHIP_LAYOUT_UNSAFE');
      expect(readFileSync(reverseDatabaseFile)).toEqual(reverseDatabaseBytes);
      expect(listDatabaseTables(reverseDatabaseFile)).toEqual(['marker']);
      expect(existsSync(reverseStorageDir)).toBe(false);
      expect(existsSync(`${reverseStorageDir}.runtime-lock.sqlite`)).toBe(
        false
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects Darwin Unicode-normalized missing-path aliases before mutation', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-ownership-unicode-'));
    try {
      if (!hasUnicodeNormalizationAliases(tempDir)) return;

      const databaseFile = join(tempDir, 'cafe\u0301', 'metadata.sqlite');
      const storageDir = join(tempDir, 'caf\u00e9');

      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'DATABASE_STORAGE_OVERLAP'
      );
      expect(existsSync(databaseFile)).toBe(false);
      expect(existsSync(storageDir)).toBe(false);
      expect(existsSync(`${databaseFile}.runtime-lock.sqlite`)).toBe(false);
      expect(existsSync(`${storageDir}.runtime-lock.sqlite`)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects database journal, WAL, and SHM collisions with storage before creating sidecars', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-ownership-layout-'));
    try {
      for (const suffix of ['-journal', '-wal', '-shm']) {
        const databaseFile = join(
          tempDir,
          `deploykit-${suffix.slice(1)}.sqlite`
        );
        const storageDir = `${databaseFile}${suffix}`;
        createMarkerDatabase(databaseFile);
        const databaseBytes = readFileSync(databaseFile);

        expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
          'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
        );
        expect(readFileSync(databaseFile)).toEqual(databaseBytes);
        expect(existsSync(storageDir)).toBe(false);
        expect(existsSync(`${databaseFile}.runtime-lock.sqlite`)).toBe(false);
        expect(existsSync(`${storageDir}.runtime-lock.sqlite`)).toBe(false);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const auxiliarySuffix of ['-journal', '-wal', '-shm']) {
    test(`rejects storage collision with an ownership sidecar ${auxiliarySuffix} file`, () => {
      const tempDir = mkdtempSync(
        join(tmpdir(), 'deploykit-ownership-auxiliary-')
      );
      try {
        const databaseFile = join(
          tempDir,
          `deploykit-${auxiliarySuffix.slice(1)}.sqlite`
        );
        const databaseSidecar = `${databaseFile}.runtime-lock.sqlite`;
        const storageDir = `${databaseSidecar}${auxiliarySuffix}`;
        createMarkerDatabase(databaseFile);
        const databaseBytes = readFileSync(databaseFile);

        expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
          'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
        );
        expect(readFileSync(databaseFile)).toEqual(databaseBytes);
        expect(listDatabaseTables(databaseFile)).toEqual(['marker']);
        expect(existsSync(storageDir)).toBe(false);
        expect(existsSync(databaseSidecar)).toBe(false);
        expect(existsSync(`${storageDir}.runtime-lock.sqlite`)).toBe(false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  test('rejects an ownership auxiliary symlink before touching its external target', () => {
    const tempDir = mkdtempSync(
      join(tmpdir(), 'deploykit-ownership-aux-link-')
    );
    try {
      const databaseFile = join(tempDir, 'deploykit.sqlite');
      const storageDir = join(tempDir, 'storage');
      const externalDatabase = join(tempDir, 'external.sqlite');
      createMarkerDatabase(externalDatabase);
      const externalBytes = readFileSync(externalDatabase);
      const [databaseSidecar, storageSidecar] = getRuntimeOwnershipPaths(
        databaseFile,
        storageDir
      );
      const journalPath = `${databaseSidecar}-journal`;
      symlinkSync(externalDatabase, journalPath);

      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(readFileSync(externalDatabase)).toEqual(externalBytes);
      expect(listDatabaseTables(externalDatabase)).toEqual(['marker']);
      expect(lstatSync(journalPath).isSymbolicLink()).toBe(true);
      expect(existsSync(databaseSidecar)).toBe(false);
      expect(existsSync(storageSidecar)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const variant of ['symlink-wal', 'hardlink-shm'] as const) {
    test(`rejects a production SQLite auxiliary ${variant} alias before sidecar creation`, () => {
      const tempDir = mkdtempSync(
        join(tmpdir(), 'deploykit-database-aux-alias-')
      );
      try {
        const databaseFile = join(tempDir, 'deploykit.sqlite');
        const storageDir = join(tempDir, 'storage');
        const externalDatabase = join(tempDir, 'external.sqlite');
        createMarkerDatabase(externalDatabase);
        const externalBytes = readFileSync(externalDatabase);
        const auxiliaryPath =
          variant === 'symlink-wal'
            ? `${databaseFile}-wal`
            : `${databaseFile}-shm`;
        if (variant === 'symlink-wal') {
          symlinkSync(externalDatabase, auxiliaryPath);
        } else {
          linkSync(externalDatabase, auxiliaryPath);
        }

        expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
          'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
        );
        expect(readFileSync(externalDatabase)).toEqual(externalBytes);
        expect(listDatabaseTables(externalDatabase)).toEqual(['marker']);
        expect(existsSync(`${databaseFile}.runtime-lock.sqlite`)).toBe(false);
        expect(existsSync(`${storageDir}.runtime-lock.sqlite`)).toBe(false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  test('rejects a sidecar symlink before changing its database target', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-sidecar-alias-'));
    try {
      const databaseFile = join(tempDir, 'deploykit.sqlite');
      const storageDir = join(tempDir, 'storage');
      const externalDatabase = join(tempDir, 'external.sqlite');
      createMarkerDatabase(databaseFile);
      createMarkerDatabase(externalDatabase);
      const databaseBytes = readFileSync(databaseFile);
      const externalBytes = readFileSync(externalDatabase);
      const [databaseSidecar, storageSidecar] = getRuntimeOwnershipPaths(
        databaseFile,
        storageDir
      );

      symlinkSync(databaseFile, databaseSidecar);
      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(readFileSync(databaseFile)).toEqual(databaseBytes);
      expect(listDatabaseTables(databaseFile)).toEqual(['marker']);
      expect(lstatSync(databaseSidecar).isSymbolicLink()).toBe(true);
      expect(existsSync(storageSidecar)).toBe(false);

      unlinkSync(databaseSidecar);
      symlinkSync(externalDatabase, databaseSidecar);
      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(readFileSync(externalDatabase)).toEqual(externalBytes);
      expect(listDatabaseTables(externalDatabase)).toEqual(['marker']);
      expect(lstatSync(databaseSidecar).isSymbolicLink()).toBe(true);
      expect(existsSync(storageSidecar)).toBe(false);

      unlinkSync(databaseSidecar);
      symlinkSync(join(tempDir, 'missing-target.sqlite'), databaseSidecar);
      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(readFileSync(databaseFile)).toEqual(databaseBytes);
      expect(lstatSync(databaseSidecar).isSymbolicLink()).toBe(true);
      expect(existsSync(storageSidecar)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects a hard-linked sidecar before changing its database target', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-sidecar-alias-'));
    try {
      const databaseFile = join(tempDir, 'deploykit.sqlite');
      const storageDir = join(tempDir, 'storage');
      const externalDatabase = join(tempDir, 'external.sqlite');
      createMarkerDatabase(databaseFile);
      createMarkerDatabase(externalDatabase);
      const externalBytes = readFileSync(externalDatabase);
      const [databaseSidecar, storageSidecar] = getRuntimeOwnershipPaths(
        databaseFile,
        storageDir
      );
      linkSync(externalDatabase, databaseSidecar);

      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(readFileSync(externalDatabase)).toEqual(externalBytes);
      expect(listDatabaseTables(externalDatabase)).toEqual(['marker']);
      expect(lstatSync(databaseSidecar).nlink).toBe(2);
      expect(existsSync(storageSidecar)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects a non-regular sidecar before creating another owned resource', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-sidecar-leaf-'));
    try {
      const databaseFile = join(tempDir, 'deploykit.sqlite');
      const storageDir = join(tempDir, 'storage');
      const [databaseSidecar, storageSidecar] = getRuntimeOwnershipPaths(
        databaseFile,
        storageDir
      );
      mkdirSync(databaseSidecar);

      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(lstatSync(databaseSidecar).isDirectory()).toBe(true);
      expect(existsSync(storageSidecar)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('preflights an unsafe second sidecar before creating the first', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-sidecar-order-'));
    try {
      const databaseFile = join(tempDir, 'deploykit.sqlite');
      const storageDir = join(tempDir, 'storage');
      const [firstSidecar, secondSidecar] = getRuntimeOwnershipPaths(
        databaseFile,
        storageDir
      );
      mkdirSync(secondSidecar);

      expect(errorMessage(acquireError(databaseFile, storageDir))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(existsSync(firstSidecar)).toBe(false);
      expect(lstatSync(secondSidecar).isDirectory()).toBe(true);
      expect(existsSync(databaseFile)).toBe(false);
      expect(existsSync(storageDir)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('reuses legal existing sidecars without replacing their filesystem identity', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-sidecar-reuse-'));
    try {
      const databaseFile = join(tempDir, 'deploykit.sqlite');
      const storageDir = join(tempDir, 'storage');
      const first = acquireRuntimeOwnership(databaseFile, storageDir);
      first.release();
      const sidecars = getRuntimeOwnershipPaths(databaseFile, storageDir);
      const identities = sidecars.map((path) => {
        const stats = lstatSync(path, { bigint: true });
        return `${stats.dev}:${stats.ino}`;
      });

      const second = acquireRuntimeOwnership(databaseFile, storageDir);
      second.release();

      expect(
        sidecars.map((path) => {
          const stats = lstatSync(path, { bigint: true });
          return `${stats.dev}:${stats.ino}`;
        })
      ).toEqual(identities);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('normalizes an existing ownership sidecar to DELETE journal mode', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-sidecar-mode-'));
    try {
      const databaseFile = join(tempDir, 'deploykit.sqlite');
      const storageDir = join(tempDir, 'storage');
      const [databaseSidecar] = getRuntimeOwnershipPaths(
        databaseFile,
        storageDir
      );
      const legacySidecar = new Database(databaseSidecar, { create: true });
      expect(
        legacySidecar
          .query<{ journal_mode: string }, []>('PRAGMA journal_mode = WAL')
          .get()?.journal_mode
      ).toBe('wal');
      legacySidecar.exec('CREATE TABLE legacy (value TEXT NOT NULL)');
      legacySidecar.close();

      const ownership = acquireRuntimeOwnership(databaseFile, storageDir);
      ownership.release();

      const normalizedSidecar = new Database(databaseSidecar);
      try {
        expect(
          normalizedSidecar
            .query<{ journal_mode: string }, []>('PRAGMA journal_mode')
            .get()?.journal_mode
        ).toBe('delete');
      } finally {
        normalizedSidecar.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects non-file database and non-directory storage leaves before sidecars', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'deploykit-resource-leaf-'));
    try {
      const databaseDirectory = join(tempDir, 'database-directory');
      const storageForDatabaseDirectory = join(tempDir, 'storage-one');
      mkdirSync(databaseDirectory);

      expect(
        errorMessage(
          acquireError(databaseDirectory, storageForDatabaseDirectory)
        )
      ).toContain('RUNTIME_OWNERSHIP_LAYOUT_UNSAFE');
      expect(existsSync(`${databaseDirectory}.runtime-lock.sqlite`)).toBe(
        false
      );
      expect(
        existsSync(`${storageForDatabaseDirectory}.runtime-lock.sqlite`)
      ).toBe(false);

      const databaseFile = join(tempDir, 'deploykit.sqlite');
      const storageFile = join(tempDir, 'storage-file');
      writeFileSync(storageFile, 'not a directory');

      expect(errorMessage(acquireError(databaseFile, storageFile))).toContain(
        'RUNTIME_OWNERSHIP_LAYOUT_UNSAFE'
      );
      expect(existsSync(`${databaseFile}.runtime-lock.sqlite`)).toBe(false);
      expect(existsSync(`${storageFile}.runtime-lock.sqlite`)).toBe(false);
      expect(readFileSync(storageFile, 'utf8')).toBe('not a directory');
    } finally {
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

function createMarkerDatabase(databaseFile: string): void {
  const database = new Database(databaseFile, { create: true });
  try {
    database.exec('CREATE TABLE marker (value TEXT NOT NULL)');
    database.query('INSERT INTO marker (value) VALUES (?)').run('untouched');
  } finally {
    database.close();
  }
}

function listDatabaseTables(databaseFile: string): string[] {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return database
      .query<{ name: string }, []>(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
         ORDER BY name`
      )
      .all()
      .map((row) => row.name);
  } finally {
    database.close();
  }
}

function hasUnicodeNormalizationAliases(directory: string): boolean {
  const composed = join(directory, 'unicode-caf\u00e9-probe');
  mkdirSync(composed);
  try {
    return existsSync(join(directory, 'unicode-cafe\u0301-probe'));
  } finally {
    rmSync(composed, { recursive: true, force: true });
  }
}
