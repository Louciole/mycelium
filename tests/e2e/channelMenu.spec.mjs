// Right-click menus of the sidebar (static/channel-menu.mjs, templates/channel-menu*.html):
// a channel's and a category's. What they offer depends on the type and the user's rights;
// mutes and notification levels are notification_override rows (routes/users.py
// set_notification_override) that the server applies when a message comes in; links and
// invitations route the client to the channel (static/routes.mjs).
import { test, expect } from '@playwright/test';
import { acceptDialog } from './helpers/dialogHelpers.mjs';
import {
    api, json, enc, setupServer, openServer, createChannel, setChannelPerm as setPerm, channelPermsPath as perms,
} from './helpers/permissionHelpers.mjs';

const TEST_TIMEOUT = 180000;
const MENU = '#channel-menu';
const SUB = '.ctx-submenu';

async function openMenu(page, selector) {
    await page.locator(selector).click({ button: 'right' });
    await expect(page.locator(MENU)).toBeVisible();
}

/** Ids of the items of the open menu, in order. */
const menuIds = (page) => page.locator(`${MENU} .ctx-item[id]`).evaluateAll(els => els.map(e => e.id));

const userInfo = (page) => json(page, '/get_user_info');
const send = (page, chan, text) => api(page, `/send_message?conv=${enc(JSON.stringify({ id: chan }))}&content=${enc(text)}&reply=`);
const unread = async (page, chan) => (await userInfo(page)).channel_unreads.some(u => u.channel === chan);
const newCategory = async (page, sid) => (await json(page, `/edit_server_category?server_id=${sid}&action=create`)).id;
const intoCategory = (page, sid, chan, cat) =>
    api(page, `/edit_server_channel?server_id=${sid}&targetId=${chan}&channel_type=textual&field=category&value=${cat}`);

test.describe('Sidebar right-click menus', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('channel menu items follow the type and the rights', async ({ browser }) => {
        const s = await setupServer(browser, 'ctxmenu_rights', 2);
        const [b, c] = s.members;
        const sid = s.serverId;
        const chan = await createChannel(s.owner, sid);
        const note = await createChannel(s.owner, sid, 'note');

        await openServer(s.owner, sid);
        await openMenu(s.owner, `#channel-conv-${chan}`);
        expect(await menuIds(s.owner)).toEqual(['channel-menu-read', 'channel-menu-invite', 'channel-menu-link',
            'channel-menu-mute', 'channel-menu-notif', 'channel-menu-move', 'edit-channel-item', 'channel-menu-duplicate', 'channel-menu-delete']);
        await expect(s.owner.locator('#channel-menu-read')).toBeDisabled();   // nothing unread
        await s.owner.keyboard.press('Escape');
        await expect(s.owner.locator(MENU)).toHaveCount(0);
        // A notes channel has no messages: no read state, no notifications
        await openMenu(s.owner, `#channel-note-${note}`);
        expect(await menuIds(s.owner)).toEqual(['channel-menu-invite', 'channel-menu-link',
            'channel-menu-move', 'edit-channel-item', 'channel-menu-duplicate', 'channel-menu-delete']);

        // B (no role): their own settings, invite and link
        await openServer(b.page, sid);
        await openMenu(b.page, `#channel-conv-${chan}`);
        expect(await menuIds(b.page)).toEqual(['channel-menu-read', 'channel-menu-invite', 'channel-menu-link',
            'channel-menu-mute', 'channel-menu-notif']);
        await b.page.keyboard.press('Escape');
        await openMenu(b.page, `#channel-note-${note}`);
        expect(await menuIds(b.page)).toEqual(['channel-menu-invite', 'channel-menu-link']);

        // C may manage that channel only: edit + delete, but neither move nor duplicate (both
        // touch its permissions: manage-roles; duplicating also creates a channel)
        await setPerm(s.owner, chan, `accountId=${c.id}`, 'manage-channels', 'allow');
        await openServer(c.page, sid);
        await openMenu(c.page, `#channel-conv-${chan}`);
        expect(await menuIds(c.page)).toEqual(['channel-menu-read', 'channel-menu-invite', 'channel-menu-link',
            'channel-menu-mute', 'channel-menu-notif', 'edit-channel-item', 'channel-menu-delete']);
        await c.page.locator('#edit-channel-item').click();
        await expect(c.page.locator('#channels-params')).toBeVisible();
        await s.close();
    });

    test('mute for a while, unmute, and a vocal channel mutes its chat', async ({ browser }) => {
        const s = await setupServer(browser, 'ctxmenu_mute', 0);
        const sid = s.serverId;
        const chan = await createChannel(s.owner, sid);
        const vocal = await createChannel(s.owner, sid, 'vocal');
        const chat = (await json(s.owner, `/get_vocal_chat?channel_id=${vocal}`)).id;
        await openServer(s.owner, sid);

        await openMenu(s.owner, `#channel-conv-${chan}`);
        await s.owner.locator('#channel-menu-mute').hover();
        const durations = s.owner.locator(`${SUB} .ctx-item`);
        await expect(durations).toHaveCount(6);
        await durations.nth(1).click();   // 1 hour
        await expect(s.owner.locator(MENU)).toHaveCount(0);
        await expect(s.owner.locator(`#channel-conv-${chan}`)).toHaveClass(/muted/);
        const mute = (await userInfo(s.owner)).notif_overrides.find(o => o.target === chan && !o.category);
        const minutes = (new Date(mute.muted_until) - Date.now()) / 60000;
        expect(minutes).toBeGreaterThan(55);
        expect(minutes).toBeLessThan(65);

        // Muted: the item says until when, and unmutes in one click (the row goes away)
        await openMenu(s.owner, `#channel-conv-${chan}`);
        await expect(s.owner.locator('#channel-menu-unmute small')).toBeVisible();
        await s.owner.locator('#channel-menu-unmute').click();
        await expect(s.owner.locator(`#channel-conv-${chan}`)).not.toHaveClass(/muted/);
        await expect.poll(async () => (await userInfo(s.owner)).notif_overrides.some(o => o.target === chan)).toBe(false);

        // A vocal channel: the row is its chat's place (what the notifications read)
        await openMenu(s.owner, `#channel-vocal-${vocal}`);
        await s.owner.locator('#channel-menu-mute').click();
        await s.owner.locator(`${SUB} .ctx-item`).last().click();   // until I unmute
        await expect(s.owner.locator(`#channel-vocal-${vocal}`)).toHaveClass(/muted/);
        await expect.poll(async () => (await userInfo(s.owner)).notif_overrides).toContainEqual(
            { target: chat, category: false, muted: true, muted_until: null, level: null });
        // Notes and drives have no notifications
        const note = await createChannel(s.owner, sid, 'note');
        expect((await api(s.owner, `/set_notification_override?target_id=${note}&target_type=note&muted=true`, { expectOk: false })).status).toBe(400);
        await s.close();
    });

    test('notification levels: a channel set to nothing, a muted category, mark as read', async ({ browser }) => {
        const s = await setupServer(browser, 'ctxmenu_notif', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const quiet = await createChannel(s.owner, sid);
        const loud = await createChannel(s.owner, sid);
        const cat = await newCategory(s.owner, sid);
        const inCat = await createChannel(s.owner, sid);
        await intoCategory(s.owner, sid, inCat, cat);
        await openServer(b.page, sid);

        // "Nothing" on one channel: the default (the server's) is the checked radio until then
        await openMenu(b.page, `#channel-conv-${quiet}`);
        await b.page.locator('#channel-menu-notif').hover();
        const levels = b.page.locator(`${SUB} [role="menuitemradio"]`);
        await expect(levels).toHaveCount(4);
        await expect(levels.first()).toHaveAttribute('aria-checked', 'true');
        await levels.last().click();
        await expect.poll(async () => (await userInfo(b.page)).notif_overrides.find(o => o.target === quiet)?.level).toBe(2);
        await openMenu(b.page, `#channel-conv-${quiet}`);
        await b.page.locator('#channel-menu-notif').hover();
        await expect(levels.last()).toHaveAttribute('aria-checked', 'true');
        await b.page.keyboard.press('Escape');

        // Muting the category mutes its channels (dimmed), not the others
        await openMenu(b.page, `.title[data-type="cat"][data-id="${cat}"]`);
        await b.page.locator('#category-menu-mute').hover();
        await b.page.locator(`${SUB} .ctx-item`).last().click();
        await expect(b.page.locator(`#channel-conv-${inCat}`)).toHaveClass(/muted/);
        await expect(b.page.locator(`#channel-conv-${loud}`)).not.toHaveClass(/muted/);

        // The server applies both: no unread for B there, an unread elsewhere
        await send(s.owner, quiet, 'shh');
        await send(s.owner, inCat, 'shh');
        await send(s.owner, loud, 'hello');
        expect(await unread(b.page, quiet)).toBe(false);
        expect(await unread(b.page, inCat)).toBe(false);
        expect(await unread(b.page, loud)).toBe(true);

        // Mark as read from the menu
        await expect(b.page.locator(`#channel-conv-${loud}`)).toHaveClass(/unread/);
        await openMenu(b.page, `#channel-conv-${loud}`);
        await b.page.locator('#channel-menu-read').click();
        await expect(b.page.locator(`#channel-conv-${loud}`)).not.toHaveClass(/unread/);
        await expect.poll(() => unread(b.page, loud)).toBe(false);
        await s.close();
    });

    test('copy link and invite to channel route the client to it', async ({ browser }) => {
        const s = await setupServer(browser, 'ctxmenu_link', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const note = await createChannel(s.owner, sid, 'note');
        const chan = await createChannel(s.owner, sid);
        await openServer(s.owner, sid);

        // Copy link: /channels#<server>/<type>/<id>, which opens that channel
        await s.owner.evaluate(() => {
            navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve() };
        });
        await openMenu(s.owner, `#channel-note-${note}`);
        await s.owner.locator('#channel-menu-link').click();
        await expect(s.owner.locator('.drive-toast')).toBeVisible();
        const link = await s.owner.evaluate(() => window.__copied);
        expect(link).toMatch(new RegExp(`/channels#${sid}/note/${note}$`));
        await b.page.goto(link);
        await b.page.reload();
        await expect.poll(() => b.page.evaluate(() => window.global?.state?.activeChan?.slug)).toBe(`-note-${note}`);

        // Invite to a channel: the modal names it; following the link lands in it
        await openMenu(s.owner, `#channel-conv-${chan}`);
        await s.owner.locator('#channel-menu-invite').click();
        await expect(s.owner.locator('#server-invitation h2')).toContainText('#');
        const invite = await s.owner.locator('#invitation-link').inputValue();
        await b.page.goto(invite);
        await Promise.all([
            b.page.waitForURL(`**/channels#${sid}/textual/${chan}`, { timeout: 15000 }),
            b.page.locator('#join-invite-btn').click(),
        ]);
        await expect.poll(() => b.page.evaluate(() => window.global?.state?.activeChan?.slug)).toBe(`-conv-${chan}`);
        await s.close();
    });

    test('duplicate keeps privacy and overwrites; move to a category; delete', async ({ browser }) => {
        const s = await setupServer(browser, 'ctxmenu_dup', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const cat = await newCategory(s.owner, sid);
        const catName = `dest${s.stamp % 100000}`;
        await api(s.owner, `/edit_server_category?server_id=${sid}&targetId=${cat}&field=name&value=${catName}`);
        const chan = await createChannel(s.owner, sid);   // outside any category
        await api(s.owner, `${perms(chan)}&action=togglePrivacy`);
        await openServer(s.owner, sid);

        // Duplicate: a private copy right after it, B sees neither
        const before = (await json(s.owner, `/get_serv_content?server_id=${sid}`)).channels.map(c => c.id);
        await openMenu(s.owner, `#channel-conv-${chan}`);
        await s.owner.locator('#channel-menu-duplicate').click();
        await expect.poll(async () => (await json(s.owner, `/get_serv_content?server_id=${sid}`)).channels.length).toBe(before.length + 1);
        const copy = (await json(s.owner, `/get_serv_content?server_id=${sid}`)).channels.find(c => !before.includes(c.id));
        expect(copy.is_private).toBe(true);
        await expect(s.owner.locator(`#channel-conv-${copy.id}`)).toBeVisible();
        expect((await json(b.page, `/get_serv_content?server_id=${sid}`)).channels.some(c => c.id === copy.id)).toBe(false);

        // Move to: every category (the server's two default ones + ours), no "No category" yet
        await openMenu(s.owner, `#channel-conv-${chan}`);
        await s.owner.locator('#channel-menu-move').hover();
        const destinations = s.owner.locator(`${SUB} .ctx-item`);
        await expect(destinations).toHaveCount(3);
        await destinations.filter({ hasText: catName }).click();
        await expect(s.owner.locator(`.group:has(.title[data-id="${cat}"]) #channel-conv-${chan}`)).toBeVisible();
        expect((await json(s.owner, `/get_serv_content?server_id=${sid}`)).channels.find(c => c.id === chan).category).toBe(cat);

        // Back out of it: "No category" comes first, its own category isn't offered
        await openMenu(s.owner, `#channel-conv-${chan}`);
        await s.owner.locator('#channel-menu-move').hover();
        await expect(destinations).toHaveCount(3);
        await expect(destinations.filter({ hasText: catName })).toHaveCount(0);
        await destinations.first().click();
        await expect.poll(async () => (await json(s.owner, `/get_serv_content?server_id=${sid}`))
            .channels.find(c => c.id === chan).category).toBe(null);

        await openMenu(s.owner, `#channel-conv-${copy.id}`);
        await s.owner.locator('#channel-menu-delete').click();
        await acceptDialog(s.owner);
        await expect(s.owner.locator(`#channel-conv-${copy.id}`)).toHaveCount(0);
        expect((await json(s.owner, `/get_serv_content?server_id=${sid}`)).channels.some(c => c.id === copy.id)).toBe(false);
        await s.close();
    });

    test('category menu: rights, collapse (kept on reload), mark as read, delete', async ({ browser }) => {
        const s = await setupServer(browser, 'ctxmenu_cat', 1);
        const [b] = s.members;
        const sid = s.serverId;
        const cat = await newCategory(s.owner, sid);
        const chan = await createChannel(s.owner, sid);
        await intoCategory(s.owner, sid, chan, cat);
        const title = `.title[data-type="cat"][data-id="${cat}"]`;

        await openServer(b.page, sid);
        await openMenu(b.page, title);
        expect(await menuIds(b.page)).toEqual(['category-menu-read', 'category-menu-collapse', 'category-menu-collapse-all',
            'category-menu-mute', 'category-menu-notif']);
        await expect(b.page.locator('#category-menu-read')).toBeDisabled();

        // Collapse it, from the menu; it stays collapsed after a reload
        await b.page.locator('#category-menu-collapse').click();
        await expect(b.page.locator(title)).toHaveClass(/closed/);
        await openServer(b.page, sid);
        await expect(b.page.locator(title)).toHaveClass(/closed/);
        await openMenu(b.page, title);
        await expect(b.page.locator('#category-menu-collapse')).toHaveAttribute('aria-checked', 'true');
        await b.page.locator('#category-menu-collapse').click();
        await expect(b.page.locator(title)).not.toHaveClass(/closed/);
        // Collapse all
        await openMenu(b.page, title);
        await b.page.locator('#category-menu-collapse-all').click();
        expect(await b.page.locator('#server-selector .title[data-type="cat"]:not(.closed)').count()).toBe(0);
        await b.page.locator(title).click();   // a click on the title opens it again

        // Mark the category as read
        await send(s.owner, chan, 'hello');
        await expect(b.page.locator(`#channel-conv-${chan}`)).toHaveClass(/unread/);
        await openMenu(b.page, title);
        await b.page.locator('#category-menu-read').click();
        await expect(b.page.locator(`#channel-conv-${chan}`)).not.toHaveClass(/unread/);
        await expect.poll(() => unread(b.page, chan)).toBe(false);

        // Owner: edit + delete too
        await openServer(s.owner, sid);
        await openMenu(s.owner, title);
        expect(await menuIds(s.owner)).toEqual(['category-menu-read', 'category-menu-collapse', 'category-menu-collapse-all',
            'category-menu-mute', 'category-menu-notif', 'edit-cat-item', 'category-menu-delete']);
        await s.owner.locator('#category-menu-delete').click();
        await acceptDialog(s.owner);
        await expect(s.owner.locator(title)).toHaveCount(0);
        await expect(s.owner.locator(`#channel-conv-${chan}`)).toBeVisible();   // its channels move out
        await s.close();
    });
});
