// Channel & Category drag-and-drop for the server sidebar
// Uses the float-midpoint pattern (same as note blocks)

import {xhr} from "./framework/templating.mjs";
import {orderServDirs, lookFor} from "./crud.mjs";
import global from "./framework/global.mjs";

let draggedEl = null
let dragType = null   // "channel" or "cat"
let indicator = null

export function initDrag() {
    // handlers are inline on elements
}

// ─── Drag start ───────────────────────────────────────────────

function onSnippetDrag(e) {
    draggedEl = e.currentTarget
    dragType = draggedEl.dataset.type === "cat" ? "cat" : "channel"
    e.dataTransfer.effectAllowed = "move"
    e.dataTransfer.setData("text/plain", draggedEl.dataset.id)
    draggedEl.classList.add("dragging")
}
window.onSnippetDrag = onSnippetDrag

// ─── Drag over ────────────────────────────────────────────────

function allowSnippetDrop(e) {
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    if (!draggedEl) return

    const target = document.elementFromPoint(e.clientX, e.clientY)
    if (!target) return

    const selector = document.getElementById("server-selector")
    if (!selector || !selector.contains(target)) { removeIndicator(); return }

    // The actual container for .group/.conv elements is inside the Subscribe wrapper div
    const container = selector.firstElementChild || selector

    removeIndicator()

    if (dragType === "cat") {
        handleCatDragOver(e, target, container)
    } else {
        handleChannelDragOver(e, target, container)
    }
}
window.allowSnippetDrop = allowSnippetDrop

function handleCatDragOver(e, target, container) {
    // The dragged element is a .title inside a .group — find its parent .group to skip it
    const draggedGroup = draggedEl.closest('.group')

    // Walk top-level children of the container to find which one the cursor is over
    const children = [...container.children].filter(c => c !== draggedGroup && c !== indicator)
    if (children.length === 0) {
        container.appendChild(getIndicator())
        return
    }

    for (let i = 0; i < children.length; i++) {
        const child = children[i]
        const rect = child.getBoundingClientRect()
        if (e.clientY < rect.top + rect.height / 2) {
            container.insertBefore(getIndicator(), child)
            return
        }
    }
    // Past all children — append at end
    container.appendChild(getIndicator())
}

function handleChannelDragOver(e, target, container) {
    const conv = target.closest(".conv")
    const title = target.closest(".group > .title")
    const group = target.closest(".group")

    if (conv && conv !== draggedEl) {
        // Hovering over a channel item — above/below it
        const rect = conv.getBoundingClientRect()
        const mid = rect.top + rect.height / 2
        if (e.clientY < mid) {
            conv.parentElement.insertBefore(getIndicator(), conv)
        } else {
            if (conv.nextElementSibling) {
                conv.parentElement.insertBefore(getIndicator(), conv.nextElementSibling)
            } else {
                conv.parentElement.appendChild(getIndicator())
            }
        }
    } else if (title) {
        const isClosed = title.classList.contains("closed")
        const groupEl = title.parentElement
        const rect = title.getBoundingClientRect()
        const mid = rect.top + rect.height / 2

        if (isClosed) {
            // Closed category — always drop OUTSIDE (before/after the whole .group at container level)
            if (e.clientY < mid) {
                container.insertBefore(getIndicator(), groupEl)
            } else {
                insertAfter(getIndicator(), groupEl, container)
            }
        } else {
            // Open category — top third: before the group, bottom two-thirds: inside as first child
            const third = rect.top + rect.height / 3
            if (e.clientY < third) {
                container.insertBefore(getIndicator(), groupEl)
            } else {
                // Insert inside the group after the title
                if (title.nextElementSibling) {
                    groupEl.insertBefore(getIndicator(), title.nextElementSibling)
                } else {
                    groupEl.appendChild(getIndicator())
                }
            }
        }
    } else if (group && !conv && !title) {
        // Inside the body of an open group (empty area)
        group.appendChild(getIndicator())
    } else {
        // Bare container area (between top-level elements, or empty space)
        const children = [...container.children].filter(c => c !== indicator && c !== draggedEl)
        for (const child of children) {
            const rect = child.getBoundingClientRect()
            if (e.clientY < rect.top + rect.height / 2) {
                container.insertBefore(getIndicator(), child)
                return
            }
        }
        container.appendChild(getIndicator())
    }
}

// ─── Drop ─────────────────────────────────────────────────────

function dropSnippet(e) {
    e.preventDefault()
    if (!draggedEl || !indicator || !indicator.parentElement) { cleanup(); return }
    dropInList(global.state.currentServer.id)
    cleanup()
}
window.dropSnippet = dropSnippet

/**
 * The sidebar is one list per container: the top level (categories + channels without
 * category, crud.mjs orderServDirs) and each category (its channels, every type together).
 * The dropped item takes the midpoint of its new neighbours in that list, so a reorder
 * writes one place. The whole list is renumbered only when two neighbours share a place
 * or floats run out between them (normalizeIfNeeded), in the order shown.
 */
function dropInList(serverId) {
    const list = indicator.parentElement
    const dragged = dragType === "cat" ? categoryItem(draggedEl) : listItem(draggedEl)
    if (!dragged) return
    const items = listItems(list, dragged)
    const i = items.indexOf(dragged)
    const place = computePlace(items[i - 1]?.place ?? null, items[i + 1]?.place ?? null)

    const newCatId = list.classList.contains('group') ? Number(list.querySelector(':scope > .title')?.dataset.id) : null
    if (dragged.kind === "channel" && (dragged.ref.category || null) !== newCatId) {
        // Changing category changes what the channel inherits (its permissions): the
        // server may refuse it (manage-roles in the channel, manage-channels in the
        // destination). Ask first — with the new place, one request — and leave the
        // channel where it was if refused.
        const req = xhr(`edit_server_channel?server_id=${serverId}&targetId=${dragged.id}&channel_type=${dragged.type}&field=category&value=${newCatId || ''}&place=${place}`, undefined, "POST", false)
        if (req.status !== 200) {
            alert(_t("Tu ne peux pas déplacer ce salon dans cette catégorie : cela changerait ses permissions."))
            orderServDirs(global.state.currentServer)
            return
        }
        dragged.ref.category = newCatId
        dragged.ref.place = dragged.place = place
        renumberIfNeeded(items, serverId)
    } else {
        dragged.ref.place = dragged.place = place
        if (!renumberIfNeeded(items, serverId)) savePlace(dragged, place, serverId)
    }

    orderServDirs(global.state.currentServer)
    if (dragged.kind === "channel") window.updateComposerLock?.()   // the open channel may have changed rights
}

/** {kind, type, id, place, ref} of a top-level .group or a .conv; ref = the dirs object. */
function listItem(el) {
    if (el.matches('.group')) return categoryItem(el.querySelector(':scope > .title'))
    if (!el.matches('.conv')) return null
    const type = el.dataset.type === "conv" ? "textual" : el.dataset.type
    // Ids are per table (a forum and a text channel can share one): look in its own type
    const ref = getChannelArray(type)?.find(c => c.id == el.dataset.id)
    return ref ? {kind: "channel", type, id: ref.id, place: ref.place, ref} : null
}

function categoryItem(title) {
    const ref = title && lookFor(title.dataset.id, global.state.currentServer.dirs.cat)
    return ref ? {kind: "cat", id: ref.id, place: ref.place, ref} : null
}

/** The items of `list` in the order shown, the dragged one where the indicator is. */
function listItems(list, dragged) {
    const draggedGroup = dragType === "cat" ? draggedEl.closest('.group') : null
    const items = []
    for (const el of list.children) {
        if (el === indicator) items.push(dragged)
        else if (el !== draggedEl && el !== draggedGroup) {
            const item = listItem(el)
            if (item) items.push(item)
        }
    }
    return items
}

function savePlace(item, place, serverId) {
    if (item.kind === "cat") {
        xhr(`edit_server_category?server_id=${serverId}&targetId=${item.id}&field=place&value=${place}`)
    } else {
        xhr(`edit_server_channel?server_id=${serverId}&targetId=${item.id}&channel_type=${item.type}&field=place&value=${place}`)
    }
}

/** Renumber the whole list (every item, every type) when needed. `items` are in the order
 *  shown and normalizeIfNeeded's sort is stable: equal places keep that order. */
function renumberIfNeeded(items, serverId) {
    return normalizeIfNeeded(items, 'place', (item, val) => {
        item.ref.place = val
        savePlace(item, val, serverId)
    })
}

// ─── Helpers ──────────────────────────────────────────────────

function insertAfter(newNode, refNode, container) {
    if (refNode.nextElementSibling) {
        container.insertBefore(newNode, refNode.nextElementSibling)
    } else {
        container.appendChild(newNode)
    }
}

function getChannelArray(channelType) {
    const dirs = global.state.currentServer.dirs
    const map = { textual: dirs.channels, vocal: dirs.vocals, drive: dirs.drives, note: dirs.notes, forum: dirs.forums }
    return map[channelType] || null
}

// Steps of 1 at the ends, like the server's end-of-list places (routes/servers.py)
function computePlace(prevPlace, nextPlace) {
    if (prevPlace != null && nextPlace != null) return (prevPlace + nextPlace) / 2
    if (prevPlace != null) return prevPlace + 1
    if (nextPlace != null) return nextPlace - 1
    return 1
}

/**
 * If positions get too close, renormalize them all to 0.1, 0.2, 0.3...
 */
export function normalizeIfNeeded(items, posKey, saveCallback) {
    if (!items || items.length < 2) return false
    const sorted = [...items].sort((a, b) => a[posKey] - b[posKey])
    let needsNorm = false
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i][posKey] - sorted[i-1][posKey] < 0.0001) { needsNorm = true; break }
    }
    if (!needsNorm) return false
    sorted.forEach((item, i) => {
        item[posKey] = (i + 1) * 0.1
        if (saveCallback) saveCallback(item, item[posKey])
    })
    return true
}

function getIndicator() {
    if (!indicator) {
        indicator = document.createElement('div')
        indicator.className = 'drop-indicator'
    }
    return indicator
}

function removeIndicator() {
    if (indicator?.parentElement) indicator.remove()
}

function cleanup() {
    removeIndicator()
    if (draggedEl) {
        draggedEl.classList.remove('dragging')
        draggedEl = null
    }
    dragType = null
}

document.addEventListener('dragend', cleanup)
