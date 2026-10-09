import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { createServerViaUi, openServerFromSidebarById } from './helpers/serverHelpers.mjs';
import {
    createNoteChannelViaUi,
    createSpreadsheetBlock,
    editSpreadsheetCell,
    openNoteChannel,
    reloadAndNavigateToNoteChannel,
    waitForNoteChannelLoaded,
} from './helpers/workspaceHelpers.mjs';

const TEST_TIMEOUT = 120000;

// The cell's rendered content div, where alignment (justify-content) and
// rounded decimals end up.
const content = (uuid, ref) => `#sheet-${uuid} .sheet-cell[data-ref="${ref}"] .sheet-cell-content`;

test.describe('Spreadsheet cell formatting', () => {
    test.setTimeout(TEST_TIMEOUT);

    // Regression: the local row/column shift only carried color/bg formats, so an
    // alignment- or decimals-only cell lost its format on screen until a reload
    // (the backend kept it).
    test('align/decimals-only formats follow an inserted row', async ({ page }) => {
        await loginUser(page, `e2esheetfmt_${Date.now()}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);
        const channelId = await createNoteChannelViaUi(page);
        await openNoteChannel(page, channelId);
        await waitForNoteChannelLoaded(page, channelId);
        const uuid = await createSpreadsheetBlock(page, channelId);

        await editSpreadsheetCell(page, uuid, 'A1', 'x');
        await editSpreadsheetCell(page, uuid, 'B1', '1.5');
        await page.evaluate((uuid) => {
            const view = window.global.state.spreadsheetViews[uuid];
            view.setCellFormat('A1', {align: 'center'});
            view.setCellFormat('B1', {decimals: 2});
        }, uuid);
        await expect(page.locator(content(uuid, 'B1'))).toHaveText('1.50');
        await page.waitForTimeout(500);   // let the format saves land before the shift

        // "Add row above" on row 1: everything moves down to row 2
        await page.evaluate((uuid) => {
            window.global.state.spreadsheetViews[uuid].applyStructureOperation('add-row-top', 'A1');
        }, uuid);

        const formats = await page.evaluate((uuid) =>
            window.global.state.spreadsheetViews[uuid].cellFormats, uuid);
        expect(formats.A2?.align).toBe('center');
        expect(formats.B2?.decimals).toBe(2);
        await expect(page.locator(content(uuid, 'A2'))).toHaveCSS('justify-content', 'center');
        await expect(page.locator(content(uuid, 'B2'))).toHaveText('1.50');

        // And the backend agrees after a reload
        await page.waitForTimeout(500);   // let the structure save land
        await reloadAndNavigateToNoteChannel(page, serverId, channelId, uuid);
        await expect(page.locator(content(uuid, 'A2'))).toHaveCSS('justify-content', 'center');
        await expect(page.locator(content(uuid, 'B2'))).toHaveText('1.50');
    });
});
