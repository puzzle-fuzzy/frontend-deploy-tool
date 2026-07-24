import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  const appDir = join('workspace', 'apps', 'server');

  test('uses local server paths and port 4010 by default', () => {
    const config = loadConfig({ appDir, env: {} });

    expect(config).toEqual({
      environment: 'development',
      port: 4010,
      databaseFile: join(appDir, 'deploykit.sqlite'),
      dataFile: join(appDir, 'data.json'),
      storageDir: join(appDir, '.voasx', 'storage'),
      publicDir: join(appDir, 'public'),
      publicBaseURL: undefined,
      sessionSecret: undefined,
      adminEmail: 'admin@deploykit.local',
      adminPassword: '',
      secureCookies: false,
      registrationEnabled: true,
      maxZipSize: 100 * 1024 * 1024, // 100MB
      maxExtractedSize: 100 * 1024 * 1024, // 100MB
      maxFileCount: 1000,
      maxPathLength: 1000,
    });
  });

  test('uses environment overrides when provided', () => {
    const config = loadConfig({
      appDir,
      env: {
        NODE_ENV: 'test',
        PORT: '4173',
        DATABASE_FILE: join('tmp', 'deploykit.sqlite'),
        DATA_FILE: join('tmp', 'data.json'),
        STORAGE_DIR: join('tmp', 'storage'),
        PUBLIC_DIR: join('tmp', 'public'),
      },
    });

    expect(config).toEqual({
      environment: 'test',
      port: 4173,
      databaseFile: join('tmp', 'deploykit.sqlite'),
      dataFile: join('tmp', 'data.json'),
      storageDir: join('tmp', 'storage'),
      publicDir: join('tmp', 'public'),
      publicBaseURL: undefined,
      sessionSecret: undefined,
      adminEmail: 'admin@deploykit.local',
      adminPassword: '',
      secureCookies: false,
      registrationEnabled: true,
      maxZipSize: 100 * 1024 * 1024, // 100MB
      maxExtractedSize: 100 * 1024 * 1024, // 100MB
      maxFileCount: 1000,
      maxPathLength: 1000,
    });
  });

  test('rejects an invalid PORT instead of silently using another port', () => {
    expect(() => loadConfig({ appDir, env: { PORT: 'not-a-port' } })).toThrow(
      'Invalid PORT'
    );
  });

  test('registration is enabled by default and toggled by REGISTRATION_ENABLED', () => {
    expect(loadConfig({ appDir, env: {} }).registrationEnabled).toBe(true);
    expect(
      loadConfig({ appDir, env: { REGISTRATION_ENABLED: 'true' } })
        .registrationEnabled
    ).toBe(true);
    for (const value of ['false', '0', 'no', 'off']) {
      expect(
        loadConfig({ appDir, env: { REGISTRATION_ENABLED: value } })
          .registrationEnabled
      ).toBe(false);
    }
  });

  test('defaults registration to disabled in production', () => {
    const config = loadConfig({
      appDir,
      env: {
        NODE_ENV: 'production',
        SESSION_SECRET: 's'.repeat(32),
        ADMIN_PASSWORD: 'production-password',
      },
    });

    expect(config.environment).toBe('production');
    expect(config.registrationEnabled).toBe(false);
  });

  test('requires a durable session secret in production', () => {
    expect(() =>
      loadConfig({
        appDir,
        env: {
          NODE_ENV: 'production',
          ADMIN_PASSWORD: 'production-password',
        },
      })
    ).toThrow('SESSION_SECRET');

    expect(() =>
      loadConfig({
        appDir,
        env: {
          NODE_ENV: 'production',
          SESSION_SECRET: 'too-short',
          ADMIN_PASSWORD: 'production-password',
        },
      })
    ).toThrow('at least 32 characters');
  });

  test('requires an explicit initial admin password in production', () => {
    expect(() =>
      loadConfig({
        appDir,
        env: {
          NODE_ENV: 'production',
          SESSION_SECRET: 's'.repeat(32),
        },
      })
    ).toThrow('ADMIN_PASSWORD');
  });

  test('rejects malformed numeric, flag, and public URL values', () => {
    expect(() => loadConfig({ appDir, env: { MAX_FILE_COUNT: '-2' } })).toThrow(
      'Invalid MAX_FILE_COUNT'
    );
    expect(() =>
      loadConfig({ appDir, env: { REGISTRATION_ENABLED: 'flase' } })
    ).toThrow('Invalid REGISTRATION_ENABLED');
    expect(() =>
      loadConfig({ appDir, env: { PUBLIC_BASE_URL: 'deploy.example.com' } })
    ).toThrow('Invalid PUBLIC_BASE_URL');
  });
});
