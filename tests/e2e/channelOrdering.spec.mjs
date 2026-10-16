// Sidebar order: `place` floats, one list per container — the top level (categories +
// channels without a category) and each category (its channels, every type together).
// New items go to the end of their list, a drag writes the place of the dragged item only
// (one request) and the server opens the first text channel shown.
// (routes/servers.py, static/drag.mjs, crud.mjs orderServDirs, db/migrate_channel_order.sql)
import { test, expect } from '@playwright/test';
import { api, json, status, setupServer, createChannel } from './helpers/permissionHelpers.mjs';
import { openServerFromSidebarById } from './helpers/serverHelpers.mjs';
import { reloadAndWaitForApp } from './helpers/messagingHelpers.mjs';

const TEST_TIMEOUT = 150000;

/** Sidebar as shown: "[NAME]" for a category, "  name" for a channel inside one, "name" at top level. */
const sidebar = (page) => page.evaluate(() => [...document.querySelectorAll('#server-selector .title, #server-selector .conv')]
    .map(el => el.matches('.title') ? `[${el.querySelector('h2').textContent.trim()}]`
        : (el.closest('.group') ? '  ' : '') + el.textContent.trim()));

async function server(browser, label) {
    const s = await setupServer(browser, label, 0);
    const sid = s.serverId;
    const p = s.owner;
    const edit = (id, field, value, type = 'textual') =>
        api(p, `/edit_server_channel?server_id=${sid}&targetId=${id}&channel_type=${type}&field=${field}&value=${encodeURIComponent(value)}`);
    const cat = async (name, place) => {
        const c = await json(p, `/edit_server_category?server_id=${sid}&action=create`);
        await api(p, `/edit_server_category?server_id=${sid}&targetId=${c.id}&field=name&value=${name}`);
        if (place !== undefined) await api(p, `/edit_server_category?server_id=${sid}&targetId=${c.id}&field=place&value=${place}`);
        return c.id;
    };
    const chan = async (name, category, place, type = 'textual') => {
        const id = await createChannel(p, sid, type);
        await edit(id, 'name', name, type);
        if (category) await edit(id, 'category', category, type);
        if (place !== undefined) await edit(id, 'place', place, type);
        return id;
    };
    /** Channel/category writes sent while running `fn` (a reorder must send one). */
    const placeWrites = async (fn) => {
        const writes = [];
        const onRequest = (r) => { if (/edit_server_(channel|category)\?/.test(r.url())) writes.push(r.url()); };
        p.on('request', onRequest);
        await fn();
        await p.waitForTimeout(500);
        p.off('request', onRequest);
        return writes.length;
    };
    /** Drag `source` onto the top edge of `target`: before it (top third of a category title = before the category). */
    const dragBefore = (source, target) => source.dragTo(target, { targetPosition: { x: 20, y: 1 } });
    const conv = (name) => p.locator('#server-selector .conv', { hasText: name }).first();
    const title = (name) => p.locator('#server-selector .title', { hasText: name }).first();
    // Reopen the server and read its sidebar (whichever channel it lands on: the last one visited)
    const reload = async () => {
        await reloadAndWaitForApp(p);
        await openServerFromSidebarById(p, sid);
        await p.locator('#server-selector .title').first().waitFor();
        return sidebar(p);
    };
    return { s, sid, p, edit, cat, chan, placeWrites, dragBefore, conv, title, reload };
}

test.describe('Channel ordering', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('new channels and categories go to the end of the sidebar, in creation order', async ({ browser }) => {
        const { s, cat, chan, reload } = await server(browser, 'order_new');
        await chan('text-new');
        await chan('voice-new', null, undefined, 'vocal');
        await cat('newcat');
        await chan('text-last');
        expect(await reload()).toEqual(['[SALONS TEXTUELS]', '  général', '[SALONS VOCAUX]',
            'text-new', 'voice-new', '[NEWCAT]', 'text-last']);
        await s.close();
    });

    test('the server opens the first text channel shown, not the lowest place of any category', async ({ browser }) => {
        const { s, p, cat, chan } = await server(browser, 'order_landing');
        const later = await cat('later', 50);
        const deep = await chan('deep', later, 0.05);
        await reloadAndWaitForApp(p);
        await openServerFromSidebarById(p, s.serverId);
        await p.waitForFunction(() => window.global.state.activeChan?.type === 'conv');
        const general = await p.evaluate(() => Math.min(...window.global.state.currentServer.dirs.channels.map(c => Number(c.id))));
        expect(await p.evaluate(() => Number(window.global.state.activeChan.id))).toBe(general);
        expect(general).not.toBe(deep);
        await s.close();
    });

    test('a channel dropped first in a category stays first (neighbours from that category only), one write', async ({ browser }) => {
        const { s, cat, chan, placeWrites, dragBefore, conv, reload } = await server(browser, 'order_first');
        const A = await cat('A', 10);
        const B = await cat('B', 20);
        await chan('a1', A, 5);
        await chan('b1', B, 1);
        await chan('b2', B, 2);
        await chan('mover', null, 30);
        await reload();
        expect(await placeWrites(() => dragBefore(conv('mover'), conv('b1')))).toBe(1);
        expect((await reload()).slice(-6)).toEqual(['[A]', '  a1', '[B]', '  mover', '  b1', '  b2']);
        await s.close();
    });

    test('a channel dropped between two categories stays there, one write', async ({ browser }) => {
        const { s, cat, chan, placeWrites, dragBefore, conv, title, reload } = await server(browser, 'order_between');
        const A = await cat('A', 10);
        const B = await cat('B', 20);
        await chan('a1', A, 5);
        await chan('b1', B, 1);
        await chan('loose', null, 0.01);
        await reload();
        expect(await placeWrites(() => dragBefore(conv('loose'), title('B')))).toBe(1);
        expect((await reload()).slice(-5)).toEqual(['[A]', '  a1', 'loose', '[B]', '  b1']);
        await s.close();
    });

    test('a category dropped above a channel without category goes above it, one write', async ({ browser }) => {
        const { s, cat, chan, placeWrites, dragBefore, conv, title, reload } = await server(browser, 'order_cat');
        await chan('loose-top', null, -10);
        await cat('mid', 20);
        await cat('last', 30);
        const before = await reload();
        expect(before[0]).toBe('loose-top');
        expect(await placeWrites(() => dragBefore(title('last'), conv('loose-top')))).toBe(1);
        const after = await reload();
        expect(after.slice(0, 2)).toEqual(['[LAST]', 'loose-top']);
        await s.close();
    });

    test('renumbering a category keeps every channel type in its place', async ({ browser }) => {
        // tb sits 0.00005 after the voice channel: dropping tc between them forces a renumbering
        const { s, cat, chan, dragBefore, conv, reload } = await server(browser, 'order_renumber');
        const A = await cat('A', 10);
        await chan('ta', A, 1);
        await chan('voice', A, 2, 'vocal');
        await chan('tb', A, 2.00005);
        await chan('tc', A, 5);
        await reload();
        await dragBefore(conv('tc'), conv('tb'));
        expect((await reload()).slice(-5)).toEqual(['[A]', '  ta', '  voice', '  tc', '  tb']);
        await s.close();
    });

    test('a drop between two channels sharing a place lands between them', async ({ browser }) => {
        // Ties come from older data (every channel used to be created at 0.1)
        const { s, cat, chan, dragBefore, conv, reload } = await server(browser, 'order_tie');
        const A = await cat('A', 10);
        await chan('x', A, 1);
        await chan('y', A, 1);
        await chan('z', null, 99);
        const before = await reload();
        const [first, second] = before.slice(-3, -1).map(n => n.trim());
        await dragBefore(conv('z'), conv(second));
        expect((await reload()).slice(-4)).toEqual(['[A]', `  ${first}`, '  z', `  ${second}`]);
        await s.close();
    });

    test('deleting a category leaves its channels where it was, in the same order', async ({ browser }) => {
        const { s, sid, p, cat, chan, reload } = await server(browser, 'order_delcat');
        const A = await cat('A', 10);
        await cat('B', 20);
        await chan('a1', A, 1);
        await chan('a2', A, 2);
        await chan('a-voice', A, 1.5, 'vocal');
        expect((await reload()).slice(-5)).toEqual(['[A]', '  a1', '  a-voice', '  a2', '[B]']);
        await api(p, `/edit_server_category?server_id=${sid}&targetId=${A}&action=delete`);
        expect((await reload()).slice(-4)).toEqual(['a1', 'a-voice', 'a2', '[B]']);
        await s.close();
    });

    test('the server only accepts finite places', async ({ browser }) => {
        const { s, sid, p, cat, chan } = await server(browser, 'order_finite');
        const id = await chan('c');
        const A = await cat('A');
        for (const bad of ['nan', 'inf', '-inf', 'abc', '']) {
            expect(await status(p, `/edit_server_channel?server_id=${sid}&targetId=${id}&channel_type=textual&field=place&value=${bad}`)).toBe(400);
            expect(await status(p, `/edit_server_category?server_id=${sid}&targetId=${A}&field=place&value=${bad}`)).toBe(400);
        }
        expect(await status(p, `/edit_server_channel?server_id=${sid}&targetId=${id}&channel_type=textual&field=place&value=2.5`)).toBe(200);
        await s.close();
    });
});
