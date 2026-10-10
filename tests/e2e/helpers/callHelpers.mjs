/**
 * Helpers for CallManager E2E tests.
 * Avoids code duplication and improves maintainability.
 */

/**
 * Starts a call in a conversation.
 * @param {Page} page - The Playwright page
 * @param {number} convId - Conversation ID
 * @param {string} callType - Call type ('audio' or 'video')
 * @returns {Promise<Object>} The created call data
 */
export async function startCall(page, convId, callType = 'audio') {
    const callData = await page.evaluate(async ({ convId, callType }) => {
        const response = await fetch(`/start_call?conversation_id=${convId}&call_type=${callType}`, {
            method: 'POST',
            credentials: 'include'
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to start call: ${response.status} - ${errorText}`);
        }
        return response.json();
    }, { convId, callType });

    console.log(`   ✅ Call started: ID=${callData.id}, mode=${callData.mode}, type=${callType}`);
    return callData;
}

/**
 * Joins an existing call.
 * @param {Page} page - The Playwright page
 * @param {number} callId - Call ID
 * @returns {Promise<Object>} Call data after joining
 */
export async function joinCall(page, callId) {
    const joinData = await page.evaluate(async (callId) => {
        const response = await fetch(`/join_call?call_id=${callId}`, {
            method: 'POST',
            credentials: 'include'
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to join call: ${response.status} - ${errorText}`);
        }
        return response.json();
    }, callId);

    console.log(`   ✅ Joined call: ${joinData.call.participant_count} participants, mode=${joinData.call.mode}`);
    return joinData;
}

/**
 * Leaves a call.
 * @param {Page} page - The Playwright page
 * @param {number} callId - Call ID
 * @returns {Promise<Object>} Data after leaving
 */
export async function leaveCall(page, callId) {
    const leaveData = await page.evaluate(async (callId) => {
        const response = await fetch(`/leave_call?call_id=${callId}`, {
            method: 'POST',
            credentials: 'include'
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to leave call: ${response.status} - ${errorText}`);
        }
        return response.json();
    }, callId);

    console.log(`   ✅ Left call: ended=${leaveData.ended}, mode_changed=${leaveData.mode_changed}`);
    return leaveData;
}

/**
 * Gets the current state of a call.
 * @param {Page} page - The Playwright page
 * @param {number} convId - Conversation ID
 * @returns {Promise<Object|null>} The call state, or null if inactive
 */
export async function getCallState(page, convId) {
    const callState = await page.evaluate(async (convId) => {
        const response = await fetch(`/get_call_state?conversation_id=${convId}`, {
            credentials: 'include'
        });
        if (!response.ok) {
            throw new Error(`Failed to get call state: ${response.status}`);
        }
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`Failed to parse JSON: ${text.substring(0, 200)}`);
        }
    }, convId);

    console.log(`   🔍 Call state: ${callState?.active === false ? 'inactive' : `active, ${callState.participant_count} participants`}`);
    return callState;
}

/**
 * Creates a conversation.
 * @param {Page} page - The Playwright page
 * @param {string} name - Conversation name
 * @param {Array<number>} memberIds - IDs of members to invite
 * @returns {Promise<number>} The created conversation ID
 */
export async function createConversation(page, name, memberIds = []) {
    const convId = await page.evaluate(async ({ name, memberIds }) => {
        const response = await fetch(
            `/create_conv?name=${encodeURIComponent(name)}&members=${JSON.stringify(memberIds)}&private=true`,
            {
                method: 'POST',
                credentials: 'include'
            }
        );
        if (!response.ok) {
            throw new Error(`Failed to create conversation: ${response.status}`);
        }
        const data = await response.json();
        return data.id;
    }, { name, memberIds });

    console.log(`   ✅ Conversation created: ID=${convId}, members=${memberIds.length + 1}`);
    return convId;
}

/**
 * Gets the current user's information.
 * @param {Page} page - The Playwright page
 * @returns {Promise<Object>} User info
 */
export async function getUserInfo(page) {
    const userInfo = await page.evaluate(async () => {
        const response = await fetch('/get_user_info', {
            method: 'POST',
            credentials: 'include'
        });
        if (!response.ok) {
            throw new Error(`Failed to get user info: ${response.status}`);
        }
        return response.json();
    });

    return userInfo;
}

/**
 * Waits until the application is fully initialized.
 * @param {Page} page - The Playwright page
 * @param {number} timeout - Timeout in ms (default: 10000)
 */
export async function waitForAppReady(page, timeout = 10000) {
    await page.waitForFunction(() => {
        return window.global?.state?.websocket?.readyState === WebSocket.OPEN
            && window.global?.state?.callManager !== undefined
            && window.global?.state?.clientID !== undefined;
    }, undefined, { timeout });

    console.log('   ✅ App ready: WebSocket connected and CallManager initialized');
}

/**
 * Waits until multiple users are ready.
 * @param {Array<Page>} pages - Playwright pages
 * @param {number} timeout - Timeout in ms (default: 10000)
 */
export async function waitForMultipleUsersReady(pages, timeout = 10000) {
    await Promise.all(pages.map(page => waitForAppReady(page, timeout)));
    console.log(`   ✅ ${pages.length} users ready`);
}

// ─── UI / reactive helpers ───────────────────────────────────────────────────

/**
 * Doit être appelé via page.addInitScript AVANT page.goto.
 * Remplace navigator.mediaDevices.getUserMedia par un faux stream audio-only
 * pour que startCall/joinCall ne bloquent pas sur une vraie caméra/micro.
 * @param {Page} page
 */
export async function mockGetUserMedia(page) {
    await page.addInitScript(() => {
        const makeFakeTrack = (kind) => ({
            kind,
            enabled: true,
            muted: false,
            readyState: 'live',
            stop: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
        });

        const fakeAudioTrack = makeFakeTrack('audio');
        const fakeVideoTrack = makeFakeTrack('video');

        const makeFakeStream = (withVideo = false) => ({
            active: true,
            getTracks: () => withVideo ? [fakeAudioTrack, fakeVideoTrack] : [fakeAudioTrack],
            getAudioTracks: () => [fakeAudioTrack],
            getVideoTracks: () => withVideo ? [fakeVideoTrack] : [],
        });

        Object.defineProperty(navigator, 'mediaDevices', {
            writable: true,
            value: {
                getUserMedia: async ({ video }) => makeFakeStream(!!video),
            },
        });
    });
}

/**
 * Attend que le composant call-component soit rendu dans le DOM.
 * @param {Page} page
 * @param {number} timeout
 */
export async function waitForCallComponent(page, timeout = 8000) {
    await page.locator('.call-component').waitFor({ state: 'visible', timeout });
    console.log('   ✅ call-component visible');
}

/**
 * Attend que le composant call-component soit absent du DOM.
 * @param {Page} page
 * @param {number} timeout
 */
export async function waitForNoCallComponent(page, timeout = 8000) {
    await page.locator('.call-component').waitFor({ state: 'hidden', timeout });
    console.log('   ✅ call-component masqué');
}

/**
 * Lit l'état courant de callViewState depuis le store réactif.
 * @param {Page} page
 * @returns {Promise<{callState: string, hasAnyVideo: boolean}>}
 */
export async function readCallViewState(page) {
    return page.evaluate(() => ({
        callState: window.global?.state?.callManager?.callState ?? 'none',
        hasAnyVideo: window.global?.state?.callManager?.hasAnyVideo ?? false,
        participants: window.global?.state?.callManager?.remoteParticipants ?? [],
    }));
}

/**
 * Injecte un état "banner" dans le callManager côté client
 * (simule la réception d'un appel WS call_started sans passer par un vrai second user).
 * @param {Page} page
 * @param {number} convId
 * @param {Object} opts
 * @param {string} [opts.callType='audio']
 * @param {number[]} [opts.participantIds=[]] IDs des participants déjà dans l'appel
 */
export async function injectBannerState(page, convId, { callType = 'audio', participantIds = [], callId = 99999 } = {}) {
    await page.evaluate(({ convId, callType, participantIds, callId }) => {
        const cm = window.global.state.callManager;
        const fakeCallData = {
            id: callId,
            conversation_id: convId,
            call_type: callType,
            participants: participantIds,
            active: true,
        };
        // Met également à jour ongoingCall pour que updateAvailableActions trouve callId
        window.global.convs[convId] = window.global.convs[convId] || {};
        window.global.convs[convId].ongoingCall = fakeCallData;
        cm.setBannerState(fakeCallData);
    }, { convId, callType, participantIds, callId });

    console.log(`   ✅ Banner state injecté (conv=${convId}, type=${callType})`);
}

/**
 * Injecte un état "calling" dans le callManager côté client
 * (simule le fait que le user local a démarré l'appel).
 * @param {Page} page
 * @param {number[]} participantIds IDs des membres en train de sonner
 */
export async function injectCallingState(page, participantIds = [], callType = 'audio') {
    await page.evaluate(({ participantIds, callType }) => {
        const cm = window.global.state.callManager;
        cm.callState = 'calling';
        cm.callType = callType;
        cm.currentCall = { id: 0 }; // needed so leaveCall() doesn't bail early
        cm.remoteParticipants = participantIds.map(id => ({ userId: id, status: 'calling' }));

        // Déclencher les mises à jour réactives
        const { setElement } = window.__vestaInternals__ || {};
        if (setElement) {
            setElement('global.state.callManager.remoteParticipants', cm.remoteParticipants);
            setElement('global.state.callManager.availableActions', [{ type: 'controls' }]);
        }
        cm.availableActions = [{ type: 'controls' }];
        cm._updateCallViewState();
    }, { participantIds, callType });

    console.log(`   ✅ Calling state injecté (${participantIds.length} participants en sonnerie)`);
}

/**
 * Ouvre une conversation dans l'interface (clic sur #conv{id} dans la sidebar).
 * @param {Page} page
 * @param {number} convId
 */
export async function openConversation(page, convId) {
    await page.locator(`#conv${convId}`).click();
    await page.waitForFunction((id) => window.global?.state?.activeConv === id, convId, { timeout: 8000 });
    await page.locator('.chat-input textarea.selected').waitFor({ state: 'visible', timeout: 8000 });
    console.log(`   ✅ Conversation ${convId} ouverte`);
}
