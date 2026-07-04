import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientSrc = path.resolve(__dirname, '../../packages/client/src');

// https://vitejs.dev/config
export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    preserveSymlinks: false,
    alias: [
      { find: '@deploykit/client', replacement: clientSrc },
      { find: '@', replacement: clientSrc },
      {
        find: '@deploykit/shared',
        replacement: path.resolve(__dirname, '../../packages/shared/src'),
      },
      {
        find: '@deploykit/server',
        replacement: path.resolve(__dirname, '../../apps/server/src'),
      },
    ],
  },
  // Allow files in packages/ to be served by the renderer Vite dev server.
  server: {
    fs: {
      allow: [path.resolve(__dirname, '../..')],
    },
  },
});
