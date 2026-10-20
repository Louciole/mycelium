/**
 * Settings › Voice & Video: devices, volumes, input profile, voice detection and
 * camera. Remembered per device (localStorage), like Discord: a device id means
 * nothing on another machine.
 *
 * The call (webrtc.mjs) captures through getMedia() and sends MicPipeline's track;
 * setVoicePref() pushes a change to the ongoing call (CallManager.updateMicInput,
 * updateMicProcessing, applyOutputSettings, switchCamera) and to the tests of the
 * settings tab. The tab's meters are painted imperatively (~45 Hz), the rest is
 * reactive: global.state.voiceSettings, global.state.mediaDevices, global.state.voiceTest.
 */
import global from "./framework/global.mjs";
import { setElement, updateElement } from "./framework/vesta.mjs";

const STORAGE_KEY = 'voice.settings';
const WORKLET_URL = '/static/voice-gate-worklet.mjs';

const DEFAULTS = {
    inputDevice: '',          // '' = the system's default device
    outputDevice: '',
    cameraDevice: '',
    inputVolume: 100,         // %, 0..200
    outputVolume: 100,        // %, 0..100 (an <audio> can't play louder)
    profile: 'isolation',     // 'isolation' | 'studio' | 'custom'
    // Custom profile only
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    autoSensitivity: true,
    sensitivity: -50,         // dB: voice detection threshold when not automatic
    cameraPreview: false,     // a preview dialog before the camera goes on in a call
};

// What a change has to redo
const CAPTURE_KEYS = ['inputDevice', 'profile', 'echoCancellation', 'noiseSuppression', 'autoGainControl'];
const GATE_KEYS = ['profile', 'inputVolume', 'autoSensitivity', 'sensitivity'];
const OUTPUT_KEYS = ['outputDevice', 'outputVolume'];

function loadPrefs() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (e) { /* private mode */ }
    const prefs = { ...DEFAULTS };
    for (const key in DEFAULTS) {
        if (typeof saved[key] === typeof DEFAULTS[key]) prefs[key] = saved[key];
    }
    return prefs;
}

export const voicePrefs = loadPrefs();
global.state.voiceSettings = voicePrefs;
global.state.voiceTest = { monitoring: false, playback: false, camera: false, error: '' };

export const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
window.canPickOutput = canPickOutput;

// ==================== CAPTURE ====================

/** The browser's voice processing for the chosen profile. */
function processing() {
    const p = voicePrefs;
    if (p.profile === 'studio') return { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (p.profile === 'custom') {
        return { echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGainControl };
    }
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
}

function audioConstraints(anyDevice) {
    const c = processing();
    if (voicePrefs.inputDevice && !anyDevice) c.deviceId = { exact: voicePrefs.inputDevice };
    return c;
}

function videoConstraints(anyDevice) {
    return voicePrefs.cameraDevice && !anyDevice ? { deviceId: { exact: voicePrefs.cameraDevice } } : true;
}

/**
 * getUserMedia with the chosen devices and processing. A chosen device that is
 * gone (unplugged, or this is another browser) falls back to the default one.
 */
export async function getMedia({ audio = false, video = false }) {
    const build = anyDevice => ({
        audio: audio && audioConstraints(anyDevice),
        video: video && videoConstraints(anyDevice),
    });
    try {
        return await navigator.mediaDevices.getUserMedia(build(false));
    } catch (e) {
        const chosen = (audio && voicePrefs.inputDevice) || (video && voicePrefs.cameraDevice);
        if (!chosen || !['OverconstrainedError', 'NotFoundError', 'NotReadableError'].includes(e.name)) throw e;
        return navigator.mediaDevices.getUserMedia(build(true));
    }
}

/** What the gate worklet does with the mic (see voice-gate-worklet.mjs). */
function gateParams() {
    const p = voicePrefs;
    const mode = p.profile === 'studio' ? 'off'
        : p.profile === 'custom' && !p.autoSensitivity ? 'manual' : 'auto';
    return { volume: p.inputVolume / 100, mode, threshold: p.sensitivity };
}

/**
 * The mic as it is sent: captured → input volume → voice detection gate, in a
 * Web Audio graph whose output track stays the same when the mic is captured again
 * (other device, other processing), so peers don't need a new track.
 * Without Web Audio (no AudioWorklet, or an AudioContext the browser won't start),
 * the captured track itself is sent: `track` then changes on restart().
 */
export class MicPipeline {
    constructor(onLevel = null) {
        this.onLevel = onLevel;        // ({level, threshold, open}) => …, ~45 times a second
        this.onDeviceLost = null;      // the captured device went away (unplugged)
        this.track = null;
        this.raw = null;
        this.ctx = null;
        this.node = null;
        this.source = null;
        this.stopped = false;
    }

    /** Start from an already captured audio stream, or capture the mic. Returns the track to send. */
    async start(raw = null) {
        raw = raw || await getMedia({ audio: true });
        try {
            await this._build();
        } catch (e) {
            console.warn('Mic processing unavailable, sending the mic as captured:', e);
            this.ctx?.close().catch(() => {});
            this.ctx = this.node = null;
            this.track = null;
        }
        this._use(raw);
        return this.track;
    }

    async _build() {
        if (!window.AudioWorkletNode) throw new Error('AudioWorklet unsupported');
        const ctx = this.ctx = new AudioContext();
        if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 1000))]);
        if (ctx.state !== 'running') throw new Error('AudioContext not allowed to start');
        await ctx.audioWorklet.addModule(WORKLET_URL);
        this.node = new AudioWorkletNode(ctx, 'voice-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const dest = ctx.createMediaStreamDestination();
        dest.channelCount = 1;
        this.node.connect(dest);
        this.node.port.onmessage = e => this.onLevel?.(e.data);
        this.track = dest.stream.getAudioTracks()[0];
        this.applySettings();
    }

    _use(raw) {
        const old = this.raw;
        this.raw = raw;
        const rawTrack = raw.getAudioTracks()[0];
        if (this.node) {
            this.source?.disconnect();
            this.source = this.ctx.createMediaStreamSource(new MediaStream([rawTrack]));
            this.source.connect(this.node);
        } else {
            this.track = rawTrack;
        }
        if (old && old !== raw) old.getTracks().forEach(t => t.stop());
        rawTrack?.addEventListener('ended', () => {
            if (this.raw === raw && !this.stopped) this.onDeviceLost?.();
        });
        if (this.stopped) this.stop();   // stopped while capturing
    }

    /**
     * Let go of the mic before capturing it again: while a capture of the device is
     * open, Chrome hands a new one the same source, old voice processing included.
     */
    releaseInput() {
        this.raw?.getTracks().forEach(t => t.stop());
    }

    /** Capture again (device or processing changed). Returns the track to send. */
    async restart() {
        this.releaseInput();
        const raw = await getMedia({ audio: true });
        if (this.stopped) {
            raw.getTracks().forEach(t => t.stop());
            return this.track;
        }
        this._use(raw);
        return this.track;
    }

    applySettings() {
        this.node?.port.postMessage(gateParams());
    }

    stop() {
        this.stopped = true;
        this.raw?.getTracks().forEach(t => t.stop());
        this.track?.stop();
        this.source?.disconnect();
        this.ctx?.close().catch(() => {});
        this.ctx = this.node = this.source = null;
    }
}

// ==================== OUTPUT ====================

/** Master volume of what we hear, 0..1 (per-user volumes multiply it). */
export function outputGain() {
    return voicePrefs.outputVolume / 100;
}

/** Route a media element to the chosen speaker (system default when it's gone). */
export function applyOutputDevice(el) {
    if (typeof el?.setSinkId !== 'function') return;
    const id = voicePrefs.outputDevice || '';
    if (el.sinkId === id) return;
    el.setSinkId(id).catch(() => { if (id) el.setSinkId('').catch(() => {}); });
}

// ==================== PREFERENCES ====================

export function setVoicePref(key, value) {
    if (!(key in DEFAULTS) || typeof value !== typeof DEFAULTS[key] || voicePrefs[key] === value) return;
    setElement(`global.state.voiceSettings.${key}`, value);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(voicePrefs)); } catch (e) { /* private mode */ }

    const call = global.state.callManager;
    if (CAPTURE_KEYS.includes(key)) {
        // Both captures of the mic (call, settings test) closed before either reopens
        call?._mic?.releaseInput();
        test.mic?.releaseInput();
        call?.updateMicInput();
        if (test.mic) restartTestMic();
    }
    if (GATE_KEYS.includes(key)) {
        call?.updateMicProcessing();
        test.mic?.applySettings();
    }
    if (OUTPUT_KEYS.includes(key)) {
        call?.applyOutputSettings();
        if (test.audio) {
            test.audio.volume = outputGain();
            applyOutputDevice(test.audio);
        }
    }
    if (key === 'cameraDevice') {
        call?.switchCamera();
        if (test.camera) restartTestCamera();
        if (preview) restartPreview();
    }
}
window.setVoicePref = setVoicePref;

// ==================== DEVICES ====================

const DEVICE_NAMES = { audioinput: 'Micro', audiooutput: 'Haut-parleur', videoinput: 'Caméra' };

/** List the devices (their names only once mic/camera access was granted). */
export async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    // Chrome's 'default' / 'communications' entries are our own "default" choice
    const of = kind => all.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    setElement('global.state.mediaDevices', {
        audioinput: of('audioinput'),
        audiooutput: of('audiooutput'),
        videoinput: of('videoinput'),
        named: all.some(d => d.label),
    });
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices());

function mediaDeviceLabel(kind, id) {
    if (!id) return _t('Par défaut du système');
    const list = global.state.mediaDevices?.[kind] || [];
    const i = list.findIndex(d => d.deviceId === id);
    if (i < 0) return global.state.mediaDevices ? _t('Appareil indisponible') : '';
    return list[i].label || `${_t(DEVICE_NAMES[kind])} ${i + 1}`;
}
window.mediaDeviceLabel = mediaDeviceLabel;

function pickMediaDevice(pref, id) {
    global.state.activeDropdown?.classList.remove('show');
    global.state.activeDropdown = undefined;
    setVoicePref(pref, id);
    updateElement('global.state.mediaDevices');   // the dropdowns show the choice
}
window.pickMediaDevice = pickMediaDevice;

// ==================== SETTINGS TAB: MIC AND CAMERA TESTS ====================

// The tab's own captures, separate from a call's: mic (meters), its loopback
// <audio> ("Test du micro"), the camera preview. All stop when the tab is left.
const test = { mic: null, audio: null, camera: null, watchdog: null };

function panelVisible() {
    const panel = document.getElementById('voice-settings');
    return !!panel?.isConnected && panel.getClientRects().length > 0;
}

/** postInsert of the "Voix & Vidéo" tab (settings.html). */
function openVoiceSettings() {
    refreshDevices();
    clearInterval(test.watchdog);
    test.watchdog = setInterval(() => { if (!panelVisible()) stopVoiceTests(); }, 500);
    // Live meters right away when the mic is already allowed (no permission prompt
    // just for opening the tab); otherwise "Test du micro" asks.
    navigator.permissions?.query({ name: 'microphone' })
        .then(status => { if (status.state === 'granted' && panelVisible()) startMicMonitor(); })
        .catch(() => {});
}
window.openVoiceSettings = openVoiceSettings;

function stopVoiceTests() {
    clearInterval(test.watchdog);
    test.watchdog = null;
    stopMicTest();
    stopTestCamera();
}

function mediaErrorText(e) {
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return _t("L'accès a été refusé : autorise-le dans les réglages du navigateur.");
    if (e?.name === 'NotFoundError') return _t('Aucun appareil trouvé.');
    if (e?.name === 'NotReadableError') return _t('Appareil déjà utilisé par une autre application.');
    return _t("Impossible d'accéder à l'appareil.");
}

async function startMicMonitor() {
    if (test.mic) return test.mic;
    const mic = test.mic = new MicPipeline(paintLevels);
    mic.onDeviceLost = () => restartTestMic();
    setElement('global.state.voiceTest.error', '');
    try {
        await mic.start();
    } catch (e) {
        if (test.mic === mic) test.mic = null;
        setElement('global.state.voiceTest.error', mediaErrorText(e));
        return null;
    }
    if (test.mic !== mic) return null;   // tab left meanwhile (stop() already ran)
    setElement('global.state.voiceTest.monitoring', true);
    refreshDevices();                    // names are given once access is granted
    return mic;
}

async function restartTestMic() {
    const mic = test.mic;
    try {
        await mic.restart();
    } catch (e) {
        setElement('global.state.voiceTest.error', mediaErrorText(e));
        return;
    }
    if (test.audio && test.mic === mic) test.audio.srcObject = new MediaStream([mic.track]);
}

/** "Test du micro": hear yourself as the others would (volume, gate, processing). */
async function toggleMicTest() {
    if (test.audio) {
        stopPlayback();
        return;
    }
    const mic = await startMicMonitor();
    if (!mic || test.audio) return;
    const audio = test.audio = new Audio();
    audio.autoplay = true;
    audio.srcObject = new MediaStream([mic.track]);
    audio.volume = outputGain();
    applyOutputDevice(audio);
    audio.play?.().catch(() => {});
    setElement('global.state.voiceTest.playback', true);
}
window.toggleMicTest = toggleMicTest;

function stopPlayback() {
    if (test.audio) {
        test.audio.pause();
        test.audio.srcObject = null;
        test.audio = null;
    }
    setElement('global.state.voiceTest.playback', false);
    document.getElementById('mic-test-meter')?.style.setProperty('--level', 0);
}

function stopMicTest() {
    stopPlayback();
    test.mic?.stop();
    test.mic = null;
    setElement('global.state.voiceTest.monitoring', false);
}

// dB → 0..1 on a meter: the sensitivity bar spans -100..0 dB like its slider,
// the test meter -60..0 dB (where a voice moves)
const sensitivityFraction = db => Math.min(1, Math.max(0, (db + 100) / 100));
const meterFraction = db => Math.min(1, Math.max(0, (db + 60) / 60));

function paintLevels({ level, threshold, open }) {
    const meter = document.getElementById('mic-test-meter');
    // The bars only move while testing; the gate sends nothing below the threshold
    if (meter) meter.style.setProperty('--level', test.audio && open ? meterFraction(level).toFixed(3) : 0);
    const bar = document.getElementById('voice-sensitivity');
    if (bar) {
        bar.style.setProperty('--level', sensitivityFraction(level).toFixed(3));
        bar.style.setProperty('--threshold', sensitivityFraction(threshold).toFixed(3));
        bar.classList.toggle('open', open);
    }
}

/** "Test vidéo" */
async function toggleCameraTest() {
    if (test.camera) {
        stopTestCamera();
        return;
    }
    await startTestCamera();
}
window.toggleCameraTest = toggleCameraTest;

async function startTestCamera() {
    setElement('global.state.voiceTest.error', '');
    let stream;
    try {
        stream = await getMedia({ video: true });
    } catch (e) {
        setElement('global.state.voiceTest.error', mediaErrorText(e));
        return;
    }
    if (!panelVisible()) {
        stream.getTracks().forEach(t => t.stop());
        return;
    }
    test.camera?.getTracks().forEach(t => t.stop());
    test.camera = stream;
    setElement('global.state.voiceTest.camera', true);
    const video = document.getElementById('camera-test-video');
    if (video) video.srcObject = stream;
    refreshDevices();
}

function restartTestCamera() {
    startTestCamera();
}

function stopTestCamera() {
    test.camera?.getTracks().forEach(t => t.stop());
    test.camera = null;
    setElement('global.state.voiceTest.camera', false);
}

// ==================== CAMERA PREVIEW (before it goes on in a call) ====================

let preview = null;   // {stream, resolve}

/**
 * Show the camera before it goes on in a call (the "Toujours afficher un aperçu"
 * setting). Resolves with the camera track to send, or null when cancelled.
 */
export function previewCamera() {
    if (preview) return Promise.resolve(null);
    return new Promise(resolve => {
        preview = { stream: null, resolve };
        document.body.insertAdjacentHTML('beforeend', getTemplate('camera-preview'));
        document.addEventListener('keydown', onPreviewKeydown, true);
        document.querySelector('#camera-preview-dialog .ui-dialog-confirm')?.focus({ preventScroll: true });
        restartPreview();
    });
}

async function restartPreview() {
    const current = preview;
    let stream;
    try {
        stream = await getMedia({ video: true });
    } catch (e) {
        if (preview !== current) return;
        closeCameraPreview(false);
        window.uiAlert?.(mediaErrorText(e));
        return;
    }
    if (preview !== current) {   // closed meanwhile
        stream.getTracks().forEach(t => t.stop());
        return;
    }
    preview.stream?.getTracks().forEach(t => t.stop());
    preview.stream = stream;
    const video = document.getElementById('camera-preview-video');
    if (video) video.srcObject = stream;
    document.getElementById('camera-preview-dialog')?.classList.add('ready');
    refreshDevices();
}

function closeCameraPreview(confirmed) {
    if (!preview) return;
    const { stream, resolve } = preview;
    preview = null;
    document.removeEventListener('keydown', onPreviewKeydown, true);
    document.getElementById('camera-preview-dialog')?.remove();
    const track = confirmed ? stream?.getVideoTracks()[0] : null;
    stream?.getTracks().forEach(t => { if (t !== track) t.stop(); });
    resolve(track || null);
}
window.closeCameraPreview = closeCameraPreview;

function onPreviewKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeCameraPreview(false);
    }
}
