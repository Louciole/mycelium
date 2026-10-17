import { expect } from '@playwright/test';
import { waitForAppReady } from './callHelpers.mjs';
import { acceptDialog } from './dialogHelpers.mjs';

/**
 * Opens the friends view from the private conversations column.
 */
export async function openFriendsArea(page) {
    await page.locator('#friendCat').click();
    await page.locator('#friends-block').waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Opens the "Add" tab and sends a friend request.
 */
export async function sendFriendRequestToUsername(page, username) {
    await page.locator('#content .selected-info .green.btn').click();
    await page.locator('#addFriendInput').waitFor({ state: 'visible', timeout: 5000 });

    await page.fill('#addFriendInput', username);
    await page.locator('.add .btn.blue').click();

    const status = page.locator('.add .status');
    await expect(status).toHaveClass(/succeed/, { timeout: 10000 });
    await expect(status).toContainText('friend request', { timeout: 10000 });
}

/**
 * Logs out through the UI (settings -> logout).
 */
export async function disconnectViaUi(page) {
    await page.locator('div[onclick="openMenu(\'settings\')"]').click();
    await page.locator('#settings').waitFor({ state: 'visible', timeout: 5000 });

    await page.locator('#account-actions').click();

    await page.locator('input[name="email"]').waitFor({ state: 'visible', timeout: 10000 });
    await expect(page).toHaveURL(/\/auth/);
}

/**
 * Accepts a targeted friend request.
 */
export async function acceptFriendRequestFromUsername(page, username) {
    // "Pending" tab
    await page.locator('#content .selected-info .cat').nth(2).click();
    await page.locator('#friends-block .scrollable').waitFor({ state: 'visible', timeout: 5000 });

    // Wait for the invitation in client state
    await page.waitForFunction((expectedUsername) => {
        const user = window.global?.user;
        const users = window.global?.users || {};
        if (!user?.invitations?.length) return false;

        return user.invitations.some((inv) => {
            const otherId = inv.kopinprincipal === user.id ? inv.kopinsecondaire : inv.kopinprincipal;
            return users[otherId]?.username === expectedUsername;
        });
    }, username, { timeout: 10000 });

    const invitationId = await page.evaluate((expectedUsername) => {
        const user = window.global.user;
        const users = window.global.users;

        const invitation = user.invitations.find((inv) => {
            const otherId = inv.kopinprincipal === user.id ? inv.kopinsecondaire : inv.kopinprincipal;
            return users[otherId]?.username === expectedUsername;
        });

        return invitation?.id;
    }, username);

    expect(invitationId).toBeTruthy();

    await page.locator(`div.action[onclick*="friend('accept',${invitationId}"]`).first().click();

    // Verify invitation removal and friend presence in UI state
    await page.waitForFunction((expectedUsername) => {
        const user = window.global?.user;
        const users = window.global?.users || {};
        if (!user) return false;

        const friendExists = (user.friends || []).some((friendship) => {
            const otherId = friendship.kopinprincipal === user.id ? friendship.kopinsecondaire : friendship.kopinprincipal;
            return users[otherId]?.username === expectedUsername;
        });

        const invitationStillThere = (user.invitations || []).some((inv) => {
            const otherId = inv.kopinprincipal === user.id ? inv.kopinsecondaire : inv.kopinprincipal;
            return users[otherId]?.username === expectedUsername;
        });

        return friendExists && !invitationStillThere;
    }, username, { timeout: 10000 });
}

/**
 * Returns the private conversation ID with a target user.
 */
export async function getPrivateConversationIdWithUsername(page, username) {
    return page.evaluate((expectedUsername) => {
        const user = window.global?.user;
        const users = window.global?.users || {};
        const convs = Object.values(window.global?.privateConvs || {});

        const conv = convs.find((c) => {
            if (!c?.members?.length) return false;
            const otherMemberId = c.members.find((memberId) => memberId !== user.id);
            return users[otherMemberId]?.username === expectedUsername;
        });

        return conv?.id || null;
    }, username);
}

export async function reloadAndWaitForApp(page) {
    await page.reload();
    await page.waitForURL('**/channels**', { timeout: 10000 });
    await waitForAppReady(page);
}

/**
 * Opens a private conversation from the sidebar.
 */
export async function openPrivateConversation(page, convId) {
    await page.locator(`#conv${convId}`).click();

    await page.waitForFunction((id) => {
        return window.global?.state?.activeConv === id;
    }, convId, { timeout: 10000 });

    await page.locator('.chat-input textarea.selected').waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Sends a message in the active conversation through the textarea.
 */
export async function sendMessageInActiveConversation(page, text) {
    const input = page.locator('.chat-input textarea.selected');
    await input.fill(text);
    await input.focus();
    await page.keyboard.press('Enter');

    await expect(page.locator('.message .mdBlock').filter({ hasText: text }).last()).toBeVisible({ timeout: 10000 });
}

/**
 * Returns the ID of the latest message that exactly matches this content.
 */
export async function getMessageIdByBody(page, body) {
    await page.waitForFunction((expectedBody) => {
        const convId = window.global?.state?.activeConv;
        const messages = window.global?.convs?.[convId]?.messages || {};
        // Wait for the reconciled (real, numeric) id, not the optimistic 'tmp_' placeholder.
        return Object.values(messages).some((m) => m?.body === expectedBody && !String(m.id).startsWith('tmp_'));
    }, body, { timeout: 10000 });

    return page.evaluate((expectedBody) => {
        const convId = window.global.state.activeConv;
        const messages = Object.values(window.global.convs[convId].messages || {})
            .filter((m) => m && m.body === expectedBody && !String(m.id).startsWith('tmp_'))
            .sort((a, b) => Number(a.id) - Number(b.id));

        return messages.length ? Number(messages[messages.length - 1].id) : null;
    }, body);
}

/**
 * Replies to an existing message.
 */
export async function replyToMessage(page, originalMessageId, replyText) {
    await page.locator(`#message-${originalMessageId}`).hover();
    await page
        .locator(`#message-${originalMessageId} .icon-wrapper:has(img[src="/static/icons/material/reply.svg"])`)
        .click({ force: true });
    await page.locator('#replyBox').waitFor({ state: 'visible', timeout: 5000 });

    await sendMessageInActiveConversation(page, replyText);
}

/**
 * Deletes a message through the UI (confirms the in-app dialog delMsg() opens).
 */
export async function deleteMessageById(page, messageId) {
    // Don't return delMsg()'s promise: it only settles once the dialog is answered
    await page.evaluate((id) => {
        window.delMsg(id);
    }, messageId);
    await acceptDialog(page);

    // Let the async xhr() call start before next UI action.
    await page.waitForTimeout(500);
}

/**
 * Edits an existing message and verifies the "edited" rendering.
 */
export async function editMessageById(page, messageId, newText) {
    await page.locator(`#message-${messageId}`).hover();
    await page
        .locator(`#message-${messageId} .icon-wrapper:has(img[src="/static/icons/material/edit.svg"])`)
        .click({ force: true });

    const editor = page.locator(`#message-${messageId} .edit textarea`);
    await editor.waitFor({ state: 'visible', timeout: 5000 });
    await editor.fill(newText);
    await editor.press('Enter');

    await expect(page.locator(`#message-${messageId} .mdBlock`)).toContainText(newText, { timeout: 10000 });
    await expect(page.locator(`#message-${messageId} .edited`)).not.toHaveText(/^\s*$/);
}

/**
 * Adds a reaction to a message through the reaction picker.
 * Returns the selected emoji.
 */
export async function addReactionToMessageById(page, messageId) {
    await page.locator(`#message-${messageId}`).hover();
    await page
        .locator(`#message-${messageId} .icon-wrapper:has(img[src="/static/icons/material/emoji.svg"])`)
        .click({ force: true });

    const picker = page.locator('#reaction-picker');
    await picker.waitFor({ state: 'visible', timeout: 5000 });

    const emojiButton = page
        .locator('#reaction-picker [onclick*="insertStandardEmoji"][onclick*="reaction"]')
        .first();
    await emojiButton.waitFor({ state: 'visible', timeout: 5000 });

    const emoji = ((await emojiButton.textContent()) || '').trim();
    await emojiButton.click({ force: true });

    await expect(page.locator(`#message-${messageId} .reaction-badge.reacted`).first()).toBeVisible({ timeout: 10000 });
    return emoji;
}

/**
 * Verifies that a reaction (optionally a specific one) is visible on a message.
 */
export async function expectReactionVisibleForMessage(page, messageId, emoji = undefined) {
    await page.waitForFunction(({ id, expectedEmoji }) => {
        const message = document.querySelector(`#message-${id}`);
        if (!message) return false;

        const badges = Array.from(message.querySelectorAll('.reaction-badge.reacted'));
        if (badges.length === 0) return false;

        if (!expectedEmoji) return true;
        return badges.some((badge) => badge.querySelector('.emoji')?.textContent?.trim() === expectedEmoji);
    }, { id: messageId, expectedEmoji: emoji }, { timeout: 10000 });
}

/**
 * Reloads the page and restores the target conversation.
 */
export async function reloadAndRestoreConversation(page, convId) {
    await reloadAndWaitForApp(page);
    await openPrivateConversation(page, convId);
}

export async function expectMessageVisible(page, text) {
    await expect(page.locator('.message .mdBlock').filter({ hasText: text }).last()).toBeVisible({ timeout: 10000 });
}

export async function expectMessageNotVisible(page, text) {
    await expect(page.locator('.message .mdBlock').filter({ hasText: text })).toHaveCount(0);
}

/**
 * Opens the add-users panel from within an active conversation.
 */
export async function openAddUsersPanel(page) {
    await page.locator('.call-actions .icon-wrapper:has(img[src="/static/icons/material/groupadd.svg"])').click();
    await page.waitForFunction(() => {
        const el = document.getElementById('add-users');
        return el && el.style.visibility !== 'hidden' && el.offsetParent !== null;
    }, undefined, { timeout: 5000 });
}

/**
 * Checks the checkbox for a friend in the add-users panel by their username.
 */
export async function selectFriendInAddPanel(page, username) {
    const row = page.locator('#add-users .scrollable .space-between').filter({
        has: page.locator('.username').filter({ hasText: username }),
    });
    await row.waitFor({ state: 'visible', timeout: 5000 });
    const checkbox = row.locator('input[type="checkbox"]');
    if (!(await checkbox.isChecked())) {
        await checkbox.click();
    }
}

/**
 * Clicks "Créer un MP" in the add-users panel.
 * Waits for the button to become enabled first.
 */
export async function confirmGroupConvCreation(page) {
    const btn = page.locator('#createConvBtn');
    await expect(btn).not.toHaveClass(/disabled/, { timeout: 5000 });
    await btn.click();
}

/**
 * Returns the ID of a group conv (private=false) that contains all given member usernames.
 */
export async function getGroupConvId(page, memberUsernames) {
    return page.evaluate((usernames) => {
        const users = window.global?.users || {};
        const convs = Object.values(window.global?.privateConvs || {});
        const conv = convs.find((c) => {
            if (c?.private !== false) return false;
            const memberNames = (c.members || []).map((id) => users[id]?.username).filter(Boolean);
            return usernames.every((u) => memberNames.includes(u));
        });
        return conv?.id || null;
    }, memberUsernames);
}

/**
 * Waits for a group conv (private=false) to appear in global.privateConvs without reloading.
 */
export async function waitForGroupConvLive(page, timeout = 10000) {
    await page.waitForFunction(() => {
        return Object.values(window.global?.privateConvs || {}).some((c) => c?.private === false);
    }, undefined, { timeout });
}





