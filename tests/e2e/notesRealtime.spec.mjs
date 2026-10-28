// Collaborative notes between members (CRDT: static/crdt/, workspaces/noteSync.mjs,
// routes/notes_sync.py): edits reach the other viewers live, two people typing in the same
// block both keep their text, a caret stays after its character while others type, undo only
// takes back one's own changes, everyone sees where the others are, and the server refuses
// what a member may not write (a timed-out member included: they still read the note live).
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
    api, json, enc, setupServer, openServer, createChannel, setChannelPerm as setPerm,
} from './helpers/permissionHelpers.mjs';
import {
    openNoteChannel, waitForNoteChannelLoaded, createSpreadsheetBlock, waitForSpreadsheetLoaded,
    editSpreadsheetCell, waitForSpreadsheetCellValue,
} from './helpers/workspaceHelpers.mjs';

const TEST_TIMEOUT = 180000;

/** Text of the note's blocks in reading order, as rendered. */
const blockTexts = (page) =>
    page.locator('#note-editor .block > .content').evaluateAll((els) => els.map((el) => el.innerText.trim()));
const blockIds = (page, chan) => page.evaluate((id) => Object.keys(window.global.notes[id]?.blocks || {}), chan);

/** The note rebuilt from its op log, as a fresh client would. */
const logTexts = (page, chan) => page.evaluate(async (id) => {
    const {NoteDoc} = await import('/static/crdt/doc.mjs');
    const data = await fetch(`/note_sync?channel=${id}&after=0`).then((r) => r.json());
    const doc = new NoteDoc(1);
    for (const op of data.ops) doc.apply(op);
    return Object.fromEntries(doc.ids().filter((o) => doc.get(o, 'deleted') === false).map((o) => [o, doc.text(o)]));
}, chan);

/** The gutter "+" of a block: a new empty block right below, focused. */
async function addBelow(page, uuid) {
    const block = page.locator(`.block[data-block-id="${uuid}"]`);
    await block.hover();
    await block.locator('.controls .add').click();
}

/** The note_ops messages a page receives over its WebSocket. */
function recordNoteOps(page) {
    const events = [];
    page.on('console', (msg) => {
        if (msg.text().includes('"type":"note_ops"')) events.push(msg.text());
    });
    return events;
}

/** Open the server and its notes channel, wait for the editor and its first block. */
async function openNote(page, sid, chan) {
    await openServer(page, sid);
    await openNoteChannel(page, chan);
    await waitForNoteChannelLoaded(page, chan);
    await page.locator('#note-editor .block').first().waitFor();
    // In the note's room (note_join answered)
    await page.waitForFunction(() => window.global.state.noteEditor?.sync?.joined === true);
}

/** POST note_push from the page's session (JSON body): {status, rejected: clocks refused}. */
const pushResult = (page, chan, body) => page.evaluate(async ([id, b]) => {
    const r = await fetch(`/note_push?channel=${id}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(b)});
    return {status: r.status, rejected: r.status === 200 ? (await r.json()).rejected : null};
}, [chan, body]);
const push = (page, chan, body) => pushResult(page, chan, body).then((r) => r.status);

test.describe('Notes - collaboration', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('edits reach the viewers live; a member who cannot view the note gets nothing', async ({ browser }) => {
        const s = await setupServer(browser, 'notes_live', 2);
        const [b, c] = s.members;
        const chan = await createChannel(s.owner, s.serverId, 'note');
        await setPerm(s.owner, chan, `accountId=${c.id}`, 'view-channels', 'deny', 'note');

        await openNote(s.owner, s.serverId, chan);
        const [first] = await blockIds(s.owner, chan);
        await openNote(b.page, s.serverId, chan);
        await openServer(c.page, s.serverId);
        const cEvents = recordNoteOps(c.page);

        // C can't join the room
        const refused = await c.page.evaluate((id) => new Promise((resolve) => {
            const socket = window.global.state.websocket;
            const listener = (event) => {
                const message = JSON.parse(event.data);
                if (message.type === 'note_error' && message.channel === id) resolve(message.error);
            };
            socket.addEventListener('message', listener);
            socket.send(JSON.stringify({type: 'note_join', clientID: window.global.state.clientID, channel: id, after: 0}));
            setTimeout(() => resolve('no answer'), 4000);
        }), chan);
        expect(refused).toBe('forbidden');

        // Edit, create, delete: B sees each without reopening the note
        await s.owner.locator(`[data-block-id="${first}"] .content`).click();
        await s.owner.keyboard.type('Hello from owner');
        await expect(b.page.locator(`[data-block-id="${first}"] .content`)).toHaveText('Hello from owner', { timeout: 5000 });
        await addBelow(s.owner, first);
        await s.owner.keyboard.type('Second line');
        await expect.poll(() => blockTexts(b.page), { timeout: 5000 }).toEqual(['Hello from owner', 'Second line']);
        const second = (await blockIds(s.owner, chan)).find((u) => u !== first);
        const block = s.owner.locator(`[data-block-id="${second}"]`);
        await block.hover();
        await block.locator('.controls .drag').click();
        await s.owner.locator('.note-block-menu .drive-context-item.danger').click();
        await expect.poll(() => blockTexts(b.page), { timeout: 5000 }).toEqual(['Hello from owner']);

        // A note left (out of its room) catches up with what changed when opened again
        const general = await b.page.evaluate(() => Math.min(...window.global.state.currentServer.dirs.channels.map((x) => Number(x.id))));
        await b.page.locator(`#channel-conv-${general}`).click();
        await b.page.waitForFunction((g) => Number(window.global.state.activeChan?.id) === g, general);
        // save_block edits the note_block row, which the owner's tab writes back 1.5 s after its last edit
        await expect.poll(async () => (await json(s.owner, `/get_note_content?channel_id=${chan}`)).blocks
            .some((bl) => bl.uuid === first), { timeout: 10000 }).toBe(true);
        await api(s.owner, `/save_block?channel=${chan}&op=edit&block=${enc(JSON.stringify({ uuid: first, content: 'Edited while away' }))}`);
        await openNoteChannel(b.page, chan);
        await expect(b.page.locator(`[data-block-id="${first}"] .content`)).toHaveText('Edited while away', { timeout: 5000 });

        expect(cEvents).toEqual([]);
        await s.close();
    });

    test('two people typing in the same block both keep their text, and agree', async ({ browser }) => {
        const s = await setupServer(browser, 'notes_same', 1);
        const [b] = s.members;
        const chan = await createChannel(s.owner, s.serverId, 'note');
        await setPerm(s.owner, chan, `accountId=${b.id}`, 'edit-notes', 'allow', 'note');
        await openNote(s.owner, s.serverId, chan);
        const [first] = await blockIds(s.owner, chan);
        await s.owner.locator(`[data-block-id="${first}"] .content`).click();
        await s.owner.keyboard.type('AZ');
        await openNote(b.page, s.serverId, chan);
        await expect(b.page.locator(`[data-block-id="${first}"] .content`)).toHaveText('AZ', { timeout: 5000 });

        // Both put their caret between the two signs and type at the same time
        for (const page of [s.owner, b.page]) {
            await page.locator(`[data-block-id="${first}"] .content`).click();
            await page.keyboard.press('End');
            await page.keyboard.press('ArrowLeft');
        }
        await Promise.all([
            s.owner.keyboard.type('alpha', { delay: 40 }),
            b.page.keyboard.type('omega', { delay: 40 }),
        ]);
        const expected = ['AalphaomegaZ', 'AomegaalphaZ'];
        await expect.poll(() => s.owner.locator(`[data-block-id="${first}"] .content`).innerText(), { timeout: 8000 })
            .toMatch(/^A(alphaomega|omegaalpha)Z$/);
        const text = await s.owner.locator(`[data-block-id="${first}"] .content`).innerText();
        expect(expected).toContain(text);
        await expect(b.page.locator(`[data-block-id="${first}"] .content`)).toHaveText(text, { timeout: 8000 });
        await expect.poll(() => logTexts(s.owner, chan).then((t) => t[first]), { timeout: 8000 }).toBe(text);
        await s.close();
    });

    test('a caret stays after its character while someone else types before it', async ({ browser }) => {
        const s = await setupServer(browser, 'notes_caret', 1);
        const [b] = s.members;
        const chan = await createChannel(s.owner, s.serverId, 'note');
        await setPerm(s.owner, chan, `accountId=${b.id}`, 'edit-notes', 'allow', 'note');
        await openNote(s.owner, s.serverId, chan);
        const [first] = await blockIds(s.owner, chan);
        const ownerEl = s.owner.locator(`[data-block-id="${first}"] .content`);
        await ownerEl.click();
        await s.owner.keyboard.type('hello world');
        await openNote(b.page, s.serverId, chan);
        const bEl = b.page.locator(`[data-block-id="${first}"] .content`);
        await expect(bEl).toHaveText('hello world', { timeout: 5000 });

        // B's caret right after "hello"
        await bEl.click();
        await b.page.keyboard.press('Home');
        for (let i = 0; i < 5; i++) await b.page.keyboard.press('ArrowRight');

        // The owner types at the start of the same block
        await ownerEl.click();
        await s.owner.keyboard.press('Home');
        await s.owner.keyboard.type('>> ');
        await expect(bEl).toHaveText('>> hello world', { timeout: 5000 });

        await expect(bEl).toBeFocused();
        await b.page.keyboard.type(',');
        await expect(bEl).toHaveText('>> hello, world');
        await expect(ownerEl).toHaveText('>> hello, world', { timeout: 5000 });
        await s.close();
    });

    test('Ctrl+Z only takes back my own changes, Ctrl+Y puts them back', async ({ browser }) => {
        const s = await setupServer(browser, 'notes_undo', 1);
        const [b] = s.members;
        const chan = await createChannel(s.owner, s.serverId, 'note');
        await setPerm(s.owner, chan, `accountId=${b.id}`, 'edit-notes', 'allow', 'note');
        await openNote(s.owner, s.serverId, chan);
        const [first] = await blockIds(s.owner, chan);
        await openNote(b.page, s.serverId, chan);
        const ownerEl = s.owner.locator(`[data-block-id="${first}"] .content`);
        const bEl = b.page.locator(`[data-block-id="${first}"] .content`);

        await ownerEl.click();
        await s.owner.keyboard.type('hello');
        await expect(bEl).toHaveText('hello', { timeout: 5000 });
        await bEl.click();
        await b.page.keyboard.press('End');
        await b.page.keyboard.type(' world');
        await expect(ownerEl).toHaveText('hello world', { timeout: 5000 });

        // The owner undoes: "hello" goes (theirs), " world" stays (B's)
        await ownerEl.click();
        await s.owner.keyboard.press('Control+z');
        await expect(ownerEl).toHaveText('world');
        await expect(bEl).toHaveText('world', { timeout: 5000 });
        await s.owner.keyboard.press('Control+y');
        await expect(ownerEl).toHaveText('hello world');
        await expect(bEl).toHaveText('hello world', { timeout: 5000 });

        // A deleted block comes back with Ctrl+Z, for everyone
        await addBelow(s.owner, first);
        await s.owner.keyboard.type('to delete');
        await expect.poll(() => blockTexts(b.page), { timeout: 5000 }).toEqual(['hello world', 'to delete']);
        const second = (await blockIds(s.owner, chan)).find((u) => u !== first);
        const block = s.owner.locator(`[data-block-id="${second}"]`);
        await block.hover();
        await block.locator('.controls .drag').click();
        await s.owner.locator('.note-block-menu .drive-context-item.danger').click();
        await expect.poll(() => blockTexts(b.page), { timeout: 5000 }).toEqual(['hello world']);
        await s.owner.keyboard.press('Control+z');
        await expect.poll(() => blockTexts(s.owner)).toEqual(['hello world', 'to delete']);
        await expect.poll(() => blockTexts(b.page), { timeout: 5000 }).toEqual(['hello world', 'to delete']);
        await s.close();
    });

    test('everyone sees who is in the note and where their caret is', async ({ browser }) => {
        const s = await setupServer(browser, 'notes_cursor', 1);
        const [b] = s.members;
        const chan = await createChannel(s.owner, s.serverId, 'note');
        await setPerm(s.owner, chan, `accountId=${b.id}`, 'edit-notes', 'allow', 'note');
        await openNote(s.owner, s.serverId, chan);
        const [first] = await blockIds(s.owner, chan);
        await s.owner.locator(`[data-block-id="${first}"] .content`).click();
        await s.owner.keyboard.type('some shared text');
        await openNote(b.page, s.serverId, chan);
        const bName = await b.page.evaluate(() => window.global.users[window.global.user.id]?.display);

        // B puts their caret in the middle of the owner's block
        const bEl = b.page.locator(`[data-block-id="${first}"] .content`);
        await bEl.click();
        await b.page.keyboard.press('Home');
        for (let i = 0; i < 5; i++) await b.page.keyboard.press('ArrowRight');

        const caret = s.owner.locator('.note-peer-caret');
        await expect(caret).toHaveCount(1, { timeout: 5000 });
        await expect(caret.locator('.note-peer-name')).toHaveText(bName);
        // In the header: B's avatar, ringed with B's caret colour; their name on hover; a click
        // opens their profile, as anywhere else on the server
        const person = s.owner.locator('.note-person');
        await expect(person).toHaveCount(1);
        await expect(person.locator('.pfp-small')).toHaveCount(1);
        const [ring, caretColor] = await s.owner.evaluate(() => [
            getComputedStyle(document.querySelector('.note-person .pfp-small')).boxShadow,
            getComputedStyle(document.querySelector('.note-peer-caret')).backgroundColor,
        ]);
        expect(ring).toContain(caretColor);
        await expect(person.locator('.tooltip')).toBeHidden();
        await person.hover();
        await expect(person.locator('.tooltip')).toBeVisible();
        await expect(person.locator('.tooltip')).toHaveText(bName);
        await person.click();
        await expect(s.owner.locator('#profileInfo')).toBeVisible();
        expect(await s.owner.evaluate(() => window.global.state.profileInfo?.id)).toBe(b.id);
        await s.owner.evaluate(() => window.closeFM());
        await expect(s.owner.locator('#profileInfo')).toBeHidden();
        // …drawn inside the block, after "some " (5 characters in)
        const [blockBox, caretBox, textStart] = await s.owner.evaluate((u) => {
            const el = document.querySelector(`[data-block-id="${u}"] .content`);
            const range = document.createRange();
            range.setStart(el.firstChild, 5);
            range.collapse(true);
            return [el.getBoundingClientRect().toJSON(), document.querySelector('.note-peer-caret').getBoundingClientRect().toJSON(),
                    range.getClientRects()[0].toJSON()];
        }, first);
        expect(caretBox.top).toBeGreaterThanOrEqual(blockBox.top - 2);
        expect(Math.abs(caretBox.left - textStart.left)).toBeLessThan(4);
        // One line high, never the whole block
        expect(caretBox.height).toBeGreaterThan(10);
        expect(caretBox.height).toBeLessThan(textStart.height * 1.6);

        // In a block of several lines, on its second line, still one line high
        await s.owner.locator(`[data-block-id="${first}"] .content`).click();
        await s.owner.keyboard.press('End');
        await s.owner.keyboard.type('\nsecond line\nthird line');
        await expect(bEl).toContainText('third line', { timeout: 5000 });
        await bEl.click();
        await b.page.keyboard.press('Control+End');
        await b.page.keyboard.press('ArrowUp');
        await b.page.keyboard.press('Home');
        await expect.poll(async () => {
            const box = await s.owner.locator('.note-peer-caret').boundingBox();
            const block = await s.owner.locator(`[data-block-id="${first}"] .content`).boundingBox();
            return box && block && box.height < 30 && box.y > block.y + 15;   // on a lower line, one line high
        }, { timeout: 5000 }).toBe(true);
        await b.page.keyboard.press('Control+Home');

        // A selection is shown too
        await b.page.keyboard.press('Shift+End');
        await expect(s.owner.locator('.note-peer-selection').first()).toBeVisible({ timeout: 5000 });

        // B goes to a text channel: out of the note's room, gone from its header
        const general = await b.page.evaluate(() => Math.min(...window.global.state.currentServer.dirs.channels.map((x) => Number(x.id))));
        await b.page.locator(`#channel-conv-${general}`).click();
        await expect(s.owner.locator('.note-person')).toHaveCount(0, { timeout: 8000 });
        await expect(s.owner.locator('.note-peer-caret')).toHaveCount(0);
        expect(await b.page.evaluate(() => window.global.state.noteEditor)).toBeNull();
        // …and back in it when they open the note again
        await openNoteChannel(b.page, chan);
        await b.page.waitForFunction(() => window.global.state.noteEditor?.sync?.joined === true);
        await expect(s.owner.locator('.note-person')).toHaveCount(1, { timeout: 8000 });

        // B closes the tab: their caret and avatar go away
        await b.page.close();
        await expect(s.owner.locator('.note-peer-caret')).toHaveCount(0, { timeout: 8000 });
        await expect(s.owner.locator('.note-person')).toHaveCount(0);
        await s.close();
    });

    test('the header shows only the people who may write; the member list everyone who sees the note', async ({ browser }) => {
        const s = await setupServer(browser, 'notes_people', 3);
        const [b, c, d] = s.members;   // B writes, C only reads, D can't see the note
        const chan = await createChannel(s.owner, s.serverId, 'note');
        await setPerm(s.owner, chan, `accountId=${b.id}`, 'edit-notes', 'allow', 'note');
        await setPerm(s.owner, chan, `accountId=${d.id}`, 'view-channels', 'deny', 'note');
        await openNote(s.owner, s.serverId, chan);
        await openNote(b.page, s.serverId, chan);
        await openNote(c.page, s.serverId, chan);
        const person = (page, uid) => page.locator(`.note-person[onclick*="toggleProfileInfo(${uid},"]`);

        // In the note with the owner: B and C. In the owner's header: B only (C has no caret to follow)
        await expect(person(s.owner, b.id)).toHaveCount(1, { timeout: 5000 });
        await s.owner.waitForTimeout(1500);   // C's presence arrived long since
        await expect(person(s.owner, c.id)).toHaveCount(0);
        await expect(s.owner.locator('.note-person')).toHaveCount(1);
        // In B's: the owner only
        await expect(person(b.page, s.ownerId)).toHaveCount(1, { timeout: 5000 });
        await expect(b.page.locator('.note-person')).toHaveCount(1);
        // C may write now: C shows for B, without anyone reopening the note (the rights change
        // reaches every member but its author, whose header follows at the next heartbeat)
        await setPerm(s.owner, chan, `accountId=${c.id}`, 'edit-notes', 'allow', 'note');
        await expect(person(b.page, c.id)).toHaveCount(1, { timeout: 5000 });

        // The member list, as in a text channel: everyone who sees the note, readers included
        await s.owner.locator('.selected-info img[src$="group.svg"]').click();
        const names = s.owner.locator('#member-list .name');
        await expect(names).toHaveCount(3);
        const listed = await names.evaluateAll((els) => els.map((el) => Number(el.dataset.uid)));
        expect(listed.sort()).toEqual([s.ownerId, b.id, c.id].sort());
        await expect(s.owner.locator('#member-list h3')).toContainText('3');
        // Beside the page, which stays usable
        const [page, list] = await s.owner.evaluate(() => [document.querySelector('.note-page').getBoundingClientRect().toJSON(),
            document.querySelector('#member-list').getBoundingClientRect().toJSON()]);
        expect(page.right).toBeLessThanOrEqual(list.left + 1);
        // Clicked again: hidden
        await s.owner.locator('.selected-info img[src$="group.svg"]').click();
        await expect(s.owner.locator('#member-list')).toBeHidden();
        await s.close();
    });

    test('a timed-out member still reads the note live but changes nothing until the timeout ends', async ({ browser }) => {
        const s = await setupServer(browser, 'notes_timeout', 1);
        const [b] = s.members;
        const chan = await createChannel(s.owner, s.serverId, 'note');
        await setPerm(s.owner, chan, `accountId=${b.id}`, 'edit-notes', 'allow', 'note');
        await openNote(s.owner, s.serverId, chan);
        const sheet = await createSpreadsheetBlock(s.owner, chan);
        await addBelow(s.owner, sheet);
        await s.owner.keyboard.type('Hello');
        const text = (await blockIds(s.owner, chan)).find((u) => u !== sheet);
        await openNote(b.page, s.serverId, chan);
        await waitForSpreadsheetLoaded(b.page, sheet);
        const editor = b.page.locator('#note-editor');
        const textEl = b.page.locator(`[data-block-id="${text}"] .content`);
        const sheetInput = b.page.locator(`#sheet-input-${sheet}`);
        await expect(editor).not.toHaveClass(/read-only/);

        // Timed out: the note turns read-only at once (the live notification)
        await api(s.owner, `/timeout_member?server_id=${s.serverId}&account_id=${b.id}&minutes=10`);
        await expect(editor).toHaveClass(/read-only/);
        await expect(textEl).toHaveAttribute('contenteditable', 'false');
        await b.page.locator(`#sheet-${sheet} .sheet-cell[data-ref="A1"]`).click();
        await expect(sheetInput).toHaveCount(0);

        // The server refuses every write of the note, whatever the page sends
        const post = (path, body) => b.page.evaluate(async ([p, bd]) => {
            const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bd && JSON.stringify(bd) });
            return [r.status, (await r.text()).includes('timed_out')];
        }, [path, body]);
        const sheetId = await b.page.evaluate((u) => window.global.state.spreadsheetViews[u].id, sheet);
        const refused = [403, true];
        expect(await post(`/note_push?channel=${chan}`, { client: 5151, ops: [{ c: 5151, k: 1, o: text, t: 'ins', p: null, s: 'R', x: 'x' }] })).toEqual(refused);
        expect(await post(`/note_project?channel=${chan}`, { seq: 1, blocks: [] })).toEqual(refused);
        expect(await post(`/note_ensure_block?channel=${chan}&uuid=${randomUUID()}&type=spreadsheet`)).toEqual(refused);
        expect(await post(`/save_block?channel=${chan}&op=edit&block=${enc(JSON.stringify({ uuid: text, content: 'hacked' }))}`)).toEqual(refused);
        expect(await post(`/save_spreadsheet_cell?channel=${chan}&spreadsheet_id=${sheetId}&cell_id=A1&value=hacked`)).toEqual(refused);

        // Reading goes on, live: the text and the sheet
        await s.owner.locator(`[data-block-id="${text}"] .content`).click();
        await s.owner.keyboard.press('End');
        await s.owner.keyboard.type(' world');
        await expect(textEl).toHaveText('Hello world', { timeout: 5000 });
        await editSpreadsheetCell(s.owner, sheet, 'A1', 'from owner');
        await waitForSpreadsheetCellValue(b.page, sheet, 'A1', 'from owner');

        // Timeout lifted: B edits again, the owner sees it
        await api(s.owner, `/remove_timeout?server_id=${s.serverId}&account_id=${b.id}`);
        await expect(editor).not.toHaveClass(/read-only/);
        await editSpreadsheetCell(b.page, sheet, 'A2', 'from b');
        await waitForSpreadsheetCellValue(s.owner, sheet, 'A2', 'from b');
        await textEl.click();
        await b.page.keyboard.press('End');
        await b.page.keyboard.type('!');
        await expect(s.owner.locator(`[data-block-id="${text}"] .content`)).toHaveText('Hello world!', { timeout: 5000 });

        // A timeout that runs out ends by itself: the note is editable again without a reload
        // (its end as the client knows it: the server's own ending is the check above)
        await b.page.evaluate((sid) => window.applyTimeoutState(sid, new Date(Date.now() + 2000).toString()), s.serverId);
        await expect(editor).toHaveClass(/read-only/);
        await expect(editor).not.toHaveClass(/read-only/, { timeout: 5000 });
        await s.close();
    });

    test('the server refuses what a member may not write', async ({ browser }) => {
        const s = await setupServer(browser, 'notes_refuse', 2);
        const [b, c] = s.members;   // B may edit, C may only read
        const chan = await createChannel(s.owner, s.serverId, 'note');
        await setPerm(s.owner, chan, `accountId=${b.id}`, 'edit-notes', 'allow', 'note');
        await setPerm(s.owner, chan, `accountId=${c.id}`, 'edit-notes', 'deny', 'note');
        await openNote(s.owner, s.serverId, chan);
        const o = randomUUID();
        const set = (client, k, extra = {}) => ({ c: client, k, o, t: 'set', f: 'type', v: 'text', ...extra });

        // Read-only member
        expect(await push(c.page, chan, { client: 777, ops: [set(777, 1)] })).toBe(403);
        // A client id belongs to the account that used it first
        expect(await push(b.page, chan, { client: 4242, ops: [set(4242, 1)] })).toBe(200);
        expect(await push(s.owner, chan, { client: 4242, ops: [set(4242, 50)] })).toBe(403);
        // Each operation is judged on its own: the refused ones come back in `rejected`, the
        // others are stored. An operation must carry the sender's client id, with increasing clocks
        const refused = (...clocks) => ({ status: 200, rejected: clocks });
        expect(await pushResult(b.page, chan, { client: 4242, ops: [set(999, 60)] })).toEqual(refused(60));
        expect(await pushResult(b.page, chan, { client: 4242, ops: [set(4242, 61), set(4242, 61)] })).toEqual(refused(61));
        // A clock far ahead (it would win every conflict)
        expect(await pushResult(b.page, chan, { client: 4242, ops: [set(4242, 10_000_000)] })).toEqual(refused(10_000_000));
        // References only to stored operations: a parent nobody wrote yet
        const ins = (k, p, x = 'x') => ({ c: 4242, k, o, t: 'ins', p, s: 'R', x });
        expect(await pushResult(b.page, chan, { client: 4242, ops: [ins(70, [5555, 3])] })).toEqual(refused(70));
        // Unknown fields and values
        expect(await pushResult(b.page, chan, { client: 4242, ops: [set(4242, 71, { f: 'content' })] })).toEqual(refused(71));
        expect(await pushResult(b.page, chan, { client: 4242, ops: [set(4242, 72, { v: 'text" onmouseover="x' })] })).toEqual(refused(72));
        // Half of an emoji is not text; a delete wider than the limit costs every browser
        expect(await pushResult(b.page, chan, { client: 4242, ops: [ins(73, null, '\udc4d\ud83d')] })).toEqual(refused(73));
        expect(await pushResult(b.page, chan, { client: 4242, ops: [{ c: 4242, k: 74, o, t: 'del', r: [[4242, 1, 200000]] }] })).toEqual(refused(74));
        // A request heavier than the limit, as a whole
        const heavy = Array.from({ length: 11 }, (_, i) => ins(1000 + i * 100_000, null, 'y'.repeat(100_000)));
        expect(await push(b.page, chan, { client: 4242, ops: heavy })).toBe(400);
        // The same batch twice: stored once
        const batch = { client: 4242, ops: [set(4242, 80, { f: 'deleted', v: false })] };
        expect(await push(b.page, chan, batch)).toBe(200);
        expect(await push(b.page, chan, batch)).toBe(200);
        // In one batch: what refers to a refused operation is refused too, the rest is stored;
        // sent again (its answer lost), the same ones are refused again
        const mixed = { client: 4242, ops: [ins(90, null, 'ab'), ins(92, [5555, 1]), ins(93, [4242, 91]), ins(94, [4242, 92])] };
        expect(await pushResult(b.page, chan, mixed)).toEqual(refused(92, 94));
        expect(await pushResult(b.page, chan, mixed)).toEqual(refused(92, 94));
        const ops = await s.owner.evaluate((id) => fetch(`/note_sync?channel=${id}&after=0`).then((r) => r.json()).then((d) => d.ops), chan);
        expect(ops.filter((op) => op.c === 4242).map((op) => op.k)).toEqual([1, 61, 80, 90, 93]);
        // seq has no gap
        expect(ops.map((op) => op.seq)).toEqual(ops.map((_, i) => i + 1));
        await s.close();
    });
});
