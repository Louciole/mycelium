import global from "./framework/global.mjs"
import {loadChan, loadConv, loadNote, loadServer, lookFor, loadForum, loadForumPost} from "./crud.mjs";
import {setElement} from "./framework/vesta.mjs";
import {closeFM, goTo} from "./framework/navigation.mjs";
import {xhr} from "./framework/templating.mjs";
import {} from "./servers/drive.mjs"
let emptyStr = '' //DO NOT REMOVE

// Mounts the conv blocks of a freshly rendered chat view. repaintConv() only covers
// messages arriving live, so blocks coming from history need this on view entry.
// mountAllConvSpreadsheets lives on window (conv-blocks.mjs), like in main.mjs —
// importing it here would add an edge to the navigation/crud/main import cycle.
function mountContentBlocks() {
    requestAnimationFrame(() => window.mountAllConvSpreadsheets?.(document.getElementById('content')))
}

let _skipRoutePush = false

function saveLastChannel(channelId, type) {
    const serverId = global.state.currentServer?.id
    if (serverId == null) return
    try {
        localStorage.setItem('nav_server_' + serverId, JSON.stringify({ id: channelId, type }))
    } catch(e) {}
}
window.saveLastChannel = saveLastChannel

function restoreLastChannel() {
    const serverId = global.state.currentServer?.id
    if (serverId == null) return false
    try {
        const saved = localStorage.getItem('nav_server_' + serverId)
        if (!saved) return false
        const { id, type } = JSON.parse(saved)
        const dirs = global.state.currentServer.dirs
        if (!dirs) return false
        if (type === 'channel' && dirs.channels?.some(c => c.id === id)) { goToChannel(id); return true }
        if (type === 'vocal'   && dirs.vocals?.some(c => c.id === id))   { goToVocalChannel(id); return true }
        if (type === 'note'    && dirs.notes?.some(c => c.id === id))    { goToNoteChannel(id); return true }
        if (type === 'forum'   && dirs.forums?.some(c => c.id === id))   { goToForumChannel(id); return true }
        if (type === 'drive'   && dirs.drives?.some(c => c.id === id))   { goToDriveChannel(id); return true }
    } catch(e) {}
    return false
}

function pushRoute(hash) {
    if (_skipRoutePush) return
    history.pushState(null, '', '/channels' + (hash ? '#' + hash : ''))
}

function replaceRoute(hash) {
    if (_skipRoutePush) return
    history.replaceState(null, '', '/channels' + (hash ? '#' + hash : ''))
}

export function handleHashRoute(hash) {
    if (!hash) return
    _skipRoutePush = true
    try {
        if (hash === '@me') {
            if (global.state.activeConv) {
                document.getElementById('conv' + global.state.activeConv)?.classList.remove('selected')
            }
            global.state.activeConv = undefined
            document.getElementById('friendCat')?.classList.add('selected')
            if (global.state.isMobile) mobileDisplayContent()
            goTo('content', 'friends', undefined, false)
            goTo('friends-block', 'main-friend')
            return
        }

        if (hash.startsWith('@me/')) {
            const convId = parseInt(hash.slice(4))
            if (!isNaN(convId) && global.convs?.[convId]) {
                goToConv(convId)
            }
            return
        }

        const parts = hash.split('/')
        if (parts.length >= 2) {
            const serverId = parseInt(parts[0])
            const channelId = parseInt(parts[1])
            if (isNaN(serverId) || isNaN(channelId)) return

            const server = lookFor(serverId, global.servers)
            if (!server) return

            global.state.currentServer = server
            global.state.activeConv = undefined
            global.state.isServer = true
            loadServer(serverId)

            // Select the server icon in the main selector (best-effort: icons may
            // not be in the DOM yet if loadServers hasn't completed).
            const prevTab = global.state.currentTab
            if (prevTab) prevTab.classList.remove('selected')
            const serverIcon = document.getElementById('server-item-' + serverId)
            if (serverIcon) {
                serverIcon.classList.add('selected')
                global.state.currentTab = serverIcon
            }

            const navigateInServer = () => {
                goTo('sec-selector', 'serverSelector', undefined, false, () => {
                    const dirs = global.state.currentServer.dirs
                    if (!dirs) return

                    if (parts[2] === 'post' && parts[3]) {
                        const postId = parseInt(parts[3])
                        if (!isNaN(postId)) {
                            goToForumChannel(channelId)
                            setTimeout(() => goToForumPost(postId), 100)
                        }
                        return
                    }

                    if (dirs.channels?.some(c => c.id === channelId)) {
                        goToChannel(channelId)
                    } else if (dirs.vocals?.some(c => c.id === channelId)) {
                        goToVocalChannel(channelId)
                    } else if (dirs.notes?.some(c => c.id === channelId)) {
                        goToNoteChannel(channelId)
                    } else if (dirs.forums?.some(c => c.id === channelId)) {
                        goToForumChannel(channelId)
                    } else if (dirs.drives?.some(c => c.id === channelId)) {
                        goToDriveChannel(channelId)
                    }
                })
            }

            // column-perso must be loaded before sec-selector can be targeted.
            // It may not exist yet if loadConvs hasn't fired (e.g. slow network).
            if (document.getElementById('sec-selector')) {
                navigateInServer()
            } else {
                goTo('sec-column', 'column-perso', undefined, false, navigateInServer)
            }
        }
    } finally {
        _skipRoutePush = false
    }
}

/**
 * Wraps MDToHTML and replaces :emojiname: shortcodes from known custom emojis
 * with inline <img> elements. Falls back to the raw shortcode if unknown.
 */
function renderMessageBody(text) {
    if (!text) return ''
    const html = MDToHTML(text)

    // Build name -> file map from all locally loaded servers (deduplicated)
    const emojiMap = {}
    const seen = new Set()
    for (const s of Object.values(global.servers || {})) {
        if (!s || !s.id || seen.has(s.id)) continue
        seen.add(s.id)
        for (const e of (s.customEmojis || [])) {
            if (e.name && e.file && !emojiMap[e.name]) emojiMap[e.name] = `/static/attachments/${e.file}`
        }
    }
    // Lazily-loaded cross-server cache
    for (const data of Object.values(global.state?.customEmojiCache || {})) {
        if (data && data.name && data.file && !emojiMap[data.name]) emojiMap[data.name] = `/static/attachments/${data.file}`
    }

    // Global custom emojis (built-in, not per-server)
    for (const [name, src] of Object.entries(window.CUSTOM_EMOJIS || {})) {
        if (!emojiMap[name]) emojiMap[name] = src
    }

    if (Object.keys(emojiMap).length === 0) return html

    return html.replace(/:([a-zA-Z0-9_]+):/g, (match, name) => {
        const src = emojiMap[name]
        if (!src) return match
        return `<img class="inline-custom-emoji" src="${src}" alt=":${name}:" title=":${name}:">`
    })
}
window.renderMessageBody = renderMessageBody

/**
 * Lazily fetch custom emoji data for emojis from servers the viewer isn't in.
 * When the fetch completes it nudges the reaction container so Vesta re-renders it.
 * @param {string} emojiRef  - 'custom:serverId:emojiId'
 * @param {number} convId    - conversation/channel id (for re-render trigger)
 * @param {number} msgId     - message id (for re-render trigger)
 */
function ensureCustomEmoji(emojiRef, convId, msgId) {
    const [, , eid] = emojiRef.split(':')
    if (!eid) return
    if (global.state?.customEmojiCache?.[eid]) return          // already cached
    if (global.state?._customEmojiLoading?.has(eid)) return    // request in flight

    global.state._customEmojiLoading.add(eid)
    xhr(`get_custom_emoji?emoji_id=${eid}`, function() {
        try {
            const data = JSON.parse(this.responseText)
            if (data && data.file) {
                global.state.customEmojiCache[eid] = data
                // Trigger Vesta re-render of the reactions element for this message
                const reactions = global.convs?.[convId]?.messages?.[msgId]?.reactions
                if (reactions) {
                    setElement(`global.convs[${convId}].messages[${msgId}].reactions`, { ...reactions })
                }
            }
        } catch(e) { /* silently ignore */ }
        finally { global.state._customEmojiLoading.delete(eid) }
    })
}
window.ensureCustomEmoji = ensureCustomEmoji


/**
 * Check if scrolled to bottom and mark conversation notifications as read
 */
function checkAndMarkConvAsRead() {
    if (!global.state.activeConv) return

    const scrollable = document.querySelector('#content .scrollable.bottom-margin')
    if (!scrollable) return

    // Check if scrolled to bottom (within 50px threshold)
    const isAtBottom = scrollable.scrollTop > -50

    if (isAtBottom && global.user.notifs) {
        // Find notification for current conversation
        const notif = global.user.notifs.find(n => n.conversation === global.state.activeConv)

        if (notif) {
            // Call backend to delete the notification
            const onload = function() {
                try {
                    // Remove notification from global.user.notifs array
                    const index = global.user.notifs.findIndex(n => n.id === notif.id)
                    if (index > -1) {
                        global.user.notifs.splice(index, 1)
                        setElement('global.user.notifs', global.user.notifs)
                    }
                } catch (e) {
                    console.error("Error updating notifications:", e)
                }
            }

            xhr(`consult_notifs?notif_id=${notif.id}`, onload, "POST")
        }
    }
}

function goToConv(convId){
    let targetElt
    if(global.state.activeConv){
        targetElt = document.getElementById("conv".concat(global.state.activeConv))
    }else{
        targetElt = document.getElementById("friendCat")
    }
    if (targetElt){
        targetElt.classList.remove("selected")
    }

    global.state.activeConv = convId
    try { localStorage.setItem('nav_last_dm', convId) } catch(e) {}
    loadConv(convId)

    // Load call state for this conversation
    if (loadCallState) {
        loadCallState(convId);
    }

    if (global.state.isMobile) {
        mobileDisplayContent()
    }

    targetElt = document.getElementById("conv".concat(convId))
    targetElt.classList.add("selected")

    global.state.isServer = false
    pushRoute('@me/' + convId)
    goTo('content','conversation',undefined,false,mountContentBlocks)

    // Attach scroll listener to mark notifications as read
    setTimeout(() => {
        const scrollable = document.querySelector('#content .scrollable.bottom-margin')
        if (scrollable) {
            // Remove old listener if exists to prevent duplicates
            scrollable.removeEventListener('scroll', checkAndMarkConvAsRead)
            // Add new listener
            scrollable.addEventListener('scroll', checkAndMarkConvAsRead)
            // Check immediately in case already at bottom (e.g., when opening conv)
            checkAndMarkConvAsRead()
        }
    }, 100)
}
window.goToConv = goToConv

// Slide the mobile track to the content pane (section 3).
function mobileDisplayContent(){
    document.body.style.setProperty('--pane-x', '-100vw')
    document.body.dataset.pane = 'content'
}
window.mobileDisplayContent = mobileDisplayContent

// Slide the mobile track back to the selectors pane (sections 1 + 2).
function mobileHideContent(){
    document.body.style.setProperty('--pane-x', '0px')
    document.body.dataset.pane = 'selectors'
}
window.mobileHideContent = mobileHideContent

function applyChannelUnreads() {
    const now = Date.now()
    const unreads = global.user?.channel_unreads || []
    const mutes = global.user?.channel_mutes || []
    const mutedIds = new Set(
        mutes
            .filter(m => !m.muted_until || new Date(m.muted_until).getTime() > now)
            .map(m => m.channel)
    )
    for (const u of unreads) {
        if (mutedIds.has(u.channel)) continue
        const elt = document.getElementById('channel-conv-' + u.channel)
        if (elt) elt.classList.add('unread')
    }
    for (const id of mutedIds) {
        const elt = document.getElementById('channel-conv-' + id)
        if (elt) { elt.classList.add('muted'); elt.classList.remove('unread') }
    }
}
window.applyChannelUnreads = applyChannelUnreads

// Authoritative "channel read" action: clears the white unread marker and the
// channel's contribution to the server's red mention badge. The backend reports
// how many mentions it cleared so the badge stays correct even for live mentions
// (which never get a global.user.notifs entry). Network call is debounced so a
// busy active channel doesn't fire a request per message.
const _channelReadTimers = {}
function markChannelRead(id, serverId){
    const sid = String(serverId ?? global.state.currentServer?.id ?? '')
    // Optimistic UI: drop the channel's unread marker immediately.
    document.getElementById('channel-conv-' + id)?.classList.remove('unread')
    const wasUnread = (global.user?.channel_unreads || []).some(u => u.channel === id)
    if (global.user?.channel_unreads) {
        global.user.channel_unreads = global.user.channel_unreads.filter(u => u.channel !== id)
    }
    // Drop the server's small unread dot if this was its last unread channel.
    if (wasUnread && sid) {
        const su = global.user.server_unread || {}
        su[sid] = Math.max(0, (su[sid] || 0) - 1)
        if (!su[sid]) delete su[sid]
        setElement('global.user.server_unread', su)
    }
    const onload = function(){
        let cleared = 0
        try { cleared = (JSON.parse(this.responseText || '{}').mentions_cleared) || 0 } catch(e){}
        // Drop any seeded notifs for this channel so they can't be double-counted.
        if (global.user?.notifs) {
            global.user.notifs = global.user.notifs.filter(n => n.conversation !== id)
        }
        if (cleared && sid) {
            const counts = global.user.server_mention_counts || {}
            counts[sid] = Math.max(0, (counts[sid] || 0) - cleared)
            if (!counts[sid]) delete counts[sid]
            setElement('global.user.server_mention_counts', counts)
        }
    }
    clearTimeout(_channelReadTimers[id])
    _channelReadTimers[id] = setTimeout(() => {
        xhr(`mark_channel_read?channel_id=${id}`, onload, "POST")
    }, 600)
}
window.markChannelRead = markChannelRead

function goToChannel(id){
    let targetElt
    if(global.state.activeChan){
        targetElt = document.getElementById("channel".concat(global.state.activeChan.slug))
        targetElt?.classList.remove("selected")
    }

    // Opening a channel marks it read (clears unread dot + its server badge share).
    markChannelRead(id, global.state.currentServer?.id)

    global.state.activeConv = id
    global.state.activeChan = {id:id, slug:"-conv-"+id, type:"conv"}
    loadChan(id)
    saveLastChannel(id, 'channel')

    if (global.state.isMobile) {
        mobileDisplayContent()
    }

    targetElt = document.getElementById("channel".concat(global.state.activeChan.slug))
    targetElt.classList.add("selected")

    pushRoute(global.state.currentServer?.id + '/' + id)
    goTo('content','server-channel',undefined,false,mountContentBlocks)
    window.updateComposerLock?.()   // timed-out banner (moderation.mjs)
}
window.goToChannel = goToChannel

function goToVocalChannel(id){
    const cm = global.state.callManager
    const alreadyInThisChannel = cm?.callState === 'active' && cm?.currentCall?.vocal_channel_id === id

    if (alreadyInThisChannel) {
        // Open the vocal channel view
        let targetElt
        if(global.state.activeChan){
            targetElt = document.getElementById("channel".concat(global.state.activeChan.slug))
            targetElt?.classList.remove("selected")
        }
        global.state.activeChan = {id:id, slug:"-vocal-"+id, type:"vocal"}
        if (global.state.isMobile) mobileDisplayContent()
        targetElt = document.getElementById("channel".concat(global.state.activeChan.slug))
        targetElt?.classList.add("selected")
        pushRoute(global.state.currentServer?.id + '/' + id)
        goTo('content','server-vocal-content',undefined,false)
        return
    }

    // Not yet in channel — join silently without navigating away
    if (window.joinVocalChannel) joinVocalChannel(id)
}
window.goToVocalChannel = goToVocalChannel

function goToNoteChannel(id){
    let targetElt
    if(global.state.activeChan){
        targetElt = document.getElementById("channel".concat(global.state.activeChan.slug))
        targetElt?.classList.remove("selected")
    }

    global.state.activeChan = {id:id, slug:"-note-"+id, type:"note"}
    saveLastChannel(id, 'note')

    if (!global.convs) global.convs = {}
    loadNote(id)

    if (global.state.isMobile) {
        mobileDisplayContent()
    }

    targetElt = document.getElementById("channel".concat(global.state.activeChan.slug))
    targetElt.classList.add("selected")

    pushRoute(global.state.currentServer?.id + '/' + id)
}
window.goToNoteChannel = goToNoteChannel

function goToForumChannel(id){
    let targetElt
    if(global.state.activeChan){
        targetElt = document.getElementById("channel".concat(global.state.activeChan.slug))
        targetElt?.classList.remove("selected")
    }

    global.state.activeChan = {id:id, slug:"-forum-"+id, type:"forum"}
    saveLastChannel(id, 'forum')

    loadForum(id)

    if (global.state.isMobile) {
        mobileDisplayContent()
    }

    targetElt = document.getElementById("channel".concat(global.state.activeChan.slug))
    targetElt?.classList.add("selected")

    pushRoute(global.state.currentServer?.id + '/' + id)
}
window.goToForumChannel = goToForumChannel

function goToForumPost(postId){
    loadForumPost(postId)
    pushRoute(global.state.currentServer?.id + '/' + global.state.activeChan?.id + '/post/' + postId)
    if (global.state.isMobile) {
        mobileDisplayContent()
    }
}
window.goToForumPost = goToForumPost

function backToForum(){
    const forumId = global.state.activeChan?.id
    if (forumId !== undefined) {
        // Refetch: replies sent in the post changed its reply count / last activity.
        // Replace the post's history entry rather than stacking forum/post/forum/post...
        loadForum(forumId)
        replaceRoute(global.state.currentServer?.id + '/' + forumId)
    }
}
window.backToForum = backToForum


function goToFriends(event){
    if(global.state.activeConv){
        let targetElt = document.getElementById("conv".concat(global.state.activeConv))
        targetElt.classList.remove("selected")
    }

    global.state.activeConv = undefined
    event.currentTarget.classList.add("selected")

    if (global.state.isMobile) {
        mobileDisplayContent()
    }

    pushRoute('@me')
    goTo('content',"friends",undefined,false)
    goTo('friends-block','main-friend')
}

// Called by the logo button in main.html when switching to the @me section.
// Restores the last visited DM if one is stored in localStorage.
function goToHome(event) {
    global.state.isServer = false
    global.state.activeConv = undefined

    let lastDmId = null
    try {
        const lastDm = localStorage.getItem('nav_last_dm')
        if (lastDm) {
            const id = parseInt(lastDm)
            if (!isNaN(id) && global.convs?.[id]) lastDmId = id
        }
    } catch(e) {}

    goTo('sec-selector', 'privateMessage', {'category': 'currentTab', 'event': event}, true, () => {
        if (lastDmId && document.getElementById('conv' + lastDmId)) {
            goToConv(lastDmId)
        } else {
            goTo('content', 'friends', undefined, false, () => goTo('friends-block', 'main-friend'))
        }
    })
}
window.goToHome = goToHome
window.goToFriends = goToFriends

function insertStandardEmoji(event,target){
    if (target === "currentInput"){
        // bug ? this does not trigger the typing event, we could use a real event instead
        let input

        //i know...
        if(event.currentTarget.parentElement.parentElement.parentElement.parentElement.parentElement.id === "std-emoji-board"){
            input = document.querySelector("#description-input")
        }else{
            input = document.querySelector("textarea.selected")
        }

        if(!global.state.previousCursor){
            global.state.previousCursor = {start:0, end:0}
        }
        input.value = input.value.slice(0,global.state.previousCursor.start).concat(event.currentTarget.innerHTML,input.value.slice(global.state.previousCursor.end))
        global.state.previousCursor = {start: global.state.previousCursor.start+event.currentTarget.innerHTML.length, end:global.state.previousCursor.start+event.currentTarget.innerHTML.length}
        input.dispatchEvent(new Event('input', { bubbles: true }))
    }else if(target === "status"){
        setElement("global.user.status.emoji",event.currentTarget.innerHTML)
        closeFM('emoji-board')
    } else if (target === "reaction") {
        const messageId = global.state.reactionPickerTarget;
        const emoji = event.currentTarget.innerHTML;
        toggleReaction(messageId, emoji);
        closeFM('reaction-picker');
    } else {
        target.innerHTML = event.currentTarget.innerHTML
    }
}
window.insertStandardEmoji = insertStandardEmoji

function openReactionPicker(event, messageId) {
    global.state.reactionPickerTarget = messageId;
    toggleFM('reaction-picker');
    const picker = document.getElementById('reaction-picker');
    const rect = event.currentTarget.getBoundingClientRect();
    picker.style.top = `${Math.max(10, rect.top - picker.offsetHeight - 10)}px`;
    picker.style.left = `${rect.left - picker.offsetWidth }px`;
    picker.style.bottom = 'unset'
    picker.style.width = 'fit-content'
}
window.openReactionPicker = openReactionPicker;

/**
 * Insert a custom server emoji (custom:serverId:emojiId) into the target.
 * @param {string} emojiRef  - 'custom:serverId:emojiId'
 * @param {string} emojiName - short name used as text fallback
 * @param {string} target    - 'currentInput', 'reaction', or 'status'
 * @param {string} file      - filename in /static/attachments/
 */
function insertCustomEmoji(emojiRef, emojiName, target, file) {
    if (target === 'reaction') {
        const messageId = global.state.reactionPickerTarget;
        toggleReaction(messageId, emojiRef);
        closeFM('reaction-picker');
    } else if (target === 'currentInput') {
        const input = document.querySelector("textarea.selected")
        if (!input) return
        const text = `:${emojiName}:`
        if (!global.state.previousCursor) global.state.previousCursor = { start: 0, end: 0 }
        input.value = input.value.slice(0, global.state.previousCursor.start) + text + input.value.slice(global.state.previousCursor.end)
        global.state.previousCursor = { start: global.state.previousCursor.start + text.length, end: global.state.previousCursor.start + text.length }
        input.dispatchEvent(new Event('input', { bubbles: true }))
    }
}
window.insertCustomEmoji = insertCustomEmoji


function insertCustomStandardEmoji(event, target, emoji) {
    if (target === 'reaction') {
        const messageId = global.state.reactionPickerTarget;
        toggleReaction(messageId, `standard:${emoji}`);
        closeFM('reaction-picker');
    } else if (target === 'currentInput') {
        const input = document.querySelector("textarea.selected")
        if (!input) return
        if (!global.state.previousCursor) global.state.previousCursor = { start: 0, end: 0 }
        input.value = input.value.slice(0, global.state.previousCursor.start) + emoji + input.value.slice(global.state.previousCursor.end)
        global.state.previousCursor = { start: global.state.previousCursor.start + emoji.length, end: global.state.previousCursor.start + emoji.length }
        input.dispatchEvent(new Event('input', { bubbles: true }))
    }
}
window.insertCustomStandardEmoji = insertCustomStandardEmoji


function toggleReaction(messageId, emoji) {
    const convId = global.state.activeConv;
    if (!convId || !global.convs[convId] || !global.convs[convId].messages[messageId]) return;
    
    xhr(`toggle_reaction?message_id=${messageId}&emoji=${encodeURIComponent(emoji)}`, (e) => {
        if (e.target.status === 200) {
            const response = JSON.parse(e.target.responseText);
            setElement(`global.convs[${global.state.activeConv}].messages[${messageId}].reactions`, response.reactions);
        } else {
             console.error("Failed to toggle reaction");
        }
    }, "POST");
}
window.toggleReaction = toggleReaction;


function renderReactionTooltipText(place, messageId, emoji, voters) {
    const msg = global.convs[place]?.messages?.[messageId];
    if (!msg || !msg.reactions || !msg.reactions[emoji]) return '';

    if (voters.length === 0) return '';
    
    // Show up to 3 names, then 'and X others'
    let displayNames = [];
    let othersCount = 0;
    
    for(let i=0; i < voters.length; i++) {
       const vid = voters[i];
       if (vid === global.user.id) {
           displayNames.push(_t("Vous"));
       } else if (global.users[vid]) {
           displayNames.push(global.users[vid].display);
       } else {
           displayNames.push(`User #${vid}`);
           loadUsers([vid]);
       }
    }
    
    if (displayNames.length > 3) {
        othersCount = displayNames.length - 3;
        displayNames = displayNames.slice(0, 3);
    }
    
    let text = displayNames.join(', ');
    if (othersCount > 0) {
        text += ` ${_t('et')} ${othersCount} ${_t('autres')}`;
    }

    const is_custom = emoji.startsWith('custom:')
    const is_standard = emoji.startsWith('standard:')
    let emojiHtml
    if (is_custom){
        emojiHtml = (() => { const [,sid,eid] = emoji.split(':'); const serv = Object.values(global.servers||{}).find(s=>s.id==sid); const e = serv?.customEmojis?.find(x=>x.id==eid); return e ? `<img src="/static/attachments/${e.file}" style="width:2rem;height:2rem;object-fit:contain">` : ':emoji:' })()
    }else if(is_standard){
        emojiHtml = (() => { const name = emoji.split(':')[2]; const e = CUSTOM_EMOJIS[name]; return e ? `<img src="${e}" style="width:2rem;height:2rem;object-fit:contain">` : ':emoji:' })()
    }else{
        emojiHtml = emoji
    }
    return `<div class="emoji-big">${emojiHtml}</div><div class="voters">${text}</div>`;
}
window.renderReactionTooltipText = renderReactionTooltipText;

function openReactionVoters(place, messageId, emoji) {
    const msg = global.convs[place]?.messages?.[messageId];
    if (!msg || !msg.reactions) return;

    const allReactions = msg.reactions;
    const options = [];
    const votes = {};
    const allVoters = new Set();
    let selectedOptionId = 1;
    let currentId = 1;

    for (const [reactionEmoji, reactionVoters] of Object.entries(allReactions)) {
        if (reactionVoters && reactionVoters.length > 0) {
            options.push({ id: currentId, text: reactionEmoji });
            votes[currentId] = reactionVoters;
            reactionVoters.forEach(voterId => allVoters.add(voterId));

            if (reactionEmoji === emoji) {
                selectedOptionId = currentId;
            }
            currentId++;
        }
    }

    if (options.length === 0) return;

    const data = {
        totalVoters: allVoters.size,
        poll: { question: `${_t('Réactions')}` },
        options: options,
        votes: votes
    };
    
    global.state.pollVotersData = data;
    global.state.pollVotersSelectedOption = selectedOptionId;
    
    openMenu('poll-voters');
    setTimeout(() => {window.renderPollVotersContent();}, 100);
}
window.openReactionVoters = openReactionVoters;

function updatePreview(formID, event, defaultValue, evaluation=undefined){
    if(global.state["currentForm"]?.id !== formID){
        global.state["currentForm"] = undefined
    }

    const save_menu = document.getElementById(formID)
    if(global.state["currentForm"]){
        if(!global.state["currentForm"][event.currentTarget.id] ){
            global.state["currentForm"][event.currentTarget.id] = {value: "", modified :false, defaultValue: eval(defaultValue)}
        }
        if(event.currentTarget.value !== global.state["currentForm"][event.currentTarget.id].value){
            if (event.currentTarget.value === eval(defaultValue)){
                global.state["currentForm"][event.currentTarget.id].value = event.currentTarget.value
                global.state["currentForm"].modified -= 1
                global.state["currentForm"][event.currentTarget.id].modified = false
                if(global.state["currentForm"].modified===0){
                    save_menu.style.display="none"
                }
            }else if(!global.state["currentForm"][event.currentTarget.id].modified){
                global.state["currentForm"][event.currentTarget.id]={value: event.currentTarget.value, modified :true,defaultValue: eval(defaultValue)}
                if(global.state["currentForm"].modified===0){
                    save_menu.style.display="flex"
                }
                global.state["currentForm"].modified += 1
            }else{
                global.state["currentForm"][event.currentTarget.id].value = event.currentTarget.value
            }

            if(evaluation){
                const pre = evaluation.title && event.currentTarget.value!=="" ? evaluation.title : ""
                updateDisplayedForm(event.currentTarget.id, pre.concat(eval(evaluation.value)))
            }else{
                updateDisplayedForm(event.currentTarget.id, event.currentTarget.value)
            }
        }
    }else if (event.currentTarget.value !== eval(defaultValue)){
        console.log(event.currentTarget.value)
        global.state["currentForm"] = { [event.currentTarget.id] : {value: event.currentTarget.value, modified :true, defaultValue: eval(defaultValue)}, modified: 1, id: formID}
        save_menu.style.display="flex"
        if(evaluation){
            const pre = evaluation.title && event.currentTarget.value!=="" ? evaluation.title : ""
            updateDisplayedForm(event.currentTarget.id, pre.concat(eval(evaluation.value)))
        }else{
            updateDisplayedForm(event.currentTarget.id, event.currentTarget.value)
        }
    }
}
window.updatePreview = updatePreview

function makePersonalServer(){
    if(confirm("Are you sure you want to convert this server into your personal server ? \n This action cannot be undone.")){
        const request = xhr("/create_personal_server?server_id="+global.state.currentServer.id , undefined, "POST", false);
        if (request.status === 200) {
        } else {
            alert("Failed to create personal server: " + request.statusText);
        }
    }
}
window.makePersonalServer = makePersonalServer

export function updateDisplayedForm(id,value){
    const subs = document.querySelectorAll(".form-".concat(id))
    for (let sub of subs){
        sub.innerHTML = value
    }
}

function reset(){
    for (let key in global.state["currentForm"]){
        if (key !== "modified" && global.state["currentForm"][key].modified){
            const element = document.getElementById(key)
            element.value = global.state["currentForm"][key].defaultValue
        }
        updateDisplayedForm(key,global.state["currentForm"][key].defaultValue)
    }
    delete global.state["currentForm"]
    const save_menu = document.querySelector(".save-settings")
    save_menu.style.display="none"
}
window.reset = reset


function toggleDropdown(event) {
    if (event.currentTarget.parentElement.classList.contains("show")){
        event.currentTarget.parentElement.classList.remove("show");
        global.state.activeDropdown = undefined
    }else{
        if(global.state.activeDropdown){
            global.state.activeDropdown.classList.remove("show");
        }
        event.currentTarget.parentElement.classList.add("show");
        global.state.activeDropdown = event.currentTarget.parentElement
    }

}
window.toggleDropdown = toggleDropdown

function changeDropdown(event) {
    const dropdown = event.currentTarget.parentElement.parentElement;
    dropdown.querySelector(".dropdown-text").innerText = event.currentTarget.innerText;
    dropdown.querySelector(".selected").classList.remove("selected")
    event.currentTarget.classList.add("selected")
    dropdown.classList.remove("show");
}
window.changeDropdown = changeDropdown

function goToServer(event,id){
    global.state.currentServer = lookFor(id,global.servers)
    global.state.activeConv = undefined
    global.state.isServer = true
    loadServer(id)
    goTo('sec-selector','serverSelector',{'category':'currentTab' ,'event': event},true,()=> {
        if (!restoreLastChannel()) {
            goToChannel(global.state.currentServer.dirs.channels[0].id)
        }
    })

}
window.goToServer = goToServer

function toggleProfileInfo(id,event){
    if (id !== global.state.profileInfo?.id) {
        closeFM()
    }
    setElement("global.state.profileInfo", global.users[id])
    toggleFM('profileInfo')

    const rect = event.currentTarget.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let top = rect.top;
    let left = rect.left + 60;

    const modalRect = global.state.activeFM.getBoundingClientRect();

    if (left + modalRect.width > viewportWidth) {
        if (rect.left - modalRect.width - 10 < 0) {
            left = viewportWidth - modalRect.width - 10;
            left = Math.max(left, 10);
        }else {
            left = rect.left - modalRect.width - 10;
        }

    }

    if (top + modalRect.height > viewportHeight) {
        top = rect.top - modalRect.height;
        if (top < 0) {
            top = Math.max(viewportHeight - modalRect.height - 10, 10); // clamp to bottom edge
        }
    }

    global.state.activeFM.style.top = top + 'px';
    global.state.activeFM.style.left = left + 'px';

}
window.toggleProfileInfo = toggleProfileInfo

function showAddRole(event){
    const elt = document.getElementById("addRole")
    elt.style.display = "flex"
    elt.style.bottom = window.innerHeight - event.currentTarget.getBoundingClientRect().top + 10 + "px"
    elt.style.left = event.currentTarget.getBoundingClientRect().left + "px"
}
window.showAddRole = showAddRole
