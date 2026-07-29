import { join } from 'node:path';
import { DEFAULT_STORAGE_QUOTA_LIMITS } from './domain/storageQuota';

export type RuntimeEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
  /** Runtime safety mode. Manual test fixtures may omit it (development). */
  environment?: RuntimeEnvironment;
  /** SQLite metadata store. Omit only in isolated tests using JSON fixtures. */
  databaseFile?: string;
  /** Legacy JSON store, imported once when SQLite is empty. */
  dataFile: string;
  storageDir: string;
  publicDir: string;
  /** Trusted browser origin serving the management UI and API. */
  managementBaseURL?: string;
  /** Untrusted browser origin serving uploaded deployment artifacts. */
  deployBaseURL?: string;
  // Auth
  sessionSecret?: string;
  adminEmail: string;
  adminPassword: string;
  /** Mark session cookies Secure (only when served over https). */
  secureCookies: boolean;
  /** Whether self-service registration (/api/auth/register) is allowed. */
  registrationEnabled: boolean;
  // Upload limits
  maxZipSize?: number;
  maxExtractedSize?: number;
  maxFileCount?: number;
  maxPathLength?: number;
  maxCompressionRatio?: number;
  maxUploadRequestSize?: number;
  maxConcurrentUploads?: number;
  maxConcurrentUploadsPerUser?: number;
  maxConcurrentUploadsPerProject?: number;
  /** Maximum persisted extracted artifact bytes across this installation. */
  maxStorageSize?: number;
  /** Maximum persisted bytes charged to one project's creator. */
  maxStorageSizePerUser?: number;
  /** Maximum persisted bytes in one project. */
  maxStorageSizePerProject?: number;
  /** Retain incomplete upload staging for at least this many hours. */
  stagingRetentionHours?: number;
  /** Retain committed trash and orphan quarantine for at least this many hours. */
  recoveryRetentionHours?: number;
  /** Expose Prometheus metrics on the trusted management origin. */
  metricsEnabled?: boolean;
  /** Bearer token required by the metrics endpoint when configured. */
  metricsToken?: string;
  /** Maximum time to drain in-flight requests before force-closing. */
  shutdownTimeoutMs?: number;
}

export interface ServerConfig extends AppConfig {
  port: number;
}

interface LoadConfigOptions {
  appDir: string;
  env?: Record<string, string | undefined>;
}

export function loadConfig({
  appDir,
  env = process.env,
}: LoadConfigOptions): ServerConfig {
  const environment = parseEnvironment(env.DEPLOYKIT_ENV ?? env.NODE_ENV);
  const managementBaseURL = parseBaseURL(
    'MANAGEMENT_BASE_URL',
    env.MANAGEMENT_BASE_URL
  );
  const deployBaseURL = parseBaseURL('DEPLOY_BASE_URL', env.DEPLOY_BASE_URL);
  const maxZipSize = parsePositiveInteger(
    'MAX_ZIP_SIZE',
    env.MAX_ZIP_SIZE,
    100 * 1024 * 1024
  );
  const maxExtractedSize = parsePositiveInteger(
    'MAX_EXTRACTED_SIZE',
    env.MAX_EXTRACTED_SIZE,
    100 * 1024 * 1024
  );
  const config: ServerConfig = {
    environment,
    port: parsePositiveInteger('PORT', env.PORT, 4010, 65535),
    databaseFile: env.DATABASE_FILE ?? join(appDir, 'deploykit.sqlite'),
    dataFile: env.DATA_FILE ?? join(appDir, 'data.json'),
    storageDir: env.STORAGE_DIR ?? join(appDir, '.voasx', 'storage'),
    publicDir: env.PUBLIC_DIR ?? join(appDir, 'public'),
    managementBaseURL,
    deployBaseURL,
    // Auth
    sessionSecret: emptyToUndefined(env.SESSION_SECRET),
    adminEmail: env.ADMIN_EMAIL ?? 'admin@deploykit.local',
    adminPassword: env.ADMIN_PASSWORD ?? '',
    secureCookies: managementBaseURL?.startsWith('https://') ?? false,
    // Local development stays convenient; production fails closed by default.
    registrationEnabled: parseFlag(
      'REGISTRATION_ENABLED',
      env.REGISTRATION_ENABLED,
      environment !== 'production'
    ),
    // Upload limits with defaults (values in bytes/count)
    maxZipSize,
    maxExtractedSize,
    maxFileCount: parsePositiveInteger(
      'MAX_FILE_COUNT',
      env.MAX_FILE_COUNT,
      1000
    ),
    maxPathLength: parsePositiveInteger(
      'MAX_PATH_LENGTH',
      env.MAX_PATH_LENGTH,
      1000
    ),
    maxCompressionRatio: parsePositiveInteger(
      'MAX_COMPRESSION_RATIO',
      env.MAX_COMPRESSION_RATIO,
      200
    ),
    maxUploadRequestSize: parsePositiveInteger(
      'MAX_UPLOAD_REQUEST_SIZE',
      env.MAX_UPLOAD_REQUEST_SIZE,
      Math.max(maxZipSize, maxExtractedSize) + 1024 * 1024
    ),
    maxConcurrentUploads: parsePositiveInteger(
      'MAX_CONCURRENT_UPLOADS',
      env.MAX_CONCURRENT_UPLOADS,
      4
    ),
    maxConcurrentUploadsPerUser: parsePositiveInteger(
      'MAX_CONCURRENT_UPLOADS_PER_USER',
      env.MAX_CONCURRENT_UPLOADS_PER_USER,
      2
    ),
    maxConcurrentUploadsPerProject: parsePositiveInteger(
      'MAX_CONCURRENT_UPLOADS_PER_PROJECT',
      env.MAX_CONCURRENT_UPLOADS_PER_PROJECT,
      1
    ),
    maxStorageSize: parsePositiveInteger(
      'MAX_STORAGE_SIZE',
      env.MAX_STORAGE_SIZE,
      DEFAULT_STORAGE_QUOTA_LIMITS.global
    ),
    maxStorageSizePerUser: parsePositiveInteger(
      'MAX_STORAGE_SIZE_PER_USER',
      env.MAX_STORAGE_SIZE_PER_USER,
      DEFAULT_STORAGE_QUOTA_LIMITS.perUser
    ),
    maxStorageSizePerProject: parsePositiveInteger(
      'MAX_STORAGE_SIZE_PER_PROJECT',
      env.MAX_STORAGE_SIZE_PER_PROJECT,
      DEFAULT_STORAGE_QUOTA_LIMITS.perProject
    ),
    stagingRetentionHours: parsePositiveInteger(
      'STAGING_RETENTION_HOURS',
      env.STAGING_RETENTION_HOURS,
      24
    ),
    recoveryRetentionHours: parsePositiveInteger(
      'RECOVERY_RETENTION_HOURS',
      env.RECOVERY_RETENTION_HOURS,
      168
    ),
    metricsEnabled: parseFlag(
      'METRICS_ENABLED',
      env.METRICS_ENABLED,
      environment !== 'production'
    ),
    metricsToken: emptyToUndefined(env.METRICS_TOKEN),
    shutdownTimeoutMs: parsePositiveInteger(
      'SHUTDOWN_TIMEOUT_MS',
      env.SHUTDOWN_TIMEOUT_MS,
      30_000,
      10 * 60 * 1000
    ),
  };
  validateAppConfig(config);
  return config;
}

/**
 * Validates safety invariants even when `createApp()` receives a manually
 * assembled config instead of one produced by `loadConfig()`.
 */
export function validateAppConfig(config: AppConfig): void {
  const environment = config.environment ?? 'development';
  if (config.managementBaseURL) {
    parseBaseURL('MANAGEMENT_BASE_URL', config.managementBaseURL);
  }
  if (config.deployBaseURL) {
    parseBaseURL('DEPLOY_BASE_URL', config.deployBaseURL);
  }
  if (environment !== 'production') return;

  if (!config.sessionSecret) {
    throw new Error(
      'SESSION_SECRET is required when DEPLOYKIT_ENV or NODE_ENV is production'
    );
  }
  if (config.sessionSecret.length < 32) {
    throw new Error(
      'SESSION_SECRET must be at least 32 characters in production'
    );
  }
  if (!config.adminPassword) {
    throw new Error(
      'ADMIN_PASSWORD is required in production to prevent logging a generated credential'
    );
  }
  if (!config.managementBaseURL || !config.deployBaseURL) {
    throw new Error(
      'MANAGEMENT_BASE_URL and DEPLOY_BASE_URL are required in production'
    );
  }
  if (
    new URL(config.managementBaseURL).origin ===
    new URL(config.deployBaseURL).origin
  ) {
    throw new Error(
      'MANAGEMENT_BASE_URL and DEPLOY_BASE_URL must use different origins'
    );
  }
  if (
    config.metricsEnabled &&
    (!config.metricsToken || config.metricsToken.length < 32)
  ) {
    throw new Error(
      'METRICS_TOKEN must be at least 32 characters when metrics are enabled in production'
    );
  }
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === undefined || value.trim() === '') return 'development';
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'development' ||
    normalized === 'test' ||
    normalized === 'production'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid DEPLOYKIT_ENV/NODE_ENV: expected development, test, or production; received "${value}"`
  );
}

/** Parses a boolean env flag, falling back to the default when unset/empty. */
function parseFlag(
  name: string,
  value: string | undefined,
  defaultValue: boolean
): boolean {
  if (value === undefined || value === '') return defaultValue;
  const normalized = value.toLowerCase().trim();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(
    `Invalid ${name}: expected true/false, 1/0, yes/no, or on/off; received "${value}"`
  );
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (value === undefined || value.trim() === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(
      `Invalid ${name}: expected an integer between 1 and ${maximum}; received "${value}"`
    );
  }
  return parsed;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBaseURL(
  name: 'MANAGEMENT_BASE_URL' | 'DEPLOY_BASE_URL',
  value: string | undefined
): string | undefined {
  const normalized = emptyToUndefined(value);
  if (!normalized) return undefined;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(
      `Invalid ${name}: expected an absolute http(s) URL; received "${value}"`
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Invalid ${name}: expected an absolute http(s) URL without credentials; received "${value}"`
    );
  }
  return url.origin;
}
