// Vocal channels: joining from the sidebar, hearing the others wherever you
// browse, shared mic/headset state, leaving, and who sees a private channel's
// occupants. Real WebRTC between two browser contexts with Chromium's fake
// microphone/camera.
import { test, expect } from '@playwright/test';
import { setupServer, createChannel, openServer, setChannelPerm } from './helpers/permissionHelpers.mjs';
import { createConversation, openConversation, waitForAppReady } from './helpers/callHelpers.mjs';
import { reloadAndWaitForApp } from './helpers/messagingHelpers.mjs';

/** Reload (to receive the conv), go to the DM list and open `conv`. */
async function openDm(page, conv) {
    if (!(await page.locator(`#conv${conv}`).count())) {
        if (!(await page.evaluate((c) => !!window.global.convs?.[c], conv))) await reloadAndWaitForApp(page);
        await page.locator('#logo').click();
    }
    await openConversation(page, conv);
}

test.use({
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
    permissions: ['microphone', 'camera'],
    viewport: { width: 1400, height: 850 },
});

/** What actually plays sound: the persistent audio sinks, by user id. */
const audioSinks = (page) => page.evaluate(() =>
    [...document.querySelectorAll('#call-audio-sinks audio')].map(a => ({
        user: Number(a.dataset.user),
        muted: a.muted,
        liveAudio: !!a.srcObject?.getAudioTracks().some(t => t.readyState === 'live'),
    })));

/** Like Discord: the 1st click connects (you stay where you are), the 2nd opens the view. */
async function joinFromSidebar(page, chan) {
    await page.locator(`#channel-vocal-${chan}`).click();
    await expect.poll(() => page.evaluate(() => {
        const cm = window.global.state.callManager;
        return cm.callState === 'active' ? cm.currentCall?.vocal_channel_id : null;
    }), { timeout: 10000 }).toBe(chan);
    await expect(page.locator('.vocal-channel-view')).toHaveCount(0);
    await page.locator(`#channel-vocal-${chan}`).click();
    await expect(page.locator('.vocal-channel-view .vocal-participants-grid')).toBeVisible({ timeout: 10000 });
}

/**
 * Replace the screen picker with a canvas animation (a real video track over
 * WebRTC); withAudio adds the "shared tab sound" (an oscillator), like a picker
 * with "share audio" ticked. Later calls change what the next share gets.
 */
const fakeScreenCapture = (page, withAudio = false) => page.evaluate((withAudio) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
        const ctx = canvas.getContext('2d');
        let n = 0;
        setInterval(() => { ctx.fillStyle = `hsl(${(n += 15) % 360},70%,50%)`; ctx.fillRect(0, 0, 640, 360); }, 100);
        const stream = canvas.captureStream(15);
        if (withAudio) {
            const audio = new AudioContext();
            const osc = audio.createOscillator();
            const dest = audio.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();
            stream.addTrack(dest.stream.getAudioTracks()[0]);
        }
        return stream;
    };
}, withAudio);

/** The sink playing someone's screen share sound ('screen-<uid>'), if any. */
const screenSink = (page, uid) => page.evaluate((uid) => {
    const a = document.querySelector(`#call-audio-sinks audio[data-user="screen-${uid}"]`);
    return a && { muted: a.muted, volume: a.volume, liveAudio: !!a.srcObject?.getAudioTracks().some(t => t.readyState === 'live') };
}, uid);

/** The <video> of a screen tile is playing frames. */
const screenPlaying = (page, id) => page.evaluate((id) => {
    const v = document.getElementById(id);
    return !!(v && v.srcObject?.getVideoTracks().some(t => t.readyState === 'live') && v.videoWidth > 0);
}, id);

/** Owner + one member, both in the server, both in its vocal channel. */
async function twoInVocal(browser, label) {
    const s = await setupServer(browser, label, 1);
    const chan = await createChannel(s.owner, s.serverId, 'vocal');
    const member = s.members[0];
    await openServer(s.owner, s.serverId);
    await openServer(member.page, s.serverId);
    await joinFromSidebar(s.owner, chan);
    await joinFromSidebar(member.page, chan);
    // Each side has received the other's media
    for (const [page, other] of [[s.owner, member.id], [member.page, s.ownerId]]) {
        await expect.poll(async () => (await audioSinks(page)).find(a => a.user === other)?.liveAudio, { timeout: 15000 }).toBe(true);
    }
    return { s, chan, member };
}

test.describe('Vocal channels', () => {
    test.setTimeout(120000);

    test('1st click on a vocal channel connects, 2nd opens the view with both tiles', async ({ browser }) => {
        const { s, chan, member } = await twoInVocal(browser, 'vocview');
        try {
            const view = s.owner.locator('.vocal-channel-view');
            await expect(view.locator('.vocal-header h2')).toHaveText('Salon vocal');
            await expect(view.locator('.vocal-tile')).toHaveCount(2);
            await expect(view.locator(`#participant-${member.id}`)).toBeVisible();
            await expect(view.locator('#participant-local')).toBeVisible();
            // Sidebar: both occupants, timer on our channel, "voice connected" panel
            await expect(s.owner.locator(`#vocal-occupant-${member.id}`)).toBeVisible();
            await expect(s.owner.locator(`#vocal-occupant-${s.ownerId}`)).toBeVisible();
            await expect(s.owner.locator(`#channel-vocal-${chan} .vocal-call-timer`)).toHaveText(/^\d+:\d\d$/);
            await expect(s.owner.locator('.voice-status-bar')).toContainText('Salon vocal');
        } finally {
            await s.close();
        }
    });

    // Regression: remote audio used to be bound only to the tiles' <video>
    // elements — never attached at all, and gone as soon as you browsed away.
    test('remote audio keeps playing while browsing a text channel', async ({ browser }) => {
        const { s, member } = await twoInVocal(browser, 'vocaudio');
        try {
            await s.owner.locator('#server-selector .conv:not(.vocal-channel-row)').first().click();
            await expect(s.owner.locator('.vocal-channel-view')).toHaveCount(0);
            const sinks = await audioSinks(s.owner);
            expect(sinks).toEqual([{ user: member.id, muted: false, liveAudio: true }]);
            await expect(s.owner.locator('.voice-status-bar')).toBeVisible();
        } finally {
            await s.close();
        }
    });

    test('mute and deafen are shared with the channel, deafen also mutes the mic', async ({ browser }) => {
        const { s, member } = await twoInVocal(browser, 'vocstate');
        const m = member.page;
        const occupantIcons = (page, uid) => page.locator(`#vocal-occupant-${uid} .vocal-occupant-state img`);
        try {
            await m.locator('#vocal-mute-btn').click();
            await expect(occupantIcons(s.owner, member.id)).toHaveAttribute('src', /mic_off\.svg/);
            await expect(s.owner.locator(`#participant-${member.id} .vocal-tile-state img`)).toHaveAttribute('src', /mic_off\.svg/);
            expect(await m.evaluate(() => window.global.state.callManager.localStream.getAudioTracks()[0].enabled)).toBe(false);

            // Unmute, then deafen: mic goes off too, the headset icon wins, and nothing plays
            await m.locator('#vocal-mute-btn').click();
            await expect(occupantIcons(s.owner, member.id)).toHaveCount(0);
            await m.locator('#vocal-deafen-btn').click();
            await expect(occupantIcons(s.owner, member.id)).toHaveAttribute('src', /headset_off\.svg/);
            expect(await m.evaluate(() => window.global.state.callManager.isMuted)).toBe(true);
            expect(await m.evaluate(() => window.global.state.callManager.localStream.getAudioTracks()[0].enabled)).toBe(false);
            expect((await audioSinks(m)).every(a => a.muted)).toBe(true);
            // …and it shows: red mic + headset in the controls, slashed mic in the user panel
            await expect(m.locator('#vocal-mute-btn')).toHaveClass(/off/);
            await expect(m.locator('#vocal-deafen-btn')).toHaveClass(/off/);
            await expect(m.locator('#profile .icon-wrapper').first().locator('.line')).toHaveClass(/visible/);

            // Undeafen restores the mic as it was (on)
            await m.locator('#vocal-deafen-btn').click();
            await expect(occupantIcons(s.owner, member.id)).toHaveCount(0);
            expect(await m.evaluate(() => window.global.state.callManager.isMuted)).toBe(false);
            expect((await audioSinks(m)).every(a => !a.muted)).toBe(true);
        } finally {
            await s.close();
        }
    });

    test('per-user volume and local mute only change my own output', async ({ browser }) => {
        const { s, member } = await twoInVocal(browser, 'vocvol');
        try {
            await s.owner.locator(`#participant-${member.id}`).click({ button: 'right' });
            const menu = s.owner.locator('#voice-user-modale');
            await expect(menu).toBeVisible();
            await menu.locator('input[type=range]').fill('30');
            await expect.poll(async () => (await s.owner.evaluate((uid) =>
                document.querySelector(`#call-audio-sinks audio[data-user="${uid}"]`).volume, member.id))).toBeCloseTo(0.3);
            await menu.locator('.item').click();
            expect((await audioSinks(s.owner))[0].muted).toBe(true);
            // The other side is untouched
            expect((await audioSinks(member.page))[0].muted).toBe(false);
        } finally {
            await s.close();
        }
    });

    test('hanging up updates everyone and keeps the mic state for next time', async ({ browser }) => {
        const { s, chan, member } = await twoInVocal(browser, 'vocleave');
        try {
            await member.page.locator('#vocal-mute-btn').click();
            await member.page.locator('#vocal-hangup-btn').click();
            await expect(s.owner.locator(`#vocal-occupant-${member.id}`)).toHaveCount(0);
            await expect.poll(async () => (await audioSinks(s.owner)).length).toBe(0);
            await expect(s.owner.locator('.vocal-invite-tile')).toBeVisible();
            // The member sees the lobby (join button) and no voice panel anymore
            await expect(member.page.locator('.vocal-join-btn')).toBeVisible();
            await expect(member.page.locator('.voice-status-bar')).toHaveCount(0);
            expect(await audioSinks(member.page)).toEqual([]);
            // Mic state survives the call, like Discord
            expect(await member.page.evaluate(() => window.global.state.callManager.isMuted)).toBe(true);
            await member.page.locator('.vocal-join-btn').click();
            await expect(s.owner.locator(`#vocal-occupant-${member.id} .vocal-occupant-state img`)).toHaveAttribute('src', /mic_off\.svg/);
            await expect(s.owner.locator(`#channel-vocal-${chan}`)).toBeVisible();
        } finally {
            await s.close();
        }
    });

    // Regression: a participant closing their browser stayed in the call forever
    test('closing the browser in a call removes you from it for everyone', async ({ browser }) => {
        const { s, chan, member } = await twoInVocal(browser, 'vocgone');
        try {
            await member.page.context().close();
            await expect(s.owner.locator(`#vocal-occupant-${member.id}`)).toHaveCount(0, { timeout: 15000 });
            await expect(s.owner.locator(`#participant-${member.id}`)).toHaveCount(0);
            await expect.poll(async () => (await audioSinks(s.owner)).length).toBe(0);
            // The server agrees: only the owner is left in the channel
            const state = await s.owner.evaluate(async (c) =>
                (await fetch(`/get_vocal_channel_state?channel_id=${c}`)).json(), chan);
            expect(state.participants).toEqual([s.ownerId]);
        } finally {
            await s.close().catch(() => {});
        }
    });

    // Regression: any of your sockets closing hung up your call, even another tab's
    test('closing another tab of yours keeps you in the call', async ({ browser }) => {
        const { s, chan, member } = await twoInVocal(browser, 'vocothertab');
        try {
            const extra = await member.page.context().newPage();
            await extra.goto('http://localhost:808/channels');
            await waitForAppReady(extra, 20000);
            await extra.close();
            await member.page.waitForTimeout(3000);
            await expect(s.owner.locator(`#vocal-occupant-${member.id}`)).toBeVisible();
            const state = await s.owner.evaluate(async (c) =>
                (await fetch(`/get_vocal_channel_state?channel_id=${c}`)).json(), chan);
            expect(state.participants.sort()).toEqual([s.ownerId, member.id].sort());
            // …while closing the call's own tab still hangs up
            await member.page.close();
            await expect(s.owner.locator(`#vocal-occupant-${member.id}`)).toHaveCount(0, { timeout: 15000 });
        } finally {
            await s.close().catch(() => {});
        }
    });

    /** Record every track getUserMedia hands out on this page (mic + camera). */
    const trackMediaTracks = (page) => page.evaluate(() => {
        window.__tracks = [];
        const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
            const stream = await native(constraints);
            window.__tracks.push(...stream.getTracks());
            return stream;
        };
    });
    const liveTracks = (page) => page.evaluate(() =>
        window.__tracks.filter(t => t.readyState === 'live').map(t => t.kind));

    // Regression: Chrome kept saying "this tab is using your microphone" after hanging up
    test('hanging up releases the microphone and camera, whatever the path', async ({ browser }) => {
        test.setTimeout(150000);
        const s = await setupServer(browser, 'vocrelease', 1);
        const page = s.owner;
        try {
            const chanA = await createChannel(page, s.serverId, 'vocal');
            const chanB = await createChannel(page, s.serverId, 'vocal');
            await openServer(page, s.serverId);
            await trackMediaTracks(page);            const inChannel = (c) => page.evaluate((c) => {
                const cm = window.global.state.callManager;
                return cm.callState === 'active' ? cm.currentCall?.vocal_channel_id : null;
            }, c);
            const hangUp = async () => {
                await page.evaluate(() => window.leaveVocalChannel());
                await expect.poll(() => liveTracks(page)).toEqual([]);
            };

            // Join, hang up
            await page.evaluate((c) => window.joinVocalChannel(c), chanA);
            await expect.poll(() => inChannel()).toBe(chanA);
            expect(await liveTracks(page)).toEqual(['audio']);
            await hangUp();

            // With the camera on
            await page.evaluate((c) => window.joinVocalChannel(c), chanA);
            await expect.poll(() => inChannel()).toBe(chanA);
            await page.evaluate(() => window.global.state.callManager.toggleVideo());
            await expect.poll(() => liveTracks(page)).toEqual(['audio', 'video']);
            await hangUp();

            // Moving from one channel to another, then hanging up
            await page.evaluate((c) => window.joinVocalChannel(c), chanA);
            await expect.poll(() => inChannel()).toBe(chanA);
            await page.evaluate((c) => window.joinVocalChannel(c), chanB);
            await expect.poll(() => inChannel()).toBe(chanB);
            expect(await liveTracks(page)).toEqual(['audio']);
            await hangUp();

            // Clicking a second channel while the first one is still connecting:
            // only the last one wins, a single mic, and the server agrees
            await page.evaluate(([a, b]) => { window.joinVocalChannel(a); window.joinVocalChannel(b); }, [chanA, chanB]);
            await expect.poll(() => inChannel()).toBe(chanB);
            await page.waitForTimeout(2000);
            expect(await liveTracks(page)).toEqual(['audio']);
            expect(await vocalParticipants(page, chanA)).toEqual([]);
            expect(await vocalParticipants(page, chanB)).toEqual([s.ownerId]);
            await hangUp();

            // Hanging up while still connecting: never ends up in the call, mic released
            await page.evaluate((c) => { window.joinVocalChannel(c); window.leaveVocalChannel(); }, chanA);
            await page.waitForTimeout(3000);
            expect(await page.evaluate(() => window.global.state.callManager.callState)).toBe('none');
            expect(await liveTracks(page)).toEqual([]);
            expect(await vocalParticipants(page, chanA)).toEqual([]);
        } finally {
            await s.close().catch(() => {});
        }
    });

    /**
     * Cut the page's WebSocket the way a network drop does (no clean close code)
     * and keep it from reconnecting until restoreSocket: a stand-in that never
     * opens takes the place of WebSocket.
     */
    const dropSocket = (page) => page.evaluate(() => {
        const Native = window.WebSocket;
        window.__NativeWS = Native;
        window.WebSocket = class {
            static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
            constructor() { this.readyState = 0; window.__pendingWS = this; }
            send() {}
            close() {}
        };
        window.global.state.websocket.close(4000, 'e2e network drop');
    });
    const restoreSocket = (page) => page.evaluate(() => {
        window.WebSocket = window.__NativeWS;
        const stuck = window.__pendingWS;
        if (stuck) { stuck.readyState = 3; stuck.onclose?.({ code: 4001, reason: 'e2e network back' }); }
    });
    const vocalParticipants = (page, chan) => page.evaluate(async (c) =>
        (await (await fetch(`/get_vocal_channel_state?channel_id=${c}`)).json()).participants || [], chan);

    test('a short network drop keeps you in the call, on your new connection', async ({ browser }) => {
        test.setTimeout(150000);
        const { s, chan, member } = await twoInVocal(browser, 'vocblip');
        const m = member.page;
        try {
            await m.evaluate(() => window.global.state.websocket.close(4000, 'e2e network drop'));
            // Reconnects 3 s later on its own and claims the call from the new socket
            await expect.poll(() => m.evaluate(() => window.global.state.websocket.readyState), { timeout: 15000 }).toBe(1);
            // Well past the grace + a sweep: still in, for the server and the owner
            await m.waitForTimeout(45000);
            expect((await vocalParticipants(s.owner, chan)).sort()).toEqual([s.ownerId, member.id].sort());
            await expect(s.owner.locator(`#vocal-occupant-${member.id}`)).toBeVisible();
            expect(await m.evaluate(() => window.global.state.callManager.callState)).toBe('active');
            // The new socket is the call's: closing the tab hangs up right away
            await m.close();
            await expect(s.owner.locator(`#vocal-occupant-${member.id}`)).toHaveCount(0, { timeout: 15000 });
        } finally {
            await s.close().catch(() => {});
        }
    });

    test('a long network drop takes you out, and you rejoin the vocal channel when back', async ({ browser }) => {
        test.setTimeout(180000);
        const { s, chan, member } = await twoInVocal(browser, 'voclongdrop');
        const m = member.page;
        try {
            await dropSocket(m);
            // Still listed during the grace, gone after it (30 s + a 10 s sweep)
            await m.waitForTimeout(10000);
            await expect(s.owner.locator(`#vocal-occupant-${member.id}`)).toBeVisible();
            await expect(s.owner.locator(`#vocal-occupant-${member.id}`)).toHaveCount(0, { timeout: 60000 });
            expect(await vocalParticipants(s.owner, chan)).toEqual([s.ownerId]);

            // Back online: the server says we're out, the client joins the channel again
            await restoreSocket(m);
            await expect(s.owner.locator(`#vocal-occupant-${member.id}`)).toBeVisible({ timeout: 20000 });
            await expect.poll(async () => (await audioSinks(s.owner)).find(a => a.user === member.id)?.liveAudio, { timeout: 20000 }).toBe(true);
            expect(await m.evaluate(() => window.global.state.callManager.callState)).toBe('active');
        } finally {
            await s.close().catch(() => {});
        }
    });

    // Regression: participants without any socket (a call reloaded from the DB
    // after a restart, a socket gone without its cleanup) stayed in for good
    test('a participant with no connection left is swept out of the call', async ({ browser }) => {
        test.setTimeout(150000);
        const s = await setupServer(browser, 'vocsweep', 1);
        try {
            const chan = await createChannel(s.owner, s.serverId, 'vocal');
            const member = s.members[0];
            await openServer(s.owner, s.serverId);
            await joinFromSidebar(s.owner, chan);
            // The member's tab is gone (no WebSocket), then a join lands over HTTP
            const request = member.page.context().request;
            await member.page.close();
            const joined = await request.post(`http://localhost:808/join_vocal_channel?channel_id=${chan}`);
            expect(joined.ok()).toBe(true);
            const participants = async () => (await s.owner.evaluate(async (c) =>
                (await fetch(`/get_vocal_channel_state?channel_id=${c}`)).json(), chan)).participants;
            expect((await participants()).sort()).toEqual([s.ownerId, member.id].sort());
            // ~30 s of grace + a 10 s sweep period
            await expect.poll(participants, { timeout: 60000, intervals: [2000] }).toEqual([s.ownerId]);
        } finally {
            await s.close().catch(() => {});
        }
    });

    test('someone whose media never gets through is kicked after ~30 s', async ({ browser }) => {
        test.setTimeout(150000);
        const s = await setupServer(browser, 'vocstuck', 1);
        try {
            const chan = await createChannel(s.owner, s.serverId, 'vocal');
            const m = s.members[0].page;
            const memberId = s.members[0].id;
            await openServer(s.owner, s.serverId);
            await openServer(m, s.serverId);
            await joinFromSidebar(s.owner, chan);
            // The member can only use relays and has none: no media can ever flow
            await m.evaluate(() => {
                const Native = window.RTCPeerConnection;
                window.RTCPeerConnection = function (config) {
                    return new Native({ ...config, iceServers: [], iceTransportPolicy: 'relay' });
                };
                window.RTCPeerConnection.prototype = Native.prototype;
            });
            await m.locator(`#channel-vocal-${chan}`).click();
            await expect(s.owner.locator(`#participant-${memberId}`)).toHaveClass(/status-connected/, { timeout: 15000 });

            // Kicked: gone for the owner, out of the call with an explanation for the member
            await expect(s.owner.locator(`#vocal-occupant-${memberId}`)).toHaveCount(0, { timeout: 70000 });
            await expect(s.owner.locator(`#participant-${memberId}`)).toHaveCount(0);
            await expect.poll(() => m.evaluate(() => window.global.state.callManager.callState)).toBe('none');
            await expect(m.locator('body')).toContainText(/personne ne recevait ton audio|nobody was receiving your audio/);
            // The owner, who joined first, stays
            expect(await s.owner.evaluate(() => window.global.state.callManager.callState)).toBe('active');
        } finally {
            await s.close().catch(() => {});
        }
    });

    // Regression: Subscribe renders first without its `element` param, so the
    // occupant lists stayed empty until the next presence event.
    test('occupants already in a channel show after a reload, in the sidebar and the lobby', async ({ browser }) => {
        const s = await setupServer(browser, 'vocreload', 1);
        try {
            const chan = await createChannel(s.owner, s.serverId, 'vocal');
            const m = s.members[0].page;
            await openServer(s.owner, s.serverId);
            await joinFromSidebar(s.owner, chan);
            await openServer(m, s.serverId);   // reload: occupants only come from get_serv_content
            await expect(m.locator(`#vocal-occupant-${s.ownerId}`)).toBeVisible();
            await m.goto(`http://localhost:808/channels#${s.serverId}/${chan}`);
            await m.reload();
            await expect(m.locator('.vocal-lobby .vocal-lobby-avatar')).toHaveCount(1, { timeout: 15000 });
            await expect(m.locator('.vocal-header-count')).toHaveText(/^1 /);
            await expect(m.locator('.vocal-join-btn')).toBeVisible();
            expect(await m.evaluate(() => window.global.state.callManager?.callState)).toBe('none');
        } finally {
            await s.close();
        }
    });

    test('a screen share gets its own tile, next to the person, camera included', async ({ browser }) => {
        const { s, member } = await twoInVocal(browser, 'vocscreen');
        const m = member.page;
        const ownerScreen = `screen-video-${s.ownerId}`;
        try {
            await fakeScreenCapture(s.owner);
            await s.owner.locator('#vocal-screen-btn').click();
            // Owner: own preview tile; member: the owner's screen tile, besides both person tiles
            await expect.poll(() => screenPlaying(s.owner, 'screen-video-local'), { timeout: 10000 }).toBe(true);
            await expect.poll(() => screenPlaying(m, ownerScreen), { timeout: 15000 }).toBe(true);
            await expect(m.locator(`#participant-${s.ownerId}`)).toBeVisible();
            await expect(m.locator('.vocal-participants-grid .vocal-tile')).toHaveCount(3);
            await expect(m.locator(`#vocal-occupant-${s.ownerId} .vocal-live-badge`)).toBeVisible();

            // Camera on top of the share: the person tile shows it, the screen tile stays
            await s.owner.locator('#vocal-video-btn').click();
            await expect(m.locator(`#participant-${s.ownerId}`)).toHaveClass(/has-stream/, { timeout: 15000 });
            await expect(m.locator(`#screen-tile-${s.ownerId}`)).toBeVisible();

            // Stop: the tile goes away on both sides; sharing again brings it back
            await s.owner.locator('#vocal-screen-btn').click();
            await expect(m.locator(`#screen-tile-${s.ownerId}`)).toHaveCount(0);
            await expect(s.owner.locator('#screen-tile-local')).toHaveCount(0);
            await s.owner.locator('#vocal-screen-btn').click();
            await expect.poll(() => screenPlaying(m, ownerScreen), { timeout: 15000 }).toBe(true);
        } finally {
            await s.close();
        }
    });

    test('someone joining during a screen share gets it too', async ({ browser }) => {
        const s = await setupServer(browser, 'vocscrlate', 1);
        const m = s.members[0].page;
        try {
            const chan = await createChannel(s.owner, s.serverId, 'vocal');
            await openServer(s.owner, s.serverId);
            await openServer(m, s.serverId);
            await joinFromSidebar(s.owner, chan);
            await fakeScreenCapture(s.owner);
            await s.owner.locator('#vocal-screen-btn').click();
            await expect.poll(() => screenPlaying(s.owner, 'screen-video-local'), { timeout: 10000 }).toBe(true);
            await joinFromSidebar(m, chan);
            await expect.poll(() => screenPlaying(m, `screen-video-${s.ownerId}`), { timeout: 15000 }).toBe(true);
        } finally {
            await s.close();
        }
    });

    // Regression: contentHint 'detail' made libwebrtc encode the share in
    // "screenshare" mode, which held it at 4-9 fps for long stretches
    test('a screen share streams at a smooth framerate', async ({ browser }) => {
        const { s, member } = await twoInVocal(browser, 'vocfps');
        const m = member.page;
        const receivedFps = () => m.evaluate(async (uid) => {
            const stats = await window.global.state.callManager.peerConnections[uid].getStats();
            let fps = 0;   // the screen's video is the only one flowing (no camera)
            stats.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') fps = Math.max(fps, r.framesPerSecond || 0); });
            return fps;
        }, s.ownerId);
        try {
            // A busy 60 fps source: moving text over a changing background
            await s.owner.evaluate(() => {
                navigator.mediaDevices.getDisplayMedia = async () => {
                    const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
                    const ctx = canvas.getContext('2d');
                    let n = 0;
                    setInterval(() => {
                        n++;
                        ctx.fillStyle = `hsl(${(n * 7) % 360},70%,50%)`;
                        ctx.fillRect(0, 0, 1280, 720);
                        ctx.fillStyle = '#fff';
                        ctx.font = '40px sans-serif';
                        for (let i = 0; i < 12; i++) ctx.fillText(`frame ${n}, line ${i}`, 20 + (n % 50), 60 + i * 50);
                    }, 16);
                    return canvas.captureStream(60);
                };
            });
            await s.owner.locator('#vocal-screen-btn').click();
            await expect.poll(() => screenPlaying(m, `screen-video-${s.ownerId}`), { timeout: 15000 }).toBe(true);
            await expect.poll(receivedFps, { timeout: 10000 }).toBeGreaterThanOrEqual(24);
            // …and it holds
            for (let i = 0; i < 3; i++) {
                await m.waitForTimeout(2000);
                expect(await receivedFps()).toBeGreaterThanOrEqual(20);
            }
        } finally {
            await s.close();
        }
    });

    test('a click shows a tile big with the others in a strip, a click goes back to the grid', async ({ browser }) => {
        const { s, member } = await twoInVocal(browser, 'vocfocus');
        const m = member.page;
        const grid = m.locator('.vocal-participants-grid');
        try {
            await fakeScreenCapture(s.owner);
            await s.owner.locator('#vocal-screen-btn').click();
            await expect.poll(() => screenPlaying(m, `screen-video-${s.ownerId}`), { timeout: 15000 }).toBe(true);

            // Focus the owner's screen: big on top, both people small below, still playing
            await m.locator(`#screen-tile-${s.ownerId}`).click();
            await expect(grid).toHaveClass(/focus-mode/);
            await expect(m.locator(`#screen-tile-${s.ownerId}`)).toHaveClass(/focused/);
            await expect(m.locator('.vocal-tile.focused')).toHaveCount(1);
            await expect.poll(() => screenPlaying(m, `screen-video-${s.ownerId}`), { timeout: 10000 }).toBe(true);
            const big = await m.locator(`#screen-tile-${s.ownerId}`).boundingBox();
            const small = await m.locator('#participant-local').boundingBox();
            expect(big.width).toBeGreaterThan(small.width * 3);
            expect(small.y).toBeGreaterThan(big.y + big.height - 1);

            // A small tile takes you back to the grid
            await m.locator('#participant-local').click();
            await expect(grid).not.toHaveClass(/focus-mode/);
            await expect(m.locator('.vocal-tile.focused')).toHaveCount(0);

            // Any tile can be focused (a person); when it goes away, back to the grid
            await m.locator(`#participant-${s.ownerId}`).click();
            await expect(m.locator(`#participant-${s.ownerId}`)).toHaveClass(/focused/);
            await s.owner.locator('#vocal-hangup-btn').click();
            await expect(m.locator(`#participant-${s.ownerId}`)).toHaveCount(0);
            await expect(grid).not.toHaveClass(/focus-mode/);
        } finally {
            await s.close();
        }
    });

    test('a screen share with sound plays it, with its own mute and volume', async ({ browser }) => {
        const { s, member } = await twoInVocal(browser, 'vocscrsnd');
        const m = member.page;
        const tile = m.locator(`#screen-tile-${s.ownerId}`);
        try {
            await fakeScreenCapture(s.owner, true);
            await s.owner.locator('#vocal-screen-btn').click();
            await expect.poll(() => screenSink(m, s.ownerId), { timeout: 15000 })
                .toEqual({ muted: false, volume: 1, liveAudio: true });
            // The sharer doesn't play their own share's sound
            expect(await screenSink(s.owner, 'local')).toBeNull();
            expect(await screenSink(s.owner, s.ownerId)).toBeNull();

            // The tile's speaker button mutes the stream for me only, not the voice
            await tile.locator('.vocal-screen-audio').click();
            await expect.poll(async () => (await screenSink(m, s.ownerId)).muted).toBe(true);
            await expect(tile.locator('.vocal-screen-audio img')).toHaveAttribute('src', /speaker_off\.svg/);
            expect((await audioSinks(m)).find(a => a.user === s.ownerId).muted).toBe(false);
            await expect(tile).not.toHaveClass(/focused/);   // the button doesn't focus the tile
            await tile.locator('.vocal-screen-audio').click();
            await expect.poll(async () => (await screenSink(m, s.ownerId)).muted).toBe(false);

            // Right-click: the stream's own volume, apart from the person's
            await tile.click({ button: 'right' });
            const menu = m.locator('#voice-user-modale');
            await expect(menu).toContainText(/Volume du stream|Stream volume/);
            await menu.locator('input[type=range]').fill('40');
            await expect.poll(async () => (await screenSink(m, s.ownerId)).volume).toBeCloseTo(0.4);
            expect(await m.evaluate((uid) =>
                document.querySelector(`#call-audio-sinks audio[data-user="${uid}"]`).volume, s.ownerId)).toBe(1);

            // Sharing again without sound: no speaker button
            await s.owner.locator('#vocal-screen-btn').click();
            await expect(tile).toHaveCount(0);
            await fakeScreenCapture(s.owner, false);
            await s.owner.locator('#vocal-screen-btn').click();
            await expect.poll(() => screenPlaying(m, `screen-video-${s.ownerId}`), { timeout: 15000 }).toBe(true);
            await expect(tile.locator('.vocal-screen-audio')).toHaveCount(0);
        } finally {
            await s.close();
        }
    });

    test('a DM call still works end to end (audio both ways, mute shared)', async ({ browser }) => {
        const s = await setupServer(browser, 'vocdm', 1);
        const m = s.members[0];
        try {
            const conv = await createConversation(s.owner, 'dm call', [m.id]);
            for (const page of [s.owner, m.page]) await openDm(page, conv);
            await trackMediaTracks(s.owner);
            await s.owner.locator('.selected-info .call-actions .icon-wrapper').first().click();   // voice call
            await expect(m.page.locator('.call-btn-accept')).toBeVisible({ timeout: 10000 });
            await m.page.locator('.call-btn-accept').click();
            for (const [page, other] of [[s.owner, m.id], [m.page, s.ownerId]]) {
                await expect.poll(async () => (await audioSinks(page)).find(a => a.user === other)?.liveAudio, { timeout: 15000 }).toBe(true);
            }
            await m.page.locator('#call-mute-btn').click();
            await expect.poll(() => s.owner.evaluate((uid) => window.global.state.voiceStates[uid]?.muted, m.id)).toBe(true);
            await s.owner.locator('.call-component .hangup').click();
            // The member stays in the (now empty) call, like Discord; the owner's audio is gone
            await expect(m.page.locator(`.call-component #participant-${s.ownerId}`)).toHaveCount(0, { timeout: 10000 });
            await expect.poll(() => audioSinks(m.page)).toEqual([]);
            await expect(s.owner.locator('.call-component.call-active')).toHaveCount(0);
            await expect.poll(() => liveTracks(s.owner)).toEqual([]);   // mic released
        } finally {
            await s.close();
        }
    });

    // Regression: the DM call section rendered the *vocal* call, and an ongoing
    // DM call flipped callState to "banner" under a live vocal connection.
    test('opening a DM with an ongoing call does not hijack the vocal connection', async ({ browser }) => {
        const s = await setupServer(browser, 'vocdmx', 1);
        const m = s.members[0];
        try {
            const chan = await createChannel(s.owner, s.serverId, 'vocal');
            const conv = await createConversation(m.page, 'dm while vocal', [s.ownerId]);
            await openServer(s.owner, s.serverId);
            await joinFromSidebar(s.owner, chan);
            await openDm(m.page, conv);
            await m.page.locator('.selected-info .call-actions .icon-wrapper').first().click();   // member rings the owner
            await expect.poll(() => s.owner.evaluate(() => window.global.state.callManager.callState)).toBe('active');

            await openDm(s.owner, conv);
            await s.owner.waitForTimeout(800);
            const cm = await s.owner.evaluate(() => ({
                state: window.global.state.callManager.callState,
                vocal: window.global.state.callManager.currentCall?.vocal_channel_id,
            }));
            expect(cm).toEqual({ state: 'active', vocal: chan });
            await expect(s.owner.locator('.voice-status-bar')).toBeVisible();
            // The DM shows its own call as joinable, not the vocal tiles
            await expect(s.owner.locator('.call-component #participant-local')).toHaveCount(0);
        } finally {
            await s.close();
        }
    });

    test('a private vocal channel only broadcasts its occupants to members who can see it', async ({ browser }) => {
        const s = await setupServer(browser, 'vocpriv', 2);
        try {
            const chan = await createChannel(s.owner, s.serverId, 'vocal');
            const [allowed, outsider] = s.members;
            await setChannelPerm(s.owner, chan, 'roleId=everyone', 'view-channels', 'deny', 'vocal');
            await setChannelPerm(s.owner, chan, `accountId=${allowed.id}`, 'view-channels', 'allow', 'vocal');
            for (const page of [s.owner, allowed.page, outsider.page]) await openServer(page, s.serverId);
            // Record the vocal presence events each member receives
            for (const page of [allowed.page, outsider.page]) {
                await page.evaluate(() => {
                    window.__vocalEvents = [];
                    const ws = window.global.state.websocket;
                    ws.addEventListener('message', (e) => {
                        const t = JSON.parse(e.data)?.content?.type;
                        if (t && (t.startsWith('vocal_channel_') || t === 'voice_state')) window.__vocalEvents.push(t);
                    });
                });
            }
            await joinFromSidebar(s.owner, chan);
            await expect(allowed.page.locator(`#vocal-occupant-${s.ownerId}`)).toBeVisible();
            await expect.poll(() => allowed.page.evaluate(() => window.__vocalEvents.length)).toBeGreaterThan(0);
            await s.owner.waitForTimeout(500);
            expect(await outsider.page.evaluate(() => window.__vocalEvents)).toEqual([]);
        } finally {
            await s.close();
        }
    });
});
