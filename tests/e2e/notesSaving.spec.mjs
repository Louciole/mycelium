// Saving notes (CRDT, static/workspaces/noteSync.mjs → routes/notes_sync.py): every edit is
// a batch of operations POSTed to note_push (a long block used to overflow nginx's URL limit
// and was lost without a word); a failed push shows "Not saved" and is sent again; edits made
// while the server can't be reached survive a reload (IndexedDB) and are sent afterwards;
// note_block (search, MCP) is written back by the clients.
import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { createServerViaUi, openServerFromSidebarById } from './helpers/serverHelpers.mjs';
import {
    createNoteChannelViaUi,
    openNoteChannel,
    waitForNoteChannelLoaded,
    getFirstBlockOfType,
} from './helpers/workspaceHelpers.mjs';

const TEST_TIMEOUT = 120000;

async function openFreshNote(page, prefix) {
    await loginUser(page, `${prefix}_${Date.now()}`);
    await waitForAppReady(page);
    const serverId = await createServerViaUi(page);
    await openServerFromSidebarById(page, serverId);
    const channelId = await createNoteChannelViaUi(page);
    await openNoteChannel(page, channelId);
    await waitForNoteChannelLoaded(page, channelId);
    await page.waitForFunction(
        (id) => Object.values(window.global?.notes?.[id]?.blocks || {}).some((b) => b.type === 'text'),
        channelId, { timeout: 10000 });
    return { serverId, channelId };
}

/** The block as note_block holds it (null when it isn't there). */
const storedBlock = (page, channelId, uuid) => page.evaluate(async ([id, u]) => {
    const note = await fetch(`/get_note_content?channel_id=${id}`).then((r) => r.json());
    return note.blocks.find((b) => b.uuid === u) || null;
}, [channelId, uuid]);
const storedContent = async (page, channelId, uuid) => (await storedBlock(page, channelId, uuid))?.content ?? null;

/** The note rebuilt from its op log, as a fresh client would (the source of truth). */
const logText = (page, channelId, uuid) => page.evaluate(async ([id, u]) => {
    const {NoteDoc} = await import('/static/crdt/doc.mjs');
    const data = await fetch(`/note_sync?channel=${id}&after=0`).then((r) => r.json());
    const doc = new NoteDoc(1);
    for (const op of data.ops) doc.apply(op);
    return doc.text(u);
}, [channelId, uuid]);

test.describe('Notes - saving', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('a block bigger than 16 KB is saved', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enotebig');
        const uuid = await getFirstBlockOfType(page, channelId, 'text');
        // ~24 KB of text: far over nginx's 8 KB request line
        const big = Array.from({ length: 3000 }, (_, i) => `mot${i}`).join(' ') + ' é';
        expect(big.length).toBeGreaterThan(16 * 1024);

        await page.locator(`[data-block-id="${uuid}"] .content`).click();
        await page.keyboard.insertText(big);
        // (lengths first: a failure doesn't print 24 KB twice)
        await expect.poll(async () => (await logText(page, channelId, uuid)).length, { timeout: 10000 }).toBe(big.length);
        await expect.poll(async () => (await storedContent(page, channelId, uuid))?.length, { timeout: 10000 }).toBe(big.length);
        expect(await storedContent(page, channelId, uuid) === big).toBe(true);
        await expect(page.locator('.note-save-status')).toHaveCount(0);

        // Still there after a reload
        await page.reload();
        await waitForAppReady(page);
        await openNoteChannel(page, channelId);
        await expect.poll(() => page.evaluate(([id, u, text]) => window.global.notes[id]?.blocks[u]?.content === text,
            [channelId, uuid, big])).toBe(true);
    });

    test('the GET query-string form still works (MCP server), and shows up live', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enoteget');
        const uuid = crypto.randomUUID();
        const block = encodeURIComponent(JSON.stringify({ uuid, type: 'text', content: 'from mcp', position: 5 }));
        const code = await page.evaluate((url) => fetch(url).then((r) => r.status),
            `/save_block?channel=${channelId}&op=create&block=${block}`);
        expect(code).toBe(200);
        expect(await storedContent(page, channelId, uuid)).toBe('from mcp');
        // The open editor receives it as operations
        await expect(page.locator(`[data-block-id="${uuid}"] .content`)).toHaveText('from mcp', { timeout: 5000 });

        // An edit and a delete through the same endpoint
        const edited = encodeURIComponent(JSON.stringify({ uuid, type: 'text', content: 'edited by mcp' }));
        expect(await page.evaluate((url) => fetch(url).then((r) => r.status), `/save_block?channel=${channelId}&op=edit&block=${edited}`)).toBe(200);
        await expect(page.locator(`[data-block-id="${uuid}"] .content`)).toHaveText('edited by mcp', { timeout: 5000 });
        expect(await page.evaluate((url) => fetch(url).then((r) => r.status),
            `/save_block?channel=${channelId}&op=delete&block=${encodeURIComponent(JSON.stringify({ uuid }))}`)).toBe(200);
        await expect(page.locator(`[data-block-id="${uuid}"]`)).toHaveCount(0, { timeout: 5000 });
        expect(await storedBlock(page, channelId, uuid)).toBeNull();
    });

    test('a failed push shows "not saved" and is sent again on its own', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enotefail');
        const uuid = await getFirstBlockOfType(page, channelId, 'text');
        const status = page.locator('.note-save-status');
        const content = page.locator(`[data-block-id="${uuid}"] .content`);

        // 1. The server answers with an error (xhr's onload also fires on 5xx)
        await page.route('**/note_push*', (route) => route.fulfill({ status: 500, body: 'boom' }));
        await content.click();
        await page.keyboard.type('abc');
        await expect(status).toBeVisible({ timeout: 5000 });
        expect(await logText(page, channelId, uuid)).toBe('');
        await expect(content).toHaveText('abc');   // nothing lost on screen

        // …it goes once the server is back
        await page.unroute('**/note_push*');
        await expect(status).toHaveCount(0, { timeout: 15000 });
        await expect.poll(() => logText(page, channelId, uuid)).toBe('abc');

        // 2. The network fails
        await page.route('**/note_push*', (route) => route.abort());
        await page.keyboard.type('def');
        await expect(status).toBeVisible({ timeout: 5000 });
        await page.unroute('**/note_push*');
        await expect(status).toHaveCount(0, { timeout: 15000 });
        await expect.poll(() => logText(page, channelId, uuid)).toBe('abcdef');
        await expect.poll(() => storedContent(page, channelId, uuid), { timeout: 10000 }).toBe('abcdef');
    });

    test('edits made while the server is unreachable survive a reload and are sent after', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enoteoffline');
        const uuid = await getFirstBlockOfType(page, channelId, 'text');
        await page.locator(`[data-block-id="${uuid}"] .content`).click();
        await page.keyboard.type('kept');
        await expect.poll(() => logText(page, channelId, uuid)).toBe('kept');

        await page.route('**/note_push*', (route) => route.abort());
        await page.keyboard.type(' offline');
        await expect(page.locator('.note-save-status')).toBeVisible({ timeout: 5000 });
        await page.waitForTimeout(500);   // IndexedDB has them
        await page.reload();
        await waitForAppReady(page);
        await openNoteChannel(page, channelId);
        // This tab took over the pending operations of the closed one: shown…
        await expect.poll(() => page.evaluate(([id, u]) => window.global.notes[id]?.blocks[u]?.content, [channelId, uuid]))
            .toBe('kept offline');
        expect(await logText(page, channelId, uuid)).toBe('kept');
        // …and sent once the server can be reached
        await page.unroute('**/note_push*');
        await expect.poll(() => logText(page, channelId, uuid), { timeout: 20000 }).toBe('kept offline');
    });

    test('checklist items save while typing, and before the page goes away', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enotetodo');
        const uuid = await getFirstBlockOfType(page, channelId, 'text');
        await page.locator(`[data-block-id="${uuid}"] .content`).click();
        await page.keyboard.type('/todo');
        await page.waitForFunction(([id, u]) => window.global.notes[id].blocks[u]?.type === 'checklist', [channelId, uuid]);

        const item = page.locator(`[data-block-id="${uuid}"] .checklist-item-text`).first();
        await item.click();
        await page.keyboard.type('buy milk');
        await expect(item).toBeFocused();   // no blur needed
        await expect.poll(() => logText(page, channelId, uuid), { timeout: 5000 }).toBe('[ ] buy milk');
        await expect.poll(() => storedContent(page, channelId, uuid), { timeout: 10000 }).toBe('[ ] buy milk');

        // Typed right before a reload: sent as the page goes away
        await page.keyboard.type(' now');
        await page.reload();
        await waitForAppReady(page);
        await expect.poll(() => logText(page, channelId, uuid), { timeout: 10000 }).toBe('[ ] buy milk now');
    });

    test('an emoji typed right before another one is saved (no half emoji is ever sent)', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enoteemoji');
        const uuid = await getFirstBlockOfType(page, channelId, 'text');
        await page.locator(`[data-block-id="${uuid}"] .content`).click();
        await page.keyboard.type('😀');
        await expect.poll(() => logText(page, channelId, uuid)).toBe('😀');
        await page.keyboard.press('Home');
        await page.keyboard.type('👍');   // same first half (surrogate) as 😀
        await expect.poll(() => logText(page, channelId, uuid)).toBe('👍😀');
        await page.keyboard.press('End');
        await page.keyboard.type(' ok');
        await expect.poll(() => logText(page, channelId, uuid)).toBe('👍😀 ok');
        await expect(page.locator('.note-save-status')).toHaveCount(0);
    });

    test('a closed tab with more than one request of pending edits gets all of them sent', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enoteorphan');
        const uuid = await getFirstBlockOfType(page, channelId, 'text');
        await page.locator(`[data-block-id="${uuid}"] .content`).click();
        await page.keyboard.type('start ');
        await expect.poll(() => logText(page, channelId, uuid)).toBe('start ');
        // A tab that went away offline with 1200 keystrokes not sent (one operation each), in
        // its IndexedDB entry: nobody holds its lock
        const typed = await page.evaluate(async ([id, u]) => {
            const {NoteDoc} = await import('/static/crdt/doc.mjs');
            const sync = window.global.state.noteEditor.sync;
            const dead = 987654321;
            const doc = new NoteDoc(dead);
            for (const op of sync.log) doc.apply(op);
            const ops = [];
            let typed = '';
            for (let i = 0; i < 1200; i++) {
                typed += String(i % 10);
                ops.push(...doc.insert(u, doc.text(u).length, String(i % 10)));
            }
            const db = await new Promise((resolve) => { const r = indexedDB.open('mycelium-notes', 2); r.onsuccess = () => resolve(r.result); });
            await new Promise((resolve) => {
                const tx = db.transaction('pending', 'readwrite');
                tx.objectStore('pending').put({client: dead, ops}, [window.global.user.id, id, dead]);
                tx.oncomplete = resolve;
            });
            db.close();
            return typed;
        }, [channelId, uuid]);
        await page.reload();
        await waitForAppReady(page);
        await openNoteChannel(page, channelId);
        // Taken over by this tab and sent in several requests, then written back to note_block
        await expect.poll(() => logText(page, channelId, uuid), { timeout: 30000 }).toBe('start ' + typed);
        await expect.poll(() => storedContent(page, channelId, uuid), { timeout: 15000 }).toBe('start ' + typed);
        expect(await page.evaluate(() => window.global.state.noteEditor.sync.orphans.length)).toBe(0);
    });

    test('two tabs editing offline keep each other\'s edits, and logout empties the cache', async ({ page }) => {
        const { serverId, channelId } = await openFreshNote(page, 'e2enotetabs');
        const uuid = await getFirstBlockOfType(page, channelId, 'text');
        const second = await page.context().newPage();
        await second.goto(page.url());
        await waitForAppReady(second);
        await openServerFromSidebarById(second, serverId);
        await openNoteChannel(second, channelId);
        await waitForNoteChannelLoaded(second, channelId);

        await page.context().route('**/note_push*', (route) => route.abort());
        await page.locator(`[data-block-id="${uuid}"] .content`).click();
        await page.keyboard.type('from A');
        await page.waitForTimeout(600);   // in IndexedDB
        await page.close();               // its keepalive push fails too
        // B keeps editing: its cache writes must not erase A's pending edits
        const bBlock = second.locator('#note-editor .block > .content').first();
        await bBlock.click();
        await second.keyboard.press('End');
        await second.keyboard.type(' and B');
        await second.waitForTimeout(600);

        // A third tab takes over A's edits; once the server is reachable, everything arrives
        const third = await second.context().newPage();
        await third.goto(second.url());
        await waitForAppReady(third);
        await openServerFromSidebarById(third, serverId);
        await openNoteChannel(third, channelId);
        await waitForNoteChannelLoaded(third, channelId);
        await second.context().unroute('**/note_push*');
        await second.evaluate(() => window.global.state.noteEditor.retrySaves());
        await expect.poll(() => logText(third, channelId, uuid), { timeout: 30000 }).toMatch(/from A/);
        await expect.poll(() => logText(third, channelId, uuid), { timeout: 30000 }).toMatch(/and B/);

        // Logout wipes the notes' cache with the rest of the local data
        const databases = () => third.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
        expect(await databases()).toContain('mycelium-notes');
        await third.evaluate(() => window.clearSnapshot());
        expect(await databases()).not.toContain('mycelium-notes');
        await third.close();
    });
});
