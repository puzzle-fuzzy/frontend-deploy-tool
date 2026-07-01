import { describe, expect, test } from 'bun:test';
import { matchBlockedPath } from '../../src/domain/uploadSafety';

describe('matchBlockedPath', () => {
  describe('blocks dangerous paths', () => {
    test.each([
      // env / secrets
      ['.env'],
      ['.env.local'],
      ['.env.production'],
      ['.env.example'],
      ['config/.env'],
      // VCS + dependency directories (any path segment)
      ['.git/config'],
      ['.svn/entries'],
      ['.hg/store'],
      ['node_modules/react/index.js'],
      // private keys (basename suffix)
      ['cert.pem'],
      ['secrets/server.key'],
      // SSH keys (exact basename)
      ['id_rsa'],
      ['id_rsa.pub'],
      ['subdir/id_rsa'],
    ])('%s', (path) => {
      expect(matchBlockedPath(path)).not.toBeNull();
    });
  });

  describe('allows safe paths (precision — no naive substring match)', () => {
    test.each([
      'greenhouse.js',
      'env-config.js',
      '.environment.js',
      '.envrc',
      'monkey.jpeg',
      'keyboard.txt',
      'id_rsa_backup.txt',
      '.gitignore',
      'id_ed25519',
      'index.html',
      'assets/main.js',
      // OS junk is NOT handled here (isSystemMetadata owns it):
      '.DS_Store',
      // case-sensitive in v1 — uppercase variants are not matched:
      'config/.ENV',
      '.GIT/config',
    ])('%s', (path) => {
      expect(matchBlockedPath(path)).toBeNull();
    });
  });
});
