import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSubprocessArtifactAuditExecutor } from '../../src/services/artifactAuditExecutor';
import {
  type ArtifactAuditExecutionResult,
  artifactAuditProcessEnvelopeSchema,
} from '../../src/services/artifactAuditProtocol';
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
        stdout: bytes(''),
        stderr: bytes(`failed at ${artifactDir}/index.html`),
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
          stdout: bytes(stdout),
          stderr: bytes(''),
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
        stdout: bytes(stdout),
        stderr: bytes(''),
      }),
    });

    await expect(
      executor.execute(inputFixture('checksum'), new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_OUTPUT_INVALID',
      retryable: false,
    });
  });

  test('bounds a real Bun stdout overflow, kills it, and waits for cleanup', async () => {
    const processEntry = join(tempDir, 'overflow-process.ts');
    const pidFile = join(tempDir, 'overflow.pid');
    writeFileSync(
      processEntry,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(
        pidFile
      )}, String(process.pid)); for (;;) process.stdout.write("x".repeat(64 * 1024));`
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
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    expect(Number.isSafeInteger(childPid)).toBe(true);
    expect(isProcessAlive(childPid)).toBe(false);
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

  test('rejects invalid UTF-8 from a real child as terminal protocol output', async () => {
    const processEntry = join(tempDir, 'invalid-utf8-process.ts');
    writeFileSync(
      processEntry,
      'process.stdout.write(Uint8Array.from([123, 34, 111, 107, 34, 58, 195, 40, 125]));'
    );
    const executor = createSubprocessArtifactAuditExecutor({
      processEntry,
      timeoutMs: 5_000,
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

  test('drains oversized stderr without deriving the public failure message from it', async () => {
    const processEntry = join(tempDir, 'stderr-process.ts');
    writeFileSync(
      processEntry,
      `process.stderr.write(${JSON.stringify(artifactDir)} + "x".repeat(16 * 1024 * 1024)); process.exit(1);`
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

  test('rejects unknown keys at every nested success-envelope layer', async () => {
    const mutations: Array<(result: ArtifactAuditExecutionResult) => unknown> =
      [
        (result) => ({ ...result, unknownResult: true }),
        (result) => ({
          ...result,
          summary: { ...result.summary, unknownSummary: true },
        }),
        (result) => ({
          ...result,
          summary: {
            ...result.summary,
            assetBytes: { ...result.summary.assetBytes, unknownAsset: true },
          },
        }),
        (result) => ({
          ...result,
          summary: {
            ...result.summary,
            largestFiles: [
              { ...result.summary.largestFiles[0], unknownFile: true },
            ],
          },
        }),
        (result) => ({
          ...result,
          summary: {
            ...result.summary,
            extensions: [
              { ...result.summary.extensions[0], unknownExtension: true },
            ],
          },
        }),
        (result) => ({
          ...result,
          checks: [{ ...result.checks[0], unknownCheck: true }],
        }),
      ];

    for (const mutate of mutations) {
      const envelope = {
        ok: true,
        result: mutate(auditResultFixture()),
      };
      expect(
        artifactAuditProcessEnvelopeSchema.safeParse(envelope).success
      ).toBe(false);
      const stdout = JSON.stringify(envelope);
      const executor = createSubprocessArtifactAuditExecutor({
        spawn: async () => ({
          exitCode: 0,
          signalCode: null,
          stdout: bytes(stdout),
          stderr: bytes(''),
        }),
      });
      await expect(
        executor.execute(inputFixture('checksum'), new AbortController().signal)
      ).rejects.toMatchObject({
        code: 'AUDIT_ENGINE_OUTPUT_INVALID',
        retryable: false,
      });
    }
  });

  test('requires process output fields that historic schemas default', async () => {
    const result = auditResultFixture();
    const withoutAssetBytes = structuredClone(
      result
    ) as Partial<ArtifactAuditExecutionResult>;
    if (withoutAssetBytes.summary) {
      const summary = withoutAssetBytes.summary as Partial<
        ArtifactAuditExecutionResult['summary']
      >;
      delete summary.assetBytes;
    }
    const withoutRuleVersion = structuredClone(result);
    const check = withoutRuleVersion.checks[0] as Partial<
      ArtifactAuditExecutionResult['checks'][number]
    >;
    delete check.ruleVersion;

    for (const invalid of [withoutAssetBytes, withoutRuleVersion]) {
      expect(
        artifactAuditProcessEnvelopeSchema.safeParse({
          ok: true,
          result: invalid,
        }).success
      ).toBe(false);
      const executor = createSubprocessArtifactAuditExecutor({
        spawn: async () => ({
          exitCode: 0,
          signalCode: null,
          stdout: bytes(JSON.stringify({ ok: true, result: invalid })),
          stderr: bytes(''),
        }),
      });
      await expect(
        executor.execute(inputFixture('checksum'), new AbortController().signal)
      ).rejects.toMatchObject({ code: 'AUDIT_ENGINE_OUTPUT_INVALID' });
    }
  });

  test('configures defensive maxBuffer above the logical protocol limit', async () => {
    let observed:
      | { logical: number; defensive: number | undefined }
      | undefined;
    const executor = createSubprocessArtifactAuditExecutor({
      maxOutputBytes: 1_024,
      spawn: async (options) => {
        observed = {
          logical: options.maxOutputBytes,
          defensive: options.maxBufferBytes,
        };
        return {
          exitCode: 0,
          signalCode: null,
          stdout: bytes(
            JSON.stringify({ ok: true, result: auditResultFixture() })
          ),
          stderr: bytes(''),
        };
      },
    });

    await executor.execute(
      inputFixture('checksum'),
      new AbortController().signal
    );
    expect(observed?.logical).toBe(1_024);
    expect(observed?.defensive).toBeGreaterThan(1_024);
  });

  test('keeps stdout overflow terminal when stderr reading rejects', async () => {
    const race = createTerminationRaceProcess([bytes('x'.repeat(2_048))]);
    const executor = createSubprocessArtifactAuditExecutor({
      maxOutputBytes: 1_024,
      timeoutMs: 5_000,
      spawnProcess: () => race.process,
    });

    const startedAt = performance.now();
    const execution = executor.execute(
      inputFixture('checksum'),
      new AbortController().signal
    );
    await race.killed;
    race.settle({ stderrError: new Error('stderr reader failed') });

    await expect(execution).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_OUTPUT_INVALID',
      retryable: false,
    });
    expect(race.killCount()).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test('keeps stdout overflow terminal when exit observation rejects', async () => {
    const race = createTerminationRaceProcess([bytes('x'.repeat(2_048))]);
    const executor = createSubprocessArtifactAuditExecutor({
      maxOutputBytes: 1_024,
      timeoutMs: 5_000,
      spawnProcess: () => race.process,
    });

    const startedAt = performance.now();
    const execution = executor.execute(
      inputFixture('checksum'),
      new AbortController().signal
    );
    await race.killed;
    race.settle({ exitError: new Error('exit observation failed') });

    await expect(execution).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_OUTPUT_INVALID',
      retryable: false,
    });
    expect(race.killCount()).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test('keeps stdout overflow terminal when timeout fires during cleanup', async () => {
    const race = createTerminationRaceProcess([bytes('x'.repeat(2_048))]);
    const executor = createSubprocessArtifactAuditExecutor({
      maxOutputBytes: 1_024,
      timeoutMs: 10,
      spawnProcess: () => race.process,
    });

    const startedAt = performance.now();
    const execution = executor.execute(
      inputFixture('checksum'),
      new AbortController().signal
    );
    await race.killed;
    await Bun.sleep(20);
    race.settle();

    await expect(execution).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_OUTPUT_INVALID',
      retryable: false,
    });
    expect(race.killCount()).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test('requests one kill when stdout overflow races an independent abort', async () => {
    const controller = new AbortController();
    const race = createTerminationRaceProcess([bytes('x'.repeat(2_048))]);
    const executor = createSubprocessArtifactAuditExecutor({
      maxOutputBytes: 1_024,
      timeoutMs: 5_000,
      spawnProcess: () => race.process,
    });

    const startedAt = performance.now();
    const execution = executor.execute(
      inputFixture('checksum'),
      controller.signal
    );
    await race.killed;
    controller.abort();
    race.settle();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(race.killCount()).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test('requests one kill when timeout races an independent abort', async () => {
    const controller = new AbortController();
    const race = createTerminationRaceProcess();
    const executor = createSubprocessArtifactAuditExecutor({
      timeoutMs: 10,
      spawnProcess: () => race.process,
    });

    const startedAt = performance.now();
    const execution = executor.execute(
      inputFixture('checksum'),
      controller.signal
    );
    await race.killed;
    controller.abort();
    race.settle();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(race.killCount()).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test('keeps a reader AbortError retryable without a caller abort', async () => {
    const race = createTerminationRaceProcess();
    const executor = createSubprocessArtifactAuditExecutor({
      timeoutMs: 10,
      spawnProcess: () => race.process,
    });

    const startedAt = performance.now();
    const execution = executor.execute(
      inputFixture('checksum'),
      new AbortController().signal
    );
    await race.killed;
    race.settle({
      stderrError: new DOMException('Reader was canceled', 'AbortError'),
    });

    await expect(execution).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_FAILED',
      retryable: true,
    });
    expect(race.killCount()).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test('keeps a stderr reader rejection retryable without overflow', async () => {
    const race = createTerminationRaceProcess();
    const executor = createSubprocessArtifactAuditExecutor({
      timeoutMs: 5_000,
      spawnProcess: () => race.process,
    });

    const execution = executor.execute(
      inputFixture('checksum'),
      new AbortController().signal
    );
    race.settle({ stderrError: new Error('stderr reader failed') });

    await expect(execution).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_FAILED',
      retryable: true,
    });
    expect(race.killCount()).toBe(1);
  });

  test('keeps an exit observation rejection retryable without overflow', async () => {
    const race = createTerminationRaceProcess();
    const executor = createSubprocessArtifactAuditExecutor({
      timeoutMs: 5_000,
      spawnProcess: () => race.process,
    });

    const execution = executor.execute(
      inputFixture('checksum'),
      new AbortController().signal
    );
    race.settle({ exitError: new Error('exit observation failed') });

    await expect(execution).rejects.toMatchObject({
      code: 'AUDIT_ENGINE_FAILED',
      retryable: true,
    });
    expect(race.killCount()).toBe(1);
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
    checks: [
      {
        id: 'structure.checksum',
        ruleVersion: 1,
        category: 'structure',
        severity: 'info',
        passed: true,
        message: 'Artifact checksum matches the uploaded version',
      },
    ],
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createTerminationRaceProcess(stdoutChunks: Uint8Array[] = []) {
  let stdoutController: ReadableStreamDefaultController<Uint8Array>;
  let stderrController: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit: (exitCode: number) => void;
  let rejectExit: (error: unknown) => void;
  let resolveKilled: () => void;
  let killCount = 0;
  let processSettled = false;
  const killed = new Promise<void>((resolve) => {
    resolveKilled = resolve;
  });
  const exited = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(streamController) {
      stdoutController = streamController;
      for (const chunk of stdoutChunks) streamController.enqueue(chunk);
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(streamController) {
      stderrController = streamController;
    },
  });
  return {
    process: {
      stdout,
      stderr,
      exited,
      signalCode: null,
      kill() {
        killCount += 1;
        resolveKilled();
      },
    },
    killed,
    killCount: () => killCount,
    settle({
      stderrError,
      exitError,
    }: {
      stderrError?: unknown;
      exitError?: unknown;
    } = {}) {
      if (processSettled) return;
      processSettled = true;
      stdoutController.close();
      if (stderrError) stderrController.error(stderrError);
      else stderrController.close();
      if (exitError) rejectExit(exitError);
      else resolveExit(137);
    },
  };
}
