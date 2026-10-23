import global from "/static/framework/global.mjs"

// ─── Mention Autocomplete System ─────────────────────────────────────────────
// Detects @/# triggers in the textarea, shows a popup with matching
// users / roles / channels, and inserts the raw-ID token on selection.

let autocompletePopup = null
let currentTrigger = null   // '@' or '#'
let triggerStart = -1       // caret position where the trigger char was typed
let selectedIndex = 0
let candidates = []

// Expose a way for sendMessage to know the popup is active
window.isMentionAutocompleteOpen = function() {
    return autocompletePopup && autocompletePopup.style.display !== "none" && candidates.length > 0
}

// ─── Candidate building ──────────────────────────────────────────────────────

function buildUserCandidates(query) {
    const results = []
    const q = query.toLowerCase()

    // Always offer @everyone and @here first (server-only)
    if (global.state?.isServer) {
        if ("everyone".startsWith(q)) results.push({ type: "everyone", display: "everyone", sub: "Notify all members" })
        if ("here".startsWith(q)) results.push({ type: "here", display: "here", sub: "Notify online members" })
    }

    // Roles (server-only)
    if (global.state?.isServer && global.state?.currentServer?.roles) {
        for (const rid in global.state.currentServer.roles) {
            const role = global.state.currentServer.roles[rid]
            if (role.name.toLowerCase().includes(q)) {
                results.push({ type: "role", id: rid, display: role.name, color: role.color, sub: "Role" })
            }
        }
    }

    // Users – in a server, use the member list; in a DM, use conv members
    const userIds = new Set()
    if (global.state?.isServer && global.state?.currentServer?.members) {
        for (const uid in global.state.currentServer.members) userIds.add(parseInt(uid))
    } else if (global.state?.activeConv && global.convs?.[global.state.activeConv]?.members) {
        for (const uid of global.convs[global.state.activeConv].members) userIds.add(parseInt(uid))
    }

    for (const uid of userIds) {
        const user = global.users[uid]
        if (!user) continue
        const match = (user.display || "").toLowerCase().includes(q) || (user.username || "").toLowerCase().includes(q)
        if (match) {
            results.push({ type: "user", id: uid, display: user.display, username: user.username, pfp: user.pfp })
        }
    }

    return results.slice(0, 15)
}

// Text channels, forums, notes and drives; "#drive/folder/…" browses inside a
// drive (static/drive-links.mjs). The token names the channel type when its ids
// may collide with textual ones ("<#notes:7>", "<#drive:12>").
const MENTIONABLE = [["channels", "hashtag"], ["forums", "inbox"], ["notes", "note"], ["drives", "folder"]]

function buildChannelCandidates(query) {
    const dirs = global.state?.currentServer?.dirs
    if (!global.state?.isServer || !dirs) return []
    if (query.includes("/")) return window.driveMentionCandidates?.(query, refreshMentionPopup) || []
    const q = query.toLowerCase()
    const results = []
    for (const [key, icon] of MENTIONABLE) {
        for (const ch of dirs[key] || []) {
            if (!ch.name.toLowerCase().includes(q)) continue
            results.push({ type: "channel", id: ch.id, display: ch.name, icon,
                           token: window.channelToken(key, ch.id),
                           browse: key === "drives" ? ch.name + "/" : undefined })
        }
    }
    return results.slice(0, 15)
}

// Finds the "#…" being typed before the caret: stops at a space, unless the
// query already browses a drive of the server ("#travail/S9 — projets/rap").
function findChannelTrigger(text) {
    const i = text.lastIndexOf("#")
    if (i < 0 || i < text.lastIndexOf("\n") || text.length - i > 101) return -1
    if (i > 0 && text[i - 1] === "<") return -1
    const query = text.slice(i + 1)
    if (!/\s/.test(query)) return i
    const slash = query.indexOf("/")
    if (slash < 0) return -1
    const drive = query.slice(0, slash).toLowerCase()
    return (global.state?.currentServer?.dirs?.drives || []).some(d => d.name.toLowerCase() === drive) ? i : -1
}

// A drive listing arrived (drive-links.mjs browse): run the autocomplete again
// on the field being typed in (the popup closed while the listing loaded).
function refreshMentionPopup() {
    const el = document.activeElement
    if (el?.matches?.(".chat-input textarea")) window.mentionOnInput({ currentTarget: el })
    else if (el?.isContentEditable && el.closest("[data-block-id]")) window.mentionNoteOnInput(null, { currentTarget: el })
}

// ─── Popup rendering ─────────────────────────────────────────────────────────

function createPopupIfNeeded(textarea) {
    if (autocompletePopup) return
    autocompletePopup = document.createElement("div")
    autocompletePopup.className = "mention-autocomplete"
    // Insert in the same flex column as the chat-wrapper, just before it
    const wrapper = textarea.closest(".chat-wrapper")
    if (wrapper && wrapper.parentElement) {
        wrapper.parentElement.insertBefore(autocompletePopup, wrapper)
    } else {
        textarea.parentElement.appendChild(autocompletePopup)
    }
}

function renderPopup() {
    if (!autocompletePopup) return
    if (candidates.length === 0) {
        closePopup()
        return
    }

    let html = ""
    candidates.forEach((c, i) => {
        const selected = i === selectedIndex ? "selected" : ""
        switch (c.type) {
            case "user":
                html += `<div class="mention-ac-item ${selected}" data-index="${i}" onmousedown="mentionSelect(${i})">
                    <div class="mention-ac-avatar" style="${c.pfp ? "background-image:url(/static/attachments/" + escapeHTML(c.pfp) + ")" : ""}"></div>
                    <div class="mention-ac-info">
                        <span class="mention-ac-name">${escapeHTML(c.display)}</span>
                        <span class="mention-ac-sub">${escapeHTML(c.username || "")}</span>
                    </div>
                </div>`
                break
            case "role":
                html += `<div class="mention-ac-item ${selected}" data-index="${i}" onmousedown="mentionSelect(${i})">
                    <div class="mention-ac-dot" style="background:${escapeHTML(c.color || "#A8A8A8")}"></div>
                    <div class="mention-ac-info">
                        <span class="mention-ac-name">${escapeHTML(c.display)}</span>
                        <span class="mention-ac-sub">Role</span>
                    </div>
                </div>`
                break
            case "channel":
                html += `<div class="mention-ac-item ${selected}" data-index="${i}" onmousedown="mentionSelect(${i})">
                    <img class="mention-ac-icon" src="/static/icons/material/${c.icon || "hashtag"}.svg"/>
                    <div class="mention-ac-info">
                        <span class="mention-ac-name">${escapeHTML(c.display)}</span>
                        ${c.sub ? `<span class="mention-ac-sub">${escapeHTML(c.sub)}</span>` : ""}
                    </div>
                </div>`
                break
            case "everyone":
            case "here":
                html += `<div class="mention-ac-item ${selected}" data-index="${i}" onmousedown="mentionSelect(${i})">
                    <div class="mention-ac-dot" style="background:#faa61a"></div>
                    <div class="mention-ac-info">
                        <span class="mention-ac-name">@${c.display}</span>
                        <span class="mention-ac-sub">${c.sub}</span>
                    </div>
                </div>`
                break
        }
    })

    autocompletePopup.innerHTML = html
    autocompletePopup.style.display = "flex"
}

function closePopup() {
    if (autocompletePopup) {
        autocompletePopup.style.display = "none"
        autocompletePopup.innerHTML = ""
        autocompletePopup.remove()
        autocompletePopup = null
    }
    currentTrigger = null
    triggerStart = -1
    candidates = []
    selectedIndex = 0
}

// ─── Selection ───────────────────────────────────────────────────────────────

function selectCandidate(textarea, index) {
    const c = candidates[index]
    if (!c) return

    let insertText = ""
    switch (c.type) {
        case "user":     insertText = `<@${c.id}>`; break
        case "role":     insertText = `<@&${c.id}>`; break
        case "channel":  insertText = c.token || `<#${c.id}>`; break
        case "everyone": insertText = `<@everyone>`; break
        case "here":     insertText = `<@here>`; break
    }

    // Replace from triggerStart (the '@' or '#') to the current caret
    const before = textarea.value.substring(0, triggerStart)
    const after = textarea.value.substring(textarea.selectionEnd)
    textarea.value = before + insertText + " " + after

    // Place caret right after inserted token
    const newPos = before.length + insertText.length + 1
    textarea.selectionStart = textarea.selectionEnd = newPos

    closePopup()
}

// "#trav" + Tab on the drive "travail" → "#travail/", listing its root.
function browseCandidate(textarea, c) {
    const before = textarea.value.substring(0, triggerStart + 1)
    const after = textarea.value.substring(textarea.selectionEnd)
    textarea.value = before + c.browse + after
    textarea.selectionStart = textarea.selectionEnd = before.length + c.browse.length
    candidates = buildChannelCandidates(c.browse)
    selectedIndex = 0
    renderPopup()
}

window.mentionSelect = function(index) {
    if (activeBlockEl) {
        selectNoteCandidate(index)
    } else {
        const textarea = document.querySelector(".chat-input textarea")
        if (textarea) selectCandidate(textarea, index)
    }
}

// ─── Note block (contenteditable) autocomplete ───────────────────────────────

let activeBlockEl = null

function getTextBeforeCaret(el) {
    const sel = window.getSelection()
    if (!sel.rangeCount) return ''
    const range = sel.getRangeAt(0).cloneRange()
    range.setStart(el, 0)
    return range.toString()
}

function createPopupForNoteBlock(blockEl) {
    if (!autocompletePopup) {
        autocompletePopup = document.createElement("div")
        autocompletePopup.className = "mention-autocomplete"
        document.body.appendChild(autocompletePopup)
    }
    // Always reposition — popup may be reused when quickly switching blocks
    const rect = blockEl.getBoundingClientRect()
    Object.assign(autocompletePopup.style, {
        position: "fixed",
        left: rect.left + "px",
        top: (rect.bottom + 4) + "px",
        width: Math.min(320, Math.max(200, rect.width)) + "px",
    })
}

// Maps a visible-text cursor offset (from getTextBeforeCaret) to the
// equivalent offset in the raw markdown source (blockToRawContent).
// Mention spans contribute their token length to raw but their visible
// text length to the text offset.
function textOffsetToRawOffset(el, textOffset) {
    let textSeen = 0
    let rawSeen = 0

    function walk(node) {
        if (textSeen >= textOffset) return true
        if (node.nodeType === Node.TEXT_NODE) {
            const take = Math.min(node.textContent.length, textOffset - textSeen)
            textSeen += take
            rawSeen += take
            return textSeen >= textOffset
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return false

        const cls = node.classList
        let token = null
        if (cls.contains('mention-channel'))       token = `<#${node.dataset.channelId}>`
        else if (cls.contains('mention-user'))     token = `<@${node.dataset.mentionId}>`
        else if (cls.contains('mention-role'))     token = `<@&${node.dataset.mentionId}>`
        else if (cls.contains('mention-everyone')) token = '<@everyone>'
        else if (cls.contains('mention-here'))     token = '<@here>'

        if (token !== null) {
            // Cursor inside a mention span → treat as landing at end of raw token
            textSeen += Math.min(node.textContent.length, textOffset - textSeen)
            rawSeen += token.length
            return textSeen >= textOffset
        }
        for (const child of node.childNodes) {
            if (walk(child)) return true
        }
        return false
    }

    for (const child of el.childNodes) {
        if (walk(child)) break
    }
    return rawSeen
}

function restoreCursorInBlock(el, caretOffset) {
    const sel = window.getSelection()
    const range = document.createRange()
    let current = 0
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
        const len = node.textContent.length
        if (current + len >= caretOffset) {
            range.setStart(node, caretOffset - current)
            range.collapse(true)
            sel.removeAllRanges()
            sel.addRange(range)
            return
        }
        current += len
    }
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
}

function selectNoteCandidate(index) {
    const c = candidates[index]
    if (!c || !activeBlockEl) return
    if (c.type !== 'channel') return

    const insertToken = `${c.token || `<#${c.id}>`} `

    // Work in raw-content space so existing mention spans are not corrupted
    const rawContent = window.blockToRawContent(activeBlockEl)
    const textBefore = getTextBeforeCaret(activeBlockEl)
    const rawTriggerPos = textOffsetToRawOffset(activeBlockEl, triggerStart)
    const rawCursorPos  = textOffsetToRawOffset(activeBlockEl, textBefore.length)

    const rawPrefix = rawContent.substring(0, rawTriggerPos)
    const newRawContent = rawPrefix + insertToken + rawContent.substring(rawCursorPos)

    const blockContainerEl = activeBlockEl.closest('[data-block-id]')
    const blockId = blockContainerEl?.dataset.blockId
    if (blockId && global.state.noteEditor?.blocks[blockId]) {
        global.state.noteEditor.blocks[blockId].content = newRawContent
        global.state.noteEditor.saveBlock(blockId)   // an edit like any other (notes CRDT)
        activeBlockEl.innerHTML = window.MDToPreview(newRawContent)

        // Find the inserted span: it's the (N+1)-th .mention-channel where N is
        // the number of <#id> tokens already in rawPrefix
        const prevCount = (rawPrefix.match(/<#[^>\s]+>/g) || []).length
        const spans = activeBlockEl.querySelectorAll('.mention-channel')
        const targetSpan = spans[prevCount]
        if (targetSpan) {
            const sel = window.getSelection()
            const after = document.createRange()
            const next = targetSpan.nextSibling
            if (next?.nodeType === Node.TEXT_NODE) {
                after.setStart(next, Math.min(1, next.textContent.length))
            } else {
                after.setStartAfter(targetSpan)
            }
            after.collapse(true)
            sel.removeAllRanges()
            sel.addRange(after)
        } else {
            restoreCursorInBlock(activeBlockEl, rawPrefix.length + insertToken.length)
        }
    }

    const savedEl = activeBlockEl
    closePopup()
    activeBlockEl = null
    savedEl.focus()
}

window.mentionNoteOnInput = function(blockId, event) {
    if (!global.state?.isServer) { closePopup(); activeBlockEl = null; return }

    const el = event.currentTarget
    const textBefore = getTextBeforeCaret(el)

    // A run of only '#' at the very start of a block is a heading initiator,
    // not a channel link — let the note editor show its block/heading selector.
    if (/^#+$/.test(textBefore)) { closePopup(); activeBlockEl = null; return }

    const i = findChannelTrigger(textBefore)
    if (i < 0) { closePopup(); activeBlockEl = null; return }
    currentTrigger = '#'
    triggerStart = i

    const query = textBefore.substring(triggerStart + 1)

    activeBlockEl = el
    createPopupForNoteBlock(el)
    candidates = buildChannelCandidates(query)
    selectedIndex = 0
    renderPopup()
}

window.mentionNoteOnKeyDown = function(blockId, event) {
    if (!autocompletePopup || autocompletePopup.style.display === "none" || candidates.length === 0) return false

    switch (event.key) {
        case "ArrowDown":
            event.preventDefault()
            selectedIndex = (selectedIndex + 1) % candidates.length
            renderPopup()
            return true
        case "ArrowUp":
            event.preventDefault()
            selectedIndex = (selectedIndex - 1 + candidates.length) % candidates.length
            renderPopup()
            return true
        case "Tab":
        case "Enter":
            event.preventDefault()
            event.stopPropagation()
            selectNoteCandidate(selectedIndex)
            return true
        case "Escape":
            event.preventDefault()
            closePopup()
            activeBlockEl = null
            return true
    }
    return false
}

window.mentionNoteOnBlur = function() {
    // Capture current popup and block so the deferred close is a no-op if
    // another popup has already opened (e.g. user moved to the chat input).
    const popupAtBlur = autocompletePopup
    const blockAtBlur = activeBlockEl
    setTimeout(() => {
        if (autocompletePopup === popupAtBlur) closePopup()
        if (activeBlockEl === blockAtBlur) activeBlockEl = null
    }, 150)
}

// ─── Click handler for user mentions in rendered messages ────────────────────
window.mentionUserClick = function(uid, event) {
    if (typeof toggleProfileInfo === 'function' && event) {
        toggleProfileInfo(uid, event)
    }
}

// ─── Global event handlers (called from template inline attributes) ──────────

/**
 * Called from textarea oninput — detects @/# triggers and shows autocomplete
 */
window.mentionOnInput = function(event) {
    const textarea = event.currentTarget
    const val = textarea.value
    const caret = textarea.selectionEnd

    // Walk backwards from caret to find a trigger
    let i = caret - 1
    while (i >= 0) {
        const ch = val[i]
        if (ch === ' ' || ch === '\n') { i = -1; break }
        if (ch === '@' || ch === '#') {
            // Don't trigger if preceded by '<' (already a raw-ID token being typed naturally – shouldn't happen from user, but be safe)
            if (i > 0 && val[i - 1] === '<') { closePopup(); return }
            currentTrigger = ch
            triggerStart = i
            break
        }
        i--
    }
    // A "#drive/folder name/…" query may contain spaces
    if (i < 0) {
        i = findChannelTrigger(val.substring(0, caret))
        if (i < 0) { closePopup(); return }
        currentTrigger = '#'
        triggerStart = i
    }

    const query = val.substring(triggerStart + 1, caret)
    if (query.length > 100 || (currentTrigger === '@' && query.length > 30)) { closePopup(); return }

    createPopupIfNeeded(textarea)

    if (currentTrigger === '@') {
        candidates = buildUserCandidates(query)
    } else {
        candidates = buildChannelCandidates(query)
    }

    selectedIndex = 0
    renderPopup()
}

/**
 * Called from textarea onkeydown — navigates the autocomplete with arrows, selects with Enter/Tab
 * Returns true if the event was consumed (caller should not process further)
 */
window.mentionOnKeyDown = function(event) {
    if (!autocompletePopup || autocompletePopup.style.display === "none" || candidates.length === 0) return false

    switch (event.key) {
        case "ArrowDown":
            event.preventDefault()
            selectedIndex = (selectedIndex + 1) % candidates.length
            renderPopup()
            return true
        case "ArrowUp":
            event.preventDefault()
            selectedIndex = (selectedIndex - 1 + candidates.length) % candidates.length
            renderPopup()
            return true
        case "Tab":
        case "Enter":
            event.preventDefault()
            event.stopPropagation()
            if (event.key === "Tab" && candidates[selectedIndex]?.browse) {
                browseCandidate(event.currentTarget, candidates[selectedIndex])
                return true
            }
            selectCandidate(event.currentTarget, selectedIndex)
            return true
        case "Escape":
            event.preventDefault()
            closePopup()
            return true
    }
    return false
}

/**
 * Called from textarea onblur — closes the popup with a delay (so mousedown on items fires first)
 */
window.mentionOnBlur = function() {
    const popupAtBlur = autocompletePopup
    setTimeout(() => { if (autocompletePopup === popupAtBlur) closePopup() }, 150)
}



