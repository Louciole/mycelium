import global from "../framework/global.mjs";
import {xhr} from "../framework/templating.mjs";
import {displayNotif, postWS} from "../main.mjs";
import {setElement, pushElement, deleteElement, addElement} from "../framework/vesta.mjs";
import {handleMessageGroup, bumpConvActivity} from "../crud.mjs";
import { notifyMessage, setBadge, callStarted, callEnded, isNative } from "../capacitor-bridge.mjs";

// Second half of the WS handshake: trade the connectionId of a "register_request"
// for a clientID. A socket the server could not authenticate (closed server-side,
// request handled by another process...) is useless, so close it: the framework's
// onclose reconnects and registers again instead of leaving the app loading forever.
function authenticateWebSocket(connectionId, onAuthenticated) {
    const socket = global.state.websocket
    const retry = (reason) => {
        console.error("[WS] authWS failed (" + reason + "), reconnecting")
        if (socket.readyState === WebSocket.OPEN) socket.close(4000, "authWS failed")
    }

    const request = xhr("authWS?connectionId=".concat(connectionId), function () {
        if (socket !== global.state.websocket || socket.readyState !== WebSocket.OPEN) return
        if (this.status !== 200) return retry(this.status)
        global.state.clientID = JSON.parse(this.responseText)
        onAuthenticated()
    })
    request.onerror = () => retry("network error")
}

function isChannelMuted(channelId) {
    const now = Date.now()
    return (global.user?.channel_mutes || []).some(
        m => m.channel === channelId && (!m.muted_until || new Date(m.muted_until).getTime() > now)
    )
}

export async function onMessage(event) {
    console.log("Received message from Python server:", event.data);
    const message = JSON.parse(event.data)
    switch (message.type){
        case "register_request":
            //TODO handle multiserver xhr with the received servID
            authenticateWebSocket(message.connectionId, postWS)
            break
        case "notif":
            switch (message.content.type){
                case "message":
                    const currentDate = new Date()
                    const timestamp = currentDate.getTime()
                    message.content.content["timestamp"] = timestamp
                    bumpConvActivity(message.content.content.place, timestamp)
                    const content = message.content.content
                    const isChannel = content.server !== undefined && content.server !== null
                    if(message.content.content.place === global.state.activeConv){
                        handleMessageGroup(message.content.content)
                        addElement('global.convs['.concat(message.content.content.place,'].messages'), message.content.content)
                        // Keep the user pinned to the bottom, or surface a pill if
                        // they've scrolled up, instead of yanking the viewport.
                        window.onConvMessageArrived?.()
                        // Reading live: keep the server-side read state in sync so the
                        // channel doesn't re-appear unread on the next reload.
                        if (isChannel && document.visibilityState === 'visible') {
                            window.markChannelRead?.(content.place, content.server)
                        }
                    }else{
                        if (isChannel) {
                            // Server channel: mark unread (the ping sound fires only on a
                            // targeted "mention" event). Respect a channel or server mute.
                            const serverMuted = global.user?.notif_prefs?.[String(content.server)]?.level === 2
                            if (!isChannelMuted(content.place) && !serverMuted) {
                                document.getElementById('channel-conv-' + content.place)?.classList.add('unread')
                                if (!global.user.channel_unreads) global.user.channel_unreads = []
                                if (!global.user.channel_unreads.some(u => u.channel === content.place)) {
                                    global.user.channel_unreads.push({ channel: content.place })
                                    // Light up the server's small unread dot.
                                    const sid = String(content.server)
                                    if (!global.user.server_unread) global.user.server_unread = {}
                                    global.user.server_unread[sid] = (global.user.server_unread[sid] || 0) + 1
                                    setElement('global.user.server_unread', global.user.server_unread)
                                }
                            }
                        } else {
                            // DM/group conv: every message is a notification
                            displayNotif(message.content)
                        }
                        // Native notification when app is in background
                        // (skip channels the user has muted locally)
                        if (isNative && document.visibilityState === 'hidden' && !(isChannel && isChannelMuted(content.place))) {
                            const sender = global.users?.[message.content.content.sender];
                            const convName = global.convs?.[message.content.content.place]?.name || 'Mycelium';
                            notifyMessage({
                                title: sender?.display ? `${sender.display} — ${convName}` : convName,
                                body: message.content.content.body || '📎 Attachment',
                                extra: { convId: message.content.content.place },
                            });
                            // Increment badge
                            const currentBadge = (window.__badgeCount || 0) + 1;
                            window.__badgeCount = currentBadge;
                            setBadge(currentBadge);
                        }
                    }
                    break;
                case "reaction_updated":
                    const reactionData = message.content.content;
                    const msgId = reactionData.messageId;
                    const conversationId = reactionData.place;
                    const reactionsDict = reactionData.reactions;

                    if (global.convs[conversationId]?.messages?.[msgId]) {
                        setElement(`global.convs[${conversationId}].messages[${msgId}].reactions`, reactionsDict);
                    }
                    break;
                case "mention": {
                    // Server-channel notification: play sound, and (for real @mentions,
                    // badge=true) bump the server's red mention badge.
                    const mention = message.content.content
                    const viewing = mention.channel_id === global.state.activeConv && document.visibilityState === 'visible'
                    if (viewing) {
                        // Already reading this channel — just clear the server-side state.
                        window.markChannelRead?.(mention.channel_id, mention.server_id)
                        break
                    }
                    if (global.user?.status?.mode !== 2) {
                        new Audio('static/sounds/notification.mp3').play().catch(() => {})
                    }
                    // badge !== false: real @mentions set badge=true; "All Messages"
                    // sets badge=false. Default to badging when the field is absent so
                    // an older backend payload still updates the count.
                    if (mention.badge !== false) {
                        const sid = String(mention.server_id)
                        if (!global.user.server_mention_counts) global.user.server_mention_counts = {}
                        global.user.server_mention_counts[sid] = (global.user.server_mention_counts[sid] || 0) + 1
                        setElement('global.user.server_mention_counts', global.user.server_mention_counts)
                    }
                    break;
                }
                case "friend_request":
                    loadUsers([message.content.content["kopinprincipal"]])
                    pushElement('global.user.invitations', message.content.content)
                    displayNotif(message.content)
                    if (isNative && document.visibilityState === 'hidden') {
                        notifyMessage({ title: 'Mycelium', body: 'New friend request', extra: {} });
                    }
                    break;
                case "accepted_request":
                    loadUsers([message.content.content["kopinsecondaire"]])
                    pushElement('global.user.friends', message.content.content)
                    for(let i in global.user.invitations){
                        const request = global.user.invitations[i]
                        if (request.id === message.content.content.id){
                            deleteElement("global.user.invitations", i)
                            break
                        }
                    }
                    break;
                case "added_conv":
                    const newConv = message.content.content
                    newConv.ongoingCall = null
                    if (newConv.private === undefined) newConv.private = true
                    if (!newConv.messages) newConv.messages = {}
                    loadUsers(newConv.members)
                    global.convs[newConv.id] = newConv
                    addElement('global.privateConvs', newConv)
                    break;
                case "update_status":
                    if (message.content.content.id === global.user.id){
                        setElement('global.user.status', message.content.content.status)
                    }
                    setElement('global.users['.concat(message.content.content.id,"].status"), message.content.content.status)
                    // Re-render online friends list when any friend's status changes
                    setElement('global.user.friends', global.user.friends)
                    break;
                case "typing":
                    if(global.state.activeConv === message.content.conv){
                        const box = document.getElementById("typing-name")
                        box.parentElement.style.display="flex";
                        // todo handle multiple names
                        box.textContent = global.users[message.content.uid]?.display ?? ""
                        setTimeout(() => box.parentElement.style.display="none", 5000)
                    }
                    break
                case "edit_conv":
                    if (message.content.item === "name"){
                        setElement('global.convs['+message.content.id+'].name', message.content.content)
                    } else if (message.content.item === "pfp") {
                        setElement('global.convs['+message.content.id+'].pfp', message.content.content)
                        setElement('global.privateConvs['+message.content.id+'].pfp', message.content.content)
                    }
                    break;

                case "message_edited":
                    const editData = message.content.content;
                    const messageId = editData.id.id; // Backend sends message object with id property
                    const newContent = editData.content;
                    const conversationId2 = editData.id.place;

                    const conv2 = global.convs[conversationId2];
                    if (conv2 && conv2.messages && conv2.messages[messageId]) {
                        setElement(`global.convs[${conversationId2}].messages[${messageId}].body`, newContent);
                        setElement(`global.convs[${conversationId2}].messages[${messageId}].edited`, true);
                        // If message has a poll, also update the poll question in the DOM directly
                        if (conv2.messages[messageId].poll) {
                            conv2.messages[messageId].poll.question = newContent;
                            const pollTitle = document.querySelector(`#message-${messageId} .poll-message h3`);
                            if (pollTitle) pollTitle.textContent = newContent;
                        }
                    }
                    break;

                case "poll_voted":
                    const pollVoteData = message.content.content;
                    const pvConv = global.convs[pollVoteData.place];
                    if (pvConv && pvConv.messages) {
                        const pvMsg = pvConv.messages[pollVoteData.messageId];
                        if (pvMsg && pvMsg.poll) {
                            pvMsg.poll.votes = pollVoteData.votes;
                            // Update vote count in DOM directly
                            const pvContainer = document.querySelector(`#message-${pollVoteData.messageId} .poll-vote-count`);
                            if (pvContainer) {
                                const allVoters = new Set();
                                for (const optId in pollVoteData.votes) {
                                    for (const v of pollVoteData.votes[optId]) allVoters.add(v);
                                }
                                pvContainer.textContent = `${allVoters.size} ${_t('votes')}`;
                            }
                        }
                    }
                    break;

                case "poll_option_added":
                    const pollOptData = message.content.content;
                    const poConv = global.convs[pollOptData.place];
                    if (poConv && poConv.messages) {
                        const poMsg = poConv.messages[pollOptData.messageId];
                        if (poMsg && poMsg.poll) {
                            poMsg.poll.options.push(pollOptData.option);
                            // Inject new option into DOM directly
                            const poList = document.querySelector(`#message-${pollOptData.messageId} .poll-option-list`);
                            if (poList) {
                                const isMultiple = poMsg.poll.multiple_choice;
                                const div = document.createElement('div');
                                div.className = 'inline poll-option';
                                div.setAttribute('onclick',
                                    `const cb=this.querySelector('input');cb.checked=!cb.checked;${isMultiple ? '' : `uncheckOtherPollOptions(cb,${pollOptData.messageId});`}this.classList.toggle('selected',cb.checked)`);
                                div.innerHTML = `<input type="checkbox" data-option-id="${pollOptData.option.id}" onclick="event.stopPropagation()"/><span></span>`;
                                div.querySelector('span').textContent = pollOptData.option.text;
                                poList.appendChild(div);
                            }
                        }
                    }
                    break;

                case "call_started":
                    const callData = message.content.content;

                    // Update conversation with ongoing call info
                    if (callData.conversation_id) {
                        setElement(`global.convs[${callData.conversation_id}].ongoingCall`, callData);
                    }

                    // Show call section as banner when we're not the initiator
                    if (callData.participants[0] !== global.user.id) {
                        const callMgrBanner = global.state.callManager;
                        if (callMgrBanner && callMgrBanner.callState === 'none') {
                            callMgrBanner.setBannerState(callData);
                        }
                        // Native full-screen incoming call notification
                        if (isNative) {
                            const caller = global.users?.[callData.participants[0]];
                            callStarted({
                                callId: callData.id,
                                callerName: caller?.display || 'Someone',
                                callType: callData.call_type || 'audio',
                            });
                        }
                    }
                    break;

                case "call_participant_joined":
                    const callManager = global.state.callManager;
                    const joinData = message.content.content;

                    // Update conversation call state
                    if (joinData.call && joinData.call.conversation_id) {
                        setElement(`global.convs[${joinData.call.conversation_id}].ongoingCall`, joinData.call);
                    }

                    // Handle participant join for active call
                    if (callManager && callManager.currentCall) {
                        await callManager.handleParticipantJoined(
                            joinData.call,
                            joinData.user_id
                        );
                    }
                    break;

                case "call_participant_left":
                    const cm = global.state.callManager;
                    const leftData = message.content.content;

                    // Update conversation call state
                    if (leftData.call && leftData.call.conversation_id) {
                        setElement(`global.convs[${leftData.call.conversation_id}].ongoingCall`, leftData.call);
                    }

                    // Handle participant leave for active call
                    if (cm && cm.currentCall) {
                        cm.handleParticipantLeft(
                            leftData.call,
                            leftData.user_id
                        );
                    }
                    break;

                case "call_ended":
                    const callMgr = global.state.callManager;
                    const endData = message.content.content;

                    // Clear ongoing call from conversation
                    if (endData.conversation_id) {
                        setElement(`global.convs[${endData.conversation_id}].ongoingCall`, null);
                    }

                    // Only clean up if we're in *this* call (not a different one)
                    if (callMgr && (!callMgr.currentCall || callMgr.currentCall.id === endData.call_id)) {
                        callMgr.cleanup();
                        if (isNative) callEnded();
                    }
                    break;

                case "call_mode_switch":
                    const modeCallManager = global.state.callManager;
                    if (modeCallManager && modeCallManager.currentCall &&
                        modeCallManager.currentCall.id === message.content.content.call_id) {
                        modeCallManager.handleModeSwitch(message.content.content.new_mode);
                    }
                    break;

                case "vocal_channel_joined": {
                    const vd = message.content.content;
                    const servId = global.state.currentServer?.id;
                    const serv = servId ? global.servers?.[servId] : null;
                    if (serv) {
                        if (!serv.vocalOccupants) serv.vocalOccupants = {};
                        serv.vocalOccupants[vd.channel_id] = vd.participants;
                        setElement(`global.state.currentServer.vocalOccupants[${vd.channel_id}]`, vd.participants);
                    }
                    break;
                }

                case "vocal_channel_left": {
                    const vdl = message.content.content;
                    const srvId2 = global.state.currentServer?.id;
                    const serv2 = srvId2 ? global.servers?.[srvId2] : null;
                    if (serv2) {
                        if (!serv2.vocalOccupants) serv2.vocalOccupants = {};
                        serv2.vocalOccupants[vdl.channel_id] = vdl.participants;
                        setElement(`global.state.currentServer.vocalOccupants[${vdl.channel_id}]`, vdl.participants);
                    }
                    // If we're watching the vocal channel content and the call ended, clean up
                    const vcm = global.state.callManager;
                    if (vcm && vcm.currentCall?.vocal_channel_id === vdl.channel_id
                            && !vdl.participants.includes(global.user.id)) {
                        vcm.cleanup();
                    }
                    break;
                }

                case "callOffer":
                    const offerMgr = global.state.callManager;
                    if (offerMgr && offerMgr.currentCall) {
                        offerMgr.handleOffer(
                            message.content.content.from_user,
                            message.content.content.signal
                        );
                    }
                    break;

                case "callAnswer":
                    const answerMgr = global.state.callManager;
                    if (answerMgr && answerMgr.currentCall) {
                        answerMgr.handleAnswer(
                            message.content.content.from_user,
                            message.content.content.signal
                        );
                    }
                    break;

                case "callIce":
                    const iceMgr = global.state.callManager;
                    if (iceMgr && iceMgr.currentCall) {
                        iceMgr.handleIceCandidate(
                            message.content.content.from_user,
                            message.content.content.signal
                        );
                    }
                    break;

                // Moderation (static/moderation.mjs, routes/moderation.py)
                case "message_deleted":
                    window.removeMessageLocally?.(message.content.content.id);
                    break;
                case "server_member_removed":
                    window.removeServerMember?.(message.content.content.server_id, message.content.content.account);
                    break;
                // Roles / channel permissions changed (routes/roles.py, access.mjs)
                case "server_permissions_changed":
                    window.onServerPermissionsChanged?.(message.content.content.server_id);
                    break;
                // Drive content changed (driveManager.notify_changed, servers/drive.mjs)
                case "drive_changed":
                    window.onDriveChanged?.(message.content.content);
                    break;
                case "server_removed":
                    window.onRemovedFromServer?.(message.content.content);
                    break;
                case "server_timeout":
                    window.applyTimeoutState?.(message.content.content.server_id, message.content.content.expires_at);
                    break;
                case "server_timeout_removed":
                    window.applyTimeoutState?.(message.content.content.server_id, null);
                    break;
                case "account_suspended":
                    window.onAccountSuspended?.();
                    break;

                default:
                    break;
            }
            break;
        default:
            break;
    }

}