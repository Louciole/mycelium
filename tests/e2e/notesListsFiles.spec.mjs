import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { createServerViaUi, openServerFromSidebarById } from './helpers/serverHelpers.mjs';
import { api, json, enc, createChannel } from './helpers/permissionHelpers.mjs';
import {
    createNoteChannelViaUi,
    openNoteChannel,
    waitForNoteChannelLoaded,
    getFirstBlockOfType,
} from './helpers/workspaceHelpers.mjs';

const TEST_TIMEOUT = 120000;
// Where an image block's image is stored (upload_note_image), or null
const noteImage = (text) => (/^note_\d+\/[0-9a-f]{64}\.png$/.test(text || '') ? text : null);

/**
 * The text drawn in each block's ::before (bullet, or number: CSS counters, which
 * getComputedStyle only gives as "counter(nl0)"), by block uuid. Chrome's DOM snapshot
 * has the laid out text.
 */
async function drawnMarkers(page) {
    const cdp = await page.context().newCDPSession(page);
    const { documents: [doc], strings } = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    await cdp.detach();
    const nodes = doc.nodes;
    const before = new Set(nodes.pseudoType.index.filter((_, i) => strings[nodes.pseudoType.value[i]] === 'before'));
    const markers = {};
    doc.layout.nodeIndex.forEach((node, i) => {
        if (!before.has(node) || doc.layout.text[i] < 0) return;
        const attrs = nodes.attributes[nodes.parentIndex[node]].map((s) => strings[s]);
        const at = attrs.indexOf('data-block-id');
        if (at >= 0) markers[attrs[at + 1]] = (markers[attrs[at + 1]] || '') + strings[doc.layout.text[i]];
    });
    return markers;
}

/** The note's blocks in reading order: type, level, text and the marker drawn before it. */
async function items(page, channelId) {
    const markers = await drawnMarkers(page);
    const blocks = await page.evaluate((id) => [...document.querySelectorAll('#note-editor .block[data-block-id]')].map((el) => {
        const block = window.global.notes[id].blocks[el.dataset.blockId];
        return { uuid: block.uuid, type: block.type, indent: block.indent || 0, text: block.content };
    }), channelId);
    return blocks.map(({ uuid, ...block }) => ({ ...block, marker: markers[uuid] || '' }));
}

async function waitForTyped(page, channelId, text) {
    await page.waitForFunction(({ id, t }) => Object.values(window.global?.notes?.[id]?.blocks || {})
        .some((b) => b.content === t), { id: channelId, t: text }, { timeout: 10000 });
}

async function freshNote(page, prefix) {
    await loginUser(page, `${prefix}_${Date.now()}`);
    await waitForAppReady(page);
    const serverId = await createServerViaUi(page);
    await openServerFromSidebarById(page, serverId);
    return serverId;
}

/** A 320×180 picture (drawn in the page) uploaded into a drive: its file id. */
async function drivePicture(page, driveId) {
    return page.evaluate(async (driveId) => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(40, 40, 100, 100);
        const r = await fetch(`/upload_drive_file?drive_id=${driveId}&filename=picture.png`, { method: 'POST',
            credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: canvas.toDataURL('image/png') }) });
        return (await r.json()).file_id;
    }, driveId);
}

/**
 * Paste a 320×180 PNG (with this text too, if any) where the caret is. Returns the block it
 * was pasted in, and whether the editor took the paste.
 */
async function pasteImage(page, withText = null) {
    return page.evaluate(async (text) => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
        canvas.getContext('2d').fillRect(0, 0, 320, 180);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const data = new DataTransfer();
        if (text) data.setData('text/plain', text);
        data.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        const target = document.activeElement;
        target.dispatchEvent(event);
        return { block: target.closest('.block')?.dataset.blockId, taken: event.defaultPrevented };
    }, withText);
}

/** Reload (the note comes back from the server) and open it again. */
async function reopen(page, serverId, channelId) {
    await page.reload();
    await waitForAppReady(page);
    await openServerFromSidebarById(page, serverId);
    await openNoteChannel(page, channelId);
    await waitForNoteChannelLoaded(page, channelId);
}

test.describe('Notes - lists and files', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('"- " and "1. " start lists; Tab, Enter and Backspace move through levels like Notion', async ({ page }) => {
        const serverId = await freshNote(page, 'e2enotelists');
        const channelId = await createNoteChannelViaUi(page);
        await openNoteChannel(page, channelId);
        await waitForNoteChannelLoaded(page, channelId);
        await page.waitForFunction((id) => Object.values(window.global?.notes?.[id]?.blocks || {}).some((b) => b.type === 'text'),
            channelId, { timeout: 10000 });
        const first = await getFirstBlockOfType(page, channelId, 'text');
        await page.locator(`[data-block-id="${first}"] .content`).click();

        // Bullets: Enter continues the list, Tab nests under the item above
        await page.keyboard.type('- Alpha');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Beta');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');                // same level as Beta
        await page.keyboard.type('Gamma');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');                // empty item: one level up…
        await page.keyboard.type('Delta');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');                // …and at the first level, out of the list

        // Numbered: the numbers restart after a paragraph, a sub-list doesn't break them
        await page.keyboard.type('1. One');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Two');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Tab');
        await page.keyboard.type('Sub');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.type('Three');
        await waitForTyped(page, channelId, 'Three');

        const expected = [
            { type: 'bullet', indent: 0, text: 'Alpha', marker: '•' },
            { type: 'bullet', indent: 1, text: 'Beta', marker: '◦' },
            { type: 'bullet', indent: 1, text: 'Gamma', marker: '◦' },
            { type: 'bullet', indent: 0, text: 'Delta', marker: '•' },
            { type: 'numbered', indent: 0, text: 'One', marker: '1.' },
            { type: 'numbered', indent: 0, text: 'Two', marker: '2.' },
            { type: 'numbered', indent: 1, text: 'Sub', marker: 'a.' },
            { type: 'numbered', indent: 0, text: 'Three', marker: '3.' },
        ];
        await expect.poll(() => items(page, channelId)).toEqual(expected);
        const subLeft = await page.evaluate(() => [...document.querySelectorAll('#note-editor .block')]
            .map((el) => el.getBoundingClientRect().left));
        expect(subLeft[6]).toBeGreaterThan(subLeft[5] + 10);   // nested items are drawn further in

        // Tab under an item of the same level is one undo step
        await page.locator('#note-editor .block > .content', { hasText: 'Three' }).click();
        await page.keyboard.press('Tab');
        await expect.poll(async () => (await items(page, channelId))[7]).toMatchObject({ indent: 1, marker: 'b.' });
        await page.keyboard.press('Control+z');
        await expect.poll(async () => (await items(page, channelId))[7]).toMatchObject({ indent: 0, marker: '3.' });

        // From the server (the op log), after a reload: same lists, same numbers
        await reopen(page, serverId, channelId);
        await expect.poll(() => items(page, channelId)).toEqual(expected);
        // …and the copy the MCP / search read has the levels too
        await expect.poll(async () => {
            const note = await json(page, `/get_note_content?channel_id=${channelId}`);
            return note.blocks.filter((b) => b.type === 'numbered').map((b) => [b.content, b.indent]).sort();
        }, { timeout: 15000 }).toEqual([['One', 0], ['Sub', 1], ['Three', 0], ['Two', 0]]);

        // Backspace at the start of an item makes it a paragraph, its text kept
        await page.locator('#note-editor .block > .content', { hasText: 'Delta' }).click();
        await page.keyboard.press('Home');
        await page.keyboard.press('Backspace');
        await expect.poll(async () => (await items(page, channelId))[3]).toEqual({ type: 'text', indent: 0, text: 'Delta', marker: '' });

        // "- " typed at the start of a paragraph makes it an item again (a paragraph that already
        // reads "- …" stays one when edited elsewhere: notesPage.spec.mjs)
        await page.keyboard.type('- ');
        await expect.poll(async () => (await items(page, channelId))[3]).toEqual({ type: 'bullet', indent: 0, text: 'Delta', marker: '•' });

        // A block written whole (the MCP server's append_block, save_block) keeps its level, live
        const block = { uuid: randomUUID(), type: 'bullet', content: 'From MCP', indent: 1, position: 99 };
        await api(page, `/save_block?channel=${channelId}&op=create&block=${enc(JSON.stringify(block))}`);
        await expect.poll(async () => (await items(page, channelId)).at(-1))
            .toEqual({ type: 'bullet', indent: 1, text: 'From MCP', marker: '◦' });
    });

    test('a file block shows a Drive image, uploads into the drive, and hides what is gone', async ({ page }) => {
        const serverId = await freshNote(page, 'e2enotefiles');
        const driveId = await createChannel(page, serverId, 'drive');
        const channelId = await createChannel(page, serverId, 'note');
        const imageId = await drivePicture(page, driveId);
        await reopen(page, serverId, channelId);
        await page.waitForFunction((id) => Object.values(window.global?.notes?.[id]?.blocks || {}).some((b) => b.type === 'text'),
            channelId, { timeout: 10000 });
        const block = await getFirstBlockOfType(page, channelId, 'text');

        // "/file" makes the block and opens the picker, straight into the only drive
        await page.locator(`[data-block-id="${block}"] .content`).click();
        await page.keyboard.type('/file');
        const picker = page.locator('#note-file-picker');
        await expect(picker.locator(`.note-file-choice[data-file-id="${imageId}"]`)).toBeVisible();
        await picker.locator(`.note-file-choice[data-file-id="${imageId}"]`).click();
        await expect(picker).toHaveCount(0);

        const image = page.locator(`[data-block-id="${block}"] .note-file-media img`);
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate((img) => img.complete && img.naturalWidth)).toBe(320);
        await expect(page.locator(`[data-block-id="${block}"] figcaption`)).toHaveText('picture.png');
        // The file sits on the block's first line, level with its handles (no blank line above it)
        const [handleTop, imageTop] = await page.evaluate((uuid) => [
            document.querySelector(`[data-block-id="${uuid}"] .controls`).getBoundingClientRect().top,
            document.querySelector(`[data-block-id="${uuid}"] .note-file-media img`).getBoundingClientRect().top], block);
        expect(Math.abs(imageTop - handleTop)).toBeLessThan(12);
        expect(await page.evaluate(({ id, uuid }) => window.global.notes[id].blocks[uuid].content, { id: channelId, uuid: block }))
            .toBe(`<#drive:${driveId}/f:${imageId}>`);

        // Same after a reload (from the op log)
        await reopen(page, serverId, channelId);
        await expect(page.locator(`[data-block-id="${block}"] .note-file-media img`)).toBeVisible();

        // Block menu → replace: a file uploaded from the picker lands in the drive and in the block
        await page.locator(`[data-block-id="${block}"]`).hover();
        await page.locator(`[data-block-id="${block}"] .controls .drag`).click();
        await page.locator('.note-block-menu .drive-context-item', { hasText: /Replace the file|Remplacer le fichier/ }).click();
        await expect(picker).toBeVisible();
        await picker.locator('#note-file-input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Q4 plan') });
        const card = page.locator(`[data-block-id="${block}"] .drive-link-card`);
        await expect(card).toContainText('plan.txt');
        const listing = await json(page, `/list_drive?drive_id=${driveId}`);
        const uploaded = listing.files.find((f) => f.filename === 'plan.txt');
        expect(uploaded).toBeTruthy();
        expect(await page.evaluate(({ id, uuid }) => window.global.notes[id].blocks[uuid].content, { id: channelId, uuid: block }))
            .toBe(`<#drive:${driveId}/f:${uploaded.id}>`);

        // The file deleted from the drive: the block says so, live, and shows nothing of it
        await api(page, `/delete_drive_file?file_id=${uploaded.id}`);
        await expect(page.locator(`[data-block-id="${block}"] .note-file-denied`)).toBeVisible({ timeout: 10000 });
        await expect(page.locator(`[data-block-id="${block}"]`)).not.toContainText('plan.txt');
    });

    test('a pasted image becomes an image block stored with the note; "/image" uploads one', async ({ page }) => {
        const serverId = await freshNote(page, 'e2enoteimages');
        const channelId = await createNoteChannelViaUi(page);
        await openNoteChannel(page, channelId);
        await waitForNoteChannelLoaded(page, channelId);
        await page.waitForFunction((id) => Object.values(window.global?.notes?.[id]?.blocks || {}).some((b) => b.type === 'text'),
            channelId, { timeout: 10000 });
        const first = await getFirstBlockOfType(page, channelId, 'text');
        await page.locator(`[data-block-id="${first}"] .content`).click();
        await page.keyboard.type('Intro');
        await waitForTyped(page, channelId, 'Intro');
        await page.locator('.note-page-tail').click();   // a new empty line below, focused

        // Paste in the empty line below: it becomes the image (a 320×180 PNG, drawn in the page)
        const pasted = await pasteImage(page);
        expect(pasted.taken).toBe(true);
        const imageBlock = (uuid) => page.evaluate(({ id, u }) => window.global.notes[id].blocks[u], { id: channelId, u: uuid });
        await expect.poll(async () => {
            const b = await imageBlock(pasted.block);
            return b.type === 'image' && /^note_\d+\/[0-9a-f]{64}\.png$/.test(b.content);
        }, { timeout: 15000 }).toBe(true);
        const img = page.locator(`[data-block-id="${pasted.block}"] .note-image img`);
        await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBe(320);

        // Copied from Word or a spreadsheet (text, and a picture of it): pasted as text
        await page.locator(`[data-block-id="${first}"] .content`).click();
        const asText = await pasteImage(page, 'Some text');
        expect(asText.taken).toBe(false);
        expect(await page.evaluate((id) => Object.values(window.global.notes[id].blocks).filter((b) => b.type === 'image').length,
            channelId)).toBe(1);

        // From the server after a reload: the same image, served
        await reopen(page, serverId, channelId);
        await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBe(320);

        // "/image" in a new line adds an empty image block, asking for one (no file chooser yet)…
        const images = () => page.evaluate((id) => [...document.querySelectorAll('#note-editor .block[data-block-id]')]
            .map((el) => window.global.notes[id].blocks[el.dataset.blockId]).filter((b) => b.type === 'image'), channelId);
        let chooserOpened = false;
        page.on('filechooser', () => { chooserOpened = true; });
        await page.locator('.note-page-tail').click();
        await page.keyboard.type('/image');
        await expect.poll(async () => (await images()).length).toBe(2);
        const empty = (await images())[1].uuid;
        const prompt = page.locator(`[data-block-id="${empty}"] .note-image-drop`);
        await expect(prompt).toHaveText(/Drop an image, or click to add one|Dépose une image, ou clique pour en ajouter une/);
        await page.waitForTimeout(500);
        expect(chooserOpened).toBe(false);

        // …a click on it asks for the file
        const png = await page.evaluate(() => {
            const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 48 });
            canvas.getContext('2d').fillRect(0, 0, 64, 48);
            return canvas.toDataURL('image/png').split(',')[1];
        });
        const chooser = page.waitForEvent('filechooser');
        await prompt.click();
        await (await chooser).setFiles({ name: 'small.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
        await expect.poll(async () => (await images()).map((b) => Boolean(noteImage(b.content)))).toEqual([true, true]);
        await expect.poll(() => page.locator('#note-editor .note-image img').evaluateAll((els) => els.map((el) => el.naturalWidth)))
            .toEqual([320, 64]);

        // An image dropped on an empty image block goes into that block (none added below)
        await page.locator('.note-page-tail').click();
        await page.keyboard.type('/image');
        await expect.poll(async () => (await images()).length).toBe(3);
        const third = (await images())[2].uuid;
        await page.locator(`[data-block-id="${third}"] .note-image-drop`).evaluate(async (target) => {
            const canvas = Object.assign(document.createElement('canvas'), { width: 40, height: 30 });
            canvas.getContext('2d').fillRect(0, 0, 40, 30);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
            const data = new DataTransfer();
            data.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
            target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
        });
        await expect.poll(async () => (await images()).map((b) => [b.uuid === third || undefined, Boolean(noteImage(b.content))]))
            .toEqual([[undefined, true], [undefined, true], [true, true]]);
        await expect.poll(() => page.locator('#note-editor .note-image img').evaluateAll((els) => els.map((el) => el.naturalWidth)))
            .toEqual([320, 64, 40]);

        // Only images: an SVG (it would run its scripts if opened on its own) is refused
        const svg = await page.evaluate(async (id) => (await fetch(`/upload_note_image?channel=${id}`, {
            method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') }),
        })).status, channelId);
        expect(svg).toBe(400);
    });

    test('an image or a file block is selected whole (a click, the keys around it), then deleted', async ({ page }) => {
        const serverId = await freshNote(page, 'e2enoteselect');
        const driveId = await createChannel(page, serverId, 'drive');
        const channelId = await createChannel(page, serverId, 'note');
        const pictureId = await drivePicture(page, driveId);
        await reopen(page, serverId, channelId);
        await page.waitForFunction((id) => Object.values(window.global?.notes?.[id]?.blocks || {}).some((b) => b.type === 'text'),
            channelId, { timeout: 10000 });
        const intro = await getFirstBlockOfType(page, channelId, 'text');
        await page.locator(`[data-block-id="${intro}"] .content`).click();
        await page.keyboard.type('Intro');
        await waitForTyped(page, channelId, 'Intro');

        // The blocks in reading order (a paragraph: its text), the selected one, where the caret is
        const order = () => page.evaluate((id) => [...document.querySelectorAll('#note-editor .block[data-block-id]')]
            .map((el) => window.global.notes[id].blocks[el.dataset.blockId])
            .map((b) => (b.type === 'text' ? b.content : b.type)), channelId);
        const selected = () => page.evaluate(() => {
            const el = document.querySelector('#note-editor .block.selected');
            return el && document.activeElement === el ? el.dataset.blockId : null;
        });
        const caretIn = () => page.evaluate(() => (document.activeElement?.classList.contains('editable-block')
            ? document.activeElement.closest('.block').dataset.blockId : null));

        await page.locator('.note-page-tail').click();
        const image = (await pasteImage(page)).block;
        await expect.poll(async () => noteImage((await page.evaluate(({ id, u }) => window.global.notes[id].blocks[u],
            { id: channelId, u: image })).content), { timeout: 15000 }).not.toBeNull();
        await page.locator('.note-page-tail').click();
        await expect.poll(order).toEqual(['Intro', 'image', '']);

        // Backspace in the empty line below: the line goes, the image is selected…
        await page.keyboard.press('Backspace');
        await expect.poll(order).toEqual(['Intro', 'image']);
        await expect.poll(selected).toBe(image);
        // …a second one deletes it: the caret is back at the end of the line above
        await page.keyboard.press('Backspace');
        await expect.poll(order).toEqual(['Intro']);
        await expect.poll(caretIn).toBe(intro);
        // An undo step of its own
        await page.keyboard.press('Control+z');
        await expect.poll(order).toEqual(['Intro', 'image']);

        // Pressing on the image and moving doesn't drag it (dropped on the note, the browser would
        // give it as a file: a copy of it)…
        const img = page.locator(`[data-block-id="${image}"] .note-image img`);
        await page.evaluate(() => {
            window._dragStarts = 0;
            document.addEventListener('dragstart', () => { window._dragStarts += 1; }, true);
        });
        const box = await img.boundingBox();
        await page.mouse.move(box.x + 100, box.y + 80);
        await page.mouse.down();
        await page.mouse.move(box.x + 130, box.y + 100, { steps: 5 });
        await page.mouse.up();
        expect(await page.evaluate(() => window._dragStarts)).toBe(0);
        // …and an image dragged from the page itself and dropped on a block adds nothing
        await img.evaluate(async (el) => {
            const blob = await (await fetch(el.src)).blob();
            const data = new DataTransfer();
            data.items.add(new File([blob], 'again.png', { type: 'image/png' }));
            el.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true }));
            el.closest('.block').dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
            el.dispatchEvent(new DragEvent('dragend', { dataTransfer: data, bubbles: true }));
        });
        await page.waitForTimeout(500);
        expect(await order()).toEqual(['Intro', 'image']);

        // A click selects it, Escape lets it go
        await img.click();
        await expect.poll(selected).toBe(image);
        await page.keyboard.press('Escape');
        await expect.poll(selected).toBe(null);
        await expect(page.locator('#note-editor .block.selected')).toHaveCount(0);

        // The arrows: up to the line above, down onto the image again
        await img.click();
        await page.keyboard.press('ArrowUp');
        await expect.poll(caretIn).toBe(intro);
        await page.keyboard.press('ArrowDown');
        await expect.poll(selected).toBe(image);

        // Enter: a new line below it, to type in
        await page.keyboard.press('Enter');
        await expect.poll(order).toEqual(['Intro', 'image', '']);
        await page.keyboard.type('After');
        await waitForTyped(page, channelId, 'After');
        await expect.poll(order).toEqual(['Intro', 'image', 'After']);

        // Delete at the end of the line above selects it, a second Delete deletes it
        await page.locator(`[data-block-id="${intro}"] .content`).click();
        await page.keyboard.press('End');
        await page.keyboard.press('Delete');
        await expect.poll(selected).toBe(image);
        await page.keyboard.press('Delete');
        await expect.poll(order).toEqual(['Intro', 'After']);
        await expect.poll(caretIn).toBe(intro);

        // A file block: a click selects it (the drive doesn't open), Backspace deletes it
        await page.locator('.note-page-tail').click();
        await page.keyboard.type('/file');
        const picker = page.locator('#note-file-picker');
        await picker.locator(`.note-file-choice[data-file-id="${pictureId}"]`).click();
        await expect(picker).toHaveCount(0);
        const fileBlock = await getFirstBlockOfType(page, channelId, 'file');
        const picture = page.locator(`[data-block-id="${fileBlock}"] .note-file-media img`);
        await expect(picture).toBeVisible();
        await picture.click();
        await expect.poll(selected).toBe(fileBlock);
        expect(await page.evaluate(() => window.global.state.activeChan.type)).toBe('note');
        await page.keyboard.press('Backspace');
        await expect.poll(order).toEqual(['Intro', 'After']);
        await page.keyboard.press('Control+z');
        await expect.poll(order).toEqual(['Intro', 'After', 'file']);

        // A double click opens its file in the drive
        await page.locator(`[data-block-id="${fileBlock}"] .note-file-media img`).dblclick();
        await expect.poll(() => page.evaluate(() => window.global.state.activeChan?.type)).toBe('drive');
    });
});
