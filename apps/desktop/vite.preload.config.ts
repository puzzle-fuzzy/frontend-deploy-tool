import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: { external: ['electron'] },
  },
  resolve: {
    preserveSymlinks: false,
    alias: {
      '@deploykit/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
});
