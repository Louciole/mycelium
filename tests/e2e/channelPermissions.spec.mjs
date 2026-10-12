// Channel settings › Permissions: private channels, read-only channels, allow/deny
// overwrites per role / member / @everyone, and who may edit them
// (routes/roles.py edit_channel_permissions, permissions.channel_rights, static/channel-permissions.mjs),
// live updates over the WebSocket and the actions hidden where the server would refuse them (static/access.mjs).
import { test, expect } from '@playwright/test';
import { openServerSettings } from './helpers/serverHelpers.mjs';
import {
    api, status, json, enc, setPerms, giveRole, createRole, setupServer, openServer,
    createChannel, channelPermsPath as perms, setChannelPerm as setPerm,
} from './helpers/permissionHelpers.mjs';

const TEST_TIMEOUT = 150000;
const sendMessage = (page, chan, text) =>
    status(page, `/send_message?conv=${enc(JSON.stringify({ id: chan }))}&content=${enc(text)}&reply=`);
const visibleChannels = async (page, sid) =>
    (await json(page, `/get_serv_content?server_id=${sid}`)).channels.map(c => Number(c.id));
// #général is created with the server: the lowest id (get_serv_content's order isn't guaranteed)
const generalChannel = (page) => page.evaluate(() => Math.min(...window.global.state.currentServer.dirs.channels.map(c => Number(c.id))));

/** Right-click the channel in the sidebar → Edit channel → Permissions tab. */
async function openChannelPermissions(page, chan) {
    await page.locator(`#channel-conv-${chan}`).click({ button: 'right' });
    await page.locator('#edit-channel-item').click();
    await page.locator('#channel-permissions-tab').click();
    await page.locator('#chan-perm-list .chan-perm').first().waitFor({ state: 'visible' });
}

test.describe('Channel permissions', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('read-only channel: @everyone denied send-messages in the UI, a role allowed back', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_ro', 1);
        const [b] = s.members;
        await openServer(s.owner, s.serverId);
        const chan = await generalChannel(s.owner);
        expect(await sendMessage(b.page, chan, 'before')).toBe(200);

        // Owner: @everyone is selected by default → deny "send messages"
        await openChannelPermissions(s.owner, chan);
        await expect(s.owner.locator('#chan-target-list .chan-target.selected')).toHaveAttribute('data-target', 'everyone');
        await s.owner.locator('#chan-perm-list .chan-perm[data-right="send-messages"] button.deny').click();
        await expect(s.owner.locator('#chan-perm-list .chan-perm[data-right="send-messages"]')).toHaveAttribute('data-state', 'deny');

        // B can still read but not write; their composer is locked
        expect(await sendMessage(b.page, chan, 'denied')).toBe(403);
        expect(await visibleChannels(b.page, s.serverId)).toContain(chan);
        await openServer(b.page, s.serverId);
        await expect(b.page.locator('.chat-input')).toHaveClass(/locked/);
        await expect(b.page.locator('.chat-input textarea')).toBeDisabled();
        await expect(b.page.locator('#timeout-banner')).toBeVisible();

        // A "Speaker" role overwrite allowing it wins over the @everyone deny
        const speaker = await createRole(s.owner, s.serverId, { name: 'Speaker' });
        await giveRole(s.owner, s.serverId, speaker, b.id);
        await setPerm(s.owner, chan, `roleId=${speaker}`, 'send-messages', 'allow');
        expect(await sendMessage(b.page, chan, 'speaker')).toBe(200);
        // …and a member overwrite denying it wins over the role
        await setPerm(s.owner, chan, `accountId=${b.id}`, 'send-messages', 'deny');
        expect(await sendMessage(b.page, chan, 'member deny')).toBe(403);
        await s.close();
    });

    test('private channel: who has access is managed from the UI', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_priv', 1);
        const [b] = s.members;
        await openServer(s.owner, s.serverId);
        const chan = await generalChannel(s.owner);
        await openChannelPermissions(s.owner, chan);

        await s.owner.locator('.chan-private-head .slider').click();
        await expect(s.owner.locator('#chan-access')).toBeVisible();
        await s.owner.waitForFunction((c) => window.findChannel(c, 'textual').is_private === true, chan);
        expect(await visibleChannels(b.page, s.serverId)).not.toContain(chan);
        expect(await status(b.page, `/get_chan_content?channel_id=${chan}`)).toBe(403);
        expect(await sendMessage(b.page, chan, 'hidden')).toBe(403);

        // Owner row is listed and can't be removed
        await expect(s.owner.locator(`#chan-access-members .chan-access-row[data-target="member:${s.ownerId}"] .remove`)).toHaveCount(0);

        // Add B through "Add members or roles"
        await s.owner.locator('#chan-add-access-btn').click();
        await s.owner.locator(`#chan-access-picker .role-member-row[data-target="member:${b.id}"]`).click();
        await s.owner.locator('#chan-access-picker .chan-picker-add').click();
        await expect(s.owner.locator(`#chan-access-members .chan-access-row[data-target="member:${b.id}"]`)).toBeVisible();
        expect(await visibleChannels(b.page, s.serverId)).toContain(chan);
        expect(await sendMessage(b.page, chan, 'invited')).toBe(200);
        // B now appears in the advanced targets too
        await expect(s.owner.locator(`#chan-target-list .chan-target[data-target="member:${b.id}"]`)).toBeVisible();

        // Remove B again
        await s.owner.locator(`#chan-access-members .chan-access-row[data-target="member:${b.id}"] .remove`).click();
        await expect(s.owner.locator(`#chan-access-members .chan-access-row[data-target="member:${b.id}"]`)).toHaveCount(0);
        expect(await visibleChannels(b.page, s.serverId)).not.toContain(chan);

        // A role works the same way, and its holders see the channel after reload
        const vip = await createRole(s.owner, s.serverId, { name: 'VIP' });
        await giveRole(s.owner, s.serverId, vip, b.id);
        await setPerm(s.owner, chan, `roleId=${vip}`, 'view-channels', 'allow');
        await openServer(b.page, s.serverId);
        await expect(b.page.locator(`#channel-conv-${chan}`)).toBeVisible();
        await s.close();
    });

    test('view overwrite on a public channel hides it everywhere (list, messages, search)', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_view', 1);
        const [b] = s.members;
        const chan = await createChannel(s.owner, s.serverId);
        await api(s.owner, `/edit_server_channel?server_id=${s.serverId}&targetId=${chan}&channel_type=textual&field=name&value=hiddenroom${s.stamp % 100000}`);
        expect(await visibleChannels(b.page, s.serverId)).toContain(chan);

        await setPerm(s.owner, chan, 'roleId=everyone', 'view-channels', 'deny');
        expect(await visibleChannels(b.page, s.serverId)).not.toContain(chan);
        expect(await status(b.page, `/get_chan_content?channel_id=${chan}`)).toBe(403);
        const found = await json(b.page, `/global_search?query=hiddenroom${s.stamp % 100000}`);
        expect(found.channels.map(c => Number(c.id))).not.toContain(chan);

        // Back to inherit: visible again
        await setPerm(s.owner, chan, 'roleId=everyone', 'view-channels', 'inherit');
        expect(await visibleChannels(b.page, s.serverId)).toContain(chan);
        await s.close();
    });

    test('who may edit channel permissions: manage-roles in the channel, hierarchy, only rights you have', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_sec', 2);
        const [b, c] = s.members;
        const sid = s.serverId;
        const top = await createRole(s.owner, sid, { name: 'Top' });
        const mod = await createRole(s.owner, sid, { name: 'Mod', perms: ['manage-roles'] });
        const low = await createRole(s.owner, sid, { name: 'Low' });
        await giveRole(s.owner, sid, mod, b.id);
        const open = await createChannel(s.owner, sid);
        const secret = await createChannel(s.owner, sid);
        await api(s.owner, `${perms(secret)}&action=togglePrivacy`);

        // No view in the private channel → no manage-roles there either
        expect(await status(b.page, `${perms(secret)}&action=togglePrivacy`)).toBe(403);
        expect(await status(b.page, `${perms(secret)}&action=setPermission&roleId=${low}&permission=view-channels&value=allow`)).toBe(403);
        expect(await status(b.page, `/get_channel_permissions?channelId=${secret}&channelType=textual`)).toBe(403);

        // In a channel B sees: only rights B has, only targets below B
        const set = (target, right, value) => status(b.page, `${perms(open)}&action=setPermission&${target}&permission=${right}&value=${value}`);
        expect(await set(`roleId=${low}`, 'send-messages', 'deny')).toBe(200);
        expect(await set(`roleId=${low}`, 'manage-messages', 'allow')).toBe(403);
        expect(await set(`roleId=${top}`, 'send-messages', 'deny')).toBe(403);
        expect(await set(`roleId=${mod}`, 'send-messages', 'deny')).toBe(403);
        expect(await set(`accountId=${s.ownerId}`, 'send-messages', 'deny')).toBe(403);
        expect(await set(`accountId=${c.id}`, 'send-messages', 'deny')).toBe(200);   // C has no role
        expect(await set(`roleId=${low}`, 'kick-members', 'allow')).toBe(400);       // not a channel right
        expect(await status(b.page, `${perms(open)}&action=set&roleId=${low}&allow=${enc('["send-messages"]')}&deny=${enc('["send-messages"]')}`)).toBe(400);

        // Channel-level "manage channel": B may rename that channel only
        await setPerm(s.owner, open, `accountId=${b.id}`, 'manage-channels', 'allow');
        const rename = (chan) => status(b.page, `/edit_server_channel?server_id=${sid}&targetId=${chan}&channel_type=textual&field=name&value=renamed`);
        expect(await rename(open)).toBe(200);
        const other = await createChannel(s.owner, sid);
        expect(await rename(other)).toBe(403);
        expect(await status(b.page, `/edit_server_channel?server_id=${sid}&action=create`)).toBe(403);

        // UI as B on a channel where B only has manage-roles: the settings open straight
        // on Permissions (no overview); targets above B are read-only
        await setPerm(s.owner, other, `roleId=${top}`, 'send-messages', 'allow');
        await openServer(b.page, sid);
        await b.page.locator(`#channel-conv-${other}`).click({ button: 'right' });
        await b.page.locator('#edit-channel-item').click();
        await b.page.locator('#chan-perm-list .chan-perm').first().waitFor({ state: 'visible' });
        await expect(b.page.locator('#channel-overview-tab')).toBeHidden();
        await b.page.locator(`#chan-target-list .chan-target[data-target="role:${top}"]`).click();
        await expect(b.page.locator('#chan-target-locked')).toBeVisible();
        await expect(b.page.locator('#chan-perm-list button:not([disabled])')).toHaveCount(0);
        await b.page.locator('#chan-target-list .chan-target[data-target="everyone"]').click();
        await expect(b.page.locator('#chan-perm-list .chan-perm[data-right="send-messages"] button.deny')).toBeEnabled();
        await expect(b.page.locator('#chan-perm-list .chan-perm[data-right="manage-messages"] button.deny')).toBeDisabled();
        await s.close();
    });

    test('workspaces: edit-notes per notes channel, private drives closed to members', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_ws', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const notesA = await createChannel(s.owner, sid, 'note');
        const notesB = await createChannel(s.owner, sid, 'note');
        const block = () => enc(JSON.stringify({ type: 'text', content: 'hi', uuid: crypto.randomUUID(), position: 1 }));
        const write = (notes) => status(b.page, `/save_block?channel=${notesA === notes ? notesA : notesB}&op=create&block=${block()}`);

        expect(await write(notesA)).toBe(403);
        await setPerm(s.owner, notesA, `accountId=${b.id}`, 'edit-notes', 'allow', 'note');
        expect(await write(notesA)).toBe(200);
        expect(await write(notesB)).toBe(403);

        // Private drive: listing its files used to only check server membership
        const drive = await createChannel(s.owner, sid, 'drive');
        expect(await status(b.page, `/get_drive_files?drive_id=${drive}`)).toBe(200);
        await api(s.owner, `${perms(drive, 'drive')}&action=togglePrivacy`);
        expect(await status(b.page, `/get_drive_files?drive_id=${drive}`)).toBe(403);
        await s.close();
    });

    test('settings panels: the Permissions tab works after the server settings were opened', async ({ browser }) => {
        // Regression: server and channel settings share #setting-server-content; with the
        // (hidden) server settings still in the DOM, the tab rendered into them.
        const s = await setupServer(browser, 'chan_panels', 0);
        const forum = await createChannel(s.owner, s.serverId, 'forum');
        await openServer(s.owner, s.serverId);
        await openServerSettings(s.owner);
        await s.owner.evaluate(() => window.closeMenu('#server-params'));
        await s.owner.mouse.click(700, 300);   // closes the server dropdown
        await s.owner.locator(`#channel-forum-${forum}`).click({ button: 'right' });
        await s.owner.locator('#edit-channel-item').click();
        await s.owner.locator('#channel-permissions-tab').click();
        await expect(s.owner.locator('#channels-params .chan-perms #chan-perm-list .chan-perm').first()).toBeVisible();
        expect(await s.owner.locator('#setting-server-content').count()).toBe(1);
        await s.close();
    });

    test('member list of a private channel only shows who can see it', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_members', 2);
        const [b, c] = s.members;
        const chan = await createChannel(s.owner, s.serverId);
        await api(s.owner, `${perms(chan)}&action=togglePrivacy`);
        await setPerm(s.owner, chan, `accountId=${b.id}`, 'view-channels', 'allow');
        await openServer(s.owner, s.serverId);
        await s.owner.locator(`#channel-conv-${chan}`).click();
        await s.owner.locator('img[onclick*="toggleMenu(\'member-list\'"]').first().click();
        await expect(s.owner.locator(`#member-list .name[data-uid="${b.id}"]`)).toBeVisible();
        await expect(s.owner.locator(`#member-list .name[data-uid="${s.ownerId}"]`)).toBeVisible();
        await expect(s.owner.locator(`#member-list .name[data-uid="${c.id}"]`)).toHaveCount(0);
        await expect(s.owner.locator('#member-list .member-list-header')).toContainText('2');
        // A public channel still lists everyone
        await s.owner.locator(`#channel-conv-${await generalChannel(s.owner)}`).click();
        await s.owner.locator('img[onclick*="toggleMenu(\'member-list\'"]').first().click();
        await expect(s.owner.locator(`#member-list .name[data-uid="${c.id}"]`)).toBeVisible();
        await s.close();
    });

    test('category permissions are inherited by its channels; moving a channel changes them', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_cat', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const cat = (await json(s.owner, `/edit_server_category?server_id=${sid}&action=create`)).id;
        const inside = await createChannel(s.owner, sid);
        const outside = await createChannel(s.owner, sid);
        const move = (page, chan, category) =>
            status(page, `/edit_server_channel?server_id=${sid}&targetId=${chan}&channel_type=textual&field=category&value=${category ?? ''}`);
        expect(await move(s.owner, inside, cat)).toBe(200);

        // Private category → its channel disappears for B (and so does the category)
        await api(s.owner, `${perms(cat, 'category')}&action=togglePrivacy`);
        let content = await json(b.page, `/get_serv_content?server_id=${sid}`);
        expect(content.channels.map(ch => Number(ch.id))).not.toContain(inside);
        expect(content.cat.map(ct => Number(ct.id))).not.toContain(cat);
        expect(content.channels.map(ch => Number(ch.id))).toContain(outside);
        expect(await sendMessage(b.page, inside, 'nope')).toBe(403);

        // A role allowed at the category level sees every channel of it
        const team = await createRole(s.owner, sid, { name: 'Team' });
        await giveRole(s.owner, sid, team, b.id);
        await setPerm(s.owner, cat, `roleId=${team}`, 'view-channels', 'allow', 'category');
        content = await json(b.page, `/get_serv_content?server_id=${sid}`);
        expect(content.channels.map(ch => Number(ch.id))).toContain(inside);
        expect(content.cat.map(ct => Number(ct.id))).toContain(cat);
        expect(await sendMessage(b.page, inside, 'team')).toBe(200);

        // The channel's own overwrites apply on top of the category's
        await setPerm(s.owner, inside, `roleId=${team}`, 'send-messages', 'deny');
        expect(await sendMessage(b.page, inside, 'read only here')).toBe(403);

        // Moving a channel in/out of the category changes what it inherits
        expect(await move(s.owner, outside, cat)).toBe(200);
        expect(await sendMessage(b.page, outside, 'still in (Team)')).toBe(200);
        await api(s.owner, `/edit_server_role?server_id=${sid}&targetId=${team}&action=unattribute&value=${b.id}`);
        expect(await sendMessage(b.page, outside, 'hidden now')).toBe(403);
        expect(await move(s.owner, outside, null)).toBe(200);
        expect(await sendMessage(b.page, outside, 'public again')).toBe(200);

        // Moving needs manage-roles in the channel (it changes its permissions)
        const mover = await createRole(s.owner, sid, { name: 'Mover', perms: ['manage-channels'] });
        await giveRole(s.owner, sid, mover, b.id);
        expect(await move(b.page, outside, cat)).toBe(403);
        await setPerms(s.owner, sid, mover, ['manage-channels', 'manage-roles']);
        // …and manage-channels in the destination: B can't even see that private category
        expect(await move(b.page, outside, cat)).toBe(403);
        await giveRole(s.owner, sid, team, b.id);
        expect(await move(b.page, outside, cat)).toBe(200);

        // Deleting a private category keeps its channels private (permissions copied down)
        await api(s.owner, `/edit_server_role?server_id=${sid}&targetId=${mover}&action=unattribute&value=${b.id}`);
        await api(s.owner, `/edit_server_category?server_id=${sid}&action=delete&targetId=${cat}`);
        content = await json(s.owner, `/get_serv_content?server_id=${sid}`);
        const insideRow = content.channels.find(ch => Number(ch.id) === inside);
        expect(insideRow.category).toBeNull();
        expect(insideRow.is_private).toBe(true);
        expect(await sendMessage(b.page, inside, 'team still sees, still read-only')).toBe(403);
        expect((await json(b.page, `/get_serv_content?server_id=${sid}`)).channels.map(ch => Number(ch.id))).toContain(inside);
        await api(s.owner, `/edit_server_role?server_id=${sid}&targetId=${team}&action=unattribute&value=${b.id}`);
        expect((await json(b.page, `/get_serv_content?server_id=${sid}`)).channels.map(ch => Number(ch.id))).not.toContain(inside);
        await s.close();
    });

    test('category settings: Permissions tab from the category menu; channels show what they inherit', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_catui', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const cat = (await json(s.owner, `/edit_server_category?server_id=${sid}&action=create`)).id;
        const chan = await createChannel(s.owner, sid);
        await api(s.owner, `/edit_server_channel?server_id=${sid}&targetId=${chan}&channel_type=textual&field=category&value=${cat}`);
        await openServer(s.owner, sid);

        await s.owner.locator(`.title[data-type="cat"][data-id="${cat}"]`).click({ button: 'right' });
        await s.owner.locator('#edit-cat-item').click();
        await s.owner.locator('#category-permissions-tab').click();
        await expect(s.owner.locator('#cat-params .chan-perms #chan-perm-list .chan-perm[data-right="edit-notes"]')).toBeVisible();
        await expect(s.owner.locator('#cat-params .settings-list .item.selected')).toHaveCount(1);
        await s.owner.locator('#cat-params .chan-private-head .slider').click();
        await s.owner.waitForFunction((c) => window.findChannel(c, 'category').is_private === true, cat);
        expect((await json(b.page, `/get_serv_content?server_id=${sid}`)).channels.map(ch => Number(ch.id))).not.toContain(chan);
        await s.owner.evaluate(() => window.closeMenu('#cat-params'));

        // The channel's own permissions tell it inherits from the category
        await s.owner.locator(`#channel-conv-${chan}`).click({ button: 'right' });
        await s.owner.locator('#edit-channel-item').click();
        await s.owner.locator('#channel-permissions-tab').click();
        await expect(s.owner.locator('#chan-inherit')).toBeVisible();
        // and the member list of that channel no longer lists B
        await s.owner.evaluate(() => window.closeMenu('#channels-params'));
        await s.owner.locator(`#channel-conv-${chan}`).click();
        await s.owner.locator('img[onclick*="toggleMenu(\'member-list\'"]').first().click();
        await expect(s.owner.locator(`#member-list .name[data-uid="${b.id}"]`)).toHaveCount(0);
        await s.close();
    });

    test('live: a member sees permission changes without reloading (composer, channels, member list, menus)', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_live', 2);
        const [b, c] = s.members;
        const sid = s.serverId;
        const room = await createChannel(s.owner, sid);
        await openServer(b.page, sid);
        const general = await generalChannel(b.page);

        // Read-only toggled on the open channel: the composer locks and unlocks
        await expect(b.page.locator('.chat-input')).not.toHaveClass(/locked/);
        await setPerm(s.owner, general, 'roleId=everyone', 'send-messages', 'deny');
        await expect(b.page.locator('.chat-input')).toHaveClass(/locked/);
        await expect(b.page.locator('#timeout-banner')).toBeVisible();
        await setPerm(s.owner, general, 'roleId=everyone', 'send-messages', 'inherit');
        await expect(b.page.locator('.chat-input')).not.toHaveClass(/locked/);

        // Member list of the open channel: C loses access → disappears from B's list
        await b.page.locator(`#channel-conv-${room}`).click();
        await b.page.locator('img[onclick*="toggleMenu(\'member-list\'"]').first().click();
        await expect(b.page.locator(`#member-list .name[data-uid="${c.id}"]`)).toBeVisible();
        await setPerm(s.owner, room, `accountId=${c.id}`, 'view-channels', 'deny');
        await expect(b.page.locator(`#member-list .name[data-uid="${c.id}"]`)).toHaveCount(0);

        // A role with manage-channels: the server menu offers "Create a channel", channels become draggable
        await expect(b.page.locator('#create-channel-item')).toHaveJSProperty('hidden', true);
        const builder = await createRole(s.owner, sid, { name: 'Builder', perms: ['manage-channels'] });
        await giveRole(s.owner, sid, builder, b.id);
        await expect(b.page.locator('#create-channel-item')).toHaveJSProperty('hidden', false);
        await expect(b.page.locator('#server-settings-item')).toHaveJSProperty('hidden', true);
        await expect(b.page.locator(`#channel-conv-${room}`)).toHaveAttribute('draggable', 'true');
        await api(s.owner, `/edit_server_role?server_id=${sid}&targetId=${builder}&action=unattribute&value=${b.id}`);
        await expect(b.page.locator('#create-channel-item')).toHaveJSProperty('hidden', true);

        // The open channel turns private: it leaves B's list and B lands on #général
        await api(s.owner, `${perms(room)}&action=togglePrivacy`);
        await expect(b.page.locator(`#channel-conv-${room}`)).toHaveCount(0);
        await expect(b.page.locator(`#channel-conv-${general}`)).toHaveClass(/selected/);
        expect(await b.page.evaluate(() => window.global.state.activeChan.id)).toBe(general);
        // …and comes back when B is let in
        await setPerm(s.owner, room, `accountId=${b.id}`, 'view-channels', 'allow');
        await expect(b.page.locator(`#channel-conv-${room}`)).toBeVisible();
        await s.close();
    });

    test('live: open settings follow the rights behind them', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_live_set', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const mod = await createRole(s.owner, sid, { name: 'Mod', perms: ['manage-roles'] });
        await giveRole(s.owner, sid, mod, b.id);
        await openServer(b.page, sid);
        await b.page.evaluate(() => window.openServerParams());
        await expect(b.page.locator('#server-roles-tab')).toBeVisible();
        await expect(b.page.locator('#server-overview-tab')).toBeHidden();
        // Gaining manage-server shows the overview tab; losing manage-roles closes the panel
        await setPerms(s.owner, sid, mod, ['manage-roles', 'manage-server']);
        await expect(b.page.locator('#server-overview-tab')).toBeVisible();
        await setPerms(s.owner, sid, mod, ['manage-server']);
        await expect(b.page.locator('#server-params')).toHaveCount(0);
        await s.close();
    });

    test('gated actions: forum posts, drive uploads and notes editing follow the channel rights', async ({ browser }) => {
        const s = await setupServer(browser, 'chan_gate', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const forum = await createChannel(s.owner, sid, 'forum');
        const drive = await createChannel(s.owner, sid, 'drive');
        const notes = await createChannel(s.owner, sid, 'note');
        const block = enc(JSON.stringify({ type: 'text', content: 'owner text', uuid: crypto.randomUUID(), position: 1 }));
        await api(s.owner, `/save_block?channel=${notes}&op=create&block=${block}`);
        const post = await s.owner.evaluate(async (f) => (await import('/static/crud.mjs')).createForumPost(f, 'Owner post', 'hello'), forum);
        await setPerm(s.owner, forum, 'roleId=everyone', 'send-messages', 'deny', 'forum');
        await setPerm(s.owner, drive, 'roleId=everyone', 'send-messages', 'deny', 'drive');
        await openServer(b.page, sid);

        // Forum: no "New post" button, Enter in the search box doesn't open the composer
        await b.page.locator(`#channel-forum-${forum}`).click();
        await expect(b.page.locator('.forum-post-card').first()).toBeVisible();
        await expect(b.page.locator('.forum-new-post-btn')).toBeHidden();
        await expect(b.page.locator('#forum-settings-btn')).toBeHidden();
        await b.page.locator('#forum-search-input').fill('My post');
        await b.page.locator('#forum-search-input').press('Enter');
        await expect(b.page.locator('#forum-composer')).toBeHidden();
        await setPerm(s.owner, forum, 'roleId=everyone', 'send-messages', 'inherit', 'forum');
        await expect(b.page.locator('.forum-new-post-btn')).toBeVisible();

        // Forum post: pin/lock/delete need manage-messages in this forum (not the server-wide right)
        await b.page.evaluate((id) => window.goToForumPost(id), post.id);
        await expect(b.page.locator('#forum-pin-btn')).toBeHidden();
        await expect(b.page.locator('#forum-lock-btn')).toBeHidden();
        await expect(b.page.locator('#forum-delete-btn')).toBeHidden();
        await setPerm(s.owner, forum, `accountId=${b.id}`, 'manage-messages', 'allow', 'forum');
        await expect(b.page.locator('#forum-pin-btn')).toBeVisible();
        await expect(b.page.locator('#forum-lock-btn')).toBeVisible();
        await expect(b.page.locator('#forum-delete-btn')).toBeVisible();

        // Drive: no upload / new folder while send-messages is denied
        await b.page.locator(`#channel-drive-${drive}`).click();
        for (const btn of ['#drive-upload-btn', '#drive-upload-folder-btn', '#drive-new-folder-btn']) {
            await expect(b.page.locator(btn)).toBeHidden();
        }
        await setPerm(s.owner, drive, 'roleId=everyone', 'send-messages', 'inherit', 'drive');
        await expect(b.page.locator('#drive-upload-btn')).toBeVisible();

        // Notes: @everyone has no edit-notes → read-only; editable once B is allowed
        await b.page.locator(`#channel-note-${notes}`).click();
        const text = b.page.locator('#note-editor .block > .content').first();
        await expect(text).toContainText('owner text');
        await expect(b.page.locator('#note-editor')).toHaveClass(/read-only/);
        await expect(text).toHaveAttribute('contenteditable', 'false');
        await expect(b.page.locator('#note-editor .block > .controls').first()).toBeHidden();
        await setPerm(s.owner, notes, `accountId=${b.id}`, 'edit-notes', 'allow', 'note');
        await expect(b.page.locator('#note-editor')).not.toHaveClass(/read-only/);
        await expect(text).toHaveAttribute('contenteditable', 'true');
        await s.close();
    });
});
