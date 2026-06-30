import { join } from 'node:path';

export interface AppConfig {
  dataFile: string;
  storageDir: string;
  publicDir: string;
  publicBaseURL?: string;
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
    // Upload limits with defaults (values in bytes/count)
    maxZipSize: parseSize(env.MAX_ZIP_SIZE),
    maxExtractedSize: parseSize(env.MAX_EXTRACTED_SIZE),
    maxFileCount: parseCount(env.MAX_FILE_COUNT),
    maxPathLength: parseCount(env.MAX_PATH_LENGTH),
  };
}

function parsePort(value: string | undefined): number {
  if (!value) return 3000;

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return 3000;

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
