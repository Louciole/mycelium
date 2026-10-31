import { test, expect } from '@playwright/test';
import { loginUser, SERVER_URL } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { createServerViaUi, openServerFromSidebarById, getServerIds } from './helpers/serverHelpers.mjs';
import { disconnectViaUi, reloadAndWaitForApp } from './helpers/messagingHelpers.mjs';
import { api, setupServer, status } from './helpers/permissionHelpers.mjs';

const TEST_TIMEOUT = 120000;

// ─── UI helpers ───────────────────────────────────────────────────────────────

/**
 * Generates an invite link via the server settings menu.
 * Returns the invite code, the end of the link shown in the invitation modal.
 */
async function generateInviteViaUi(page) {
    // Open the server context menu (click on the server name bar)
    await page.locator('#server-infos').click();
    await page.locator('#server-settings').waitFor({ state: 'visible', timeout: 5000 });

    // Click "Inviter des gens" — the blue item at the top
    await page.locator('#server-settings .item.blue[onclick="createInvitation()"]').click();

    // Wait for the invitation modal with the link
    await page.locator('#server-invitation').waitFor({ state: 'visible', timeout: 10000 });

    // The link shown in the modal ends with the code
    const code = await page.waitForFunction(() => {
        const link = document.getElementById('invitation-link')?.value;
        return link ? link.split('/').pop() : null;
    }, { timeout: 10000 });

    const inviteCode = await code.jsonValue();
    expect(inviteCode).toBeTruthy();

    // The input in the modal should contain the full URL with the code
    const inputValue = await page.locator('#server-invitation input[readonly]').inputValue();
    expect(inputValue).toContain(inviteCode);

    // Close the modal
    await page.locator('#server-invitation .close').click();
    await page.locator('#server-invitation').waitFor({ state: 'hidden', timeout: 5000 });

    return inviteCode;
}

/**
 * Leaves a server — used for cleanup via direct API since there is no
 * dedicated "leave server" button accessible in a straightforward UI path.
 */
async function leaveServerApi(page, serverId) {
    const result = await page.evaluate(async (id) => {
        const r = await fetch(`/leave_server?server_id=${id}`, { method: 'POST', credentials: 'include' });
        if (!r.ok) throw new Error(`leave_server ${r.status}`);
        return r.json();
    }, serverId);
    expect(result).toMatchObject({ ok: true });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Invitations — E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('Generate invite via UI, User B joins via URL, leaves, User A deletes server', async ({ page }) => {
        const suffix = Date.now();
        const accountA = `e2e_inv_a_${suffix}`;
        const accountB = `e2e_inv_b_${suffix}`;

        // ── 1. User A creates a server and generates an invite ────────────────
        await loginUser(page, accountA);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        const serverName = await page.evaluate(() => window.global?.state?.currentServer?.name);
        expect(serverName).toBeTruthy();

        const inviteCode = await generateInviteViaUi(page);

        // Calling the invite endpoint a second time returns the same cached code
        const inviteCode2 = await page.evaluate(async (id) => {
            const r = await fetch(`/create_invitation?server_id=${id}`, { method: 'POST', credentials: 'include' });
            return (await r.text()).replace(/"/g, '').trim();
        }, serverId);
        expect(inviteCode2).toBe(inviteCode);

        await disconnectViaUi(page);

        // ── 2. User B navigates to the invitation page ────────────────────────
        await loginUser(page, accountB);
        await waitForAppReady(page);

        const beforeJoin = await getServerIds(page);

        // Navigate to the invite URL as a logged-in user — the server shows the
        // invitation-snippet.html with a "Rejoindre" button
        await page.goto(`${SERVER_URL}/${inviteCode}`);

        // The invitation page shows the server name and a "Rejoindre" link/button
        await expect(page.locator('h2')).toContainText(serverName, { timeout: 10000 });

        // "Rejoindre" joins, then the page goes to the server (invitation.mjs joinInvitation)
        await Promise.all([
            page.waitForURL(`**/channels#${serverId}`, { timeout: 15000 }),
            page.locator('#join-invite-btn').click(),
        ]);

        await waitForAppReady(page);

        // The new server should now be in User B's server list
        const afterJoin = await getServerIds(page);
        expect(afterJoin.length).toBe(beforeJoin.length + 1);
        expect(afterJoin).toContain(serverId);

        // The server name is visible in state
        const joinedName = await page.evaluate((id) => window.global?.servers?.[id]?.name, serverId);
        expect(joinedName).toBe(serverName);

        // Sidebar entry for the server exists
        const serverIcons = page.locator('#servers .item.serveur');
        await expect(serverIcons).toHaveCount(afterJoin.length, { timeout: 5000 });

        // ── 3. User B leaves the server ───────────────────────────────────────
        await leaveServerApi(page, serverId);
        await reloadAndWaitForApp(page);

        const afterLeave = await getServerIds(page);
        expect(afterLeave).not.toContain(serverId);

        await disconnectViaUi(page);

        // ── 4. User A deletes the server ──────────────────────────────────────
        await loginUser(page, accountA);
        await waitForAppReady(page);

        const beforeDelete = await getServerIds(page);
        expect(beforeDelete).toContain(serverId);

        // Delete via API — there is no dedicated "delete server" button in the UI
        await page.evaluate(async (id) => {
            await fetch(`/delete_server?server_id=${id}`, { method: 'POST', credentials: 'include', redirect: 'follow' });
        }, serverId);

        await reloadAndWaitForApp(page);

        const afterDelete = await getServerIds(page);
        expect(afterDelete).not.toContain(serverId);
    });

    test('A banned member who clicks "Rejoindre" is told the invitation is invalid', async ({ browser }) => {
        const s = await setupServer(browser, 'inv_banned', 1);
        const [b] = s.members;
        const code = (await api(s.owner, `/create_invitation?server_id=${s.serverId}`)).text.replace(/"/g, '').trim();
        await api(s.owner, `/ban_member?server_id=${s.serverId}&account_id=${b.id}`);

        await b.page.goto(`${SERVER_URL}/${code}`);
        await b.page.locator('#join-invite-btn').click();
        await expect(b.page.locator('h2')).toHaveText('Invitation invalide', { timeout: 10000 });
        expect(await status(b.page, `/get_serv_content?server_id=${s.serverId}`)).toBe(403);   // not a member
        await s.close();
    });
});
