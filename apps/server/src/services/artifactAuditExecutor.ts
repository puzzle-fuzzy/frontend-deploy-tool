import { fileURLToPath } from 'node:url';
import type { ArtifactAuditResult } from './artifactAuditEngine';
import {
  ARTIFACT_AUDIT_PROCESS_ERROR_MESSAGES,
  type ArtifactAuditExecutionInput,
  type ArtifactAuditProcessErrorCode,
  artifactAuditExecutionInputSchema,
  artifactAuditProcessEnvelopeSchema,
} from './artifactAuditProtocol';

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STDERR_DIAGNOSTIC_BYTES = 2_048;
const MAX_BUFFER_SLACK_BYTES = 64 * 1024;

export interface ArtifactAuditExecutor {
  execute(
    input: ArtifactAuditExecutionInput,
    signal: AbortSignal
  ): Promise<ArtifactAuditResult>;
}

interface ArtifactAuditProcessResult {
  exitCode: number | null;
  signalCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  stdoutExceeded?: boolean;
  timedOut?: boolean;
}

interface ArtifactAuditSpawnOptions {
  input: ArtifactAuditExecutionInput;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  maxBufferBytes: number;
  processEntry: string;
}

interface ArtifactAuditChildProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  signalCode: number | string | null;
  kill(signal?: number | string): void;
}

interface ArtifactAuditChildProcessSpawnOptions {
  cmd: string[];
  stdin: Blob;
  stdout: 'pipe';
  stderr: 'pipe';
  killSignal: string;
  maxBuffer: number;
  env: Record<string, string>;
}

type ArtifactAuditChildProcessSpawner = (
  options: ArtifactAuditChildProcessSpawnOptions
) => ArtifactAuditChildProcess;

type ArtifactAuditProcessSpawner = (
  options: ArtifactAuditSpawnOptions
) => Promise<ArtifactAuditProcessResult>;

interface SubprocessArtifactAuditExecutorOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  processEntry?: string;
  spawn?: ArtifactAuditProcessSpawner;
  spawnProcess?: ArtifactAuditChildProcessSpawner;
}

export class ArtifactAuditExecutionError extends Error {
  readonly code: ArtifactAuditProcessErrorCode;
  readonly retryable: boolean;

  constructor(code: ArtifactAuditProcessErrorCode, retryable: boolean) {
    super(ARTIFACT_AUDIT_PROCESS_ERROR_MESSAGES[code]);
    this.name = 'ArtifactAuditExecutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function createSubprocessArtifactAuditExecutor(
  options: SubprocessArtifactAuditExecutorOptions = {}
): ArtifactAuditExecutor {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxBufferBytes = maxOutputBytes + MAX_BUFFER_SLACK_BYTES;
  const processEntry =
    options.processEntry ??
    fileURLToPath(
      new URL('../workers/artifactAuditProcess.ts', import.meta.url)
    );
  const spawnProcess = options.spawnProcess ?? spawnBunArtifactAuditProcess;
  const spawn =
    options.spawn ??
    ((spawnOptions) => spawnArtifactAuditProcess(spawnOptions, spawnProcess));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Artifact audit timeout must be a positive integer');
  }
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    !Number.isSafeInteger(maxBufferBytes)
  ) {
    throw new Error('Artifact audit output budget must be a positive integer');
  }

  return {
    async execute(input, signal) {
      if (signal.aborted) throw abortError();
      const parsedInput = artifactAuditExecutionInputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new ArtifactAuditExecutionError('AUDIT_ENGINE_FAILED', false);
      }

      let processResult: ArtifactAuditProcessResult;
      try {
        processResult = await spawn({
          input: parsedInput.data,
          signal,
          timeoutMs,
          maxOutputBytes,
          maxBufferBytes,
          processEntry,
        });
      } catch (error) {
        if (signal.aborted) throw abortError();
        if (isExplicitStdoutMaxBufferError(error)) throw invalidResultError();
        throw infrastructureError();
      }
      if (signal.aborted) throw abortError();
      if (
        processResult.stdoutExceeded === true ||
        processResult.stdout.byteLength > maxOutputBytes
      ) {
        throw invalidResultError();
      }
      if (processResult.timedOut) throw infrastructureError();
      if (processResult.exitCode !== 0) throw infrastructureError();

      let stdout: string;
      try {
        stdout = new TextDecoder('utf-8', { fatal: true }).decode(
          processResult.stdout
        );
      } catch {
        throw invalidResultError();
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(stdout);
      } catch {
        throw invalidResultError();
      }
      const envelope = artifactAuditProcessEnvelopeSchema.safeParse(decoded);
      if (!envelope.success) throw invalidResultError();
      if (!envelope.data.ok) {
        throw new ArtifactAuditExecutionError(
          envelope.data.error.code,
          envelope.data.error.retryable
        );
      }
      return envelope.data.result;
    },
  };
}

async function spawnArtifactAuditProcess(
  {
    input,
    signal,
    timeoutMs,
    maxOutputBytes,
    maxBufferBytes,
    processEntry,
  }: ArtifactAuditSpawnOptions,
  spawnProcess: ArtifactAuditChildProcessSpawner
): Promise<ArtifactAuditProcessResult> {
  const subprocess = spawnProcess({
    cmd: [process.execPath, processEntry],
    stdin: new Blob([JSON.stringify(input)], { type: 'application/json' }),
    stdout: 'pipe',
    stderr: 'pipe',
    killSignal: 'SIGKILL',
    maxBuffer: maxBufferBytes,
    env: {
      PATH: process.env.PATH ?? '',
      DEPLOYKIT_AUDIT_PROCESS: '1',
    },
  });
  let timedOut = false;
  let settled = false;
  let killRequested = false;
  const kill = () => {
    if (settled || killRequested) return;
    killRequested = true;
    try {
      subprocess.kill('SIGKILL');
    } catch {
      // A concurrent exit is equivalent to successful cleanup.
    }
  };
  const abort = () => kill();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  timeout.unref?.();

  const stdoutPromise = readBoundedStream(
    subprocess.stdout,
    maxOutputBytes + 1,
    maxOutputBytes,
    kill
  ).catch((error) => {
    kill();
    throw error;
  });
  const stderrPromise = readBoundedStream(
    subprocess.stderr,
    STDERR_DIAGNOSTIC_BYTES
  ).catch((error) => {
    kill();
    throw error;
  });
  const exitPromise = subprocess.exited.catch((error) => {
    kill();
    throw error;
  });

  try {
    const [stdoutResult, stderrResult, exitResult] = await Promise.allSettled([
      stdoutPromise,
      stderrPromise,
      exitPromise,
    ]);
    if (signal.aborted) throw abortError();
    if (stdoutResult.status === 'fulfilled' && stdoutResult.value.exceeded) {
      settled = true;
      return {
        exitCode: exitResult.status === 'fulfilled' ? exitResult.value : null,
        signalCode:
          typeof subprocess.signalCode === 'number'
            ? subprocess.signalCode
            : null,
        stdout: stdoutResult.value.bytes,
        stderr:
          stderrResult.status === 'fulfilled'
            ? stderrResult.value.bytes
            : new Uint8Array(),
        stdoutExceeded: true,
        timedOut,
      };
    }
    if (stdoutResult.status === 'rejected') throw stdoutResult.reason;
    if (stderrResult.status === 'rejected') throw stderrResult.reason;
    if (exitResult.status === 'rejected') throw exitResult.reason;
    settled = true;
    return {
      exitCode: exitResult.value,
      signalCode:
        typeof subprocess.signalCode === 'number'
          ? subprocess.signalCode
          : null,
      stdout: stdoutResult.value.bytes,
      stderr: stderrResult.value.bytes,
      stdoutExceeded: stdoutResult.value.exceeded,
      timedOut,
    };
  } finally {
    settled = true;
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

function spawnBunArtifactAuditProcess(
  options: ArtifactAuditChildProcessSpawnOptions
): ArtifactAuditChildProcess {
  return Bun.spawn(options);
}

function invalidResultError(): ArtifactAuditExecutionError {
  return new ArtifactAuditExecutionError('AUDIT_ENGINE_OUTPUT_INVALID', false);
}

function infrastructureError(): ArtifactAuditExecutionError {
  return new ArtifactAuditExecutionError('AUDIT_ENGINE_FAILED', true);
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  retainBytes: number,
  excessThreshold = Number.POSITIVE_INFINITY,
  onFirstExcess?: () => void
): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  const retained = new Uint8Array(retainBytes);
  const reader = stream.getReader();
  let retainedLength = 0;
  let observedLength = 0;
  let exceeded = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      observedLength += value.byteLength;
      const writable = Math.min(value.byteLength, retainBytes - retainedLength);
      if (writable > 0) {
        retained.set(value.subarray(0, writable), retainedLength);
        retainedLength += writable;
      }
      if (!exceeded && observedLength > excessThreshold) {
        exceeded = true;
        onFirstExcess?.();
      }
    }
  } catch (error) {
    if (!exceeded) throw error;
  } finally {
    reader.releaseLock();
  }
  return {
    bytes: retained.subarray(0, retainedLength),
    exceeded,
  };
}

function isExplicitStdoutMaxBufferError(error: unknown): boolean {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  ) {
    return false;
  }
  if ('stream' in error && error.stream === 'stdout') return true;
  return (
    error instanceof Error &&
    error.message === 'stdout maxBuffer length exceeded'
  );
}

function abortError(): DOMException {
  return new DOMException('Artifact audit execution was aborted', 'AbortError');
}
