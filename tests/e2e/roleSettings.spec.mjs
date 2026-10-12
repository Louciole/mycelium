// Server settings › Roles: role list, role editor, @everyone defaults, hierarchy,
// permission split and backend validation (routes/roles.py, static/roles.mjs).
import { test, expect } from '@playwright/test';
import { openServerSettings } from './helpers/serverHelpers.mjs';
import {
    api, status, json, enc, setPerms, giveRole, createRole, setupServer, openServer,
} from './helpers/permissionHelpers.mjs';

const TEST_TIMEOUT = 150000;

async function openRolesTab(page, opts) {
    await openServerSettings(page, opts);
    await page.locator('#server-roles-tab').click();
    await page.locator('#role-list-rows').waitFor({ state: 'visible', timeout: 5000 });
}

const row = (page, roleId) => page.locator(`#role-list-rows .role-row[data-id="${roleId}"]`);
const memberRoles = (page, uid) => page.evaluate(
    (u) => (window.global.state.currentServer.members[u]?.roles || []).map(Number), uid);

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Server settings › Roles', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('role list: counts, search, … menu delete — a deleted role no longer breaks its members', async ({ browser }) => {
        const s = await setupServer(browser, 'roles_list', 1);
        const [b] = s.members;
        const alpha = await createRole(s.owner, s.serverId, { name: `Alpha${s.stamp % 1000}` });
        const beta = await createRole(s.owner, s.serverId, { name: `Beta${s.stamp % 1000}` });
        const gamma = await createRole(s.owner, s.serverId, { name: `Gamma${s.stamp % 1000}` });
        await giveRole(s.owner, s.serverId, alpha, s.ownerId);
        await giveRole(s.owner, s.serverId, alpha, b.id);
        await giveRole(s.owner, s.serverId, beta, b.id);

        await openServer(s.owner, s.serverId);
        await openRolesTab(s.owner);

        // Count, hierarchy order (creation order: appended at the bottom), live member counts
        await expect(s.owner.locator('#role-count')).toHaveText(/3$/);
        const ids = await s.owner.locator('#role-list-rows .role-row').evaluateAll(els => els.map(e => Number(e.dataset.id)));
        expect(ids).toEqual([alpha, beta, gamma]);
        await expect(row(s.owner, alpha).locator('.role-members')).toHaveText(/2/);
        await expect(row(s.owner, beta).locator('.role-members')).toHaveText(/1/);
        await expect(row(s.owner, gamma).locator('.role-members')).toHaveText(/0/);

        // Search filters rows (and disables dragging while filtered)
        await s.owner.fill('#role-search', 'beta');
        await expect(s.owner.locator('#role-list-rows .role-row')).toHaveCount(1);
        await expect(row(s.owner, beta)).not.toHaveAttribute('draggable', 'true');
        await s.owner.fill('#role-search', '');
        await expect(s.owner.locator('#role-list-rows .role-row')).toHaveCount(3);

        // Before deleting: B's permission checks answer 403, not a crash
        expect(await status(b.page, `/edit_server_channel?server_id=${s.serverId}&action=create`)).toBe(403);

        // … menu → delete Beta (confirm auto-accepted). Regression: the menu used to
        // open at the click point, over the next rows' buttons, unstyled.
        const moreBtn = row(s.owner, beta).locator('.action[data-id]');
        await moreBtn.click();
        const menu = s.owner.locator('#role-actions-modale.visible');
        await expect(menu).toBeVisible();
        const [btnBox, menuBox] = [await moreBtn.boundingBox(), await menu.boundingBox()];
        expect(menuBox.y).toBeGreaterThanOrEqual(btnBox.y + btnBox.height);
        expect(Math.abs((menuBox.x + menuBox.width) - (btnBox.x + btnBox.width))).toBeLessThan(2);
        expect(menuBox.width).toBeGreaterThan(150);
        await s.owner.locator('#role-actions-modale.visible .item.crit').click();
        await expect(row(s.owner, beta)).toHaveCount(0);
        await expect(s.owner.locator('#role-count')).toHaveText(/2$/);
        expect(await memberRoles(s.owner, b.id)).not.toContain(beta);

        // Regression: B held the deleted role — getRights used to KeyError (500) on it
        expect(await status(b.page, `/edit_server_channel?server_id=${s.serverId}&action=create`)).toBe(403);
        const content = await json(b.page, `/get_serv_content?server_id=${s.serverId}`);
        const bEntry = content.members.find(m => m.id === b.id);
        expect(bEntry.roles.map(Number).sort()).toEqual([alpha]);
        await s.close();
    });

    test('role editor: sidebar, rename, custom colour + preview, members tab add/remove', async ({ browser }) => {
        const s = await setupServer(browser, 'roles_editor', 1);
        const [b] = s.members;
        const other = await createRole(s.owner, s.serverId, { name: `Other${s.stamp % 1000}` });
        await openServer(s.owner, s.serverId);
        await openRolesTab(s.owner);

        // Create from the list → editor opens on the new role
        await s.owner.locator('#create-role-btn').click();
        await s.owner.locator('#roleName').waitFor({ state: 'visible' });
        const roleId = await s.owner.evaluate(() => Number(window.global.state.currentRole.id));
        await expect(s.owner.locator(`#role-editor-sidebar .role-sidebar-item[data-id="${roleId}"]`)).toHaveClass(/selected/);
        await expect(s.owner.locator('#role-editor-sidebar .role-sidebar-item[data-id="everyone"]')).toHaveCount(1);

        // Rename through the save bar: title and sidebar follow
        const name = `Mods${s.stamp % 10000}`;
        await s.owner.fill('#roleName', name);
        await s.owner.locator('#formRole .btn.green').click();
        await expect(s.owner.locator('#role-editor-title')).toContainText(name);
        await expect(s.owner.locator(`#role-editor-sidebar .role-sidebar-item[data-id="${roleId}"]`)).toContainText(name);

        // Custom colour (native picker) → state, preview and custom swatch
        await s.owner.locator('#role-custom-color').fill('#123456');
        await s.owner.waitForFunction((id) => window.global.state.currentServer.roles[id].color === '#123456', roleId);
        await expect(s.owner.locator('#role-preview .role-preview-name')).toHaveCSS('color', 'rgb(18, 52, 86)');
        await expect(s.owner.locator('#role-color-picker .item.custom')).toHaveClass(/selected/);
        // A preset swatch takes over the check mark
        await s.owner.locator('#role-color-picker .grid .item[data-color="#e74c3c"]').click();
        await expect(s.owner.locator('#role-color-picker .grid .item[data-color="#e74c3c"]')).toHaveClass(/selected/);
        await expect(s.owner.locator('#role-color-picker .item.custom')).not.toHaveClass(/selected/);

        // Members tab: add B through the picker
        await s.owner.locator('#role-tabs h2[data-tab="members"]').click();
        await expect(s.owner.locator('#role-tabs h2[data-tab="members"]')).toContainText('(0)');
        await s.owner.locator('#role-add-members-btn').click();
        await s.owner.locator(`#role-picker-list .role-member-row[data-id="${b.id}"]`).click();
        await s.owner.locator('#role-picker-add').click();
        await expect(s.owner.locator(`#role-member-list .role-member-row[data-id="${b.id}"]`)).toBeVisible();
        await expect(s.owner.locator('#role-tabs h2[data-tab="members"]')).toContainText('(1)');
        expect(await memberRoles(s.owner, b.id)).toContain(roleId);
        expect((await json(b.page, `/get_serv_content?server_id=${s.serverId}`))
            .members.find(m => m.id === b.id).roles.map(Number)).toContain(roleId);

        // Member search inside the tab
        await s.owner.fill('#role-member-search', 'zzz-no-match');
        await expect(s.owner.locator('#role-member-list .role-member-row')).toHaveCount(0);
        await s.owner.fill('#role-member-search', '');

        // Remove B
        await s.owner.locator(`#role-member-list .role-member-row[data-id="${b.id}"] .remove`).click();
        await expect(s.owner.locator('#role-member-list .role-member-row')).toHaveCount(0);
        await expect(s.owner.locator('#role-tabs h2[data-tab="members"]')).toContainText('(0)');
        expect(await memberRoles(s.owner, b.id)).not.toContain(roleId);

        // Sidebar switches role and keeps the tab; Back returns to the list
        await s.owner.locator(`#role-editor-sidebar .role-sidebar-item[data-id="${other}"]`).click();
        await expect(s.owner.locator('#role-editor-title')).toContainText(`Other${s.stamp % 1000}`.toUpperCase(), { ignoreCase: true });
        await expect(s.owner.locator('#role-tabs h2[data-tab="members"]')).toHaveClass(/selected/);
        await s.owner.locator('.role-editor-sidebar .back').click();
        await expect(row(s.owner, roleId)).toBeVisible();

        // Persistence
        await openServer(s.owner, s.serverId);
        const role = await s.owner.evaluate((id) => window.global.state.currentServer.roles[id], roleId);
        expect(role.name).toBe(name);
        expect(role.color).toBe('#e74c3c');
        await s.close();
    });

    test('@everyone default permissions grant rights to every member; permissions search and clear', async ({ browser }) => {
        const s = await setupServer(browser, 'roles_everyone', 1);
        const [b] = s.members;
        const createChannel = `/edit_server_channel?server_id=${s.serverId}&action=create`;
        expect(await status(b.page, createChannel)).toBe(403);

        await openServer(s.owner, s.serverId);
        await openRolesTab(s.owner);
        await s.owner.locator('#everyone-card').click();

        // Only the Permissions tab exists for @everyone
        await expect(s.owner.locator('#role-tabs h2')).toHaveCount(1);
        await expect(s.owner.locator('#role-editor-sidebar .role-sidebar-item[data-id="everyone"]')).toHaveClass(/selected/);
        await expect(s.owner.locator('#role-editor-more')).toBeHidden();

        // Permissions are grouped by category; the search narrows them. Mycelium
        // (op) rights never show on a normal server, nor for @everyone.
        expect(await s.owner.locator('#role-perm-list .perm-category').count()).toBeGreaterThanOrEqual(5);
        await expect(s.owner.locator('#role-perm-list .permission[data-right="mycelium-admin"]')).toHaveCount(0);
        await expect(s.owner.locator('#role-perm-list .permission[data-right="dashboard-read"]')).toHaveCount(0);
        await s.owner.fill('#perm-search', 'expressions');
        await expect(s.owner.locator('#role-perm-list .permission')).toHaveCount(1);
        await expect(s.owner.locator('#role-perm-list .permission')).toHaveAttribute('data-right', 'manage-expressions');
        await s.owner.fill('#perm-search', '');

        // Grant manage-channels to everyone → B can create channels
        await s.owner.locator('#role-perm-list .permission[data-right="manage-channels"] .slider').click();
        await s.owner.waitForFunction(() => 'manage-channels' in (window.global.state.currentServer.default_permissions || {}));
        expect(await status(b.page, createChannel)).toBe(200);

        // B's UI follows after a reload: "Create a channel" entry visible
        await openServer(b.page, s.serverId);
        expect(await b.page.evaluate(() => window.checkServRights('manage-channels'))).toBe(true);
        expect(await b.page.evaluate(() => window.checkServRights('manage-roles'))).toBe(false);

        // Clear permissions → back to 403
        await s.owner.locator('.perm-clear .link').click();
        await s.owner.waitForFunction(() => Object.keys(window.global.state.currentServer.default_permissions || {}).length === 0);
        await expect(s.owner.locator('#role-perm-list .permission[data-right="manage-channels"] input')).not.toBeChecked();
        expect(await status(b.page, createChannel)).toBe(403);
        await s.close();
    });

    test('hierarchy: a manage-roles member only manages roles below their highest one', async ({ browser }) => {
        const s = await setupServer(browser, 'roles_hier', 2);
        const [b, c] = s.members;
        const sid = s.serverId;
        const top = await createRole(s.owner, sid, { name: 'Top' });
        const manager = await createRole(s.owner, sid, { name: 'Manager', perms: ['manage-roles', 'kick-members'] });
        const low = await createRole(s.owner, sid, { name: 'Low' });
        await giveRole(s.owner, sid, manager, b.id);
        const role = (id) => `/edit_server_role?server_id=${sid}&targetId=${id}`;

        // Edit / assign: only strictly below
        expect(await status(b.page, `${role(low)}&field=name&value=Lower`)).toBe(200);
        expect(await status(b.page, `${role(top)}&field=name&value=Hacked`)).toBe(403);
        expect(await status(b.page, `${role(manager)}&field=name&value=Hacked`)).toBe(403);
        expect(await status(b.page, `${role(top)}&action=attribute&value=${b.id}`)).toBe(403);
        expect(await status(b.page, `${role(low)}&action=attribute&value=${c.id}`)).toBe(200);

        // Can't hand out a role carrying rights you don't hold (owner gave it ban-members)
        const banRole = await createRole(s.owner, sid, { name: 'Banner', perms: ['ban-members'] });
        expect(await status(b.page, `${role(banRole)}&action=attribute&value=${c.id}`)).toBe(403);
        expect(await status(b.page, `/add_role_members?server_id=${sid}&role_id=${banRole}&members=${enc(JSON.stringify([c.id]))}`)).toBe(403);
        await api(s.owner, `${role(banRole)}&action=delete`);

        // Grant only what you hold
        const perms = (p) => `${role(low)}&field=permissions&value=${enc(JSON.stringify(Object.fromEntries(p.map(k => [k, '']))))}`;
        expect(await status(b.page, perms(['kick-members']))).toBe(200);
        expect(await status(b.page, perms(['kick-members', 'ban-members']))).toBe(403);
        expect(await status(b.page, perms(['server-admin']))).toBe(403);

        // Reorder: roles at or above yours stay put
        const low2 = (await json(b.page, `/edit_server_role?server_id=${sid}&action=create`)).id;
        const reorder = (order) => `/reorder_server_roles?server_id=${sid}&order=${enc(JSON.stringify(order))}`;
        expect(await status(b.page, reorder([low, top, manager, low2]))).toBe(403);
        expect(await status(b.page, reorder([top, manager, low2, low]))).toBe(200);

        // Delete
        expect(await status(b.page, `${role(top)}&action=delete`)).toBe(403);
        expect(await status(b.page, `${role(low2)}&action=delete`)).toBe(200);

        // Moderation follows the hierarchy too
        await giveRole(s.owner, sid, top, c.id);
        const kickC = `/kick_member?server_id=${sid}&account_id=${c.id}`;
        expect(await status(b.page, kickC)).toBe(403);

        // UI as B: settings open straight on Roles (no overview), locked rows
        await openServer(b.page, sid);
        await openServerSettings(b.page, { overview: false });
        await expect(b.page.locator('#server-overview-tab')).toBeHidden();
        await b.page.locator('#role-list-rows').waitFor({ state: 'visible' });
        await expect(row(b.page, top)).toHaveClass(/locked/);
        await expect(row(b.page, manager)).toHaveClass(/locked/);
        await expect(row(b.page, low)).toHaveAttribute('draggable', 'true');
        await expect(row(b.page, top)).not.toHaveAttribute('draggable', 'true');

        // Above-role editor is read-only
        await row(b.page, top).locator('.role-name').click();
        await expect(b.page.locator('#role-locked-hint')).toBeVisible();
        await expect(b.page.locator('#roleName')).toBeDisabled();
        await b.page.locator('#role-tabs h2[data-tab="permissions"]').click();
        await expect(b.page.locator('#role-perm-list .permission input:not([disabled])')).toHaveCount(0);

        // Below-role editor: only the rights B holds are toggleable
        await b.page.locator(`#role-editor-sidebar .role-sidebar-item[data-id="${low}"]`).click();
        await expect(b.page.locator('#role-perm-list .permission[data-right="kick-members"] input')).toBeEnabled();
        await expect(b.page.locator('#role-perm-list .permission[data-right="ban-members"] input')).toBeDisabled();

        // C's top role is now Top (above B): demote C to Low only → B may kick
        await api(s.owner, `${role(top)}&action=unattribute&value=${c.id}`);
        expect(await status(b.page, kickC)).toBe(200);
        await s.close();
    });

    test('profile card still loads when its template arrives after a server is open', async ({ browser }) => {
        // Regression: profile-info.html is loaded asynchronously at startup; evaluated
        // with a server already open and no profile selected, its role filter threw
        // (profileInfo.id of undefined) and the card was never inserted.
        const s = await setupServer(browser, 'roles_race', 0);
        const roleId = await createRole(s.owner, s.serverId, { name: 'Racer' });
        await giveRole(s.owner, s.serverId, roleId, s.ownerId);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        await s.owner.route('**/static/templates/profile-info.html', async route => { await gate; await route.continue(); });
        await openServer(s.owner, s.serverId);
        release();
        await s.owner.locator('#profileInfo').waitFor({ state: 'attached', timeout: 10000 });
        await s.owner.locator('img[onclick*="toggleMenu(\'member-list\'"]').first().click();
        await s.owner.locator(`#member-list .name[data-uid="${s.ownerId}"]`).click();
        await expect(s.owner.locator('#profileInfo .roleTag')).toContainText('Racer');
        await s.close();
    });

    test('drag & drop reorders roles, persists, and the highest role gives the name colour', async ({ browser }) => {
        const s = await setupServer(browser, 'roles_drag', 0);
        const red = await createRole(s.owner, s.serverId, { name: 'Red', color: '#e74c3c' });
        const blue = await createRole(s.owner, s.serverId, { name: 'Blue', color: '#3498db' });
        await giveRole(s.owner, s.serverId, blue, s.ownerId);
        await giveRole(s.owner, s.serverId, red, s.ownerId);
        await openServer(s.owner, s.serverId);
        expect(await s.owner.evaluate((u) => window.memberColor(u), s.ownerId)).toBe('#e74c3c');

        await openRolesTab(s.owner);
        await row(s.owner, blue).dragTo(row(s.owner, red), { targetPosition: { x: 40, y: 3 } });
        await expect(s.owner.locator('#role-list-rows .role-row').first()).toHaveAttribute('data-id', String(blue));
        expect(await s.owner.evaluate((u) => window.memberColor(u), s.ownerId)).toBe('#3498db');

        await openServer(s.owner, s.serverId);
        const order = await s.owner.evaluate(() => window.sortedRoles().map(r => r.id));
        expect(order).toEqual([blue, red]);
        expect(await s.owner.evaluate((u) => window.memberColor(u), s.ownerId)).toBe('#3498db');
        await s.close();
    });

    test('role names are rendered as text: list, editor, profile card, mention', async ({ browser }) => {
        const s = await setupServer(browser, 'roles_xss', 0);
        const evil = '<b class=pwn>x</b>';
        const roleId = await createRole(s.owner, s.serverId, { name: evil });
        await giveRole(s.owner, s.serverId, roleId, s.ownerId);
        await openServer(s.owner, s.serverId);
        const pwned = () => s.owner.evaluate(() => document.querySelectorAll('.pwn').length);

        // Mention in a channel message
        const input = s.owner.locator('.chat-input textarea.selected');
        await input.fill(`<@&${roleId}>`);
        await input.press('Enter');
        await expect(s.owner.locator(`.mention-role[data-mention-id="${roleId}"]`).last()).toHaveText(`@${evil}`);

        // Profile card role tag
        await s.owner.locator('img[onclick*="toggleMenu(\'member-list\'"]').first().click();
        await s.owner.locator(`#member-list .name[data-uid="${s.ownerId}"]`).click();
        await expect(s.owner.locator('#profileInfo .roleTag').first()).toContainText(evil);

        // Settings list + editor + sidebar
        await openRolesTab(s.owner);
        await expect(row(s.owner, roleId).locator('.role-name')).toHaveText(evil);
        await row(s.owner, roleId).locator('.role-name').click();
        await expect(s.owner.locator('#role-editor-title')).toContainText(evil);
        await expect(s.owner.locator('#roleName')).toHaveValue(evil);
        expect(await pwned()).toBe(0);
        await s.close();
    });

    test('rights split: each right gates its own endpoints; server-admin implies them', async ({ browser }) => {
        const s = await setupServer(browser, 'roles_split', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const roleId = await createRole(s.owner, sid, { perms: ['manage-channels'] });
        await giveRole(s.owner, sid, roleId, b.id);
        const createChannel = `/edit_server_channel?server_id=${sid}&action=create`;
        const rename = `/edit_server_property?server_id=${sid}&property=name&value=${enc('Renamed by B')}`;
        const emojiPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const emoji = `/create_server_emoji?server_id=${sid}&name=e2e&value=${enc(emojiPng)}`;
        const editRoles = `/edit_server_role?server_id=${sid}&action=create`;

        expect(await status(b.page, createChannel)).toBe(200);
        expect(await status(b.page, rename)).toBe(403);
        expect(await status(b.page, emoji)).toBe(403);
        expect(await status(b.page, editRoles)).toBe(403);

        await setPerms(s.owner, sid, roleId, ['manage-server', 'manage-expressions']);
        expect(await status(b.page, createChannel)).toBe(403);
        expect(await status(b.page, rename)).toBe(200);
        expect(await status(b.page, emoji)).toBe(200);

        await setPerms(s.owner, sid, roleId, ['server-admin']);
        for (const path of [createChannel, rename, editRoles]) expect(await status(b.page, path)).toBe(200);

        // Settings entry: hidden without any settings right, shown with one
        await setPerms(s.owner, sid, roleId, []);
        await openServer(b.page, sid);
        expect(await b.page.evaluate(() => window.canOpenServerSettings())).toBe(false);
        await setPerms(s.owner, sid, roleId, ['manage-expressions']);
        await openServer(b.page, sid);
        expect(await b.page.evaluate(() => window.canOpenServerSettings())).toBe(true);
        await s.close();
    });

    test('edit_server_role validates its input', async ({ browser }) => {
        const s = await setupServer(browser, 'roles_valid', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const roleId = await createRole(s.owner, sid, {});
        const r = `/edit_server_role?server_id=${sid}&targetId=${roleId}`;
        const cases = [
            [`${r}&field=color&value=${enc('red')}`, 400],
            [`${r}&field=color&value=${enc('#12345')}`, 400],
            [`${r}&field=color&value=${enc('#ABCDEF')}`, 200],
            [`${r}&field=name&value=${enc('x'.repeat(25))}`, 400],
            [`${r}&field=name&value=${enc('   ')}`, 400],
            [`${r}&field=id&value=1`, 400],
            [`${r}&field=server&value=1`, 400],
            [`${r}&field=permissions&value=${enc('{"edit":""}')}`, 400],
            [`${r}&field=permissions&value=${enc('{"mycelium-admin":""}')}`, 400],
            [`${r}&field=permissions&value=${enc('not json')}`, 400],
            [`${r}&field=permissions&value=${enc('["kick-members"]')}`, 400],
            [`/edit_server_role?server_id=${sid}&targetId=everyone&field=name&value=x`, 400],
            [`/edit_server_role?server_id=${sid}&targetId=999999999&field=name&value=x`, 404],
            [`/reorder_server_roles?server_id=${sid}&order=${enc('[1,2]')}`, 400],
            [`/add_role_members?server_id=${sid}&role_id=${roleId}&members=${enc('[999999999]')}`, 400],
            [`${r}&action=attribute&value=999999999`, 400],
        ];
        for (const [path, expected] of cases) {
            expect.soft(await status(s.owner, path), path).toBe(expected);
        }
        // Colour is stored lower-case; attributing twice is refused
        const content = await json(s.owner, `/get_serv_content?server_id=${sid}`);
        expect(content.roles.find(x => x.id === roleId).color).toBe('#abcdef');
        expect(await status(s.owner, `${r}&action=attribute&value=${b.id}`)).toBe(200);
        expect(await status(s.owner, `${r}&action=attribute&value=${b.id}`)).toBe(400);
        // Plain members can't touch roles at all
        expect(await status(b.page, `${r}&field=name&value=x`)).toBe(403);
        expect(await status(b.page, `/edit_server_role?server_id=${sid}&action=create`)).toBe(403);
        await s.close();
    });
});
