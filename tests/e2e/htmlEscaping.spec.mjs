import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import {
    changeServerName,
    closeServerSettings,
    createServerViaUi,
    openServerFromSidebarById,
    openServerSettings
} from './helpers/serverHelpers.mjs';

const SERVER_URL = 'http://localhost:808';
const TEST_TIMEOUT = 120000;

async function apiPost(page, path) {
    return page.evaluate(async (p) => {
        const r = await fetch(p, { method: 'POST', credentials: 'include' });
        if (!r.ok) throw new Error(`POST ${p} → ${r.status}`);
        return r.text();
    }, path);
}

/**
 * Templates interpolate raw: user-controlled names (server name, display name)
 * must go through escapeHTML() or any member/invitee gets the markup injected.
 */
test.describe('HTML escaping of user-controlled names - E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('server name and display name render as text in the rail, member list and invite page', async ({ page, browser }) => {
        const suffix = Date.now();
        const serverName = `<b>x</b> esc ${suffix}`;
        const displayName = `<b>d</b> ${suffix}`;

        await loginUser(page, `e2e_escape_${suffix}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);
        await openServerSettings(page);
        await changeServerName(page, serverName);
        await closeServerSettings(page);
        await apiPost(page, `/change_profile?element=display&value=${encodeURIComponent(displayName)}`);
        const userId = await page.evaluate(() => window.global.user.id);

        await page.reload();
        await waitForAppReady(page);

        // 1) Rail: tooltip and slug are literal text, nothing parsed.
        const icon = page.locator(`#server-item-${serverId}`);
        const railEntry = page.locator('#servers .container').filter({ has: icon });
        await expect(railEntry.locator('.tooltip')).toHaveText(serverName);
        await expect(icon).toHaveText('<e');
        await expect(railEntry.locator('b')).toHaveCount(0);

        // 2) Member list: display name is literal text.
        await icon.click();
        await page.waitForFunction((id) => Number(window.global?.state?.currentServer?.id) === Number(id), serverId);
        await page.locator('img[onclick*="toggleMenu(\'member-list\'"]').first().click();
        const memberName = page.locator(`#member-list .name[onclick^="toggleProfileInfo(${userId},"]`);
        await expect(memberName).toHaveText(displayName);
        await expect(memberName.locator('b')).toHaveCount(0);

        // 3) Invite page (seen by anyone holding the link, logged out here).
        const inviteCode = (await apiPost(page, `/create_invitation?server_id=${serverId}`)).replace(/"/g, '').trim();
        const visitor = await browser.newPage();
        await visitor.goto(`${SERVER_URL}/${inviteCode}`);
        const title = visitor.locator('.window h2');
        await expect(title).toHaveText(serverName, { timeout: 10000 });
        await expect(visitor.locator('.window b')).toHaveCount(0);
        await visitor.close();
    });
});
