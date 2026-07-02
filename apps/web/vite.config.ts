import path from 'node:path';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  build: {
    // Package-local output; the root `build` script packages this into
    // apps/server/public so the backend can serve the management UI.
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      // Client package is consumed from source; the UI lives there now, so
      // both `@deploykit/client` and `@` resolve into the client src tree.
      // Web's own `src/` is now just `main.tsx`, which has no `@/` imports.
      '@deploykit/client': path.resolve(__dirname, '../../packages/client/src'),
      '@deploykit/shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@': path.resolve(__dirname, '../../packages/client/src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/deploy': 'http://localhost:3000',
    },
  },
});
