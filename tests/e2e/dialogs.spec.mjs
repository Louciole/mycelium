// In-app alert / confirm / prompt (static/dialogs.mjs): results, keyboard, queue, focus.
import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { acceptDialog, dismissDialog, expectNoDialog, UI_DIALOG } from './helpers/dialogHelpers.mjs';

const TEST_TIMEOUT = 60000;

// Opens a dialog without awaiting it; its result lands in window.__dialogResults[key]
async function open(page, key, kind, message, opts) {
    await page.evaluate(({ key, kind, message, opts }) => {
        window.__dialogResults ??= {};
        window[kind](message, opts).then((r) => { window.__dialogResults[key] = r === undefined ? '<undefined>' : r; });
    }, { key, kind, message, opts });
}

const result = (page, key) =>
    page.waitForFunction((key) => key in (window.__dialogResults || {}), key).then(() =>
        page.evaluate((key) => window.__dialogResults[key], key));

test.describe('In-app dialogs', () => {
    test.setTimeout(TEST_TIMEOUT);

    test.beforeEach(async ({ page }) => {
        await loginUser(page, `e2e_dialogs_${Date.now()}`);
        await waitForAppReady(page);
    });

    test('confirm / prompt / alert resolve with the expected values', async ({ page }) => {
        await open(page, 'c1', 'uiConfirm', 'Delete it?', { danger: true, confirmLabel: 'Delete' });
        const dialog = page.locator(UI_DIALOG);
        await expect(dialog).toHaveAttribute('role', 'alertdialog');
        await expect(dialog).toHaveAttribute('aria-modal', 'true');
        await expect(dialog).toHaveClass(/danger/);
        await expect(dialog.locator('.ui-dialog-confirm')).toHaveText('Delete');
        await expect(dialog.locator('.ui-dialog-confirm')).toBeFocused();
        expect(await acceptDialog(page)).toEqual({ kind: 'confirm', message: 'Delete it?' });
        expect(await result(page, 'c1')).toBe(true);

        await open(page, 'c2', 'uiConfirm', 'Sure?');
        await dismissDialog(page);
        expect(await result(page, 'c2')).toBe(false);

        await open(page, 'p1', 'uiPrompt', 'Name?', { value: 'abc' });
        await expect(dialog).toHaveAttribute('role', 'dialog');
        await expect(dialog.locator('.ui-dialog-input')).toBeFocused();
        await expect(dialog.locator('.ui-dialog-input')).toHaveValue('abc');
        await acceptDialog(page, 'typed');
        expect(await result(page, 'p1')).toBe('typed');

        await open(page, 'p2', 'uiPrompt', 'Name?');
        await dismissDialog(page);
        expect(await result(page, 'p2')).toBe(null);

        // Messages are text, not HTML
        await open(page, 'a1', 'uiAlert', '<b id="injected">x</b>');
        await expect(dialog.locator('.ui-dialog-message')).toHaveText('<b id="injected">x</b>');
        await expect(dialog.locator('.ui-dialog-cancel')).toHaveCount(0);
        await acceptDialog(page);
        expect(await result(page, 'a1')).toBe('<undefined>');
        await expectNoDialog(page);
    });

    test('keyboard: Enter confirms, Escape cancels, Tab stays inside; backdrop click cancels', async ({ page }) => {
        const dialog = page.locator(UI_DIALOG);

        await open(page, 'k1', 'uiPrompt', 'Reason?');
        await page.keyboard.type('spam');
        await page.keyboard.press('Enter');
        expect(await result(page, 'k1')).toBe('spam');

        await open(page, 'k2', 'uiConfirm', 'Sure?');
        await page.keyboard.press('Escape');
        expect(await result(page, 'k2')).toBe(false);

        // Tab cycles input → cancel → confirm → input; Enter on Cancel cancels
        await open(page, 'k3', 'uiPrompt', 'Reason?');
        await page.keyboard.press('Tab');
        await expect(dialog.locator('.ui-dialog-cancel')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(dialog.locator('.ui-dialog-confirm')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(dialog.locator('.ui-dialog-input')).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(dialog.locator('.ui-dialog-confirm')).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Enter');
        expect(await result(page, 'k3')).toBe(null);

        // required: OK stays disabled (and Enter does nothing) until something is typed
        await open(page, 'k4', 'uiPrompt', 'Reason?', { required: true });
        await expect(dialog.locator('.ui-dialog-confirm')).toBeDisabled();
        await page.keyboard.press('Enter');
        await expect(dialog).toBeVisible();
        await page.keyboard.type(' x ');
        await page.keyboard.press('Enter');
        expect(await result(page, 'k4')).toBe(' x ');

        await open(page, 'k5', 'uiConfirm', 'Sure?');
        await page.mouse.click(5, 5);
        expect(await result(page, 'k5')).toBe(false);
        await expectNoDialog(page);
    });

    test('dialogs are queued one at a time and focus goes back where it was', async ({ page }) => {
        await page.evaluate(() => {
            const input = document.createElement('input');
            input.id = 'dialog-focus-probe';
            document.body.appendChild(input);
            input.focus();
        });
        await open(page, 'q1', 'uiConfirm', 'First');
        await open(page, 'q2', 'uiPrompt', 'Second', { value: '2' });
        await expect(page.locator(UI_DIALOG)).toHaveCount(1);

        expect((await acceptDialog(page)).message).toBe('First');
        expect((await acceptDialog(page)).message).toBe('Second');
        expect(await result(page, 'q1')).toBe(true);
        expect(await result(page, 'q2')).toBe('2');
        await expectNoDialog(page);
        await expect(page.locator('#dialog-focus-probe')).toBeFocused();
    });
});
