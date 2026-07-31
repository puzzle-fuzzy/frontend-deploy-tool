import { expect, test } from 'bun:test';
import {
  attachBackupSecondaryFailures,
  type BackupSecondaryFailure,
} from '../../src/services/backupFailure';

const cleanupFailure: BackupSecondaryFailure = {
  step: 'cleanup-temporary',
  resource: '/backup.tmp-test',
  error: new Error('cleanup failed'),
};
const releaseFailure: BackupSecondaryFailure = {
  step: 'release',
  resource: 'runtime-ownership',
  error: new Error('release failed'),
};

test('attaches ordered backup secondary failures without replacing identity or prior cause', () => {
  const priorCause = new Error('prior cause');
  const primary = new Error('primary', { cause: priorCause }) as Error & {
    backupSecondaryFailures?: BackupSecondaryFailure[];
  };
  attachBackupSecondaryFailures(primary, [cleanupFailure, releaseFailure]);
  expect(primary.backupSecondaryFailures).toEqual([
    cleanupFailure,
    releaseFailure,
  ]);
  expect(primary.cause).toBeInstanceOf(AggregateError);
  expect((primary.cause as AggregateError).errors).toEqual([
    cleanupFailure.error,
    releaseFailure.error,
  ]);
  expect((primary.cause as AggregateError & { cause?: unknown }).cause).toBe(
    priorCause
  );
});

test('appends a later backup secondary failure', () => {
  const primary = new Error('primary') as Error & {
    backupSecondaryFailures?: BackupSecondaryFailure[];
  };
  attachBackupSecondaryFailures(primary, [cleanupFailure]);
  attachBackupSecondaryFailures(primary, [releaseFailure]);
  expect(primary.backupSecondaryFailures).toEqual([
    cleanupFailure,
    releaseFailure,
  ]);
});

test('does not throw for frozen errors or primitive initiating values', () => {
  expect(() =>
    attachBackupSecondaryFailures(Object.freeze(new Error('frozen')), [
      cleanupFailure,
    ])
  ).not.toThrow();
  expect(() =>
    attachBackupSecondaryFailures('primitive-primary', [cleanupFailure])
  ).not.toThrow();
});

test('does not escape hostile existing backup metadata', () => {
  const nonArray = new Error('non-array');
  Object.defineProperty(nonArray, 'backupSecondaryFailures', {
    configurable: true,
    writable: true,
    value: 'hostile',
  });
  const throwingGetter = new Error('throwing getter');
  Object.defineProperty(throwingGetter, 'backupSecondaryFailures', {
    get() {
      throw new Error('metadata getter failed');
    },
  });
  const throwingElement = new Error('throwing element');
  Object.defineProperty(throwingElement, 'backupSecondaryFailures', {
    configurable: true,
    writable: true,
    value: [
      Object.defineProperty({}, 'error', {
        get() {
          throw new Error('element getter failed');
        },
      }),
    ],
  });
  for (const primary of [nonArray, throwingGetter, throwingElement]) {
    expect(() =>
      attachBackupSecondaryFailures(primary, [cleanupFailure])
    ).not.toThrow();
  }
});
