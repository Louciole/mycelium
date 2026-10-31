import { test, expect } from '@playwright/test';
import { loginUser, SERVER_URL } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import {
    changeServerName,
    createServerViaUi,
    enableCommunityServer,
    openDiscoverServersMenu,
    openServerFromSidebarById,
    openServerSettings,
    searchDiscoverServer,
    setCommunityMetadata
} from './helpers/serverHelpers.mjs';

const TEST_TIMEOUT = 120000;

/**
 * Discover is a page of the app layout (rail -> secondary column -> content),
 * not a fullscreen overlay: the rail stays usable and the page is routable.
 */
test.describe('Discover page - E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('discover lives in the app layout, filters with chips, and joins a server', async ({ page, browser }) => {
        const suffix = Date.now();
        // HTML in the name must be shown as text on the card, never parsed.
        const serverName = `<b>x</b> disc ${suffix}`;
        const tag = `d${suffix}`;
        const languageCode = 'ja';

        // Owner: a community server with a language and a tag.
        await loginUser(page, `e2e_discover_owner_${suffix}`);
        await waitForAppReady(page);
        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);
        await openServerSettings(page);
        await changeServerName(page, serverName);
        await enableCommunityServer(page);
        await setCommunityMetadata(page, { description: `Discover page ${suffix}`, languageCode, tag });
        await page.reload();
        await waitForAppReady(page);

        // 1) Opening Discover keeps the rail and selects the compass like a server.
        await openDiscoverServersMenu(page);

        // Every string of the page is translated (_t warns "traduction : <key> is missing").
        // Listen from a fresh render of the page only: other views have their own gaps.
        const missingEn = [];
        page.on('console', (m) => { if (m.text().startsWith('traduction :')) missingEn.push(m.text()); });
        await openDiscoverServersMenu(page);
        await expect(page.locator('#main-selector')).toBeVisible();
        await expect(page.locator('#discover-servers')).toHaveClass(/selected/);
        await expect(page.locator('#logo')).not.toHaveClass(/selected/);
        await expect(page.locator('#profile')).toBeVisible();
        await expect(page.locator('.fullscreen-menu')).toHaveCount(0);
        expect(page.url()).toContain('#discover');

        const card = page.locator(`.server-card[data-server-id="${serverId}"]`);

        // 2) A `tag:` token becomes a chip, the free text stays empty, results are filtered.
        const input = page.locator('#discover-search-smart');
        await input.pressSequentially(`tag:${tag} `);
        const tagChip = page.locator(`.discover-chip[data-kind="tag"][data-value="${tag}"]`);
        await expect(tagChip).toHaveCount(1);
        await expect(input).toHaveValue('');
        await expect(card).toHaveCount(1);
        await expect(page.locator('.server-card')).toHaveCount(1);

        // Name is escaped: literal text, no <b> element injected.
        await expect(card.locator('h3')).toHaveText(serverName);
        await expect(card.locator('h3 b')).toHaveCount(0);

        // Removing the chip drops the filter.
        await tagChip.locator('button').click();
        await expect(tagChip).toHaveCount(0);

        // 3) Autocomplete (the composer's @ popup): `tag:` lists existing tags.
        const popup = page.locator('#discover-autocomplete');
        await input.pressSequentially(`tag:${tag.slice(0, -1)}`);
        const tagSuggestion = popup.locator('.mention-ac-item[data-kind="tag"]', { hasText: `# ${tag}` });
        await expect(tagSuggestion).toHaveCount(1);
        await tagSuggestion.click();
        await expect(tagChip).toHaveCount(1);
        await expect(input).toHaveValue('');
        await tagChip.locator('button').click();
        await expect(tagChip).toHaveCount(0);

        // Keyboard: "la" suggests the `lang:` syntax, Tab inserts it, then languages are listed.
        await input.click();
        await input.pressSequentially('la');
        await expect(popup.locator('.mention-ac-item[data-kind="hint"]', { hasText: 'lang:' })).toHaveCount(1);
        await input.press('Tab');
        await expect(input).toHaveValue('lang:');
        await input.pressSequentially(languageCode);
        await expect(popup.locator('.mention-ac-item[data-kind="lang"]').first()).toContainText(languageCode);
        await input.press('Enter');
        const langChip = page.locator(`.discover-chip[data-kind="lang"][data-value="${languageCode}"]`);
        await expect(langChip).toHaveCount(1);
        await expect(input).toHaveValue('');
        await input.press('Escape');
        await expect(popup).toBeHidden();
        await langChip.locator('button').click();
        await expect(langChip).toHaveCount(0);

        // 4) Language dropdown in the secondary column (the app's .dropdown component).
        const langText = page.locator('#discover-lang-text');
        const allLanguages = await langText.textContent();
        await page.locator('#discover-lang-dropdown .dropdown-button').click();
        await expect(page.locator('#discover-lang-dropdown')).toHaveClass(/show/);
        await page.locator(`#discover-languages li[data-lang="${languageCode}"]`).click();
        await expect(page.locator('#discover-lang-dropdown')).not.toHaveClass(/show/);
        await expect(langChip).toHaveCount(1);
        await expect(langText).not.toHaveText(allLanguages);
        await expect(card).toHaveCount(1);
        // Backspace in the empty field removes the last chip, and the dropdown follows.
        await input.click();
        await input.press('Backspace');
        await expect(page.locator('.discover-chip')).toHaveCount(0);
        await expect(langText).toHaveText(allLanguages);

        // The secondary column never overflows horizontally.
        const overflow = await page.evaluate(() => {
            const nav = document.getElementById('discover-nav');
            return nav.scrollWidth - nav.clientWidth;
        });
        expect(overflow).toBe(0);
        expect(missingEn).toEqual([]);

        // Owner is a member: "Ouvrir", no join button.
        await searchDiscoverServer(page, `disc ${suffix}`);
        await expect(card.locator('button.discover-open')).toHaveCount(1);
        await expect(card.locator('button.discover-join')).toHaveCount(0);

        // 4) Rail navigation away and back: discover column is replaced, then restored.
        await openServerFromSidebarById(page, serverId);
        await expect(page.locator('#discover-nav')).toHaveCount(0);
        await expect(page.locator('#server-selector')).toBeVisible();
        await expect(page.locator('#discover-servers')).not.toHaveClass(/selected/);
        await openDiscoverServersMenu(page);
        await page.locator('#logo').click();
        await expect(page.locator('#friendCat')).toBeVisible();
        await expect(page.locator('#discover-nav')).toHaveCount(0);
        await expect(page.locator('#discover-servers')).not.toHaveClass(/selected/);

        // 5) Another user joins from the card, then opens the server from it.
        const context2 = await browser.newContext({ locale: 'fr-FR' });
        const page2 = await context2.newPage();
        try {
            await loginUser(page2, `e2e_discover_joiner_${suffix}`);
            await waitForAppReady(page2);

            // Deep link straight to the discover page.
            await page2.goto(`${SERVER_URL}/channels#discover`);
            await waitForAppReady(page2);
            await page2.locator('#discover-nav').waitFor({ state: 'visible', timeout: 10000 });
            await expect(page2.locator('#discover-servers')).toHaveClass(/selected/);
            const missingFr = [];
            page2.on('console', (m) => { if (m.text().startsWith('traduction :')) missingFr.push(m.text()); });
            await openDiscoverServersMenu(page2);

            await searchDiscoverServer(page2, `disc ${suffix}`);
            const card2 = page2.locator(`.server-card[data-server-id="${serverId}"]`);
            await card2.locator('button.discover-join').click();
            await expect(card2.locator('button.discover-open')).toHaveCount(1);
            await expect(page2.locator('#discover-lang-text')).toHaveText('Toutes les langues');
            expect(missingFr).toEqual([]);
            await page2.locator(`#server-item-${serverId}`).waitFor({ state: 'attached', timeout: 10000 });

            await card2.locator('button.discover-open').click();
            await page2.waitForFunction((id) => Number(window.global?.state?.currentServer?.id) === Number(id)
                && window.global?.state?.isServer === true, serverId, { timeout: 10000 });
            await expect(page2.locator('#discover-nav')).toHaveCount(0);
            await expect(page2.locator(`#server-item-${serverId}`)).toHaveClass(/selected/);
            await expect(page2.locator('#discover-servers')).not.toHaveClass(/selected/);
        } finally {
            await context2.close();
        }
    });
});
