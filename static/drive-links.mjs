import global from "./framework/global.mjs"
import {xhr} from "./framework/templating.mjs"
import {updateElement} from "./framework/vesta.mjs"
import {channelRoute} from "./routes.mjs"

// ─── Channel mentions and drive links ────────────────────────────────────────
// "<#id>" mentions a textual channel or a forum (their ids share one sequence).
// Other channel types have their own ids, which may be the same numbers, so
// their mentions name the type:
//   <#notes:7>  <#vocal:3>  <#drive:12>
// and a drive mention can point inside it:
//   <#drive:12/d:45>   folder 45 of drive 12
//   <#drive:12/f:301>  file 301 of drive 12
// Folder/file names come from drive_links (batched, cached, filtered by
// access) and are patched into the rendered chips when they arrive — markdown
// rendering stays synchronous.

const REF_RE = /^(?:(drive|notes|vocal):)?(\d+)(?:\/([df]):(\d+))?$/
// Token prefix -> the server's dirs it names ('' = no prefix)
const PREFIX_DIRS = {
    '': [['channels', 'textual'], ['forums', 'forum']],
    drive: [['drives', 'drive']],
    notes: [['notes', 'note']],
    vocal: [['vocals', 'vocal']],
}

const links = {}            // ref -> drive_links result ({ok: false} when hidden)
const queued = new Set()
const inflight = new Set()
let flushTimer = null

/** "drive:12/f:301" -> {prefix: 'drive', id: 12, kind: 'f', itemId: 301}, or null. */
function parseRef(ref) {
    const match = REF_RE.exec(String(ref))
    if (!match) return null
    const [, prefix = '', id, kind, itemId] = match
    if (kind && prefix !== 'drive') return null   // only a drive has folders/files
    return {prefix, id: Number(id), kind, itemId: itemId && Number(itemId)}
}

/** The "<#…>" token of a channel of the given dirs key ('channels', 'notes', 'drives'…). */
export function channelToken(dirsKey, id) {
    const prefix = Object.keys(PREFIX_DIRS).find(p => PREFIX_DIRS[p].some(([key]) => key === dirsKey)) || ''
    return `<#${prefix ? prefix + ':' : ''}${id}>`
}
window.channelToken = channelToken

function channelInServer(parsed, serv = global.state?.currentServer) {
    const dirs = serv?.dirs
    if (!dirs) return null
    for (const [key, type] of PREFIX_DIRS[parsed.prefix]) {
        const chan = (dirs[key] || []).find(c => Number(c.id) === parsed.id)
        if (chan) return {chan, type}
    }
    return null
}

function queueLink(ref) {
    if (queued.has(ref) || inflight.has(ref) || links[ref]) return
    queued.add(ref)
    clearTimeout(flushTimer)
    flushTimer = setTimeout(flushLinks, 20)
}

function flushLinks() {
    const refs = [...queued].slice(0, 50)
    refs.forEach(ref => { queued.delete(ref); inflight.add(ref) })
    if (queued.size) flushTimer = setTimeout(flushLinks, 20)
    if (!refs.length) return
    xhr(`drive_links?refs=${encodeURIComponent(JSON.stringify(refs))}`, function () {
        refs.forEach(ref => inflight.delete(ref))
        if (this.status !== 200) return
        const data = JSON.parse(this.responseText)
        for (const ref of refs) {
            links[ref] = data[ref] || {ok: false}
            repaintLink(ref)
        }
    })
}

function linkLabel(ref) {
    const parsed = parseRef(ref)
    if (!parsed.kind) {
        const found = channelInServer(parsed)
        if (found) return found.chan.name
        return links[ref]?.ok ? links[ref].name : null
    }
    const info = links[ref]
    if (!info) return '…'
    return info.ok ? `${info.drive_name} › ${info.name}` : _t('inaccessible item')
}

/**
 * HTML of a "<#ref>" mention (markdown.mjs mention_channel), or null when ref
 * isn't a channel/drive reference.
 */
function renderChannelMention(ref) {
    ref = String(ref)
    const parsed = parseRef(ref)
    if (!parsed) return null
    // Only drives are resolved remotely (another server's drive, folders, files)
    if (parsed.prefix === 'drive' && (parsed.kind || !channelInServer(parsed))) queueLink(ref)
    const label = linkLabel(ref) ?? 'unknown-channel'
    const denied = links[ref] && !links[ref].ok
    return `<span class='mention mention-channel${denied ? ' mention-denied' : ''}' data-channel-id='${escapeHTML(ref)}' onclick='openChannelMention(event, this.dataset.channelId)'>#${escapeHTML(label)}</span>`
}
window.renderChannelMention = renderChannelMention

function cardHtml(ref) {
    const info = links[ref]
    return fillWith('drive-link-card', [{
        ref, info,
        kind: info?.ok && window.driveFileKind(info.name),
        where: info?.ok ? [info.drive_name, ...(info.path || []).map(p => p.name)].join(' › ') : '',
    }])
}

/**
 * A message made of a single file link gets a card under it (navigation.mjs
 * renderMessageBody), repainted through global.driveLinkCards[drive][file]
 * once drive_links answers.
 */
function driveLinkCardHtml(text) {
    // Stored bodies have "<" escaped as "&lt;" (the live copy doesn't).
    const match = /^(?:<|&lt;)#drive:(\d+)\/f:(\d+)(?:>|&gt;)$/.exec((text || '').trim())
    if (!match) return ''
    const ids = [Number(match[1]), Number(match[2])]
    queueLink(`drive:${ids[0]}/f:${ids[1]}`)
    return Subscribe(`global.driveLinkCards[${ids[0]}][${ids[1]}]`,
        (card = ids) => window.driveLinkCardInner(card), 'drive-contents', {element: JSON.stringify(ids)})
}
window.driveLinkCardHtml = driveLinkCardHtml
window.driveLinkCardInner = ([driveId, fileId]) => cardHtml(`drive:${driveId}/f:${fileId}`)

function repaintLink(ref) {
    const label = linkLabel(ref)
    const denied = links[ref] && !links[ref].ok
    for (const el of document.querySelectorAll('.mention-channel[data-channel-id]')) {
        if (el.dataset.channelId !== ref) continue
        if (label !== null) el.textContent = '#' + label
        el.classList.toggle('mention-denied', !!denied)
    }
    const parsed = parseRef(ref)
    if (parsed.kind === 'f') updateElement(`global.driveLinkCards[${parsed.id}][${parsed.itemId}]`)
}

/** A drive changed (rename, move, delete…): resolve its links again. */
function forgetDriveLinks(driveId) {
    const ref0 = 'drive:' + driveId
    for (const ref of Object.keys(links)) {
        if (ref === ref0 || ref.startsWith(ref0 + '/')) {
            delete links[ref]
            if (document.querySelector(`[data-channel-id="${ref}"], [data-drive-card="${ref}"]`)) queueLink(ref)
        }
    }
    delete browseCache[driveId]
}
window.forgetDriveLinks = forgetDriveLinks

/** Click on a mention or a card: open the channel / folder / file. */
function openChannelMention(event, ref) {
    event?.preventDefault?.()
    event?.stopPropagation?.()
    const parsed = parseRef(ref)
    if (!parsed) return
    const {id, kind, itemId} = parsed
    const serv = global.state?.currentServer
    const local = global.state?.isServer ? channelInServer(parsed) : null

    if (!kind && local) {
        const go = {textual: 'goToChannel', forum: 'goToForumChannel', note: 'goToNoteChannel',
                    drive: 'goToDriveChannel', vocal: 'goToVocalChannel'}[local.type]
        window[go]?.(id)
        return
    }
    const info = links[ref]
    if (!info?.ok) return
    const target = kind ? {[kind === 'd' ? 'folder' : 'file']: itemId} : {}
    // Same server, drive listed: no server reload.
    if (local && Number(serv?.id) === Number(info.server)) {
        window.goToDriveChannel(id, target)
        return
    }
    const route = kind ? channelRoute(info.server, 'drive', info.drive, kind === 'd' ? 'folder' : 'file', itemId)
        : channelRoute(info.server, 'drive', info.drive)
    window.handleHashRoute?.(route)
    window.pushRoute?.(route)
}
window.openChannelMention = openChannelMention

// ─── # autocomplete inside drives ────────────────────────────────────────────
// "#travail/" lists the root of the drive "travail", "#travail/Eseo/rap" the
// items of its folder "Eseo" starting with "rap" (static/mentions.mjs).

const browseCache = {}   // driveId -> {folderKey -> {folders, files} | 'loading'}

function browse(driveId, folderId, refresh) {
    const byFolder = browseCache[driveId] || (browseCache[driveId] = {})
    const key = folderId ?? 'root'
    if (byFolder[key] && byFolder[key] !== 'loading') return byFolder[key]
    if (!byFolder[key]) {
        byFolder[key] = 'loading'
        xhr(`list_drive?drive_id=${driveId}` + (folderId ? `&folder_id=${folderId}` : ''), function () {
            if (this.status !== 200) { delete byFolder[key]; return }
            const data = JSON.parse(this.responseText)
            byFolder[key] = {folders: data.folders, files: data.files}
            refresh?.()
        })
    }
    return null
}

/** Autocomplete candidates for a "#drive/folder/…" query (`refresh` reruns it once loaded). */
function driveMentionCandidates(query, refresh) {
    const parts = query.split('/')
    const drives = global.state?.currentServer?.dirs?.drives || []
    const drive = drives.find(d => d.name.toLowerCase() === parts[0].toLowerCase())
    if (!drive) return []

    let folder = null
    const path = [drive.name]
    for (const segment of parts.slice(1, -1)) {
        const listing = browse(drive.id, folder, refresh)
        if (!listing) return []
        const next = listing.folders.find(f => f.foldername.toLowerCase() === segment.toLowerCase())
        if (!next) return []
        folder = next.id
        path.push(next.foldername)
    }
    const listing = browse(drive.id, folder, refresh)
    if (!listing) return []

    const q = parts[parts.length - 1].toLowerCase()
    const sub = path.join(' › ')
    const prefix = path.join('/') + '/'
    return [
        ...listing.folders.filter(f => f.foldername.toLowerCase().includes(q)).map(f => ({
            type: 'channel', id: drive.id, display: f.foldername, sub, icon: 'folder',
            token: `<#drive:${drive.id}/d:${f.id}>`, browse: prefix + f.foldername + '/',
        })),
        ...listing.files.filter(f => f.filename.toLowerCase().includes(q)).map(f => ({
            type: 'channel', id: drive.id, display: f.filename, sub, icon: 'file',
            token: `<#drive:${drive.id}/f:${f.id}>`,
        })),
    ].slice(0, 15)
}
window.driveMentionCandidates = driveMentionCandidates

// The markdown renderer (static/markdown, vendored) renders "<#id>" for textual
// channels only: re-render its mention spans with renderChannelMention.
const MENTION_SPAN = /<span class='mention mention-channel' data-channel-id='([^']*)'[^>]*>[^<]*<\/span>/g

function enhanceChannelMentions(html) {
    if (!html || !html.includes('mention-channel')) return html
    return html.replace(MENTION_SPAN, (span, ref) => renderChannelMention(ref) ?? span)
}
window.enhanceChannelMentions = enhanceChannelMentions
