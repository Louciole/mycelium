/**
 * Drives the in-app dialogs (static/dialogs.mjs: uiAlert / uiConfirm / uiPrompt),
 * which replaced the browser's alert() / confirm() / prompt(): Playwright's
 * page.on('dialog') doesn't see them.
 */

export const UI_DIALOG = '#ui-dialog';

async function answer(page, button, value, timeout) {
    const dialog = page.locator(UI_DIALOG);
    await dialog.waitFor({ state: 'visible', timeout });
    const handle = await dialog.elementHandle();
    const info = {
        kind: await dialog.getAttribute('data-kind'),
        message: (await dialog.locator('.ui-dialog-message').textContent()).trim(),
    };
    if (value !== undefined) await dialog.locator('.ui-dialog-input').fill(String(value));
    await dialog.locator(button).click();
    // Queued dialogs reuse the same id: wait for this one to go, not for "no dialog"
    await handle.waitForElementState('hidden', { timeout });
    return info;
}

/**
 * Waits for the next dialog and confirms it (OK / the primary button), typing
 * `value` first for a prompt (leave it undefined to keep the prompt's default).
 * Returns {kind, message} so callers can assert on what was asked.
 */
export function acceptDialog(page, value = undefined, { timeout = 10000 } = {}) {
    return answer(page, '.ui-dialog-confirm', value, timeout);
}

/** Waits for the next confirm/prompt dialog and cancels it. Returns {kind, message}. */
export function dismissDialog(page, { timeout = 10000 } = {}) {
    return answer(page, '.ui-dialog-cancel', undefined, timeout);
}

/** Asserts no in-app dialog is open (none pending either). */
export async function expectNoDialog(page) {
    await page.locator(UI_DIALOG).waitFor({ state: 'detached', timeout: 5000 });
}
