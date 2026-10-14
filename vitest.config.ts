import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  plugins: [svelte()],
  resolve: {
    // svelte ships separate server/client builds; tests need the client one
    conditions: ['browser'],
    alias: {
      '@ibh/policy': path.resolve(__dirname, 'packages/policy/src/index.ts'),
      '@ibh/executor': path.resolve(__dirname, 'packages/executor/src/index.ts'),
      '@ibh/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@ibh/ui': path.resolve(__dirname, 'packages/ui/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.{ts,tsx}',
      'examples/proxy/cloudflare/worker.test.js',
      'examples/proxy/usage.test.js',
    ],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
});
