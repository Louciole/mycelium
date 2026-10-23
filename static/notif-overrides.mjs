// A member's notification settings for channels and categories (the right-click menus):
// global.user.notif_overrides rows {target, category, muted, muted_until, level}, written by
// routes/users.py set_notification_override and read by message_helpers.notifyChannelMesage.
// A channel row is keyed by its message place (a vocal channel by its chat's). A channel is
// muted by its own row or its category's; its level is its own, else its category's, else
// the server's (global.user.notif_prefs). Level: 0 all messages, 1 @mentions, 2 nothing.

import global from "./framework/global.mjs"
import {setElement} from "./framework/vesta.mjs"
import {xhr} from "./framework/templating.mjs"

// Channel types with messages, the only ones with notifications
export const NOTIF_TYPES = ["textual", "forum", "vocal"]
window.NOTIF_TYPES = NOTIF_TYPES

const LEVEL_LABELS = ["Tous les messages", "Seulement les @mentions", "Rien"]

/** "Tous les messages" / … of a level. */
export function levelLabel(level) {
    return _t(LEVEL_LABELS[level] ?? LEVEL_LABELS[1])
}
window.levelLabel = levelLabel

/** Target of a channel's row: its id, a vocal channel's chat place id (null until it has one). */
export function overrideKey(id, type, serv = global.state.currentServer) {
    return type === "vocal" ? findChannel(id, "vocal", serv)?.chat ?? null : Number(id)
}

function overrideOf(target, category) {
    if (target == null) return null
    return (global.user?.notif_overrides || []).find(o => o.target === Number(target) && o.category === category) || null
}

const activeMute = (o) => o?.muted && (!o.muted_until || new Date(o.muted_until).getTime() > Date.now()) ? o : null

/** The channel's own mute in effect (its row), or null. */
export function channelOwnMute(id, type, serv = global.state.currentServer) {
    return activeMute(overrideOf(overrideKey(id, type, serv), false))
}
window.channelOwnMute = channelOwnMute

export function categoryMute(catId) {
    return activeMute(overrideOf(catId, true))
}
window.categoryMute = categoryMute

/** Muted by itself or by its category. */
export function isChannelMuted(id, type, serv = global.state.currentServer) {
    if (!NOTIF_TYPES.includes(type)) return false
    const category = findChannel(id, type, serv)?.category
    return !!(channelOwnMute(id, type, serv) || (category && categoryMute(category)))
}
window.isChannelMuted = isChannelMuted

export function serverLevel(serv = global.state.currentServer) {
    return global.user?.notif_prefs?.[String(serv?.id)]?.level ?? 1
}
window.serverLevel = serverLevel

/** Level set on the category itself, or null (it follows the server). */
export function categoryOwnLevel(catId) {
    return overrideOf(catId, true)?.level ?? null
}
window.categoryOwnLevel = categoryOwnLevel

export function categoryLevel(catId, serv = global.state.currentServer) {
    return categoryOwnLevel(catId) ?? serverLevel(serv)
}
window.categoryLevel = categoryLevel

/** Level set on the channel itself, or null (it follows its category / the server). */
export function channelOwnLevel(id, type, serv = global.state.currentServer) {
    return overrideOf(overrideKey(id, type, serv), false)?.level ?? null
}
window.channelOwnLevel = channelOwnLevel

/** What the channel follows without a level of its own. */
export function channelDefaultLevel(id, type, serv = global.state.currentServer) {
    const category = findChannel(id, type, serv)?.category
    return category ? categoryLevel(category, serv) : serverLevel(serv)
}
window.channelDefaultLevel = channelDefaultLevel

export function channelLevel(id, type, serv = global.state.currentServer) {
    return channelOwnLevel(id, type, serv) ?? channelDefaultLevel(id, type, serv)
}
window.channelLevel = channelLevel

/** {id, type} of the channel of a message place in a server: a text or forum channel,
 *  or the vocal channel whose chat it is. */
export function channelOfPlace(place, serverId) {
    const serv = global.servers?.[serverId]
    for (const type of ["textual", "forum"]) {
        if (findChannel(place, type, serv)) return {id: Number(place), type, serv}
    }
    const vocal = serv?.dirs?.vocals?.find(v => v.chat === Number(place))
    return vocal ? {id: vocal.id, type: "vocal", serv} : null
}

/** A message in this place makes no unread marker nor sound: muted, or "nothing". */
export function isPlaceSilenced(place, serverId) {
    const chan = channelOfPlace(place, serverId)
    if (!chan) return serverLevel(global.servers?.[serverId]) === 2
    return isChannelMuted(chan.id, chan.type, chan.serv) || channelLevel(chan.id, chan.type, chan.serv) === 2
}

/** "Muet jusqu'à 14:30" (a date when not today), or "Jusqu'à ce que tu le réactives". */
export function muteHint(mute) {
    if (!mute.muted_until) return _t("Jusqu'à ce que tu le réactives")
    const until = new Date(mute.muted_until)
    const time = until.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})
    const day = until.toDateString() === new Date().toDateString()
        ? "" : until.toLocaleDateString([], {day: "numeric", month: "short"}) + " "
    return _t("Muet jusqu'à") + " " + day + time
}
window.muteHint = muteHint

/** Earliest end of a timed mute still running (ms), or Infinity. */
export function nextMuteEnd() {
    const now = Date.now()
    return Math.min(...(global.user?.notif_overrides || [])
        .filter(o => o.muted && o.muted_until)
        .map(o => new Date(o.muted_until).getTime())
        .filter(t => t > now))
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** type: a channel type or "category"; params: {muted, minutes} / {level}. */
function setNotifOverride(type, id, params) {
    const query = new URLSearchParams({target_id: id, target_type: type, ...params})
    xhr(`set_notification_override?${query}`, function () {
        if (this.status !== 200) return
        const row = JSON.parse(this.responseText)
        if (type === "vocal") {
            const chan = findChannel(id, "vocal")
            if (chan) chan.chat = row.target   // its chat may have just been created
        }
        const rows = (global.user.notif_overrides || []).filter(o => !(o.target === row.target && o.category === row.category))
        if (row.muted || row.level != null) rows.push(row)
        setElement("global.user.notif_overrides", rows)
        window.applyChannelUnreads?.()
    }, "POST")
}

/** Mute for `minutes`, or until unmuted (null). */
window.muteTarget = (type, id, minutes) => setNotifOverride(type, id, minutes == null ? {muted: true} : {muted: true, minutes})
window.unmuteTarget = (type, id) => setNotifOverride(type, id, {muted: false})
/** level: 0 | 1 | 2, or "inherit". */
window.setNotifLevel = (type, id, level) => setNotifOverride(type, id, {level})
