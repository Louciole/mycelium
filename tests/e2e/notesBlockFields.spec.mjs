// Mass assignment on the notes write endpoints (routes/workspaces.py): save_block used to
// insert the client's block dict as-is, so a forged id / channel / parent_block landed in
// note_block. Only the whitelisted, validated columns may be set, and every reference
// (parent block, database block) must stay inside the notes channel being written.
import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { createServerViaUi } from './helpers/serverHelpers.mjs';

const TEST_TIMEOUT = 120000;
const enc = encodeURIComponent;

/** POST `path` from the page's session → { status, text }. */
const call = (page, path) => page.evaluate(async (p) => {
    const r = await fetch(p, { method: 'POST', credentials: 'include' });
    return { status: r.status, text: await r.text() };
}, path);
const status = async (page, path) => (await call(page, path)).status;

const saveBlock = (page, channel, block, op = 'create') =>
    status(page, `/save_block?channel=${channel}&op=${op}&block=${enc(JSON.stringify(block))}`);
const noteBlocks = async (page, channel) =>
    JSON.parse((await call(page, `/get_note_content?channel_id=${channel}`)).text).blocks;
const blockOf = async (page, channel, uuid) => (await noteBlocks(page, channel)).find(b => b.uuid === uuid);

async function createNotesChannel(page, serverId) {
    const res = await call(page, `/edit_server_channel?server_id=${serverId}&action=create&channel_type=note`);
    expect(res.status).toBe(200);
    return Number(JSON.parse(res.text).channel.id);
}

test.describe('Notes: client-forged block fields', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('save_block only stores whitelisted fields, parent_block stays in the channel', async ({ page }) => {
        await loginUser(page, `e2e_blockfields_${Date.now()}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        const notesA = await createNotesChannel(page, serverId);
        const notesB = await createNotesChannel(page, serverId);

        const textBlock = (extra = {}) => ({ type: 'text', content: 'hi', uuid: crypto.randomUUID(), position: 1, ...extra });

        // A block in B to point at
        const inB = textBlock();
        expect(await saveBlock(page, notesB, inB)).toBe(200);
        const inBId = Number((await blockOf(page, notesB, inB.uuid)).id);

        // Forged id / channel are ignored: the block lands in A with a server-assigned id
        const forged = textBlock({ id: inBId + 1000000, channel: notesB });
        expect(await saveBlock(page, notesA, forged)).toBe(200);
        const stored = await blockOf(page, notesA, forged.uuid);
        expect(stored).toBeTruthy();
        expect(Number(stored.id)).not.toBe(forged.id);
        expect(Number(stored.channel)).toBe(notesA);
        expect(await blockOf(page, notesB, forged.uuid)).toBeUndefined();

        // parent_block pointing into another channel is rejected, on create and on edit
        expect(await saveBlock(page, notesA, textBlock({ parent_block: inBId }))).toBe(400);
        expect(await saveBlock(page, notesA, { ...stored, parent_block: inBId }, 'edit')).toBe(400);
        expect(await saveBlock(page, notesA, { ...stored, parent_block: Number(stored.id) }, 'edit')).toBe(400);
        expect((await blockOf(page, notesA, forged.uuid)).parent_block).toBeNull();
        // …while a parent in the same channel is fine
        const child = textBlock({ parent_block: Number(stored.id) });
        expect(await saveBlock(page, notesA, child)).toBe(200);
        expect(Number((await blockOf(page, notesA, child.uuid)).parent_block)).toBe(Number(stored.id));

        // Edit sends the stored row back: id / channel are ignored, real columns are saved
        expect(await saveBlock(page, notesA, { ...stored, id: inBId, channel: notesB, content: 'edited' }, 'edit')).toBe(200);
        const edited = await blockOf(page, notesA, forged.uuid);
        expect(edited.content).toBe('edited');
        expect(Number(edited.id)).toBe(Number(stored.id));
        expect(Number(edited.channel)).toBe(notesA);
        expect(Number((await blockOf(page, notesB, inB.uuid)).id)).toBe(inBId);

        // Values rendered unescaped in the note templates must be plain identifiers / UUIDs
        expect(await saveBlock(page, notesA, textBlock({ type: 'text" onmouseover="alert(1)' }))).toBe(400);
        expect(await saveBlock(page, notesA, textBlock({ uuid: "x');alert(1)//" }))).toBe(400);
        expect(await saveBlock(page, notesA, textBlock({ row_group: "x');alert(1)//" }))).toBe(400);
        expect(await saveBlock(page, notesA, textBlock({ position: 'NaN' }))).toBe(400);
        expect(await saveBlock(page, notesA, textBlock({ column_index: -1 }))).toBe(400);
        expect(await saveBlock(page, notesA, { ...stored, type: '<b>' }, 'edit')).toBe(400);
        // A uuid can't be claimed twice (it would collide across channels)
        expect(await saveBlock(page, notesB, textBlock({ uuid: forged.uuid }))).toBe(400);
        expect(await status(page, `/save_block?channel=${notesA}&op=create&block=${enc('[1]')}`)).toBe(400);
    });

    test('databases stay bound to their notes channel', async ({ page }) => {
        await loginUser(page, `e2e_dbfields_${Date.now()}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        const notesA = await createNotesChannel(page, serverId);
        const notesB = await createNotesChannel(page, serverId);

        // A database block in B (save_block auto-creates its note_database)
        const dbBlock = { type: 'database', content: '', uuid: crypto.randomUUID(), position: 1 };
        expect(await saveBlock(page, notesB, dbBlock)).toBe(200);
        const content = (chan) => call(page, `/get_database_content?channel=${chan}&block_uuid=${dbBlock.uuid}`);
        const inB = await content(notesB);
        expect(inB.status).toBe(200);
        const database = JSON.parse(inB.text);

        // Neither readable nor re-creatable through channel A
        expect((await content(notesA)).status).toBe(404);
        const create = (chan, uuid) => status(page,
            `/save_database?channel=${chan}&op=create&database=${enc(JSON.stringify({ block_uuid: uuid }))}`);
        expect(await create(notesA, dbBlock.uuid)).toBe(404);
        expect(await create(notesB, dbBlock.uuid)).toBe(200);   // idempotent in its own channel

        // Edit: validated values only
        const edit = (fields) => status(page,
            `/save_database?channel=${notesB}&op=edit&database=${enc(JSON.stringify({ id: database.id, ...fields }))}`);
        expect(await edit({ view_type: 'gallery' })).toBe(200);
        expect(await edit({ view_type: 'x'.repeat(40) })).toBe(400);
        expect(await edit({ name: { evil: true } })).toBe(400);
        expect(await edit({ gallery_cover_column: 999999999 })).toBe(400);
        expect(await edit({ gallery_cover_column: Number(database.columns[0].id) })).toBe(200);

        const row = (r) => status(page,
            `/save_database_row?channel=${notesB}&database_id=${database.id}&op=create&row=${enc(JSON.stringify(r))}`);
        expect(await row({ position: 'abc' })).toBe(400);
        expect(await row({ position: 2 })).toBe(200);
    });
});
