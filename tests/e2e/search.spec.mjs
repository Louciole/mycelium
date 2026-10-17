import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { createServerViaUi, openServerFromSidebarById, expectServerLoadedWithDefaultChannel } from './helpers/serverHelpers.mjs';
import { reloadAndWaitForApp } from './helpers/messagingHelpers.mjs';

const TEST_TIMEOUT = 120000;

// thin API helper (same shape as moderation.spec.mjs)
async function api(page, path, { method = 'POST', expectOk = true } = {}) {
    return page.evaluate(async ({ path, method }) => {
        const r = await fetch(path, { method, credentials: 'include' });
        const text = await r.text();
        return { status: r.status, text };
    }, { path, method }).then((res) => {
        if (expectOk && (res.status < 200 || res.status >= 300)) {
            throw new Error(`${method} ${path} → ${res.status}: ${res.text}`);
        }
        return res;
    });
}

async function openPalette(page) {
    await page.keyboard.press('Control+k');
    await expect(page.locator('#search-palette')).toBeVisible();
}

test.describe('Global search (Ctrl+K)', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('palette opens with Ctrl+K and closes with Escape', async ({ page }) => {
        await loginUser(page, `srchui_a_${Date.now()}`);
        await waitForAppReady(page);

        await openPalette(page);
        await page.keyboard.press('Escape');
        await expect(page.locator('#search-palette')).toBeHidden();
    });

    test('finds a channel locally and navigates to it with Enter', async ({ page }) => {
        await loginUser(page, `srchui_b_${Date.now()}`);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);
        await expectServerLoadedWithDefaultChannel(page, serverId);

        const chanId = await page.evaluate(() => window.global.state.currentServer.dirs.channels[0].id);
        const token = `zorgue2e${Date.now()}`;
        await api(page, `edit_server_channel?server_id=${serverId}&action=edit&field=name&value=${token}&targetId=${chanId}&channel_type=textual`);

        // reload so the sidebar (and the palette's local index) sees the new name
        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        await expectServerLoadedWithDefaultChannel(page, serverId);

        await openPalette(page);
        await page.fill('#search-palette-input', token);
        await expect(page.locator('.search-result', { hasText: token })).toBeVisible();

        await page.keyboard.press('Enter');
        await expect(page.locator('#search-palette')).toBeHidden();
        await page.waitForFunction((id) => Number(window.global.state.activeConv) === Number(id), chanId);
    });

    test('finds a nested drive folder remotely and deep-opens it', async ({ page }) => {
        await loginUser(page, `srchui_c_${Date.now()}`);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);
        await expectServerLoadedWithDefaultChannel(page, serverId);

        const ts = Date.now();
        const created = await api(page, `edit_server_channel?server_id=${serverId}&action=create&channel_type=drive`);
        const driveId = JSON.parse(created.text).channel.id;
        await api(page, `create_drive_folder?drive_id=${driveId}&foldername=racine${ts}`);
        const folders = JSON.parse((await api(page, `get_drive_folders?drive_id=${driveId}`, { method: 'GET' })).text);
        const rootId = folders.find(f => f.foldername === `racine${ts}`).id;
        await api(page, `create_drive_folder?drive_id=${driveId}&foldername=feuille${ts}&parent_folder=${rootId}`);

        await openPalette(page);
        await page.fill('#search-palette-input', `feuille${ts}`);
        // remote tier: 200ms debounce + round trip — Playwright auto-waits
        const row = page.locator('.search-result', { hasText: `feuille${ts}` });
        await expect(row).toBeVisible();

        await row.click();
        await expect(page.locator('#search-palette')).toBeHidden();
        await page.waitForFunction(({ driveId }) => {
            const state = window.global.state;
            const path = window.global.drive?.path || [];
            return state.activeChan?.type === 'drive'
                && Number(state.activeChan.id) === Number(driveId)
                && path.length === 2; // racine / feuille
        }, { driveId });
        await expect(page).toHaveURL(new RegExp(`/${driveId}/folder/\\d+$`));
    });
});
