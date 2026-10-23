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
import { acceptDialog } from './helpers/dialogHelpers.mjs';

const TEST_TIMEOUT = 90000;

const api = (page, path) => page.evaluate(async (path) => {
    const r = await fetch(path, { method: 'POST', credentials: 'include' });
    return { status: r.status, text: await r.text() };
}, path);

const forumContent = async (page, forumId) => JSON.parse(await page.evaluate(
    async (id) => (await fetch('get_forum_content?channel_id=' + id)).text(), forumId));

/** Logs in, creates a server with a forum channel and returns their ids. */
async function setupForum(page, account) {
    await loginUser(page, account);
    await waitForAppReady(page);
    const serverId = await createServerViaUi(page);
    await openServerFromSidebarById(page, serverId);
    await page.evaluate(() => window.createChan('forum'));
    await page.waitForFunction(
        () => (window.global?.state?.currentServer?.dirs?.forums || []).length > 0,
        undefined, { timeout: 10000 },
    );
    const forumId = await page.evaluate(() => Number(window.global.state.currentServer.dirs.forums[0].id));
    return { serverId, forumId };
}

async function addTag(page, forumId, name, color = '#3BA55C') {
    const res = await api(page, `edit_forum_tags?forum_id=${forumId}&action=add&tag=${encodeURIComponent(JSON.stringify({ name, color }))}`);
    expect(res.status).toBe(200);
    return JSON.parse(res.text).available_tags.find((t) => t.name === name).id;
}

async function openForum(page, forumId) {
    await page.evaluate((id) => window.goToForumChannel(id), forumId);
    await page.locator('.forum-new-post-btn').waitFor({ state: 'visible', timeout: 10000 });
}

// A tiny real PNG so the upload goes through the same pipeline as a user's image
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAGklEQVR4nGP4z8CAFTGMSgwkxcDAwMDAAADMKAf5tHvi0AAAAABJRU5ErkJggg==',
    'base64');

test.describe('Forum channels - E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('Composer: post with an image and a tag, reply, pin, lock and delete', async ({ page }) => {
        const suffix = Date.now();
        const { forumId } = await setupForum(page, `e2e_forum_${suffix}`);
        await expect(page.locator(`#channel-forum-${forumId}`)).toBeVisible({ timeout: 10000 });
        const tagId = await addTag(page, forumId, `Tag${suffix}`);

        await openForum(page, forumId);
        await expect(page.locator('.forum-empty')).toBeVisible();

        // Opening the composer hides the search bar; closing it drops pending attachments
        // (they live in the chat's shared global.state.currentMessageAttachments)
        await page.locator('.forum-new-post-btn').click();
        await expect(page.locator('#forum-composer')).toBeVisible();
        await expect(page.locator('.forum-search-bar')).toBeHidden();
        await expect(page.locator('.forum-composer-submit')).toHaveClass(/disabled/); // no title yet
        await page.setInputFiles('#forum-file-upload', { name: 'dropped.png', mimeType: 'image/png', buffer: PNG });
        await expect(page.locator('#forum-composer .attachment-preview')).toHaveCount(1);
        await page.locator('.forum-composer-close').click();
        await expect(page.locator('#forum-composer')).toBeHidden();
        await expect(page.locator('.forum-search-bar')).toBeVisible();
        expect(await page.evaluate(() => window.global.state.currentMessageAttachments.length)).toBe(0);

        // Real post: title, message, image, tag
        const title = `First topic ${suffix}`;
        const starter = `Starter message ${suffix}`;
        await page.locator('.forum-new-post-btn').click();
        await expect(page.locator('#forum-composer .attachment-preview')).toHaveCount(0);
        await page.fill('#forum-composer [data-post-title]', title);
        await page.fill('#forum-composer [data-post-content]', starter);
        await page.setInputFiles('#forum-file-upload', { name: 'cover.png', mimeType: 'image/png', buffer: PNG });
        await expect(page.locator('#forum-composer .attachment-preview')).toHaveCount(1);
        await page.locator(`#forum-composer [data-tag-option="${tagId}"]`).click();
        await page.locator('.forum-composer-submit').click();

        // Lands in the open post: header with title + tag, starter message with its image
        await page.waitForFunction(
            () => Boolean(window.global?.state?.activeConv) &&
                  window.global?.convs?.[window.global.state.activeConv]?.forum,
            undefined, { timeout: 10000 },
        );
        const postId = await page.evaluate(() => window.global.state.activeConv);
        await expect(page.locator('.forum-open-title')).toContainText(title);
        await expect(page.locator('.forum-thread-header .forum-tag-chip')).toHaveText(`Tag${suffix}`);
        await expect(page.locator('.message .mdBlock').filter({ hasText: starter })).toBeVisible({ timeout: 10000 });
        await expect(page.locator('.message img[src*="/static/attachments/"]')).toHaveCount(1);

        // Reply through the standard chat composer
        const reply = `A reply ${suffix}`;
        await sendMessageInActiveConversation(page, reply);
        await expect(page.locator('.message .mdBlock').filter({ hasText: reply })).toBeVisible({ timeout: 10000 });

        // Back to the list: card with thumbnail (first image of the starter) and reply count.
        // It replaces the post's history entry instead of stacking forum/post/forum...
        const historyLength = await page.evaluate(() => history.length);
        await page.evaluate(() => window.backToForum());
        await expect.poll(() => page.evaluate(() => location.hash)).toMatch(new RegExp(`/${forumId}$`));
        expect(await page.evaluate(() => history.length)).toBe(historyLength);
        const card = page.locator('.forum-post-card').first();
        await card.waitFor({ state: 'visible', timeout: 10000 });
        await expect(card.locator('.forum-post-title')).toHaveText(title);
        await expect(card.locator('.forum-post-thumb')).toHaveAttribute('style', /\/static\/attachments\//);
        await expect(card.locator('.forum-post-replies')).toHaveText('1');

        // Moderation from the post header: pin + lock show up in the post and in the list
        await page.evaluate((id) => window.goToForumPost(id), postId);
        await page.locator('.forum-open-title').waitFor();
        await page.locator('.forum-header-actions img[src*="flag_outlined"]').click();
        await page.locator('.forum-header-actions img[src*="lock_open"]').click();
        await expect(page.locator('.forum-thread-badge')).toHaveCount(2);
        await expect(page.locator('.forum-locked-notice')).toBeVisible();
        await expect(page.locator('.chat-wrapper')).toHaveCount(0);
        const stored = (await forumContent(page, forumId)).posts.find((p) => p.id === postId);
        expect(stored.pinned).toBe(true);
        expect(stored.locked).toBe(true);
        await page.evaluate(() => window.backToForum());
        await expect(page.locator('.forum-post-card .forum-badge-icon')).toHaveCount(2);

        // Delete (with confirmation): back to an empty forum, gone server-side
        await page.evaluate((id) => window.goToForumPost(id), postId);
        await page.locator('.forum-header-actions img[src*="trash"]').click();
        await acceptDialog(page);
        await expect(page.locator('.forum-empty')).toBeVisible({ timeout: 10000 });
        expect((await forumContent(page, forumId)).posts).toHaveLength(0);
    });

    test('Attachments left in the composer are not sent with the next chat message', async ({ page }) => {
        const suffix = Date.now();
        const { forumId } = await setupForum(page, `e2e_forum_attach_${suffix}`);
        const textId = await page.evaluate(() => Number(window.global.state.currentServer.dirs.channels[0].id));

        await openForum(page, forumId);
        await page.locator('.forum-new-post-btn').click();
        await page.setInputFiles('#forum-file-upload', { name: 'left-behind.png', mimeType: 'image/png', buffer: PNG });
        await expect(page.locator('#forum-composer .attachment-preview')).toHaveCount(1);

        // Leave without closing the composer, then chat in the text channel
        await page.locator(`#channel-conv-${textId}`).click();
        await page.locator('.chat-input textarea').waitFor({ state: 'visible', timeout: 10000 });
        const body = `plain message ${suffix}`;
        await sendMessageInActiveConversation(page, body);
        const messageId = await getMessageIdByBody(page, body);
        await page.waitForFunction(({ textId, messageId }) =>
            !String(messageId).startsWith('tmp_') && window.global.convs[textId].messages[messageId],
        { textId, messageId }, { timeout: 10000 });
        const sent = await page.evaluate(({ textId, messageId }) =>
            window.global.convs[textId].messages[messageId].attachments, { textId, messageId });
        expect(sent).toEqual([]);
    });

    test('Post list: layout, search, tag filter, sort, per-user view prefs', async ({ page }) => {
        const suffix = Date.now();
        const { forumId } = await setupForum(page, `e2e_forum_list_${suffix}`);
        const tagId = await addTag(page, forumId, `Only${suffix}`);
        expect((await api(page, `create_forum_post?forum_id=${forumId}&title=${encodeURIComponent(`Alpha ${suffix}`)}&content=body&tags=${encodeURIComponent(JSON.stringify([tagId]))}`)).status).toBe(200);
        expect((await api(page, `create_forum_post?forum_id=${forumId}&title=${encodeURIComponent(`Beta ${suffix}`)}&content=body`)).status).toBe(200);

        await openForum(page, forumId);
        await page.locator('.forum-post-card').first().waitFor({ state: 'visible', timeout: 10000 });

        // Regression: #member-list-wrapper (height:100%) used to be a column sibling of the
        // post list and squashed it to 0px: posts were in the DOM but invisible.
        const box = await page.locator('.forum-main').boundingBox();
        expect(box.height).toBeGreaterThan(300);
        await expect(page.locator('.forum-post-card')).toHaveCount(2);

        // Default sort = recent activity (newest first); "Oldest first" reverses it
        await expect(page.locator('.forum-post-title')).toHaveText([`Beta ${suffix}`, `Alpha ${suffix}`]);
        await page.locator('.forum-pill').click();
        await page.locator('.forum-menu-option').nth(2).click(); // Sort by: oldest first
        await expect(page.locator('.forum-post-title')).toHaveText([`Alpha ${suffix}`, `Beta ${suffix}`]);

        // Tag filter toggles
        await page.locator('.forum-tag-filters .forum-tag-chip').click();
        await expect(page.locator('.forum-post-title')).toHaveText([`Alpha ${suffix}`]);
        await page.locator('.forum-tag-filters .forum-tag-chip').click();
        await expect(page.locator('.forum-post-card')).toHaveCount(2);

        // Search filters by title; Enter opens the composer with it as the title
        await page.fill('#forum-search-input', 'Beta');
        await expect(page.locator('.forum-post-title')).toHaveText([`Beta ${suffix}`]);
        await page.fill('#forum-search-input', 'Gamma');
        await page.press('#forum-search-input', 'Enter');
        await expect(page.locator('#forum-composer')).toBeVisible();
        await expect(page.locator('#forum-composer [data-post-title]')).toHaveValue('Gamma');
        await page.keyboard.press('Escape');
        await expect(page.locator('#forum-composer')).toBeHidden();
        await expect(page.locator('.forum-empty')).toBeVisible(); // "no post matches"
        await page.fill('#forum-search-input', '');
        await expect(page.locator('.forum-post-card')).toHaveCount(2);

        // "Sort & view" is a personal preference: it must not rewrite the forum's defaults
        const settingsCalls = [];
        page.on('request', (r) => { if (r.url().includes('edit_forum_settings')) settingsCalls.push(r.url()); });
        await page.locator('.forum-pill').click();
        await page.locator('.forum-menu-option').nth(4).click(); // View as: gallery
        await expect(page.locator('.forum-gallery')).toBeVisible();
        expect(settingsCalls).toHaveLength(0);
        // ...and it survives reopening the forum
        await openForum(page, forumId);
        await expect(page.locator('.forum-gallery')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('.forum-post-title')).toHaveText([`Alpha ${suffix}`, `Beta ${suffix}`]);
    });

    test('Forum settings (Overview): name, guidelines, tags, required tag, defaults', async ({ page }) => {
        const suffix = Date.now();
        const { forumId } = await setupForum(page, `e2e_forum_settings_${suffix}`);
        await openForum(page, forumId);
        await page.locator('.forum-header-actions img[src*="settings"]').click();
        await expect(page.locator('#channels-params')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#forum-guidelines-input')).toBeVisible();

        // Name + guidelines go through the unsaved-changes bar
        await page.fill('#name-input', `Débats ${suffix}`);
        await page.fill('#forum-guidelines-input', 'Soyez gentils.');
        await expect(page.locator('.forum-guidelines-counter')).toHaveText(String(4096 - 'Soyez gentils.'.length));
        await expect(page.locator('#formChannel')).toBeVisible();
        await page.locator('#formChannel .btn.green').click();
        await expect(page.locator('#formChannel')).toBeHidden();
        let saved = await forumContent(page, forumId);
        expect(saved.name).toBe(`Débats ${suffix}`);
        expect(saved.guidelines).toBe('Soyez gentils.');
        await expect(page.locator(`#channel-forum-${forumId}`)).toContainText(`Débats ${suffix}`);

        // Create a tag in the dialog, rename it, then delete it
        await page.locator('.forum-create-tag-btn').click();
        await expect(page.locator('.forum-tag-editor')).toBeVisible();
        await expect(page.locator('#forum-tag-save')).toHaveClass(/disabled/);
        await page.fill('#forum-tag-name', `Tag${suffix}`);
        await page.locator('.forum-tag-color').nth(3).click();
        await page.locator('#forum-tag-save').click();
        await expect(page.locator('.forum-tag-editor')).toHaveCount(0);
        await expect(page.locator('.forum-settings-tags .forum-tag-chip')).toHaveText(`Tag${suffix}`);
        saved = await forumContent(page, forumId);
        expect(saved.available_tags).toEqual([expect.objectContaining({ name: `Tag${suffix}`, color: '#ED4245' })]);

        await page.locator('.forum-settings-tags .forum-tag-chip').click();
        await expect(page.locator('#forum-tag-name')).toHaveValue(`Tag${suffix}`);
        await page.fill('#forum-tag-name', `Renamed${suffix}`);
        await page.locator('#forum-tag-save').click();
        await expect(page.locator('.forum-settings-tags .forum-tag-chip')).toHaveText(`Renamed${suffix}`);

        // Required tag: saved right away
        await page.locator('.forum-settings-check').click();
        await expect.poll(async () => (await forumContent(page, forumId)).require_tag).toBe(true);

        // Default layout: saved right away, applies to members without a personal choice
        await page.locator('.forum-settings-radio').filter({ hasText: /Gallery|Galerie/ }).click();
        await expect.poll(async () => (await forumContent(page, forumId)).default_layout).toBe('gallery');
        await page.evaluate(() => window.closeMenu('#channels-params'));

        // The forum page reflects all of it
        await expect(page.locator('.forum-guidelines')).toContainText('Soyez gentils.');
        await expect(page.locator('.forum-tag-filters .forum-tag-chip')).toHaveText(`Renamed${suffix}`);

        // Required tag survives a refetch of the forum (fetchForum used to drop require_tag):
        // "Post" stays disabled until a tag is picked, and the API refuses untagged posts
        await openForum(page, forumId);
        expect(await page.evaluate((id) => window.global.forums[id].require_tag, forumId)).toBe(true);
        await page.locator('.forum-new-post-btn').click();
        await expect(page.locator('[data-tag-label]')).toContainText(/required|requis/);
        await page.fill('#forum-composer [data-post-title]', 'Needs a tag');
        await expect(page.locator('.forum-composer-submit')).toHaveClass(/disabled/);

        // A refused post shows an error in the composer instead of failing silently
        await page.evaluate((id) => { window.global.forums[id].require_tag = false; window.updateCreatePostButton() }, forumId);
        await page.locator('.forum-composer-submit').click();
        await expect(page.locator('[data-post-error]')).toHaveText(/Pick a tag|Choisis un tag/);
        await expect(page.locator('#forum-composer')).toBeVisible();
        await page.locator('#forum-composer [data-tag-option]').click();
        await expect(page.locator('.forum-composer-submit')).not.toHaveClass(/disabled/);
        await page.locator('.forum-composer-submit').click();
        await expect(page.locator('.forum-open-title')).toContainText('Needs a tag', { timeout: 10000 });
        expect((await api(page, `create_forum_post?forum_id=${forumId}&title=untagged&content=x`)).status).toBe(400);
        await page.evaluate(() => window.backToForum());
        await expect(page.locator('.forum-gallery')).toBeVisible({ timeout: 10000 });

        // Deleting the tag (from its dialog) removes it from the forum
        await page.locator('.forum-header-actions img[src*="settings"]').click();
        await page.locator('.forum-settings-tags .forum-tag-chip').click();
        await page.locator('.forum-dialog-delete').click();
        await acceptDialog(page);
        await expect(page.locator('.forum-settings-tags')).toHaveCount(0);
        saved = await forumContent(page, forumId);
        expect(saved.available_tags).toEqual([]);
        expect(saved.posts.find((p) => p.title === 'Needs a tag').tags).toEqual([]);
    });

    test('Channel settings act on the right channel (stale panel + forum delete)', async ({ page }) => {
        const suffix = Date.now();
        const { forumId } = await setupForum(page, `e2e_forum_chan_${suffix}`);
        const textId = await page.evaluate(() => Number(window.global.state.currentServer.dirs.channels[0].id));

        // Regression: #channels-params was rendered once and then reused, so opening the text
        // channel's settings and then the forum's kept the text channel (and its type).
        const openChannelSettings = async (selector) => {
            await page.locator(selector).click({ button: 'right' });
            await page.locator('#edit-channel-item').click();
            await expect(page.locator('#channels-params')).toBeVisible({ timeout: 5000 });
        };
        await openChannelSettings(`#channel-conv-${textId}`);
        expect(await page.evaluate(() => window.global.state.editingChannelType)).toBe('textual');
        await expect(page.locator('#forum-guidelines-input')).toHaveCount(0);
        await page.evaluate(() => window.closeMenu('#channels-params'));
        await openChannelSettings(`#channel-forum-${forumId}`);
        expect(await page.evaluate(() => window.global.state.editingChannelType)).toBe('forum');
        await expect(page.locator('#forum-guidelines-input')).toBeVisible();

        // Deleting from there deletes the forum (it used to be sent as channel_type=textual → 403)
        await page.locator('#channels-params .item.crit').click();
        await acceptDialog(page);
        await page.waitForFunction((id) =>
            !(window.global.state.currentServer.dirs.forums || []).some((c) => c.id == id), forumId, { timeout: 10000 });
        const status = await page.evaluate(async (id) => (await fetch('get_forum_content?channel_id=' + id)).status, forumId);
        expect(status).toBe(404);
        expect(await page.evaluate((id) =>
            (window.global.state.currentServer.dirs.channels || []).some((c) => c.id == id), textId)).toBe(true);
    });

    // Forum-post messages have place = the post id (not a textual channel): reactions,
    // manage-messages deletes and their WS fan-out must resolve it to the forum.
    test('Members react in a forum post; a moderator deletes a member reply live', async ({ browser }) => {
        const suffix = Date.now();
        const ownerCtx = await browser.newContext();
        const memberCtx = await browser.newContext();
        const owner = await ownerCtx.newPage();
        const member = await memberCtx.newPage();

        // Wait for each view to render: switching straight from the forum to the post
        // lets the forum template land last and hide the post.
        const openPost = async (page, forumId, postId) => {
            await openForum(page, forumId);
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

        // A plain member gets no admin controls (forum settings, pin/lock/delete of others' posts).
        // They stay in the DOM, hidden, so a permission change can show them live (access.mjs applyGates).
        await openForum(member, forumId);
        await expect(member.locator('.forum-header-actions img[src*="settings"]')).toBeHidden();
        await openPost(member, forumId, postId);
        await expect(member.locator('.forum-header-actions img[src*="flag"]')).toBeHidden();
        await expect(member.locator('.forum-header-actions img[src*="lock"]')).toBeHidden();
        await expect(member.locator('.forum-header-actions img[src*="trash"]')).toBeHidden();

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
        await acceptDialog(owner);   // delMsg() confirm

        // The member sees it disappear via the message_deleted WS notif
        await member.waitForFunction(({ postId, replyId }) =>
            !window.global.convs[postId].messages[replyId], { postId, replyId }, { timeout: 10000 });
        await expect(member.locator('.message .mdBlock').filter({ hasText: reply })).toHaveCount(0);

        await ownerCtx.close();
        await memberCtx.close();
    });
});
