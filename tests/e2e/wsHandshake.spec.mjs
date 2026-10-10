import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';

// The WS handshake is: WS "register" -> server answers "register_request" with a
// connectionId -> client calls /authWS?connectionId=N over HTTP -> gets its clientID.
// If /authWS fails the client used to keep the open socket without a clientID and
// the app stayed on "Mycelium is loading" forever.

test.describe('WebSocket handshake', () => {
    test.setTimeout(120000);

    test('every reload completes the handshake', async ({ page }) => {
        await loginUser(page, `e2e_ws_reload_${Date.now()}`);
        await waitForAppReady(page);

        const authStatuses = [];
        page.on('response', (r) => {
            if (r.url().includes('/authWS')) authStatuses.push(r.status());
        });

        for (let i = 0; i < 12; i++) {
            await page.reload();
            await waitForAppReady(page, 10000);
        }
        // Every attempt must have succeeded first time: a failure here means the
        // HTTP request did not reach the process holding the socket (e.g. a second
        // server.py sharing the HTTP port through SO_REUSEPORT).
        expect(authStatuses.filter((s) => s !== 200)).toEqual([]);
    });

    test('a failed /authWS reconnects instead of hanging', async ({ page }) => {
        await loginUser(page, `e2e_ws_retry_${Date.now()}`);
        await waitForAppReady(page);

        // Unknown or already used connectionId: a clean 404, not a 500 KeyError.
        const usedId = await page.request.get('/authWS?connectionId=999999999');
        expect(usedId.status()).toBe(404);

        let failed = 0;
        await page.route('**/authWS?*', async (route) => {
            if (failed++ === 0) {
                await route.fulfill({ status: 500, contentType: 'text/html', body: '<h1>500</h1>' });
            } else {
                await route.continue();
            }
        });

        await page.reload();
        await waitForAppReady(page, 15000);
        expect(failed).toBeGreaterThanOrEqual(2);
    });
});
