export interface BackupSecondaryFailure {
  step: 'cleanup-temporary' | 'release';
  resource: string;
  error: unknown;
}

type ErrorWithBackupSecondaryFailures = Error & {
  cause?: unknown;
  backupSecondaryFailures?: BackupSecondaryFailure[];
};

export function attachBackupSecondaryFailures(
  primaryError: unknown,
  newFailures: readonly BackupSecondaryFailure[]
): void {
  try {
    if (!(primaryError instanceof Error) || newFailures.length === 0) return;
    const target = primaryError as ErrorWithBackupSecondaryFailures;
    let existingValue: unknown;
    let previousCause: unknown;
    try {
      existingValue = target.backupSecondaryFailures;
    } catch {
      // The initiating error remains authoritative.
    }
    try {
      previousCause = target.cause;
    } catch {
      // The initiating error remains authoritative.
    }
    const existing = Array.isArray(existingValue) ? existingValue : [];
    const failures = [...existing, ...newFailures];
    try {
      target.backupSecondaryFailures = failures;
    } catch {
      // Metadata is best effort for frozen/hostile Error objects.
    }
    const secondaryErrors: unknown[] = [];
    for (const failure of failures) {
      try {
        secondaryErrors.push(failure?.error);
      } catch (metadataError) {
        secondaryErrors.push(metadataError);
      }
    }
    const aggregate = new AggregateError(
      secondaryErrors,
      'Backup encountered secondary cleanup failures'
    );
    if (previousCause !== undefined) {
      (aggregate as AggregateError & { cause?: unknown }).cause = previousCause;
    }
    try {
      target.cause = aggregate;
    } catch {
      // Never replace the initiating failure with metadata assignment.
    }
  } catch {
    // All bookkeeping is best effort; the initiating error stays authoritative.
  }
}
