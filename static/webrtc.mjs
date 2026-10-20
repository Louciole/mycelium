import global from "./framework/global.mjs";
import { xhr } from "./framework/templating.mjs";
import { setElement, pushElement, deleteVal } from "./framework/vesta.mjs";
import { callEnded as nativeCallEnded, isNative } from "./capacitor-bridge.mjs";
import { MicPipeline, getMedia, outputGain, applyOutputDevice, previewCamera, voicePrefs } from "./voiceSettings.mjs";

// STUN servers for ICE candidates - TURN servers should be added for production
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
];

// Screen share capture. The sound is offered by the picker where the browser
// supports it (Chromium: a tab's sound, the whole system's on Windows/ChromeOS);
// elsewhere audio is ignored and the share is picture only.
// A participant still "Connecting…" (no media) after this is reported (see _checkStuckPeers)
const STUCK_AFTER_MS = 30000;

const SCREEN_CAPTURE = {
    video: { frameRate: { ideal: 30, max: 60 }, width: { max: 1920 }, height: { max: 1080 } },
    audio: {
        // Music / game sound, not a voice: no voice processing
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // Leave out this page's own output (the call's voices), or sharing the
        // system's sound would send everyone back their own voice
        restrictOwnAudio: true,
    },
    systemAudio: 'include',
};

/**
 * CallManager - Manages WebRTC P2P and SFU calls
 *
 * Key Principles:
 * 1. Only the JOINER creates peer connections with offers
 * 2. Existing participants WAIT for offers from joiners
 * 3. ICE candidates are queued until remote description is set
 * 4. Glare (simultaneous offers) is resolved with user ID tiebreaker
 * 5. All state changes use Vesta's reactive system
 */
export class CallManager {
    constructor() {
        // Call state
        this.currentCall = null;
        this.mode = 'p2p'; // 'p2p' or 'sfu'
        this.callType = 'audio'; // 'audio' or 'video'
        this.callState = 'none'; // 'none', 'banner', 'calling', 'active'
        this.hasAnyVideo = false; // true when any participant (local or remote) has active video
        this.callViewState = { callState: 'none', hasAnyVideo: false }; // combined reactive state for template

        // Media streams
        this.localStream = null;
        this.remoteStreams = {}; // userId -> MediaStream
        this.remoteParticipants = []; // Array for template rendering with status
        this.availableActions = []; // Dynamic actions based on state

        // WebRTC connections
        this.peerConnections = {}; // userId -> RTCPeerConnection
        this.iceCandidateQueues = {}; // userId -> [ICE candidates]

        // Audio/Video controls. Mic/headset state outlives a call (like Discord) and
        // is remembered across reloads.
        this.isMuted = loadPref('voice.muted', false);
        this.isVideoOff = false;
        this.isDeafened = loadPref('voice.deafened', false);
        this._mutedBeforeDeafen = loadPref('voice.mutedBeforeDeafen', false);
        // Screen share = its own video track in its own stream (not the camera's),
        // so it gets its own tile next to the person's, camera included.
        this.isScreenSharing = false;
        this._screenTrack = null;
        this._screenAudioTrack = null; // the shared tab / system sound, when the picker offered it
        this._screenStream = null;   // stream id the peers see the screen under (msid)
        this._screenPreview = null;  // MediaStream for our own screen tile
        this._screenSenders = {};    // userId -> {video, audio} RTCRtpSenders carrying our screen
        this.remoteScreens = {};     // userId -> their screen MediaStream (picture + sound)
        this.screenShares = [];      // [{userId, local, hasAudio, muted}] — the screen tiles (reactive)
        // Tile shown big with the others in a strip below ('local', '<userId>',
        // 'screen-local', 'screen-<userId>'), null = the grid. See toggleFocus.
        this.focus = null;

        // Remote audio plays through hidden <audio> elements that live outside the
        // views (#call-audio-sinks), so you keep hearing people while browsing
        // other channels. Tile <video> elements are visual only (always muted).
        // A screen share's sound has its own sink, volume and mute, keyed 'screen-<userId>'.
        this._audioSinks = {}; // userId | 'screen-<userId>' -> HTMLAudioElement
        this.userVolumes = loadPref('voice.userVolumes', {}); // same keys -> 0..1
        this.localMutes = {}; // same keys -> true when muted for me only
        this._speaking = {}; // analyser key ('local' | userId) -> last painted speaking state

        // Bumped by every getUserMedia request and by cleanup: a stream that lands
        // late (stale request, hung up meanwhile) is released at once.
        this._mediaRequest = 0;
        // Bumped by every vocal join and hang-up: only the latest join goes through.
        this._joinAttempt = 0;

        // Timers
        this._callingTimeout = null; // Cleared when first participant joins

        // Audio level monitoring (speaking indicator)
        this._audioContext = null;
        this._audioAnalysers = {}; // key -> { analyser, dataArray }
        this._audioMonitorInterval = null;

        this.setupWebSocketHandlers();
    }

    setupWebSocketHandlers() {
        // Register this instance globally for WebSocket handlers
        global.state.callManager = this;

        // Initialize reactive properties
        setElement('global.state.callManager.callState', this.callState);
        this._setRemoteParticipants(this.remoteParticipants);
        setElement('global.state.callManager.availableActions', this.availableActions);
        setElement('global.state.callManager.callViewState', this.callViewState);
        // userId -> {muted, deafened, video, screen, screen_audio} of everyone in a call we can see
        // (our own call's participants and the vocal channels of the servers we load)
        if (!global.state.voiceStates) global.state.voiceStates = {};
        this._stuckSince = {};     // userId -> when their tile started saying "Connecting…"
        this._stuckReported = {};  // userId -> last callPeerStuck sent about them
        setInterval(() => this._checkStuckPeers(), 5000);
    }

    /**
     * The WebSocket came back (network drop, laptop waking up…) while we were in
     * a call: the server gave us CALL_GRACE_S to return on a new socket. Claim the
     * call from this one; handleRebound gets the answer.
     */
    resyncAfterReconnect() {
        if (!this.currentCall?.id || (this.callState !== 'active' && this.callState !== 'calling')) return;
        this._sendWebSocketMessage({ type: 'callRebind', call_id: this.currentCall.id });
    }

    /** Server's answer to callRebind: still in, or gone (the grace ran out). */
    async handleRebound({ call_id, in_call, call }) {
        if (this.currentCall?.id !== call_id) return;
        if (in_call) {
            // Catch up on what we missed while away. Whoever left: drop their tile
            // and link. Whoever came: their offer was lost with the old socket, so
            // we're the one connecting (glare is handled if they offer again).
            const ids = new Set(call.participants);
            for (const p of [...this.remoteParticipants]) {
                if (!ids.has(p.userId)) this.handleParticipantLeft(call, p.userId);
            }
            this.currentCall = call;
            setElement('global.state.callManager.currentCall', call);
            this.mergeVoiceStates(call.voice_states);
            for (const userId of call.participants) {
                if (userId === global.user.id || this.remoteParticipants.some(p => p.userId === userId)) continue;
                this.remoteParticipants.push({ userId, status: 'connected' });
                this._setRemoteParticipants(this.remoteParticipants);
                if (this.mode === 'p2p') {
                    this.createPeerConnection(userId, true).catch(e => console.error('Catch-up connection failed:', e));
                }
            }
            this._broadcastVoiceState();
            return;
        }
        // Taken out while away: a vocal channel is joined again (like Discord), a
        // DM call is over for us
        const channelId = this.currentCall.vocal_channel_id;
        this.cleanup();
        if (channelId) await window.joinVocalChannel?.(channelId);
        else window.uiAlert?.(_t("Tu as été déconnecté·e de l'appel."));
    }

    /**
     * A participant whose media never arrives (tile stuck on "Connecting…") for
     * STUCK_AFTER_MS is reported to the server, every 10 s while it lasts; the
     * server kicks whoever everyone else reports and who is gone or cut off too
     * (Mycelium.report_stuck_peer). Dead sockets are swept server-side anyway.
     */
    _checkStuckPeers() {
        if (!this.currentCall || this.callState !== 'active') {
            this._stuckSince = {};
            this._stuckReported = {};
            return;
        }
        const now = Date.now();
        const stuck = new Set();
        for (const p of this.remoteParticipants) {
            if (p.status !== 'connected') continue;
            stuck.add(String(p.userId));
            const since = this._stuckSince[p.userId] ??= now;
            if (now - since >= STUCK_AFTER_MS && now - (this._stuckReported[p.userId] || 0) >= 10000) {
                this._stuckReported[p.userId] = now;
                this._sendWebSocketMessage({ type: 'callPeerStuck', call_id: this.currentCall.id, user_id: p.userId });
            }
        }
        for (const userId in this._stuckSince) {
            if (!stuck.has(userId)) {
                delete this._stuckSince[userId];
                delete this._stuckReported[userId];
            }
        }
    }

    /** Replace the participant list; the re-render recreates the tiles, so rebind streams. */
    _setRemoteParticipants(list) {
        this.remoteParticipants = list;
        setElement('global.state.callManager.remoteParticipants', list);
        requestAnimationFrame(() => this._reattachStreams());
        this._checkFocus();
    }

    // ==================== FOCUSED TILE ====================

    /**
     * A click on a tile of the vocal view: from the grid, show it big with the
     * others in a strip below; from the focused view, any click (a small tile or
     * the big one) goes back to the grid.
     */
    toggleFocus(key) {
        this.focus = this.focus === null ? String(key) : null;
        this._updateCallViewState();
    }

    /** The focused tile key, or null when it no longer exists (left, stopped sharing). */
    focusedKey() {
        const key = this.focus;
        if (key === null) return null;
        if (key === 'local') return key;
        if (key === 'screen-local') return this.isScreenSharing ? key : null;
        if (key.startsWith('screen-')) {
            return this.screenShares.some(s => !s.local && `screen-${s.userId}` === key) ? key : null;
        }
        return this.remoteParticipants.some(p => String(p.userId) === key) ? key : null;
    }

    /** Back to the grid when the focused tile went away (its strip would be all that's left). */
    _checkFocus() {
        if (this.focus !== null && this.focusedKey() === null) {
            this.focus = null;
            this._updateCallViewState();
        }
    }

    _updateCallViewState() {
        this.callViewState = { callState: this.callState, hasAnyVideo: this.hasAnyVideo, focus: this.focusedKey() };
        setElement('global.state.callManager.callViewState', this.callViewState);
        // The grid re-render recreates every <video> element, dropping their srcObject.
        // Re-attach all streams (local + remote) afterwards, or e.g. a peer enabling
        // their camera — which flips hasAnyVideo and triggers this very re-render —
        // would wipe the freshly-arrived remote video. Done without _updateHasAnyVideo
        // to avoid re-rendering recursively.
        requestAnimationFrame(() => this._reattachStreams());
    }

    // Re-bind every known stream to its (possibly recreated) <video> element.
    _reattachStreams() {
        this.displayLocalStream();
        for (const userId in this.remoteStreams) {
            const stream = this.remoteStreams[userId];
            const videoElement = document.getElementById(`remote-video-${userId}`);
            if (videoElement) {
                if (videoElement.srcObject !== stream) videoElement.srcObject = stream;
                videoElement.muted = true; // audio goes through the sinks
            }
            const participantElement = document.getElementById(`participant-${userId}`);
            if (participantElement) {
                participantElement.classList.toggle('has-stream', this._remoteHasVideo(userId));
            }
        }
        for (const share of this.screenShares) {
            const video = document.getElementById(`screen-video-${share.local ? 'local' : share.userId}`);
            const stream = share.local ? this._screenPreview : this.remoteScreens[share.userId];
            if (video && stream && video.srcObject !== stream) video.srcObject = stream;
        }
        for (const key in this._speaking) this._paintSpeaking(key);
    }

    /**
     * Whether a remote participant is currently sending picture. A receiver can't
     * see the sender disabling its camera track (it just gets black frames), so the
     * announced voice state wins when we have one.
     */
    _remoteHasVideo(userId) {
        const stream = this.remoteStreams[userId];
        if (!stream || !stream.getVideoTracks().some(t => t.readyState === 'live')) return false;
        const vs = global.state.voiceStates?.[userId];
        return vs ? !!vs.video : stream.getVideoTracks().some(t => t.enabled);
    }

    _localHasVideo() {
        return !!(this.localStream &&
            this.localStream.getVideoTracks().some(t => t.enabled && t.readyState === 'live') &&
            !this.isVideoOff);
    }

    _updateHasAnyVideo() {
        const anyRemoteVideo = Object.keys(this.remoteStreams).some(uid => this._remoteHasVideo(uid));
        const newHasAnyVideo = anyRemoteVideo || this._localHasVideo() || this.screenShares.length > 0;
        if (newHasAnyVideo !== this.hasAnyVideo) {
            this.hasAnyVideo = newHasAnyVideo;
            this._updateCallViewState();
        }
    }

    // ==================== AUDIO LEVEL MONITORING ====================

    /** Start polling audio levels for the speaking indicator. */
    _startAudioMonitor() {
        if (this._audioMonitorInterval) return;
        try {
            this._audioContext = new AudioContext();
        } catch (e) {
            // Browser may block without user gesture; speaking rings are lost but
            // the interval still drives the duration timers.
            this._audioContext = null;
        }
        // Connect local stream immediately if available
        if (this.localStream) this._connectStreamToAnalyser('local', this.localStream);
        this._audioMonitorInterval = setInterval(() => this._updateSpeakingIndicators(), 100);
    }

    /** Connect a MediaStream to an AnalyserNode for level detection. */
    _connectStreamToAnalyser(key, stream) {
        if (!this._audioContext || this._audioAnalysers[key]) return;
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) return;
        try {
            const source = this._audioContext.createMediaStreamSource(stream);
            const analyser = this._audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.8;
            source.connect(analyser);
            this._audioAnalysers[key] = { analyser, dataArray: new Uint8Array(analyser.frequencyBinCount) };
        } catch (e) { /* ignore */ }
    }

    /**
     * Poll all analysers and mark who is speaking. This runs 10 times a second, so
     * it toggles a class on the existing tile / sidebar row, and only when the
     * state flips: going through setElement would rebuild subscriptions (and the
     * tiles' <video>) at the rhythm of speech. _reattachStreams re-applies it to
     * re-rendered tiles.
     */
    _updateSpeakingIndicators() {
        for (const [key, { analyser, dataArray }] of Object.entries(this._audioAnalysers)) {
            analyser.getByteFrequencyData(dataArray);
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            // A muted mic still produces samples locally; nobody hears them.
            const speaking = avg > 8 && !(key === 'local' ? this.isMuted : this.localMutes[key]);
            if (!!this._speaking[key] === speaking) continue;
            this._speaking[key] = speaking;
            this._paintSpeaking(key);
        }
    }

    _paintSpeaking(key) {
        const speaking = !!this._speaking[key];
        const userId = key === 'local' ? global.user?.id : key;
        document.getElementById(key === 'local' ? 'participant-local' : `participant-${key}`)?.classList.toggle('speaking', speaking);
        document.getElementById(`vocal-occupant-${userId}`)?.classList.toggle('speaking', speaking);
    }

    /** Ticks global.state.callClock every second while in a vocal channel (duration labels subscribe to it). */
    _startCallClock() {
        if (this._clockInterval) return;
        setElement('global.state.callClock', Date.now());
        this._clockInterval = setInterval(() => setElement('global.state.callClock', Date.now()), 1000);
    }

    _stopCallClock() {
        clearInterval(this._clockInterval);
        this._clockInterval = null;
        setElement('global.state.callClock', null);
    }

    // ==================== REMOTE AUDIO OUTPUT ====================

    _attachAudio(userId, stream) {
        let audio = this._audioSinks[userId];
        if (!audio) {
            // <audio> elements can't come from a template: re-rendering a list
            // would recreate every one of them and cut everybody's sound.
            const container = document.getElementById('call-audio-sinks'); // main.html
            if (!container) return;
            audio = document.createElement('audio');
            audio.autoplay = true;
            audio.dataset.user = userId;
            container.appendChild(audio);
            this._audioSinks[userId] = audio;
        }
        if (audio.srcObject !== stream) audio.srcObject = stream;
        this._applyAudioSink(userId);
        audio.play?.().catch(() => {});
    }

    _applyAudioSink(userId) {
        const audio = this._audioSinks[userId];
        if (!audio) return;
        audio.muted = this.isDeafened || !!this.localMutes[userId];
        // Settings › speaker: device and master volume
        audio.volume = this.getUserVolume(userId) * outputGain();
        applyOutputDevice(audio);
    }

    _applyAllAudioSinks() {
        for (const userId in this._audioSinks) this._applyAudioSink(userId);
    }

    _detachAudio(userId) {
        const audio = this._audioSinks[userId];
        if (!audio) return;
        audio.srcObject = null;
        audio.remove();
        delete this._audioSinks[userId];
    }

    getUserVolume(userId) {
        const v = this.userVolumes[userId];
        return typeof v === 'number' ? Math.min(1, Math.max(0, v)) : 1;
    }

    /**
     * Volume (0..1) of one participant's voice — or of their screen share's sound
     * (key 'screen-<userId>') — for me only; remembered per key.
     */
    setUserVolume(key, volume) {
        this.userVolumes[key] = Math.min(1, Math.max(0, Number(volume)));
        savePref('voice.userVolumes', this.userVolumes);
        this._applyAudioSink(key);
        if (global.state.voiceMenu?.key === String(key)) {
            setElement('global.state.voiceMenu.volume', Math.round(this.userVolumes[key] * 100));
        }
    }

    toggleLocalMute(key) {
        this.localMutes[key] = !this.localMutes[key];
        this._applyAudioSink(key);
        // A screen share's sound: its tile shows the mute button state
        if (String(key).startsWith('screen-')) this._refreshScreenShares();
        return this.localMutes[key];
    }

    /** Stop audio monitoring and release resources. */
    _stopAudioMonitor() {
        if (this._audioMonitorInterval) {
            clearInterval(this._audioMonitorInterval);
            this._audioMonitorInterval = null;
        }
        this._audioAnalysers = {};
        // Sidebar rows outlive the call: don't leave anyone ringed green
        for (const key in this._speaking) { this._speaking[key] = false; this._paintSpeaking(key); }
        this._speaking = {};
        if (this._audioContext) {
            this._audioContext.close().catch(() => {});
            this._audioContext = null;
        }
    }

    // ==================== CALL LIFECYCLE ====================

    setBannerState(callData) {
        this.callState = 'banner';
        this.currentCall = callData;
        setElement('global.state.callManager.callState', 'banner');
        if (callData.participants) {
            this.remoteParticipants = callData.participants
                .filter(userId => userId !== global.user.id)
                .map(userId => ({ userId, status: 'active' }));
            this._setRemoteParticipants(this.remoteParticipants);
        }
        // Compute actions first so the single render below sees them already set
        this.updateAvailableActions();
        this._updateCallViewState();
    }

    /**
     * Update available actions based on current call state
     */
    updateAvailableActions() {
        switch (this.callState) {
            case 'banner':
                // Banner: show only the join/decline buttons (same UI as in-call, different actions)
                const call = global.convs[global.state.activeConv]?.ongoingCall || this.currentCall;
                this.availableActions = [
                    {
                        type: 'join',
                        callId: call?.id,
                        isVideo: call?.call_type === 'video'
                    }
                ];
                break;

            case 'calling':
            case 'active':
                // In call: show controls
                this.availableActions = [{ type: 'controls' }];
                break;

            default:
                this.availableActions = [];
        }

        setElement('global.state.callManager.availableActions', this.availableActions);
    }

    // ==================== MEDIA STREAM MANAGEMENT ====================

    /**
     * Get local media stream (audio/video)
     */
    async getLocalStream(video = false) {
        // Only the latest request keeps its stream: one that resolves after a newer
        // request or a hang-up (cleanup) stops its tracks — otherwise the mic stays
        // open with nothing holding it ("this tab is using your microphone").
        const request = ++this._mediaRequest;
        try {
            // Devices and voice processing from Settings › Voix & Vidéo. The mic goes
            // through MicPipeline (input volume, voice detection) before being sent.
            const captured = await getMedia({ audio: true, video });
            const mic = new MicPipeline();
            mic.onDeviceLost = () => this.updateMicInput();   // unplugged: back to the default mic
            const micTrack = await mic.start(new MediaStream(captured.getAudioTracks()));
            if (request !== this._mediaRequest) {
                mic.stop();
                captured.getTracks().forEach(t => t.stop());
                throw supersededError();
            }
            if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
            this._mic?.stop();
            this._mic = mic;
            this.localStream = new MediaStream([micTrack, ...captured.getVideoTracks()]);
            this.callType = video ? 'video' : 'audio';
            this.isVideoOff = !video;
            setElement('global.state.callManager.callType', this.callType);

            // Apply pre-set mute state immediately
            this._applyLocalMic();

            this.displayLocalStream();
            console.log(`✅ Local ${this.callType} stream acquired`);

            return this.localStream;
        } catch (error) {
            if (error.superseded) throw error;
            // Fallback: if video fails, try audio only
            if (video && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')) {
                console.warn('Video permission denied, falling back to audio only');
                try {
                    return await this.getLocalStream(false);
                } catch (audioError) {
                    throw new Error('Microphone access required to make calls.');
                }
            }

            // Handle various getUserMedia errors
            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                throw new Error('Microphone/camera permission denied.');
            } else if (error.name === 'NotFoundError') {
                throw new Error('No microphone/camera found.');
            } else if (error.name === 'NotReadableError') {
                throw new Error('Microphone/camera is already in use.');
            } else {
                throw new Error(`Media access error: ${error.message}`);
            }
        }
    }

    displayLocalStream() {
        const localVideo = document.getElementById('local-video');
        if (localVideo && this.localStream) {
            localVideo.srcObject = this.localStream;
            localVideo.muted = true; // Prevent echo
        }
        const localTile = document.getElementById('participant-local');
        if (localTile) {
            const hasVideo = !!(this.localStream &&
                this.localStream.getVideoTracks().some(t => t.enabled) &&
                !this.isVideoOff);
            localTile.classList.toggle('has-stream', hasVideo);
        }
    }

    /**
     * Play outgoing call ringtone
     */
    playOutgoingRingtone() {
        const ringtone = document.getElementById('outgoing-call-tone');
        if (ringtone) {
            applyOutputDevice(ringtone);
            ringtone.currentTime = 0;
            ringtone.play().catch(e => console.log('Cannot play outgoing ringtone:', e));
        }
    }

    /**
     * Stop outgoing call ringtone
     */
    stopOutgoingRingtone() {
        const ringtone = document.getElementById('outgoing-call-tone');
        if (ringtone) {
            ringtone.pause();
            ringtone.currentTime = 0;
        }
    }

    // ==================== CALL LIFECYCLE ====================

    /**
     * Start a new call
     */
    async startCall(conversationId, video = false) {
        if (this.callState === 'calling' || this.callState === 'active') {
            if (this.currentCall?.conversation_id === conversationId) return; // already in it
            await this.leaveCall(); // e.g. connected to a vocal channel: one call at a time
        }
        try {
            await this.getLocalStream(video);

            // Create call on server
            const response = await this._httpRequest('POST', `/start_call?conversation_id=${conversationId}&call_type=${this.callType}`);

            // Update state reactively
            this.currentCall = response;
            this.mode = response.mode;
            this.callState = 'calling';
            setElement('global.state.callManager.currentCall', response);
            setElement('global.state.callManager.mode', response.mode);
            setElement('global.state.callManager.callState', 'calling');
            this._updateCallViewState();

            // Get conversation members and add them as 'calling' participants
            const conv = global.convs[conversationId];
            if (conv && conv.members) {
                this.remoteParticipants = conv.members
                    .filter(userId => userId !== global.user.id)
                    .map(userId => ({ userId, status: 'calling' }));
                this._setRemoteParticipants(this.remoteParticipants);
            }

            // Update available actions
            this.updateAvailableActions();

            // Play outgoing call ringtone
            this.playOutgoingRingtone();

            // Auto-cancel call if nobody joins within 30 seconds
            this._callingTimeout = setTimeout(() => {
                if (this.callState === 'calling') {
                    console.log('⏰ Calling timeout — no one joined after 30s');
                    this.cleanup();
                }
            }, 30000);

            // Start audio level monitoring for the speaking indicator
            this._startAudioMonitor();

            // Notify server via WebSocket
            this._sendWebSocketMessage({
                type: "callStart",
                conversation_id: conversationId,
                call_type: this.callType
            });
            this._broadcastVoiceState();

            console.log(`✅ Call started (ID: ${response.id}, mode: ${this.mode})`);
            return response;

        } catch (error) {
            if (error.superseded) return null;   // hung up while the mic was being granted
            console.error('❌ Failed to start call:', error);
            this.cleanup();
            throw error;
        }
    }

    /**
     * Join an existing call
     */
    async joinCall(callId, video = false) {
        if (this.callState === 'calling' || this.callState === 'active') {
            if (this.currentCall?.id === callId) return; // already in it
            await this.leaveCall(); // e.g. connected to a vocal channel: one call at a time
        }
        try {
            await this.getLocalStream(video);

            // Dismiss native incoming call notification (if any)
            if (isNative) nativeCallEnded();

            // Join call on server
            const response = await this._httpRequest('POST', `/join_call?call_id=${callId}`);

            // Update state reactively
            this.currentCall = response.call;
            this.mode = response.call.mode;
            this.callState = 'active';
            setElement('global.state.callManager.currentCall', response.call);
            setElement('global.state.callManager.mode', response.call.mode);
            setElement('global.state.callManager.callState', 'active');
            this._updateCallViewState();

            // Initialize remote participants with 'connected' status
            this.remoteParticipants = response.call.participants
                .filter(userId => userId !== global.user.id)
                .map(userId => ({ userId, status: 'connected' }));
            this._setRemoteParticipants(this.remoteParticipants);

            // Update available actions
            this.updateAvailableActions();

            // Start audio level monitoring for the speaking indicator
            this._startAudioMonitor();

            // Notify server via WebSocket
            this._sendWebSocketMessage({
                type: "callJoin",
                call_id: callId
            });
            this.mergeVoiceStates(response.call.voice_states);
            this._broadcastVoiceState();

            // IMPORTANT: As the joiner, WE create offers to all existing participants
            if (this.mode === 'p2p') {
                for (const participantId of this.currentCall.participants) {
                    if (participantId !== global.user.id) {
                        console.log(`📤 Creating peer connection to user ${participantId} (we are joiner)`);
                        await this.createPeerConnection(participantId, true);
                    }
                }
            } else if (this.mode === 'sfu') {
                await this.createSFUConnection();
            }

            console.log(`✅ Joined call (ID: ${callId}, mode: ${this.mode})`);
            return response;

        } catch (error) {
            if (error.superseded) return null;   // hung up while the mic was being granted
            console.error('❌ Failed to join call:', error);
            this.cleanup();
            throw error;
        }
    }

    /**
     * Leave the current call
     */
    async leaveCall() {
        if (!this.currentCall) return;

        try {
            const callId = this.currentCall.id;
            const vocalChannelId = this.currentCall.vocal_channel_id;

            if (vocalChannelId) {
                // Vocal channels: the WS vocalLeave handler is the single source of
                // truth — it mutates the call and broadcasts presence. Calling the
                // HTTP /leave_call too would run leave_call twice and leave the last
                // participant stuck in a half-ended state (stale occupant list).
                this._sendWebSocketMessage({
                    type: "vocalLeave",
                    call_id: callId,
                    channel_id: vocalChannelId
                });
            } else {
                // Notify server via HTTP
                await this._httpRequest('POST', `/leave_call?call_id=${callId}`);
                this._sendWebSocketMessage({
                    type: "callLeave",
                    call_id: callId
                });
            }

            console.log(`✅ Left call (ID: ${callId})`);
        } catch (error) {
            console.error('❌ Error leaving call:', error);
        } finally {
            this.cleanup();
        }
    }

    // ==================== PEER CONNECTION MANAGEMENT ====================

    /** Our tracks for a new connection: mic/camera, plus the screen (and its sound) when sharing. */
    _addLocalTracks(pc, userId) {
        if (!this.localStream) return;
        this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
        if (this._screenTrack) {
            this._screenSenders[userId] = {
                video: pc.addTrack(this._screenTrack, this._screenStream),
                audio: this._screenAudioTrack ? pc.addTrack(this._screenAudioTrack, this._screenStream) : null,
            };
            tuneScreenSender(this._screenSenders[userId].video);
        }
    }

    /**
     * Create a WebRTC peer connection
     * @param {number} userId - The user to connect to
     * @param {boolean} createOffer - Whether to create and send an offer
     */
    async createPeerConnection(userId, createOffer = false) {
        console.log(`🔗 Creating peer connection to user ${userId} (createOffer: ${createOffer})`);

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        this.peerConnections[userId] = pc;
        this.iceCandidateQueues[userId] = []; // Initialize queue

        this._addLocalTracks(pc, userId);

        // ICE candidate handler
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this._sendWebSocketMessage({
                    type: "callIce",
                    call_id: this.currentCall.id,
                    target_user: userId,
                    signal: { candidate: event.candidate }
                });
            }
        };

        // Remote track handler
        pc.ontrack = (event) => {
            const stream = event.streams[0];
            if (!stream) return;
            console.log(`📥 Received remote track from user ${userId}`);
            // Their mic/camera stream comes first (its tracks are added first, see
            // _addLocalTracks); a stream with another id is their screen share,
            // picture and, when they shared it, sound (ontrack fires once per track).
            const main = this.remoteStreams[userId];
            if (main && stream.id !== main.id) {
                this.remoteScreens[userId] = stream;
                if (stream.getAudioTracks().length) this._attachAudio(`screen-${userId}`, stream);
                this._refreshScreenShares();
                return;
            }
            this.remoteStreams[userId] = stream;
            this.displayRemoteStream(userId, stream);
            // Not 'active' yet: tracks show up with the SDP, before any media
            // flows. The tile leaves "Connecting…" once the link is up (below).
        };

        // Connection state monitoring
        pc.onconnectionstatechange = () => {
            console.log(`🔄 Connection state with ${userId}: ${pc.connectionState}`);
            if (this.peerConnections[userId] !== pc) return;   // replaced meanwhile
            clearTimeout(pc._disconnectTimer);
            if (pc.connectionState === 'disconnected') {
                // Often a network blip that ICE recovers from on its own: closing
                // right away used to cut the sound for good. Give it a moment.
                pc._disconnectTimer = setTimeout(() => {
                    if (this.peerConnections[userId] === pc && pc.connectionState === 'disconnected') {
                        this._reconnectPeer(userId);
                    }
                }, 8000);
            } else if (pc.connectionState === 'failed') {
                this._reconnectPeer(userId);
            } else if (pc.connectionState === 'connected') {
                console.log(`✅ Connected to user ${userId}`);
                // Media flows: the tile stops saying "Connecting…" (see _checkStuckPeers)
                const participant = this.remoteParticipants.find(p => p.userId === Number(userId));
                if (participant && participant.status !== 'active') {
                    participant.status = 'active';
                    this._setRemoteParticipants(this.remoteParticipants);
                }
            }
        };

        // ICE connection state monitoring
        pc.oniceconnectionstatechange = () => {
            console.log(`🧊 ICE state with ${userId}: ${pc.iceConnectionState}`);
        };

        // Create and send offer if we're the initiator
        if (createOffer) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            this._sendWebSocketMessage({
                type: "callOffer",
                call_id: this.currentCall.id,
                target_user: userId,
                signal: { sdp: offer }
            });

            console.log(`📤 Offer sent to user ${userId}`);
        }

        return pc;
    }

    /**
     * Create SFU server connection
     */
    async createSFUConnection() {
        console.log('🔗 Creating SFU server connection');

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        this.peerConnections['sfu_server'] = pc;
        this.iceCandidateQueues['sfu_server'] = [];

        this._addLocalTracks(pc, 'sfu_server');

        // ICE candidate handler
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this._sendWebSocketMessage({
                    type: "callIce",
                    call_id: this.currentCall.id,
                    signal: { candidate: event.candidate }
                });
            }
        };

        // Remote track handler
        pc.ontrack = (event) => {
            const streamId = event.streams[0].id;
            console.log(`📥 Received remote track from SFU (stream: ${streamId})`);
            this.remoteStreams[streamId] = event.streams[0];
            this.displayRemoteStream(streamId, event.streams[0]);
        };

        // Create and send offer to SFU
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        this._sendWebSocketMessage({
            type: "callOffer",
            call_id: this.currentCall.id,
            signal: { sdp: offer }
        });

        console.log('📤 Offer sent to SFU server');
        return pc;
    }

    // ==================== SIGNALING HANDLERS ====================

    /**
     * Handle incoming WebRTC offer
     */
    async handleOffer(fromUser, signal) {
        console.log(`📨 Received offer from user ${fromUser}`);

        try {
            const existingPc = this.peerConnections[fromUser];

            // Handle offer glare (both sides sent offers simultaneously)
            if (existingPc && existingPc.signalingState === 'have-local-offer') {
                console.warn(`⚠️ Offer glare with user ${fromUser}`);

                // Tiebreaker: lower user ID wins
                if (global.user.id < fromUser) {
                    console.log(`  → We win (${global.user.id} < ${fromUser}), ignoring their offer`);
                    return;
                } else if (existingPc.currentRemoteDescription) {
                    // An established connection renegotiating (camera / screen share on
                    // both sides at once): roll our offer back instead of closing it, so
                    // the media keeps flowing. Our pending tracks get no m-line in their
                    // offer, and the check after the answer below re-offers them.
                    console.log(`  → They win (${fromUser} < ${global.user.id}), rolling back our offer`);
                    await existingPc.setLocalDescription({ type: 'rollback' });
                } else {
                    console.log(`  → They win (${fromUser} < ${global.user.id}), accepting their offer`);
                    existingPc.close();
                    delete this.peerConnections[fromUser];
                }
            }

            // Reuse an already-established connection so a renegotiation (e.g. a peer
            // turning on their camera) is applied in place. Tearing the connection
            // down and recreating it would start a fresh ICE session on our side while
            // the offerer keeps theirs, so the credentials mismatch and the new media
            // never connects. Only build a new connection when there isn't a usable one.
            let pc = this.peerConnections[fromUser];
            // A dead connection (the other side is reconnecting) is rebuilt, not renegotiated
            if (pc && pc.signalingState === 'stable' && !['failed', 'closed'].includes(pc.connectionState)) {
                console.log(`♻️ Renegotiating existing connection with ${fromUser}`);
            } else {
                if (pc) {
                    console.log(`♻️ Closing unusable connection with ${fromUser} (state: ${pc.signalingState})`);
                    pc.close();
                    delete this.peerConnections[fromUser];
                }
                pc = await this.createPeerConnection(fromUser, false);
            }

            // Set remote description
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

            // Process queued ICE candidates
            await this.processIceCandidateQueue(fromUser);

            // Create and send answer
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            this._sendWebSocketMessage({
                type: "callAnswer",
                call_id: this.currentCall.id,
                target_user: fromUser,
                signal: { sdp: answer }
            });

            console.log(`✅ Answer sent to user ${fromUser} (state: ${pc.signalingState})`);

            // Tracks of ours the offer had no m-line for (our camera or screen while
            // they joined audio-only) are not sent yet: offer them in turn.
            if (pc.getTransceivers().some(t => t.sender.track && !t.mid)) {
                await this._renegotiate(pc, fromUser);
            }
        } catch (error) {
            console.error(`❌ Error handling offer from ${fromUser}:`, error);
        }
    }

    /**
     * Handle incoming WebRTC answer
     */
    async handleAnswer(fromUser, signal) {
        console.log(`📨 Received answer from user ${fromUser}`);

        const pc = this.peerConnections[fromUser] || this.peerConnections['sfu_server'];

        if (!pc) {
            console.warn(`⚠️ Received answer from ${fromUser} but no peer connection exists`);
            return;
        }

        // Verify we're in the correct state
        if (pc.signalingState !== 'have-local-offer') {
            console.warn(`⚠️ Received answer from ${fromUser} but state is '${pc.signalingState}' (expected 'have-local-offer'). Ignoring.`);
            return;
        }

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

            // Process queued ICE candidates
            await this.processIceCandidateQueue(fromUser);

            console.log(`✅ Answer processed from user ${fromUser}`);
        } catch (error) {
            console.error(`❌ Error processing answer from ${fromUser}:`, error);
        }
    }

    /**
     * Handle incoming ICE candidate
     */
    async handleIceCandidate(fromUser, signal) {
        const pc = this.peerConnections[fromUser] || this.peerConnections['sfu_server'];

        if (!pc) {
            console.warn(`⚠️ ICE candidate from ${fromUser} but no connection exists`);
            return;
        }

        if (!signal.candidate) {
            return;
        }

        try {
            // Only add if remote description is set, otherwise queue
            if (pc.remoteDescription && pc.remoteDescription.type) {
                await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                console.log(`✅ ICE candidate added for ${fromUser}`);
            } else {
                this.iceCandidateQueues[fromUser] = this.iceCandidateQueues[fromUser] || [];
                this.iceCandidateQueues[fromUser].push(signal.candidate);
                console.log(`📥 ICE candidate queued for ${fromUser} (waiting for remote description)`);
            }
        } catch (error) {
            console.error(`❌ Error adding ICE candidate from ${fromUser}:`, error);
        }
    }

    /**
     * Process queued ICE candidates after remote description is set
     */
    async processIceCandidateQueue(userId) {
        const queue = this.iceCandidateQueues[userId];
        if (!queue || queue.length === 0) {
            return;
        }

        const pc = this.peerConnections[userId];
        if (!pc) {
            return;
        }

        console.log(`📤 Processing ${queue.length} queued ICE candidates for ${userId}`);

        for (const candidate of queue) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
                console.error(`❌ Error adding queued ICE candidate:`, error);
            }
        }

        // Clear queue
        this.iceCandidateQueues[userId] = [];
    }

    // ==================== PARTICIPANT MANAGEMENT ====================

    /**
     * Handle when a participant joins the call
     */
    async handleParticipantJoined(callData, newUserId) {
        console.log(`👋 Participant ${newUserId} joined`);

        const isNewcomer = newUserId !== global.user.id && !this.currentCall?.participants?.includes(newUserId);
        // Update call data
        this.currentCall = callData;
        setElement('global.state.callManager.currentCall', callData);
        this.mergeVoiceStates(callData.voice_states);
        if (isNewcomer) playVoiceCue('join');

        // If we were in 'calling' state and someone joined, transition to 'active'
        if (this.callState === 'calling' && newUserId !== global.user.id) {
            // Cancel the 30s unanswered-call timeout
            if (this._callingTimeout) {
                clearTimeout(this._callingTimeout);
                this._callingTimeout = null;
            }

            this.callState = 'active';
            setElement('global.state.callManager.callState', 'active');
            this._updateCallViewState();

            // Stop outgoing ringtone
            this.stopOutgoingRingtone();

            // Update available actions
            this.updateAvailableActions();

            // Update participant status from 'calling' to 'connected'
            const participant = this.remoteParticipants.find(p => p.userId === newUserId);
            if (participant) {
                participant.status = 'connected';
            } else {
                // Add new participant if not already in list
                this.remoteParticipants.push({ userId: newUserId, status: 'connected' });
            }
            this._setRemoteParticipants(this.remoteParticipants);
        } else if (newUserId !== global.user.id) {
            // Add participant if not already present
            const exists = this.remoteParticipants.find(p => p.userId === newUserId);
            if (!exists) {
                this.remoteParticipants.push({ userId: newUserId, status: 'connected' });
                this._setRemoteParticipants(this.remoteParticipants);
            }
        }

        // Handle mode change
        if (this.mode !== callData.mode) {
            console.log(`🔄 Mode changed: ${this.mode} → ${callData.mode}`);
            await this.handleModeSwitch(callData.mode);
        }

        // CRITICAL: Do NOT create peer connection here!
        // The joiner will send us an offer, we wait for it
        if (this.mode === 'p2p' && newUserId && newUserId !== global.user.id) {
            console.log(`✋ Waiting for offer from user ${newUserId} (they are the joiner)`);
        }
    }

    /**
     * Handle when a participant leaves the call
     */
    handleParticipantLeft(callData, leftUserId) {
        console.log(`👋 Participant ${leftUserId} left`);
        if (leftUserId !== global.user.id && this.remoteParticipants.some(p => p.userId === leftUserId)) {
            playVoiceCue('leave');
        }
        this.setVoiceState(leftUserId, null);

        // Update call data
        this.currentCall = callData;
        setElement('global.state.callManager.currentCall', callData);

        // Always remove from the reactive participant list (handles audio-only participants
        // who never had a remoteStreams entry)
        this.remoteParticipants = this.remoteParticipants.filter(p => p.userId !== leftUserId);
        this._setRemoteParticipants(this.remoteParticipants);

        // Clean up their WebRTC connection and any streams
        this.handlePeerDisconnection(leftUserId);

        // Handle mode change if needed
        if (callData.mode && this.mode !== callData.mode) {
            this.handleModeSwitch(callData.mode);
        }
    }

    /**
     * The media link with a participant broke (failed, or disconnected for too
     * long). If they're still in the call (a dead browser is removed by the
     * server, call_participant_left), build a new connection: one side only
     * offers (lower id, like the glare tiebreak), the other waits for that offer.
     * Their tile stays meanwhile.
     */
    _reconnectPeer(userId) {
        this.handlePeerDisconnection(userId);
        const participant = this.remoteParticipants.find(p => p.userId === Number(userId));
        if (!participant || !this.currentCall || this.mode !== 'p2p') return;
        // Back to "Connecting…" until media flows again (counts towards _checkStuckPeers)
        participant.status = 'connected';
        this._setRemoteParticipants(this.remoteParticipants);
        if (global.user.id < Number(userId)) {
            console.log(`🔁 Reconnecting to user ${userId}`);
            this.createPeerConnection(Number(userId), true).catch(e => console.error('Reconnect failed:', e));
        }
    }

    /**
     * Handle peer disconnection
     */
    handlePeerDisconnection(userId) {
        console.log(`🔌 Disconnecting from user ${userId}`);

        if (this.peerConnections[userId]) {
            this.peerConnections[userId].close();
            delete this.peerConnections[userId];
        }

        if (this.remoteStreams[userId]) {
            delete this.remoteStreams[userId];
            this._updateHasAnyVideo();
        }
        this._detachAudio(userId);
        this._detachAudio(`screen-${userId}`);
        delete this._screenSenders[userId];
        if (this.remoteScreens[userId]) {
            delete this.remoteScreens[userId];
            this._refreshScreenShares();
        }

        delete this._audioAnalysers[String(userId)];
        if (this._speaking[userId]) { this._speaking[userId] = false; this._paintSpeaking(String(userId)); }
        delete this._speaking[userId];
        delete this.iceCandidateQueues[userId];
    }

    /**
     * Handle mode switch (P2P ↔ SFU)
     */
    async handleModeSwitch(newMode) {
        console.log(`🔄 Switching mode: ${this.mode} → ${newMode}`);

        this.mode = newMode;
        setElement('global.state.callManager.mode', newMode);

        // Close all existing connections
        for (const userId in this.peerConnections) {
            this.peerConnections[userId].close();
        }
        this.peerConnections = {};
        this.iceCandidateQueues = {};
        this._screenSenders = {};

        // Recreate connections in new mode
        if (newMode === 'sfu') {
            await this.createSFUConnection();
        } else if (newMode === 'p2p') {
            // Deterministic offer direction: higher ID sends the offer in each pair,
            // avoiding glare without any coordination.
            for (const participantId of this.currentCall.participants) {
                if (participantId !== global.user.id) {
                    await this.createPeerConnection(participantId, global.user.id > participantId);
                }
            }
        }
    }


    // ==================== UI MANAGEMENT ====================

    /**
     * Display remote user's video stream
     */
    displayRemoteStream(userId, stream) {
        if (!stream) return;
        // Sound doesn't depend on any view being open
        this._attachAudio(userId, stream);
        // Hook into the audio monitor so this participant gets a speaking indicator
        this._connectStreamToAnalyser(String(userId), stream);
        // A video track arriving later (camera / screen share) must refresh the tile
        stream.onaddtrack = () => { this._updateHasAnyVideo(); this._reattachStreams(); };
        // Wait for template to render the element, then attach the picture
        requestAnimationFrame(() => {
            this._reattachStreams();
            this._updateHasAnyVideo();
        });
    }

    /**
     * Remove remote user's audio analyser (stream and participant list managed by caller)
     */
    removeRemoteStreamDisplay(userId) {
        delete this._audioAnalysers[String(userId)];
    }

    // ==================== AUDIO/VIDEO CONTROLS ====================

    _applyLocalMic() {
        const audioTrack = this.localStream?.getAudioTracks()[0];
        if (audioTrack) audioTrack.enabled = !this.isMuted;
    }

    // Discord semantics: deafening also mutes the mic; undeafening restores the mic
    // as it was; unmuting while deafened undeafens too.
    toggleMute() {
        if (this.isDeafened) {
            this.isDeafened = false;
            this.isMuted = false;
        } else {
            this.isMuted = !this.isMuted;
        }
        this._afterVoiceToggle();
        playVoiceCue(this.isMuted ? 'mute' : 'unmute');
        console.log(`🎤 Mute: ${this.isMuted}`);
    }

    toggleDeafen() {
        this.isDeafened = !this.isDeafened;
        if (this.isDeafened) {
            this._mutedBeforeDeafen = this.isMuted;
            this.isMuted = true;
        } else {
            this.isMuted = this._mutedBeforeDeafen;
        }
        this._afterVoiceToggle();
        playVoiceCue(this.isDeafened ? 'deafen' : 'undeafen');
        console.log(`🔇 Deafen: ${this.isDeafened}`);
    }

    _afterVoiceToggle() {
        this._applyLocalMic();
        this._applyAllAudioSinks();
        savePref('voice.muted', this.isMuted);
        savePref('voice.deafened', this.isDeafened);
        savePref('voice.mutedBeforeDeafen', this._mutedBeforeDeafen);
        this.updateCallControls();
        this._broadcastVoiceState();
    }

    async toggleVideo() {
        if (!this.localStream) return;
        const videoTrack = this.localStream.getVideoTracks()[0];
        if (videoTrack?.enabled) {
            videoTrack.enabled = false;
            this.isVideoOff = true;
            this._afterVideoToggle();
            return;
        }
        // Settings › "Toujours afficher un aperçu de la vidéo": look before going on
        let previewed = null;
        if (voicePrefs.cameraPreview) {
            previewed = await previewCamera();
            if (!previewed) return;
            if (!this.localStream || !this.currentCall) {   // hung up during the preview
                previewed.stop();
                return;
            }
        }
        const current = this.localStream.getVideoTracks()[0];
        if (!current) {
            this._enableCamera(previewed);
            return;
        }
        if (previewed) {
            this._replaceLocalTrack(current, previewed);
            current.stop();
        } else {
            current.enabled = true;
        }
        this.isVideoOff = false;
        this._afterVideoToggle();
    }

    _afterVideoToggle() {
        this.updateCallControls();
        this._updateHasAnyVideo();
        this._reattachStreams();
        this._broadcastVoiceState();
        console.log(`📹 Video off: ${this.isVideoOff}`);
    }

    /** Turn the camera on for the first time in this call (`track`: already captured by the preview). */
    async _enableCamera(track = null) {
        try {
            const videoTrack = track || (await getMedia({ video: true })).getVideoTracks()[0];
            if (!videoTrack) return;
            if (!this.localStream || !this.currentCall) {   // hung up while the camera was being granted
                videoTrack.stop();
                return;
            }

            this.localStream.addTrack(videoTrack);
            this.callType = 'video';
            this.isVideoOff = false;
            setElement('global.state.callManager.callType', this.callType);

            await this._sendVideoTrack(videoTrack);

            // _updateHasAnyVideo triggers _updateCallViewState which re-renders the
            // outer Subscribe and schedules displayLocalStream() via rAF so srcObject
            // is re-attached to the freshly created #local-video element.
            this._updateHasAnyVideo();
            this._reattachStreams();
            this.updateCallControls();
            this._broadcastVoiceState();
            console.log('📹 Camera enabled');
        } catch (error) {
            console.error('❌ Failed to enable camera:', error);
        }
    }

    /**
     * Make every peer connection send `track` as our camera: replace the track of
     * our camera sender when there is one (no renegotiation), otherwise addTrack
     * with our stream (the peer files it under our camera stream) + renegotiate.
     */
    async _sendVideoTrack(track) {
        for (const userId in this.peerConnections) {
            const pc = this.peerConnections[userId];
            const sender = pc.getSenders().find(sd => sd.track?.kind === 'video' && sd !== this._screenSenders[userId]?.video);
            if (sender) {
                await sender.replaceTrack(track);
                continue;
            }
            pc.addTrack(track, this.localStream);
            await this._renegotiate(pc, userId);
        }
    }

    // ==================== SETTINGS › VOIX & VIDÉO (live) ====================

    /** Swap one of our tracks (mic, camera) in our stream and on every connection, without renegotiating. */
    _replaceLocalTrack(oldTrack, newTrack) {
        if (!this.localStream || oldTrack === newTrack) return;
        if (oldTrack) this.localStream.removeTrack(oldTrack);
        this.localStream.addTrack(newTrack);
        for (const pc of Object.values(this.peerConnections)) {
            const sender = pc.getSenders().find(s => s.track === oldTrack);
            sender?.replaceTrack(newTrack).catch(e => console.warn('replaceTrack failed:', e));
        }
        if (newTrack.kind === 'audio') {   // the speaking ring listens to the old track
            delete this._audioAnalysers.local;
            this._connectStreamToAnalyser('local', this.localStream);
        }
    }

    /** Mic device or voice processing changed: capture again. */
    async updateMicInput() {
        const mic = this._mic;
        if (!mic || !this.localStream) return;
        const before = mic.track;
        try {
            await mic.restart();
        } catch (e) {
            console.warn('Mic switch failed:', e);
            return;
        }
        if (mic !== this._mic) return;   // hung up meanwhile
        // Only changes when the mic is sent as captured (no Web Audio processing)
        if (mic.track !== before) this._replaceLocalTrack(before, mic.track);
        this._applyLocalMic();
    }

    /** Mic volume / voice detection changed. */
    updateMicProcessing() {
        this._mic?.applySettings();
    }

    /** Speaker device / volume changed. */
    applyOutputSettings() {
        this._applyAllAudioSinks();
        applyOutputDevice(document.getElementById('outgoing-call-tone'));
    }

    /** Camera device changed: keep filming (or not) with the new one. */
    async switchCamera() {
        const old = this.localStream?.getVideoTracks()[0];
        if (!old || old.readyState !== 'live') return;
        let track;
        try {
            track = (await getMedia({ video: true })).getVideoTracks()[0];
        } catch (e) {
            console.warn('Camera switch failed:', e);
            return;
        }
        if (!track) return;
        if (this.localStream?.getVideoTracks()[0] !== old) {   // camera changed or hung up meanwhile
            track.stop();
            return;
        }
        track.enabled = old.enabled;
        this._replaceLocalTrack(old, track);
        old.stop();
        this._reattachStreams();
    }

    async _renegotiate(pc, userId) {
        if (pc.signalingState !== 'stable') return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._sendWebSocketMessage({
            type: "callOffer",
            call_id: this.currentCall.id,
            target_user: parseInt(userId),
            signal: { sdp: offer }
        });
    }

    async toggleScreenShare() {
        if (this.isScreenSharing) return this.stopScreenShare();
        // The picker is open: a second click must not start a second capture
        if (this._startingScreenShare) return;
        if (!this.currentCall || !navigator.mediaDevices?.getDisplayMedia) return;
        let screenStream;
        this._startingScreenShare = true;
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia(SCREEN_CAPTURE)
                // A browser refusing the audio options outright: picture only
                .catch(e => e?.name === 'TypeError' ? navigator.mediaDevices.getDisplayMedia({ video: true }) : Promise.reject(e));
        } catch (error) {
            console.log('Screen share cancelled:', error?.name);
            return;
        } finally {
            this._startingScreenShare = false;
        }
        const screenTrack = screenStream.getVideoTracks()[0];
        // Only when the picker offered it and the user kept "share audio" ticked
        const audioTrack = screenStream.getAudioTracks()[0] || null;
        if (!screenTrack || !this.currentCall) {   // nothing picked, or hung up meanwhile
            screenStream.getTracks().forEach(t => t.stop());
            return;
        }
        // 'motion', not 'detail': 'detail' makes libwebrtc encode in "screenshare"
        // mode, which held the stream at 4-9 fps for long stretches (measured)
        screenTrack.contentHint = 'motion';
        if (audioTrack) audioTrack.contentHint = 'music';
        // The browser's own "Stop sharing" button ends the track
        screenTrack.addEventListener('ended', () => this.stopScreenShare());

        this._screenTrack = screenTrack;
        this._screenAudioTrack = audioTrack;
        this._screenPreview = new MediaStream([screenTrack]);   // picture only: we don't play our own sound
        this._screenStream = this._screenStream || new MediaStream(); // stable id for the peers
        this.isScreenSharing = true;
        for (const userId in this.peerConnections) {
            const pc = this.peerConnections[userId];
            const senders = pc.getSenders();
            const prev = this._screenSenders[userId];
            const video = prev?.video && senders.includes(prev.video) ? prev.video : null;
            const audio = prev?.audio && senders.includes(prev.audio) ? prev.audio : null;
            // Shared before: replaceTrack, no renegotiation. A missing sender (first
            // share, or the first one with sound) needs an addTrack + a new offer.
            let renegotiate = false;
            const next = { video, audio };
            if (video) await video.replaceTrack(screenTrack);
            else { next.video = pc.addTrack(screenTrack, this._screenStream); renegotiate = true; }
            if (audio) await audio.replaceTrack(audioTrack);
            else if (audioTrack) { next.audio = pc.addTrack(audioTrack, this._screenStream); renegotiate = true; }
            this._screenSenders[userId] = next;
            await tuneScreenSender(next.video);
            if (renegotiate) await this._renegotiate(pc, userId);
        }
        this._afterScreenToggle();
        console.log('🖥️ Screen share started');
    }

    async stopScreenShare() {
        if (!this.isScreenSharing) return;
        const tracks = [this._screenTrack, this._screenAudioTrack];
        this._screenTrack = null;
        this._screenAudioTrack = null;
        this._screenPreview = null;
        this.isScreenSharing = false;
        tracks.forEach(t => t?.stop());
        // Keep the senders (track null): sharing again is a replaceTrack, and the
        // peers drop the tile as soon as our voice state says screen: false
        for (const userId in this._screenSenders) {
            const { video, audio } = this._screenSenders[userId];
            await video?.replaceTrack(null).catch(() => {});
            await audio?.replaceTrack(null).catch(() => {});
        }
        this._afterScreenToggle();
        console.log('🖥️ Screen share stopped');
    }

    _afterScreenToggle() {
        setElement('global.state.callManager.isScreenSharing', this.isScreenSharing);
        this._broadcastVoiceState();
        this._refreshScreenShares();
    }

    /**
     * Recompute the screen tiles: ours while sharing, and each peer whose screen
     * stream arrived and whose voice state says they're sharing (either can come
     * first). Re-renders only when the list changes.
     */
    _refreshScreenShares() {
        const list = this.isScreenSharing && global.user
            ? [{ userId: global.user.id, local: true, hasAudio: false, muted: false }] : [];
        for (const userId in this.remoteScreens) {
            const vs = global.state.voiceStates?.[userId];
            if (!vs?.screen) continue;
            // The sender says whether this share carries sound: a receiver keeps the
            // audio track of an earlier share with sound, silent once it's replaced.
            const hasAudio = !!vs.screen_audio && this.remoteScreens[userId].getAudioTracks().length > 0;
            list.push({ userId: Number(userId), local: false, hasAudio, muted: !!this.localMutes[`screen-${userId}`] });
        }
        if (JSON.stringify(list) !== JSON.stringify(this.screenShares)) {
            this.screenShares = list;
            setElement('global.state.callManager.screenShares', list);
            this._updateHasAnyVideo();
            requestAnimationFrame(() => this._reattachStreams());
            this._checkFocus();
        }
    }

    updateCallControls() {
        setElement('global.state.callManager.isMuted', this.isMuted);
        setElement('global.state.callManager.isVideoOff', this.isVideoOff);
        setElement('global.state.callManager.isDeafened', this.isDeafened);
    }

    // ==================== SHARED VOICE STATE ====================

    _voiceState() {
        return {
            muted: this.isMuted,
            deafened: this.isDeafened,
            video: !!(this.localStream?.getVideoTracks().some(t => t.enabled) && !this.isVideoOff),
            screen: this.isScreenSharing,
            screen_audio: this.isScreenSharing && !!this._screenAudioTrack
        };
    }

    /** Announce our mic/headset/camera/screen state to the call (and the channel's audience). */
    _broadcastVoiceState() {
        if (!this.currentCall || (this.callState !== 'active' && this.callState !== 'calling')) return;
        this.setVoiceState(global.user.id, this._voiceState());
        this._sendWebSocketMessage({ type: "voiceState", call_id: this.currentCall.id, ...this._voiceState() });
    }

    /** Record someone's voice state (null forgets it) and refresh what depends on it. */
    setVoiceState(userId, state) {
        if (!global.state.voiceStates) global.state.voiceStates = {};
        // Per-user path: only global.state.voiceStates[userId] subscriptions repaint
        setElement(`global.state.voiceStates[${Number(userId)}]`, state || null);
        // Pictures only depend on the states of our own call
        if (Number(userId) === global.user?.id || this.remoteStreams[userId]) {
            this._updateHasAnyVideo();
            this._reattachStreams();
            this._refreshScreenShares();
        }
    }

    /** Merge a {userId: state} map (call / channel payloads) into the known states. */
    mergeVoiceStates(map) {
        if (!map) return;
        const states = { ...(global.state.voiceStates || {}), ...map };
        // Our own state is authoritative locally
        if (this.currentCall && global.user) states[global.user.id] = this._voiceState();
        setElement('global.state.voiceStates', states);
    }

    cleanup() {
        console.log('🧹 Cleaning up call manager');
        this._mediaRequest++;   // a mic still being granted is released when it lands

        // Cancel pending timers
        if (this._callingTimeout) {
            clearTimeout(this._callingTimeout);
            this._callingTimeout = null;
        }

        // Stop audio level monitoring and the duration clock
        this._stopAudioMonitor();
        this._stopCallClock();

        // Stop ringtones
        this.stopOutgoingRingtone();

        // Stop all local media tracks (the mic's capture and processing graph too)
        this._mic?.stop();
        this._mic = null;
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                track.stop();
                console.log(`⏹️ Stopped ${track.kind} track`);
            });
            this.localStream = null;
        }
        this._screenTrack?.stop();
        this._screenAudioTrack?.stop();
        this._screenTrack = null;
        this._screenAudioTrack = null;
        this.isScreenSharing = false;
        this._screenStream = null;
        this._screenPreview = null;
        this._screenSenders = {};
        this.remoteScreens = {};
        this.screenShares = [];
        this.focus = null;

        // Release the remote audio outputs
        for (const userId in this._audioSinks) this._detachAudio(userId);
        this.localMutes = {};

        // Close all peer connections
        for (const userId in this.peerConnections) {
            this.peerConnections[userId].close();
            console.log(`🔌 Closed connection to ${userId}`);
        }
        this.peerConnections = {};

        // Clear ICE candidate queues
        this.iceCandidateQueues = {};

        // Remove all remote streams
        this.remoteStreams = {};
        this.remoteParticipants = [];
        this.availableActions = [];

        // Reset state (mic/headset state is kept for the next call, like Discord)
        const wasInCall = !!this.currentCall && this.callState !== 'banner';
        this.currentCall = null;
        this.mode = 'p2p';
        this.callType = 'audio';
        this.callState = 'none';
        this.isVideoOff = false;

        // Update reactive state
        this.hasAnyVideo = false;
        setElement('global.state.callManager.currentCall', null);
        setElement('global.state.callManager.mode', 'p2p');
        setElement('global.state.callManager.callType', 'audio');
        setElement('global.state.callManager.callState', 'none');
        setElement('global.state.callManager.isVideoOff', false);
        setElement('global.state.callManager.isScreenSharing', false);
        setElement('global.state.callManager.screenShares', []);
        setElement('global.state.callManager.remoteParticipants', []);
        setElement('global.state.callManager.availableActions', []);
        this._updateCallViewState();
        if (wasInCall && global.user) {
            this.setVoiceState(global.user.id, null);
            playVoiceCue('leave');
        }

        // Clear local video element
        const localVideo = document.getElementById('local-video');
        if (localVideo) {
            localVideo.srcObject = null;
        }

        // Dismiss native incoming-call notification if still showing
        if (isNative) nativeCallEnded().catch(() => {});

        console.log('✅ Cleanup complete');
    }

    // ==================== HELPER METHODS ====================

    /**
     * Send WebSocket message to server
     */
    _sendWebSocketMessage(data) {
        if (!global.state.websocket) {
            console.error('❌ WebSocket not available');
            return;
        }

        const message = {
            ...data,
            clientID: global.state.clientID
        };

        global.state.websocket.send(JSON.stringify(message));
    }

    /**
     * Make HTTP request to server
     */
    async _httpRequest(method, url) {
        return new Promise((resolve, reject) => {
            const onload = function() {
                // xhr calls onload on 4xx/5xx too: surface the server's message
                if (this.status >= 400) {
                    reject(new Error(this.responseText || `HTTP ${this.status}`));
                    return;
                }
                try {
                    resolve(JSON.parse(this.responseText));
                } catch (e) {
                    reject(e);
                }
            };
            xhr(url, onload, method);
        });
    }
}


function showPermissionError(message) {
    console.error('Permission error:', message);

    const notification = document.createElement('div');
    notification.className = 'permission-error-notification';
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #ED4245;
        color: white;
        padding: 1rem 1.5rem;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        z-index: 9999;
        max-width: 350px;
        animation: slideIn 0.3s ease;
    `;

    document.body.appendChild(notification);

    // Auto-supprimer après 5 secondes
    setTimeout(() => {
        notification.style.animation = 'fadeOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 5000);
}
window.showPermissionError = showPermissionError;

/**
 * Check if user is currently in a call
 */
window.isInCall = function(callId) {
    const callManager = global.state.callManager;
    return callManager && callManager.currentCall && callManager.currentCall.id === callId;
};

/**
 * Load the call state for a conversation
 */
window.loadCallState = async function(conversationId) {
    try {
        const response = await fetch(`/get_call_state?conversation_id=${conversationId}`);
        const callState = await response.json();

        console.log('📞 loadCallState result:', callState);

        // Check if there's an active call (API returns call object with id, or null/empty)
        if (callState && callState.id) {
            setElement(`global.convs[${conversationId}].ongoingCall`, callState);

            // Set callState to 'banner' if we're in no call at all. While connected
            // elsewhere (a vocal channel, another DM), the call buttons of the
            // header join this one instead (leaving the other first).
            const callManager = global.state.callManager;
            if (callManager && !callManager.currentCall) {
                console.log('📢 Setting banner state with participants:', callState.participants);

                callManager.callState = 'banner';
                setElement('global.state.callManager.callState', 'banner');

                // Populate remote participants for banner display (exclude self)
                callManager.remoteParticipants = callState.participants
                    .filter(userId => userId !== global.user.id)
                    .map(userId => ({ userId, status: 'connected' }));
                callManager._setRemoteParticipants(callManager.remoteParticipants);

                // Update available actions
                callManager.updateAvailableActions();
                callManager._updateCallViewState();

                console.log('✅ Banner state set:', {
                    callState: callManager.callState,
                    participants: callManager.remoteParticipants,
                    actions: callManager.availableActions
                });
            }
        } else {
            console.log('📭 No active call in this conversation');
            setElement(`global.convs[${conversationId}].ongoingCall`, null);

            // Reset callManager to 'none' state if not in a call
            const callManager = global.state.callManager;
            if (callManager && !callManager.currentCall) {
                callManager.callState = 'none';
                callManager.remoteParticipants = [];
                callManager.availableActions = [];
                setElement('global.state.callManager.callState', 'none');
                setElement('global.state.callManager.remoteParticipants', []);
                setElement('global.state.callManager.availableActions', []);
                callManager._updateCallViewState();
            }
        }
    } catch (error) {
        console.error('Failed to load call state:', error);
    }
};

/**
 * Handle call button click - either join existing call or start new one
 */
window.handleCallButtonClick = async function(conversationId, isVideo) {
    const conv = global.convs[conversationId];

    // Check if there's an ongoing call in this conversation
    if (conv?.ongoingCall && conv.ongoingCall.active) {
        // Join the existing call
        await joinExistingCall(conv.ongoingCall.id, isVideo);
    } else {
        // Start a new call
        if (isVideo) {
            await startVideoCall(conversationId);
        } else {
            await startVoiceCall(conversationId);
        }
    }
};

/**
 * Join an existing call from the banner
 */
window.joinExistingCall = async function(callId, hasVideo = false) {
    console.log('Joining existing call', callId, hasVideo);

    const callManager = global.state.callManager;
    if (!callManager) {
        showPermissionError('Reload page.');
        return;
    }

    try {
        await callManager.joinCall(callId, hasVideo);
        // Display is handled automatically by callState = 'active'
    } catch (error) {
        showPermissionError(error.message);
    }
};

window.startVoiceCall = async function(conversationId) {
    const callManager = global.state.callManager;

    try {
        await callManager.startCall(conversationId, false);
        // Display is handled automatically by callState = 'calling'
    } catch (error) {
        showPermissionError(error.message);
    }
};

window.startVideoCall = async function(conversationId) {
    const callManager = global.state.callManager;
    if (!callManager) {
        showPermissionError('Reload page.');
        return;
    }

    try {
        await callManager.startCall(conversationId, true);
        // Display is handled automatically by callState = 'calling'
    } catch (error) {
        showPermissionError(error.message);
    }
};

window.joinCall = async function(callId, hasVideo = false) {
    console.log('Joining call', callId, hasVideo);

    const callManager = global.state.callManager;
    if (!callManager) {
        showPermissionError('ReloadPage.');
        return;
    }

    try {
        await callManager.joinCall(callId, hasVideo);
    } catch (error) {
        showPermissionError(error.message);
    }
};

window.leaveCall = async function() {
    const callManager = global.state.callManager;
    if (callManager) {
        await callManager.leaveCall();
    }
};

window.declineCallSection = function(callId) {
    const callManager = global.state.callManager;
    if (callManager && callManager.callState === 'banner') {
        callManager.cleanup();
    }
};

/**
 * Join a vocal channel (no ring — immediate presence).
 * Called from goToVocalChannel in navigation.mjs.
 */
window.joinVocalChannel = async function(channelId) {
    const callManager = global.state.callManager;
    if (!callManager) return;

    // Already in this vocal channel — just navigate to the view, don't re-join
    if (callManager.currentCall?.vocal_channel_id === channelId && callManager.callState === 'active') {
        return;
    }
    if (callManager.joiningChannel === channelId) return; // double click

    // Another channel clicked (or a hang-up) while this join is still waiting for
    // the mic or the server makes it stale: only the latest attempt goes through
    const attempt = ++callManager._joinAttempt;
    const stale = () => attempt !== callManager._joinAttempt;

    // If already in another call, leave it first
    if (callManager.currentCall) {
        await callManager.leaveCall();
    }
    if (stale()) return;

    // The view shows a spinner while the mic prompt / HTTP join are pending
    callManager.joiningChannel = channelId;
    callManager._updateCallViewState();
    try {
        await callManager.getLocalStream(false);
        if (stale()) return;   // its stream went to the newer attempt, or was stopped by the hang-up

        const response = await callManager._httpRequest('POST', `/join_vocal_channel?channel_id=${channelId}`);
        const { call } = response;
        if (stale()) {
            // The server put us in, but we've moved on meanwhile: leave it again
            callManager._sendWebSocketMessage({ type: "vocalLeave", call_id: call.id, channel_id: channelId });
            return;
        }

        callManager.currentCall = call;
        callManager.mode = call.mode;
        callManager.callState = 'active';
        setElement('global.state.callManager.currentCall', call);
        setElement('global.state.callManager.mode', call.mode);
        setElement('global.state.callManager.callState', 'active');

        callManager.remoteParticipants = call.participants
            .filter(uid => uid !== global.user.id)
            .map(uid => ({ userId: uid, status: 'connected' }));
        callManager._setRemoteParticipants(callManager.remoteParticipants);

        callManager.updateAvailableActions();
        callManager._startAudioMonitor();
        callManager._updateCallViewState();
        callManager.mergeVoiceStates(call.voice_states);
        callManager._startCallClock();
        playVoiceCue('join');

        // Notify other server members we joined (presence broadcast)
        callManager._sendWebSocketMessage({
            type: "vocalJoin",
            channel_id: channelId,
            call_id: call.id
        });
        callManager._broadcastVoiceState();

        // Tell existing call participants to expect an offer from us (WebRTC signaling)
        if (call.participants.length > 1) {
            callManager._sendWebSocketMessage({
                type: "callJoin",
                call_id: call.id
            });

            // Mirror joinCall: above the SFU threshold the call uses an SFU, so the
            // joiner connects to the SFU instead of building a full P2P mesh.
            if (callManager.mode === 'sfu') {
                await callManager.createSFUConnection();
            } else {
                for (const participantId of call.participants) {
                    if (participantId !== global.user.id) {
                        await callManager.createPeerConnection(participantId, true);
                    }
                }
            }
        }

        console.log(`✅ Joined vocal channel ${channelId} (call ${call.id})`);
    } catch (error) {
        if (stale() || error.superseded) return;
        console.error('❌ Failed to join vocal channel:', error);
        showPermissionError(error.message);
        callManager.cleanup();
    } finally {
        if (!stale()) {
            callManager.joiningChannel = null;
            callManager._updateCallViewState();
        }
    }
};

window.leaveVocalChannel = async function() {
    const callManager = global.state.callManager;
    if (!callManager) return;
    if (callManager.joiningChannel !== null && callManager.joiningChannel !== undefined) {
        // Still connecting: call the join off (a mic still being granted is
        // released by cleanup, a server join that lands is left again)
        callManager._joinAttempt++;
        callManager.joiningChannel = null;
        if (!callManager.currentCall) {
            callManager.cleanup();
            return;
        }
    }
    if (callManager.currentCall?.vocal_channel_id) {
        await callManager.leaveCall();
    }
};

/** Fullscreen on the call surface (vocal channel view or DM call section); toggles. */
window.enterCallFullscreen = function(target) {
    if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
        return;
    }
    const el = (typeof target === 'string' ? document.querySelector(target) : target)
        || document.querySelector('.vocal-channel-view') || document.querySelector('.call-component');
    el?.requestFullscreen?.().catch(e => console.warn('Fullscreen refused:', e));
};

window.toggleScreenShare = function() {
    global.state.callManager?.toggleScreenShare();
};

// ==================== TEMPLATE HELPERS (vocal views) ====================

/** Profile of a call participant; global.users may not hold ourselves. */
window.voiceUser = function(userId) {
    return global.users?.[userId] || (Number(userId) === global.user?.id ? global.user : null) || {};
};

window.voiceInitial = function(userId) {
    return (voiceUser(userId).display || '?').trim().charAt(0).toUpperCase() || '?';
};

/** Round avatar: the picture, or the initial on a per-user colour. */
window.voiceAvatar = function(userId, className) {
    const pfp = voiceUser(userId).pfp;
    const hue = (Number(userId) * 137.508) % 360;
    return pfp
        ? `<div class="${className}" style="background-image:url(/static/attachments/${escapeHTML(pfp)})"></div>`
        : `<div class="${className} initial" style="background-color:hsl(${hue},45%,40%)">${escapeHTML(voiceInitial(userId))}</div>`;
};

/** Mic / headset / live markers of someone's announced voice state. */
window.voiceStateIcons = function(userId, onTile = false) {
    const vs = global.state.voiceStates?.[userId];
    if (!vs) return '';
    const icon = (name, label) => `<img class="icon ${onTile ? 'red' : ''}" src="/static/icons/material/${name}.svg" alt="${label}" title="${label}"/>`;
    return (vs.screen && !onTile ? `<span class="vocal-live-badge">${_t('EN DIRECT')}</span>` : '')
        + (!onTile && vs.video ? icon('videocam', _t('Caméra')) : '')
        + (vs.deafened ? icon('headset_off', _t('En sourdine')) : vs.muted ? icon('mic_off', _t('Micro coupé')) : '');
};

/** {chan, server} of a vocal channel, whatever server it belongs to. */
window.voiceChannelInfo = function(channelId) {
    for (const server of Object.values(global.servers || {})) {
        const chan = server?.dirs?.vocals?.find(v => v.id === channelId);
        if (chan) return { chan, server };
    }
    return { chan: null, server: null };
};

/**
 * Right-click on a participant (their voice) or on their screen share (its sound,
 * screen = true): a volume and a mute for me only. Rendered by voice-user-menu.html.
 */
window.openVoiceUserMenu = function(event, userId, screen = false) {
    event.preventDefault();
    event.stopPropagation();
    const cm = global.state.callManager;
    userId = Number(userId);
    if (!cm || userId === global.user?.id) return;
    const key = screen ? `screen-${userId}` : String(userId);
    setElement('global.state.voiceMenu', {
        userId,
        key,
        screen: !!screen,
        volume: Math.round(cm.getUserVolume(key) * 100),
        localMute: !!cm.localMutes[key],
    });
    toggleModale('voice-user-modale', event);
};

window.toggleVoiceLocalMute = function(key) {
    global.state.callManager?.toggleLocalMute(key);
    closeFM();
};

/** Click on a tile of the vocal view: focus it / back to the grid (CallManager.toggleFocus). */
window.toggleVocalFocus = function(key) {
    global.state.callManager?.toggleFocus(key);
};

/** 'focused' on the focused tile of the vocal view (vocal-tile / vocal-screen-tile templates). */
window.vocalFocusClass = function(key) {
    return global.state.callManager?.focusedKey() === String(key) ? 'focused' : '';
};

// ==================== MODULE HELPERS ====================

/** A media request or join that a newer one (or a hang-up) made pointless: not an error to show. */
function supersededError() {
    return Object.assign(new Error('superseded'), { name: 'AbortError', superseded: true });
}

/**
 * Encoding of a screen share sender: up to 30 fps and enough bitrate for 1080p,
 * and when bandwidth runs short, lower the resolution before the framerate.
 */
function tuneScreenSender(sender) {
    if (!sender?.getParameters) return Promise.resolve();
    const params = sender.getParameters();
    if (!params.encodings?.length) return Promise.resolve();   // not negotiated yet: nothing to tune
    params.encodings[0].maxBitrate = 4_000_000;
    params.encodings[0].maxFramerate = 30;
    params.degradationPreference = 'maintain-framerate';
    return sender.setParameters(params).catch(e => console.warn('Screen sender tuning refused:', e));
}

function loadPref(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
        return fallback;
    }
}

function savePref(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
}

/** "1:32", "12:05", "1:02:44" */
export function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
window.formatDuration = formatDuration;

// Short synthesized cues (no audio assets needed): join/leave and mic/headset toggles.
const VOICE_CUES = {
    join:     [[523, 0], [784, 0.09]],
    leave:    [[784, 0], [523, 0.09]],
    mute:     [[440, 0], [330, 0.06]],
    unmute:   [[330, 0], [440, 0.06]],
    deafen:   [[392, 0], [262, 0.07]],
    undeafen: [[262, 0], [392, 0.07]],
};
let cueContext = null;
function playVoiceCue(name) {
    const notes = VOICE_CUES[name];
    if (!notes) return;
    try {
        cueContext = cueContext || new AudioContext();
        const t0 = cueContext.currentTime;
        for (const [freq, offset] of notes) {
            const osc = cueContext.createOscillator();
            const gain = cueContext.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, t0 + offset);
            gain.gain.exponentialRampToValueAtTime(0.08, t0 + offset + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.14);
            osc.connect(gain).connect(cueContext.destination);
            osc.start(t0 + offset);
            osc.stop(t0 + offset + 0.16);
        }
    } catch (e) { /* audio blocked: cues are cosmetic */ }
}

export default CallManager;






























