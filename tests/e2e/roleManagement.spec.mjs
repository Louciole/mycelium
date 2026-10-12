import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import {
    createServerViaUi,
    openServerFromSidebarById,
    getServerIds,
    openServerSettings,
} from './helpers/serverHelpers.mjs';
import { disconnectViaUi, reloadAndWaitForApp } from './helpers/messagingHelpers.mjs';

const SERVER_URL = 'http://localhost:808';
const TEST_TIMEOUT = 120000;

// ─── Thin API helper (role creation/setup only — everything user-facing is UI) ─

async function apiPost(page, path) {
    return page.evaluate(async (p) => {
        const r = await fetch(p, { method: 'POST', credentials: 'include' });
        if (!r.ok) { const t = await r.text(); throw new Error(`POST ${p} → ${r.status}: ${t}`); }
        const text = await r.text();
        try { return JSON.parse(text); } catch { return text; }
    }, path);
}

// ─── Navigation helpers ────────────────────────────────────────────────────────

/**
 * From an open server, opens Server Settings → Roles tab and waits for the
 * roles list (with its "Create Role" button) to be rendered.
 */
async function openRolesSettings(page) {
    await openServerSettings(page);
    // The "Rôles" tab inside the server-params side menu.
    await page.locator('#server-roles-tab').click();
    await page.locator('#create-role-btn').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Clicks "Create Role", which creates a role server-side and navigates into the
 * single-role edit screen. Returns the new role's id from live state.
 */
async function createRoleViaUi(page) {
    const before = await page.evaluate(() =>
        Object.keys(window.global?.state?.currentServer?.roles || {}).map(Number));

    await page.locator('#create-role-btn').click();

    // Editing screen for the freshly created role appears.
    await page.locator('#roleName').waitFor({ state: 'visible', timeout: 5000 });

    const roleId = await page.evaluate((prev) => {
        const roles = window.global?.state?.currentServer?.roles || {};
        const created = Object.keys(roles).map(Number).find((id) => !prev.includes(id));
        return created ?? Number(window.global?.state?.currentRole?.id);
    }, before);

    expect(roleId).toBeTruthy();
    return roleId;
}

/**
 * Opens a member's profile card by opening the member list and clicking the
 * entry that matches the given display name.
 */
async function openMemberCard(page, userId) {
    // Ensure the member's user profile is loaded so the list can render.
    await page.waitForFunction((id) => Boolean(window.global?.users?.[id]), userId, { timeout: 10000 });

    // Open the member list from the channel header group icon.
    await page.locator('img[onclick*="toggleMenu(\'member-list\'"]').first().click();
    await page.locator('#member-list').waitFor({ state: 'visible', timeout: 5000 });

    // Target this exact member — the id is embedded in the onclick handler
    // (display names can be blank, so matching on text is unreliable).
    await page.locator(`#member-list .name[onclick^="toggleProfileInfo(${userId},"]`).first().click();

    await page.locator('#profileInfo').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction((id) => Number(window.global?.state?.profileInfo?.id) === Number(id), userId, { timeout: 5000 });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Role management — E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('Role editing works live: create, rename, recolor, toggle permission', async ({ page }) => {
        const suffix = Date.now();
        await loginUser(page, `e2e_role_edit_${suffix}`);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        // ── 1. Create a role via the UI ───────────────────────────────────────
        await openRolesSettings(page);
        const roleId = await createRoleViaUi(page);

        // ── 2. Rename it — must reflect live in state (no reload) ──────────────
        const newName = `Moderators-${suffix}`;
        await page.fill('#roleName', newName);

        // Typing surfaces the unsaved-changes save bar.
        await page.locator('#formRole').waitFor({ state: 'visible', timeout: 5000 });
        await page.locator('#formRole .btn.green').click();

        await page.waitForFunction(({ id, name }) => {
            const roles = window.global?.state?.currentServer?.roles || {};
            return roles[id]?.name === name && window.global?.state?.currentRole?.name === name;
        }, { id: roleId, name: newName }, { timeout: 5000 });

        // ── 3. Recolor it — clicking a swatch updates state live ──────────────
        const expectedColor = await page.evaluate(() => {
            const swatch = document.querySelector('#setting-server-content .roleColor .grid .item');
            return getComputedStyle(swatch).getPropertyValue('--color').trim();
        });
        expect(expectedColor).toMatch(/^#/);

        await page.locator('#setting-server-content .roleColor .grid .item').first().click();

        await page.waitForFunction(({ id, color }) => {
            const roles = window.global?.state?.currentServer?.roles || {};
            return (roles[id]?.color || '').toLowerCase() === color.toLowerCase();
        }, { id: roleId, color: expectedColor }, { timeout: 5000 });

        // ── 4. Toggle a permission (right) — updates live and untoggles ───────
        await page.locator('#role-tabs h2[data-tab="permissions"]').click();
        // The real checkbox is visually hidden inside a custom switch; toggle via the slider.
        const permSlider = page.locator('#roleEditContent .permission[data-right="server-admin"] .switch .slider');
        await permSlider.waitFor({ state: 'visible', timeout: 5000 });

        await permSlider.click();
        await page.waitForFunction((id) => {
            const perms = window.global?.state?.currentServer?.roles?.[id]?.permissions || {};
            return 'server-admin' in perms;
        }, roleId, { timeout: 5000 });

        await permSlider.click();
        await page.waitForFunction((id) => {
            const perms = window.global?.state?.currentServer?.roles?.[id]?.permissions || {};
            return !('server-admin' in perms);
        }, roleId, { timeout: 5000 });

        // ── 5. Persistence: reload and confirm name + color survived ──────────
        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);

        const persisted = await page.evaluate(({ id }) => {
            const role = window.global?.state?.currentServer?.roles?.[id];
            return role ? { name: role.name, color: role.color } : null;
        }, { id: roleId });

        expect(persisted).not.toBeNull();
        expect(persisted.name).toBe(newName);
        expect((persisted.color || '').toLowerCase()).toBe(expectedColor.toLowerCase());
    });

    test('Add and remove a role on a member card, live', async ({ page }) => {
        const suffix = Date.now();
        const accountA = `e2e_role_owner_${suffix}`;
        const accountB = `e2e_role_member_${suffix}`;
        const roleName = `Trusted-${suffix}`;

        // ── 1. Owner creates a server + a named role, and an invite ───────────
        await loginUser(page, accountA);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        const { id: roleId } = await apiPost(page, `/edit_server_role?server_id=${serverId}&action=create`);
        expect(roleId).toBeTruthy();
        await apiPost(page, `/edit_server_role?server_id=${serverId}&field=name&value=${encodeURIComponent(roleName)}&targetId=${roleId}`);

        const serverName = await page.evaluate(() => window.global?.state?.currentServer?.name);
        const inviteCode = await apiPost(page, `/create_invitation?server_id=${serverId}`);
        const invite = String(inviteCode).replace(/"/g, '').trim();
        expect(invite).toBeTruthy();

        await disconnectViaUi(page);

        // ── 2. Member B joins via the invite URL ──────────────────────────────
        await loginUser(page, accountB);
        await waitForAppReady(page);

        const userBId = await page.evaluate(() => Number(window.global?.user?.id));
        expect(userBId).toBeTruthy();

        await page.goto(`${SERVER_URL}/${invite}`);
        await expect(page.locator('h2')).toContainText(serverName, { timeout: 10000 });
        await Promise.all([
            page.waitForURL('**/channels**', { timeout: 15000 }),
            page.locator('a[href*="join_server"] .btn').click(),
        ]);
        await waitForAppReady(page);
        expect(await getServerIds(page)).toContain(serverId);

        await disconnectViaUi(page);

        // ── 3. Owner opens member B's card and adds the role — live ───────────
        await loginUser(page, accountA);
        await waitForAppReady(page);
        await openServerFromSidebarById(page, serverId);

        await openMemberCard(page, userBId);

        // No roles yet on the card.
        await expect(page.locator('#profileInfo .roleTag')).toHaveCount(0);

        // Click "+" then pick the role in the popup.
        await page.locator('#profileInfo .attributeRole').click();
        await page.locator('#addRole').waitFor({ state: 'visible', timeout: 5000 });
        await page.locator('#addRole .inline', { hasText: roleName }).first().click();

        // Live: state gains the role and the tag renders on the card.
        await page.waitForFunction(({ sid, uid, rid }) => {
            const roles = window.global?.state?.currentServer?.members?.[uid]?.roles || [];
            return roles.map(Number).includes(Number(rid))
                && Number(window.global?.state?.currentServer?.id) === Number(sid);
        }, { sid: serverId, uid: userBId, rid: roleId }, { timeout: 5000 });
        await expect(page.locator('#profileInfo .roleTag')).toHaveCount(1);
        await expect(page.locator('#profileInfo .roleTag')).toContainText(roleName);

        // ── 4. Persistence of attribution: reload, reopen card, tag present ───
        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        await openMemberCard(page, userBId);
        await expect(page.locator('#profileInfo .roleTag')).toHaveCount(1);

        // ── 5. Remove the role via the "×" button on the tag — live ───────────
        const tag = page.locator('#profileInfo .roleTag').first();
        await tag.hover();
        const removeBtn = tag.locator('.roleTag-remove');
        await expect(removeBtn).toBeVisible();
        await removeBtn.click();

        await page.waitForFunction(({ uid, rid }) => {
            const roles = window.global?.state?.currentServer?.members?.[uid]?.roles || [];
            return !roles.map(Number).includes(Number(rid));
        }, { uid: userBId, rid: roleId }, { timeout: 5000 });
        await expect(page.locator('#profileInfo .roleTag')).toHaveCount(0);

        // ── 6. Persistence of removal: reload and confirm it is gone ──────────
        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);

        const stillHasRole = await page.evaluate(({ uid, rid }) => {
            const roles = window.global?.state?.currentServer?.members?.[uid]?.roles || [];
            return roles.map(Number).includes(Number(rid));
        }, { uid: userBId, rid: roleId });
        expect(stillHasRole).toBe(false);
    });
});
