import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { createServerViaUi, openServerFromSidebarById } from './helpers/serverHelpers.mjs';
import {
    acceptFriendRequestFromUsername,
    disconnectViaUi,
    getPrivateConversationIdWithUsername,
    openFriendsArea,
    openPrivateConversation,
    reloadAndWaitForApp,
    sendFriendRequestToUsername,
} from './helpers/messagingHelpers.mjs';
import {
    convSheetRoot,
    editSpreadsheetCell,
    getSpreadsheetCellDisplayValue,
    getSpreadsheetCellRawValue,
    waitForSpreadsheetCellValue,
    waitForSpreadsheetLoaded,
} from './helpers/workspaceHelpers.mjs';

const TEST_TIMEOUT = 120000;

// The tricount template pre-fills row 1 (see the conv_block branch of send_message).
const TRICOUNT_HEADERS = { A1: 'Name', B1: 'Amount', C1: 'Paid By' };

// ─── UI helpers ───────────────────────────────────────────────────────────────

/**
 * Opens the block picker from the chat composer plus-menu.
 * Works for both server channels and private conversations — the composer markup
 * is identical in server-channel.html and conversation.html.
 */
async function openBlockPicker(page) {
    await page.locator('.chat-input .icon-wrapper[onclick*="chat-plus-menu"]').click();
    await page.locator('#chat-plus-menu').waitFor({ state: 'visible', timeout: 5000 });

    await page.locator('#chat-plus-menu .item[onclick*="create-block"]').click();
    await page.locator('#create-block').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Inserts a block through the picker UI and waits for the resulting message to
 * render AND for its spreadsheet view to finish loading.
 *
 * `category` is the picker column ('featured' | 'empty'); `optionName` is the
 * visible label of the block option inside that category.
 *
 * Returns the block uuid, read back from the rendered message.
 */
async function insertConvBlockViaUi(page, { category, optionName }) {
    const before = await page.locator('.conv-spreadsheet-container[data-block-id]').count();

    await openBlockPicker(page);

    // 'featured' is selected by default; switching is what exercises selectBlockCategory()
    if (category !== 'featured') {
        await page.locator(`#create-block .block-cat-item[data-cat="${category}"]`).click();
        await expect(page.locator(`#create-block .block-option-group[data-for="${category}"]`))
            .toBeVisible({ timeout: 5000 });
    }

    await page.locator(`#create-block .block-option-group[data-for="${category}"] .block-option`)
        .filter({ hasText: optionName })
        .click();

    await page.locator('#create-block').waitFor({ state: 'hidden', timeout: 10000 });

    // The message is appended by the XHR onload, then mounted on the next frame
    await expect
        .poll(() => page.locator('.conv-spreadsheet-container[data-block-id]').count(), { timeout: 15000 })
        .toBe(before + 1);

    const blockUuid = await page.locator('.conv-spreadsheet-container[data-block-id]')
        .last()
        .getAttribute('data-block-id');
    expect(blockUuid).toBeTruthy();

    await waitForSpreadsheetLoaded(page, blockUuid, convSheetRoot(blockUuid));
    return blockUuid;
}

/**
 * Asserts the tricount header row is present, both in the DOM and in the view state.
 */
async function expectTricountHeaders(page, blockUuid) {
    const root = convSheetRoot(blockUuid);
    for (const [ref, expected] of Object.entries(TRICOUNT_HEADERS)) {
        const shown = await getSpreadsheetCellDisplayValue(page, blockUuid, ref, root);
        expect(String(shown).trim()).toBe(expected);
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Conversation blocks — E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('Insert a tricount block in a channel: headers, cell edits, formula, reload persistence', async ({ page }) => {
        const suffix = Date.now();
        await loginUser(page, `e2e_block_${suffix}`);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        const channelId = await page.evaluate(() => window.global?.state?.activeConv);
        expect(channelId).toBeTruthy();

        // ── 1. Insert the tricount block ──────────────────────────────────────
        const blockUuid = await insertConvBlockViaUi(page, { category: 'featured', optionName: 'Tricount' });
        const root = convSheetRoot(blockUuid);

        // ── 2. The template pre-filled the header row ─────────────────────────
        await expectTricountHeaders(page, blockUuid);

        // ── 3. Fill in two expenses and a total formula ───────────────────────
        await editSpreadsheetCell(page, blockUuid, 'A2', 'Pizza', root);
        await editSpreadsheetCell(page, blockUuid, 'B2', '30', root);
        await editSpreadsheetCell(page, blockUuid, 'A3', 'Drinks', root);
        await editSpreadsheetCell(page, blockUuid, 'B3', '12', root);
        await editSpreadsheetCell(page, blockUuid, 'B4', '=B2+B3', root);

        await waitForSpreadsheetCellValue(page, blockUuid, 'B4', '42');

        // The raw value stays the formula, the display shows the result
        expect(await getSpreadsheetCellRawValue(page, blockUuid, 'B4')).toBe('=B2+B3');
        expect(String(await getSpreadsheetCellDisplayValue(page, blockUuid, 'B4', root)).trim()).toBe('42');

        // ── 4. Reload and verify the block and its data survive ───────────────
        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        await page.locator(`#channel-conv-${channelId}`).click();
        await page.waitForFunction((id) => window.global?.state?.activeConv === id, channelId, { timeout: 10000 });

        await waitForSpreadsheetLoaded(page, blockUuid, root);
        await expectTricountHeaders(page, blockUuid);

        expect(String(await getSpreadsheetCellDisplayValue(page, blockUuid, 'A2', root)).trim()).toBe('Pizza');
        expect(await getSpreadsheetCellRawValue(page, blockUuid, 'B4')).toBe('=B2+B3');
        await waitForSpreadsheetCellValue(page, blockUuid, 'B4', '42');
    });

    test('The empty sheet block is inserted without tricount headers', async ({ page }) => {
        const suffix = Date.now();
        await loginUser(page, `e2e_block_empty_${suffix}`);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        const blockUuid = await insertConvBlockViaUi(page, { category: 'empty', optionName: 'Sheet' });
        const root = convSheetRoot(blockUuid);

        // Row 1 must be blank — the tricount template must not leak into the empty one
        for (const ref of Object.keys(TRICOUNT_HEADERS)) {
            expect(await getSpreadsheetCellRawValue(page, blockUuid, ref) ?? '').toBe('');
        }

        // The grid is still usable
        await editSpreadsheetCell(page, blockUuid, 'A1', 'hello', root);
        expect(String(await getSpreadsheetCellDisplayValue(page, blockUuid, 'A1', root)).trim()).toBe('hello');
    });

    test('A tricount block inserted in a private conversation is visible to both members', async ({ browser }) => {
        const suffix = Date.now();
        const accountA = `e2e_blk_a_${suffix}`;
        const accountB = `e2e_blk_b_${suffix}`;

        const context = await browser.newContext();
        const page = await context.newPage();

        // 1) Create both accounts and befriend them
        await loginUser(page, accountA);
        await waitForAppReady(page);
        const usernameA = await page.evaluate(() => window.global?.user?.username);
        expect(usernameA).toBeTruthy();
        await disconnectViaUi(page);

        await loginUser(page, accountB);
        await waitForAppReady(page);
        const usernameB = await page.evaluate(() => window.global?.user?.username);
        expect(usernameB).toBeTruthy();
        await openFriendsArea(page);
        await sendFriendRequestToUsername(page, usernameA);
        await disconnectViaUi(page);

        await loginUser(page, accountA);
        await waitForAppReady(page);
        await openFriendsArea(page);
        await acceptFriendRequestFromUsername(page, usernameB);
        await reloadAndWaitForApp(page);

        const convId = await getPrivateConversationIdWithUsername(page, usernameB);
        expect(convId).toBeGreaterThan(0);
        await openPrivateConversation(page, convId);

        // 2) Insert a tricount block in the DM and fill one row
        const blockUuid = await insertConvBlockViaUi(page, { category: 'featured', optionName: 'Tricount' });
        const root = convSheetRoot(blockUuid);
        await expectTricountHeaders(page, blockUuid);
        await editSpreadsheetCell(page, blockUuid, 'A2', 'Taxi', root);

        // 3) The other member sees the same block with the same content
        const contextB = await browser.newContext();
        const pageB = await contextB.newPage();
        await loginUser(pageB, accountB);
        await waitForAppReady(pageB);
        await openPrivateConversation(pageB, convId);

        await pageB.locator(`${root} .sheet-table`).waitFor({ state: 'visible', timeout: 15000 });
        await waitForSpreadsheetLoaded(pageB, blockUuid, root);

        await expectTricountHeaders(pageB, blockUuid);
        expect(String(await getSpreadsheetCellDisplayValue(pageB, blockUuid, 'A2', root)).trim()).toBe('Taxi');

        await contextB.close();
        await context.close();
    });
});
