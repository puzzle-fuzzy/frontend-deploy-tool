import { join } from "node:path";
import type { AppConfig } from "./app";

export interface ServerConfig extends AppConfig {
  port: number;
}

interface LoadConfigOptions {
  appDir: string;
  env?: Record<string, string | undefined>;
}

export function loadConfig({ appDir, env = process.env }: LoadConfigOptions): ServerConfig {
  return {
    port: parsePort(env.PORT),
    dataFile: env.DATA_FILE ?? join(appDir, "data.json"),
    storageDir: env.STORAGE_DIR ?? join(appDir, ".voasx", "storage"),
    publicDir: env.PUBLIC_DIR ?? join(appDir, "public"),
  };
}

function parsePort(value: string | undefined): number {
  if (!value) return 3000;

  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return 3000;

  return port;
}
