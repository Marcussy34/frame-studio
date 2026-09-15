import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The same alias vite.config.ts uses, so a test can import a component module without
  // its '@/...' imports failing to resolve.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
