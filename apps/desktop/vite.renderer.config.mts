import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Electron Forge's VitePlugin forces `preserveSymlinks: true`, which breaks
    // resolution of transitive deps (e.g. react-dom -> scheduler) under bun's
    // symlinked node_modules layout. Restore Vite's default so the bundler
    // follows symlinks during the renderer build.
    preserveSymlinks: false,
  },
});
