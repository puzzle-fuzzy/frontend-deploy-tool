import { join } from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';

// Resolve paths relative to the package root (this file lives in `<root>/src/`).
const config = loadConfig({ appDir: join(import.meta.dir, '..') });

Bun.serve({
  port: config.port,
  fetch: createApp(config).fetch,
});

console.log(`DeployKit server is running at http://localhost:${config.port}`);
