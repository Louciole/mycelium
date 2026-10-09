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

// Initiators typed in a text block that convert it into an interactive block.
// "/sheet" and "/todo" also match slash-menu keywords, so the "/" menu is open
// right before the conversion happens.
const INITIATORS = [
    { text: '/sheet', type: 'spreadsheet' },
    { text: '/todo', type: 'checklist' },
    { text: '/database', type: 'database' },
];

test.describe('Notes - slash menu', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('Slash menu closes when an initiator converts the block', async ({ page }) => {
        const username = `e2eslash_${Date.now()}`;

        await loginUser(page, username);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        expect(serverId).toBeTruthy();
        await openServerFromSidebarById(page, serverId);

        for (const { text, type } of INITIATORS) {
            // Fresh note channel per initiator → one default empty text block
            const channelId = await createNoteChannelViaUi(page);
            await openNoteChannel(page, channelId);
            await waitForNoteChannelLoaded(page, channelId);

            await page.waitForFunction(
                (id) => Object.values(window.global?.notes?.[id]?.blocks || {}).some((b) => b.type === 'text'),
                channelId,
                { timeout: 10000 }
            );
            const blockUuid = await getFirstBlockOfType(page, channelId, 'text');
            expect(blockUuid).toBeTruthy();

            const contentEl = page.locator(`[data-block-id="${blockUuid}"] .content.editable-block`);
            await contentEl.waitFor({ state: 'visible', timeout: 5000 });
            await contentEl.click();

            // Typing "/" opens the menu…
            await page.keyboard.type('/');
            await expect(page.locator('.slash-menu')).toBeVisible();

            // …and finishing the initiator converts the block and must close it
            await page.keyboard.type(text.slice(1));
            await page.waitForFunction(
                ({ id, uuid, t }) => window.global?.notes?.[id]?.blocks?.[uuid]?.type === t,
                { id: channelId, uuid: blockUuid, t: type },
                { timeout: 10000 }
            );

            await expect(page.locator('.slash-menu')).toHaveCount(0);
            expect(await page.evaluate(() => !!window.global?.state?.slashMenu?.visible)).toBe(false);
            console.log(`✅ ${text} → ${type}, slash menu closed`);
        }
    });
});
