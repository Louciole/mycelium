import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { createConversation, openConversation, waitForAppReady } from './helpers/callHelpers.mjs';
import { reloadAndWaitForApp } from './helpers/messagingHelpers.mjs';

const TEST_TIMEOUT = 60000;

/**
 * Mentions are chat markdown (chat-markdown.mjs): messages and notes render them,
 * other markdown (profile descriptions, Vesta's MDToHTML) shows them as text.
 */
test.describe('Mentions - E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('a user mention in a message shows the name and opens the profile', async ({ page }) => {
        const suffix = Date.now();
        await loginUser(page, `e2e_mention_${suffix}`);
        await waitForAppReady(page);
        const { userId, display } = await page.evaluate(() => ({
            userId: window.global.user.id,
            display: window.global.users?.[window.global.user.id]?.display ?? window.global.user.display,
        }));

        const convId = await createConversation(page, `mentions ${suffix}`, []);
        await reloadAndWaitForApp(page);
        await openConversation(page, convId);

        const input = page.locator('.chat-input textarea.selected');
        await input.fill(`hi <@${userId}> end ${suffix}`);
        await input.focus();
        await page.keyboard.press('Enter');

        const chip = page.locator(`.message .mdBlock .mention-user[data-mention-id="${userId}"]`).last();
        await expect(chip).toHaveText(`@${display}`, { timeout: 10000 });
        await chip.click();
        await page.waitForFunction((id) => Number(window.global?.state?.profileInfo?.id) === Number(id), userId, { timeout: 10000 });
    });

    test('profile markdown has no mentions, chat markdown does', async ({ page }) => {
        await loginUser(page, `e2e_mention_md_${Date.now()}`);
        await waitForAppReady(page);

        const { profile, message } = await page.evaluate(() => ({
            profile: window.MDToHTML('me &lt;@1> &lt;#2> **b**'),
            message: window.renderMessageBody('me &lt;@1> &lt;#2> **b**'),
        }));
        expect(profile).toBe('me &lt;@1> &lt;#2> <b>b</b>');
        expect(message).toContain("class='mention mention-user'");
        expect(message).toContain("class='mention mention-channel");
        expect(message).toContain('<b>b</b>');
    });
});
