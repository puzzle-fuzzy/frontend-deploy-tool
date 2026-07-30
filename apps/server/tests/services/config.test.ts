import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadConfig, validateAppConfig } from '../../src/config';

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
      managementBaseURL: undefined,
      deployBaseURL: undefined,
      sessionSecret: undefined,
      adminEmail: 'admin@deploykit.local',
      adminPassword: '',
      secureCookies: false,
      registrationEnabled: true,
      maxZipSize: 100 * 1024 * 1024, // 100MB
      maxExtractedSize: 100 * 1024 * 1024, // 100MB
      maxFileCount: 1000,
      maxPathLength: 1000,
      maxCompressionRatio: 200,
      maxUploadRequestSize: 101 * 1024 * 1024,
      maxConcurrentUploads: 4,
      maxConcurrentUploadsPerUser: 2,
      maxConcurrentUploadsPerProject: 1,
      maxStorageSize: 20 * 1024 * 1024 * 1024,
      maxStorageSizePerUser: 10 * 1024 * 1024 * 1024,
      maxStorageSizePerProject: 5 * 1024 * 1024 * 1024,
      stagingRetentionHours: 24,
      recoveryRetentionHours: 168,
      metricsEnabled: true,
      metricsToken: undefined,
      shutdownTimeoutMs: 30_000,
      artifactAuditWorkerEnabled: true,
      artifactAuditPollIntervalMs: 1_000,
      artifactAuditTimeoutMs: 60_000,
      artifactAuditLeaseMs: 90_000,
      artifactAuditMaxAttempts: 3,
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
      managementBaseURL: undefined,
      deployBaseURL: undefined,
      sessionSecret: undefined,
      adminEmail: 'admin@deploykit.local',
      adminPassword: '',
      secureCookies: false,
      registrationEnabled: true,
      maxZipSize: 100 * 1024 * 1024, // 100MB
      maxExtractedSize: 100 * 1024 * 1024, // 100MB
      maxFileCount: 1000,
      maxPathLength: 1000,
      maxCompressionRatio: 200,
      maxUploadRequestSize: 101 * 1024 * 1024,
      maxConcurrentUploads: 4,
      maxConcurrentUploadsPerUser: 2,
      maxConcurrentUploadsPerProject: 1,
      maxStorageSize: 20 * 1024 * 1024 * 1024,
      maxStorageSizePerUser: 10 * 1024 * 1024 * 1024,
      maxStorageSizePerProject: 5 * 1024 * 1024 * 1024,
      stagingRetentionHours: 24,
      recoveryRetentionHours: 168,
      metricsEnabled: true,
      metricsToken: undefined,
      shutdownTimeoutMs: 30_000,
      artifactAuditWorkerEnabled: true,
      artifactAuditPollIntervalMs: 1_000,
      artifactAuditTimeoutMs: 60_000,
      artifactAuditLeaseMs: 90_000,
      artifactAuditMaxAttempts: 3,
    });
  });

  test('rejects a database path equal to or nested inside artifact storage', () => {
    const storageDir = join(appDir, 'unsafe-storage');
    const manualConfig = {
      dataFile: join(appDir, 'data.json'),
      storageDir,
      publicDir: join(appDir, 'public'),
      adminEmail: 'admin@test.local',
      adminPassword: 'test-password',
      secureCookies: false,
      registrationEnabled: false,
    };

    expect(() =>
      validateAppConfig({
        ...manualConfig,
        databaseFile: join(storageDir, 'deploykit.sqlite'),
      })
    ).toThrow('DATABASE_STORAGE_OVERLAP');
    expect(() =>
      validateAppConfig({
        ...manualConfig,
        databaseFile: storageDir,
      })
    ).toThrow('DATABASE_STORAGE_OVERLAP');
    expect(() =>
      loadConfig({
        appDir,
        env: {
          DATABASE_FILE: join(storageDir, 'deploykit.sqlite'),
          STORAGE_DIR: storageDir,
        },
      })
    ).toThrow('DATABASE_STORAGE_OVERLAP');
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
        MANAGEMENT_BASE_URL: 'https://console.example.com',
        DEPLOY_BASE_URL: 'https://deploy.example.net',
      },
    });

    expect(config.environment).toBe('production');
    expect(config.registrationEnabled).toBe(false);
    expect(config.metricsEnabled).toBe(false);
  });

  test('requires a durable session secret in production', () => {
    expect(() =>
      loadConfig({
        appDir,
        env: {
          NODE_ENV: 'production',
          ADMIN_PASSWORD: 'production-password',
          MANAGEMENT_BASE_URL: 'https://console.example.com',
          DEPLOY_BASE_URL: 'https://deploy.example.net',
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
          MANAGEMENT_BASE_URL: 'https://console.example.com',
          DEPLOY_BASE_URL: 'https://deploy.example.net',
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
          MANAGEMENT_BASE_URL: 'https://console.example.com',
          DEPLOY_BASE_URL: 'https://deploy.example.net',
        },
      })
    ).toThrow('ADMIN_PASSWORD');
  });

  test('rejects malformed numeric, flag, and origin URL values', () => {
    expect(() => loadConfig({ appDir, env: { MAX_FILE_COUNT: '-2' } })).toThrow(
      'Invalid MAX_FILE_COUNT'
    );
    expect(() =>
      loadConfig({ appDir, env: { REGISTRATION_ENABLED: 'flase' } })
    ).toThrow('Invalid REGISTRATION_ENABLED');
    expect(() =>
      loadConfig({
        appDir,
        env: { MANAGEMENT_BASE_URL: 'console.example.com' },
      })
    ).toThrow('Invalid MANAGEMENT_BASE_URL');
    expect(() =>
      loadConfig({ appDir, env: { DEPLOY_BASE_URL: 'deploy.example.com' } })
    ).toThrow('Invalid DEPLOY_BASE_URL');
    expect(() =>
      loadConfig({ appDir, env: { MAX_COMPRESSION_RATIO: '0' } })
    ).toThrow('Invalid MAX_COMPRESSION_RATIO');
    expect(() =>
      loadConfig({ appDir, env: { MAX_CONCURRENT_UPLOADS: '1.5' } })
    ).toThrow('Invalid MAX_CONCURRENT_UPLOADS');
    expect(() =>
      loadConfig({ appDir, env: { MAX_STORAGE_SIZE_PER_PROJECT: '0' } })
    ).toThrow('Invalid MAX_STORAGE_SIZE_PER_PROJECT');
    expect(() =>
      loadConfig({ appDir, env: { STAGING_RETENTION_HOURS: '0' } })
    ).toThrow('Invalid STAGING_RETENTION_HOURS');
    expect(() =>
      loadConfig({ appDir, env: { SHUTDOWN_TIMEOUT_MS: '600001' } })
    ).toThrow('Invalid SHUTDOWN_TIMEOUT_MS');
    expect(() =>
      loadConfig({ appDir, env: { ARTIFACT_AUDIT_MAX_ATTEMPTS: '11' } })
    ).toThrow('Invalid ARTIFACT_AUDIT_MAX_ATTEMPTS');
    expect(() =>
      loadConfig({
        appDir,
        env: {
          ARTIFACT_AUDIT_TIMEOUT_MS: '60000',
          ARTIFACT_AUDIT_LEASE_MS: '60000',
        },
      })
    ).toThrow(
      'ARTIFACT_AUDIT_LEASE_MS must be greater than ARTIFACT_AUDIT_TIMEOUT_MS'
    );
  });

  test('uses explicit upload resource budgets', () => {
    const config = loadConfig({
      appDir,
      env: {
        MAX_ZIP_SIZE: '1000',
        MAX_EXTRACTED_SIZE: '2000',
        MAX_UPLOAD_REQUEST_SIZE: '3000',
        MAX_COMPRESSION_RATIO: '50',
        MAX_CONCURRENT_UPLOADS: '3',
        MAX_CONCURRENT_UPLOADS_PER_USER: '2',
        MAX_CONCURRENT_UPLOADS_PER_PROJECT: '1',
        MAX_STORAGE_SIZE: '9000',
        MAX_STORAGE_SIZE_PER_USER: '6000',
        MAX_STORAGE_SIZE_PER_PROJECT: '3000',
        STAGING_RETENTION_HOURS: '12',
        RECOVERY_RETENTION_HOURS: '72',
        SHUTDOWN_TIMEOUT_MS: '45000',
        ARTIFACT_AUDIT_WORKER_ENABLED: 'false',
        ARTIFACT_AUDIT_POLL_INTERVAL_MS: '2500',
        ARTIFACT_AUDIT_TIMEOUT_MS: '70000',
        ARTIFACT_AUDIT_LEASE_MS: '100000',
        ARTIFACT_AUDIT_MAX_ATTEMPTS: '5',
      },
    });

    expect(config.maxZipSize).toBe(1000);
    expect(config.maxExtractedSize).toBe(2000);
    expect(config.maxUploadRequestSize).toBe(3000);
    expect(config.maxCompressionRatio).toBe(50);
    expect(config.maxConcurrentUploads).toBe(3);
    expect(config.maxConcurrentUploadsPerUser).toBe(2);
    expect(config.maxConcurrentUploadsPerProject).toBe(1);
    expect(config.maxStorageSize).toBe(9000);
    expect(config.maxStorageSizePerUser).toBe(6000);
    expect(config.maxStorageSizePerProject).toBe(3000);
    expect(config.stagingRetentionHours).toBe(12);
    expect(config.recoveryRetentionHours).toBe(72);
    expect(config.shutdownTimeoutMs).toBe(45_000);
    expect(config.artifactAuditWorkerEnabled).toBe(false);
    expect(config.artifactAuditPollIntervalMs).toBe(2_500);
    expect(config.artifactAuditTimeoutMs).toBe(70_000);
    expect(config.artifactAuditLeaseMs).toBe(100_000);
    expect(config.artifactAuditMaxAttempts).toBe(5);
  });

  test('normalizes configured origins and derives secure cookies from management', () => {
    const config = loadConfig({
      appDir,
      env: {
        MANAGEMENT_BASE_URL: 'https://console.example.com/path/',
        DEPLOY_BASE_URL: 'https://deploy.example.net/releases/',
      },
    });

    expect(config.managementBaseURL).toBe('https://console.example.com');
    expect(config.deployBaseURL).toBe('https://deploy.example.net');
    expect(config.secureCookies).toBe(true);
  });

  test('requires distinct management and deploy origins in production', () => {
    const baseEnv = {
      DEPLOYKIT_ENV: 'production',
      SESSION_SECRET: 's'.repeat(32),
      ADMIN_PASSWORD: 'production-password',
    };

    expect(() =>
      loadConfig({
        appDir,
        env: baseEnv,
      })
    ).toThrow(
      'MANAGEMENT_BASE_URL and DEPLOY_BASE_URL are required in production'
    );

    expect(() =>
      loadConfig({
        appDir,
        env: {
          ...baseEnv,
          MANAGEMENT_BASE_URL: 'https://console.example.com',
          DEPLOY_BASE_URL: 'https://console.example.com/deploy',
        },
      })
    ).toThrow(
      'MANAGEMENT_BASE_URL and DEPLOY_BASE_URL must use different origins'
    );
  });

  test('requires a strong metrics token when production metrics are enabled', () => {
    const baseEnv = {
      DEPLOYKIT_ENV: 'production',
      SESSION_SECRET: 's'.repeat(32),
      ADMIN_PASSWORD: 'production-password',
      MANAGEMENT_BASE_URL: 'https://console.example.com',
      DEPLOY_BASE_URL: 'https://deploy.example.net',
      METRICS_ENABLED: 'true',
    };

    expect(() => loadConfig({ appDir, env: baseEnv })).toThrow('METRICS_TOKEN');
    expect(() =>
      loadConfig({
        appDir,
        env: { ...baseEnv, METRICS_TOKEN: 'too-short' },
      })
    ).toThrow('at least 32 characters');

    const config = loadConfig({
      appDir,
      env: { ...baseEnv, METRICS_TOKEN: 'm'.repeat(32) },
    });
    expect(config.metricsEnabled).toBe(true);
    expect(config.metricsToken).toBe('m'.repeat(32));
  });
});
