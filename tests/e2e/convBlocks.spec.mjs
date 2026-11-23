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
 * Picks a block in the picker (`category`: a picker column, see BLOCK_CATEGORIES in
 * static/conv-blocks.mjs; `optionName`: the visible name of the option) and waits for
 * the picker to close.
 */
async function pickBlock(page, { category, optionName }) {
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
}

/** Inserts a spreadsheet block and waits for its sheet to load. Returns its uuid. */
async function insertSheetViaUi(page, option) {
    const before = await page.locator('.conv-spreadsheet-container[data-block-id]').count();
    await pickBlock(page, option);

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

/** Inserts a tricount / checklist block. Returns the locator of the rendered block. */
async function insertBlockViaUi(page, option, cssType) {
    const blocks = page.locator(`.conv-block.cb-${cssType}`);
    const before = await blocks.count();
    await pickBlock(page, option);
    await expect.poll(() => blocks.count(), { timeout: 15000 }).toBe(before + 1);
    const uuid = await blocks.last().getAttribute('data-block-uuid');
    expect(uuid).toBeTruthy();
    return page.locator(`.conv-block[data-block-uuid="${uuid}"]`);
}

/** Fills and submits the "add an expense" form of a tricount block. */
async function addExpense(block, { label, amount, payer, splitWith }) {
    await block.locator('.cb-add').click();
    const form = block.locator('form.cb-form[data-form="new"]');
    await form.locator('input[name="label"]').fill(label);
    await form.locator('input[name="amount"]').fill(amount);
    if (payer) await form.locator('select[name="payer"]').selectOption({ label: payer });
    if (splitWith) {
        for (const chip of await form.locator('.cb-split-chip').all()) {
            const name = (await chip.textContent()).trim();
            const box = chip.locator('input');
            if (splitWith.includes(name) !== await box.isChecked()) await chip.click();
        }
    }
    await form.locator('button[type="submit"]').click();
    await expect(form).toHaveCount(0, { timeout: 10000 });
}

async function addParticipant(block, name) {
    await block.locator('.cb-tab').nth(2).click();
    const input = block.locator('input[data-keep="person-new"]');
    await input.fill(name);
    await input.press('Enter');
    await expect(block.locator('.cb-person input').last()).toHaveValue(name, { timeout: 10000 });
    await expect(input).toHaveValue('');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Conversation blocks — E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('Picker: categories, search, and the empty state', async ({ page }) => {
        await loginUser(page, `e2e_block_pick_${Date.now()}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        await openBlockPicker(page);
        const picker = page.locator('#create-block');
        await expect(picker.locator('.block-option-group[data-for="featured"] .block-option')
            .filter({ hasText: 'Tricount' })).toBeVisible();

        await picker.locator('.block-cat-item[data-cat="games"]').click();
        await expect(picker.locator('.block-option-group[data-for="games"] .block-option')
            .filter({ hasText: 'Scoreboard' })).toBeVisible();

        // Search spans every category, each block listed once (Checklist is the To-do list)
        await picker.locator('.block-picker-search').fill('list');
        const results = picker.locator('.block-option-group[data-for="search"] .block-option-name');
        await expect(results).toHaveText(['Shopping list', 'To-do list']);
        await picker.locator('.block-picker-search').fill('zzzz');
        await expect(picker.locator('.block-picker-empty')).toBeVisible();
        await picker.locator('.block-picker-search').fill('');
        await expect(picker.locator('.block-option-group[data-for="games"]')).toBeVisible();
    });

    test('Tricount in a channel: participants, expenses, balances, settling up, reload', async ({ page }) => {
        await loginUser(page, `e2e_block_${Date.now()}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);
        const channelId = await page.evaluate(() => window.global?.state?.activeConv);
        expect(channelId).toBeTruthy();

        const block = await insertBlockViaUi(page, { category: 'featured', optionName: 'Tricount' }, 'tricount');
        await expect(block.locator('.cb-empty')).toBeVisible();

        // In a channel only the author is a participant: add two friends by name
        await addParticipant(block, 'Camille');
        await addParticipant(block, 'Sam');
        await expect(block.locator('.cb-person input')).toHaveCount(3);

        await block.locator('.cb-tab').first().click();
        await addExpense(block, { label: 'Groceries', amount: '45' });   // paid by me, split between all
        await addExpense(block, { label: 'Train <b>', amount: '30,50', payer: 'Camille', splitWith: ['Camille', 'Sam'] });

        // Newest first; user input is shown as text
        await expect(block.locator('.cb-row-title')).toHaveText(['Train <b>', 'Groceries']);
        await expect(block.locator('.cb-head .cb-sub')).toHaveText('3 participants · 2 expenses');
        await expect(block.locator('.cb-stat').first()).toContainText('75.50');
        // me: paid 45, my share 15 → I'm owed 30
        await expect(block.locator('.cb-stat.optional .cb-stat-value')).toHaveText('15.00 €');
        await expect(block.locator('.cb-stat.positive .cb-stat-value')).toHaveText('30.00 €');
        await expect(block.locator('.cb-stack .cb-avatar')).toHaveCount(3);

        // Balances: me +30, Camille +30.50-15-15.25 = +0.25, Sam -15-15.25 = -30.25
        await block.locator('.cb-tab').nth(1).click();
        await expect(block.locator('.cb-balance .cb-amount')).toHaveText([/\+30\.00/, /\+0\.25/, /−30\.25/]);
        // Sam owes me 30 (mine: highlighted, "Mark as received"), Sam owes Camille 0.25
        await expect(block.locator('.cb-settle')).toHaveCount(2);
        await expect(block.locator('.cb-settle.mine .cb-settle-text')).toHaveText('Sam owes you 30.00 €');
        await expect(block.locator('.cb-settle').nth(1).locator('.cb-settle-text')).toHaveText('Sam owes 0.25 € to Camille');

        // Settling posts a reimbursement and the suggestion goes away
        await block.locator('.cb-settle.mine .btn').click();
        await expect(block.locator('.cb-settle')).toHaveCount(1, { timeout: 10000 });

        // A participant with expenses can't be removed
        await block.locator('.cb-tab').nth(2).click();
        await expect(block.locator('.cb-person .cb-icon-btn').nth(1)).toBeDisabled();

        // Renaming the tricount, then everything survives a reload
        await block.locator('.cb-title').fill('Lyon trip');
        await block.locator('.cb-title').press('Enter');
        await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.conv-block.cb-tricount')]
            .pop()?.querySelector('.cb-title')?.value)).toBe('Lyon trip');

        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        await page.locator(`#channel-conv-${channelId}`).click();
        await page.waitForFunction((id) => window.global?.state?.activeConv === id, channelId, { timeout: 10000 });
        const reloaded = page.locator('.conv-block.cb-tricount').last();
        await expect(reloaded.locator('.cb-title')).toHaveValue('Lyon trip', { timeout: 15000 });
        await expect(reloaded.locator('.cb-row-title')).toHaveCount(3);   // 2 expenses + the reimbursement
        await expect(reloaded.locator('.cb-row.transfer')).toHaveCount(1);
    });

    test('Who brings what: add items, take one on, tick it, edit and delete', async ({ page }) => {
        await loginUser(page, `e2e_block_chk_${Date.now()}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        const block = await insertBlockViaUi(page, { category: 'organize', optionName: 'Who brings what?' }, 'checklist');
        const input = block.locator('.cb-check-new input');
        for (const text of ['Chips', 'Wine', 'Cake']) {
            await input.fill(text);
            await input.press('Enter');
            await expect(block.locator('.cb-check-text').last()).toHaveText(text, { timeout: 10000 });
        }
        await expect(block.locator('.cb-check-text')).toHaveText(['Chips', 'Wine', 'Cake']);
        await expect(input).toBeFocused();

        const wine = block.locator('.cb-check:not(.cb-check-new)').nth(1);
        await wine.locator('.cb-claim').click();
        await expect(wine.locator('.cb-claim.taken.mine')).toBeVisible({ timeout: 10000 });
        await wine.locator('.cb-box').click();
        await expect(wine).toHaveClass(/done/);
        await expect(block.locator('.cb-head .cb-sub')).toHaveText('1 of 3 taken · 1 brought');
        await expect(block.locator('.cb-progress')).toHaveText('1/3');
        await expect(wine.locator('.cb-claim.taken.mine')).toContainText('Me');

        // Double-click to rename, Enter to save
        await block.locator('.cb-check-text').first().dblclick();
        const edit = block.locator('input[data-keep^="edit-"]');
        await edit.fill('Chips & dips');
        await edit.press('Enter');
        await expect(block.locator('.cb-check-text').first()).toHaveText('Chips & dips', { timeout: 10000 });

        // Escape leaves the text as it was, nothing is sent
        await block.locator('.cb-check-text').first().dblclick();
        await edit.fill('Not this');
        await edit.press('Escape');
        await expect(edit).toHaveCount(0);
        await expect(block.locator('.cb-check-text').first()).toHaveText('Chips & dips');

        await block.locator('.cb-check:not(.cb-check-new)').last().hover();
        await block.locator('.cb-check:not(.cb-check-new)').last().locator('.cb-icon-btn[title="Delete"]').click();
        await expect(block.locator('.cb-check-text')).toHaveText(['Chips & dips', 'Wine'], { timeout: 10000 });
    });

    test('Ready-made scoreboard: headers and totals', async ({ page }) => {
        await loginUser(page, `e2e_block_score_${Date.now()}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        const blockUuid = await insertSheetViaUi(page, { category: 'games', optionName: 'Scoreboard' });
        const root = convSheetRoot(blockUuid);
        // The sheet sits in a block card whose header names the template
        const card = page.locator('.conv-block.cb-sheet').filter({ has: page.locator(root) });
        await expect(card.locator('.cb-head .cb-title')).toHaveText('Scoreboard');
        expect(String(await getSpreadsheetCellDisplayValue(page, blockUuid, 'B1', root)).trim()).toBe('Player 1');
        expect(await getSpreadsheetCellRawValue(page, blockUuid, 'B8')).toBe('=SUM(B2:B7)');

        await editSpreadsheetCell(page, blockUuid, 'B2', '10', root);
        await editSpreadsheetCell(page, blockUuid, 'B3', '7', root);
        await waitForSpreadsheetCellValue(page, blockUuid, 'B8', '17');
    });

    test('The empty sheet block is inserted blank', async ({ page }) => {
        const suffix = Date.now();
        await loginUser(page, `e2e_block_empty_${suffix}`);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        const blockUuid = await insertSheetViaUi(page, { category: 'empty', optionName: 'Sheet' });
        const root = convSheetRoot(blockUuid);

        // Row 1 must be blank — no template leaks into the empty one
        for (const ref of ['A1', 'B1', 'C1']) {
            expect(await getSpreadsheetCellRawValue(page, blockUuid, ref) ?? '').toBe('');
        }

        // The grid is still usable
        await editSpreadsheetCell(page, blockUuid, 'A1', 'hello', root);
        expect(String(await getSpreadsheetCellDisplayValue(page, blockUuid, 'A1', root)).trim()).toBe('hello');

        // A row added but refused by the server: the sheet goes back to what is stored
        const rows = await page.evaluate((uuid) => window.global.state.spreadsheetViews[uuid].rows, blockUuid);
        await page.route('**/save_spreadsheet_structure?*', (route) => route.fulfill({ status: 403, body: '' }));
        await page.evaluate((uuid) => window.global.state.spreadsheetViews[uuid].applyStructureOperation('add-row-top', 'A1'), blockUuid);
        await expect.poll(() => page.evaluate((uuid) => {
            const v = window.global.state.spreadsheetViews[uuid];
            return [v.rows, v.cells.A1 ?? null, v.cells.A2 ?? null];
        }, blockUuid)).toEqual([rows, 'hello', null]);
        await expect(page.locator(`${root} .sheet-cell[data-ref="A1"] .sheet-cell-content`)).toHaveText('hello');
    });

    test('A tricount in a private conversation: both members are in it, and see each other\'s expenses live', async ({ browser }) => {
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

        // 2) A inserts a tricount: both members are participants
        const block = await insertBlockViaUi(page, { category: 'money', optionName: 'Tricount' }, 'tricount');
        const uuid = await block.getAttribute('data-block-uuid');
        await block.locator('.cb-tab').nth(2).click();
        await expect(block.locator('.cb-person .cb-chip')).toHaveCount(2);   // both tagged "member"
        await block.locator('.cb-tab').first().click();
        await addExpense(block, { label: 'Taxi', amount: '20' });

        // 3) B sees it, and A sees B's expense without reloading
        const contextB = await browser.newContext();
        const pageB = await contextB.newPage();
        await loginUser(pageB, accountB);
        await waitForAppReady(pageB);
        await openPrivateConversation(pageB, convId);
        const blockB = pageB.locator(`.conv-block[data-block-uuid="${uuid}"]`);
        await expect(blockB.locator('.cb-row-title')).toHaveText(['Taxi'], { timeout: 15000 });
        await expect(blockB.locator('.cb-stat.negative .cb-stat-value')).toHaveText('10.00 €');

        await addExpense(blockB, { label: 'Dinner', amount: '60' });
        await expect(block.locator('.cb-row-title')).toHaveText(['Dinner', 'Taxi'], { timeout: 15000 });
        // A: paid 20, owes 10 + 30 → owes 20
        await expect(block.locator('.cb-stat.negative .cb-stat-value')).toHaveText('20.00 €', { timeout: 15000 });

        await contextB.close();
        await context.close();
    });

    test('A change made on an outdated block is redone on the new one, or refused', async ({ page }) => {
        await loginUser(page, `e2e_block_conflict_${Date.now()}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        // Someone's change lands while ours is on its way: `meanwhile` makes it through
        // the API before our request goes, which then carries an outdated version
        const api = (endpoint, body) => page.request.post(`/${endpoint}`, { data: body });
        const racing = (endpoint, meanwhile) => page.route(`**/${endpoint}`, async route => {
            await meanwhile();
            await route.continue();
        }, { times: 1 });

        // 1) Taking on an item renamed meanwhile: the block is reloaded, the item taken on
        const list = await insertBlockViaUi(page, { category: 'organize', optionName: 'Who brings what?' }, 'checklist');
        const listUuid = await list.getAttribute('data-block-uuid');
        const input = list.locator('input[data-keep="new-item"]');
        await input.fill('Chips');
        await input.press('Enter');
        const row = list.locator('.cb-check').first();
        await expect(row.locator('.cb-check-text')).toHaveText('Chips', { timeout: 10000 });
        const itemId = Number((await row.locator('.cb-box').getAttribute('onclick')).match(/, (\d+),/)[1]);

        await racing('edit_conv_block_item', () => api('edit_conv_block_item',
            { block_uuid: listUuid, item_id: itemId, data: { text: 'Crisps' } }));
        await row.locator('.cb-claim').click();
        await expect(row.locator('.cb-claim.taken.mine')).toBeVisible({ timeout: 10000 });
        await expect(row.locator('.cb-check-text')).toHaveText('Crisps');

        // 2) Removing a participant who got an expense meanwhile: refused, they stay
        const tricount = await insertBlockViaUi(page, { category: 'money', optionName: 'Tricount' }, 'tricount');
        const tricountUuid = await tricount.getAttribute('data-block-uuid');
        await addParticipant(tricount, 'Camille');
        const state = await (await page.request.get(`/get_conv_block?block_uuid=${tricountUuid}`)).json();
        const camille = state.settings.participants.find(p => p.name === 'Camille');

        await racing('edit_conv_block', () => api('add_conv_block_item', {
            block_uuid: tricountUuid, data: { label: 'Taxi', amount: 1200, payer: camille.id, split: [camille.id] } }));
        await tricount.locator('.cb-person').nth(1).locator('.cb-icon-btn').click();
        await expect(page.locator('#ui-dialog .ui-dialog-message'))
            .toHaveText('This participant still has expenses', { timeout: 10000 });
        await page.locator('#ui-dialog .ui-dialog-confirm').click();
        await expect(tricount.locator('.cb-person input')).toHaveCount(2);
    });
});
