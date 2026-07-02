import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@deploykit/client': path.resolve(__dirname, '../../packages/client/src'),
      '@deploykit/shared': path.resolve(__dirname, '../../packages/shared/src'),
      '@': path.resolve(__dirname, '../../packages/client/src'),
    },
  },
});
