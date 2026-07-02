import { defineConfig } from 'vite';

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
  },
});
