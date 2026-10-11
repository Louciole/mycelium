import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { disconnectViaUi } from './helpers/messagingHelpers.mjs';
import { recordCreatedServer } from './helpers/cleanupHelpers.mjs';
import {
    createServerViaUi,
    expectServerLoadedWithDefaultChannel,
    getServerIds,
    goToCreateServerFinalStep,
    openCreateServerModal,
    openServerFromSidebarById
} from './helpers/serverHelpers.mjs';

const TEST_TIMEOUT = 90000;

test.describe('Server creation - E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('User can create a server via UI and keep it after reload/relogin', async ({ page }) => {
        const suffix = Date.now();
        const account = `e2e_server_${suffix}`;

        // 1) Login with a fresh account
        await loginUser(page, account);
        expect(page.url()).toContain('/channels');
        await waitForAppReady(page);

        const beforeServerIds = await getServerIds(page);
        const beforeSidebarCount = await page.locator('#servers .item.serveur').count();

        // 2) Create server from the modal flow
        const createdServerId = await createServerViaUi(page);

        // 3) Validate immediate UI/state success
        const afterServerIds = await getServerIds(page);
        const afterSidebarCount = await page.locator('#servers .item.serveur').count();

        expect(afterServerIds.length).toBe(beforeServerIds.length + 1);
        expect(afterSidebarCount).toBe(beforeSidebarCount + 1);
        expect(afterServerIds).toContain(createdServerId);

        const createdServerName = await page.evaluate((id) => window.global?.servers?.[id]?.name, createdServerId);
        expect(createdServerName).toBe('New Server');

        // 4) Open the new server through the sidebar and verify default channel load
        await openServerFromSidebarById(page, createdServerId);
        await expectServerLoadedWithDefaultChannel(page, createdServerId);

        // 5) Reload and verify persistence
        await page.reload();
        await page.waitForURL('**/channels**', { timeout: 10000 });
        await waitForAppReady(page);

        const idsAfterReload = await getServerIds(page);
        expect(idsAfterReload).toContain(createdServerId);

        // 6) Logout/login and verify persistence again
        await disconnectViaUi(page);

        await loginUser(page, account);
        expect(page.url()).toContain('/channels');
        await waitForAppReady(page);

        const idsAfterRelogin = await getServerIds(page);
        expect(idsAfterRelogin).toContain(createdServerId);
    });

    test('User can name the server in the creation modal and the name persists', async ({ page }) => {
        const suffix = Date.now();
        // Markup-like characters check that the sidebar renders the name as text.
        const serverName = `<i>Mon</i> serveur & co ${suffix}`;

        await loginUser(page, `e2e_server_named_${suffix}`);
        await waitForAppReady(page);

        const createdServerId = await createServerViaUi(page, serverName);

        expect(await serverNameInState(page, createdServerId)).toBe(serverName);
        await expect(sidebarTooltip(page, createdServerId)).toHaveText(serverName);
        await expect(page.locator(`#server-item-${createdServerId}`)).toHaveText('<s');

        // Persisted server-side: still there after a reload (get_user_servers)
        await page.reload();
        await page.waitForURL('**/channels**', { timeout: 10000 });
        await waitForAppReady(page);

        expect(await serverNameInState(page, createdServerId)).toBe(serverName);
        await expect(sidebarTooltip(page, createdServerId)).toHaveText(serverName);
    });

    test('Server name field: Enter key, reset on reopen, 44-char cap, default name and API validation', async ({ page }) => {
        const suffix = Date.now();
        await loginUser(page, `e2e_server_name_rules_${suffix}`);
        await waitForAppReady(page);

        const nameInput = page.locator('#create-server-name');

        // 1) Pressing Enter in the field creates the server
        const enterName = `Entree ${suffix}`;
        let beforeIds = await getServerIds(page);
        await openCreateServerModal(page);
        await goToCreateServerFinalStep(page);
        await nameInput.fill(enterName);
        await nameInput.press('Enter');
        await page.locator('#create-server').waitFor({ state: 'hidden', timeout: 10000 });
        const enterServerId = await waitForNewServer(page, beforeIds);
        expect(await serverNameInState(page, enterServerId)).toBe(enterName);

        // 2) Reopening the modal resets the field, and typing is capped at 44 chars
        await openCreateServerModal(page);
        await goToCreateServerFinalStep(page);
        await expect(nameInput).toHaveValue('');
        await nameInput.pressSequentially('x'.repeat(50));
        await expect(nameInput).toHaveValue('x'.repeat(44));

        beforeIds = await getServerIds(page);
        await page.locator('#createServerSteps .step').nth(1).locator('.btn.blue').click();
        await page.locator('#create-server').waitFor({ state: 'hidden', timeout: 10000 });
        const cappedServerId = await waitForNewServer(page, beforeIds);
        expect(await serverNameInState(page, cappedServerId)).toBe('x'.repeat(44));

        // 3) Leaving the field empty (after the reset) gives the default name
        const defaultServerId = await createServerViaUi(page);
        expect(await serverNameInState(page, defaultServerId)).toBe('New Server');

        // 4) Backend rejects names longer than server.name's varchar(44)
        const tooLong = await page.evaluate(async (name) => {
            const r = await fetch('/create_server?name=' + encodeURIComponent(name), { method: 'POST', credentials: 'include' });
            return r.status;
        }, 'y'.repeat(45));
        expect(tooLong).toBe(400);
    });
});

/** Name of a server as currently held in global state. */
function serverNameInState(page, serverId) {
    return page.evaluate((id) => window.global?.servers?.[id]?.name, serverId);
}

/** Tooltip showing the server name next to its sidebar icon. */
function sidebarTooltip(page, serverId) {
    return page.locator('#servers .container')
        .filter({ has: page.locator(`#server-item-${serverId}`) })
        .locator('.tooltip');
}

/** Waits until a server not in `previousIds` shows up in state and returns its id. */
async function waitForNewServer(page, previousIds) {
    const handle = await page.waitForFunction((before) => {
        const ids = Object.values(window.global?.servers || {})
            .map((server) => Number(server?.id))
            .filter((id) => Number.isFinite(id));
        return ids.find((id) => !before.includes(id)) || false;
    }, previousIds, { timeout: 10000 });
    const serverId = await handle.jsonValue();
    recordCreatedServer(page, serverId);
    return serverId;
}

