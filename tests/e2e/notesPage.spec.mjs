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

/** Text of the note's blocks in reading order, as rendered. */
async function blockTexts(page) {
    return page.locator('#note-editor .block > .content').evaluateAll((els) => els.map((el) => el.innerText.trim()));
}

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

test.describe('Notes - page editor', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('the page title renames the notes channel', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enotetitle');

        const title = page.locator('#note-page-title');
        await expect(title).toHaveAttribute('contenteditable', 'true');
        await title.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.type('Roadmap Q4');
        await page.keyboard.press('Enter');

        // Sidebar, header and server agree, and Enter moved the caret into the first block
        await expect(page.locator(`#channel-note-${channelId}`)).toContainText('Roadmap Q4');
        await expect(page.locator('#note-editor .block > .content').first()).toBeFocused();
        await openNoteChannel(page, channelId);
        await expect.poll(() => page.evaluate((id) => fetch(`/get_note_content?channel_id=${id}`).then((r) => r.json()).then((j) => j.name), channelId))
            .toBe('Roadmap Q4');
    });

    test('Enter and "+" insert right below the block, Backspace goes back up', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enoteorder');
        const first = await getFirstBlockOfType(page, channelId, 'text');

        await page.locator(`[data-block-id="${first}"] .content`).click();
        await page.keyboard.type('# One');                 // heading initiator
        await page.keyboard.press('Enter');                // → new text block below
        await page.keyboard.type('three');
        await expect.poll(() => blockTexts(page)).toEqual(['One', 'three']);

        // "+" in the heading's gutter inserts between the two
        const heading = page.locator(`[data-block-id="${first}"]`);
        await heading.hover();
        await heading.locator('.controls .add').click();
        await page.keyboard.type('two');
        await expect.poll(() => blockTexts(page)).toEqual(['One', 'two', 'three']);

        // Same order after a reload from the server
        await page.reload();
        await waitForAppReady(page);
        await openNoteChannel(page, channelId);
        await expect.poll(() => blockTexts(page)).toEqual(['One', 'two', 'three']);

        // Emptying "two" then Backspace deletes it and puts the caret at the end of "One"
        await page.locator('#note-editor .block > .content', { hasText: 'two' }).click();
        await page.keyboard.press('End');
        for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await expect.poll(() => blockTexts(page)).toEqual(['One', 'three']);
        await expect(page.locator(`[data-block-id="${first}"] .content`)).toBeFocused();
    });

    test('the editing preview gives back exactly the text typed (no line added, no character lost)', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enotepreview');
        // Text → preview → text, as the editor reads it back on every keystroke
        const lossy = await page.evaluate(() => {
            const cases = ['- a', '- a\n- b', '-a', '- ', 'x\n- s', '-# small', '> q', '>> q', '**b**', '*i*', '***bi***', '~~s~~',
                '||sp||', "'''code'''", "'''multi\nline'''", "a'''b'''c", '[x]', '[ ] todo', '[a](https://e.com)', 'a\n\nb',
                '<#1>', '<@2>', '<@&3>', '<@everyone>', 'a < b', '&amp;', '&lt;b&gt;', '<$red hi/>', 'end<', 'end~',
                'https://x.org\nnext', 'é😀', '<img src=x onerror=alert(1)>'];
            return cases.filter((raw) => {
                const el = document.createElement('span');
                el.innerHTML = window.MDToPreview(raw);
                return window.blockToRawContent(el) !== raw;
            });
        });
        expect(lossy).toEqual([]);

        // Typing after a list marker used to add a line per keystroke
        const uuid = await getFirstBlockOfType(page, channelId, 'text');
        const el = page.locator(`[data-block-id="${uuid}"] .content`);
        await el.click();
        await page.keyboard.type('- item sddsd');
        await expect.poll(() => page.evaluate(([id, u]) => window.global.notes[id].blocks[u].content, [channelId, uuid])).toBe('- item sddsd');
        await expect(el).toHaveText('- item sddsd');
        // Typed text shows as text, never as HTML
        await page.keyboard.type(' <b>x</b>');
        await page.locator('#note-page-title').click();   // rendered view
        await expect(el.locator('b')).toHaveCount(0);
        await expect(el).toContainText('<b>x</b>');
    });

    test('the block handle menu turns a block into a heading, duplicates and deletes it', async ({ page }) => {
        const { channelId } = await openFreshNote(page, 'e2enotemenu');
        const first = await getFirstBlockOfType(page, channelId, 'text');

        await page.locator(`[data-block-id="${first}"] .content`).click();
        await page.keyboard.type('Hello');
        const block = page.locator(`[data-block-id="${first}"]`);
        await block.hover();
        await block.locator('.controls .drag').click();
        const menu = page.locator('.note-block-menu');
        await expect(menu).toBeVisible();

        await menu.locator('.drive-context-item').nth(2).click();   // Text, H1, H2 → H2
        await expect(menu).toHaveCount(0);
        await expect(page.locator(`[data-block-id="${first}"] .content`)).toHaveClass(/note-heading2/);
        await expect.poll(() => page.evaluate(([id, uuid]) => window.global.notes[id].blocks[uuid].type, [channelId, first])).toBe('heading2');

        await block.hover();
        await block.locator('.controls .drag').click();
        await menu.locator('.drive-context-item:not(.danger)').last().click();   // Duplicate
        await expect.poll(() => blockTexts(page)).toEqual(['Hello', 'Hello']);

        await block.hover();
        await block.locator('.controls .drag').click();
        await menu.locator('.drive-context-item.danger').click();               // Delete
        await expect.poll(() => blockTexts(page)).toEqual(['Hello']);
        await expect.poll(() => page.evaluate(([id, uuid]) => uuid in window.global.notes[id].blocks, [channelId, first])).toBe(false);

        // A click outside closes it
        const remaining = page.locator('#note-editor .block').first();
        await remaining.hover();
        await remaining.locator('.controls .drag').click();
        await expect(menu).toBeVisible();
        await page.locator('#note-page-title').click();
        await expect(menu).toHaveCount(0);
    });
});
