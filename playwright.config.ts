import { defineConfig } from '@playwright/test';

// This is the core author's e2e suite; the demo project has its own config.
export default defineConfig({
  testDir: 'test/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 180_000,
  reporter: 'list',
  use: { trace: 'off' },
});
