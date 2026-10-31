// Parallel app boots, the part every E2E test starts with: signup + first boot,
// then reloads, timing each until waitForAppReady.
//
//   npx playwright test --config tests/perf/playwright.perf.config.mjs
//   WORKERS=8 BOOTS=8 RELOADS=3 E2E_BASE_URL=http://localhost:808 (nginx) ...
import { test } from '@playwright/test';
import { loginUser } from '../e2e/helpers/authHelpers.mjs';
import { waitForAppReady } from '../e2e/helpers/callHelpers.mjs';

const BOOTS = Number(process.env.BOOTS || 8);
const RELOADS = Number(process.env.RELOADS || 3);

test.describe.configure({ mode: 'parallel' });
for (let i = 0; i < BOOTS; i++) {
    test(`boot ${i}`, async ({ page }) => {
        test.setTimeout(180000);
        const t0 = Date.now();
        await loginUser(page, `e2e_boot_${Date.now()}_${i}`);
        await waitForAppReady(page, 60000);
        const first = Date.now() - t0;
        const reloads = [];
        for (let k = 0; k < RELOADS; k++) {
            const t = Date.now();
            await page.reload();
            await waitForAppReady(page, 60000);
            reloads.push(Date.now() - t);
        }
        console.log(`BOOTRESULT ${JSON.stringify({ i, first, reloads })}`);
    });
}
