import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactAuditExecutionError,
  createSubprocessArtifactAuditExecutor,
} from '../../src/services/artifactAuditExecutor';
import { checksumDirectory } from '../../src/services/artifactService';

let tempDir: string;
let artifactDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deploykit-audit-executor-'));
  artifactDir = join(tempDir, 'artifact');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, 'index.html'),
    '<html lang="en"><head><title>Executor test page</title></head><body><h1>Test</h1></body></html>'
  );
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('createSubprocessArtifactAuditExecutor', () => {
  test('executes the production entrypoint and validates its result', async () => {
    const checksum = checksumDirectory(artifactDir);
    const executor = createSubprocessArtifactAuditExecutor({
      timeoutMs: 5_000,
    });

    const result = await executor.execute(
      inputFixture(checksum),
      new AbortController().signal
    );

    expect(result).toMatchObject({
      artifactChecksum: checksum,
      status: 'warning',
      summary: {
        fileCount: 1,
        totalBytes: expect.any(Number),
      },
    });
  });

  test('returns a stable retryable error for non-zero process exit', async () => {
    const executor = createSubprocessArtifactAuditExecutor({
      spawn: async () => ({
        exitCode: 1,
        signalCode: null,
        stdout: '',
        stderr: `failed at ${artifactDir}/index.html`,
      }),
    });

    const promise = executor.execute(
      inputFixture(checksumDirectory(artifactDir)),
      new AbortController().signal
    );
    await expect(promise).rejects.toMatchObject({
      name: 'ArtifactAuditExecutionError',
      message: 'Artifact audit subprocess exited unsuccessfully',
      retryable: true,
    });
    await expect(promise).rejects.not.toThrow(artifactDir);
  });

  test('treats invalid and oversized protocol output as non-retryable', async () => {
    for (const stdout of ['not-json', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
      const executor = createSubprocessArtifactAuditExecutor({
        spawn: async () => ({
          exitCode: 0,
          signalCode: null,
          stdout,
          stderr: '',
        }),
      });

      await expect(
        executor.execute(
          inputFixture(checksumDirectory(artifactDir)),
          new AbortController().signal
        )
      ).rejects.toMatchObject({
        name: 'ArtifactAuditExecutionError',
        message: 'Artifact audit subprocess returned an invalid result',
        retryable: false,
      });
    }
  });

  test('propagates abort without converting it into a retryable failure', async () => {
    const controller = new AbortController();
    const executor = createSubprocessArtifactAuditExecutor({
      spawn: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        }),
    });

    const execution = executor.execute(
      inputFixture(checksumDirectory(artifactDir)),
      controller.signal
    );
    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('kills a subprocess that exceeds its execution timeout', async () => {
    const processEntry = join(tempDir, 'slow-process.ts');
    writeFileSync(processEntry, 'await Bun.sleep(60_000);');
    const executor = createSubprocessArtifactAuditExecutor({
      processEntry,
      timeoutMs: 20,
    });

    const startedAt = performance.now();
    await expect(
      executor.execute(
        inputFixture(checksumDirectory(artifactDir)),
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(ArtifactAuditExecutionError);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test('rejects malformed execution input before spawning', async () => {
    let spawned = false;
    const executor = createSubprocessArtifactAuditExecutor({
      spawn: async () => {
        spawned = true;
        throw new Error('must not spawn');
      },
    });

    await expect(
      executor.execute(
        { ...inputFixture('checksum'), artifactDir: '' },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      name: 'ArtifactAuditExecutionError',
      retryable: false,
    });
    expect(spawned).toBe(false);
  });
});

function inputFixture(expectedChecksum: string) {
  return {
    artifactDir,
    expectedChecksum,
    policy: {
      enforcement: 'advisory' as const,
      maxTotalBytes: 50 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      maxFileCount: 1_000,
      maxJavaScriptBytes: 10 * 1024 * 1024,
      maxStylesheetBytes: 2 * 1024 * 1024,
      maxFontBytes: 10 * 1024 * 1024,
    },
    context: { spaMode: false, routingType: 'path' as const },
  };
}
