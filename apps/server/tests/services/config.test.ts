import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  const appDir = join('workspace', 'apps', 'server');

  test('uses local server paths and port 4010 by default', () => {
    const config = loadConfig({ appDir, env: {} });

    expect(config).toEqual({
      port: 4010,
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
        PORT: '4173',
        DATA_FILE: join('tmp', 'data.json'),
        STORAGE_DIR: join('tmp', 'storage'),
        PUBLIC_DIR: join('tmp', 'public'),
      },
    });

    expect(config).toEqual({
      port: 4173,
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

  test('falls back to port 4010 when PORT is invalid', () => {
    expect(loadConfig({ appDir, env: { PORT: 'not-a-port' } }).port).toBe(4010);
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
});
