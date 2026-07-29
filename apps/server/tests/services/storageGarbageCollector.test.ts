import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectStorageGarbage } from '../../src/services/storageGarbageCollector';

const now = new Date('2026-07-30T12:00:00.000Z');
const old = new Date('2026-07-20T12:00:00.000Z');
const fresh = new Date('2026-07-30T11:00:00.000Z');

function touchDirectory(path: string, modifiedAt: Date): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'payload.txt'), 'payload');
  utimesSync(path, modifiedAt, modifiedAt);
}

describe('collectStorageGarbage', () => {
  test('removes only expired staging and committed recovery entries', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-gc-'));
    const oldStaging = join(storageDir, '.staging', 'old-upload');
    const freshStaging = join(storageDir, '.staging', 'fresh-upload');
    const oldCommitted = join(storageDir, '.recovery', 'trash', 'old-commit');
    const freshCommitted = join(
      storageDir,
      '.recovery',
      'trash',
      'fresh-commit'
    );
    const uncommitted = join(storageDir, '.recovery', 'trash', 'uncommitted');
    const oldOrphan = join(storageDir, '.recovery', 'orphans', 'old-orphan');
    const freshOrphan = join(
      storageDir,
      '.recovery',
      'orphans',
      'fresh-orphan'
    );

    try {
      touchDirectory(oldStaging, old);
      touchDirectory(freshStaging, fresh);
      for (const [path, modifiedAt] of [
        [oldCommitted, old],
        [freshCommitted, fresh],
      ] as const) {
        touchDirectory(path, modifiedAt);
        const marker = join(path, 'COMMITTED');
        writeFileSync(marker, modifiedAt.toISOString());
        utimesSync(marker, modifiedAt, modifiedAt);
      }
      touchDirectory(uncommitted, old);
      touchDirectory(oldOrphan, old);
      touchDirectory(freshOrphan, fresh);

      expect(
        collectStorageGarbage(storageDir, {
          now,
          stagingRetentionMs: 24 * 60 * 60 * 1000,
          recoveryRetentionMs: 7 * 24 * 60 * 60 * 1000,
        })
      ).toEqual({
        removedStagingEntries: 1,
        removedCommittedTrashEntries: 1,
        removedOrphanEntries: 1,
      });

      expect(existsSync(oldStaging)).toBe(false);
      expect(existsSync(freshStaging)).toBe(true);
      expect(existsSync(oldCommitted)).toBe(false);
      expect(existsSync(freshCommitted)).toBe(true);
      expect(existsSync(uncommitted)).toBe(true);
      expect(existsSync(oldOrphan)).toBe(false);
      expect(existsSync(freshOrphan)).toBe(true);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test('supports a non-destructive dry run', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'deploykit-gc-'));
    const stale = join(storageDir, '.staging', 'stale');
    try {
      touchDirectory(stale, old);
      expect(
        collectStorageGarbage(storageDir, {
          now,
          stagingRetentionMs: 1,
          recoveryRetentionMs: 1,
          dryRun: true,
        })
      ).toMatchObject({ removedStagingEntries: 1 });
      expect(existsSync(stale)).toBe(true);
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});
