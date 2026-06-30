import { createApp } from './src/app';
import { loadConfig } from './src/config';

const config = loadConfig({ appDir: import.meta.dir });

Bun.serve({
  port: config.port,
  fetch: createApp(config).fetch,
});

console.log(`DeployKit server is running at http://localhost:${config.port}`);
