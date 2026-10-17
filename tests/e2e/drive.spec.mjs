import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { createServerViaUi, openServerFromSidebarById } from './helpers/serverHelpers.mjs';
import { reloadAndWaitForApp } from './helpers/messagingHelpers.mjs';
import { api, json, enc, createChannel, setupServer, openServer } from './helpers/permissionHelpers.mjs';
import { acceptDialog } from './helpers/dialogHelpers.mjs';

const TEST_TIMEOUT = 120000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Uploads a text file through the API (same request as the UI). Returns its id. */
async function uploadText(page, driveId, filename, text, folderId = null) {
    return page.evaluate(async ({ driveId, filename, text, folderId }) => {
        const file = 'data:text/plain;base64,' + btoa(unescape(encodeURIComponent(text)));
        const url = `/upload_drive_file?drive_id=${driveId}&filename=${encodeURIComponent(filename)}`
            + (folderId ? `&parent_folder=${folderId}` : '');
        const r = await fetch(url, { method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
        if (!r.ok) throw new Error(`upload ${r.status}`);
        return (await r.json()).file_id;
    }, { driveId, filename, text, folderId });
}

const createFolder = async (page, driveId, name, parent = null) =>
    (await json(page, `/create_drive_folder?drive_id=${driveId}&foldername=${enc(name)}` + (parent ? `&parent_folder=${parent}` : ''))).folder_id;

const renameChannel = (page, serverId, chan, name, type) => api(page,
    `/edit_server_channel?server_id=${serverId}&action=edit&field=name&value=${enc(name)}&targetId=${chan}&channel_type=${type}`);

/** Opens a drive from the sidebar and waits for its listing. */
async function openDrive(page, driveId) {
    await page.locator(`#channel-drive-${driveId}`).click();
    await page.waitForFunction((id) => {
        const d = window.global?.drive;
        return d && Number(d.id) === Number(id) && !d.loading && document.getElementById('drive-view');
    }, driveId, { timeout: 10000 });
}

const fileItem = (page, id) => page.locator(`.drive-file-item[data-file-id="${id}"]`);
const folderItem = (page, id) => page.locator(`.drive-folder-item[data-folder-id="${id}"]`);
const menuItem = (page, label) => page.locator('.drive-context-menu .drive-context-item', { hasText: label });

/** Sends `text` in the open text channel and waits for the server-confirmed message. */
async function sendRaw(page, text) {
    const input = page.locator('.chat-input textarea.selected');
    await input.fill(text);
    await input.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction((body) => {
        const messages = window.global?.convs?.[window.global.state.activeConv]?.messages || {};
        return Object.values(messages).some(m => m?.body === body && !String(m.id).startsWith('tmp_'));
    }, text, { timeout: 10000 });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Drive — E2E', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('browse, upload, rename, move, view and delete like Google Drive', async ({ page }) => {
        const suffix = Date.now();
        await loginUser(page, `e2e_drive_${suffix}`);
        await waitForAppReady(page);

        const serverId = await createServerViaUi(page);
        await openServerFromSidebarById(page, serverId);
        const driveId = await createChannel(page, serverId, 'drive');
        await openServer(page, serverId);
        await openDrive(page, driveId);

        // ── URL follows the drive ─────────────────────────────────────────────
        await expect(page).toHaveURL(new RegExp(`#${serverId}/${driveId}$`));
        await expect(page.locator('.drive-empty')).toBeVisible();

        // ── Menus toggle on their button; the member list opens ───────────────
        await page.locator('.drive-chip[data-filter="type"]').click();
        await expect(page.locator('.drive-context-menu')).toBeVisible();
        await page.locator('.drive-chip[data-filter="type"]').click();
        await expect(page.locator('.drive-context-menu')).toHaveCount(0);
        await page.locator('#drive-view .selected-info img[src$="group.svg"]').click();
        await expect(page.locator('#member-list')).toBeVisible();

        // ── Upload through New › Upload files ─────────────────────────────────
        const filename = `rapport-${suffix}.txt`;
        await page.locator('#drive-new-btn').click();
        const [chooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            menuItem(page, 'Upload files').click(),
        ]);
        await chooser.setFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from(`Hello ${suffix}`) });
        const card = page.locator('.drive-file-item', { hasText: filename });
        await expect(card).toBeVisible({ timeout: 15000 });
        await expect(card.locator('.drive-preview-text pre')).toContainText(`Hello ${suffix}`);
        const fileId = Number(await card.getAttribute('data-file-id'));

        // ── New › New folder (prompt) ─────────────────────────────────────────
        await page.locator('#drive-new-btn').click();
        await menuItem(page, 'New folder').click();
        expect((await acceptDialog(page, `Dossier ${suffix}`)).kind).toBe('prompt');
        const folder = page.locator('.drive-folder-item', { hasText: `Dossier ${suffix}` });
        await expect(folder).toBeVisible();
        const folderId = Number(await folder.getAttribute('data-folder-id'));

        // Names are escaped (no HTML injection through a file name)
        await uploadText(page, driveId, `<img src=x onerror="window.__xss=1">.txt`, 'x');
        await page.evaluate(() => window.reloadDrive());
        await expect(page.locator('.drive-file-item', { hasText: '<img src=x' })).toBeVisible();
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();

        // ── Rename via the ⋮ menu ─────────────────────────────────────────────
        await fileItem(page, fileId).locator('.drive-more').click();
        await menuItem(page, 'Rename').click();
        await acceptDialog(page, `final-${suffix}.txt`);
        await expect(fileItem(page, fileId).locator('.drive-item-name')).toHaveText(`final-${suffix}.txt`);

        // ── Selection bar + Move to… dialog ───────────────────────────────────
        await fileItem(page, fileId).click();
        await expect(page.locator('.drive-selection-count')).toBeVisible();
        await page.locator('.drive-selection-bar .drive-bar-btn', { hasText: 'Move' }).click();
        await expect(page.locator('#drive-dialog')).toBeVisible();
        await expect(page.locator('#drive-move-here')).toBeDisabled();   // already here
        await page.locator(`[data-move-folder="${folderId}"]`).click();
        await expect(page.locator('#drive-move-here')).toBeEnabled();
        await page.locator('#drive-move-here').click();
        await expect(fileItem(page, fileId)).toHaveCount(0);

        // ── Open the folder: URL, breadcrumb, back button ─────────────────────
        await folder.dblclick();
        await expect(page).toHaveURL(new RegExp(`#${serverId}/${driveId}/folder/${folderId}$`));
        await expect(page.locator('.drive-crumb.current')).toContainText(`Dossier ${suffix}`);
        await expect(fileItem(page, fileId)).toBeVisible();

        await page.locator('.drive-crumb[data-crumb="null"]').click();
        await expect(folderItem(page, folderId)).toBeVisible();
        await page.goBack();
        await expect(fileItem(page, fileId)).toBeVisible();

        // ── A folder URL survives a reload ────────────────────────────────────
        await reloadAndWaitForApp(page);
        await page.waitForFunction((id) => Number(window.global?.drive?.folder) === Number(id) && !window.global.drive.loading, folderId, { timeout: 15000 });
        await expect(fileItem(page, fileId)).toBeVisible();

        // ── Viewer (double-click), its own URL, Escape closes ─────────────────
        await fileItem(page, fileId).dblclick();
        await expect(page.locator('#drive-viewer')).toBeVisible();
        await expect(page.locator('#drive-viewer .drive-viewer-text')).toContainText(`Hello ${suffix}`);
        await expect(page).toHaveURL(new RegExp(`#${serverId}/${driveId}/file/${fileId}$`));
        await page.keyboard.press('Escape');
        await expect(page.locator('#drive-viewer')).toHaveCount(0);
        await expect(page).toHaveURL(new RegExp(`/folder/${folderId}$`));

        // ── List view, kept after a reload ────────────────────────────────────
        await page.locator('#drive-view-list').click();
        await expect(page.locator(`.drive-row[data-file-id="${fileId}"]`)).toBeVisible();
        await expect(page.locator('.drive-list-head')).toContainText('Owner');
        await reloadAndWaitForApp(page);
        await expect(page.locator(`.drive-row[data-file-id="${fileId}"]`)).toBeVisible({ timeout: 15000 });
        await page.locator('#drive-view-grid').click();

        // ── Details panel ─────────────────────────────────────────────────────
        await fileItem(page, fileId).click();
        await page.locator('#drive-details-btn').click();
        await expect(page.locator(`.drive-details[data-details-id="${fileId}"]`)).toContainText('TXT');

        // ── Touch screens: a tap opens, a long press starts a selection ───────
        await page.keyboard.press('Escape');
        await page.evaluate(() => { window.global.state.isMobile = true; });
        await fileItem(page, fileId).dispatchEvent('touchstart');
        await page.waitForTimeout(700);
        await fileItem(page, fileId).dispatchEvent('touchend');
        await fileItem(page, fileId).click();                      // the click ending the press
        await expect(page.locator('.drive-selection-count')).toBeVisible();
        expect(await page.evaluate(() => window.global.driveSelection.length)).toBe(1);
        await page.evaluate(() => { window.global.state.isMobile = false; });
        await page.keyboard.press('Escape');

        // ── Type filter ───────────────────────────────────────────────────────
        await page.locator('.drive-crumb[data-crumb="null"]').click();
        await page.locator('.drive-chip[data-filter="type"]').click();
        await menuItem(page, 'Folders').click();
        await expect(folderItem(page, folderId)).toBeVisible();
        await expect(page.locator('.drive-file-item')).toHaveCount(0);
        await page.locator('.drive-chip[data-filter="type"] .drive-chip-clear').click();
        await expect(page.locator('.drive-file-item')).toHaveCount(1);

        // ── Delete the folder (and the file inside) from the selection bar ────
        await folderItem(page, folderId).click();
        await page.locator('.drive-selection-bar .drive-bar-btn.danger').click();
        expect((await acceptDialog(page)).kind).toBe('confirm');
        await expect(folderItem(page, folderId)).toHaveCount(0);
        const left = await json(page, `/list_drive?drive_id=${driveId}`);
        expect(left.folders).toHaveLength(0);
    });

    test('drive links in messages and notes, and the # autocomplete', async ({ browser }) => {
        const { owner, serverId, members, stamp, close } = await setupServer(browser, 'drivelinks', 1);
        const member = members[0].page;
        try {
            const driveName = `docs${stamp}`;
            const driveId = await createChannel(owner, serverId, 'drive');
            await renameChannel(owner, serverId, driveId, driveName, 'drive');
            const folderId = await createFolder(owner, driveId, 'Eseo');
            const fileId = await uploadText(owner, driveId, `rapport-${stamp}.txt`, 'contenu', folderId);

            const privateDrive = await createChannel(owner, serverId, 'drive');
            await api(owner, `/edit_channel_permissions?channelId=${privateDrive}&channelType=drive&action=togglePrivacy`);
            const secretId = await uploadText(owner, privateDrive, `secret-${stamp}.txt`, 'secret');
            const noteName = `memo${stamp}`;
            const noteId = await createChannel(owner, serverId, 'note');
            await renameChannel(owner, serverId, noteId, noteName, 'note');

            await openServer(owner, serverId);

            // ── # autocomplete browses the drive and inserts a file link ──────
            const input = owner.locator('.chat-input textarea.selected');
            await input.click();
            await owner.keyboard.type(`#${driveName.slice(0, 6)}`);
            await expect(owner.locator('.mention-ac-item', { hasText: driveName })).toBeVisible();
            await owner.keyboard.press('Tab');                      // "#docs…/" — inside the drive
            await expect(input).toHaveValue(`#${driveName}/`);
            await expect(owner.locator('.mention-ac-item', { hasText: 'Eseo' })).toBeVisible();
            await owner.keyboard.type('Eseo/rap');
            await expect(owner.locator('.mention-ac-item', { hasText: `rapport-${stamp}.txt` })).toBeVisible();
            await owner.keyboard.press('Enter');
            await expect(input).toHaveValue(`<#drive:${driveId}/f:${fileId}> `);
            await input.fill('');

            // Notes ids may equal textual ones: the token names the type
            await owner.keyboard.type(`#${noteName}`);
            await owner.locator('.mention-ac-item', { hasText: noteName }).first().waitFor();
            await owner.keyboard.press('Enter');
            await expect(input).toHaveValue(`<#notes:${noteId}> `);
            await input.fill('');
            await sendRaw(owner, `<#notes:${noteId}>`);
            await expect(owner.locator(`.mention-channel[data-channel-id="notes:${noteId}"]`).last()).toHaveText(`#${noteName}`);

            // ── A lone file link renders as a chip + a card ───────────────────
            const fileRef = `drive:${driveId}/f:${fileId}`;
            await sendRaw(owner, `<#${fileRef}>`);
            const chip = owner.locator(`.mention-channel[data-channel-id="${fileRef}"]`).last();
            await expect(chip).toHaveText(`#${driveName} › rapport-${stamp}.txt`);
            await expect(owner.locator(`.drive-link-card[data-drive-card="${fileRef}"]`).last()).toContainText('Eseo');

            // Folder link, drive link, and a link to a private drive's file
            await sendRaw(owner, `voir <#drive:${driveId}/d:${folderId}> et <#drive:${driveId}> et <#drive:${privateDrive}/f:${secretId}>`);
            await expect(owner.locator(`.mention-channel[data-channel-id="drive:${driveId}/d:${folderId}"]`).last()).toHaveText(`#${driveName} › Eseo`);
            await expect(owner.locator(`.mention-channel[data-channel-id="drive:${driveId}"]`).last()).toHaveText(`#${driveName}`);
            const privateName = await owner.evaluate((id) => window.global.state.currentServer.dirs.drives.find(d => d.id === id).name, privateDrive);
            await expect(owner.locator(`.mention-channel[data-channel-id="drive:${privateDrive}/f:${secretId}"]`).last()).toHaveText(`#${privateName} › secret-${stamp}.txt`);

            // The member can't see the private drive: no name, no card
            await openServer(member, serverId);
            const denied = member.locator(`.mention-channel[data-channel-id="drive:${privateDrive}/f:${secretId}"]`).last();
            await expect(denied).toHaveText('#inaccessible item');
            await expect(denied).toHaveClass(/mention-denied/);
            await expect(member.locator(`.mention-channel[data-channel-id="${fileRef}"]`).last()).toHaveText(`#${driveName} › rapport-${stamp}.txt`);

            // ── Clicking a file link opens the drive on that file ─────────────
            await member.locator(`.drive-link-card[data-drive-card="${fileRef}"]`).last().click();
            await expect(member.locator(`#drive-viewer[data-file-id="${fileId}"]`)).toBeVisible();
            await expect(member).toHaveURL(new RegExp(`#${serverId}/${driveId}/file/${fileId}$`));
            await member.keyboard.press('Escape');
            await expect(member.locator('.drive-crumb.current')).toContainText('Eseo');

            // A folder link
            await member.goBack();
            await member.waitForFunction(() => window.global?.state?.activeChan?.type === 'conv', undefined, { timeout: 10000 });
            await member.locator(`.mention-channel[data-channel-id="drive:${driveId}/d:${folderId}"]`).last().click();
            await member.waitForFunction((id) => Number(window.global?.drive?.folder) === Number(id), folderId, { timeout: 10000 });

            // The viewer belongs to the drive view: Back to the conversation closes it
            await member.goBack();
            await member.waitForFunction(() => window.global?.state?.activeChan?.type === 'conv', undefined, { timeout: 10000 });
            await member.locator(`.drive-link-card[data-drive-card="${fileRef}"]`).last().click();
            await expect(member.locator(`#drive-viewer[data-file-id="${fileId}"]`)).toBeVisible();
            await member.goBack();
            await member.waitForFunction(() => window.global?.state?.activeChan?.type === 'conv', undefined, { timeout: 10000 });
            await expect(member.locator('#drive-viewer')).toHaveCount(0);

            // ── Notes render drive links too ──────────────────────────────────
            const rendered = await owner.evaluate(async (ref) => {
                await import('/static/workspaces/notes.mjs');   // loaded with the first notes channel
                return window.MDToPreview(`<#${ref}>`) + window.MDToRender(`<#${ref}>`);
            }, fileRef);
            expect(rendered).toContain(`data-channel-id='${fileRef}'`);
            expect(rendered).toContain(`rapport-${stamp}.txt`);
        } finally {
            await close();
        }
    });

    test('changes made by another member show up live', async ({ browser }) => {
        const { owner, serverId, members, stamp, close } = await setupServer(browser, 'drivelive', 1);
        const member = members[0].page;
        try {
            const driveId = await createChannel(owner, serverId, 'drive');
            await openServer(member, serverId);
            await openDrive(member, driveId);

            await createFolder(owner, driveId, `live-${stamp}`);
            await expect(member.locator('.drive-folder-item', { hasText: `live-${stamp}` })).toBeVisible({ timeout: 10000 });

            const fileId = await uploadText(owner, driveId, `live-${stamp}.txt`, 'x');
            await expect(fileItem(member, fileId)).toBeVisible({ timeout: 10000 });

            await api(owner, `/rename_drive_item?item_type=file&item_id=${fileId}&name=${enc(`renamed-${stamp}.txt`)}`);
            await expect(fileItem(member, fileId).locator('.drive-item-name')).toHaveText(`renamed-${stamp}.txt`, { timeout: 10000 });

            await api(owner, `/delete_drive_file?file_id=${fileId}`);
            await expect(fileItem(member, fileId)).toHaveCount(0, { timeout: 10000 });
        } finally {
            await close();
        }
    });
});
