import { join } from 'node:path';

export interface AppConfig {
  dataFile: string;
  storageDir: string;
  publicDir: string;
  publicBaseURL?: string;
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
  return {
    port: parsePort(env.PORT),
    dataFile: env.DATA_FILE ?? join(appDir, 'data.json'),
    storageDir: env.STORAGE_DIR ?? join(appDir, '.voasx', 'storage'),
    publicDir: env.PUBLIC_DIR ?? join(appDir, 'public'),
    publicBaseURL: env.PUBLIC_BASE_URL,
    // Auth
    sessionSecret: env.SESSION_SECRET,
    adminEmail: env.ADMIN_EMAIL ?? 'admin@deploykit.local',
    adminPassword: env.ADMIN_PASSWORD ?? '',
    secureCookies: env.PUBLIC_BASE_URL?.startsWith('https://') ?? false,
    // Registration defaults to open; set REGISTRATION_ENABLED=false to close it.
    registrationEnabled: parseFlag(env.REGISTRATION_ENABLED, true),
    // Upload limits with defaults (values in bytes/count)
    maxZipSize: parseSize(env.MAX_ZIP_SIZE),
    maxExtractedSize: parseSize(env.MAX_EXTRACTED_SIZE),
    maxFileCount: parseCount(env.MAX_FILE_COUNT),
    maxPathLength: parseCount(env.MAX_PATH_LENGTH),
  };
}

/** Parses a boolean env flag, falling back to the default when unset/empty. */
function parseFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  return !['false', '0', 'no', 'off'].includes(value.toLowerCase().trim());
}

function parsePort(value: string | undefined): number {
  if (!value) return 4010;

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return 4010;

  return port;
}

function parseSize(value: string | undefined): number {
  if (!value) return 100 * 1024 * 1024; // 100MB default

  const size = Number(value);
  if (!Number.isInteger(size) || size <= 0) return 100 * 1024 * 1024;

  return size;
}

function parseCount(value: string | undefined): number {
  if (!value) return 1000; // 1000 files/chars default

  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0) return 1000;

  return count;
}
