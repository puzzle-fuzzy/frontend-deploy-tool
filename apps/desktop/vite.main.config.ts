import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['electron', 'electron-store'],
    },
  },
  resolve: {
    // Electron Forge's VitePlugin forces `preserveSymlinks: true`, which breaks
    // resolution under bun's symlinked node_modules. Restore Vite's default.
    preserveSymlinks: false,
    alias: {
      '@deploykit/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
});
