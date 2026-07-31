interface OperationalOwnership<TMigrationGuard> {
  readonly migrationGuard: TMigrationGuard;
  release(): void;
}

interface OperationalSecondaryFailure {
  readonly step: 'release';
  readonly resource: 'runtime-ownership';
  readonly error: unknown;
}

type ErrorWithOperationalSecondaryFailures = Error & {
  cause?: unknown;
  operationalSecondaryFailures?: OperationalSecondaryFailure[];
};

type OperationalOutcome<T> =
  | { kind: 'success'; value: T }
  | { kind: 'failure'; error: unknown };

export function executeOwnedOperation<T, TMigrationGuard>(
  ownership: OperationalOwnership<TMigrationGuard>,
  operation: (migrationGuard: TMigrationGuard) => T
): T {
  let outcome: OperationalOutcome<T>;
  try {
    outcome = {
      kind: 'success',
      value: operation(ownership.migrationGuard),
    };
  } catch (error) {
    outcome = { kind: 'failure', error };
  }

  try {
    ownership.release();
  } catch (releaseError) {
    if (outcome.kind === 'success') throw releaseError;
    attachOperationalSecondaryFailure(outcome.error, releaseError);
  }

  if (outcome.kind === 'failure') throw outcome.error;
  return outcome.value;
}

function attachOperationalSecondaryFailure(
  primaryError: unknown,
  releaseError: unknown
): void {
  try {
    if (!(primaryError instanceof Error)) return;
    const target = primaryError as ErrorWithOperationalSecondaryFailures;
    let existingValue: unknown;
    let previousCause: unknown;
    try {
      existingValue = target.operationalSecondaryFailures;
    } catch {
      // The operation error remains authoritative.
    }
    try {
      previousCause = target.cause;
    } catch {
      // The operation error remains authoritative.
    }

    const existing = Array.isArray(existingValue) ? existingValue : [];
    const failures: OperationalSecondaryFailure[] = [
      ...existing,
      {
        step: 'release',
        resource: 'runtime-ownership',
        error: releaseError,
      },
    ];
    try {
      target.operationalSecondaryFailures = failures;
    } catch {
      // Metadata is best effort for frozen or hostile Error objects.
    }

    const aggregate = new AggregateError(
      failures.map((failure) => failure.error),
      'Operational command encountered secondary lifecycle failures'
    );
    if (previousCause !== undefined) {
      (aggregate as AggregateError & { cause?: unknown }).cause = previousCause;
    }
    try {
      target.cause = aggregate;
    } catch {
      // Never replace the initiating operation failure with metadata failure.
    }
  } catch {
    // All bookkeeping is best effort; the operation error stays authoritative.
  }
}
