// Right-click menus of the server sidebar: a channel's (templates/channel-menu-channel.html)
// and a category's (channel-menu-category.html), with their submenus (channel-menu-mute,
// -notif, -move). The templates decide what shows from the user's rights (access.mjs, the
// mirror of the server's checks); this module holds the open menu, places it, and acts.

import global from "./framework/global.mjs"
import {setElement} from "./framework/vesta.mjs"
import {closeFM} from "./framework/navigation.mjs"
import {xhr} from "./framework/templating.mjs"
import {orderServDirs, loadServer} from "./crud.mjs"
import {channelTypeOf} from "./channel-permissions.mjs"
import {channelLink} from "./routes.mjs"

const DIR_KEYS = ["channels", "vocals", "drives", "notes", "forums"]

// ── What the templates ask ───────────────────────────────────────────────────

/** A text channel with unread messages (the only type with an unread marker). */
function isChannelUnread(id) {
    return (global.user?.channel_unreads || []).some(u => u.channel === Number(id))
}
window.isChannelUnread = isChannelUnread

/** The category's text channels with unread messages. */
function categoryUnreads(catId) {
    return (global.state.currentServer?.dirs?.channels || []).filter(c => c.category === Number(catId) && isChannelUnread(c.id))
}
window.categoryUnreads = categoryUnreads

/**
 * [{id, name}] where the channel may go (id null: out of any category). Changing category
 * changes what it inherits: the server wants manage-channels + manage-roles in it and
 * manage-channels in the destination (servers.py _require_category_move).
 */
function moveDestinations(id, type) {
    const chan = findChannel(id, type)
    if (!chan || !checkChannelRight(id, type, "manage-channels") || !checkChannelRight(id, type, "manage-roles")) return []
    const destinations = [...(global.state.currentServer.dirs.cat || [])]
        .sort((a, b) => a.place - b.place)
        .filter(cat => cat.id !== chan.category && checkChannelRight(cat.id, "category", "manage-channels"))
        .map(cat => ({id: cat.id, name: cat.name}))
    if (chan.category) destinations.unshift({id: null, name: _t("Sans catégorie")})
    return destinations
}
window.moveDestinations = moveDestinations

/** manage-channels where the copy goes (its category, else the server) and manage-roles in
 *  it, its overwrites being copied (servers.py _duplicate_channel). */
function canDuplicateChannel(id, type) {
    const category = findChannel(id, type)?.category
    const here = category ? checkChannelRight(category, "category", "manage-channels") : checkServRights("manage-channels")
    return here && checkChannelRight(id, type, "manage-roles")
}
window.canDuplicateChannel = canDuplicateChannel

// ── Collapsed categories (per server, on this device) ────────────────────────

function collapsedCategories(serverId = global.state.currentServer?.id) {
    try {
        return JSON.parse(localStorage.getItem("collapsed_cats_" + serverId)) || []
    } catch (e) {
        return []
    }
}

function isCategoryCollapsed(catId) {
    return collapsedCategories().includes(Number(catId))
}
window.isCategoryCollapsed = isCategoryCollapsed

/** Saves them, and folds the sidebar to match (server-category.html reads them on repaint). */
function setCollapsedCategories(ids) {
    try { localStorage.setItem("collapsed_cats_" + global.state.currentServer?.id, JSON.stringify(ids)) } catch (e) { /* private mode */ }
    document.querySelectorAll('#server-selector .title[data-type="cat"]')
        .forEach(title => title.classList.toggle("closed", ids.includes(Number(title.dataset.id))))
}

window.toggleCategory = (catId) => {
    const ids = collapsedCategories().filter(id => id !== Number(catId))
    setCollapsedCategories(isCategoryCollapsed(catId) ? ids : [...ids, Number(catId)])
}
window.collapseAllCategories = () => setCollapsedCategories((global.state.currentServer?.dirs?.cat || []).map(cat => cat.id))

// ── Actions ──────────────────────────────────────────────────────────────────

window.markCategoryRead = (catId) => categoryUnreads(catId).forEach(chan => markChannelRead(chan.id))

let toastTimer
function showToast(text) {
    setElement("global.state.toast", text)
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => setElement("global.state.toast", null), 2000)
}

window.copyChannelLink = (id, type) => {
    navigator.clipboard.writeText(channelLink(global.state.currentServer.id, type, id))
        .then(() => showToast(_t("Lien copié")))
}

window.inviteToChannel = (id, type) => createInvitation({id, type})

/** The copy shows up with the server reload (the other members' too, over the WebSocket). */
window.duplicateChannel = (id, type) => {
    const serv = global.state.currentServer
    xhr(`edit_server_channel?server_id=${serv.id}&action=duplicate&targetId=${id}&channel_type=${type}`, function () {
        if (this.status === 200 && global.state.currentServer === serv) loadServer(serv.id)
    }, "POST")
}

/** Place after the last item of a sidebar list: the top level (categories + channels
 *  shown outside one, crud.mjs sidebarOrder) or a category. */
function endOfList(serv, categoryId) {
    const channels = DIR_KEYS.flatMap(key => serv.dirs[key] || [])
    const places = categoryId == null
        ? [...(serv.dirs.cat || []), ...channels.filter(c => !c.category || !findChannel(c.category, "category", serv))].map(x => x.place)
        : channels.filter(c => c.category === categoryId).map(c => c.place)
    return places.length ? Math.max(...places) + 1 : 1
}

/** One request: its category and its place at the end of that list (like a drop, drag.mjs). */
window.moveChannel = (id, type, categoryId) => {
    const serv = global.state.currentServer
    const chan = findChannel(id, type)
    if (!serv || !chan) return
    const place = endOfList(serv, categoryId)
    xhr(`edit_server_channel?server_id=${serv.id}&targetId=${id}&channel_type=${type}&field=category&value=${categoryId ?? ""}&place=${place}`, function () {
        if (this.status !== 200) {
            uiAlert(_t("Tu ne peux pas déplacer ce salon dans cette catégorie : cela changerait ses permissions."))
            return
        }
        chan.category = categoryId
        chan.place = place
        if (global.state.currentServer !== serv) return
        orderServDirs(serv)
        window.updateComposerLock?.()   // the open channel may have changed rights
        setTimeout(() => window.applyChannelUnreads?.(), 0)
    }, "POST")
}

// ── The open menu: global.state.channelMenu ──────────────────────────────────
// {kind: "channel" | "category", id, type, x, y, sub: {name, x, y} | null, panel: name | null}

window.channelMenuHtml = () => global.state.channelMenu ? fillWith("channel-menu", [global.state.channelMenu]) : ""

const MARGIN = 8

/** `pos` moved back so that `size` fits before `max`. */
const fit = (pos, size, max) => pos + size > max - MARGIN ? Math.max(MARGIN, max - size - MARGIN) : pos

function render() {
    setElement("global.state.channelMenu", global.state.channelMenu)
}

/** Repaint, then pull the menu (and its submenu) back inside the viewport: their size is
 *  only known once painted. A submenu that can't fit on the right opens on the left. */
function renderInViewport() {
    render()
    const menu = global.state.channelMenu
    const main = document.getElementById("channel-menu")?.getBoundingClientRect()
    if (!menu || !main) return
    let moved = false
    const x = fit(menu.x, main.width, window.innerWidth), y = fit(menu.y, main.height, window.innerHeight)
    if (x !== menu.x || y !== menu.y) {
        Object.assign(menu, {x, y})
        moved = true
    }
    const subEl = document.querySelector(".ctx-submenu")
    if (menu.sub && subEl) {
        const sub = subEl.getBoundingClientRect()
        const right = x + main.width + 4
        const subX = right + sub.width > window.innerWidth - MARGIN ? Math.max(MARGIN, x - sub.width - 4) : right
        const subY = fit(menu.sub.y, sub.height, window.innerHeight)
        if (subX !== menu.sub.x || subY !== menu.sub.y) {
            Object.assign(menu.sub, {x: subX, y: subY})
            moved = true
        }
    }
    if (moved) render()
}

function openSidebarMenu(event, kind, id, type) {
    event.preventDefault()
    event.stopPropagation()
    closeFM()
    const el = event.currentTarget
    // The settings opened from the menu read their channel / category from it
    global.state.modaltarget = el
    // Opened from the keyboard (context menu key): under the item, not at 0,0
    const rect = el.getBoundingClientRect()
    const fromKeyboard = !event.clientX && !event.clientY
    global.state.channelMenu = {kind, id, type, sub: null, panel: null,
        x: fromKeyboard ? rect.left : event.clientX, y: fromKeyboard ? rect.bottom : event.clientY}
    renderInViewport()
}

/** Right-click on a channel of the sidebar (server-*-channel.html). */
window.openChannelMenu = (event) => {
    const el = event.currentTarget
    openSidebarMenu(event, "channel", Number(el.dataset.id), channelTypeOf(el))
}

/** Right-click on a category title (server-category.html). */
window.openCategoryMenu = (event) => openSidebarMenu(event, "category", Number(event.currentTarget.dataset.id), "category")

function closeChannelMenu(event) {
    event?.stopPropagation()
    if (global.state.channelMenu) setElement("global.state.channelMenu", null)
}
window.closeChannelMenu = closeChannelMenu

/** Desktop: the submenu flies out next to its item. Mobile: it replaces the menu, with a back row. */
function openChannelSubmenu(event, name) {
    const menu = global.state.channelMenu
    if (!menu || menu.sub?.name === name || menu.panel === name) return
    if (global.state.isMobile) {
        menu.panel = name
        menu.sub = null
    } else {
        const main = document.getElementById("channel-menu").getBoundingClientRect()
        menu.sub = {name, x: main.right + 4, y: event.currentTarget.getBoundingClientRect().top - 6}
    }
    renderInViewport()
}
window.openChannelSubmenu = openChannelSubmenu

function closeChannelSubmenu(event) {
    event?.stopPropagation()
    const menu = global.state.channelMenu
    if (!menu || (!menu.sub && !menu.panel)) return
    menu.sub = null
    menu.panel = null
    renderInViewport()
}
window.closeChannelSubmenu = closeChannelSubmenu

/** Hovering an item of the menu opens its submenu (`name`), or closes the one open. */
window.hoverChannelMenu = (event, name) => {
    if (global.state.isMobile) return
    if (name) openChannelSubmenu(event, name)
    else closeChannelSubmenu()
}

if (!window._myceliumChannelMenu) {
    window._myceliumChannelMenu = true
    // A click, right-click or scroll outside the menu closes it, so does Escape
    const outside = (event) => global.state.channelMenu && !event.target?.closest?.(".ctx-menu")
    document.addEventListener("click", (event) => { if (outside(event)) closeChannelMenu() })
    document.addEventListener("contextmenu", (event) => { if (outside(event)) closeChannelMenu() })
    document.addEventListener("scroll", (event) => { if (outside(event)) closeChannelMenu() }, true)
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && global.state.channelMenu) closeChannelMenu()
    })
    window.addEventListener("resize", () => closeChannelMenu())
}
