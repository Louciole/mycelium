import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { reloadAndWaitForApp } from './helpers/messagingHelpers.mjs';
import {
    changeServerName,
    closeServerSettings,
    createServerViaUi,
    enableCommunityServer,
    openServerFromSidebarById,
    openServerSettings
} from './helpers/serverHelpers.mjs';

// Community server settings (server-main-settings.html): the community switch,
// description, languages and tags — how they behave in the settings UI, how they
// render, what edit_server_property accepts, and how they surface on Discover.

const TEST_TIMEOUT = 120000;

async function api(page, path, { method = 'POST' } = {}) {
    return page.evaluate(async ({ path, method }) => {
        const r = await fetch(path, { method, credentials: 'include' });
        return { status: r.status, text: await r.text() };
    }, { path, method });
}

function editProperty(page, serverId, property, value) {
    return api(page, `edit_server_property?server_id=${serverId}&property=${property}&value=${encodeURIComponent(value)}`);
}

/**
 * The server as the backend stores it, read through the Discover listing. The
 * listing is capped (50 servers) so we search by the unique token in its name.
 */
async function discoverEntry(page, serverId, token, extraQuery = '') {
    const res = await api(page, `get_discoverable_servers?search=${encodeURIComponent(token)}${extraQuery}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.text);
    return [...data.featured, ...data.regular].find((s) => Number(s.id) === Number(serverId)) || null;
}

function currentServer(page) {
    return page.evaluate(() => {
        const s = window.global.state.currentServer;
        const list = (v) => (typeof v === 'string' ? JSON.parse(v || '[]') : (v || []));
        return { name: s.name, description: s.description, isCommunity: Boolean(s.is_community), tags: list(s.tags), languages: list(s.languages) };
    });
}

async function addTag(page, tag, { withEnter = false } = {}) {
    await page.fill('#new-tag-input', tag);
    if (withEnter) await page.press('#new-tag-input', 'Enter');
    else await page.locator('#add-tag-button').click();
}

/** Picks a language in the app's .dropdown component (Settings > Language style). */
async function pickLanguage(page, code) {
    const before = await page.locator('.server-language-item').count();
    await page.locator('#language-add-dropdown .dropdown-button').click();
    await page.locator(`#language-add-dropdown li[data-lang="${code}"]`).click();
    await expect(page.locator('.server-language-item')).toHaveCount(before + 1);
}

let tokenSeq = 0;
function uniqueToken() {
    // + random: the tests of this file run in parallel workers, each with its own counter
    return `c${Date.now().toString(36)}${(tokenSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Logs in, creates a server named after a unique token and opens its settings. */
async function setupCommunityServer(page, account) {
    await loginUser(page, account);
    await waitForAppReady(page);
    const serverId = await createServerViaUi(page);
    await openServerFromSidebarById(page, serverId);
    await openServerSettings(page);
    const token = uniqueToken();
    await changeServerName(page, `Comm ${token}`);
    return { serverId, token };
}

/** Scrolls the settings pane (the scrollable ancestor of `selector`) to its very bottom. */
async function scrollSettingsToBottom(page, selector) {
    await page.evaluate((sel) => {
        let el = document.querySelector(sel);
        while (el && !(el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
        if (el) el.scrollTop = el.scrollHeight;
    }, selector);
}

function overlaps(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test.describe('Community server settings - E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('community switch shows the section, persists, and controls Discover visibility', async ({ page }) => {
        const { serverId, token } = await setupCommunityServer(page, `e2e_comm_switch_${Date.now()}`);

        await expect(page.locator('#community-settings')).toBeHidden();
        expect(await discoverEntry(page, serverId, token)).toBeNull();

        await enableCommunityServer(page);
        await expect(page.locator('#community-settings')).toBeVisible();
        expect(await discoverEntry(page, serverId, token)).not.toBeNull();

        // Metadata set while public is kept when the server goes private and back.
        await pickLanguage(page, 'fr');
        await expect(page.locator('.server-language-item')).toHaveCount(1);

        await page.locator('label.switch .slider').click();
        await expect(page.locator('#community-settings')).toBeHidden();
        await expect.poll(async () => (await currentServer(page)).isCommunity).toBe(false);
        expect(await discoverEntry(page, serverId, token)).toBeNull();

        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        await openServerSettings(page);
        await expect(page.locator('#is-community-checkbox')).not.toBeChecked();
        await expect(page.locator('#community-settings')).toBeHidden();

        await enableCommunityServer(page);
        await expect(page.locator('.server-language-item')).toHaveCount(1);
        expect((await discoverEntry(page, serverId, token)).languages).toEqual(['fr']);
    });

    test('a refused community switch is rolled back in the UI', async ({ page }) => {
        const { serverId, token } = await setupCommunityServer(page, `e2e_comm_refused_${Date.now()}`);

        await page.route('**/edit_server_property?*property=is_community*', (route) =>
            route.fulfill({ status: 403, body: 'Only server owner can change community status' }));
        await page.locator('label.switch .slider').click();

        await expect(page.locator('#is-community-checkbox')).not.toBeChecked();
        await expect(page.locator('#community-settings')).toBeHidden();
        expect((await currentServer(page)).isCommunity).toBe(false);
        expect(await discoverEntry(page, serverId, token)).toBeNull();
    });

    test('languages: add several, labelled with their name, no duplicates, remove, persist', async ({ page }) => {
        const { serverId, token } = await setupCommunityServer(page, `e2e_comm_langs_${Date.now()}`);
        await enableCommunityServer(page);

        await expect(page.locator('#languages-selector')).toContainText(/no language|aucune langue/i);
        for (const code of ['fr', 'en', 'ja']) {
            await pickLanguage(page, code);
            // The menu closes after each pick.
            await expect(page.locator('#language-add-dropdown .dropdown-menu')).toBeHidden();
        }
        await expect(page.locator('.server-language-item')).toHaveCount(3);
        // Chips show the language name, like the picker does — not a bare code.
        await expect(page.locator('.server-language-item').first()).toContainText('Français');
        await expect(page.locator('.server-language-item').nth(2)).toContainText('日本語');

        // A language already picked is no longer offered.
        await expect(page.locator('#language-add-dropdown li[data-lang="fr"]')).toHaveCount(0);
        await expect(page.locator('#language-add-dropdown li[data-lang="de"]')).toHaveCount(1);

        await page.locator('.server-language-item').filter({ hasText: 'English' }).locator('button').click();
        await expect(page.locator('.server-language-item')).toHaveCount(2);
        expect((await currentServer(page)).languages).toEqual(['fr', 'ja']);
        await expect(page.locator('#language-add-dropdown li[data-lang="en"]')).toHaveCount(1);

        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        await openServerSettings(page);
        await expect(page.locator('.server-language-item')).toHaveCount(2);
        expect((await discoverEntry(page, serverId, token)).languages).toEqual(['fr', 'ja']);
    });

    test('tags: button and Enter, trimmed, no duplicates, limits, remove, persist', async ({ page }) => {
        const { serverId, token } = await setupCommunityServer(page, `e2e_comm_tags_${Date.now()}`);
        await enableCommunityServer(page);

        await addTag(page, '  Gaming  ');
        await expect(page.locator('.server-tag-item')).toHaveCount(1);
        await expect(page.locator('#new-tag-input')).toHaveValue('');

        await addTag(page, 'chill', { withEnter: true });
        await expect(page.locator('.server-tag-item')).toHaveCount(2);
        await expect(page.locator('#new-tag-input')).toHaveValue('');

        // Same tag with another case is a duplicate: refused with a visible message.
        await addTag(page, 'gaming');
        await expect(page.locator('#server-tag-error')).toBeVisible();
        await expect(page.locator('.server-tag-item')).toHaveCount(2);

        // Tags are capped at 20 characters by the input itself.
        await page.fill('#new-tag-input', 'x'.repeat(30));
        expect((await page.inputValue('#new-tag-input')).length).toBe(20);

        // At most 10 tags.
        for (let i = 3; i <= 10; i++) await addTag(page, `tag${i}`);
        await expect(page.locator('.server-tag-item')).toHaveCount(10);
        await addTag(page, 'one-too-many');
        await expect(page.locator('#server-tag-error')).toBeVisible();
        await expect(page.locator('.server-tag-item')).toHaveCount(10);

        await page.locator('.server-tag-item').filter({ hasText: 'chill' }).locator('button').click();
        await expect(page.locator('.server-tag-item')).toHaveCount(9);
        const tags = (await currentServer(page)).tags;
        expect(tags[0]).toBe('Gaming');
        expect(tags).not.toContain('chill');

        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        expect((await currentServer(page)).tags).toEqual(tags);
        expect((await discoverEntry(page, serverId, token)).tags).toEqual(tags);
    });

    test('a tag the server refuses is not added to the UI', async ({ page }) => {
        await setupCommunityServer(page, `e2e_comm_tagfail_${Date.now()}`);
        await enableCommunityServer(page);

        await page.route('**/edit_server_property?*property=tags*', (route) => route.fulfill({ status: 400, body: 'nope' }));
        await addTag(page, 'refused');
        await expect(page.locator('#server-tag-error')).toBeVisible();
        await expect(page.locator('.server-tag-item')).toHaveCount(0);
        expect((await currentServer(page)).tags).toEqual([]);
    });

    test('description and name: saved, persisted, shown on the Discover card', async ({ page }) => {
        const suffix = Date.now();
        const { serverId, token } = await setupCommunityServer(page, `e2e_comm_desc_${suffix}`);
        await enableCommunityServer(page);

        const name = `Renamed ${token}`;
        const description = `Un serveur pour parler de tout ${suffix}.`;
        await page.fill('#name-input', name);
        await page.fill('#description-input', description);
        await page.locator('#formServer .btn.green').click();
        await expect(page.locator('#formServer')).toBeHidden();

        await expect.poll(async () => (await discoverEntry(page, serverId, token))?.description).toBe(description);
        expect((await discoverEntry(page, serverId, token)).name).toBe(name);

        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        await openServerSettings(page);
        await expect(page.locator('#name-input')).toHaveValue(name);
        await expect(page.locator('#description-input')).toHaveValue(description);

        // The name is capped by the DB column (varchar 44): the input says so too.
        await page.fill('#name-input', 'n'.repeat(60));
        expect((await page.inputValue('#name-input')).length).toBe(44);
    });

    test('filling everything (unsaved text, then languages and tags) saves everything', async ({ page }) => {
        const { serverId, token } = await setupCommunityServer(page, `e2e_comm_all_${Date.now()}`);
        await enableCommunityServer(page);

        // Text fields first, left unsaved while the lists are edited (they save instantly).
        const name = `All ${token}`;
        const description = `Tout rempli ${token}`;
        await page.fill('#name-input', name);
        await page.fill('#description-input', description);
        await pickLanguage(page, 'fr');
        await addTag(page, 'first');
        await pickLanguage(page, 'de');
        await addTag(page, 'second', { withEnter: true });

        // The pending text edits survive the list updates, and the save bar is still there.
        await expect(page.locator('#description-input')).toHaveValue(description);
        await expect(page.locator('#name-input')).toHaveValue(name);
        await expect(page.locator('#formServer')).toBeVisible();
        await page.locator('#formServer .btn.green').click();
        await expect(page.locator('#formServer')).toBeHidden();

        // Then a second round on an already-filled server.
        await page.fill('#description-input', `${description} (v2)`);
        await addTag(page, 'third');
        await page.locator('#formServer .btn.green').click();

        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        const entry = await discoverEntry(page, serverId, token);
        expect(entry).toMatchObject({ name, description: `${description} (v2)`, languages: ['fr', 'de'], tags: ['first', 'second', 'third'] });
        await openServerSettings(page);
        await expect(page.locator('#description-input')).toHaveValue(`${description} (v2)`);
        await expect(page.locator('.server-language-item')).toHaveCount(2);
        await expect(page.locator('.server-tag-item')).toHaveCount(3);
    });

    test('user-provided values render as text, not HTML', async ({ page }) => {
        const { serverId, token } = await setupCommunityServer(page, `e2e_comm_xss_${Date.now()}`);
        await enableCommunityServer(page);

        const name = `Le "serveur" <b> ${token}`;
        const description = '</textarea><img src=x onerror="window.__pwned=1">';
        const tag = '<b id=pwn>t</b>';
        expect((await editProperty(page, serverId, 'name', name)).status).toBe(200);
        expect((await editProperty(page, serverId, 'description', description)).status).toBe(200);
        expect((await editProperty(page, serverId, 'tags', JSON.stringify([tag]))).status).toBe(200);

        await closeServerSettings(page);
        await reloadAndWaitForApp(page);
        await openServerFromSidebarById(page, serverId);
        // The server header shows the name as text too.
        await expect(page.locator('#server-infos h1')).toHaveText(name);
        await expect(page.locator('#server-infos h1 b')).toHaveCount(0);
        await openServerSettings(page);

        await expect(page.locator('#name-input')).toHaveValue(name);
        await expect(page.locator('#description-input')).toHaveValue(description);
        await expect(page.locator('.server-tag-item').first()).toContainText(tag);
        await expect(page.locator('#pwn')).toHaveCount(0);
        expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    });

    test('layout: icon slug centred, controls aligned and readable, save bar never hides the form', async ({ page }) => {
        await setupCommunityServer(page, `e2e_comm_layout_${Date.now()}`);

        // The icon placeholder shows the server's initials in the middle of the circle.
        const icon = await page.evaluate(() => {
            const circle = document.querySelector('#setting-server-content .circle');
            const text = [...circle.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
                || circle.querySelector('span');
            const range = document.createRange();
            range.selectNodeContents(text);
            const t = range.getBoundingClientRect();
            const c = circle.getBoundingClientRect();
            return { dx: Math.abs((t.x + t.width / 2) - (c.x + c.width / 2)), dy: Math.abs((t.y + t.height / 2) - (c.y + c.height / 2)), h: t.height };
        });
        expect(icon.dx).toBeLessThan(4);
        expect(icon.dy).toBeLessThan(4);
        expect(icon.h).toBeGreaterThan(20);

        await enableCommunityServer(page);
        for (const t of ['alpha', 'beta', 'gamma']) await addTag(page, t);

        // Form controls use the app font, and line up on the same right edge.
        const controls = await page.evaluate(() => {
            const font = getComputedStyle(document.querySelector('#setting-server-content h1')).fontFamily;
            const sels = ['#name-input', '#description-input', '#language-add-dropdown .dropdown-button', '#new-tag-input'];
            const right = (sel) => document.querySelector(sel).getBoundingClientRect().right;
            return {
                font,
                fonts: Object.fromEntries(sels.map((sel) => [sel, getComputedStyle(document.querySelector(sel)).fontFamily])),
                descriptionRight: right('#description-input'),
                languageRight: right('#language-add-dropdown .dropdown-button'),
                addRight: right('#add-tag-button'),
                addBorder: getComputedStyle(document.getElementById('add-tag-button')).borderTopWidth
            };
        });
        for (const [sel, f] of Object.entries(controls.fonts)) expect(f, `${sel} font`).toBe(controls.font);
        expect(Math.abs(controls.descriptionRight - controls.languageRight)).toBeLessThan(2);
        expect(Math.abs(controls.addRight - controls.languageRight)).toBeLessThan(2);
        expect(controls.addBorder).toBe('0px');

        // Tag and description inputs show how many characters are left.
        await page.fill('#new-tag-input', 'hello');
        await expect(page.locator('#new-tag-counter')).toHaveText('15');
        await page.press('#new-tag-input', 'Enter');
        await expect(page.locator('#new-tag-counter')).toHaveText('20');
        await page.fill('#description-input', 'abc');
        await expect(page.locator('#description-input + .community-counter')).toHaveText('497');

        // The storage bar's empty track is visible against the settings background.
        const storage = await page.evaluate(() => {
            const track = document.querySelector('#setting-server-content .storage-bar');
            return { track: getComputedStyle(track).backgroundColor, panel: getComputedStyle(document.getElementById('setting-panel')).backgroundColor, width: track.getBoundingClientRect().width };
        });
        expect(storage.track).not.toBe(storage.panel);
        expect(storage.width).toBeGreaterThan(100);

        // With unsaved changes, the floating save bar must not cover the bottom of the form.
        await page.fill('#description-input', 'unsaved');
        const bar = page.locator('#formServer');
        await expect(bar).toBeVisible();
        await scrollSettingsToBottom(page, '#new-tag-input');
        const barBox = await bar.boundingBox();
        for (const sel of ['#new-tag-input', '#add-tag-button', '.server-tag-item >> nth=0', '.server-tag-item >> nth=2']) {
            const box = await page.locator(sel).boundingBox();
            expect(overlaps(barBox, box), `save bar covers ${sel}`).toBe(false);
        }
    });

    test('edit_server_property validates community values', async ({ page }) => {
        const { serverId, token } = await setupCommunityServer(page, `e2e_comm_api_${Date.now()}`);
        const edit = (p, v) => editProperty(page, serverId, p, v).then((r) => r.status);

        expect(await edit('is_community', 'yes')).toBe(400);
        expect(await edit('is_community', 'true')).toBe(200);

        expect(await edit('tags', 'not json')).toBe(400);
        expect(await edit('tags', '"gaming"')).toBe(400);
        expect(await edit('tags', '[1, 2]')).toBe(400);
        expect(await edit('tags', JSON.stringify(['ok', 'x'.repeat(21)]))).toBe(400);
        expect(await edit('tags', JSON.stringify(['   ']))).toBe(400);
        expect(await edit('tags', JSON.stringify(['Gaming', 'gaming']))).toBe(400);
        expect(await edit('tags', JSON.stringify(Array.from({ length: 11 }, (_, i) => `t${i}`)))).toBe(400);
        expect(await edit('tags', JSON.stringify([' padded ', 'Two']))).toBe(200);
        expect((await discoverEntry(page, serverId, token)).tags).toEqual(['padded', 'Two']);

        expect(await edit('languages', '{"fr": 1}')).toBe(400);
        expect(await edit('languages', JSON.stringify(["fr');alert(1);('"]))).toBe(400);
        expect(await edit('languages', JSON.stringify(['fr', 'fr']))).toBe(400);
        expect(await edit('languages', JSON.stringify(['fr', 'en']))).toBe(200);
        expect((await discoverEntry(page, serverId, token)).languages).toEqual(['fr', 'en']);

        expect(await edit('description', 'd'.repeat(501))).toBe(400);
        expect(await edit('description', 'd'.repeat(500))).toBe(200);

        expect(await edit('name', '   ')).toBe(400);
        expect(await edit('name', 'n'.repeat(45))).toBe(400);

        expect(await edit('member_count', '9999')).toBe(403);
        expect(await edit('no_such_property', '1')).toBe(400);
    });

    test('only the owner can change community settings', async ({ browser }) => {
        const suffix = Date.now();
        const ownerCtx = await browser.newContext();
        const memberCtx = await browser.newContext();
        const owner = await ownerCtx.newPage();
        const member = await memberCtx.newPage();
        try {
            await loginUser(owner, `e2e_comm_owner_${suffix}`);
            await waitForAppReady(owner);
            const serverId = await createServerViaUi(owner);
            const token = uniqueToken();
            expect((await editProperty(owner, serverId, 'name', `Comm ${token}`)).status).toBe(200);
            expect((await editProperty(owner, serverId, 'is_community', 'true')).status).toBe(200);

            await loginUser(member, `e2e_comm_member_${suffix}`);
            await waitForAppReady(member);
            expect((await api(member, `join_community_server?server_id=${serverId}`)).status).toBe(200);

            expect((await editProperty(member, serverId, 'is_community', 'false')).status).toBe(403);
            expect((await editProperty(member, serverId, 'tags', '["hijack"]')).status).toBe(403);
            expect((await editProperty(member, serverId, 'languages', '["ru"]')).status).toBe(403);
            expect((await editProperty(member, serverId, 'description', 'hijack')).status).toBe(403);

            const entry = await discoverEntry(owner, serverId, token);
            expect(entry.tags).toEqual([]);
            expect(entry.languages).toEqual([]);
            expect(entry.description).toBeNull();
        } finally {
            await ownerCtx.close();
            await memberCtx.close();
        }
    });

    test('Discover filters by tag whatever its case, from the card chip', async ({ page }) => {
        const suffix = Date.now();
        const { serverId, token } = await setupCommunityServer(page, `e2e_comm_filter_${suffix}`);
        const tag = `MixedCase${suffix % 100000}`;
        const name = `Comm ${token}`;
        expect((await editProperty(page, serverId, 'is_community', 'true')).status).toBe(200);
        expect((await editProperty(page, serverId, 'tags', JSON.stringify([tag]))).status).toBe(200);

        const q = (t) => `&tags=${encodeURIComponent(JSON.stringify([t]))}`;
        expect(await discoverEntry(page, serverId, token, q(tag))).not.toBeNull();
        expect(await discoverEntry(page, serverId, token, q(tag.toLowerCase()))).not.toBeNull();
        expect(await discoverEntry(page, serverId, token, q('nope' + suffix))).toBeNull();

        // Clicking the tag on the card filters the list — and keeps this server in it.
        await closeServerSettings(page);
        await page.locator('#discover-servers').click();
        await page.locator('#discover-search-smart').fill(name);
        const card = page.locator(`.server-card[data-server-id="${serverId}"]`);
        await expect(card).toBeVisible();
        await card.locator('.server-tags .tag').filter({ hasText: tag }).click();
        await expect(page.locator(`.server-card[data-server-id="${serverId}"]`)).toBeVisible();
    });
});
