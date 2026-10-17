import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import {
    openFriendsArea,
    sendFriendRequestToUsername,
    acceptFriendRequestFromUsername,
    disconnectViaUi,
    reloadAndWaitForApp,
    openPrivateConversation,
    getPrivateConversationIdWithUsername,
} from './helpers/messagingHelpers.mjs';
import { acceptDialog } from './helpers/dialogHelpers.mjs';

const TEST_TIMEOUT = 120000;

// ─── UI helpers ───────────────────────────────────────────────────────────────

/**
 * Opens the "Tous" (all friends) tab in the friends area.
 */
async function openAllFriendsTab(page) {
    // "Tous" is the second .cat tab in the friends header
    await page.locator('#content .selected-info .cat').nth(1).click();
    await page.locator('#friends-block .scrollable').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Removes a friend via the friendCard "…" context menu.
 * Opens the modale, clicks "Retirer l'ami".
 */
async function removeFriendViaUi(page, friendshipId) {
    // Click the "more" action on the friend card
    await page.locator(`.action[data-id="${friendshipId}"][onclick*="more-friends"]`).click();
    await page.locator('#more-friends').waitFor({ state: 'visible', timeout: 5000 });

    // Click "Retirer l'ami" (the critical red item), then confirm in the dialog friend('remove', ...) opens
    await page.locator('#more-friends .item.crit').click();
    await acceptDialog(page);
    await page.locator('#more-friends').waitFor({ state: 'hidden', timeout: 5000 });

    // Wait until the friendship is gone from state
    await page.waitForFunction((fid) => {
        return !(window.global?.user?.friends || []).some((f) => f.id === fid);
    }, friendshipId, { timeout: 10000 });
}

/**
 * Blocks a user via the "Bloquer" button in the private conversation welcome element.
 * Must be called while the private conversation with that user is open.
 */
async function blockUserViaUi(page, userId) {
    const blockBtn = page.locator(`.btn.gray2[onclick*="blockUser(${userId})"]`);
    await blockBtn.waitFor({ state: 'visible', timeout: 10000 });
    await blockBtn.click();

    // Wait until the user appears in window.global.user.blocked
    await page.waitForFunction((id) => {
        return Object.values(window.global?.user?.blocked || {}).some((b) => b.blocked === id);
    }, userId, { timeout: 10000 });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Social — remove friend & block — E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('Remove friend: card disappears after clicking "Retirer" in context menu', async ({ page }) => {
        const suffix = Date.now();
        const accountA = `e2e_social_a_${suffix}`;
        const accountB = `e2e_social_b_${suffix}`;
        let userAUsername, userBUsername;

        // ── 1. Build a friendship between A and B ─────────────────────────────
        await loginUser(page, accountA);
        await waitForAppReady(page);
        userAUsername = await page.evaluate(() => window.global?.user?.username);
        await disconnectViaUi(page);

        await loginUser(page, accountB);
        await waitForAppReady(page);
        userBUsername = await page.evaluate(() => window.global?.user?.username);
        await openFriendsArea(page);
        await sendFriendRequestToUsername(page, userAUsername);
        await disconnectViaUi(page);

        await loginUser(page, accountA);
        await waitForAppReady(page);
        await openFriendsArea(page);
        await acceptFriendRequestFromUsername(page, userBUsername);
        await reloadAndWaitForApp(page);

        // Sanity: friendship exists in state
        const friendship = await page.evaluate((name) => {
            const user = window.global?.user;
            const users = window.global?.users || {};
            return (user?.friends || []).find((f) => {
                const other = f.kopinprincipal === user.id ? f.kopinsecondaire : f.kopinprincipal;
                return users[other]?.username === name;
            }) || null;
        }, userBUsername);
        expect(friendship).not.toBeNull();

        // ── 2. Navigate to the "Tous" tab and find the friend card ────────────
        await openFriendsArea(page);
        await openAllFriendsTab(page);

        // Friend card should be visible
        await expect(
            page.locator(`.action[data-id="${friendship.id}"][onclick*="more-friends"]`),
        ).toBeVisible({ timeout: 10000 });

        // ── 3. Remove via the "…" context menu ────────────────────────────────
        await removeFriendViaUi(page, friendship.id);

        // Friend card is gone from the DOM
        await expect(
            page.locator(`.action[data-id="${friendship.id}"]`),
        ).toHaveCount(0, { timeout: 5000 });

        // ── 4. Calling remove again returns 403 (double-remove protection) ────
        const status = await page.evaluate(async (id) => {
            const r = await fetch(`/remove_friend?friendship_id=${id}`, {
                method: 'POST', credentials: 'include',
            });
            return r.status;
        }, friendship.id);
        expect(status).toBe(403);

        // ── 5. Reload and verify friend is still gone ─────────────────────────
        await reloadAndWaitForApp(page);
        const friendsAfterReload = await page.evaluate((name) => {
            const user = window.global?.user;
            const users = window.global?.users || {};
            return (user?.friends || []).some((f) => {
                const other = f.kopinprincipal === user.id ? f.kopinsecondaire : f.kopinprincipal;
                return users[other]?.username === name;
            });
        }, userBUsername);
        expect(friendsAfterReload).toBe(false);
    });

    test('Block user: button in DM welcome area, user appears in blocked list', async ({ page }) => {
        const suffix = Date.now();
        const accountA = `e2e_block_a_${suffix}`;
        const accountB = `e2e_block_b_${suffix}`;
        let userBId;

        // ── 1. Build friendship so A has a DM with B ──────────────────────────
        await loginUser(page, accountA);
        await waitForAppReady(page);
        const userAUsername = await page.evaluate(() => window.global?.user?.username);
        await disconnectViaUi(page);

        await loginUser(page, accountB);
        await waitForAppReady(page);
        userBId = await page.evaluate(() => window.global?.user?.id);
        const userBUsername = await page.evaluate(() => window.global?.user?.username);
        await openFriendsArea(page);
        await sendFriendRequestToUsername(page, userAUsername);
        await disconnectViaUi(page);

        await loginUser(page, accountA);
        await waitForAppReady(page);
        await openFriendsArea(page);
        await acceptFriendRequestFromUsername(page, userBUsername);
        await reloadAndWaitForApp(page);

        // ── 2. Open the private conversation with B ───────────────────────────
        const convId = await getPrivateConversationIdWithUsername(page, userBUsername);
        expect(convId).toBeGreaterThan(0);
        await openPrivateConversation(page, convId);

        // ── 3. Block via the "Bloquer" button in the welcome element ──────────
        const blockedBefore = await page.evaluate(() => Object.values(window.global?.user?.blocked || {}));
        expect(blockedBefore.some((b) => b.blocked === userBId)).toBe(false);

        await blockUserViaUi(page, userBId);

        // Blocked list shows User B
        const blockedAfter = await page.evaluate(() => Object.values(window.global?.user?.blocked || {}));
        expect(blockedAfter.some((b) => b.blocked === userBId)).toBe(true);

        // ── 4. Blocking again is idempotent (API returns already_blocked) ─────
        const blockAgain = await page.evaluate(async (id) => {
            const r = await fetch(`/block_user?user_id=${id}`, { method: 'POST', credentials: 'include' });
            return r.json();
        }, userBId);
        expect(blockAgain.status).toBe('already_blocked');

        // ── 5. Reload and verify block persists ───────────────────────────────
        await reloadAndWaitForApp(page);
        const blockedReloaded = await page.evaluate(() => Object.values(window.global?.user?.blocked || {}));
        expect(blockedReloaded.some((b) => b.blocked === userBId)).toBe(true);
    });
});
