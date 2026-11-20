import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a running stack (docker compose: web on :8080 proxying /api).
 * CI runs them in the docker job; locally: `npm run e2e -w apps/web` with the stack up.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    viewport: { width: 1200, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 800 } },
    },
  ],
});
