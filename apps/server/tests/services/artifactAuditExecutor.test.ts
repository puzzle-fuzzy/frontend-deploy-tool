import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSubprocessArtifactAuditExecutor } from '../../src/services/artifactAuditExecutor';
import type { ArtifactAuditExecutionResult } from '../../src/services/artifactAuditProtocol';
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

  test('returns known inspection faults through a safe terminal envelope', async () => {
    symlinkSync(
      join(artifactDir, 'index.html'),
      join(artifactDir, 'unsafe-alias.html')
    );
    const executor = createSubprocessArtifactAuditExecutor({
      timeoutMs: 5_000,
    });

    await expect(
      executor.execute(inputFixture('checksum'), new AbortController().signal)
    ).rejects.toMatchObject({
      name: 'ArtifactAuditExecutionError',
      code: 'AUDIT_ARTIFACT_UNSAFE',
      message: 'Artifact contains an unsafe filesystem entry',
      retryable: false,
    });

    const child = Bun.spawn({
      cmd: [process.execPath, productionProcessEntry()],
      stdin: new Blob([JSON.stringify(inputFixture('checksum'))]),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
        DEPLOYKIT_AUDIT_PROCESS: '1',
      },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: {
        code: 'AUDIT_ARTIFACT_UNSAFE',
        message: 'Artifact contains an unsafe filesystem entry',
        retryable: false,
      },
    });
    expect(stdout).not.toContain(artifactDir);
    expect(stdout).not.toContain('unsafe-alias.html');
  });

  test('classifies missing artifact files as terminal and redacts the path', async () => {
    const missingDir = join(tempDir, 'private', 'missing-artifact');
    const executor = createSubprocessArtifactAuditExecutor({
      timeoutMs: 5_000,
    });

    await expect(
      executor.execute(
        { ...inputFixture('checksum'), artifactDir: missingDir },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      code: 'AUDIT_ARTIFACT_UNREADABLE',
      message: 'Artifact files could not be read',
      retryable: false,
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
      code: 'AUDIT_ENGINE_FAILED',
      message: 'Artifact audit engine failed',
      retryable: true,
    });
    await expect(promise).rejects.not.toThrow(artifactDir);
  });

  test('treats malformed and schema-invalid output as terminal protocol failure', async () => {
    for (const stdout of [
      'not-json',
      JSON.stringify(auditResultFixture()),
      JSON.stringify({
        ok: false,
        error: {
          code: 'AUDIT_ARTIFACT_UNSAFE',
          message: artifactDir,
          retryable: false,
        },
      }),
    ]) {
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
        code: 'AUDIT_ENGINE_OUTPUT_INVALID',
        message: 'Artifact audit subprocess returned an invalid result',
        retryable: false,
      });
    }
  });

  test('rejects an oversized otherwise valid envelope as terminal', async () => {
    const stdout = JSON.stringify({ ok: true, result: auditResultFixture() });
    const executor = createSubprocessArtifactAuditExecutor({
      maxOutputBytes: new TextEncoder().encode(stdout).byteLength - 1,
      spawn: async () => ({
        exitCode: 0,
        signalCode: null,
        stdout,
        stderr: '',
      }),
    });

    await expect(
      executor.execute(inputFixture('checksum'), new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_OUTPUT_INVALID',
      retryable: false,
    });
  });

  test('classifies a real Bun stdout maxBuffer overflow as terminal', async () => {
    const processEntry = join(tempDir, 'overflow-process.ts');
    writeFileSync(
      processEntry,
      'process.stdout.write("x".repeat(16 * 1024 * 1024)); await Bun.sleep(1_000);'
    );
    const executor = createSubprocessArtifactAuditExecutor({
      processEntry,
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    });

    await expect(
      executor.execute(inputFixture('checksum'), new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_OUTPUT_INVALID',
      message: 'Artifact audit subprocess returned an invalid result',
      retryable: false,
    });
  });

  test('does not infer stdout overflow from a generic maxBuffer failure', async () => {
    const executor = createSubprocessArtifactAuditExecutor({
      spawn: async () => {
        throw new Error('generic maxBuffer failure');
      },
    });

    await expect(
      executor.execute(inputFixture('checksum'), new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_FAILED',
      message: 'Artifact audit engine failed',
      retryable: true,
    });
  });

  test('accepts only an explicitly identified stdout maxBuffer failure', async () => {
    const overflow = Object.assign(
      new Error('stdout maxBuffer length exceeded'),
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }
    );
    const executor = createSubprocessArtifactAuditExecutor({
      spawn: async () => {
        throw overflow;
      },
    });

    await expect(
      executor.execute(inputFixture('checksum'), new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_OUTPUT_INVALID',
      retryable: false,
    });
  });

  test('redacts a real unexpected child crash as retryable infrastructure failure', async () => {
    const processEntry = join(tempDir, 'crash-process.ts');
    writeFileSync(
      processEntry,
      'const input = JSON.parse(await Bun.stdin.text()); throw new Error("crashed at " + input.artifactDir);'
    );
    const executor = createSubprocessArtifactAuditExecutor({
      processEntry,
      timeoutMs: 5_000,
    });

    const promise = executor.execute(
      inputFixture('checksum'),
      new AbortController().signal
    );
    await expect(promise).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_FAILED',
      message: 'Artifact audit engine failed',
      retryable: true,
    });
    await expect(promise).rejects.not.toThrow(artifactDir);
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
    ).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_FAILED',
      message: 'Artifact audit engine failed',
      retryable: true,
    });
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
      code: 'AUDIT_ENGINE_FAILED',
      message: 'Artifact audit engine failed',
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

function productionProcessEntry(): string {
  return fileURLToPath(
    new URL('../../src/workers/artifactAuditProcess.ts', import.meta.url)
  );
}

function auditResultFixture(): ArtifactAuditExecutionResult {
  return {
    artifactChecksum: 'checksum',
    status: 'passed',
    score: 100,
    summary: {
      fileCount: 1,
      totalBytes: 128,
      largestFiles: [{ path: 'index.html', size: 128 }],
      extensions: [{ extension: '.html', bytes: 128, count: 1 }],
      assetBytes: {
        javascript: 0,
        stylesheet: 0,
        font: 0,
        image: 0,
      },
    },
    checks: [],
  };
}
