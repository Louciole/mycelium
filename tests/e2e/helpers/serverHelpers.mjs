import { expect } from '@playwright/test';
import { recordCreatedServer } from './cleanupHelpers.mjs';

/**
 * Opens the server creation modal from the left sidebar.
 */
export async function openCreateServerModal(page) {
    await page.locator('#new-server').click();
    await page.locator('#create-server').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Navigates to the final creation step inside the server creation modal.
 */
export async function goToCreateServerFinalStep(page) {
    await page.locator('#createServerSteps .step').first().locator('.category').first().click();
    await page.locator('#createServerSteps .step').nth(1).locator('.btn.blue').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Creates a server through the UI and returns its new ID.
 * When `name` is given it is typed in the modal's name field; otherwise the
 * field is left empty and the server gets the default name ("New Server").
 */
export async function createServerViaUi(page, name) {
    const beforeServerIds = await getServerIds(page);

    await openCreateServerModal(page);
    await goToCreateServerFinalStep(page);

    if (name !== undefined) {
        await page.locator('#create-server-name').fill(name);
    }

    await page.locator('#createServerSteps .step').nth(1).locator('.btn.blue').click();

    await page.locator('#create-server').waitFor({ state: 'hidden', timeout: 10000 });

    await page.waitForFunction((previousIds) => {
        const ids = Object.values(window.global?.servers || {})
            .map((server) => Number(server?.id))
            .filter((id) => Number.isFinite(id));
        return ids.length > previousIds.length;
    }, beforeServerIds, { timeout: 10000 });

    const afterServerIds = await getServerIds(page);
    const createdServerId = afterServerIds.find((id) => !beforeServerIds.includes(id));

    expect(createdServerId).toBeTruthy();
    recordCreatedServer(page, createdServerId);
    return createdServerId;
}

/**
 * Returns current server IDs from global state.
 */
export async function getServerIds(page) {
    return page.evaluate(() => {
        return Object.values(window.global?.servers || {})
            .map((server) => Number(server?.id))
            .filter((id) => Number.isFinite(id))
            .sort((a, b) => a - b);
    });
}

/**
 * Opens a server from the sidebar using its ID.
 */
export async function openServerFromSidebarById(page, serverId) {
    const serverIndex = await page.evaluate((id) => {
        const servers = Object.values(window.global?.servers || {});
        return servers.findIndex((server) => Number(server.id) === Number(id));
    }, serverId);

    expect(serverIndex).toBeGreaterThanOrEqual(0);

    const serverIcons = page.locator('#servers .item.serveur');
    await expect(serverIcons).toHaveCount(serverIndex + 1, { timeout: 10000 });
    await serverIcons.nth(serverIndex).click();

    await page.waitForFunction((id) => {
        return Number(window.global?.state?.currentServer?.id) === Number(id)
            && window.global?.state?.isServer === true;
    }, serverId, { timeout: 10000 });
}

/**
 * Verifies the created server is loaded with at least one textual channel selected.
 */
export async function expectServerLoadedWithDefaultChannel(page, serverId) {
    await page.waitForFunction((id) => {
        const state = window.global?.state;
        const server = state?.currentServer;
        if (!server || Number(server.id) !== Number(id)) return false;

        const channels = server?.dirs?.channels || [];
        if (channels.length === 0) return false;

        const activeChan = state?.activeChan;
        return activeChan && activeChan.type === 'conv' && Number(activeChan.id) === Number(channels[0].id);
    }, serverId, { timeout: 10000 });
}

/**
 * Opens server settings panel (server parameters modal) for the currently open server.
 * The overview tab only exists with "manage-server": pass `{ overview: false }`
 * for a member who opens the settings through another right (e.g. manage-roles).
 */
export async function openServerSettings(page, { overview = true } = {}) {
    await page.locator('#server-infos').click();
    await page.locator('#server-settings').waitFor({ state: 'visible', timeout: 5000 });

    const paramsEntry = page.locator('#server-settings .item[onclick*="openServerParams"]');
    // Fallback for the flying-menu race: the dropdown can be re-rendered (hidden)
    // between the visibility check and the click when the server state refreshes.
    const clicked = await paramsEntry.isVisible().catch(() => false)
        && await paramsEntry.click({ timeout: 3000 }).then(() => true, () => false);
    if (!clicked) {
        await page.evaluate(() => {
            window.openServerParams();
        });
    }

    await page.locator('#server-params').waitFor({ state: 'visible', timeout: 5000 });
    if (overview) await page.locator('#name-input').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Closes server settings panel.
 */
export async function closeServerSettings(page) {
    await page.locator('#server-params .close').click();
    await page.locator('#server-params').waitFor({ state: 'hidden', timeout: 5000 });
}

/**
 * Changes server name and saves through the settings form.
 */
export async function changeServerName(page, newName) {
    await page.fill('#name-input', newName);
    const saveButton = page.locator('#formServer .btn.green');
    await saveButton.waitFor({ state: 'visible', timeout: 5000 });
    await saveButton.click();
    await page.waitForTimeout(300);

    const currentName = await page.evaluate(() => window.global?.state?.currentServer?.name);
    expect(currentName).toBe(newName);
}

/**
 * Uploads a new server icon through the image upload UI and returns resulting filename.
 */
export async function changeServerIcon(page) {
    const previousPfp = await page.evaluate(() => window.global?.state?.currentServer?.pfp || null);

    await page.locator('#setting-server-content .btn.blue').filter({ hasText: "Change server's icon" }).click();
    await page.locator('#loadImage').waitFor({ state: 'visible', timeout: 5000 });

    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3ZfZkAAAAASUVORK5CYII=';
    await page.setInputFiles('#fileInput', {
        name: 'server-icon.png',
        mimeType: 'image/png',
        buffer: Buffer.from(pngBase64, 'base64')
    });

    await page.locator('#resize-image').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#resize-image .btn.blue').click();
    await page.locator('#resize-image').waitFor({ state: 'hidden', timeout: 10000 });

    await page.waitForFunction((before) => {
        const current = window.global?.state?.currentServer?.pfp;
        return Boolean(current) && current !== before;
    }, previousPfp, { timeout: 10000 });

    const newPfp = await page.evaluate(() => window.global?.state?.currentServer?.pfp || null);
    expect(newPfp).toBeTruthy();
    return newPfp;
}

/**
 * Enables community mode if needed.
 */
export async function enableCommunityServer(page) {
    const checkbox = page.locator('#is-community-checkbox');
    await checkbox.waitFor({ state: 'attached', timeout: 5000 });

    if (!(await checkbox.isChecked())) {
        await page.locator('label.switch .slider').click({ force: true });
    }

    await page.waitForFunction(() => Boolean(window.global?.state?.currentServer?.is_community), undefined, { timeout: 10000 });
    await page.locator('#community-settings').waitFor({ state: 'visible', timeout: 5000 });
}

/**
 * Sets discoverable community metadata (description, language, tag).
 */
export async function setCommunityMetadata(page, { description, languageCode, tag }) {
    if (description) {
        await page.fill('#description-input', description);
        const saveButton = page.locator('#formServer .btn.green');
        await saveButton.waitFor({ state: 'visible', timeout: 5000 });
        await saveButton.click();
        await page.waitForTimeout(300);
    }

    if (languageCode) {
        await page.locator('#language-add-dropdown .dropdown-button').click();
        await page.locator(`#language-add-dropdown li[data-lang="${languageCode}"]`).click();
        await page.waitForFunction((lang) => {
            const langs = window.global?.state?.currentServer?.languages;
            if (!langs) return false;
            const arr = typeof langs === 'string' ? JSON.parse(langs) : langs;
            return Array.isArray(arr) && arr.includes(lang);
        }, languageCode, { timeout: 10000 });
    }

    if (tag) {
        await page.fill('#new-tag-input', tag);
        await page.locator('#add-tag-button').click();
        await page.waitForFunction((expectedTag) => {
            const tags = window.global?.state?.currentServer?.tags;
            if (!tags) return false;
            const arr = typeof tags === 'string' ? JSON.parse(tags) : tags;
            return Array.isArray(arr) && arr.includes(expectedTag);
        }, tag, { timeout: 10000 });
    }
}

/**
 * Asserts server settings persistence in global state for key editable fields.
 */
export async function expectServerSettingsPersisted(page, serverId, expected) {
    await page.waitForFunction(({ id, expectedData }) => {
        const server = Object.values(window.global?.servers || {}).find((s) => Number(s?.id) === Number(id));
        if (!server) return false;

        if (expectedData.name && server.name !== expectedData.name) return false;
        if (expectedData.pfp && server.pfp !== expectedData.pfp) return false;
        if (expectedData.description && server.description !== expectedData.description) return false;
        if (expectedData.isCommunity !== undefined && Boolean(server.is_community) !== Boolean(expectedData.isCommunity)) return false;

        if (expectedData.languageCode) {
            const langs = typeof server.languages === 'string' ? JSON.parse(server.languages || '[]') : (server.languages || []);
            if (!langs.includes(expectedData.languageCode)) return false;
        }

        if (expectedData.tag) {
            const tags = typeof server.tags === 'string' ? JSON.parse(server.tags || '[]') : (server.tags || []);
            if (!tags.includes(expectedData.tag)) return false;
        }

        return true;
    }, { id: serverId, expectedData: expected }, { timeout: 10000 });
}

/**
 * Opens discover servers menu and waits for initial content.
 */
export async function openDiscoverServersMenu(page) {
    await page.locator('#discover-servers').click();
    await page.locator('#discover-servers-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#discover-nav').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#discover-content').waitFor({ state: 'attached', timeout: 5000 });
}

/**
 * Searches discover menu by server name.
 */
export async function searchDiscoverServer(page, serverName) {
    const input = page.locator('#discover-search-smart');
    await input.fill(serverName);
    await input.dispatchEvent('input');
}

/**
 * Verifies discover card details and membership lock state for a server.
 */
export async function expectDiscoverCardForMember(page, { serverId, serverName, description, tag, languageCode }) {
    const card = page.locator(`.server-card[data-server-id="${serverId}"]`).first();
    await card.waitFor({ state: 'visible', timeout: 10000 });

    await expect(card.locator('h3')).toHaveText(serverName);
    await expect(card.locator('.server-description')).toContainText(description);
    await expect(card.locator('.server-card-icon img')).toHaveCount(1);
    await expect(card.locator('.server-tags .tag').filter({ hasText: tag })).toHaveCount(1);

    // State-level assertion for language code is robust against translated labels in UI.
    await page.waitForFunction(({ id, lang }) => {
        const discover = window.global?.discover?.servers;
        if (!discover) return false;
        const all = [...(discover.featured || []), ...(discover.regular || [])];
        const server = all.find((s) => Number(s.id) === Number(id));
        if (!server) return false;
        const langs = typeof server.languages === 'string' ? JSON.parse(server.languages || '[]') : (server.languages || []);
        return Array.isArray(langs) && langs.includes(lang);
    }, { id: serverId, lang: languageCode }, { timeout: 10000 });

    // Members get an "Ouvrir" button that opens the server instead of a join button.
    await expect(card.locator('button.discover-open')).toHaveCount(1);
    await expect(card.locator('button.discover-join')).toHaveCount(0);
}


