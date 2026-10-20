// Text chat of a vocal channel (Discord's chat panel): the chat-bubble button of
// the vocal view opens the channel's messages + a composer. Readable and writable
// by whoever can view the channel, in the call or not; live over the WebSocket.
import { test, expect } from '@playwright/test';
import { setupServer, createChannel, openServer, setChannelPerm, api, status, json, enc } from './helpers/permissionHelpers.mjs';

test.use({
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
    permissions: ['microphone', 'camera'],
    viewport: { width: 1400, height: 850 },
});

/** Like Discord: the 1st click connects (you stay where you are), the 2nd opens the view. */
async function joinFromSidebar(page, chan) {
    await page.locator(`#channel-vocal-${chan}`).click();
    await expect.poll(() => page.evaluate(() => {
        const cm = window.global.state.callManager;
        return cm.callState === 'active' ? cm.currentCall?.vocal_channel_id : null;
    }), { timeout: 10000 }).toBe(chan);
    await page.locator(`#channel-vocal-${chan}`).click();
    await expect(page.locator('.vocal-channel-view .vocal-participants-grid')).toBeVisible({ timeout: 10000 });
}

/** The view without joining (what a URL / a reload opens): the lobby with its join button. */
async function openVocalView(page, chan) {
    await page.evaluate((c) => window.goToVocalChannel(c, false), chan);
    await expect(page.locator('.vocal-channel-view .vocal-join-btn')).toBeVisible();
}

async function openChat(page) {
    await page.locator('#vocal-chat-btn').click();
    await expect(page.locator('#vocal-chat .chat-input textarea')).toBeVisible();
}

async function post(page, text) {
    const input = page.locator('#vocal-chat .chat-input textarea');
    await input.fill(text);
    await input.press('Enter');
}

const chatMessage = (page, text) => page.locator('#vocal-chat .message .mdBlock').filter({ hasText: text });
const sendTo = (place, text) => `/send_message?conv=${enc(JSON.stringify({ id: place }))}&content=${enc(text)}`;

test.describe('Vocal channel chat', () => {
    test.setTimeout(120000);

    test('members in and out of the call read and post live', async ({ browser }) => {
        const s = await setupServer(browser, 'vchat', 1);
        const member = s.members[0];
        try {
            const chan = await createChannel(s.owner, s.serverId, 'vocal');
            await openServer(s.owner, s.serverId);
            await openServer(member.page, s.serverId);

            await joinFromSidebar(s.owner, chan);   // owner: in the call
            await openVocalView(member.page, chan);  // member: just looking
            await openChat(s.owner);
            await openChat(member.page);
            await expect(s.owner.locator('#vocal-chat-btn')).toHaveClass(/on/);

            await post(s.owner, 'hello from the call');
            await expect(chatMessage(s.owner, 'hello from the call')).toBeVisible();
            await expect(chatMessage(member.page, 'hello from the call')).toBeVisible({ timeout: 10000 });

            await post(member.page, 'hello from outside');
            await expect(chatMessage(member.page, 'hello from outside')).toBeVisible();
            await expect(chatMessage(s.owner, 'hello from outside')).toBeVisible({ timeout: 10000 });
            // Posting didn't pull the member into the call, nor the owner out of it
            expect(await member.page.evaluate(() => window.global.state.callManager?.callState)).not.toBe('active');
            await expect(s.owner.locator('.vocal-participants-grid')).toBeVisible();

            // Stored in the channel's own place (not the vocal id, which could be a text channel's)
            const chat = await json(member.page, `/get_vocal_chat?channel_id=${chan}`);
            expect(chat.vocal).toBe(chan);
            expect(chat.messages.map(m => m.body)).toEqual(['hello from the call', 'hello from outside']);

            // Closing the panel hands the view back to the stage
            await s.owner.locator('#vocal-chat-close').click();
            await expect(s.owner.locator('#vocal-chat')).toHaveCount(0);
            expect(await s.owner.evaluate(() => window.global.state.activeConv)).toBeUndefined();
        } finally {
            await s.close();
        }
    });

    test('view right gates reading and posting, send-messages gates posting', async ({ browser }) => {
        const s = await setupServer(browser, 'vchatperm', 2);
        const [outsider, reader] = s.members;
        try {
            const chan = await createChannel(s.owner, s.serverId, 'vocal');
            const place = (await json(s.owner, `/get_vocal_chat?channel_id=${chan}`)).id;
            await setChannelPerm(s.owner, chan, `accountId=${outsider.id}`, 'view-channels', 'deny', 'vocal');
            await setChannelPerm(s.owner, chan, `accountId=${reader.id}`, 'send-messages', 'deny', 'vocal');

            // No view right: neither read nor post
            expect(await status(outsider.page, `/get_vocal_chat?channel_id=${chan}`)).toBe(403);
            expect(await status(outsider.page, sendTo(place, 'sneaky'))).toBe(403);

            // View without send-messages: reads, can't post — and the composer says so
            expect(await status(reader.page, `/get_vocal_chat?channel_id=${chan}`)).toBe(200);
            expect(await status(reader.page, sendTo(place, 'read only'))).toBe(403);
            await api(s.owner, sendTo(place, 'owner speaking'));
            await openServer(reader.page, s.serverId);
            await openVocalView(reader.page, chan);
            await openChat(reader.page);
            await expect(chatMessage(reader.page, 'owner speaking')).toBeVisible();
            await expect(reader.page.locator('#vocal-chat .chat-input textarea')).toBeDisabled();
            await expect(reader.page.locator('#timeout-banner')).toBeVisible();

            const messages = (await json(s.owner, `/get_vocal_chat?channel_id=${chan}`)).messages;
            expect(messages.map(m => m.body)).toEqual(['owner speaking']);
        } finally {
            await s.close();
        }
    });
});
