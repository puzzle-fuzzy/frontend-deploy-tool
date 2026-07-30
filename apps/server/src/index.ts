import { join } from 'node:path';
import { createDeployKitRuntime } from './app';
import { loadConfig } from './config';
import { startDeployKitServer } from './serverEntry';

// Resolve paths relative to the package root (this file lives in `<root>/src/`).
const config = loadConfig({ appDir: join(import.meta.dir, '..') });
const runtime = createDeployKitRuntime(config);
await startDeployKitServer(config, runtime);
