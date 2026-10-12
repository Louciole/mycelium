import {getRelevantUser} from "./main.mjs"
import {
    addElement,
    deleteElement,
    deleteElementDict,
    setElement,
    difference,
    pushElement,
    deleteVal,
    updateElement
} from "./framework/vesta.mjs"
import {initWebSockets} from "./framework/websockets.mjs"
import global from "./framework/global.mjs"
import {xhr} from "./framework/templating.mjs";
import {goTo, initNavigation, closeFM} from "./framework/navigation.mjs";
import imageEditor, { emojiImageEditor } from "/static/imageEditor.mjs"
import {initActivity} from "./activity.mjs";
import {isSystemMessage} from "./system-messages.mjs";
import {getForumViewPrefs} from "./forumPrefs.mjs";

function changeUsername(){
    const input = document.getElementById("username-input")

    const regex = /^(?=.{3,}$)[a-zA-Z0-9_\-\.]*$/;
    if (!regex.test(input.value)) {
        input.setCustomValidity("Invalid username. It must be at least 2 characters in letters, numbers, '_', '-', and '.'.");
        input.reportValidity()
        return
    } else {
        input.setCustomValidity("");
    }

    const onload = function() { // request successful
        setElement('global.user.username', input.value)
        closeMenu('#change-username')
    };
    xhr("/change_username?value=".concat(input.value),onload,"POST")
}
window.changeUsername = changeUsername

function openCreateServer(){
    // The modal lives in main.html (static, no templating): reset the name
    // field and translate its placeholder on every opening.
    const input = document.getElementById('create-server-name')
    input.value = ''
    input.placeholder = _t('nom du serveur')
    openMenu('create-server')
}
window.openCreateServer = openCreateServer

function newServer(){
    // Empty name → the backend falls back to "New Server".
    const name = document.getElementById('create-server-name').value.trim()
    let request = new XMLHttpRequest();
    request.open('POST', "create_server?name=" + encodeURIComponent(name), true);
    request.onload = function() {
        // Refresh the whole list from get_user_servers so the new server
        // arrives fully populated (name, owner, customEmojis, …). Building a
        // partial object client-side leaves `owner` unset, which makes
        // checkServRights() deny every admin action, and a missing `name`
        // crashes the icon renderer (getSlug).
        loadServers()
    };

    request.onerror = function() {
        console.log("request failed")
    };
    request.send();
    closeMenu('#create-server')
}
window.newServer = newServer

export function loadServers(){
    const onload = function() {
        const response = JSON.parse(this.responseText)
        // global.servers is a dict keyed by server id (every writer uses
        // global.servers[id] = ...). get_user_servers returns an array, so
        // re-key it here — keeping it as an array makes id-indexed writes
        // create phantom duplicate entries.
        const servers = {}
        for (const s of response) servers[s.id] = s
        global.servers = servers
        setElement(`global.servers`, servers)
    };
    xhr("get_user_servers",onload)
}

export function loadConvs(renderOnly = false){
    // Paint the DM sidebar from whatever is in global.convs/privateConvs.
    const render = function() {
        updateElement("global.convs")
        // Don't clobber sec-column when the user is browsing a server — the
        // server selector is already there and this async callback would race it.
        // Same for the discover page, which owns sec-selector while it is open.
        if (global.state.isServer || document.getElementById('discover-nav')) return
        goTo('sec-column',"column-perso",undefined, true,()=>{goTo('sec-selector',"privateMessage")})
    }

    // Offline (or an explicit local-first paint from a snapshot): the convs are
    // already in global — just render them, never fetch. Without this the list
    // never paints offline, since the network onload below never fires.
    if (global.state.offline || renderOnly) {
        render()
        return
    }

    const onload = function() {
        const keys = JSON.parse(this.responseText)
        const liveIds = new Set(keys.map(k => k.id.toString()))
        for(let key of keys){
            // Merge into the existing object instead of replacing it: this response
            // lands asynchronously at boot, possibly after the conv was already opened
            // (hash route, click on the snapshot paint) — replacing it would drop its
            // loaded messages/messageGroups and the next send would crash.
            // (ids are unique across convs and channels: their tables share one sequence)
            const conv = global.convs[key.id] ? Object.assign(global.convs[key.id], key) : key
            global.privateConvs[key.id] = conv // HACK
            global.convs[key.id] = conv
            // The open conv's call state comes from loadCallState(); the others' may be a stale snapshot
            if (String(key.id) !== String(global.state.activeConv)) conv.ongoingCall = null
            addElement("global.privateConvs", conv);
            loadUsers(conv.members)
        }

        // Prune ghosts: a DM left/deleted on another client lingers in the
        // snapshot otherwise — we overwrite returned ids but never drop the ones
        // the server stopped returning. Key off privateConvs (DMs only); channel
        // content also lives in global.convs under channel ids, and a channel may
        // share a conv's numeric id, so only clear the convs mirror when it's the
        // very object we set for this DM.
        for (const id of Object.keys(global.privateConvs)) {
            if (liveIds.has(id.toString())) continue
            const ghost = global.privateConvs[id]
            deleteElementDict("global.privateConvs", id)
            if (global.convs[id] === ghost) deleteElementDict("global.convs", id)
        }

        render()
    };
    xhr("get_user_convs",onload)
}

export function bumpConvActivity(convId){
    const conv = global.privateConvs[convId]
    if (!conv) return
    let max = ''
    for (const c of Object.values(global.privateConvs)) {
        const v = String(c.last_activity || '')
        if (v > max) max = v
    }
    conv.last_activity = max + '~'
    updateElement('global.privateConvs')
}
window.bumpConvActivity = bumpConvActivity

export function loadUsers(keys, force = false){
    // Offline: the cached / snapshotted profiles are all we have. Never hit the
    // network (the sync XHR below would just fail and stall the boot).
    if (global.state.offline) return


    const toLoad = force
        ? Array.from(new Set(keys.map(k => k.toString())))
        : difference(keys, global.users)

    if (toLoad.length === 0){
        return
    }

    const onload = function() {
        const users = JSON.parse(this.responseText)
        for(let user of users){
            global.users[user.id] = user
        }
    };
    // Kept synchronous: callers such as getConvName() read global.users[...] on
    // the very next line and rely on the value being present.
    xhr("get_users_info?users="+JSON.stringify(toLoad), onload, "GET",false)
}
window.loadUsers = loadUsers

export function refreshUsers(){
    if (global.state.offline) return
    const selfId = String(global.user?.id)
    const ids = Object.keys(global.users).filter(id => id !== selfId)
    if (ids.length === 0) return
    loadUsers(ids, true)
    // Re-paint the surfaces that read display names out of the now-fresh cache.
    updateElement('global.user.friends')
    updateElement('global.convs')
}
window.refreshUsers = refreshUsers

export function loadConv(key){
    // Offline: the snapshot already holds this conv's processed messageGroups.
    // Skip the (synchronous) fetch so it can't throw or overwrite cached state.
    if (global.state.offline) return

    const onload = function() {
    };

    const request = xhr("get_conv_content?conv_id="+JSON.stringify(key), onload, "GET",false)
    if (!request.responseText) return
    const elements = JSON.parse(request.responseText)
    elements.attachments = elements.attachments ? JSON.parse(elements.attachments) : []
    for(let element in elements){
        global.convs[key][element] = elements[element]
    }

    let prev = null
    global.convs[key].messageGroups = []

    const messagesArray = global.convs[key].messages || []
    global.convs[key].messages = {}  // Source of truth: all messages by ID

    for(let message of messagesArray){
        message.body = message.body.replace(/</g, "&lt;")
        if (typeof message.attachments === 'string') {
            try { message.attachments = JSON.parse(message.attachments) } catch(e) { message.attachments = [] }
        }
        if (!message.attachments) message.attachments = []

        // si ça fait moins de 3 minutes de différence, que c'est la même personne et que la date n'a pas changée et que le message n'est pas une réponse
        global.convs[key].messages[message.id] = message

        // Group consecutive messages from same sender
        if(canGroupWith(prev, message)){
            global.convs[key].messageGroups[global.convs[key].messageGroups.length-1].messages.push(message)
        }else{
            newMessageGroup(key, message)
        }
        prev = message
    }
}

export function loadChan(key){
    // Offline: keep the snapshotted channel state; the fetch+reset below would
    // wipe it and throw on a synchronous network error.
    if (global.state.offline) return

    const onload = function() {
    };

    const request = xhr("get_chan_content?channel_id="+JSON.stringify(key), onload, "GET",false)
    const elements = JSON.parse(request.responseText)
    elements.attachments = elements.attachments ? JSON.parse(elements.attachments) : []

    global.convs[key] = {}
    for(let element in elements){
        global.convs[key][element] = elements[element]
    }

    let prev = null
    global.convs[key].messageGroups = []

    // Convert messages array to dict
    const messagesArray = global.convs[key].messages || []
    global.convs[key].messages = {}  // Source of truth: all messages by ID

    for(let message of messagesArray){
        message.body = message.body.replace(/</g, "&lt;")
        if (typeof message.attachments === 'string') {
            try { message.attachments = JSON.parse(message.attachments) } catch(e) { message.attachments = [] }
        }
        if (!message.attachments) message.attachments = []

        global.convs[key].messages[message.id] = message

        // Group consecutive messages - messageGroups contain REFERENCES to messages dict objects
        if(canGroupWith(prev, message)){
            global.convs[key].messageGroups[global.convs[key].messageGroups.length-1].messages.push(message)
        }else{
            newMessageGroup(key, message)
        }
        prev = message
    }
}

export function loadNote(key){
    const onload = function() {
        import("./workspaces/notes.mjs").then(()=>{
            global.state.noteEditor = new NoteEditor()
            goTo('content','server-note-content',undefined,false)
        })
    };

    // Offline: render the snapshotted note (if any) without fetching.
    if (global.state.offline) {
        if (global.notes[key]) onload()
        return
    }

    const request = xhr("get_note_content?channel_id="+JSON.stringify(key), onload, "GET",false)
    const elements = JSON.parse(request.responseText)

    global.notes[key] = {}
    for(let element in elements){
        global.notes[key][element] = elements[element]
    }

    // Convert array to dict
    const blocksArray = global.notes[key].blocks || []
    global.notes[key].blocks = {}

    for(let block of blocksArray){
        global.notes[key].blocks[block.uuid] = block

    }
}

/** Fetches a forum's metadata + posts into global.forums (no navigation). */
export function fetchForum(key){
    const request = xhr("get_forum_content?channel_id="+JSON.stringify(key), function(){}, "GET", false)
    if (request.status !== 200) return null
    const elements = JSON.parse(request.responseText)

    if (!global.forums) global.forums = {}
    const prev = global.forums[key] || {}
    const prefs = getForumViewPrefs(key)
    global.forums[key] = {
        id: key,
        name: elements.name,
        available_tags: elements.available_tags || [],
        guidelines: elements.guidelines,
        require_tag: !!elements.require_tag,
        is_private: elements.is_private,
        posts: elements.posts || [],
        default_layout: elements.default_layout || "list",
        default_sort: elements.default_sort || "activity",
        layout: prefs.layout || elements.default_layout || "list",
        sort: prefs.sort || elements.default_sort || "activity",
        tagFilter: prev.tagFilter ?? null,
        search: "",
        guidelinesClosed: prev.guidelinesClosed || false,
    }
    return global.forums[key]
}

export function loadForum(key){
    // Offline: show the snapshotted forum (if any) without fetching.
    if (global.state.offline) {
        if (global.forums?.[key]) goTo('content','server-forum-content',undefined,false)
        return
    }

    if (!fetchForum(key)) return
    setElement("global.forums["+key+"]", global.forums[key])
    goTo('content','server-forum-content',undefined,false)
}

export function loadForumPost(postId){
    // Offline: reopen the snapshotted post (if any) without fetching.
    if (global.state.offline) {
        if (global.convs?.[postId]?.messageGroups) {
            global.state.activeConv = postId
            goTo('content','server-forum-post',undefined,false)
        }
        return
    }

    const request = xhr("get_forum_post?post_id="+JSON.stringify(postId), function(){}, "GET", false)
    const elements = JSON.parse(request.responseText)

    global.state.activeConv = postId
    global.convs[postId] = {
        id: postId,
        name: elements.title,
        forum: elements.forum,
        title: elements.title,
        tags: elements.tags || [],
        author: elements.author,
        pinned: elements.pinned,
        locked: elements.locked,
        created_at: elements.created_at,
    }

    let prev = null
    global.convs[postId].messageGroups = []

    const messagesArray = elements.messages || []
    global.convs[postId].messages = {}  // Source of truth: all messages by ID

    for(let message of messagesArray){
        message.body = message.body.replace(/</g, "&lt;")
        if (typeof message.attachments === 'string') {
            try { message.attachments = JSON.parse(message.attachments) } catch(e) { message.attachments = [] }
        }
        if (!message.attachments) message.attachments = []

        global.convs[postId].messages[message.id] = message

        if(canGroupWith(prev, message)){
            global.convs[postId].messageGroups[global.convs[postId].messageGroups.length-1].messages.push(message)
        }else{
            newMessageGroup(postId, message)
        }
        prev = message
    }

    goTo('content','server-forum-post',undefined,false)
    window.updateComposerLock?.()   // timeout / read-only forum (moderation.mjs)
}

export function createForumPost(forumId, title, content, tags=[], attachments=[]){
    const body = {title, content, tags, attachments}
    const request = xhr("create_forum_post?forum_id="+JSON.stringify(forumId), function(){}, "POST", false, body)
    // Errors (tag required, timeout, quota...) come back as plain text: surface them to the caller
    if (request.status !== 200) throw new Error(request.responseText || String(request.status))
    const resp = JSON.parse(request.responseText)
    const post = resp.post
    if (global.forums && global.forums[forumId]) {
        global.forums[forumId].posts.unshift(post)
        setElement("global.forums["+forumId+"].posts", global.forums[forumId].posts)
    }
    return post
}

export function editForumPost(postId, action, value){
    let url = "edit_forum_post?post_id="+JSON.stringify(postId)+"&action="+action
    if (value !== undefined) url += "&value="+encodeURIComponent(typeof value === "string" ? value : JSON.stringify(value))
    const request = xhr(url, function(){}, "POST", false)
    return JSON.parse(request.responseText)
}

export function editForumTags(forumId, action, tag=null, tagId=null){
    let url = "edit_forum_tags?forum_id="+JSON.stringify(forumId)+"&action="+action
    if (tag !== null) url += "&tag="+encodeURIComponent(JSON.stringify(tag))
    // Tag ids are uuids: send them raw (JSON.stringify quoted them, so edit/remove matched nothing)
    if (tagId !== null) url += "&tagId="+encodeURIComponent(tagId)
    const request = xhr(url, function(){}, "POST", false)
    const resp = JSON.parse(request.responseText)
    if (global.forums && global.forums[forumId]) {
        global.forums[forumId].available_tags = resp.available_tags
        setElement("global.forums["+forumId+"].available_tags", resp.available_tags)
    }
    return resp
}

export function editForumSettings(forumId, field, value){
    const url = "edit_forum_settings?forum_id="+JSON.stringify(forumId)+"&field="+field+"&value="+encodeURIComponent(value)
    const request = xhr(url, function(){}, "POST", false)
    return JSON.parse(request.responseText)
}

export function loadUser(){
    let request = new XMLHttpRequest();
    request.open('POST', "/get_user_info", true);
    request.onload = function() { // request successful

        const response = JSON.parse(request.responseText)
        for (let key in response){
            global.user[key] = response[key]
        }
        updateElement('global.user', global.user)

        global.users[global.user.id] = global.user
        loadConvs()
        initWebSockets()
        initActivity()
    };

    request.onerror = function() {
        console.log("request failed")
    };

    request.send();
}

function friend(action, element, event = undefined){
    //element is the id of the invitation for an accept or the username for an add

    const effect = function() {
        if (action !== "add"){
            return
        }

        const status = document.querySelector(".add .status")
        const search= document.querySelector(".add .search")

        const res = JSON.parse(this.responseText)
        if(res.status === "ok"){
            status.classList.add("succeed")
            status.classList.remove("failed")
            search.classList.add("succeed")
            search.classList.remove("failed")
            status.innerHTML = "Well done ! Your friend request has been sent !"
        }else{
            status.classList.remove("succeed")
            status.classList.add("failed")
            search.classList.remove("succeed")
            search.classList.add("failed")
            status.innerHTML = res.error
        }
    };

    if(action === "add"){
        const domElt= document.getElementById(element)
        xhr("add_friend?username=".concat(encodeURIComponent(domElt.value)),effect)
    }else if(action === "accept"){
        const invitationId = element
        const onAccept = function() {
            let res
            try { res = JSON.parse(this.responseText) } catch(e){ return }
            if (res.status !== "ok") return

            const idx = global.user.invitations.findIndex(inv => inv.id === invitationId)
            if (idx === -1) return

            const accepted = global.user.invitations[idx]
            accepted.accepted = true
            accepted.private = true
            accepted.conv = res.conv
            pushElement("global.user.friends", accepted)
            deleteElement("global.user.invitations", idx)
        }
        xhr("accept_friend?invitation_id=".concat(invitationId), onAccept)
    }else if(action === "remove"){
        element = lookFor(element.getAttribute("data-id"),global.user.friends)
        if (confirm("Do you really want to remove ".concat(global.users[getRelevantUser(element)].display," from your friends ?"))){
            const remEffect = function(){
                deleteElement("global.user.friends",element)
            }
            xhr("remove_friend?friendship_id=".concat(element.id),remEffect)
            closeFM()
        }
    }else if(action === "removeYES"){
        if (element.confirm){
            if (! confirm("Do you really want to remove ".concat(global.users[element.id].display," from your friends ?"))){
                return
            }
        }

        for (let friendship in global.user.friends) {
            if (getRelevantUser(friend) === element.id) {
                const remEffect = function () {
                    deleteElement("global.user.friends", element.id)
                }
                xhr("remove_friend?friendship_id=".concat(element.id), remEffect)
                break
            }
        }
    }
    else{
        // Map old action names to new endpoints
        const endpointMap = {"get": "get_friends", "getBlocked": "get_blocked", "invitations": "get_friend_invitations"};
        const endpoint = endpointMap[action] || action;
        xhr(endpoint,effect)
    }
}
window.friend = friend

// this function should be used only in non performance critical cases
export function lookFor(element, array){
    for(let i in array){
        if(array[i].id.toString() == element){
            return array[i]
        }
    }
}

function getLastMessage(convId) {
    const groups = global.convs[convId]?.messageGroups
    if (!groups || groups.length === 0) return null
    const lastGroup = groups[groups.length - 1]
    if (!lastGroup.messages || lastGroup.messages.length === 0) return null
    return lastGroup.messages[lastGroup.messages.length - 1]
}

/**
 * Create a new message group
 * @param {number} conv - Conversation ID
 * @param {object} message - Message object (reference will be stored, not a copy)
 */
function newMessageGroup(conv, message){
    global.convs[conv].messageGroups.push({
        "date": getTimeStr(message.timestamp, { locale: "fr-FR",hour: undefined, minute: undefined}),
        "messages":[message],  // Array of REFERENCES to message objects
        "id":global.convs[conv].messageGroups.length
    })
}

/**
 * Whether `message` joins the group `prev` belongs to: same sender, < 3 min
 * apart, same day, not a reply. System notices always stand alone.
 */
function canGroupWith(prev, message){
    if (!prev || isSystemMessage(prev) || isSystemMessage(message)) return false
    const day = ts => getTimeStr(ts, { locale: "fr-FR",hour: undefined, minute: undefined})
    return message.sender === prev.sender
        && (new Date(message.timestamp)-new Date(prev.timestamp))/60000<3
        && day(message.timestamp) === day(prev.timestamp)
        && !message.reply
}

/**
 * Handle grouping of a new message
 * Groups consecutive messages from the same sender within 3 minutes
 * @param {object} message - Message object to group
 */
export function handleMessageGroup(message){
    console.log("handleMessageGroup",message)
    if (typeof message.attachments === 'string') {
        try { message.attachments = JSON.parse(message.attachments) } catch(e) { message.attachments = [] }
    }
    if (!message.attachments) message.attachments = []

    if(canGroupWith(getLastMessage(message.place), message)){
        // Add reference to existing group
        global.convs[message.place].messageGroups[global.convs[message.place].messageGroups.length-1].messages.push(message)
    }else{
        newMessageGroup(message.place, message)
    }
}

export function sendTyping(){
    if(global.settings.silent_typing === undefined){
        global.settings.silent_typing = false
    }

    console.log("send typing",global.state.lastTyping)
    if( !global.settings.silent_typing && (!global.state.lastTyping || global.state.lastTyping+5000 < new Date().valueOf())){
        const message = {"type" : 'typing', "clientID": global.state.clientID, "conv": global.state.activeConv};
        global.state.lastTyping = new Date().valueOf()
        global.state.websocket.send(JSON.stringify(message))
    }
}

function changeStatus(mode){
    const default_msg = {"0":"Online","1":"Idle","2":"Do not Disturb","3":"Offline"}
    const status = {"mode":mode,"text": global.user.status.text !== default_msg[global.user.status.mode]?global.user.status.text:null, "emoji": global.user.status.emoji?global.user.status.emoji:null, "expiration":global.user.status.expiration?global.user.status.expiration:null}

    const onload = function() { // request successful
        const default_icons = {"0":"green","1":"orange","2":"RED","3":"spymode"}

        status.text = status.text?status.text:default_msg[status.mode]
        status.icon = status.icon?status.icon:default_icons[status.mode]
        setElement('global.user.status', status)
        closeMenu('#custom-status')
    };
    xhr("/change_status?value=".concat(JSON.stringify(status)),onload,"POST")
}
window.changeStatus = changeStatus

function setCustomStatus(){
    const input = document.getElementById("input-status")
    const modeDrop = document.getElementById("drop-status-mode").querySelector(".selected")
    const expDrop = document.getElementById("drop-status-exp").querySelector(".selected")

    const now = new Date()
    const brusselsOffset = -now.getTimezoneOffset() * 60 * 1000; // Negative offset for CET/CEST

    const hour = new Date(now.getTime() + brusselsOffset)
    hour.setHours(hour.getHours() + 1)

    const hours = new Date(now.getTime() + brusselsOffset)
    hours.setHours(hours.getHours() + 4)

    const half = new Date(now.getTime() + brusselsOffset)
    half.setMinutes(half.getMinutes() + 30)

    const tomorrow = new Date(now.getTime() + brusselsOffset)
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(0, 0, 0, 0)

    const exps = [tomorrow,hours,hour,half]
    const exp = expDrop.getAttribute("data-value") != 4 ? exps[expDrop.getAttribute("data-value")] : null

    const status = {"mode":modeDrop.getAttribute("data-value"),"text": input.value, "emoji":global.user.status.emoji,"expiration":exp}

    const onload = function() { // request successful
        const default_icons = {"0":"green","1":"orange","2":"RED","3":"spymode"}

        status.text = status.text?status.text:getDefaultMessage(status.mode)
        status.icon = status.icon?status.icon:default_icons[status.mode]
        setElement('global.user.status', status)
        closeMenu('#custom-status')
    };
    xhr("/change_status?value=".concat(JSON.stringify(status)),onload,"POST")
}
window.setCustomStatus = setCustomStatus

function getDefaultMessage(mode){
    const default_msg = {"0":"Online","1":"Idle","2":"Do not Disturb","3":"Offline"}
    return default_msg[mode]
}
window.getDefaultMessage = getDefaultMessage

function blockUser(id){
    const effect = function() {
        const response = JSON.parse(this.responseText)
        if(response.status === "ok"){
            friend('removeYES', {"id":id})
            addElement("global.user.blocked",{"id":response.id, "blocked":id})
        }
    };

    xhr("block_user?user_id=".concat(id),effect)
}
window.blockUser = blockUser

function initPendingMembers(){
    if (!global.state.pendingConvMembers[global.state.activeConv]){
        global.state.pendingConvMembers[global.state.activeConv] = global.convs[global.state.activeConv].members
    }
    return ""
}
window.initPendingMembers = initPendingMembers

function addPendingUser(event, id){
    console.log("addPendingUser",global.state.pendingConvMembers[global.state.activeConv])
    if (event.currentTarget.checked) {
        if (global.state.pendingConvMembers[global.state.activeConv].length >= 10){
            event.currentTarget.checked = false
            return
        }
        pushElement("global.state.pendingConvMembers[" + global.state.activeConv + "]", id)
        if (global.state.pendingConvMembers[global.state.activeConv].length > 2){
            const btn = document.getElementById("createConvBtn")
            btn.classList.remove("disabled")
        }
    }else {
        deleteVal("global.state.pendingConvMembers[" + global.state.activeConv + "]", id)
        if (global.state.pendingConvMembers[global.state.activeConv].length <= 2){
            const btn = document.getElementById("createConvBtn")
            btn.classList.add("disabled")
        }
    }
    console.log(global.state.pendingConvMembers[global.state.activeConv])
}
window.addPendingUser = addPendingUser

function filterFriendList(event) {
    const query = event.target.value.toLowerCase()
    document.querySelectorAll('#add-users .scrollable .space-between').forEach(row => {
        const username = row.querySelector('.username')?.textContent?.toLowerCase() || ''
        const name = row.querySelector('.name')?.textContent?.toLowerCase() || ''
        row.style.display = (username.includes(query) || name.includes(query)) ? '' : 'none'
    })
}
window.filterFriendList = filterFriendList

function createConv(event){
    if (event.currentTarget.classList.contains("disabled")){
        return
    }

    let selfId
    for(let i in global.state.pendingConvMembers[global.state.activeConv]){
        if(global.state.pendingConvMembers[global.state.activeConv][i] === global.user.id){
            selfId = i
            break
        }
    }

    global.state.pendingConvMembers[global.state.activeConv].splice(selfId,1)
    const members = global.state.pendingConvMembers[global.state.activeConv]
    const conv = {"name":"New Conversation","members":members,"messageGroups":[],"messages":{},"private":false}

    const onload = function() {
        const res = JSON.parse(this.responseText)
        conv.id = res.id
        global.convs[conv.id] = conv
        global.privateConvs[conv.id] = conv
        addElement("global.privateConvs", conv)
        closeMenu("#add-users")
    };
    xhr("create_conv?name=".concat(conv.name,"&members=",JSON.stringify(conv.members)),onload)
}
window.createConv = createConv

function renameConv(event,id){
    if (event.currentTarget.value.length < 1 || event.currentTarget.value.trim() === global.convs[id].name){
        return
    }

    const name = event.currentTarget.value.trim()
    console.log("renameConv",id,event.currentTarget)
    const onload = function() { // request successful
        setElement('global.convs['+id+'].name', name)
    };
    xhr("/edit_conv?element=name&value=".concat(name,"&conv_id=",id),onload,"POST")
}
window.renameConv = renameConv

function dropImage(event) {
    event.preventDefault();
    event.currentTarget.classList.remove('dragging');

    const files = event.dataTransfer.files;
    if (files.length > 0) {
        const file = files[0];
        handleImageUpload(file);
    }
}
window.dropImage = dropImage

// Max file size: 50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024

function dropFileMessage(event) {
    event.preventDefault()
    document.querySelector('.dragging').classList.remove('dragging')

    const files = event.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
        displayMessageAttachment(files[i])
    }
}
window.dropFileMessage = dropFileMessage

function pasteFileMessage(event) {
    const items = event.clipboardData?.items;
    if (!items) return;

    // Iterate through clipboard items and handle files (images and others)
    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // Handle images
        if (item.type.indexOf('image') !== -1) {
            const file = item.getAsFile();
            if (file) {
                displayMessageAttachment(file);
            }
        }
        // Handle other files (kind === 'file' but not image)
        else if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) {
                displayMessageAttachment(file);
            }
        }
    }
}
window.pasteFileMessage = pasteFileMessage

/**
 * Open image resize menu and initialize editor
 * @param {File} file - Image file to edit
 * @param {number} cropRatio - Crop ratio (1 = square, 3 = banner)
 * @param {boolean} isCircle - Whether to use a circular crop overlay
 */
function uploadResizeFile(file, cropRatio = 1, isCircle = false) {
    openMenu("resize-image", false)

    // Reset zoom slider
    const slider = document.querySelector('#resize-image input[type="range"]')
    if (slider) slider.value = 1

    imageEditor.init(file, cropRatio, isCircle).catch(err => {
        console.error("Failed to load image:", err)
        closeMenu('#resize-image')
    })
}
window.uploadResizeImage = uploadResizeFile

/**
 * Show storage quota exceeded alert
 */
function showQuotaExceeded(targetType) {
    if (targetType === 'user') {
        alert(_t("Your personal storage is full (15 GB). Please delete some files or upgrade your plan to upload more."))
    } else {
        alert(_t("This server's storage is full (5 GB). Please delete some files or upgrade the server's storage plan."))
    }
}
window.showQuotaExceeded = showQuotaExceeded

/**
 * Handle 413 quota exceeded response from server
 * @param {XMLHttpRequest} response
 * @returns {boolean} true if quota was exceeded
 */
function handleQuotaError(response) {
    if (response.status === 413) {
        try {
            const err = JSON.parse(response.responseText)
            showQuotaExceeded(err.target_type || 'server')
        } catch(e) {
            showQuotaExceeded('server')
        }
        return true
    }
    return false
}
window.handleQuotaError = handleQuotaError

/**
 * Display attachment preview (image or file) in the message box
 * @param {File} file - File to display
 */
function displayMessageAttachment(file) {
    // Check file size
    if (file.size > MAX_FILE_SIZE) {
        alert(`File "${file.name}" is too large. Maximum size is 50MB.`)
        return
    }

    pendingAttachments() // drop leftovers from a view that is gone
    const reader = new FileReader();
    const box = document.getElementById("imageBox")
    global.state.attachmentsBox = box
    box.style.display = "block"

    const isImage = file.type.startsWith('image/')

    reader.onload = function(e) {
        // Initialize array if needed
        if (!global.state.currentMessageAttachments) {
            global.state.currentMessageAttachments = []
        }

        // Store attachment metadata
        const attachment = {
            dataUrl: reader.result,
            name: file.name,
            type: file.type,
            isImage: isImage
        }
        global.state.currentMessageAttachments.push(attachment)

        // Render preview
        renderAttachmentPreviews()
    }
    reader.readAsDataURL(file);
}
window.displayMessageAttachment = displayMessageAttachment

/**
 * Render all attachment previews in the imageBox
 */
function renderAttachmentPreviews() {
    const box = document.getElementById("imageBox")
    const container = box.querySelector('.attachments-container')
    if (!container) return
    if (window.updateSendButton) updateSendButton()

    container.innerHTML = ''

    const attachments = global.state.currentMessageAttachments || []
    attachments.forEach((attachment, index) => {
        const wrapper = document.createElement('div')
        wrapper.className = 'attachment-preview'

        if (attachment.isImage) {
            // Image preview - square canvas like original displayMessageImage
            const canvas = document.createElement('canvas')
            canvas.className = 'imageCanvas'
            const ctx = canvas.getContext('2d')
            const img = new Image()
            img.onload = function() {
                // Square canvas based on the larger dimension
                const size = Math.max(img.width, img.height)
                canvas.width = size
                canvas.height = size
                // Center the image
                const x = (size - img.width) / 2
                const y = (size - img.height) / 2
                ctx.drawImage(img, x, y, img.width, img.height)
            }
            img.src = attachment.dataUrl
            wrapper.appendChild(canvas)
        } else {
            // File preview
            const filePreview = document.createElement('div')
            filePreview.className = 'file-preview'

            const icon = document.createElement('img')
            icon.className = 'icon'
            icon.src = '/static/icons/material/paperclip.svg'

            const fileName = document.createElement('span')
            fileName.className = 'file-name'
            fileName.textContent = attachment.name.length > 20
                ? attachment.name.substring(0, 17) + '...'
                : attachment.name

            filePreview.appendChild(icon)
            filePreview.appendChild(fileName)
            wrapper.appendChild(filePreview)
        }

        // Delete button
        const menu = document.createElement('div')
        menu.className = 'imageMenu'
        menu.innerHTML = `
            <div class="icon-wrapper" onclick="removeAttachment(${index})">
                <img class="icon" src="/static/icons/material/trash.svg"/>
            </div>
        `
        wrapper.appendChild(menu)

        container.appendChild(wrapper)
    })
}
window.renderAttachmentPreviews = renderAttachmentPreviews

/**
 * Remove a specific attachment by index
 * @param {number} index - Index of attachment to remove
 */
function removeAttachment(index) {
    if (!global.state.currentMessageAttachments) return

    global.state.currentMessageAttachments.splice(index, 1)

    if (global.state.currentMessageAttachments.length === 0) {
        removeAllAttachments()
    } else {
        renderAttachmentPreviews()
    }
}
window.removeAttachment = removeAttachment

/**
 * Attachments waiting to be sent. They belong to the #imageBox they were added in: once that
 * box has left the DOM (the user switched channel / closed the forum composer's view) they are
 * stale and dropped, instead of riding along with the next message sent elsewhere.
 */
export function pendingAttachments() {
    if (global.state.attachmentsBox && !global.state.attachmentsBox.isConnected) {
        global.state.currentMessageAttachments = []
        global.state.attachmentsBox = undefined
    }
    return global.state.currentMessageAttachments || []
}
window.pendingAttachments = pendingAttachments

/**
 * Remove all attachments and hide the box
 */
function removeAllAttachments() {
    const box = document.getElementById("imageBox")
    box.style.display = "none"
    global.state.currentMessageAttachments = []
    if (window.updateSendButton) updateSendButton()
}
window.removeAllAttachments = removeAllAttachments

/**
 * Open banner editor with file picker (opens loadImage menu directly)
 */
function openBannerEditor() {
    global.state.uploadImage = "banner" // Flag for upload target
    openMenu('loadImage', false)
}
window.openBannerEditor = openBannerEditor

/**
 * Handle image upload from loadImage menu (detects banner vs pfp)
 */
function handleImageUpload(file) {
    if (!file) return

    const isBanner = global.state.uploadImage === "banner"
    const cropRatio = isBanner ? 3 : 1 // 3:1 for banners, 1:1 for avatars
    const isCircle = !isBanner // avatars are round, banners are rectangular

    uploadResizeFile(file, cropRatio, isCircle)
}
window.handleImageUpload = handleImageUpload

function uploadConvPfp(convId) {
    global.state.uploadImage = "convPfp"
    global.state.uploadConvId = convId
    openMenu('loadImage', false)
}
window.uploadConvPfp = uploadConvPfp

function uploadProfileImage(field="pfp"){
    const isBanner = global.state.uploadImage === "banner"
    const isConvPfp = global.state.uploadImage === "convPfp"
    const outputSize = isBanner ? 600 : 256

    imageEditor.getCroppedImageData(outputSize).then(result => {
        const onload = function () {
            if (handleQuotaError(this)) return
            if (global.state.uploadImage === "serverAvatar") {
                global.state.uploadImage = ""
                try {
                    const response = JSON.parse(this.responseText)
                    if (response.pfp) {
                        setElement('global.state.currentServer.pfp', response.pfp)
                        updateElement("global.servers")
                    }
                } catch (e) {
                    console.error("Failed to parse server pfp response:", e)
                }
            } else if (isConvPfp) {
                global.state.uploadImage = ""
                try {
                    const response = JSON.parse(this.responseText)
                    if (response.pfp) {
                        setElement('global.convs[' + global.state.uploadConvId + '].pfp', response.pfp)
                        setElement('global.privateConvs[' + global.state.uploadConvId + '].pfp', response.pfp)
                    }
                } catch (e) {
                    console.error("Failed to parse conv pfp response:", e)
                }
            } else if (isBanner) {
                global.state.uploadImage = ""
                try {
                    const response = JSON.parse(this.responseText)
                    if (response.banner) {
                        setElement('global.user.banner', response.banner)
                    }
                } catch (e) {
                    console.error("Failed to parse banner response:", e)
                }
            } else {
                try {
                    const response = JSON.parse(this.responseText)
                    if (response.pfp) {
                        setElement('global.user.pfp', response.pfp)
                    }
                } catch (e) {
                    console.error("Failed to parse user pfp response:", e)
                }
            }
        }

        if (global.state.uploadImage === "serverAvatar"){
            xhr("edit_server_property?property=pfp&server_id=".concat(global.state.currentServer.id), onload,"POST",true,{"value":result})
        } else if (isConvPfp) {
            xhr("change_conv_pfp?conv_id=".concat(global.state.uploadConvId), onload,"POST",true,{"value":result})
        } else if (isBanner) {
            xhr("change_banner", onload,"POST",true,{"value":result})
        } else {
            xhr("change_pfp", onload,"POST",true,{"value":result})
        }
        closeMenu('#resize-image')
        closeMenu('#loadImage')
    }).catch(err => {
        console.error("Failed to crop image:", err)
    })
}
window.uploadProfileImage = uploadProfileImage

// ── Custom emoji upload ────────────────────────────────────────────────────

// Expose emoji editor controls to HTML onclick handlers
window.emojiEditorStartDrag = (event) => emojiImageEditor.startDrag(event)
window.emojiEditorZoom = (value) => { emojiImageEditor.zoom(value); updateEmojiPreview() }

function openEmojiUploadMenu() {
    document.getElementById('emojiFileInput').click()
}
window.openEmojiUploadMenu = openEmojiUploadMenu

function handleEmojiImageUpload(file) {
    if (!file) return
    const defaultName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'emoji'

    openMenu("emoji-upload", false)

    requestAnimationFrame(() => {
        const slider = document.querySelector('#emoji-upload input[type="range"]')
        if (slider) slider.value = 1

        emojiImageEditor.onEndDrag = updateEmojiPreview
        emojiImageEditor.init(file, 1).then(() => {
            const nameInput = document.getElementById('emoji-name-input')
            if (nameInput) nameInput.value = defaultName
            updateEmojiPreview()
        }).catch(err => {
            console.error("Failed to load emoji image:", err)
            closeMenu('#emoji-upload')
        })
    })
}
window.handleEmojiImageUpload = handleEmojiImageUpload

function updateEmojiPreview() {
    emojiImageEditor.getCroppedImageData(64, 'image/png').then(dataUrl => {
        const large = document.getElementById('emojiPreviewLarge')
        const small = document.getElementById('emojiPreviewSmall')
        if (large) large.src = dataUrl
        if (small) small.src = dataUrl
    }).catch(() => {})
}
window.updateEmojiPreview = updateEmojiPreview

function finishEmojiUpload() {
    const nameInput = document.getElementById('emoji-name-input')
    const name = (nameInput?.value || 'emoji').trim().replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'emoji'
    const serverId = global.state.currentServer?.id
    if (!serverId) return

    emojiImageEditor.getCroppedImageData(128, 'image/png').then(result => {
        const onload = function() {
            if (handleQuotaError(this)) return
            try {
                const response = JSON.parse(this.responseText)
                if (response.error) { console.error("Emoji upload error:", response.error); return }
                const emojis = [...(global.state.currentServer.customEmojis || []), response]
                setElement('global.state.currentServer.customEmojis', emojis)
                const serv = lookFor(serverId, global.servers)
                if (serv) serv.customEmojis = emojis
            } catch(e) { console.error("Failed to parse emoji response:", e) }
        }
        xhr(`create_server_emoji?server_id=${serverId}&name=${encodeURIComponent(name)}`, onload, "POST", true, {"value": result})
        closeMenu('#emoji-upload')
    }).catch(err => { console.error("Failed to crop emoji:", err) })
}
window.finishEmojiUpload = finishEmojiUpload

function deleteServerEmoji(emojiId) {
    const serverId = global.state.currentServer?.id
    if (!serverId) return
    const onload = function() {
        try {
            const response = JSON.parse(this.responseText)
            if (response.status === 'ok') {
                const emojis = (global.state.currentServer.customEmojis || []).filter(e => e.id !== emojiId)
                setElement('global.state.currentServer.customEmojis', emojis)
                const serv = lookFor(serverId, global.servers)
                if (serv) serv.customEmojis = emojis
            }
        } catch(e) { console.error("Failed to parse delete response:", e) }
    }
    xhr(`delete_server_emoji?emoji_id=${emojiId}`, onload, "POST")
}
window.deleteServerEmoji = deleteServerEmoji

// ── End custom emoji upload ────────────────────────────────────────────────


export function loadServer(id){
    // Offline: the snapshot already holds this server's dirs/members/roles.
    // Skip the (synchronous) fetch — it would throw on a network error and abort
    // navigation — and just re-trigger reactivity so the channel list paints from
    // the cached state. Every other loader is guarded the same way.
    if (global.state.offline) {
        const serv = lookFor(id, global.servers)
        if (serv) {
            if (serv.dirs) orderServDirs(serv)
            setElement(`global.servers[${id}]`, serv)
            if (global.state.currentServer?.id === id) {
                setElement('global.state.currentServer', serv)
            }
        }
        return
    }

    const onload = function() { // request successful
        console.log(this.responseText)
        const resp = JSON.parse(this.responseText)
        const serv = lookFor(id,global.servers)

        // Preserve community server properties (languages, tags, description, etc.)
        // These are loaded by getUserServers but not included in getServContent
        const preservedProps = {
            languages: serv.languages,
            tags: serv.tags,
            description: serv.description,
            is_community: serv.is_community,
            is_featured: serv.is_featured,
            member_count: serv.member_count,
            customEmojis: serv.customEmojis
        };

        if (resp.op) {
            serv.op = resp.op
        }
        const dashboards = resp.dashboards ? resp.dashboards : []
        const vocals = resp.vocals ? resp.vocals : []
        const drives = resp.drives ? resp.drives : []
        const notes = resp.notes ? resp.notes : []
        const forums = resp.forums ? resp.forums : []
        serv["dirs"] = {"channels" : resp.channels, "dashboards" : dashboards , "vocals" : vocals, "drives" : drives, "notes": notes, "forums": forums, "cat" : resp.cat}

        const vocalOccupants = {}
        for (const chan of vocals) {
            vocalOccupants[chan.id] = chan.occupants || []
        }
        serv["vocalOccupants"] = vocalOccupants

        serv["members"] = {}
        let userList = []
        for (let member of resp.members){
            serv["members"][member.id] = member
            userList.push(member.id)
        }
        serv["roles"] = {}
        for (let role of resp.roles){
            serv["roles"][role.id] = role
        }
        serv["default_permissions"] = resp.default_permissions || {}

        serv["type"]= resp.type
        serv["channel_permissions"] = resp.channel_permissions || []
        serv["storage_quota"] = resp.storage_quota || 0

        // Restore preserved properties
        Object.assign(serv, preservedProps);

        loadUsers(userList)
        orderServDirs(serv)

        // Déclencher la réactivité Vesta en mettant à jour le global state
        setElement(`global.servers[${id}]`, serv);

        // Si c'est le serveur actuel, mettre à jour currentServer pour déclencher Subscribe
        if (global.state.currentServer?.id === id) {
            setElement('global.state.currentServer', serv);
        }
        // Restore unread channel markers after DOM re-renders
        setTimeout(() => window.applyChannelUnreads?.(), 0)
    };
    xhr("get_serv_content?server_id=".concat(id.toString()),onload,"GET",false)
}
window.loadServer = loadServer;

function firstGreater(arr, target) {
    for (let i = 0; i < arr.length; i++) {
        if (arr[i].place >= target) {
            return i;
        }
    }
}

export function orderServDirs(serv){
    serv?.dirs?.cat.sort((a, b) => a.place - b.place);

    for (let cat of serv.dirs.cat){
        cat.channels = []
    }

    // Collect all channel types with their type tag
    const allChannels = [
        ...(serv.dirs.channels || []).map(c => ({...c, type: "textual"})),
        ...(serv.dirs.vocals || []).map(c => ({...c, type: "vocal", name: c.name || "Salon vocal"})),
        ...(serv.dirs.drives || []).map(c => ({...c, type: "drive"})),
        ...(serv.dirs.notes || []).map(c => ({...c, type: "note"})),
        ...(serv.dirs.forums || []).map(c => ({...c, type: "forum"})),
    ]
    allChannels.sort((a, b) => a.place - b.place)

    let ordered = [...serv.dirs.cat]
    for (let chan of allChannels){
        if (chan.category){
            const cat = lookFor(chan.category, serv.dirs.cat)
            if (cat) {
                cat.channels.push(chan)
            } else {
                ordered.splice(firstGreater(ordered, chan.place) ?? ordered.length, 0, chan)
            }
        }else{
            ordered.splice(firstGreater(ordered, chan.place) ?? ordered.length, 0, chan)
        }
    }
    setElement("global.state.currentServer['displayed-dirs']", ordered)
}

function createInvitation(){
    xhr("create_invitation?server_id="+global.state.currentServer.id,function(){
        global.state.currentInvitationId = this.responseText
        openMenu('server-invitation')
    })
}
window.createInvitation = createInvitation

function copyInviteLink(iconWrapper){
    const input = iconWrapper.closest('.input-wrapper')?.querySelector('input')
    if (!input) return
    navigator.clipboard.writeText(input.value).then(() => {
        const img = iconWrapper.querySelector('img')
        const prev = img.src
        img.src = '/static/icons/material/check.svg'
        setTimeout(() => { img.src = prev }, 1500)
    })
}
window.copyInviteLink = copyInviteLink

function createChan(type = 'textual'){
    const channelType = type || 'textual';

    const onChannelCreated = function() {
        try {
            const response = JSON.parse(this.responseText);
            const newChannel = response.channel;
            const channelTypeStr = response.type;

            // Ajouter le type au canal
            if (channelTypeStr === 'textual') {
                newChannel.type = 'textual';
                global.state.currentServer.dirs.channels.push(newChannel);
            } else if (channelTypeStr === 'vocal') {
                newChannel.type = 'vocal';
                newChannel.name = newChannel.name || "Salon vocal";
                global.state.currentServer.dirs.vocals.push(newChannel);
            } else if (channelTypeStr === 'drive') {
                newChannel.type = 'drive';
                global.state.currentServer.dirs.drives.push(newChannel);
            } else if (channelTypeStr === 'note') {
                newChannel.type = 'note';
                global.state.currentServer.dirs.notes.push(newChannel);
            } else if (channelTypeStr === 'forum') {
                newChannel.type = 'forum';
                if (!global.state.currentServer.dirs.forums) global.state.currentServer.dirs.forums = [];
                global.state.currentServer.dirs.forums.push(newChannel);
            }

            // Re-ordonner et mettre à jour l'affichage
            orderServDirs(global.state.currentServer);

        } catch (e) {
            console.error("Error creating channel:", e);
        }
    };

    xhr("edit_server_channel?server_id="+global.state.currentServer.id+"&action=create&channel_type="+channelType, onChannelCreated);

    const menu = document.getElementById('create-channel');
    if(menu) menu.style.display = 'none';

    // Close the server-settings flying menu if it's still open behind the dialog
    closeFM();
}
window.createChan = createChan

function createCat(){
    const onload = function() {
        try {
            const cat = JSON.parse(this.responseText)
            global.state.currentServer.dirs.cat.push(cat)
            orderServDirs(global.state.currentServer)
        } catch(e) {
            console.error("Error creating category:", e)
        }
    }
    xhr("edit_server_category?server_id="+global.state.currentServer.id+"&action=create", onload)
}
window.createCat = createCat

function deleteCatFromMenu(){
    const catId = global.state.editingCatId
    if (!catId) return
    // Close the modale if open
    if (global.state.activeFM) {
        global.state.activeFM.classList.remove("visible")
        global.state.activeFM = undefined
    }
    // Close settings menu if open
    const menu = document.getElementById('cat-params')
    if (menu) menu.style.display = 'none'
    deleteCat(catId)
}
window.deleteCatFromMenu = deleteCatFromMenu

function saveCatSettings(){
    const catId = global.state.editingCatId
    if (!catId) return
    const input = document.getElementById('cat-name-input')
    if (!input) return
    const newName = input.value.trim()
    if (!newName) return

    xhr("edit_server_category?server_id="+global.state.currentServer.id+"&targetId="+catId+"&field=name&value="+encodeURIComponent(newName))
    const cat = lookFor(parseInt(catId), global.state.currentServer.dirs.cat)
    if (cat) cat.name = newName
    orderServDirs(global.state.currentServer)

    // Hide save bar
    const form = document.getElementById('formCat')
    if (form) form.style.display = 'none'
    delete global.state["currentForm"]
}
window.saveCatSettings = saveCatSettings

function deleteCat(catId){
    if (!confirm(_t("Delete this category? Channels inside will be moved out."))) return
    const onload = function(){
        // Remove category from dirs
        const idx = global.state.currentServer.dirs.cat.findIndex(c => c.id == catId)
        if (idx > -1) global.state.currentServer.dirs.cat.splice(idx, 1)
        // Unassign channels locally
        const allArrays = [global.state.currentServer.dirs.channels, global.state.currentServer.dirs.vocals, global.state.currentServer.dirs.drives, global.state.currentServer.dirs.notes]
        for (const arr of allArrays) {
            for (const ch of arr) {
                if (ch.category == catId) ch.category = null
            }
        }
        orderServDirs(global.state.currentServer)
    }
    xhr("edit_server_category?server_id="+global.state.currentServer.id+"&targetId="+catId+"&action=delete", onload)
}
window.deleteCat = deleteCat

/**
 * Server, channel and category settings all render into #setting-server-content:
 * with two of them in the DOM, goTo() (getElementById) would fill the hidden one.
 * Keep a single settings panel, rebuilt for what is being edited.
 */
export function closeSettingsPanels(){
    for (const id of ['server-params', 'channels-params', 'cat-params']) document.getElementById(id)?.remove()
    // goTo() un-highlights this tab: it must not point into a removed panel
    delete global.state.currentSettingTab
}
window.closeSettingsPanels = closeSettingsPanels

/** Opens the settings of the category in global.state.modaltarget (rebuilt each time). */
function openCategorySettings(){
    closeSettingsPanels()
    global.state.permissionsScope = 'category'
    openMenu('cat-params', false)
    if (!canManageCategory()) openChannelPermissions()
}
window.openCategorySettings = openCategorySettings

/**
 * Opens the settings of the channel in global.state.modaltarget. #channels-params is rendered
 * for the channel it was opened on (name, type, Overview), so it is rebuilt every time.
 */
function openChannelSettings(){
    closeSettingsPanels()
    global.state.permissionsScope = 'channel'   // channel-permissions.mjs
    openMenu('channels-params', false)
    // Only channel-level "manage-roles": the overview is hidden, open the permissions
    if (!canManageChannel()) openChannelPermissions()
}
window.openChannelSettings = openChannelSettings

function deleteChannel(){
    const id = global.state.modaltarget?.dataset?.id
    const type = global.state.editingChannelType || 'textual'
    if (!id) return
    if (!confirm(_t("Delete this channel? This action cannot be undone."))) return
    const onload = function(){
        const arrMap = {textual: 'channels', vocal: 'vocals', drive: 'drives', note: 'notes', forum: 'forums'}
        const arr = global.state.currentServer.dirs[arrMap[type]]
        if (arr) {
            const idx = arr.findIndex(c => c.id == id)
            if (idx > -1) arr.splice(idx, 1)
        }
        closeMenu('#channels-params')
        orderServDirs(global.state.currentServer)
    }
    xhr(`edit_server_channel?server_id=${global.state.currentServer.id}&action=delete&targetId=${id}&channel_type=${type}`, onload)
}
window.deleteChannel = deleteChannel

function attributeRole(roleId){
    const onload = function() {
        if (this.status !== 200) {
            return;
        }

        // Updates the state and repaints the profile card, member list, role settings
        applyMemberRole(global.state.profileInfo.id, roleId, true)
        const elt = document.getElementById("addRole")
        elt.style.display = "none"
    }

    xhr("edit_server_role?server_id="+global.state.currentServer.id+"&action=attribute&value="+global.state.profileInfo.id+"&targetId="+roleId, onload)
}
window.attributeRole = attributeRole

function removeRoleFromUser(event, roleId){
    event.stopPropagation()

    const onload = function() {
        if (this.status !== 200) {
            return;
        }

        applyMemberRole(global.state.profileInfo.id, roleId, false)
    }

    xhr("edit_server_role?server_id="+global.state.currentServer.id+"&action=unattribute&value="+global.state.profileInfo.id+"&targetId="+roleId, onload)
}
window.removeRoleFromUser = removeRoleFromUser

// Minimal API Keys actions used by the devs-settings template
function createApiKey(){
    const name = document.getElementById('api-key-name').value.trim()
    const perms = []

    if(!name){
        // simple client-side validation
        alert('Please provide a name for the API key')
        return
    }

    const payload = {name: name, permissions: perms}
    const onload = function(){
        // Expecting server to return the newly created key object: {id, name, key, created, permissions}
        try{
            const newKey = JSON.parse(this.responseText)
            // mark visible so it is shown unmasked once
            newKey.visible = true
            addElement('global.user.apiKeys', newKey)

            // show modal with the raw key value
            const val = newKey.key || ''
            const preview = document.getElementById('new-api-key-value')
            if(preview){ preview.textContent = val; preview.style.cursor = 'pointer'; preview.onclick = copyCreatedKey }
            const modal = document.getElementById('createdKeyModal')
            if(modal) modal.style.display = 'block'

            // clear input
            const inp = document.getElementById('api-key-name')
            if(inp) inp.value = ''
        }catch(e){
            console.log('createApiKey: invalid response', this.responseText)
        }
    }

    xhr('create_api_key', onload, 'POST', true, payload)
}
window.createApiKey = createApiKey

function revokeKey(id){
    if(!confirm(''+_t('Are you sure you want to revoke this API key?'))){
        return
    }
    const onload = function(){
        // remove from global.user.apiKeys
        if(!global.user || !global.user.apiKeys) return
        for(let i = 0; i < global.user.apiKeys.length; i++){
            if(global.user.apiKeys[i].id.toString() === id.toString()){
                deleteElement('global.user.apiKeys', i)
                break
            }
        }
    }
    xhr('revoke_api_key?key_id='+encodeURIComponent(id), onload)
}
window.revokeKey = revokeKey

function regenerateKey(id){
    if(!confirm(''+_t('Regenerate this API key ? The previous value will stop working.'))){
        return
    }
    const onload = function(){
        try{
            const resp = JSON.parse(this.responseText)
            // resp should contain the new key string and maybe metadata
            const newKeyValue = resp.key || resp

            if(!global.user || !global.user.apiKeys) return
            for(let i=0;i<global.user.apiKeys.length;i++){
                if(global.user.apiKeys[i].id.toString() === id.toString()){
                    // update value and mark visible once
                    global.user.apiKeys[i].key = newKeyValue
                    global.user.apiKeys[i].visible = true
                    // show modal with new value
                    const preview = document.getElementById('new-api-key-value')
                    if(preview) { preview.textContent = newKeyValue; preview.style.cursor = 'pointer'; preview.onclick = copyCreatedKey }
                    const modal = document.getElementById('createdKeyModal')
                    if(modal) modal.style.display = 'block'
                    // update element so subscribers react
                    setElement('global.user.apiKeys['+i+'].key', newKeyValue)
                    setElement('global.user.apiKeys['+i+'].visible', true)
                    break
                }
            }
        }catch(e){
            console.log('regenerateKey: invalid response', this.responseText)
        }
    }
    xhr('regenerate_api_key?key_id='+encodeURIComponent(id), onload)
}
window.regenerateKey = regenerateKey

// Copy-to-clipboard helper for the created/regenerated key preview
function copyCreatedKey(){
    const preview = document.getElementById('new-api-key-value')
    if(!preview) return
    const text = preview.textContent ? preview.textContent.trim() : ''
    if(!text) return

    navigator.clipboard.writeText(text).then(()=>{ showCopyFeedback(preview) }).catch(()=>{ fallbackCopy(text, preview) })

}
window.copyCreatedKey = copyCreatedKey


function showCopyFeedback(anchor){
    // small transient feedback element
    const f = document.createElement('div')
    f.className = 'muted'
    f.style.marginTop = '8px'
    f.textContent = _t('Copied to clipboard')
    anchor.parentElement.appendChild(f)
    setTimeout(()=>{ try{ f.remove() }catch(e){} }, 1500)
}

function loadUserApiKeys(){
    const onload = function(){
        try{
            const keys = JSON.parse(this.responseText)
            // ensure structure and default visibility
            if(!global.user) global.user = {}
            global.user.apiKeys = keys.map(function(k){
                k.visible = false
                // ensure created is a string
                if(k.created) k.created = k.created.toString()
                return k
            })
            // trigger reactive update
            setElement('global.user.apiKeys', global.user.apiKeys)
        }catch(e){
            console.log('loadUserApiKeys: invalid response', this.responseText)
        }
    }
    xhr('get_user_api_keys', onload)
}
window.loadUserApiKeys = loadUserApiKeys

function addEmail(){
    const input = document.getElementById("new-email-input")
    const emailValue = input.value.trim()

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailValue)) {
        input.setCustomValidity("Invalid email address.");
        input.reportValidity()
        return
    } else {
        input.setCustomValidity("");
    }

    const onload = function() {
        const response = JSON.parse(this.responseText)
        if (response.error) {
            alert(response.error)
        } else {
            // Add the new email to the list
            if (!global.user.additional_emails) {
                global.user.additional_emails = []
            }
            pushElement('global.user.additional_emails', response)
            input.value = ''
        }
    };
    xhr("/add_email?email=".concat(encodeURIComponent(emailValue)), onload, "POST")
}
window.addEmail = addEmail

function removeEmail(emailId){
    if (!confirm('Are you sure you want to remove this email address?')) {
        return
    }

    const onload = function() {
        const response = JSON.parse(this.responseText)
        if (response.error) {
            alert(response.error)
        } else {
            // Remove the email from the list
            if (global.user.additional_emails) {
                const index = global.user.additional_emails.findIndex(e => e.id === emailId)
                if (index !== -1) {
                    deleteVal('global.user.additional_emails', index)
                }
            }
        }
    };
    xhr("/remove_email?email_id=".concat(emailId), onload, "POST")
}
window.removeEmail = removeEmail

// ==================== Community Server Functions ====================

const MAX_SERVER_TAGS = 10

/** Shows (or clears, with no message) the inline error under a community setting. */
function showCommunityError(id, message) {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = message || ''
    el.hidden = !message
}

/**
 * Saves a JSON-list server property (tags, languages) and only then updates the
 * local state, so a refused change never shows up as saved.
 */
function saveServerList(property, list, errorId, onSaved) {
    xhr(`edit_server_property?server_id=${global.state.currentServer.id}&property=${property}&value=${encodeURIComponent(JSON.stringify(list))}`,
        function () {
            if (this.status !== 200) {
                showCommunityError(errorId, _t("Impossible d'enregistrer ce changement."))
                return
            }
            showCommunityError(errorId)
            setElement('global.state.currentServer.' + property, list)
            onSaved?.()
        },
        "POST", false)
}

function toggleCommunityServer() {
    const checkbox = document.getElementById('is-community-checkbox')
    const isCommunity = checkbox.checked

    xhr(`edit_server_property?server_id=${global.state.currentServer.id}&property=is_community&value=${isCommunity}`,
        function () {
            if (this.status !== 200) {
                checkbox.checked = !isCommunity
                showCommunityError('community-error', this.status === 403
                    ? _t("Seul le propriétaire du serveur peut changer ce réglage.")
                    : _t("Impossible d'enregistrer ce changement."))
                return
            }
            showCommunityError('community-error')
            global.state.currentServer.is_community = isCommunity
            const communitySettings = document.getElementById('community-settings')
            if (communitySettings) communitySettings.style.display = isCommunity ? '' : 'none'
        },
        "POST", false)
}
window.toggleCommunityServer = toggleCommunityServer

/**
 * Language chips plus the app's .dropdown component (as in Settings > Language)
 * offering the languages not chosen yet.
 */
function renderServerLanguages() {
    const languages = parseJsonArray(global.state.currentServer?.languages)
    const label = (code) => `${getFlagEmoji(code)} ${escapeHTML(SERVER_LANGUAGES[code] || code.toUpperCase())}`
    const chips = languages.length
        ? '<div class="community-chips">' + languages.map((code, index) =>
            `<span class="server-language-item community-chip">${label(code)}<button onclick="removeLanguage(${index})" aria-label="${_t('Retirer')}">×</button></span>`
          ).join('') + '</div>'
        : `<p class="community-empty">${_t("Aucune langue sélectionnée")}</p>`
    const available = Object.keys(SERVER_LANGUAGES).filter(code => !languages.includes(code))
    if (available.length === 0) return chips
    return chips + `<div class="dropdown" id="language-add-dropdown">
        <div class="dropdown-button" onclick="toggleDropdown(event)">
            <div class="dropdown-text">${_t("Ajouter une langue...")}</div>
            <div class="icon-wrapper">
                <img class="icon down" src="/static/icons/material/down.svg" alt=""/>
                <img class="icon up" src="/static/icons/material/up.svg" alt=""/>
            </div>
        </div>
        <ul class="dropdown-menu scrollbar">${available.map(code =>
            `<li data-lang="${code}" onclick="addLanguage(this.dataset.lang)">${label(code)}</li>`).join('')}</ul>
    </div>`
}
window.renderServerLanguages = renderServerLanguages

function addLanguage(language) {
    const dropdown = document.getElementById('language-add-dropdown')
    dropdown?.classList.remove('show')
    if (global.state.activeDropdown === dropdown) global.state.activeDropdown = undefined
    const languages = parseJsonArray(global.state.currentServer?.languages)
    if (!language || languages.includes(language)) return
    saveServerList('languages', [...languages, language], 'server-language-error')
}
window.addLanguage = addLanguage

function removeLanguage(index) {
    const languages = parseJsonArray(global.state.currentServer?.languages)
    saveServerList('languages', languages.filter((_, i) => i !== index), 'server-language-error')
}
window.removeLanguage = removeLanguage

function renderServerTags() {
    const tags = parseJsonArray(global.state.currentServer?.tags)
    if (tags.length === 0) return `<p class="community-empty">${_t("Aucun tag ajouté")}</p>`
    return '<div class="community-chips">' + tags.map((tag, index) =>
        `<span class="server-tag-item community-chip"># ${escapeHTML(tag)}<button onclick="removeServerTag(${index})" aria-label="${_t('Retirer')}">×</button></span>`
    ).join('') + '</div>'
}
window.renderServerTags = renderServerTags

function addServerTag() {
    const input = document.getElementById('new-tag-input')
    const tag = input.value.trim()
    if (!tag) return

    const tags = parseJsonArray(global.state.currentServer?.tags)
    if (tags.some(t => t.toLowerCase() === tag.toLowerCase())) {
        showCommunityError('server-tag-error', _t("Ce tag existe déjà."))
        return
    }
    if (tags.length >= MAX_SERVER_TAGS) {
        showCommunityError('server-tag-error', _t("Vous ne pouvez pas ajouter plus de 10 tags."))
        return
    }
    saveServerList('tags', [...tags, tag], 'server-tag-error', () => {
        input.value = ''
        document.getElementById('new-tag-counter').textContent = input.maxLength
    })
}
window.addServerTag = addServerTag

function removeServerTag(index) {
    const tags = parseJsonArray(global.state.currentServer?.tags)
    saveServerList('tags', tags.filter((_, i) => i !== index), 'server-tag-error')
}
window.removeServerTag = removeServerTag

function leaveServer(){
    const serverId = global.state.currentServer?.id
    if (!serverId) return
    if (!confirm(_t("Quitter ce serveur ?"))) return
    const onload = function() {
        deleteElementDict("global.servers", serverId)
        goTo('sec-column', "column-perso", undefined, true, () => { goTo('sec-selector', "privateMessage") })
    }
    xhr("leave_server?server_id=".concat(serverId), onload, "POST")
}
window.leaveServer = leaveServer

function muteChannel(minutes){
    const chanId = parseInt(global.state.modaltarget?.dataset?.id)
    if (!chanId) return
    const url = minutes !== null ? `mute_channel?channel_id=${chanId}&minutes=${minutes}` : `mute_channel?channel_id=${chanId}`
    const onload = function() {
        const resp = JSON.parse(this.responseText)
        if (!global.user.channel_mutes) global.user.channel_mutes = []
        global.user.channel_mutes = global.user.channel_mutes.filter(m => m.channel !== chanId)
        global.user.channel_mutes.push({ channel: chanId, muted_until: resp.muted_until })
        setElement('global.user.channel_mutes', global.user.channel_mutes)
        // Remove unread marker on muted channel
        document.getElementById('channel-conv-' + chanId)?.classList.remove('unread')
        closeFM()
    }
    xhr(url, onload, "POST")
}
window.muteChannel = muteChannel

function unmuteChannel(){
    const chanId = parseInt(global.state.modaltarget?.dataset?.id)
    if (!chanId) return
    const onload = function() {
        global.user.channel_mutes = (global.user.channel_mutes || []).filter(m => m.channel !== chanId)
        setElement('global.user.channel_mutes', global.user.channel_mutes)
        closeFM()
    }
    xhr(`unmute_channel?channel_id=${chanId}`, onload, "POST")
}
window.unmuteChannel = unmuteChannel

function setServerNotifPref(opts){
    const serverId = global.state.currentServer?.id
    if (!serverId) return
    const params = new URLSearchParams({ server_id: serverId })
    if (opts.level !== undefined) params.set('level', opts.level)
    if (opts.suppress_everyone !== undefined) params.set('suppress_everyone', opts.suppress_everyone)
    const onload = function() {
        if (!global.user.notif_prefs) global.user.notif_prefs = {}
        if (!global.user.notif_prefs[String(serverId)]) global.user.notif_prefs[String(serverId)] = {}
        if (opts.level !== undefined) global.user.notif_prefs[String(serverId)].level = opts.level
        if (opts.suppress_everyone !== undefined) global.user.notif_prefs[String(serverId)].suppress_everyone = opts.suppress_everyone
        setElement('global.user.notif_prefs', global.user.notif_prefs)
        closeFM()
    }
    xhr(`set_server_notif_pref?${params}`, onload, "POST")
}
window.setServerNotifPref = setServerNotifPref
