import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    preserveSymlinks: false,
    alias: {
      '@deploykit/client': path.resolve(__dirname, '../../packages/client/src'),
      '@deploykit/shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@deploykit/server': path.resolve(__dirname, '../../apps/server/src'),
      // All shared component code lives in packages/client/src and uses @/ aliases.
      // The desktop renderer never imports via @/ directly; this alias ensures
      // packages/client internal imports (e.g. @/shared/ui/button) resolve.
      '@': path.resolve(__dirname, '../../packages/client/src'),
    },
  },
});
