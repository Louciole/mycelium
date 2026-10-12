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

    const id = parseInt(draggedEl.dataset.id)
    const serverId = global.state.currentServer.id

    if (dragType === "cat") {
        dropCategory(id, serverId)
    } else {
        dropChannel(id, serverId)
    }

    cleanup()
}
window.dropSnippet = dropSnippet

function dropCategory(catId, serverId) {
    const selector = document.getElementById("server-selector")
    const container = selector?.firstElementChild || selector

    const prevEl = findTopLevelSibling(indicator, 'previous', container, '.group')
    const nextEl = findTopLevelSibling(indicator, 'next', container, '.group')

    const newPlace = computePlace(getPlaceFromTopLevel(prevEl), getPlaceFromTopLevel(nextEl))

    const cat = lookFor(catId, global.state.currentServer.dirs.cat)
    if (cat) cat.place = newPlace

    const normalized = normalizeIfNeeded(global.state.currentServer.dirs.cat, 'place', (item, val) => {
        xhr(`edit_server_category?server_id=${serverId}&targetId=${item.id}&field=place&value=${val}`)
    })
    if (!normalized) {
        xhr(`edit_server_category?server_id=${serverId}&targetId=${catId}&field=place&value=${newPlace}`)
    }
    orderServDirs(global.state.currentServer)
}

function dropChannel(chanId, serverId) {
    // If indicator is inside a .group, the channel goes into that category
    const parentGroup = indicator.parentElement?.classList.contains('group')
        ? indicator.parentElement : null
    const newCatId = parentGroup
        ? parseInt(parentGroup.querySelector('.title')?.dataset.id)
        : null

    // Find neighbor .conv elements for position calculation
    const prevConv = findConvSibling(indicator, 'previous')
    const nextConv = findConvSibling(indicator, 'next')

    const newPlace = computePlace(
        prevConv ? parseFloat(prevConv.dataset.pos) : null,
        nextConv ? parseFloat(nextConv.dataset.pos) : null
    )

    const chanType = draggedEl.dataset.type
    const channelType = chanType === "conv" ? "textual" : chanType

    // Ids are per table (a forum and a text channel can share one): look in its own type
    const chan = getChannelArray(channelType)?.find(c => c.id == chanId)
    const oldCat = chan?.category
    if ((oldCat || null) !== (newCatId || null)) {
        // Changing category changes what the channel inherits (its permissions): the
        // server may refuse it (manage-roles in the channel, manage-channels in the
        // destination). Ask first, and leave the channel where it was if refused.
        const req = xhr(`edit_server_channel?server_id=${serverId}&targetId=${chanId}&channel_type=${channelType}&field=category&value=${newCatId || ''}`, undefined, "POST", false)
        if (req.status !== 200) {
            alert(_t("Tu ne peux pas déplacer ce salon dans cette catégorie : cela changerait ses permissions."))
            orderServDirs(global.state.currentServer)
            return
        }
    }

    if (chan) {
        chan.place = newPlace
        chan.category = newCatId
    }

    // Normalize channels sharing the same category to avoid float precision loss
    const channelArr = getChannelArray(channelType)
    const siblingsInCat = channelArr?.filter(c => (c.category || null) === (newCatId || null))
    const normalized = normalizeIfNeeded(siblingsInCat, 'place', (item, val) => {
        xhr(`edit_server_channel?server_id=${serverId}&targetId=${item.id}&channel_type=${channelType}&field=place&value=${val}`)
    })
    if (!normalized) {
        xhr(`edit_server_channel?server_id=${serverId}&targetId=${chanId}&channel_type=${channelType}&field=place&value=${newPlace}`)
    }

    orderServDirs(global.state.currentServer)
    window.updateComposerLock?.()   // the open channel may have changed rights
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

function computePlace(prevPlace, nextPlace) {
    if (prevPlace != null && nextPlace != null) return (prevPlace + nextPlace) / 2
    if (prevPlace != null) return prevPlace + 0.1
    if (nextPlace != null) return nextPlace / 2
    return 0.1
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

/**
 * Find the nearest sibling .conv, crossing .group boundaries if needed.
 * Skips the currently dragged element so its stale position isn't used.
 */
function findConvSibling(el, direction) {
    const prop = direction === 'previous' ? 'previousElementSibling' : 'nextElementSibling'

    function firstValidConv(convs) {
        const arr = [...convs].filter(c => c !== draggedEl)
        return direction === 'previous' ? arr[arr.length - 1] : arr[0]
    }

    let sibling = el[prop]
    while (sibling) {
        if (sibling.matches('.conv') && sibling !== draggedEl) return sibling
        if (sibling.matches('.group')) {
            const match = firstValidConv(sibling.querySelectorAll('.conv'))
            if (match) return match
        }
        sibling = sibling[prop]
    }
    // If inside a .group, continue searching at the container level
    const parent = el.parentElement
    if (parent?.classList.contains('group')) {
        let groupSibling = parent[prop]
        while (groupSibling) {
            if (groupSibling.matches('.conv') && groupSibling !== draggedEl) return groupSibling
            if (groupSibling.matches('.group')) {
                const match = firstValidConv(groupSibling.querySelectorAll('.conv'))
                if (match) return match
            }
            groupSibling = groupSibling[prop]
        }
    }
    return null
}

function findTopLevelSibling(el, direction, container, selector) {
    const prop = direction === 'previous' ? 'previousElementSibling' : 'nextElementSibling'
    const draggedGroup = draggedEl?.closest('.group')
    let sibling = el[prop]
    while (sibling) {
        if (sibling !== indicator && sibling !== draggedGroup && sibling !== draggedEl) {
            if (selector) {
                if (sibling.matches(selector)) return sibling
            } else if (sibling.matches('.group') || sibling.matches('.conv')) {
                return sibling
            }
        }
        sibling = sibling[prop]
    }
    return null
}

function getPlaceFromTopLevel(el) {
    if (!el) return null
    if (el.matches('.group')) {
        const title = el.querySelector('.title')
        return title ? parseFloat(title.dataset.pos) : null
    }
    return el.dataset.pos ? parseFloat(el.dataset.pos) : null
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
