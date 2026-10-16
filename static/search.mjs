// Ctrl+K global search palette.
//
// Two result sources, one ranking path:
//  - local (every keystroke): servers + DMs from global state — the only place
//    DM display names exist (getConvName) — plus channels of already-loaded
//    servers as bonus instant rows;
//  - remote (debounced ≥2 chars): global_search — channels of all servers,
//    forum posts, drive files/folders, ACL-filtered server-side.
// Both are scored with fuzzyScore (match-quality tier), then ordered inside a
// tier by frecency (get_frecency, fetched once per session), then raw score.
import global from "/static/framework/global.mjs"
import {goTo} from "/static/framework/navigation.mjs"
import {xhr} from "/static/framework/templating.mjs"
import {setElement} from "/static/framework/vesta.mjs"
import {handleHashRoute} from "/static/navigation.mjs"

const REMOTE_MIN_CHARS = 2
const DEBOUNCE_MS = 200
const MAX_RESULTS = 20

const ICONS = {
    server: 'group', conv: 'person', textual: 'hashtag', vocal: 'sound',
    drive: 'folder', note: 'note', forum: 'inbox', post: 'message',
    file: 'file', folder: 'folder',
}

let frecency = {places: {}, servers: {}}
let frecencyRequested = false
let debounceTimer = null
let remoteSeq = 0
let remoteItems = []
let currentQuery = ''
let currentItems = []
let selIdx = 0

function ensureFrecency() {
    if (frecencyRequested || global.state?.offline) return
    frecencyRequested = true
    xhr('get_frecency', function () {
        try { frecency = JSON.parse(this.responseText) } catch (e) { return /* rank without it */ }
        recompute() // re-rank whatever is already displayed
    })
}

/** Everything searchable without the server: all servers and DMs are loaded at
 * boot; channels only exist for servers visited this session (the remote tier
 * covers the rest — ids overlap and are deduplicated in recompute). */
function localCandidates() {
    const items = []
    for (const s of Object.values(global.servers || {})) {
        items.push({kind: 'server', id: s.id, name: s.name || ''})
        const dirs = s.dirs
        if (!dirs) continue
        for (const [key, kind] of [['channels', 'textual'], ['vocals', 'vocal'], ['drives', 'drive'], ['notes', 'note'], ['forums', 'forum']]) {
            for (const c of (dirs[key] || [])) {
                items.push({kind, id: c.id, name: c.name || '', server: s.id})
            }
        }
    }
    for (const c of Object.values(global.privateConvs || {})) {
        // getConvName throws if a member isn't in global.users yet; one bad
        // conv must not take down the whole search pass.
        let name = c.name || ''
        try { name = getConvName(c) || '' } catch (e) { /* keep fallback */ }
        items.push({kind: 'conv', id: c.id, name})
    }
    return items
}

function frecencyOf(item) {
    if (item.kind === 'server') return frecency.servers?.[item.id] || 0
    return frecency.places?.[item.id] || 0
}

// fuzzyScore's bands encode match quality: exact ≥1000 > prefix ≥500 >
// substring ≥200 > subsequence >0. Frecency only orders within a band, so a
// rarely-visited exact match still beats a favorite channel that merely
// contains the query.
function tierOf(score) {
    if (score >= 1000) return 3
    if (score >= 500) return 2
    if (score >= 200) return 1
    return 0
}

function rank(pool, query) {
    const scored = []
    for (const it of pool) {
        const score = fuzzyScore(query, it.name)
        if (score > 0) {
            scored.push({...it, _tier: tierOf(score), _score: score, _frec: frecencyOf(it)})
        } else if (it.sim) {
            // Trigram-only hit (typo/accent): fuzzyScore can't see it, keep it
            // in the lowest tier so real matches always outrank it.
            scored.push({...it, _tier: -1, _score: it.sim, _frec: frecencyOf(it)})
        }
    }
    scored.sort((a, b) => b._tier - a._tier || b._frec - a._frec || b._score - a._score)
    return scored.slice(0, MAX_RESULTS)
}

function subtitleOf(item) {
    const serverName = item.server != null ? (global.servers?.[item.server]?.name || '') : ''
    switch (item.kind) {
        case 'server': return _t('Serveur')
        case 'conv': return _t('Message privé')
        case 'post': return [item.forum_name, serverName].filter(Boolean).join(' · ')
        case 'file': case 'folder': {
            const path = [item.drive_name, ...(item.path || []).map(f => f.name)].filter(Boolean).join(' / ')
            return [serverName, path].filter(Boolean).join(' · ')
        }
        default: return serverName
    }
}

function paint(items) {
    currentItems = items
    if (selIdx >= items.length) selIdx = Math.max(items.length - 1, 0)
    items.forEach((it, i) => {
        it._idx = i
        it._selected = i === selIdx
        it._icon = ICONS[it.kind] || 'search'
        it._subtitle = subtitleOf(it)
    })
    global.state.searchQuery = currentQuery
    global.state.searchResults = items
    setElement('global.state.searchResults', items)
    setTimeout(() => document.getElementById('search-result-' + selIdx)?.scrollIntoView({block: 'nearest'}), 0)
}

function recompute() {
    if (!currentQuery) { paint([]); return }
    const seen = new Set()
    const pool = []
    for (const it of localCandidates()) {
        const key = it.kind + ':' + it.id
        if (!seen.has(key)) { seen.add(key); pool.push(it) }
    }
    for (const it of remoteItems) {
        const key = it.kind + ':' + it.id
        if (!seen.has(key)) { seen.add(key); pool.push(it) }
    }
    paint(rank(pool, currentQuery))
}

function fetchRemote(query) {
    const seq = ++remoteSeq
    xhr('global_search?query=' + encodeURIComponent(query), function () {
        if (seq !== remoteSeq || query !== currentQuery) return // stale response
        let resp
        try { resp = JSON.parse(this.responseText) } catch (e) { return }
        remoteItems = [
            ...(resp.channels || []),
            ...(resp.posts || []),
            ...(resp.files || []),
            ...(resp.folders || []),
        ]
        recompute()
    })
}

function searchPalette(event) {
    currentQuery = event.target.value.trim()
    selIdx = 0
    clearTimeout(debounceTimer)
    remoteItems = []
    recompute()
    if (currentQuery.length >= REMOTE_MIN_CHARS && !global.state?.offline) {
        const q = currentQuery
        debounceTimer = setTimeout(() => fetchRemote(q), DEBOUNCE_MS)
    }
}
window.searchPalette = searchPalette

function searchPaletteKeydown(event) {
    if (event.key === 'ArrowDown') {
        event.preventDefault()
        selIdx = Math.min(selIdx + 1, currentItems.length - 1)
        paint(currentItems)
    } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        selIdx = Math.max(selIdx - 1, 0)
        paint(currentItems)
    } else if (event.key === 'Enter') {
        event.preventDefault()
        openSearchResultAt(selIdx)
    }
    // Escape is handled by the document-level listener so it also works when
    // focus has left the input (e.g. after clicking around the results).
}
window.searchPaletteKeydown = searchPaletteKeydown

function openSearchResultAt(i) {
    const item = currentItems[i]
    if (!item) return
    closeSearchPalette()

    switch (item.kind) {
        case 'conv':
            // goToConv assumes its sidebar row is in the DOM, which is false
            // while a server is displayed — render the DM list first, the
            // same dance convNotif.html and goToHome do.
            global.state.isServer = false
            goTo('sec-selector', 'privateMessage', undefined, false)
            handleHashRoute('@me/' + item.id)
            break
        case 'server': {
            // '/0' opens the server without a channel; then land on the first
            // textual channel like a sidebar click would.
            handleHashRoute(item.id + '/0')
            const first = window.firstTextChannel(global.state.currentServer)
            if (first) goToChannel(first.id)
            break
        }
        case 'post':
            handleHashRoute(item.server + '/' + item.forum + '/post/' + item.id)
            break
        case 'file':
        case 'folder': {
            handleHashRoute(item.server + '/' + item.drive_channel)
            // goToDriveChannel opened the drive at its root; deep-open the
            // containing folder from the server-provided ancestor path.
            const stack = (item.path || []).map(f => ({id: f.id, name: f.name}))
            if (item.kind === 'folder') stack.push({id: item.id, name: item.name})
            if (stack.length) {
                if (!global.driveCurrentFolder) global.driveCurrentFolder = {}
                global.driveCurrentFolder[item.drive_channel] = stack
                setElement(`global.driveCurrentFolder[${item.drive_channel}]`, stack)
                loadDriveContent(item.drive_channel, stack[stack.length - 1].id)
            }
            break
        }
        default: // textual / vocal / note / forum / drive channels
            handleHashRoute(item.server + '/' + item.id)
    }
}
window.openSearchResultAt = openSearchResultAt

function openSearchPalette() {
    ensureFrecency()
    openMenu('search-palette', false)
    currentQuery = ''
    remoteItems = []
    selIdx = 0
    paint([])
    const input = document.getElementById('search-palette-input')
    if (input) {
        input.value = ''
        input.focus()
    }
}
window.openSearchPalette = openSearchPalette

function closeSearchPalette() {
    clearTimeout(debounceTimer) // don't fire a remote search for a closed palette
    const menu = document.getElementById('search-palette')
    if (menu) menu.style.display = 'none'
}
window.closeSearchPalette = closeSearchPalette

function isPaletteOpen() {
    const menu = document.getElementById('search-palette')
    return !!menu && menu.style.display === 'flex'
}

document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault() // browsers bind Ctrl+K to the URL bar
        if (isPaletteOpen()) closeSearchPalette()
        else openSearchPalette()
    } else if (event.key === 'Escape' && isPaletteOpen()) {
        closeSearchPalette()
    }
})
