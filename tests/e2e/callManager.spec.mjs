/**
 * Tests E2E CallManager avec Playwright
 **
 * Installation:
 *   npm install -D @playwright/test
 *   npx playwright install
 *
 * Lancer:
 *   npx playwright test tests/e2e/callManager.spec.mjs
 */

import { test, expect } from '@playwright/test';
import { loginUser, waitForAuthComplete } from './helpers/authHelpers.mjs';
import {
    startCall,
    joinCall,
    leaveCall,
    getCallState,
    createConversation,
    getUserInfo,
    waitForAppReady
} from './helpers/callHelpers.mjs';

const TEST_TIMEOUT = 30000;


// Tests
test.describe('CallManager - E2E', () => {

    // Variables pour cleanup
    let activeCallIds = [];
    let activeConvIds = [];

    test.beforeEach(async ({ page }) => {
        test.setTimeout(TEST_TIMEOUT);
        activeCallIds = [];
        activeConvIds = [];
    });

    test.afterEach(async ({ page }) => {
        // Cleanup: Quitter tous les appels actifs
        for (const callId of activeCallIds) {
            try {
                await page.evaluate(async (callId) => {
                    await fetch(`/leave_call?call_id=${callId}`, {
                        method: 'POST',
                        credentials: 'include'
                    });
                }, callId);
            } catch (error) {
                console.log(`   ⚠️ Cleanup warning: Failed to leave call ${callId}: ${error.message}`);
            }
        }
        console.log(`   🧹 Cleanup complete: ${activeCallIds.length} calls cleaned`);
    });

    test('User can login via /auth flow', async ({ page }) => {
        const user = await loginUser(page, 'e2e_login_' + Date.now());

        // Vérifier qu'on est bien sur /channels
        expect(page.url()).toContain('/channels');

        // Attendre que le flow d'initialisation complet soit terminé
        await waitForAppReady(page);

        // Vérification finale
        const appReady = await page.evaluate(() => {
            return {
                wsState: window.global?.state?.websocket?.readyState,
                wsOpen: WebSocket.OPEN,
                hasCallManager: !!window.global?.state?.callManager,
                hasClientID: !!window.global?.state?.clientID
            };
        });

        expect(appReady.wsState).toBe(appReady.wsOpen);
        expect(appReady.hasCallManager).toBe(true);
        expect(appReady.hasClientID).toBe(true);
    });
});
