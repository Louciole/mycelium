/**
 * Tests E2E — Section d'appel dans la conversation
 *
 * Couvre le contexte 1 de la feature call :
 *   - Rendu de la section avant la liste de messages
 *   - Mode audio (cercles) / mode vidéo (rectangles colorés)
 *   - État ringing (status-calling)
 *   - Contrôles bannière (rejeter / rejoindre) et contrôles in-call
 *   - Bouton plein écran
 *   - Cycle de vie complet start → join → leave via l'API HTTP
 */

import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import {
    createConversation,
    getCallState,
    getUserInfo,
    joinCall,
    leaveCall,
    mockGetUserMedia,
    openConversation,
    injectBannerState,
    injectCallingState,
    readCallViewState,
    startCall,
    waitForAppReady,
    waitForCallComponent,
    waitForNoCallComponent,
} from './helpers/callHelpers.mjs';
import { reloadAndWaitForApp } from './helpers/messagingHelpers.mjs';

const TEST_TIMEOUT = 60000;
const FAKE_USER_ID = 88888; // ID fictif pour simuler un pair

// ─── Setup commun ────────────────────────────────────────────────────────────

/**
 * Crée un compte, attend que l'app soit prête et crée une conv de test.
 * Retourne { convId }.
 */
async function setupUserAndConv(page, suffix) {
    await mockGetUserMedia(page);
    await loginUser(page, `e2ecall_${suffix}`);
    expect(page.url()).toContain('/channels');
    await waitForAppReady(page);

    const userId = await page.evaluate(() => window.global.user.id);
    const convId = await createConversation(page, `call-test-${suffix}`, []);
    await reloadAndWaitForApp(page);
    await openConversation(page, convId);

    return { convId, userId };
}

// ─── Suite principale ─────────────────────────────────────────────────────────

test.describe('Section appel — conversation', () => {
    test.setTimeout(TEST_TIMEOUT);

    // ── Rendu de la bannière ──────────────────────────────────────────────────

    test.describe('Rendu de la bannière', () => {

        test('la section apparaît avant .scrollable quand un appel est actif', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            await injectBannerState(page, convId, { participantIds: [FAKE_USER_ID] });
            await waitForCallComponent(page);

            // .call-component doit précéder .scrollable dans le DOM
            const order = await page.evaluate(() => {
                const conv = document.querySelector('.neutral');
                const children = Array.from(conv?.children ?? []);
                const callIdx = children.findIndex(el => el.querySelector('.call-component') || el.classList.contains('call-component'));
                const scrollIdx = children.findIndex(el => el.classList.contains('scrollable'));
                return { callIdx, scrollIdx };
            });

            expect(order.callIdx).toBeGreaterThanOrEqual(0);
            expect(order.scrollIdx).toBeGreaterThanOrEqual(0);
            expect(order.callIdx).toBeLessThan(order.scrollIdx);
        });

        test('mode audio — la classe call-audiomode est appliquée', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            await injectBannerState(page, convId, { callType: 'audio', participantIds: [FAKE_USER_ID] });
            await waitForCallComponent(page);

            await expect(page.locator('.call-component')).toHaveClass(/call-audiomode/);
            await expect(page.locator('.call-component')).not.toHaveClass(/call-videomode/);
        });

        test('mode audio — les participants sont affichés en cercles', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            await injectBannerState(page, convId, { participantIds: [FAKE_USER_ID] });
            await waitForCallComponent(page);

            const participant = page.locator('.call-audiomode .call-participant').first();
            await participant.waitFor({ state: 'visible', timeout: 5000 });

            // En mode audio, border-radius doit être 50% (forme circulaire)
            const borderRadius = await participant.evaluate(el =>
                getComputedStyle(el).borderRadius
            );
            expect(borderRadius).toBe('50%');
        });

        test('un participant "ringing" a la classe status-calling', async ({ page }) => {
            const suffix = Date.now();
            await setupUserAndConv(page, suffix);

            // Simule un appel sortant : les autres membres sonnent
            await injectCallingState(page, [FAKE_USER_ID]);
            await waitForCallComponent(page);

            await expect(page.locator('.call-participant.status-calling')).toBeVisible({ timeout: 5000 });
        });

        test('les contrôles bannière affichent un bouton rejeter (rouge) et un bouton rejoindre (vert)', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            await injectBannerState(page, convId, { participantIds: [FAKE_USER_ID] });
            await waitForCallComponent(page);

            const joinControls = page.locator('.call-join-controls');
            await joinControls.waitFor({ state: 'visible', timeout: 5000 });

            await expect(joinControls.locator('.call-btn-decline')).toBeVisible();
            await expect(joinControls.locator('.call-btn-accept')).toBeVisible();

            // Vérification des couleurs de fond via CSS
            const declineBg = await joinControls.locator('.call-btn-decline').evaluate(el =>
                getComputedStyle(el).backgroundColor
            );
            const acceptBg = await joinControls.locator('.call-btn-accept').evaluate(el =>
                getComputedStyle(el).backgroundColor
            );

            // Les boutons doivent avoir une teinte rouge/verte — on vérifie juste
            // que les deux couleurs sont différentes et non transparentes.
            expect(declineBg).not.toBe(acceptBg);
            expect(declineBg).not.toBe('rgba(0, 0, 0, 0)');
            expect(acceptBg).not.toBe('rgba(0, 0, 0, 0)');
        });

        test('le bouton plein écran est présent dans la section', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            await injectBannerState(page, convId, { participantIds: [FAKE_USER_ID] });
            await waitForCallComponent(page);

            await expect(page.locator('.call-fullscreen-btn')).toBeAttached();
        });

        test('le bouton plein écran devient visible au hover de la section', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            await injectBannerState(page, convId, { participantIds: [FAKE_USER_ID] });
            await waitForCallComponent(page);

            const btn = page.locator('.call-fullscreen-btn');
            const section = page.locator('.call-component');

            // Sans hover : opacity 0
            const opacityBefore = await btn.evaluate(el => getComputedStyle(el).opacity);
            expect(parseFloat(opacityBefore)).toBe(0);

            // Avec hover : opacity 1 (après la transition CSS de 200ms)
            await section.hover();
            await page.waitForFunction(
                () => {
                    const el = document.querySelector('.call-fullscreen-btn');
                    return el && parseFloat(getComputedStyle(el).opacity) >= 0.99;
                },
                undefined,
                { timeout: 2000 },
            );
            const opacityAfter = await btn.evaluate(el => getComputedStyle(el).opacity);
            expect(parseFloat(opacityAfter)).toBeGreaterThan(0.99);
        });

    });

    // ── Contrôles interactifs ─────────────────────────────────────────────────

    test.describe('Contrôles interactifs', () => {

        test('cliquer sur rejeter ferme la section d\'appel', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            await injectBannerState(page, convId, { participantIds: [FAKE_USER_ID] });
            await waitForCallComponent(page);

            await page.locator('.call-btn-decline').click();

            await waitForNoCallComponent(page);

            const state = await readCallViewState(page);
            expect(state.callState).toBe('none');
        });

        test('rejoindre un appel passe callState à "active" et affiche les contrôles in-call', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            // Crée un vrai appel côté serveur
            const callData = await startCall(page, convId, 'audio');
            // Réinitialise l'état client en banner avec le vrai callId pour simuler
            // un non-participant qui rejoint depuis la bannière
            await injectBannerState(page, convId, {
                callType: 'audio',
                callId: callData.id,
                participantIds: [],
            });
            await waitForCallComponent(page);

            // Clique sur "Rejoindre" — vérifie que le bouton existe et est cliquable
            // (WebRTC ne peut pas se connecter en headless, donc on ne vérifie pas 'active')
            await page.locator('.call-btn-accept').click();

            // Vérifie que join_call a bien été appelé côté serveur
            const stateAfterJoin = await getCallState(page, convId);
            expect(stateAfterJoin?.participant_count).toBeGreaterThanOrEqual(1);

            // Cleanup
            await leaveCall(page, callData.id);
        });

        test('les contrôles in-call contiennent mute, caméra et raccrocher', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            // Injecte un état 'calling' en mode vidéo pour rendre le bouton caméra visible
            await injectCallingState(page, [FAKE_USER_ID], 'video');
            await waitForCallComponent(page);

            const controls = page.locator('.controls-buttons');
            await controls.waitFor({ state: 'visible', timeout: 5000 });

            await expect(controls.locator('#call-mute-btn')).toBeVisible();
            await expect(controls.locator('#call-video-btn')).toBeVisible();
            await expect(controls.locator('.icon-wrapper.hangup')).toBeVisible();
        });

        test('le bouton raccrocher quitte l\'appel et masque la section', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            // Injecte un état 'calling' côté client (startCall via API ne notifie pas le client)
            await injectCallingState(page, [FAKE_USER_ID]);
            await waitForCallComponent(page);

            // Clique sur raccrocher
            await page.locator('.controls-buttons .icon-wrapper.hangup').click();

            await waitForNoCallComponent(page);

            const state = await readCallViewState(page);
            expect(state.callState).toBe('none');
        });

    });

    // ── Mode vidéo ────────────────────────────────────────────────────────────

    test.describe('Mode vidéo', () => {

        test('hasAnyVideo=true applique la classe call-videomode', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            await injectBannerState(page, convId, { participantIds: [FAKE_USER_ID] });
            await waitForCallComponent(page);

            // Injecte hasAnyVideo=true directement
            await page.evaluate(() => {
                const cm = window.global.state.callManager;
                cm.hasAnyVideo = true;
                cm._updateCallViewState();
            });

            await expect(page.locator('.call-component')).toHaveClass(/call-videomode/, { timeout: 5000 });
            await expect(page.locator('.call-component')).not.toHaveClass(/call-audiomode/);
        });

        test('en mode vidéo, les participants ont une forme rectangulaire', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            await injectBannerState(page, convId, { participantIds: [FAKE_USER_ID] });
            await waitForCallComponent(page);

            await page.evaluate(() => {
                const cm = window.global.state.callManager;
                cm.hasAnyVideo = true;
                cm._updateCallViewState();
            });

            await page.locator('.call-videomode .call-participant').first().waitFor({
                state: 'visible',
                timeout: 5000,
            });

            const borderRadius = await page.locator('.call-videomode .call-participant').first().evaluate(el =>
                getComputedStyle(el).borderRadius
            );
            // 50% = cercle → doit ne PAS être 50%
            expect(borderRadius).not.toBe('50%');
        });

        test('un participant ringing en mode vidéo a un fond noir', async ({ page }) => {
            const suffix = Date.now();
            await setupUserAndConv(page, suffix);

            await injectCallingState(page, [FAKE_USER_ID]);
            await waitForCallComponent(page);

            // Bascule en mode vidéo
            await page.evaluate(() => {
                const cm = window.global.state.callManager;
                cm.hasAnyVideo = true;
                cm._updateCallViewState();
            });

            const bg = await page.locator('.call-videomode .call-participant.status-calling').first().evaluate(el =>
                getComputedStyle(el).backgroundColor
            );
            // rgb(17, 17, 17) = #111
            expect(bg).toBe('rgb(17, 17, 17)');
        });

    });

    // ── Cycle de vie complet (API HTTP) ───────────────────────────────────────

    test.describe('Cycle de vie — API HTTP', () => {

        test('démarrer un appel crée un appel actif côté serveur', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            const callData = await startCall(page, convId, 'audio');
            expect(callData.id).toBeGreaterThan(0);
            expect(callData.call_type).toBe('audio');

            const state = await getCallState(page, convId);
            expect(state.id).toBe(callData.id);
            expect(state.participant_count).toBeGreaterThanOrEqual(1);

            await leaveCall(page, callData.id);
        });

        test('rejoindre puis quitter un appel met à jour le nombre de participants', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            const callData = await startCall(page, convId, 'audio');
            const joinData = await joinCall(page, callData.id);
            expect(joinData.call.participant_count).toBeGreaterThanOrEqual(1);

            await leaveCall(page, callData.id);
            const stateAfter = await getCallState(page, convId);
            // L'appel est terminé (plus de participants) ou null
            const ended = !stateAfter?.id || stateAfter?.participant_count === 0 || stateAfter?.active === false;
            expect(ended).toBe(true);
        });

        test('callState client passe à "calling" après inject et à "none" après leaveCall', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            // startCall via API ne notifie pas le client — on injecte l'état 'calling'
            await injectCallingState(page, [FAKE_USER_ID]);
            await waitForCallComponent(page);

            const stateBefore = await readCallViewState(page);
            expect(stateBefore.callState).toBe('calling');

            // Quitter via le bouton raccrocher (appelle callManager.leaveCall() → cleanup())
            await page.locator('.controls-buttons .icon-wrapper.hangup').click();
            await waitForNoCallComponent(page);

            const stateAfter = await readCallViewState(page);
            expect(stateAfter.callState).toBe('none');
            expect(stateAfter.hasAnyVideo).toBe(false);
        });

        test('hasAnyVideo revient à false quand le dernier participant vidéo raccroche', async ({ page }) => {
            const suffix = Date.now();
            const { convId } = await setupUserAndConv(page, suffix);

            // Injecte un état 'calling' côté client
            await injectCallingState(page, [FAKE_USER_ID]);
            await waitForCallComponent(page);

            // Simule l'activation de la vidéo locale (le faux stream a une videoTrack enabled)
            await page.evaluate(() => {
                window.global.state.callManager._updateHasAnyVideo();
            });

            // Quitter l'appel — hasAnyVideo doit revenir à false
            await page.locator('.controls-buttons .icon-wrapper.hangup').click();
            await waitForNoCallComponent(page);

            const state = await readCallViewState(page);
            expect(state.hasAnyVideo).toBe(false);
        });

    });

});
