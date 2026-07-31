import { expect, test } from 'bun:test';
import { O_RDONLY } from 'node:constants';
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSingleLinkRegularFile,
  BACKUP_DATABASE_SNAPSHOT_UNSAFE,
  BACKUP_SOURCE_UNSAFE,
  type CapturedFileIdentity,
  isMissingPathError,
  lstatIfPresent,
  pathEntryExistsNoFollow,
  sameCapturedIdentity,
} from '../../src/services/backupFileSafety';

test('file-safety errors retain their stable codes', () => {
  expect(BACKUP_DATABASE_SNAPSHOT_UNSAFE).toBe(
    'BACKUP_DATABASE_SNAPSHOT_UNSAFE'
  );
  expect(BACKUP_SOURCE_UNSAFE).toBe('BACKUP_SOURCE_UNSAFE');
});

test('missing paths remain absent under no-follow semantics', () => {
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), 'deploykit-backup-file-safety-missing-')
  );
  try {
    const missingPath = join(temporaryRoot, 'missing');
    expect(lstatIfPresent(missingPath)).toBeUndefined();
    expect(pathEntryExistsNoFollow(missingPath)).toBe(false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

for (const [code, expected] of [
  ['ENOENT', true],
  ['ENOTDIR', false],
  ['EACCES', false],
] as const) {
  test(`isMissingPathError returns ${expected} for ${code}`, () => {
    const error = Object.assign(new Error(`synthetic ${code}`), { code });
    expect(isMissingPathError(error)).toBe(expected);
  });
}

for (const [name, probe] of [
  ['lstatIfPresent', lstatIfPresent],
  ['pathEntryExistsNoFollow', pathEntryExistsNoFollow],
] as const) {
  test(`${name} propagates a real ENOTDIR error`, () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), 'deploykit-backup-file-safety-enotdir-')
    );
    try {
      const regularFile = join(temporaryRoot, 'regular-file');
      writeFileSync(regularFile, 'not a directory');

      const error = captureError(() => probe(join(regularFile, 'child')));
      expect(error.code).toBe('ENOTDIR');
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
}

test('a dangling symlink remains a present path entry', () => {
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), 'deploykit-backup-file-safety-symlink-')
  );
  try {
    const danglingLink = join(temporaryRoot, 'dangling-link');
    symlinkSync(join(temporaryRoot, 'missing-target'), danglingLink);

    expect(lstatIfPresent(danglingLink)?.isSymbolicLink()).toBe(true);
    expect(pathEntryExistsNoFollow(danglingLink)).toBe(true);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('a multiply-linked regular file retains the exact unsafe error', () => {
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), 'deploykit-backup-file-safety-hardlink-')
  );
  try {
    const source = join(temporaryRoot, 'source');
    writeFileSync(source, 'backup source');
    linkSync(source, join(temporaryRoot, 'alias'));

    const descriptor = openSync(source, O_RDONLY);
    try {
      const stats = fstatSync(descriptor, { bigint: true });
      const error = captureError(() =>
        assertSingleLinkRegularFile(source, stats, BACKUP_SOURCE_UNSAFE)
      );
      expect(error.message).toBe(
        `[BACKUP_SOURCE_UNSAFE] Backup source must be a single-link regular file: ${source}`
      );
    } finally {
      closeSync(descriptor);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

const capturedIdentity: CapturedFileIdentity = {
  dev: 1n,
  ino: 2n,
  size: 3n,
  mtimeNs: 4n,
  ctimeNs: 5n,
};

test('sameCapturedIdentity accepts equal identities', () => {
  expect(sameCapturedIdentity(capturedIdentity, { ...capturedIdentity })).toBe(
    true
  );
});

for (const [field, value] of [
  ['dev', 11n],
  ['ino', 12n],
  ['size', 13n],
  ['mtimeNs', 14n],
  ['ctimeNs', 15n],
] as const satisfies ReadonlyArray<
  readonly [keyof CapturedFileIdentity, bigint]
>) {
  test(`sameCapturedIdentity rejects ${field} drift`, () => {
    expect(
      sameCapturedIdentity(capturedIdentity, {
        ...capturedIdentity,
        [field]: value,
      })
    ).toBe(false);
  });
}

function captureError(callback: () => unknown): Error & { code?: string } {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error & { code?: string };
  }
  throw new Error('Expected callback to throw');
}
