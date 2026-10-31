import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { SERVER_URL } from './e2e/helpers/authHelpers.mjs';

// Absolute paths: the root playwright.config.mjs re-exports this config, and
// relative ones would resolve against the repo root.
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  testDir: here('./e2e'),
  // Tests, not just files, are spread over the workers: the two biggest files
  // (channelPermissions, vocalChannel) take 6-7 min each on their own.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Locally, past 4 workers the browsers saturate the CPU and the WSL server slows
  // down instead (measured: 8 workers is no faster, and its boots time out).
  workers: process.env.CI ? 1 : Number(process.env.E2E_WORKERS || 4),
  reporter: 'html',
  // Deletes the servers the tests created (see e2e/helpers/cleanupHelpers.mjs)
  globalTeardown: here('./e2e/helpers/globalTeardown.mjs'),

  // Serves /static/ and proxies the rest to the app (see e2e/frontServer.mjs);
  // skipped when E2E_BASE_URL points somewhere else (e.g. nginx on :808).
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node e2e/frontServer.mjs',
    cwd: here('.'),
    url: `${SERVER_URL}/static/404.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },

  use: {
    baseURL: SERVER_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
