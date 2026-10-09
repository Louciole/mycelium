import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import {
    createServerViaUi,
    openServerFromSidebarById,
} from './helpers/serverHelpers.mjs';
import {
    sendMessageInActiveConversation,
    getMessageIdByBody,
    reloadAndWaitForApp,
} from './helpers/messagingHelpers.mjs';

const TEST_TIMEOUT = 90000;

test.describe('Forum channels - E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('Create forum, add a post, reply, and toggle layout', async ({ page }) => {
        const suffix = Date.now();
        const account = `e2e_forum_${suffix}`;

        // 1) Login + create/open a server
        await loginUser(page, account);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);

        // 2) Create a forum channel (via the same handler the channel picker calls)
        await page.evaluate(() => window.createChan('forum'));
        await page.waitForFunction(
            () => (window.global?.state?.currentServer?.dirs?.forums || []).length > 0,
            undefined,
            { timeout: 10000 },
        );
        const forumId = await page.evaluate(
            () => Number(window.global.state.currentServer.dirs.forums[0].id),
        );
        expect(forumId).toBeTruthy();

        // Sidebar entry exists
        await expect(page.locator(`#channel-forum-${forumId}`)).toBeVisible({ timeout: 10000 });

        // 3) Open the forum -> post browser renders
        await page.evaluate((id) => window.goToForumChannel(id), forumId);
        await page.locator('.forum-new-post-btn').waitFor({ state: 'visible', timeout: 10000 });
        await expect(page.locator('.forum-empty')).toBeVisible();

        // 4) Create a post through the modal
        await page.locator('.forum-new-post-btn').click();
        await page.locator('#create-forum-post').waitFor({ state: 'visible', timeout: 5000 });

        const title = `First topic ${suffix}`;
        const starter = `Starter message ${suffix}`;
        await page.fill('#create-forum-post [data-post-title]', title);
        await page.fill('#create-forum-post [data-post-content]', starter);
        await page.locator('#create-forum-post .btn.blue').click();

        // 5) Lands in the open post view with the starter message
        await page.waitForFunction(
            () => Boolean(window.global?.state?.activeConv) &&
                  window.global?.convs?.[window.global.state.activeConv]?.forum,
            undefined,
            { timeout: 10000 },
        );
        await expect(page.locator('.forum-open-title')).toContainText(title);
        await expect(page.locator('.message .mdBlock').filter({ hasText: starter })).toBeVisible({ timeout: 10000 });

        // 6) Reply in the post thread (reuses the standard composer + backend message path)
        const reply = `A reply ${suffix}`;
        await sendMessageInActiveConversation(page, reply);
        await expect(page.locator('.message .mdBlock').filter({ hasText: reply })).toBeVisible({ timeout: 10000 });

        // 7) Back to the forum: the post now shows in the list with a reply count
        await page.evaluate(() => window.backToForum());
        await page.locator('.forum-post-card').first().waitFor({ state: 'visible', timeout: 10000 });
        await expect(page.locator('.forum-post-title').filter({ hasText: title })).toBeVisible();

        // 8) Layout toggle switches the container class
        await page.locator('.forum-layout-btn').nth(1).click(); // gallery
        await expect(page.locator('.forum-gallery')).toBeVisible({ timeout: 5000 });
        await page.locator('.forum-layout-btn').nth(0).click(); // list
        await expect(page.locator('.forum-list')).toBeVisible({ timeout: 5000 });
    });

    // Forum-post messages have place = the post id (not a textual channel): reactions,
    // manage-messages deletes and their WS fan-out must resolve it to the forum.
    test('Members react in a forum post; a moderator deletes a member reply live', async ({ browser }) => {
        const suffix = Date.now();
        const ownerCtx = await browser.newContext();
        const memberCtx = await browser.newContext();
        const owner = await ownerCtx.newPage();
        const member = await memberCtx.newPage();
        owner.on('dialog', (d) => d.accept());   // delMsg() confirm

        const api = (page, path) => page.evaluate(async (path) => {
            const r = await fetch(path, { method: 'POST', credentials: 'include' });
            return { status: r.status, text: await r.text() };
        }, path);
        // Wait for each view to render: switching straight from the forum to the post
        // lets the forum template land last and hide the post.
        const openPost = async (page, forumId, postId) => {
            await page.evaluate((id) => window.goToForumChannel(id), forumId);
            await page.locator('.forum-new-post-btn').waitFor({ state: 'visible', timeout: 10000 });
            await page.evaluate((id) => window.goToForumPost(id), postId);
            await page.locator('.forum-open-title').waitFor({ state: 'visible', timeout: 10000 });
            await page.waitForFunction((id) =>
                window.global?.state?.activeConv === id && !!window.global?.convs?.[id]?.messages,
            postId, { timeout: 10000 });
        };

        // Owner: community server + forum + post
        await loginUser(owner, `e2e_forum_mod_${suffix}`);
        await waitForAppReady(owner);
        const serverId = await createServerViaUi(owner);
        expect((await api(owner, `edit_server_property?property=is_community&server_id=${serverId}&value=true`)).status).toBe(200);
        await openServerFromSidebarById(owner, serverId);
        await owner.evaluate(() => window.createChan('forum'));
        await owner.waitForFunction(
            () => (window.global?.state?.currentServer?.dirs?.forums || []).length > 0,
            undefined, { timeout: 10000 },
        );
        const forumId = await owner.evaluate(
            () => Number(window.global.state.currentServer.dirs.forums[0].id),
        );
        const created = await api(owner,
            `create_forum_post?forum_id=${forumId}&title=${encodeURIComponent(`Topic ${suffix}`)}&content=starter`);
        expect(created.status).toBe(200);
        const postId = JSON.parse(created.text).post.id;

        // Member joins and replies in the post
        await loginUser(member, `e2e_forum_mem_${suffix}`);
        await waitForAppReady(member);
        expect((await api(member, `join_community_server?server_id=${serverId}`)).status).toBe(200);
        await reloadAndWaitForApp(member);
        await openServerFromSidebarById(member, serverId);
        await openPost(member, forumId, postId);
        const reply = `Reply to moderate ${suffix}`;
        await sendMessageInActiveConversation(member, reply);
        const replyId = await getMessageIdByBody(member, reply);

        // Owner reloads to know the new member (like moderation.spec), then opens the post
        await reloadAndWaitForApp(owner);
        await openServerFromSidebarById(owner, serverId);
        await openPost(owner, forumId, postId);
        const starterId = await getMessageIdByBody(owner, 'starter');

        // Member reacts to the starter: allowed, and the owner gets the live update
        const reacted = await api(member, `toggle_reaction?message_id=${starterId}&emoji=${encodeURIComponent('standard:👍')}`);
        expect(reacted.status).toBe(200);
        await owner.waitForFunction(({ postId, starterId }) =>
            Object.keys(window.global.convs[postId].messages[starterId]?.reactions || {}).length > 0,
        { postId, starterId }, { timeout: 10000 });

        // Owner (manage-messages) gets the delete action on the member's reply and uses it
        const del = owner.locator(`#message-${replyId} [onclick="delMsg(${replyId})"]`);
        await expect(del).toHaveCount(1);
        await del.dispatchEvent('click');

        // The member sees it disappear via the message_deleted WS notif
        await member.waitForFunction(({ postId, replyId }) =>
            !window.global.convs[postId].messages[replyId], { postId, replyId }, { timeout: 10000 });
        await expect(member.locator('.message .mdBlock').filter({ hasText: reply })).toHaveCount(0);

        await ownerCtx.close();
        await memberCtx.close();
    });
});
