import {initNavigation, printWatermark, goTo} from "/static/framework/navigation.mjs"
import {handleHashRoute} from "/static/navigation.mjs"
import {initWebSockets} from "./framework/websockets.mjs";
import {loadServers, loadUser, loadConvs, loadUsers, refreshUsers, handleMessageGroup, sendTyping, lookFor, orderServDirs, bumpConvActivity} from "/static/crud.mjs"
import global from "/static/framework/global.mjs"
import {MDToHTML} from "/static/markdown/utils.mjs"; // DO NOT REMOVE
import {} from "/static/admin.mjs"; // DO NOT REMOVE
import {} from "/static/access.mjs"; // DO NOT REMOVE
import {} from "/static/avatar.mjs"; // DO NOT REMOVE
import {} from "/static/imageEditor.mjs"; // Image crop/resize editor
import { initDrag } from "./drag.mjs";
import emojis from "/static/emojis.mjs";
import {addElement, deleteElement, pushElement, setElement, updateElement} from "/static/framework/vesta.mjs";
import {xhr} from "./framework/templating.mjs";
import {initTranslations} from "./translations/translation.mjs";
import {initConnectivity} from "/static/framework/connectivity.mjs";
import {loadSnapshot, saveSnapshot, configurePersistence} from "/static/framework/persistence.mjs";
import CallManager from "/static/webrtc.mjs";
import {} from "/static/constants.mjs"; // Expose and parseJsonArray globally
import {} from "/static/mentions.mjs"; // Mention autocomplete system
import {} from "/static/poll.mjs"; // Poll creation and voting
import {} from "/static/conv-blocks.mjs"; // Conversation block insertion
import {} from "/static/forum.mjs"; // Forum channels: posts, tags, layouts
// Capacitor bridge — only activates when running inside a native shell
import { hideSplash, registerPushNotifications } from "/static/capacitor-bridge.mjs";


global.state.currentTab = document.getElementById("logo")
const notifElt = document.getElementById("notif")
global.state.pendingConvMembers = {}
global.state.customEmojiCache = {} // keyed by emoji_id → {id, name, file}
global.state._customEmojiLoading = new Set() // prevents duplicate in-flight requests
global.users = {}
global.convs = {}
global.notes = {}
global.privateConvs = {}


const onBlockedLoaded = function(){
    global.user.blocked = {}
    let usersToload = []

    for(let blockship of JSON.parse(this.responseText)){
        usersToload.push(blockship.blocked)
        global.user.blocked[blockship.id] = blockship
    }
    loadUsers(usersToload)
}

const onFriendsLoaded = function(){
    global.user.friends = JSON.parse(this.responseText)
    let usersToload = []
    for (let friendship of global.user.friends){
        usersToload.push(getRelevantUser(friendship))
    }
    loadUsers(usersToload)
}

const onInvitationsLoaded = function(){
    global.user.invitations = JSON.parse(this.responseText)
    let usersToload = []
    for (let friendship of global.user.invitations){
        usersToload.push(getRelevantUser(friendship))
    }
    loadUsers(usersToload)
}

// markReady reveals the UI. It is safe to call WITHOUT a websocket (offline
// boot), and is idempotent — postWS and the offline path both call it.
export function markReady(){
    if (global.state._ready) return
    global.state._ready = true

    console.log("UI ready", global)
    hideLoadingScreen()

    // URL routing: restore view from hash on initial load, handle browser back/forward
    const _initialHash = window.location.hash.slice(1)
    if (_initialHash) {
        setTimeout(() => handleHashRoute(_initialHash), 300)
    }
    window.addEventListener('popstate', () => handleHashRoute(window.location.hash.slice(1)))

    // Hide native splash screen once the app is ready
    hideSplash();
}
window.markReady = markReady

// postWS runs only once the websocket handshake has completed (online).
export function postWS(){
    const userList = JSON.stringify(Object.keys(global.users).map(cle => parseInt(cle)))
    xhr("subscribe?client_id="+global.state.clientID+"&cat=user&items="+userList,undefined)

    global.state.callManager = new CallManager();

    markReady();

    // Register for push notifications now that the user is authenticated
    // (requires google-services.json / Firebase to be configured)
    registerPushNotifications();

    // ── Capacitor deep-link / notification navigation hooks ──
    window.addEventListener('cap:navigateToConv', (e) => {
        const { convId } = e.detail;
        if (!convId || !global.convs[convId]) return;
        global.state.isServer = false;
        global.state.activeConv = convId;
        goTo('content', 'conv', undefined, true);
    });

    window.addEventListener('cap:deepLinkInvite', (e) => {
        const { token } = e.detail;
        if (token) window.location.href = `/static/invitation.html?token=${token}`;
    });

    window.addEventListener('cap:deepLinkChannel', (e) => {
        const { serverId, channelId } = e.detail;
        if (!serverId || !channelId) return;
        // Navigate to the server + channel
        const srv = Object.values(global.servers || {}).find(s => String(s.id) === String(serverId));
        if (srv) {
            global.state.isServer = true;
            global.state.currentServer = srv;
            global.state.activeConv = parseInt(channelId);
            goTo('content', 'conv', undefined, true);
        }
    });

    // Quick reply from notification action
    window.addEventListener('cap:quickReply', (e) => {
        const { convId, message } = e.detail;
        if (!convId || !message) return;
        // Notification payloads carry convId as a string; the server expects the
        // same numeric id the in-app send uses.
        const convIdNum = Number(convId);
        const id = Number.isNaN(convIdNum) ? convId : convIdNum;
        const savedConv = global.state.activeConv;
        global.state.activeConv = id;
        const xhr2 = new XMLHttpRequest();
        xhr2.open('GET', `send_message?conv=${encodeURI(JSON.stringify({id}))}&content=${encodeURIComponent(message)}&reply=`, true);
        xhr2.withCredentials = true;
        xhr2.send();
        global.state.activeConv = savedConv;
    });

    // Answer/Decline calls from notification actions
    window.addEventListener('cap:answerCall', (e) => {
        const { callId, callType } = e.detail;
        if (callId && window.joinCall) window.joinCall(callId, callType === 'video');
    });

    window.addEventListener('cap:declineCall', () => {
        const ringtone = document.getElementById('call-ringtone');
        if (ringtone) { ringtone.pause(); ringtone.currentTime = 0; }
        const notif = document.querySelector('.incoming-call-notification');
        if (notif) notif.remove();
    });
}

const CUSTOM_EMOJIS = {
    'bzh': '/static/images/bzh.png',
    ':bzh:': '<img class="custom-emoji" src="/static/images/bzh.png" alt=":bzh:">'
}
window.CUSTOM_EMOJIS = CUSTOM_EMOJIS

function renderEmoji(text) {
    for (const [code, html] of Object.entries(CUSTOM_EMOJIS)) {
        text = text.split(code).join(html)
    }
    return text
}
window.renderEmoji = renderEmoji

function statusText(){
    if(global.user?.status?.text){

        const default_msg = ["Online","Idle","Do not Disturb","Offline"]
        if(default_msg.includes(global.user.status.text)){
            global.user.status.text = _t(global.user.status.text)
        }

        if(global.user?.status?.emoji){
            return renderEmoji(global.user.status.emoji).concat(" ",global.user.status.text)
        }else{
            return global.user.status.text
        }
    }else{
        return _t("Online")
    }
}
window.statusText = statusText

function getSlug(name){
    const words = name.split(' ')
    let i = 0
    let slug= ''
    while (i < words.length && i<2){
        slug= slug + words[i][0]
        i++
    }
    return slug
}
window.getSlug = getSlug

function isImageAttachment(attachment) {
    // Optimistic (pre-upload) attachments carry a mime but no filepath yet.
    if (attachment.mime) return attachment.mime.startsWith("image/");
    if (!attachment.filepath) return true;
    return false;
}
window.isImageAttachment = isImageAttachment

/**
 * Download a file on native Capacitor (Android/iOS).
 * The `download` attribute is silently ignored by both WebViews, so we fetch
 * the file as a Blob and trigger the save via a temporary blob URL instead.
 * On plain browsers the onclick is a no-op and the default <a download> runs.
 */
async function nativeBlobDownload(url, filename) {
    const absoluteUrl = new URL(url, location.href).href;

    // Android: delegate to the native DownloadManager plugin.
    // The plugin reads session cookies from the WebView's own CookieManager
    // (including HttpOnly cookies) and passes them to DownloadManager, which
    // downloads in the background and shows an OS notification — same UX as Discord.
    if (window.Capacitor?.getPlatform() === 'android') {
        try {
            await window.Capacitor.Plugins.Download.downloadFile({ url: absoluteUrl, filename });
        } catch (e) {
            console.error('[nativeBlobDownload] Android plugin failed:', e);
            window.open(absoluteUrl, '_blank');
        }
        return;
    }

    // iOS: fetch the blob in JS and hand it to the native share sheet (Files, AirDrop, …).
    try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const blob = await response.blob();
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file] });
            return;
        }
        // Fallback for very old WebView versions that predate Web Share Level 2
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    } catch (e) {
        if (e.name === 'AbortError') return; // user dismissed share sheet — not an error
        console.error('[nativeBlobDownload] iOS failed:', e);
        window.open(absoluteUrl, '_blank');
    }
}
window.nativeBlobDownload = nativeBlobDownload

async function downloadAttachment(url, filename, event) {
    if (!window.Capacitor?.isNativePlatform?.()) return;
    event.preventDefault();
    await nativeBlobDownload(url, filename);
}
window.downloadAttachment = downloadAttachment

function loadEmojis(){

    global.state.emojis = []
    global.state.allEmojis = [] // Flat list for search

    for (let category of emojis) {
        let cat = {name:category.name, icon:category.icon, content:"",status:""}
        for (let emoji of category.content) {
            const is_custom = !!emoji.img

            let displayChar
            if (is_custom){
                displayChar = `<img class="custom-emoji-item" src="${emoji.img}" alt="${emoji.char}">`
                cat.content = cat.content.concat(`<div class="item" data-char="${emoji.char}" data-name="${emoji.name}" onclick="insertCustomStandardEmoji(event,'currentInput', '${emoji.char}')">${displayChar}</div>`)
                cat.status = cat.status.concat(`<div class="item" data-char="${emoji.char}" data-name="${emoji.name}" onclick="insertCustomStandardEmoji(event,'status', '${emoji.char}')">${displayChar}</div>`)
            }else{
                displayChar = emoji.char
                cat.content = cat.content.concat(`<div class="item" data-name="${emoji.name}" onclick="insertStandardEmoji(event,'currentInput')">${displayChar}</div>`)
                cat.status = cat.status.concat(`<div class="item" data-name="${emoji.name}" onclick="insertStandardEmoji(event,'status')">${displayChar}</div>`)
            }

            // Store for search
            global.state.allEmojis.push({
                char: emoji.char,
                name: emoji.name,
                category: category.name,
                img: emoji.img
            })
        }
        global.state.emojis.push(cat)
    }
}

/**
 * Fuzzy search score - higher is better match
 * @param {string} query - Search query
 * @param {string} text - Text to search in
 * @returns {number} Score (0 = no match, higher = better)
 */
function fuzzyScore(query, text) {
    query = query.toLowerCase()
    text = text.toLowerCase()

    // Exact match gets highest score
    if (text === query) return 1000

    // Starts with query gets high score
    if (text.startsWith(query)) return 500 + (query.length / text.length) * 100

    // Contains query as substring
    if (text.includes(query)) return 200 + (query.length / text.length) * 100

    // Fuzzy character matching
    let score = 0
    let queryIndex = 0
    let consecutiveBonus = 0

    for (let i = 0; i < text.length && queryIndex < query.length; i++) {
        if (text[i] === query[queryIndex]) {
            score += 10 + consecutiveBonus
            consecutiveBonus += 5 // Reward consecutive matches
            queryIndex++
        } else {
            consecutiveBonus = 0
        }
    }

    // Only return score if all query characters were found
    return queryIndex === query.length ? score : 0
}
/**
 * Search emojis and update the emoji board
 * @param {Event} event - Input event
 */
function searchEmojis(event) {
    const query = event.target.value.trim()
    const emojiBoard = event.target.closest('.emoji-board')
    const scrollable = emojiBoard.querySelector('.selector .scrollable')

    // Detect if this is a status emoji board (uses 'status' target) or input board (uses 'currentInput')
    const isStatusBoard = emojiBoard.id === 'emoji-board'
    const insertTarget = isStatusBoard ? 'status' : 'currentInput'
    const template = isStatusBoard ? 'emoji-cat' : 'emoji-cat-input'

    if (!query) {
        // Reset to default view
        scrollable.innerHTML = fillWith(template, global.state.emojis)
        return
    }

    // Search and score standard emojis
    const results = global.state.allEmojis
        .map(emoji => ({
            ...emoji,
            score: fuzzyScore(query, emoji.name)
        }))
        .filter(emoji => emoji.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 50) // Limit results

    // Search and score custom emojis
    const customResults = []
    for (const server of Object.values(global.servers || {})) {
        for (const e of (server.customEmojis || [])) {
            const score = fuzzyScore(query, e.name)
            if (score > 0) customResults.push({ ...e, score, serverId: server.id })
        }
    }
    customResults.sort((a, b) => b.score - a.score)

    if (results.length === 0 && customResults.length === 0) {
        scrollable.innerHTML = `<div class="no-results">${_t('Aucun émoji trouvé')}</div>`
        return
    }

    // Build results HTML
    const standardHtml = results.map(emoji => {
        const is_custom = !!emoji.img

        let res
        let displayChar
        if (is_custom){
            displayChar = `<img class="custom-emoji-item" src="${emoji.img}" alt="${emoji.char}">`
            res = `<div class="item" data-char="${emoji.char}" data-name="${emoji.name}" onclick="insertCustomStandardEmoji(event,'${insertTarget}', '${emoji.char}')">${displayChar}</div>`
        }else{
            res = `<div class="item" data-name="${emoji.name}" onclick="insertStandardEmoji(event,'${insertTarget}')">${emoji.char}</div>`
        }
        return res
    }).join('')

    const customHtml = customResults.map(e =>
        `<div class="item custom-emoji-item" title=":${e.name}:" onclick="insertCustomEmoji('custom:${e.serverId}:${e.id}','${e.name}','${insertTarget}','${e.file}')">` +
        `<img src="/static/attachments/${e.file}" style="width:1.5rem;height:1.5rem;object-fit:cover"></div>`
    ).join('')

    scrollable.innerHTML = `<div class="search-results"><div class="cat">${standardHtml}${customHtml}</div></div>`
}
window.searchEmojis = searchEmojis

/** Returns friends whose status is not offline (grey/spymode/undefined count as offline). */
function getOnlineFriends() {
    const offlineIcons = new Set(['grey', 'spymode'])
    return (global.user.friends || []).filter(f => {
        const icon = global.users[getRelevantUser(f)]?.status?.icon
        return icon && !offlineIcons.has(icon)
    })
}
window.getOnlineFriends = getOnlineFriends

/** Shared fuzzy search over a given friends pool. */
function _searchFriendsInPool(event, pool) {
    const query = event.target.value.trim()
    const scrollable = document.querySelector('#friends-block .scrollable')
    if (!scrollable) return

    if (!query) {
        scrollable.innerHTML = fillWith('friendCard', pool, 'column')
        return
    }

    const results = pool
        .map(f => ({ friendship: f, score: fuzzyScore(query, global.users[getRelevantUser(f)]?.display ?? '') }))
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(r => r.friendship)

    scrollable.innerHTML = results.length
        ? fillWith('friendCard', results, 'column')
        : `<div style="padding:1rem;color:var(--text2)">${_t('Aucun ami trouvé')}</div>`
}

function searchFriends(event) { _searchFriendsInPool(event, global.user.friends) }
window.searchFriends = searchFriends

function searchFriendsOnline(event) { _searchFriendsInPool(event, getOnlineFriends()) }
window.searchFriendsOnline = searchFriendsOnline

/** Returns deduplicated servers that have at least one custom emoji. */
function _uniqueServersWithEmojis() {
    const seen = new Set()
    return Object.values(global.servers || {}).filter(s => {
        if (!s || !s.id || seen.has(s.id)) return false
        seen.add(s.id)
        return s.customEmojis && s.customEmojis.length > 0
    })
}

/**
 * Build HTML for custom emoji category groups (for use in emoji boards).
 * @param {string} target - 'currentInput', 'reaction', or 'status'
 */
function getCustomEmojiCatHtml(target) {
    const servers = _uniqueServersWithEmojis()
    if (servers.length === 0) return ''

    return servers.map(server => {
        const items = server.customEmojis.map(e =>
            `<div class="item custom-emoji-item" title=":${e.name}:" onclick="insertCustomEmoji('custom:${server.id}:${e.id}','${e.name}','${target}','${e.file}')">` +
            `<img src="/static/attachments/${e.file}" style="width:2rem;height:2rem;object-fit:cover">` +
            `</div>`
        ).join('')
        return `<div class="group" id="emoji-cat-server-${server.id}">` +
            `<div class="title" onclick="toggleGroup()">` +
            `<h3>${server.name}</h3><div class="icon">&gt;</div></div>` +
            `<div class="cat">${items}</div></div>`
    }).join('')
}
window.getCustomEmojiCatHtml = getCustomEmojiCatHtml

/**
 * Build HTML for custom emoji category scroll buttons.
 */
function getCustomEmojiScrollHtml() {
    const serversWithEmojis = Object.values(global.servers || {}).filter(s => s.customEmojis && s.customEmojis.length > 0)
    return serversWithEmojis.map(server => {
        const icon = server.pfp
            ? `<img src="/static/attachments/${server.pfp}" style="width:1.3rem;height:1.3rem;border-radius:50%;object-fit:cover">`
            : `<div class="circle blue" style="width:1.3rem;height:1.3rem;font-size:0.6rem">${server.name.charAt(0)}</div>`
        return `<a class="icon-wrapper" href="#emoji-cat-server-${server.id}">${icon}</a>`
    }).join('')
}
window.getCustomEmojiScrollHtml = getCustomEmojiScrollHtml


function repaintConv(sub, value){
    console.log("repainting conv", sub, value)
    const conv = global.convs[global.state.activeConv]
    if (!conv?.messageGroups?.length) return

    if(conv.messageGroups[conv.messageGroups.length-1].messages.length > 1){
        sub.lastChild.remove()
        if (sub.children[sub.children.length-1].classList.contains("separator")){
            sub.children[sub.children.length-1].remove()
        }
    }
    sub.insertAdjacentHTML("beforeend", fillWith('messageGroup',[conv.messageGroups[conv.messageGroups.length-1]]))
    requestAnimationFrame(() => mountAllConvSpreadsheets(sub))


    // au lieu de fillWith on prends l'élément modifié et on l'handle
    // pour un nouveau message on l'append au groupe
    // pour un nouveau groupe on l'ajoute a la conv active
}
window.repaintConv = repaintConv

function Save(endpoint="change_profile"){
    console.log("saving",global.state["currentForm"])
    for (let key in global.state["currentForm"]){
        if (key !== "modified" && global.state["currentForm"][key].modified){
            const target = key.split("-")[0]
            console.log("target is ",target)
            if (endpoint === "edit_server_property") {
                xhr(endpoint + "?server_id=".concat(global.state.currentServer.id, "&property=", target, "&value=", encodeURIComponent(global.state["currentForm"][key].value)), undefined, "POST", false)
                setElement("global.state.currentServer.".concat(target), global.state["currentForm"][key].value)
            }else if (endpoint === "editChannel") {
                const id = global.state.modaltarget.dataset.id
                const type = global.state.modaltarget.dataset.type
                const newValue = global.state["currentForm"][key].value

                const channelId = parseInt(id)
                let channelArray = null
                let channelIndex = -1


                if (type === "vocal") {
                    channelArray = global.state.currentServer.dirs.vocals
                }else if (type === "conv") {
                    channelArray = global.state.currentServer.dirs.channels
                }else if (type === "note") {
                    channelArray = global.state.currentServer.dirs.notes
                }else if (type === "drive") {
                    channelArray = global.state.currentServer.dirs.drives
                }

                if (channelArray) {
                    channelIndex =  channelArray.findIndex(ch => ch.id === channelId)
                    channelArray[channelIndex].name = newValue
                    orderServDirs(global.state.currentServer)
                }

                // Envoyer la requête en arrière-plan (si ça échoue, on pourrait rollback)
                xhr("edit_server_channel?server_id=".concat(global.state.currentServer.id, "&value=", encodeURIComponent(newValue), "&field=name&targetId=", id, "&channel_type=", type), undefined, "POST", false)
            }else if (endpoint === "editRole") {
                const id = global.state.currentRole.id
                xhr("edit_server_role?server_id=".concat(global.state.currentServer.id, "&value=", encodeURIComponent(global.state["currentForm"][key].value), "&field=name&targetId=", id), undefined, "POST", false)
                // setElement("global.state.currentServer.".concat(target), global.state["currentForm"][key].value)
            }else{
                xhr(endpoint+"?element=".concat(target,"&value=",encodeURIComponent(global.state["currentForm"][key].value)), undefined,"POST",false)
                setElement("global.user.".concat(target), global.state["currentForm"][key].value)
            }
        }
    }
    delete global.state["currentForm"]
    const save_menu = document.querySelector(".save-settings")
    save_menu.style.display="none"
}
window.Save = Save

export function getRelevantUser(element){
    if (global.user.id === element["kopinprincipal"]){
        return element["kopinsecondaire"]
    }else{
        return element["kopinprincipal"]
    }
}
window.getRelevantUser = getRelevantUser

function sendCurrentMessage(target){
    const body = target.value
    const hasAttachments = global.state?.currentMessageAttachments?.length > 0
    if (body.trim() === '' && !hasAttachments) return

    // Send attachment objects with metadata for the backend.
    const attachmentData = (global.state.currentMessageAttachments || []).map(a => ({
        dataUrl: a.dataUrl,
        filename: a.name,
        mimeType: a.type
    }))

    const conv = global.state.activeConv
    // Optimistic message: render it immediately with a sentinel id and a
    // "pending" state, then reconcile against the server response (real id +
    // stored attachment paths). The sentinel can't collide with a real DB id.
    const tempId = 'tmp_' + (global.state._tmpSeq = (global.state._tmpSeq || 0) + 1)
    const message = {
        "id": tempId,
        "sender": global.user.id,
        "place": conv,
        "body": body,
        "timestamp": Date.now(),
        "reply": global.convs[conv].reply,
        // local preview objects; swapped for server paths on reconcile
        "attachments": attachmentData.map(a => ({dataUrl: a.dataUrl, filename: a.filename, mime: a.mimeType})),
        "sendState": "pending",
        // everything deliverMessage() needs to (re)send, kept for retry
        "_payload": {content: body, reply: global.convs[conv].reply, attachments: attachmentData}
    }
    handleMessageGroup(message)
    addElement('global.convs['.concat(conv,'].messages'), message)
    bumpConvActivity(conv, message.timestamp)
    scrollConvToBottom()

    // Clear the composer right away so it feels instant.
    target.value = ''
    resizeHeight(undefined, target)
    updateSendButton(target)
    cancelReply()
    removeAllAttachments()

    deliverMessage(message)
}
window.sendCurrentMessage = sendCurrentMessage

// Fire (or re-fire) the actual send for an optimistic message and wire up
// success/failure. Reused by retrySend().
function deliverMessage(message){
    setMessageSendState(message, 'pending')
    const p = message._payload
    const onload = function(){
        if (this.status >= 200 && this.status < 300){
            reconcileSentMessage(message, this.responseText)
        }else{
            // Server responded with an error (5xx / 413 quota / …). onload fires
            // for any completed response, so failure is detected by status.
            handleQuotaError(this)   // shows the quota dialog when it's a 413
            markMessageFailed(message)
        }
    }
    const req = xhr(
        "send_message?conv=".concat(encodeURI(JSON.stringify({'id':message.place})), "&content=", encodeURIComponent(p.content), "&reply=", p.reply),
        onload, "POST", true, {"attachments": p.attachments}
    )
    // Network-level failures: offline / unreachable fire onerror; a hung
    // connection fires ontimeout (there is no default timeout otherwise).
    req.timeout = 15000
    req.onerror = () => markMessageFailed(message)
    req.ontimeout = () => markMessageFailed(message)
}
window.deliverMessage = deliverMessage

// Swap the optimistic placeholder for the server's saved message: re-key it
// under the real DB id (so reactions/edits/replies target the right row) and
// adopt the stored attachment paths.
function reconcileSentMessage(message, responseText){
    let realId, serverAttachments
    try {
        const data = JSON.parse(responseText)
        const m = data.message || data
        realId = m.id
        serverAttachments = m.attachments   // JSON string: [{mime,filename,filepath}]
    } catch(e){ /* keep the temp id if the body isn't what we expect */ }

    const conv = global.convs[message.place]
    const tempId = message.id
    if (conv && realId !== undefined && realId !== null && String(realId) !== String(tempId)){
        delete conv.messages[tempId]
        message.id = realId
        conv.messages[realId] = message
    }
    if (typeof serverAttachments === 'string'){
        try { message.attachments = JSON.parse(serverAttachments) } catch(e){}
    }
    message.sendState = 'sent'
    delete message._payload
    rerenderMessage(message, tempId)
}

function markMessageFailed(message){
    setMessageSendState(message, 'failed')
}

function setMessageSendState(message, state){
    message.sendState = state
    rerenderMessage(message)
}

// Replace a single message's DOM node in place (its .group wrapper), so the
// pending/failed/sent visuals and the real id-keyed reactive bindings refresh
// without repainting the whole conversation.
function rerenderMessage(message, oldId = message.id){
    const el = document.getElementById('message-' + oldId)
    const group = el?.closest('.group')
    if (group){
        group.outerHTML = fillWith('message', [message])
    }
}

// Retry a message that failed to send, from the red retry icon.
function retrySend(tempId){
    const conv = global.convs[global.state.activeConv]
    const message = conv?.messages?.[tempId]
    if (!message || !message._payload) return
    deliverMessage(message)
}
window.retrySend = retrySend

// The message list is flex column-reverse, so the bottom (newest) sits at
// scrollTop 0; scrolling up yields negative offsets.
function getConvScrollable(){
    return document.querySelector('#content .scrollable.bottom-margin')
        || document.querySelector('#content .scrollable')
}
window.getConvScrollable = getConvScrollable

function scrollConvToBottom(smooth = true){
    const sc = getConvScrollable()
    if (sc) sc.scrollTo({top: 0, behavior: smooth ? 'smooth' : 'auto'})
}
window.scrollConvToBottom = scrollConvToBottom

// Called when a message arrives for the active conv. If the user is at the
// bottom we keep them pinned; if they've scrolled up we surface a pill instead
// of yanking the viewport.
function onConvMessageArrived(){
    const sc = getConvScrollable()
    if (!sc) return
    if (sc.scrollTop > -150){
        scrollConvToBottom()
    }else{
        showNewMessagesPill(sc)
    }
}
window.onConvMessageArrived = onConvMessageArrived

function showNewMessagesPill(scrollable){
    const host = scrollable.parentElement || scrollable
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
    let pill = host.querySelector('.new-msg-pill')
    if (!pill){
        pill = document.createElement('div')
        pill.className = 'new-msg-pill'
        pill.innerHTML = `<img class="icon" src="/static/icons/material/down.svg"/><span>${_t('Nouveaux messages')}</span>`
        pill.onclick = () => { scrollConvToBottom(); pill.remove() }
        host.appendChild(pill)
        // Drop the pill once the user reaches the bottom on their own.
        const onScroll = () => {
            if (scrollable.scrollTop > -50){
                pill.remove()
                scrollable.removeEventListener('scroll', onScroll)
            }
        }
        scrollable.addEventListener('scroll', onScroll)
    }
}
window.showNewMessagesPill = showNewMessagesPill

function sendMessage(event){
    // On mobile, Enter inserts a newline; the send button is used to send instead
    if (event.key === "Enter" && !event.shiftKey && !global.state.isMobile){
        sendCurrentMessage(event.currentTarget)
        event.preventDefault()
    }else{
        sendTyping()
    }
}
window.sendMessage = sendMessage

// Grey the mobile send button when there's nothing to send, accent it otherwise
function updateSendButton(textarea){
    if (!textarea){
        // called from attachment handlers without a reference to the textarea
        textarea = document.querySelector('.chat-input textarea')
    }
    const btn = textarea?.closest('.chat-input')?.querySelector('.send-btn')
    if (!btn) return
    const hasContent = textarea.value.trim() !== '' || global.state?.currentMessageAttachments?.length>0
    btn.classList.toggle('active', hasContent)
}
window.updateSendButton = updateSendButton

function sendButtonClick(event){
    const textarea = event.currentTarget.closest('.chat-input').querySelector('textarea')
    sendCurrentMessage(textarea)
}
window.sendButtonClick = sendButtonClick

function resizeHeight(event, target = undefined){
    if (!target){
        target = event.currentTarget
    }
    target.style.height = 'auto';
    target.style.height = target.scrollHeight + 'px';
}
window.resizeHeight = resizeHeight

function getConvName(conv,inputable = false){
    if (conv.private || !inputable){
        if(conv.name){
            return conv.name
        }

        let name = ""
        loadUsers(conv.members)

        for (let member in conv.members){
            member = conv.members[member]
            if(member != global.user.id){
                name = name.concat(global.users[member].display)
            }
        }
        conv.name=name
        return name
    }else{
        return `<input value="${conv.name ? conv.name : ''}" onblur="renameConv(event,${conv.id})" onkeydown="checkEnter(event, ()=>{renameConv(event,${conv.id})})")>`
    }
}
window.getConvName = getConvName

function getSeparator(element){
    let date

    if(element.id>0){
        date = global.convs[global.state.activeConv].messageGroups[element.id-1].date
    }else{
        date = undefined
    }
    if(date !== element.date){
        return `<div class="separator"><p>${element.date}</p><div class="hr"></div></div>`
    }else{
        return ""
    }
}
window.getSeparator = getSeparator

function getAnswerBlock(element){
    if(element.messages[0].reply){
        const og = global.convs[global.state.activeConv].messages?.[element.messages[0].reply]

        if (!og){ // FIXME when sending a message you dont get the id of your message back so the reply block is broken if the users responds
            return ""
        }

        return `<div class="inline reply">
<div class="replyLineBox">
    <div class="replyLine">
    </div>
</div>
<div class="circle red small" style="background-image:url(/static/attachments/${global.users[og.sender]?.pfp});background-size:cover;"></div>
<b>@${global.users[og.sender].display}</b>
<a href="#message-${og.id}" class="ellipsis">${og.body}</a>
</div>`
    }else{
        return ""
    }
}
window.getAnswerBlock = getAnswerBlock

export function displayNotif(notif){
    // First-column notif bubbles are exclusively for DMs/group convs. A notif whose
    // "place" isn't a known conversation (e.g. a server channel that slipped through,
    // or a conv not yet loaded) must not render — it would produce a broken bubble
    // with no avatar/name. Channel messages are surfaced via the server badge instead.
    if (notif.content.place && !global.convs?.[notif.content.place]) {
        return
    }
    if (global.user?.status?.mode !== 2) {
        const notifSound = new Audio('static/sounds/notification.mp3');
        notifSound.play();
    }
    const bubbles = document.getElementsByClassName("notifIndicator")
    if(notif.content.place){
        const conv_elt = document.getElementById("conv"+notif.content?.place.toString())
            || document.getElementById("channel-conv-"+notif.content?.place.toString())

        if (conv_elt){
            conv_elt.style.setProperty("color", "var(--text)")
        }
        if(!global.state.notifs){
            global.state.notifs = {}
        }
        if(!global.state.notifs.convs){
            global.state.notifs.convs = []
        }
        pushElement("global.state.notifs.convs",{n: 1, conv:global.convs[notif.content.place]})
    }else{
        for(let bubble of bubbles){
            bubble.style.display="flex"
        }
    }
    //notifElt.style.display = "flex"
    //notifElt.innerText = notif.body
    //setTimeout(() => notifElt.style.display="none", 1500)
}

function notMe(userList, loadUser=false){
    if (userList == undefined) {
        return undefined
    }

    for (let i in userList){
        if (userList[i] != global.user.id){
            if(loadUser){
                loadUsers([userList[i]])
            }
            return userList[i]
        }
    }
    return userList[0]
}
window.notMe = notMe

function getUserStatus(id, customOnly=false){
    if(global.users[id]?.status?.text){

        const default_msg = ["Online","Idle","Do not Disturb","Offline"]
        if(default_msg.includes(global.users[id].status.text)){
            if (customOnly){
                return ""
            }
            global.users[id].status.text = _t(global.users[id].status.text)
        }

        if(global.users[id]?.status?.emoji){
            return global.users[id].status.emoji.concat(" ",global.users[id].status.text)
        }else{
            return global.users[id].status.text
        }
    }else{
        return _t("Online")
    }
}
window.getUserStatus = getUserStatus


function deleteServer(){
    if (confirm(_t('Voulez-vous vraiment supprimer votre serveur et tous ses contenus associés ? Cette action est irréversible.'))) {

        const onload = function() { // request successful
            console.log("server deleted")
            window.location.href = ("/channels")
        };
        xhr("delete_server?server_id=".concat(global.state.currentServer.id), onload, "POST", true)

    } else {
        console.log("ouf 😖")
    }
}
window.deleteServer = deleteServer

initNavigation()
printWatermark("Mycelium@carbonlab.dev", "https://github.com/Louciole/mycelium")

// ── Connectivity + persistence ──
// One way of working for online and offline: render whatever was cached, then
// always attempt the network refresh. Online, the refresh overwrites the cache
// paint; offline, those requests fail harmlessly and the cached state stands.
// Must run AFTER initNavigation() (which sets window.global).
// App-specific config for the generic framework persistence engine: which
// global subtrees to snapshot, and the IndexedDB name.
configurePersistence({
    keys: ['user', 'users', 'servers', 'convs', 'privateConvs', 'notes', 'forums'],
    dbName: 'mycelium',
})
initConnectivity({ bannerText: 'Hors-ligne — données enregistrées' })
// Snapshot the navigable state when the app is hidden/closed (covers mobile
// backgrounding). Bounded: one record, overwritten.
document.addEventListener('visibilitychange', () => { if (document.hidden) saveSnapshot() })
window.addEventListener('pagehide', saveSnapshot)

await initTranslations()
goTo('content',"friends",undefined,true,()=>{goTo('friends-block','main-friend')})
loadTemplate("profile-info.html")
loadTemplate("create-poll.html")
loadTemplate("create-block.html")
loadTemplate("create-forum-post.html")
loadTemplate("poll-voters.html")

// Local-first paint: rehydrate global from the last snapshot so a cold start
// (notably offline) shows servers/convs immediately, before any network call.
const _snapshot = await loadSnapshot()
if (_snapshot) {
    for (const k in _snapshot) global[k] = _snapshot[k]
    if (global.user?.id) global.users[global.user.id] = global.user
    setElement('global.servers', global.servers || {})
    loadConvs(true)    // local-first paint of the DM sidebar from the snapshot (no fetch)
    markReady()
    initWebSockets()   // idempotent; reconnects when the network returns
}

// Network bootstrap (always): refreshes the cache paint when online, fails
// silently when offline.
refreshUsers()
loadUser()
xhr("get_blocked", onBlockedLoaded)
xhr("get_friends", onFriendsLoaded)
xhr("get_friend_invitations", onInvitationsLoaded)


loadServers()

// low priority
loadEmojis()
initDrag()


function hideLoadingScreen() {
    const loadingScreen = document.getElementById('loading-screen');

    // Fade out the loading screen
    loadingScreen.classList.add('fade-out');

    // Optional: wait until the transition ends before removing or showing content
    loadingScreen.addEventListener('transitionend', () => {
        loadingScreen.style.display = 'none';
    });
}


function showIncomingCallNotification(callData) {
    // TODO USE A TEMPLATE INSTEAD OF CREATING ELEMENTS LIKE A SAVAGE
    const isVideo = callData.call_type === 'video';
    const callTypeText = isVideo ? _t("appel vidéo") : _t("appel vocal");

    const initiator = callData.participants[0];
    const initiatorName = global.users[initiator]?.display || 'Un utilisateur';

    const notification = document.createElement('div');
    notification.className = 'incoming-call-notification';
    notification.innerHTML = `
        <div class="incoming-call-content">
            <img class="icon large" src="/static/icons/material/${isVideo ? 'videocam' : 'call'}.svg"/>
            <h3>${initiatorName}</h3>
            <p>${callTypeText} ${_t("entrant")}</p>
            <div class="incoming-call-actions">
                <button class="btn-accept" onclick="acceptCall(${callData.id}, ${isVideo})">
                    <img class="icon" src="/static/icons/material/call.svg"/>
                    ${_t("Accepter")}
                </button>
                <button class="btn-decline" onclick="declineCall(${callData.id})">
                    <img class="icon" src="/static/icons/material/call_end.svg"/>
                    ${_t("Refuser")}
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(notification);

    const notifSound = document.getElementById('call-ringtone');
    if (notifSound) {
        notifSound.play().catch(e => console.log('Cannot play ringtone:', e));
    }
}
window.showIncomingCallNotification = showIncomingCallNotification;

window.acceptCall = async function(callId, hasVideo) {
    const notification = document.querySelector('.incoming-call-notification');
    if (notification) {
        notification.remove();
    }

    const ringtone = document.getElementById('call-ringtone');
    if (ringtone) {
        ringtone.pause();
        ringtone.currentTime = 0;
    }

    await joinCall(callId, hasVideo);
};

window.declineCall = function(callId) {
    // Supprimer la notification
    const notification = document.querySelector('.incoming-call-notification');
    if (notification) {
        notification.remove();
    }

    // Arrêter la sonnerie
    const ringtone = document.getElementById('call-ringtone');
    if (ringtone) {
        ringtone.pause();
        ringtone.currentTime = 0;
    }
};

window.addEventListener('load', () => {
    hideLoadingScreen()
});
