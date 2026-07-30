import { fileURLToPath } from 'node:url';
import type { ArtifactAuditResult } from './artifactAuditEngine';
import {
  type ArtifactAuditExecutionInput,
  artifactAuditExecutionInputSchema,
  artifactAuditExecutionResultSchema,
} from './artifactAuditProtocol';

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ArtifactAuditExecutor {
  execute(
    input: ArtifactAuditExecutionInput,
    signal: AbortSignal
  ): Promise<ArtifactAuditResult>;
}

interface ArtifactAuditProcessResult {
  exitCode: number | null;
  signalCode: number | null;
  stdout: string;
  stderr: string;
}

interface ArtifactAuditSpawnOptions {
  input: ArtifactAuditExecutionInput;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  processEntry: string;
}

type ArtifactAuditProcessSpawner = (
  options: ArtifactAuditSpawnOptions
) => Promise<ArtifactAuditProcessResult>;

interface SubprocessArtifactAuditExecutorOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  processEntry?: string;
  spawn?: ArtifactAuditProcessSpawner;
}

export class ArtifactAuditExecutionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'ArtifactAuditExecutionError';
    this.retryable = retryable;
  }
}

export function createSubprocessArtifactAuditExecutor(
  options: SubprocessArtifactAuditExecutorOptions = {}
): ArtifactAuditExecutor {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const processEntry =
    options.processEntry ??
    fileURLToPath(
      new URL('../workers/artifactAuditProcess.ts', import.meta.url)
    );
  const spawn = options.spawn ?? spawnArtifactAuditProcess;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Artifact audit timeout must be a positive integer');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error('Artifact audit output budget must be a positive integer');
  }

  return {
    async execute(input, signal) {
      if (signal.aborted) throw abortError();
      const parsedInput = artifactAuditExecutionInputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new ArtifactAuditExecutionError(
          'Artifact audit execution input is invalid',
          false
        );
      }

      let processResult: ArtifactAuditProcessResult;
      try {
        processResult = await spawn({
          input: parsedInput.data,
          signal,
          timeoutMs,
          maxOutputBytes,
          processEntry,
        });
      } catch (error) {
        if (signal.aborted || isAbortError(error)) throw abortError();
        throw new ArtifactAuditExecutionError(
          'Artifact audit subprocess could not be started',
          true
        );
      }
      if (signal.aborted) throw abortError();
      if (processResult.exitCode !== 0) {
        throw new ArtifactAuditExecutionError(
          'Artifact audit subprocess exited unsuccessfully',
          true
        );
      }
      if (
        new TextEncoder().encode(processResult.stdout).byteLength >
        maxOutputBytes
      ) {
        throw invalidResultError();
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(processResult.stdout);
      } catch {
        throw invalidResultError();
      }
      const result = artifactAuditExecutionResultSchema.safeParse(decoded);
      if (!result.success) throw invalidResultError();
      return result.data;
    },
  };
}

async function spawnArtifactAuditProcess({
  input,
  signal,
  timeoutMs,
  maxOutputBytes,
  processEntry,
}: ArtifactAuditSpawnOptions): Promise<ArtifactAuditProcessResult> {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, processEntry],
    stdin: new Blob([JSON.stringify(input)], { type: 'application/json' }),
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: maxOutputBytes,
    env: {
      PATH: process.env.PATH ?? '',
      DEPLOYKIT_AUDIT_PROCESS: '1',
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return {
    exitCode,
    signalCode:
      typeof subprocess.signalCode === 'number' ? subprocess.signalCode : null,
    stdout,
    stderr: truncateDiagnostic(stderr),
  };
}

function invalidResultError(): ArtifactAuditExecutionError {
  return new ArtifactAuditExecutionError(
    'Artifact audit subprocess returned an invalid result',
    false
  );
}

function truncateDiagnostic(value: string): string {
  return value.slice(0, 2_048);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('Artifact audit execution was aborted', 'AbortError');
}
