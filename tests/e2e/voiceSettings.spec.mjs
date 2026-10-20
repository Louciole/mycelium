// Settings › Voix & Vidéo: devices, meters, input profile, camera test, and the
// settings reaching an ongoing call (speaker volume, mic switch, mic volume,
// camera preview). Chromium's fake microphone (a beep every second) and camera.
import { test, expect } from '@playwright/test';
import { setupServer, createChannel, openServer } from './helpers/permissionHelpers.mjs';

test.use({
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
    permissions: ['microphone', 'camera'],
    viewport: { width: 1400, height: 850 },
});

/** Record every track getUserMedia hands out (to check what is released). */
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
    window.__tracks.filter(t => t.readyState === 'live').map(t => t.kind).sort());

/** Highest value of a meter's CSS variable over `ms` (the fake mic only beeps once a second). */
const peakOf = (page, id, prop, ms = 2500) => page.evaluate(([id, prop, ms]) => new Promise(resolve => {
    let peak = 0;
    const timer = setInterval(() => {
        const el = document.getElementById(id);
        if (el) peak = Math.max(peak, Number(el.style.getPropertyValue(prop)) || 0);
    }, 15);
    setTimeout(() => { clearInterval(timer); resolve(peak); }, ms);
}), [id, prop, ms]);

const savedPrefs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('voice.settings') || '{}'));

async function openVoiceSettings(page) {
    await page.locator('div[onclick="openMenu(\'settings\')"]').click();
    await page.locator('#settings').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('#voice-settings-tab').click();
    await expect(page.locator('#voice-settings')).toBeVisible();
}

const inChannel = (page) => page.evaluate(() => {
    const cm = window.global.state.callManager;
    return cm.callState === 'active' ? cm.currentCall?.vocal_channel_id : null;
});

/** Owner + one member in the server's vocal channel, each receiving the other's audio. */
async function twoInVocal(browser, label) {
    const s = await setupServer(browser, label, 1);
    const chan = await createChannel(s.owner, s.serverId, 'vocal');
    const member = s.members[0];
    for (const page of [s.owner, member.page]) {
        await openServer(page, s.serverId);
        await trackMediaTracks(page);
        await page.evaluate((c) => window.joinVocalChannel(c), chan);
        await expect.poll(() => inChannel(page), { timeout: 10000 }).toBe(chan);
    }
    for (const [page, other] of [[s.owner, member.id], [member.page, s.ownerId]]) {
        await expect.poll(() => page.evaluate((uid) =>
            !!document.querySelector(`#call-audio-sinks audio[data-user="${uid}"]`)?.srcObject?.getAudioTracks().some(t => t.readyState === 'live'), other),
        { timeout: 15000 }).toBe(true);
    }
    return { s, chan, member };
}

test.describe('Voice & video settings', () => {
    test.setTimeout(120000);

    test('the tab lists the devices, meters the mic, switches profiles and tests the camera', async ({ browser }) => {
        const s = await setupServer(browser, 'voiceset', 0);
        const page = s.owner;
        try {
            await trackMediaTracks(page);
            await openVoiceSettings(page);

            // Mic already allowed: the meter runs right away and devices have names
            await expect.poll(() => page.evaluate(() => window.global.state.voiceTest.monitoring)).toBe(true);
            await page.locator('#inputDevice-dropdown .dropdown-button').click();
            const mics = page.locator('#inputDevice-dropdown .dropdown-menu li');
            await expect(mics.first()).toHaveAttribute('data-id', '');   // "system default"
            expect(await mics.count()).toBeGreaterThan(1);
            await expect(mics.nth(1)).toHaveText(/Fake/);                // the device's own name
            // Pick a device: saved, shown in the button
            const picked = await mics.nth(1).textContent();
            await mics.nth(1).click();
            await expect(page.locator('#inputDevice-dropdown .dropdown-text')).toHaveText(picked);
            expect((await savedPrefs(page)).inputDevice).toBeTruthy();

            // The fake mic beeps: the voice detection bar sees it and opens
            await expect.poll(() => peakOf(page, 'voice-sensitivity', '--level'), { timeout: 10000 }).toBeGreaterThan(0.3);

            // Mic test: hear yourself, the bars light up
            await page.locator('#mic-test-btn').click();
            await expect.poll(() => page.evaluate(() => window.global.state.voiceTest.playback)).toBe(true);
            await expect.poll(() => peakOf(page, 'mic-test-meter', '--level'), { timeout: 10000 }).toBeGreaterThan(0);

            // Input volume: saved, shown
            await page.locator('#input-volume').fill('150');
            await expect(page.locator('.global-state-voiceSettings-inputVolume')).toHaveText('150%');
            expect((await savedPrefs(page)).inputVolume).toBe(150);

            // Profiles: studio has no voice detection, custom has every option
            await page.locator('.voice-radio:has(input[value="studio"])').click();
            await expect(page.locator('#voice-sensitivity')).toHaveCount(0);
            await page.locator('.voice-radio:has(input[value="custom"])').click();
            await expect(page.locator('#voice-sensitivity')).toBeVisible();
            await expect(page.locator('#voice-echoCancellation')).toBeChecked();
            await expect(page.locator('#sensitivity-slider')).toHaveCount(0);
            await page.locator('.voice-option:has(#auto-sensitivity) .switch').click();
            await expect(page.locator('#sensitivity-slider')).toBeVisible();
            await page.locator('#sensitivity-slider').fill('-30');
            await page.locator('.voice-option:has(#voice-noiseSuppression) .switch').click();
            const prefs = await savedPrefs(page);
            expect(prefs).toMatchObject({ profile: 'custom', autoSensitivity: false, sensitivity: -30, noiseSuppression: false });
            // The mic was captured again with the new processing, the old capture released
            await expect.poll(() => page.evaluate(() =>
                window.__tracks.filter(t => t.kind === 'audio' && t.readyState === 'live').map(t => t.getSettings().noiseSuppression)))
                .toEqual([false]);

            // Camera test
            await page.locator('#camera-test-btn').click();
            await expect.poll(() => page.evaluate(() => document.getElementById('camera-test-video')?.videoWidth || 0), { timeout: 10000 }).toBeGreaterThan(0);
            expect(await liveTracks(page)).toEqual(['audio', 'video']);

            // Leaving the settings releases the mic and the camera
            await page.locator('#settings .close').click();
            await expect.poll(() => liveTracks(page), { timeout: 5000 }).toEqual([]);

            // Remembered after a reload
            await page.reload();
            await page.waitForFunction(() => window.global?.state?.voiceSettings);
            expect(await page.evaluate(() => window.global.state.voiceSettings.sensitivity)).toBe(-30);
        } finally {
            await s.close();
        }
    });

    test('in a call: speaker volume, mic switch and mic volume apply live', async ({ browser }) => {
        const { s, member } = await twoInVocal(browser, 'voicecall');
        try {
            const page = s.owner;
            // Speaker volume scales what we hear (per-user volume included)
            await page.evaluate(() => window.setVoicePref('outputVolume', 40));
            expect(await page.evaluate((uid) => document.querySelector(`#call-audio-sinks audio[data-user="${uid}"]`).volume, member.id)).toBeCloseTo(0.4);

            // Switching the mic keeps the same sent track (no renegotiation) and releases the old capture
            const before = await page.evaluate(() => window.global.state.callManager.localStream.getAudioTracks()[0].id);
            const otherMic = await page.evaluate(async () =>
                (await navigator.mediaDevices.enumerateDevices()).find(d => d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId))?.deviceId);
            await page.evaluate((id) => window.setVoicePref('inputDevice', id), otherMic);
            await expect.poll(() => page.evaluate(() =>
                window.__tracks.filter(t => t.kind === 'audio' && t.readyState === 'live').map(t => t.getSettings().deviceId))).toEqual([otherMic]);
            expect(await page.evaluate(() => window.global.state.callManager.localStream.getAudioTracks()[0].id)).toBe(before);
            const sent = () => page.evaluate(() => Object.values(window.global.state.callManager.peerConnections)
                .flatMap(pc => pc.getSenders()).filter(sd => sd.track?.kind === 'audio').map(sd => sd.track.id));
            expect(await sent()).toEqual([before]);

            // The member hears the beeps…
            const memberHears = () => member.page.evaluate((uid) => new Promise(resolve => {
                const audio = document.querySelector(`#call-audio-sinks audio[data-user="${uid}"]`);
                const ctx = new AudioContext();
                const analyser = ctx.createAnalyser();
                ctx.createMediaStreamSource(audio.srcObject).connect(analyser);
                const data = new Float32Array(analyser.fftSize);
                let peak = 0;
                const timer = setInterval(() => {
                    analyser.getFloatTimeDomainData(data);
                    for (const v of data) peak = Math.max(peak, Math.abs(v));
                }, 20);
                setTimeout(() => { clearInterval(timer); ctx.close(); resolve(peak); }, 2500);
            }), s.ownerId);
            expect(await memberHears()).toBeGreaterThan(0.01);
            // …and nothing once the mic volume is at 0
            await page.evaluate(() => window.setVoicePref('inputVolume', 0));
            await page.waitForTimeout(500);
            expect(await memberHears()).toBeLessThan(0.001);
        } finally {
            await s.close();
        }
    });

    test('"always preview video" shows the camera before it goes on', async ({ browser }) => {
        const { s, member } = await twoInVocal(browser, 'voiceprev');
        try {
            const page = s.owner;
            await page.evaluate(() => window.setVoicePref('cameraPreview', true));

            // Cancel: the camera stays off and is released
            await page.evaluate(() => { window.global.state.callManager.toggleVideo(); });
            await expect(page.locator('#camera-preview-dialog.ready')).toBeVisible({ timeout: 10000 });
            await expect.poll(() => page.evaluate(() => document.getElementById('camera-preview-video')?.videoWidth || 0)).toBeGreaterThan(0);
            await page.locator('#camera-preview-dialog .ui-dialog-cancel').click();
            await expect(page.locator('#camera-preview-dialog')).toHaveCount(0);
            await expect.poll(() => liveTracks(page)).toEqual(['audio']);

            // Confirm: the previewed camera is what the others get
            await page.evaluate(() => { window.global.state.callManager.toggleVideo(); });
            await expect(page.locator('#camera-preview-dialog.ready')).toBeVisible({ timeout: 10000 });
            await page.locator('#camera-preview-dialog .ui-dialog-confirm').click();
            await expect(page.locator('#camera-preview-dialog')).toHaveCount(0);
            await expect.poll(() => member.page.evaluate((uid) => !!window.global.state.voiceStates?.[uid]?.video, s.ownerId), { timeout: 10000 }).toBe(true);
            await expect.poll(() => member.page.evaluate((uid) =>
                window.global.state.callManager.remoteStreams[uid]?.getVideoTracks().some(t => t.readyState === 'live'), s.ownerId), { timeout: 15000 }).toBe(true);
            expect(await liveTracks(page)).toEqual(['audio', 'video']);

            // Turning it off then on again previews again
            await page.evaluate(() => { window.global.state.callManager.toggleVideo(); });
            await expect.poll(() => member.page.evaluate((uid) => !!window.global.state.voiceStates?.[uid]?.video, s.ownerId)).toBe(false);
            await page.evaluate(() => { window.global.state.callManager.toggleVideo(); });
            await expect(page.locator('#camera-preview-dialog.ready')).toBeVisible({ timeout: 10000 });
            await page.keyboard.press('Escape');
            await expect(page.locator('#camera-preview-dialog')).toHaveCount(0);
        } finally {
            await s.close();
        }
    });
});
