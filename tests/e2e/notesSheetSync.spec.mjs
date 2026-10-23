// Spreadsheets in a notes channel, live between viewers: a sheet keeps its content in its own
// tables (REST, routes/workspaces.py), and every saved change is announced to the note's room
// (note_sheet, relayed like the note's operations by routes/notes_sync.py). A viewer sees
// values, formats, widths and rows added or removed without reopening the note, keeps what
// they are typing, everyone ends on what the database holds even when two people write the
// same cell at once, and a member who lost access to the note gets nothing more.
import { test, expect } from '@playwright/test';
import { setupServer, openServer, createChannel, setChannelPerm as setPerm } from './helpers/permissionHelpers.mjs';
import {
    openNoteChannel, waitForNoteChannelLoaded, createSpreadsheetBlock, editSpreadsheetCell,
    waitForSpreadsheetLoaded, waitForSpreadsheetCellValue, sheetRoot,
} from './helpers/workspaceHelpers.mjs';

const TEST_TIMEOUT = 180000;

/** Open the server and its notes channel, in the note's room. */
async function openNote(page, sid, chan) {
    await openServer(page, sid);
    await openNoteChannel(page, chan);
    await waitForNoteChannelLoaded(page, chan);
    await page.waitForFunction(() => window.global.state.noteEditor?.sync?.joined === true);
}

/** A notes channel with a sheet, opened by the owner and by every member (who may edit it). */
async function sharedSheet(browser, label, n) {
    const s = await setupServer(browser, label, n);
    const chan = await createChannel(s.owner, s.serverId, 'note');
    for (const m of s.members) await setPerm(s.owner, chan, `accountId=${m.id}`, 'edit-notes', 'allow', 'note');
    await openNote(s.owner, s.serverId, chan);
    const sheet = await createSpreadsheetBlock(s.owner, chan);
    for (const m of s.members) {
        await openNote(m.page, s.serverId, chan);
        await waitForSpreadsheetLoaded(m.page, sheet);
    }
    return { s, chan, sheet };
}

/** What a page's view of the sheet holds. */
const viewState = (page, sheet) => page.evaluate((uuid) => {
    const v = window.global.state.spreadsheetViews[uuid];
    return { rows: v.rows, cols: v.cols, cells: v.cells, formats: v.cellFormats, widths: v.colWidths };
}, sheet);

/** What the database holds (the same shape). */
const storedState = (page, chan, sheet) => page.evaluate(async ([id, uuid]) => {
    const d = await fetch(`/get_spreadsheet_content?channel=${id}&block_uuid=${uuid}`).then((r) => r.json());
    return { rows: d.rows, cols: d.cols, cells: d.cells, formats: d.cell_formats, widths: d.col_widths };
}, [chan, sheet]);

/** A sheet state as a string, whatever the order of its keys. */
const canon = (state) => JSON.stringify(state, (key, value) => (value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b)))
    : value));

/** The note_sheet messages a page receives over its WebSocket. */
function recordSheetEvents(page) {
    const events = [];
    page.on('console', (msg) => {
        if (msg.text().includes('"type":"note_sheet"')) events.push(msg.text());
    });
    return events;
}

test.describe('Notes - live spreadsheets', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('values, formats, widths and rows reach the other viewers live', async ({ browser }) => {
        const { s, sheet } = await sharedSheet(browser, 'sheet_live', 1);
        const b = s.members[0].page;

        // The owner's changes come back to it too: arriving while its save is still answering,
        // they are known as its own (no reading the sheet again)
        const reads = [];
        s.owner.on('request', (r) => { if (r.url().includes('get_spreadsheet_content')) reads.push(r.url()); });
        await s.owner.route('**/save_spreadsheet_cell?*', async (route) => {
            const response = await route.fetch();
            await new Promise((r) => setTimeout(r, 1000));   // stored and announced, answered later
            await route.fulfill({ response });
        });
        await editSpreadsheetCell(s.owner, sheet, 'A1', '21');
        await editSpreadsheetCell(s.owner, sheet, 'B1', '=A1*2');
        await waitForSpreadsheetCellValue(b, sheet, 'A1', '21');
        await waitForSpreadsheetCellValue(b, sheet, 'B1', '42');
        await s.owner.waitForFunction((uuid) => window.global.state.spreadsheetViews[uuid]._inFlight === 0, sheet);
        expect(reads).toEqual([]);
        await s.owner.unroute('**/save_spreadsheet_cell?*');
        await expect(b.locator(`${sheetRoot(sheet)} .sheet-cell[data-ref="B1"] .sheet-cell-content`)).toHaveText('42');

        // Emptied cell
        await editSpreadsheetCell(s.owner, sheet, 'B1', '');
        await expect.poll(async () => (await viewState(b, sheet)).cells.B1 ?? null).toBe(null);

        // Format and column width
        await s.owner.evaluate((uuid) => window.global.state.spreadsheetViews[uuid].setCellFormat('A1', { bg: '#1971c233', decimals: 2 }), sheet);
        await expect(b.locator(`${sheetRoot(sheet)} .sheet-cell[data-ref="A1"] .sheet-cell-content`)).toHaveText('21.00');
        await expect.poll(async () => (await viewState(b, sheet)).formats.A1?.bg).toBe('#1971c233');
        await s.owner.evaluate((uuid) => {
            const v = window.global.state.spreadsheetViews[uuid];
            v._setColWidth(0, 300);
            v._persistColumnWidth(0);
        }, sheet);
        await expect.poll(async () => (await viewState(b, sheet)).widths[0]).toBe(300);

        // A row added above: A1 moves down to A2, for B too
        await s.owner.evaluate((uuid) => window.global.state.spreadsheetViews[uuid].applyStructureOperation('add-row-top', 'A1'), sheet);
        await waitForSpreadsheetCellValue(b, sheet, 'A2', '21');
        expect((await viewState(b, sheet)).rows).toBe(4);
        expect(await viewState(b, sheet)).toEqual(await viewState(s.owner, sheet));
        await s.close();
    });

    test('what I am typing in a cell stays while someone else edits the sheet', async ({ browser }) => {
        const { s, sheet } = await sharedSheet(browser, 'sheet_typing', 1);
        const b = s.members[0].page;

        const input = b.locator(`#sheet-input-${sheet}`);
        await b.locator(`${sheetRoot(sheet)} .sheet-cell[data-ref="A2"]`).click();
        await input.waitFor();
        await b.keyboard.type('half');

        // A value elsewhere: shown to B, B's input untouched and still focused
        await editSpreadsheetCell(s.owner, sheet, 'A1', 'from owner');
        await waitForSpreadsheetCellValue(b, sheet, 'A1', 'from owner');
        await expect(b.locator(`${sheetRoot(sheet)} .sheet-cell[data-ref="A1"] .sheet-cell-content`)).toHaveText('from owner');
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('half');

        // A row added above B's cell: B now types in A3, still with its text and caret
        await s.owner.evaluate((uuid) => window.global.state.spreadsheetViews[uuid].applyStructureOperation('add-row-top', 'A1'), sheet);
        await waitForSpreadsheetCellValue(b, sheet, 'A2', 'from owner');
        await expect(input).toBeFocused();
        await expect(input).toHaveValue('half');
        await b.keyboard.type(' done');
        await input.blur();
        await waitForSpreadsheetCellValue(s.owner, sheet, 'A3', 'half done');
        await s.close();
    });

    test("a change saved before I am in the note's room still reaches me (opening, reconnecting)", async ({ browser }) => {
        const s = await setupServer(browser, 'sheet_join', 1);
        const b = s.members[0].page;
        const chan = await createChannel(s.owner, s.serverId, 'note');
        await openNote(s.owner, s.serverId, chan);
        const sheet = await createSpreadsheetBlock(s.owner, chan);

        // B's note_join reaches the server 1.5 s late (a slow socket): B reads the sheet first
        await b.addInitScript(() => {
            const send = WebSocket.prototype.send;
            WebSocket.prototype.send = function (data) {
                if (typeof data === 'string' && data.includes('"note_join"')) {
                    setTimeout(() => send.call(this, data), 1500);
                    return;
                }
                return send.call(this, data);
            };
        });
        // and its reads of the sheet come back late: the server's "read your sheets again", sent
        // when B enters the room, arrives while they are still loading
        let read, release, open = false;
        const sheetRead = new Promise((r) => { read = r; });
        const released = new Promise((r) => { release = () => { open = true; r(); }; });
        await b.route('**/get_spreadsheet_content?*', async (route) => {
            if (open) return route.continue();
            const response = await route.fetch();
            read();
            await released;
            await route.fulfill({ response });
        });
        await openServer(b, s.serverId);
        await openNoteChannel(b, chan);
        await sheetRead;
        await editSpreadsheetCell(s.owner, sheet, 'A1', 'while opening');   // after B's read, before B is in
        await b.waitForTimeout(2000);                                        // B is in the room now
        release();
        await waitForSpreadsheetLoaded(b, sheet);
        await waitForSpreadsheetCellValue(b, sheet, 'A1', 'while opening');

        // The socket drops: what is saved meanwhile reaches B once it is back in the room
        await b.evaluate(() => window.global.state.websocket.close());
        await editSpreadsheetCell(s.owner, sheet, 'A1', 'while away');
        await waitForSpreadsheetCellValue(b, sheet, 'A1', 'while away');
        await s.close();
    });

    test('two people writing the same cells at once end on what the database holds', async ({ browser }) => {
        const { s, chan, sheet } = await sharedSheet(browser, 'sheet_race', 1);
        const b = s.members[0].page;

        // Both write A1 and B1 in quick bursts, at the same time, with a row inserted midway
        const burst = (page, who) => page.evaluate(async ([uuid, name]) => {
            const v = window.global.state.spreadsheetViews[uuid];
            for (let i = 0; i < 15; i++) {
                v.saveEdit(i % 2 ? 'A1' : 'B1', `${name}${i}`);
                if (i === 7 && name === 'owner') v.applyStructureOperation('add-row-top', 'A1');
                await new Promise((r) => setTimeout(r, 15));
            }
        }, [sheet, who]);
        const refused = [];
        b.on('response', (r) => { if (r.url().includes('/save_spreadsheet') && r.status() !== 200) refused.push(r.url()); });
        await Promise.all([burst(s.owner, 'owner'), burst(b, 'b')]);

        // The writes are still landing: once both tabs have nothing on its way, every view is the database
        const settled = (page) => page.waitForFunction((uuid) => {
            const v = window.global.state.spreadsheetViews[uuid];
            return v._inFlight === 0 && !v._stale;
        }, sheet, { timeout: 15000 });
        await Promise.all([settled(s.owner), settled(b)]);
        expect(refused).toEqual([]);
        for (const page of [s.owner, b]) {
            await expect.poll(async () => {
                const [view, stored] = await Promise.all([viewState(page, sheet), storedState(page, chan, sheet)]);
                return canon(view) === canon(stored) ? 'same' : `${canon(view)} != ${canon(stored)}`;
            }, { timeout: 10000 }).toBe('same');
        }
        await s.close();
    });

    test('my edit on its way never flips back to an older value someone else saved', async ({ browser }) => {
        const { s, chan, sheet } = await sharedSheet(browser, 'sheet_older', 1);
        const b = s.members[0].page;

        // B's save is held 2 s on its way: the owner's, sent meanwhile, is stored first
        let release;
        const held = new Promise((r) => { release = r; });
        await b.route('**/save_spreadsheet_cell?*', async (route) => { await held; await route.continue(); });
        await editSpreadsheetCell(b, sheet, 'A1', 'mine');
        await editSpreadsheetCell(s.owner, sheet, 'A1', 'theirs');
        await waitForSpreadsheetCellValue(s.owner, sheet, 'A1', 'theirs');
        // B got the owner's change while its own was on its way: it keeps showing its own
        await expect.poll(() => b.evaluate((uuid) => window.global.state.spreadsheetViews[uuid]._stale, sheet)).toBe(true);
        expect((await viewState(b, sheet)).cells.A1).toBe('mine');
        await expect(b.locator(`${sheetRoot(sheet)} .sheet-cell[data-ref="A1"] .sheet-cell-content`)).toHaveText('mine');

        // B's save lands last: everyone ends on it
        release();
        await waitForSpreadsheetCellValue(s.owner, sheet, 'A1', 'mine');
        expect((await storedState(b, chan, sheet)).cells.A1).toBe('mine');
        await b.waitForFunction((uuid) => window.global.state.spreadsheetViews[uuid]._inFlight === 0, sheet);
        expect((await viewState(b, sheet)).cells.A1).toBe('mine');
        await s.close();
    });

    test('a member who may only read the note sees the changes live and can change nothing', async ({ browser }) => {
        const s = await setupServer(browser, 'sheet_readonly', 1);
        const b = s.members[0].page;   // no edit-notes: a member's default in a notes channel
        const chan = await createChannel(s.owner, s.serverId, 'note');
        await openNote(s.owner, s.serverId, chan);
        const sheet = await createSpreadsheetBlock(s.owner, chan);
        await openNote(b, s.serverId, chan);
        await waitForSpreadsheetLoaded(b, sheet);
        const id = await b.evaluate((uuid) => window.global.state.spreadsheetViews[uuid].id, sheet);

        // Live: values, formats, rows
        await editSpreadsheetCell(s.owner, sheet, 'A1', 'from owner');
        await waitForSpreadsheetCellValue(b, sheet, 'A1', 'from owner');
        await s.owner.evaluate((uuid) => window.global.state.spreadsheetViews[uuid].setCellFormat('A1', { bg: '#1971c233' }), sheet);
        await expect.poll(async () => (await viewState(b, sheet)).formats.A1?.bg).toBe('#1971c233');
        await s.owner.evaluate((uuid) => window.global.state.spreadsheetViews[uuid].applyStructureOperation('add-row-top', 'A1'), sheet);
        await waitForSpreadsheetCellValue(b, sheet, 'A2', 'from owner');

        // The sheet offers no editing: no cell editor, no cell menu, no column resize
        const cell = b.locator(`${sheetRoot(sheet)} .sheet-cell[data-ref="A2"]`);
        await cell.click();
        await cell.click({ button: 'right' });
        await b.locator(`${sheetRoot(sheet)} .sheet-col-resizer`).first().dispatchEvent('mousedown', { clientX: 100 });
        await expect(b.locator(`#sheet-input-${sheet}`)).toHaveCount(0);
        await expect(b.locator('.sheet-context-menu')).toHaveCount(0);
        expect(await b.evaluate((uuid) => window.global.state.spreadsheetViews[uuid].isResizingCol, sheet)).toBe(false);

        // The server refuses every write, whatever the page sends
        const post = (path) => b.evaluate(async (p) => (await fetch(p, { method: 'POST' })).status, path);
        const base = `channel=${chan}&spreadsheet_id=${id}`;
        expect(await post(`/save_spreadsheet_cell?${base}&cell_id=A2&value=hacked`)).toBe(403);
        expect(await post(`/save_spreadsheet_cell_format?${base}&cell_id=A2&bg_color=%23e03131`)).toBe(403);
        expect(await post(`/save_spreadsheet_col_width?${base}&col_idx=0&width=500`)).toBe(403);
        expect(await post(`/save_spreadsheet_structure?${base}&op=delete-row&ref=A2`)).toBe(403);
        expect(await post(`/save_spreadsheet?${base}&data=${encodeURIComponent('{"rows":1}')}`)).toBe(403);

        // A write forced from the page is undone: the sheet goes back to what is stored
        await b.evaluate((uuid) => window.global.state.spreadsheetViews[uuid].saveEdit('A2', 'hacked'), sheet);
        await waitForSpreadsheetCellValue(b, sheet, 'A2', 'from owner');
        const stored = await storedState(s.owner, chan, sheet);
        expect([stored.rows, stored.cells.A2, stored.formats.A2?.bg, stored.widths[0]]).toEqual([4, 'from owner', '#1971c233', undefined]);
        expect(canon(await viewState(b, sheet))).toBe(canon(stored));
        await s.close();
    });

    test('a member who can no longer view the note gets no more sheet changes', async ({ browser }) => {
        const { s, chan, sheet } = await sharedSheet(browser, 'sheet_rights', 1);
        const b = s.members[0];
        await editSpreadsheetCell(s.owner, sheet, 'A1', 'before');
        await waitForSpreadsheetCellValue(b.page, sheet, 'A1', 'before');

        await setPerm(s.owner, chan, `accountId=${b.id}`, 'view-channels', 'deny', 'note');
        const events = recordSheetEvents(b.page);
        // The room trusts a socket's right for RIGHTS_TTL (10 s) before checking it again
        await b.page.waitForTimeout(10500);
        await editSpreadsheetCell(s.owner, sheet, 'A1', 'secret');
        await waitForSpreadsheetCellValue(s.owner, sheet, 'A1', 'secret');
        await b.page.waitForTimeout(1500);
        expect(events).toEqual([]);
        await s.close();
    });
});
