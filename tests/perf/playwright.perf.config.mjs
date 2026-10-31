import { defineConfig, devices } from '@playwright/test';
import base from '../playwright.config.mjs';

export default defineConfig({
    testDir: '.',
    testMatch: '*.bench.mjs',
    workers: Number(process.env.WORKERS || 8),
    reporter: 'line',
    webServer: base.webServer,
    use: { baseURL: base.use.baseURL, video: process.env.VIDEO || 'off' },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
