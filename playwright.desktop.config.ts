import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './desktop-tests',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 90_000,
  use: { trace: 'retain-on-failure' },
  outputDir: 'test-results/desktop',
});
