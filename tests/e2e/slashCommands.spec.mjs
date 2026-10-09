import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { createServerViaUi, openServerFromSidebarById } from './helpers/serverHelpers.mjs';
import {
    acceptFriendRequestFromUsername,
    getPrivateConversationIdWithUsername,
    openFriendsArea,
    openPrivateConversation,
    reloadAndWaitForApp,
    sendFriendRequestToUsername,
} from './helpers/messagingHelpers.mjs';

const TEST_TIMEOUT = 120000;
const SHRUG = '¯\\_(ツ)_/¯';
const TABLEFLIP = '(╯°□°)╯︵ ┻━┻';

const composer = page => page.locator('.chat-input textarea.selected');
const slashMenu = page => page.locator('.slash-autocomplete');

// Uncaught errors (e.g. "reading 'push'" when a conv lost its messageGroups) fail the test
function trackPageErrors(page) {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    return errors;
}

async function typeInComposer(page, text) {
    await composer(page).click();
    await page.keyboard.type(text);
}

async function lastMessageBody(page) {
    return page.locator('.message .mdBlock').last().innerText();
}

/** Parses "a lancé 2d6 et a obtenu 9 (4 + 5)." from the last system notice. */
async function lastDiceNotice(page) {
    const notice = page.locator('.system-message').last();
    await expect(notice).toBeVisible({ timeout: 10000 });
    return {
        text: await notice.locator('.system-text').innerText(),
        total: Number(await notice.locator('.system-text > b:not(.system-actor)').innerText()),
    };
}

test.describe('Slash commands — E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('Menu, text commands, dice rolls and validation in a server channel', async ({ page }) => {
        const errors = trackPageErrors(page);
        const suffix = Date.now();
        await loginUser(page, `e2e_slash_${suffix}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);
        const channelId = await page.evaluate(() => window.global?.state?.activeConv);

        // ── "/" opens the list, typing filters it ───────────────────────────
        await typeInComposer(page, '/');
        await expect(slashMenu(page)).toBeVisible();
        await expect(slashMenu(page).locator('.mention-ac-item')).toHaveCount(4);
        // Like the @ menu: in the composer column, right above the input
        const [menuBox, inputBox] = [await slashMenu(page).boundingBox(), await page.locator('.chat-input').boundingBox()];
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(inputBox.y + 1);
        expect(menuBox.y + menuBox.height).toBeGreaterThan(inputBox.y - 40);
        expect(menuBox.x).toBeGreaterThanOrEqual(inputBox.x - 20);
        await page.keyboard.type('sh');
        await expect(slashMenu(page).locator('.mention-ac-item')).toHaveCount(1);
        await expect(slashMenu(page).locator('.mention-ac-name')).toContainText('/shrug');

        // Enter on a partial name completes it, a second Enter sends the emoji alone
        await page.keyboard.press('Enter');
        await expect(composer(page)).toHaveValue('/shrug ');
        await expect(slashMenu(page)).toHaveCount(0);
        await page.keyboard.press('Enter');
        await expect.poll(() => lastMessageBody(page)).toBe(SHRUG);

        // A fully typed command is sent right away, and text is kept before the emoji
        await typeInComposer(page, '/tableflip');
        await page.keyboard.press('Enter');
        await expect.poll(() => lastMessageBody(page)).toBe(TABLEFLIP);
        await typeInComposer(page, '/tableflip hello');
        await page.keyboard.press('Enter');
        await expect.poll(() => lastMessageBody(page)).toBe(`hello ${TABLEFLIP}`);

        // ── /d: Enter twice rolls the preselected d20 ───────────────────────
        await typeInComposer(page, '/d');
        await page.keyboard.press('Enter');
        await expect(composer(page)).toHaveValue('/d ');
        await expect(slashMenu(page).locator('.slash-arg-chip.selected')).toHaveText('d20');
        await expect(slashMenu(page).locator('.slash-arg-preview')).toContainText('d20');
        await page.keyboard.press('Enter');
        // The command stays visible as a regular message, followed by the notice
        await expect.poll(() => lastMessageBody(page)).toBe('/d 20');
        let roll = await lastDiceNotice(page);
        expect(roll.text).toContain('1d20');
        expect(roll.total).toBeGreaterThanOrEqual(1);
        expect(roll.total).toBeLessThanOrEqual(20);
        await expect(composer(page)).toHaveValue('');

        // ── NdF notation, typed directly ────────────────────────────────────
        await typeInComposer(page, '/d 2d6');
        await expect(slashMenu(page).locator('.slash-arg-chip.selected')).toHaveText('2d6');
        await page.keyboard.press('Enter');
        await expect(page.locator('.system-message')).toHaveCount(2);
        await expect.poll(() => lastMessageBody(page)).toBe('/d 2d6');
        roll = await lastDiceNotice(page);
        expect(roll.text).toContain('2d6');
        expect(roll.total).toBeGreaterThanOrEqual(2);
        expect(roll.total).toBeLessThanOrEqual(12);
        // Each notice is its own group: no sender header, no grouping with the previous one
        await expect(page.locator('.message-group.system-message .first-message')).toHaveCount(0);

        // ── Invalid values are blocked client-side ─────────────────────────
        await typeInComposer(page, '/d 1');
        await expect(slashMenu(page).locator('.slash-arg-preview.error')).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(composer(page)).toHaveValue('/d 1');
        await page.keyboard.press('Escape');
        await expect(slashMenu(page)).toHaveCount(0);
        await composer(page).fill('');

        // ── ...and server-side ─────────────────────────────────────────────
        const status = await page.evaluate(async (conv) => {
            const send = async (command) => (await fetch(
                `/send_message?conv=${encodeURI(JSON.stringify({id: conv}))}&content=should-not-exist`,
                {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({command})}
            )).status;
            return {
                tooManyFaces: await send({name: 'dice', count: 1, faces: 5000}),
                tooManyDice: await send({name: 'dice', count: 21, faces: 6}),
                notANumber: await send({name: 'dice', count: 1, faces: 'abc'}),
                unknown: await send({name: 'rm -rf'}),
            };
        }, channelId);
        expect(status).toEqual({tooManyFaces: 400, tooManyDice: 400, notANumber: 400, unknown: 400});

        // System notices can't be edited
        const noticeId = await page.locator('.system-message').last().getAttribute('id');
        const editStatus = await page.evaluate(async (id) => (await fetch(
            `/edit_message?message_id=${id}&content=hacked`, {method: 'POST'})).status, noticeId.replace('message-', ''));
        expect(editStatus).toBe(403);

        // ── Persisted and rendered the same after a reload ─────────────────
        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        await page.locator(`#channel-conv-${channelId}`).click();
        await page.waitForFunction((id) => window.global?.state?.activeConv === id, channelId, { timeout: 10000 });
        await expect(page.locator('.system-message')).toHaveCount(2, { timeout: 10000 });
        expect((await lastDiceNotice(page)).total).toBe(roll.total);
        await expect(page.locator('.message .mdBlock').filter({ hasText: SHRUG })).toHaveCount(1);
        await expect(page.locator('.message .mdBlock').filter({ hasText: '/d 2d6' })).toHaveCount(1);
        // Rejected commands left nothing behind
        await expect(page.locator('.message .mdBlock').filter({ hasText: 'should-not-exist' })).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test('A dice roll reaches the other member of a DM live, also once the conv list reloads', async ({ page, browser }) => {
        const errors = trackPageErrors(page);
        const suffix = Date.now();
        const contextB = await browser.newContext();
        const pageB = await contextB.newPage();

        await loginUser(page, `e2e_slash_a_${suffix}`);
        await waitForAppReady(page);
        const usernameA = await page.evaluate(() => window.global?.user?.username);

        await loginUser(pageB, `e2e_slash_b_${suffix}`);
        await waitForAppReady(pageB);
        const usernameB = await pageB.evaluate(() => window.global?.user?.username);
        await openFriendsArea(pageB);
        await sendFriendRequestToUsername(pageB, usernameA);

        await openFriendsArea(page);
        await acceptFriendRequestFromUsername(page, usernameB);
        await reloadAndWaitForApp(page);
        await reloadAndWaitForApp(pageB);

        const convA = await getPrivateConversationIdWithUsername(page, usernameB);
        const convB = await getPrivateConversationIdWithUsername(pageB, usernameA);
        expect(convA).toBe(convB);
        await openPrivateConversation(page, convA);
        await openPrivateConversation(pageB, convB);

        await typeInComposer(page, '/d20');
        await page.keyboard.press('Enter');
        const sent = await lastDiceNotice(page);
        await expect.poll(() => lastMessageBody(pageB)).toBe('/d20');
        const received = await lastDiceNotice(pageB);
        expect(received.total).toBe(sent.total);
        expect(received.text).toContain(await page.evaluate(() => window.global.user.display));

        // ── The conv list lands while the DM is open ───────────────────────
        // At boot the URL (or a click on the snapshot sidebar) can open a DM before
        // get_user_convs answers; that answer used to replace the conv object and
        // drop its messageGroups, so the next send crashed ("reading 'push'").
        const convsLoaded = page.waitForResponse('**/get_user_convs');
        await page.evaluate(async () => (await import('/static/crud.mjs')).loadConvs());
        await convsLoaded;
        await page.waitForTimeout(300);   // let its onload run
        await typeInComposer(page, '/d 2d6');
        await page.keyboard.press('Enter');
        await expect.poll(() => lastMessageBody(page)).toBe('/d 2d6');
        await expect(page.locator('.system-message')).toHaveCount(2);
        expect((await lastDiceNotice(page)).text).toContain('2d6');
        await expect.poll(() => lastMessageBody(pageB)).toBe('/d 2d6');
        await expect(pageB.locator('.system-message')).toHaveCount(2);
        expect(errors).toEqual([]);

        await contextB.close();
    });
});
