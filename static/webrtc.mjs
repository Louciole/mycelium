import global from "./framework/global.mjs";
import { xhr } from "./framework/templating.mjs";
import { setElement, pushElement, deleteVal } from "./framework/vesta.mjs";
import { callEnded as nativeCallEnded, isNative } from "./capacitor-bridge.mjs";

// STUN servers for ICE candidates - TURN servers should be added for production
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
];

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

        // Audio/Video controls
        this.isMuted = false;
        this.isVideoOff = false;
        this.isDeafened = false;

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
        setElement('global.state.callManager.remoteParticipants', this.remoteParticipants);
        setElement('global.state.callManager.availableActions', this.availableActions);
        setElement('global.state.callManager.callViewState', this.callViewState);
    }

    _updateCallViewState() {
        this.callViewState = { callState: this.callState, hasAnyVideo: this.hasAnyVideo };
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
            if (videoElement && videoElement.srcObject !== stream) {
                videoElement.srcObject = stream;
                videoElement.muted = this.isDeafened;
            }
            const participantElement = document.getElementById(`participant-${userId}`);
            if (participantElement) {
                const hasVideo = stream.getVideoTracks().some(t => t.enabled);
                participantElement.classList.toggle('has-stream', hasVideo);
            }
        }
    }

    _updateHasAnyVideo() {
        const anyRemoteVideo = Object.values(this.remoteStreams).some(stream =>
            stream.getVideoTracks().some(t => t.enabled)
        );
        const localHasVideo = !!(this.localStream &&
            this.localStream.getVideoTracks().some(t => t.enabled) &&
            !this.isVideoOff);
        const newHasAnyVideo = anyRemoteVideo || localHasVideo;
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
            return; // Browser may block without user gesture; not critical
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

    /** Poll all analysers and toggle .speaking on participant tiles. */
    _updateSpeakingIndicators() {
        for (const [key, { analyser, dataArray }] of Object.entries(this._audioAnalysers)) {
            analyser.getByteFrequencyData(dataArray);
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            const elemId = key === 'local' ? 'participant-local' : `participant-${key}`;
            document.getElementById(elemId)?.classList.toggle('speaking', avg > 8);
        }
    }

    /** Stop audio monitoring and release resources. */
    _stopAudioMonitor() {
        if (this._audioMonitorInterval) {
            clearInterval(this._audioMonitorInterval);
            this._audioMonitorInterval = null;
        }
        this._audioAnalysers = {};
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
            setElement('global.state.callManager.remoteParticipants', this.remoteParticipants);
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
        try {
            const constraints = { audio: true, video: video };

            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.callType = video ? 'video' : 'audio';
            setElement('global.state.callManager.callType', this.callType);

            // Apply pre-set mute state immediately
            if (this.isMuted) {
                const audioTrack = this.localStream.getAudioTracks()[0];
                if (audioTrack) audioTrack.enabled = false;
            }

            this.displayLocalStream();
            console.log(`✅ Local ${this.callType} stream acquired`);

            return this.localStream;
        } catch (error) {
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
        if (this.callState !== 'none') return;
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
                setElement('global.state.callManager.remoteParticipants', this.remoteParticipants);
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

            console.log(`✅ Call started (ID: ${response.id}, mode: ${this.mode})`);
            return response;

        } catch (error) {
            console.error('❌ Failed to start call:', error);
            this.cleanup();
            throw error;
        }
    }

    /**
     * Join an existing call
     */
    async joinCall(callId, video = false) {
        if (this.callState !== 'none' && this.callState !== 'banner') return;
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
            setElement('global.state.callManager.remoteParticipants', this.remoteParticipants);

            // Update available actions
            this.updateAvailableActions();

            // Start audio level monitoring for the speaking indicator
            this._startAudioMonitor();

            // Notify server via WebSocket
            this._sendWebSocketMessage({
                type: "callJoin",
                call_id: callId
            });

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

        // Add local tracks to connection
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                pc.addTrack(track, this.localStream);
            });
        }

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
            this.remoteStreams[userId] = stream;
            this.displayRemoteStream(userId, stream);

            // Update participant status to 'active' when we receive their stream
            const participant = this.remoteParticipants.find(p => p.userId === userId);
            if (participant && participant.status !== 'active') {
                participant.status = 'active';
                setElement('global.state.callManager.remoteParticipants', this.remoteParticipants);
            }
        };

        // Connection state monitoring
        pc.onconnectionstatechange = () => {
            console.log(`🔄 Connection state with ${userId}: ${pc.connectionState}`);
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                this.handlePeerDisconnection(userId);
            } else if (pc.connectionState === 'connected') {
                console.log(`✅ Connected to user ${userId}`);
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

        // Add local tracks
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                pc.addTrack(track, this.localStream);
            });
        }

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
            if (pc && pc.signalingState === 'stable') {
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

        // Update call data
        this.currentCall = callData;
        setElement('global.state.callManager.currentCall', callData);

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
            setElement('global.state.callManager.remoteParticipants', this.remoteParticipants);
        } else if (newUserId !== global.user.id) {
            // Add participant if not already present
            const exists = this.remoteParticipants.find(p => p.userId === newUserId);
            if (!exists) {
                this.remoteParticipants.push({ userId: newUserId, status: 'connected' });
                setElement('global.state.callManager.remoteParticipants', this.remoteParticipants);
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

        // Update call data
        this.currentCall = callData;
        setElement('global.state.callManager.currentCall', callData);

        // Always remove from the reactive participant list (handles audio-only participants
        // who never had a remoteStreams entry)
        this.remoteParticipants = this.remoteParticipants.filter(p => p.userId !== leftUserId);
        setElement('global.state.callManager.remoteParticipants', this.remoteParticipants);

        // Clean up their WebRTC connection and any streams
        this.handlePeerDisconnection(leftUserId);

        // Handle mode change if needed
        if (callData.mode && this.mode !== callData.mode) {
            this.handleModeSwitch(callData.mode);
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

        delete this._audioAnalysers[String(userId)];
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
        // Wait for template to render the element, then attach stream
        requestAnimationFrame(() => {
            const videoElement = document.getElementById(`remote-video-${userId}`);
            const participantElement = document.getElementById(`participant-${userId}`);

            if (videoElement && stream) {
                videoElement.srcObject = stream;
                videoElement.muted = this.isDeafened;

                // Check if stream has active video tracks
                const hasVideo = stream.getVideoTracks().length > 0 && stream.getVideoTracks()[0].enabled;

                // Add/remove class based on whether we have video
                if (participantElement) {
                    if (hasVideo) {
                        participantElement.classList.add('has-stream');
                    } else {
                        participantElement.classList.remove('has-stream');
                    }
                }

                this._updateHasAnyVideo();
                // Hook into the audio monitor so this participant gets a speaking indicator
                this._connectStreamToAnalyser(String(userId), stream);
            }
        });
    }

    /**
     * Remove remote user's audio analyser (stream and participant list managed by caller)
     */
    removeRemoteStreamDisplay(userId) {
        delete this._audioAnalysers[String(userId)];
    }

    // ==================== AUDIO/VIDEO CONTROLS ====================

    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) audioTrack.enabled = !this.isMuted;
        }
        this.updateCallControls();
        console.log(`🎤 Mute: ${this.isMuted}`);
    }

    toggleVideo() {
        if (!this.localStream) return;
        const videoTrack = this.localStream.getVideoTracks()[0];
        if (!videoTrack) {
            this._enableCamera();
            return;
        }
        videoTrack.enabled = !videoTrack.enabled;
        this.isVideoOff = !videoTrack.enabled;
        this.updateCallControls();
        this._updateHasAnyVideo();
        console.log(`📹 Video off: ${this.isVideoOff}`);
    }

    async _enableCamera() {
        try {
            const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
            const videoTrack = videoStream.getVideoTracks()[0];
            if (!videoTrack) return;

            this.localStream.addTrack(videoTrack);
            this.callType = 'video';
            this.isVideoOff = false;
            setElement('global.state.callManager.callType', this.callType);

            // Add track to every peer connection and renegotiate
            for (const userId in this.peerConnections) {
                const pc = this.peerConnections[userId];
                pc.addTrack(videoTrack, this.localStream);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                this._sendWebSocketMessage({
                    type: "callOffer",
                    call_id: this.currentCall.id,
                    target_user: parseInt(userId),
                    signal: { sdp: offer }
                });
            }

            // _updateHasAnyVideo triggers _updateCallViewState which re-renders the
            // outer Subscribe and schedules displayLocalStream() via rAF so srcObject
            // is re-attached to the freshly created #local-video element.
            this._updateHasAnyVideo();
            this.updateCallControls();
            console.log('📹 Camera enabled');
        } catch (error) {
            console.error('❌ Failed to enable camera:', error);
        }
    }

    toggleDeafen() {
        this.isDeafened = !this.isDeafened;

        // Mute/unmute all remote video elements
        for (const userId in this.remoteStreams) {
            const videoElement = document.getElementById(`remote-video-${userId}`);
            if (videoElement) {
                videoElement.muted = this.isDeafened;
            }
        }

        // Mute/unmute remote audio elements
        const audioContainer = document.getElementById('remote-audio-container');
        if (audioContainer) {
            audioContainer.querySelectorAll('audio').forEach(audio => {
                audio.muted = this.isDeafened;
            });
        }

        this.updateCallControls();
        console.log(`🔇 Deafen: ${this.isDeafened}`);
    }

    updateCallControls() {
        setElement('global.state.callManager.isMuted', this.isMuted);
        setElement('global.state.callManager.isVideoOff', this.isVideoOff);
        setElement('global.state.callManager.isDeafened', this.isDeafened);
    }


    cleanup() {
        console.log('🧹 Cleaning up call manager');

        // Cancel pending timers
        if (this._callingTimeout) {
            clearTimeout(this._callingTimeout);
            this._callingTimeout = null;
        }

        // Stop audio level monitoring
        this._stopAudioMonitor();

        // Stop ringtones
        this.stopOutgoingRingtone();

        // Stop all local media tracks
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                track.stop();
                console.log(`⏹️ Stopped ${track.kind} track`);
            });
            this.localStream = null;
        }

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

        // Reset state
        this.currentCall = null;
        this.mode = 'p2p';
        this.callType = 'audio';
        this.callState = 'none';
        this.isMuted = false;
        this.isVideoOff = false;
        this.isDeafened = false;

        // Update reactive state
        this.hasAnyVideo = false;
        setElement('global.state.callManager.currentCall', null);
        setElement('global.state.callManager.mode', 'p2p');
        setElement('global.state.callManager.callType', 'audio');
        setElement('global.state.callManager.callState', 'none');
        setElement('global.state.callManager.isMuted', false);
        setElement('global.state.callManager.isVideoOff', false);
        setElement('global.state.callManager.isDeafened', false);
        setElement('global.state.callManager.remoteParticipants', []);
        setElement('global.state.callManager.availableActions', []);
        this._updateCallViewState();

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

            // Set callState to 'banner' if we're not in this call
            const callManager = global.state.callManager;
            if (callManager && (!callManager.currentCall || callManager.currentCall.id !== callState.id)) {
                console.log('📢 Setting banner state with participants:', callState.participants);

                callManager.callState = 'banner';
                setElement('global.state.callManager.callState', 'banner');

                // Populate remote participants for banner display (exclude self)
                callManager.remoteParticipants = callState.participants
                    .filter(userId => userId !== global.user.id)
                    .map(userId => ({ userId, status: 'connected' }));
                setElement('global.state.callManager.remoteParticipants', callManager.remoteParticipants);

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

    // If already in another call, leave it first
    if (callManager.currentCall) {
        await callManager.leaveCall();
    }

    try {
        await callManager.getLocalStream(false);

        const response = await callManager._httpRequest('POST', `/join_vocal_channel?channel_id=${channelId}`);
        const { call } = response;

        callManager.currentCall = call;
        callManager.mode = call.mode;
        callManager.callState = 'active';
        setElement('global.state.callManager.currentCall', call);
        setElement('global.state.callManager.mode', call.mode);
        setElement('global.state.callManager.callState', 'active');

        callManager.remoteParticipants = call.participants
            .filter(uid => uid !== global.user.id)
            .map(uid => ({ userId: uid, status: 'connected' }));
        setElement('global.state.callManager.remoteParticipants', callManager.remoteParticipants);

        callManager.updateAvailableActions();
        callManager._startAudioMonitor();
        callManager._updateCallViewState();

        // Notify other server members we joined (presence broadcast)
        callManager._sendWebSocketMessage({
            type: "vocalJoin",
            channel_id: channelId,
            call_id: call.id
        });

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
        console.error('❌ Failed to join vocal channel:', error);
        showPermissionError(error.message);
        callManager.cleanup();
    }
};

window.leaveVocalChannel = async function() {
    const callManager = global.state.callManager;
    if (callManager && callManager.currentCall?.vocal_channel_id) {
        await callManager.leaveCall();
    }
};

window.enterCallFullscreen = function() {
    // TODO: implement fullscreen call mode (context 2)
    console.log('Enter fullscreen call');
};

export default CallManager;






























