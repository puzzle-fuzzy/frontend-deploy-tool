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
    rolldownOptions: {
      output: {
        // Keep the authenticated workspace from becoming one cache-hostile
        // bundle. These groups follow stable dependency boundaries rather than
        // individual screens, so upgrades invalidate only the affected layer.
        codeSplitting: {
          minSize: 0,
          includeDependenciesRecursively: false,
          groups: [
            {
              name: 'ui',
              test: /node_modules\/.*(@base-ui|radix-ui|lucide-react)/,
            },
            {
              name: 'avatar',
              test: /node_modules\/.*@dicebear/,
            },
            {
              name: 'framework',
              test: /node_modules\/.*\/node_modules\/(react|react-dom|scheduler|hono|i18next|react-i18next)\//,
            },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@deploykit/shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@': path.resolve(__dirname, '../../packages/client/src'),
    },
  },
  server: {
    port: 5018,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4010',
      '/deploy': 'http://localhost:4010',
    },
  },
});
