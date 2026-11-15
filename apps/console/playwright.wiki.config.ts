import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'wiki-editor.spec.ts', workers: 1,
  timeout: 60_000, use: { ...devices['Desktop Chrome'] },
});
