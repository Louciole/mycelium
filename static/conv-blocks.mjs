import global from "./framework/global.mjs"
import {xhr} from "./framework/templating.mjs"
import {handleMessageGroup} from "./crud.mjs"
import {addElement, setElement, generateUUID} from "./framework/vesta.mjs"
import {mountSpreadsheet} from "./workspaces/spreadsheet.mjs"

// Interactive blocks posted in a conversation ("Insert a block").
// The server only stores them (routes/conv_blocks.py: JSON settings and items,
// versions, access): the block types live here. This module offers them in the
// picker, says what a new one starts with, checks every change before sending
// it, works out what tricounts and checklists show (the markup is in
// templates/cb-*.html and block-picker-*.html) and keeps them in sync
// (`conv_block_changed`, see ws/onMessage.mjs).

// ── Picker catalogue (templates/create-block.html, block-picker-*.html) ─────
// `cat`: the picker column; `featured` also lists it under "Featured".
const BLOCK_CATEGORIES = [
    {id: "featured", label: "Featured", icon: "heart"},
    {id: "money", label: "Money", icon: "dashboard"},
    {id: "organize", label: "Organize", icon: "check"},
    {id: "games", label: "Games", icon: "trophy"},
    {id: "empty", label: "Empty blocks", icon: "grid"},
]

const BLOCK_OPTIONS = [
    {type: "tricount", template: "default", cat: "money", featured: true, icon: "group", tint: "green",
        name: "Tricount", desc: "Who paid, who owes whom", keywords: "money expenses share split dépenses"},
    {type: "spreadsheet", template: "budget", cat: "money", icon: "dashboard", tint: "green",
        name: "Budget", desc: "Planned vs actual, with totals", keywords: "money budget sheet"},
    {type: "checklist", template: "potluck", cat: "organize", featured: true, icon: "food", tint: "orange",
        name: "Who brings what?", desc: "Everyone takes on something to bring", keywords: "party potluck soirée apéro"},
    {type: "checklist", template: "groceries", cat: "organize", featured: true, icon: "list", tint: "orange",
        name: "Shopping list", desc: "Tick items as they land in the cart", keywords: "shopping groceries courses"},
    {type: "checklist", template: "empty", cat: "organize", icon: "check", tint: "accent",
        name: "To-do list", desc: "Tasks the whole conversation can tick", keywords: "todo tasks checklist"},
    {action: "poll", cat: "organize", icon: "poll", tint: "accent",
        name: "Poll", desc: "Ask a question, collect votes", keywords: "poll vote sondage"},
    {type: "spreadsheet", template: "scores", cat: "games", featured: true, icon: "trophy", tint: "purple",
        name: "Scoreboard", desc: "Points per round, totals per player", keywords: "game score points jeu"},
    {type: "spreadsheet", template: "empty", cat: "empty", icon: "grid", tint: "accent",
        name: "Sheet", desc: "Empty spreadsheet with formulas", keywords: "spreadsheet sheet table tableur"},
    {type: "checklist", template: "empty", cat: "empty", icon: "check", tint: "accent",
        name: "Checklist", desc: "Empty list of tasks", keywords: "todo checklist"},
]

// The picker's columns, the first one open
function blockCategories() {
    return BLOCK_CATEGORIES.map((c, i) => ({...c, selected: i === 0}))
}

function blockOptionsIn(catId) {
    return BLOCK_OPTIONS.filter(o => catId === "featured" ? o.featured : o.cat === catId)
}

// An icon of the set, drawn in the tile's color (templates/cb-glyph.html)
function cbGlyph(name) {
    return fillWith('cb-glyph', [name])
}

Object.assign(window, {blockCategories, blockOptionsIn, cbGlyph})

function selectBlockCategory(catName) {
    const modal = document.getElementById('create-block')
    if (!modal) return
    const search = modal.querySelector('.block-picker-search')
    if (search && search.value) { search.value = ""; filterBlockPicker("") }
    modal.querySelectorAll('.block-cat-item').forEach(el =>
        el.classList.toggle('selected', el.dataset.cat === catName))
    modal.querySelectorAll('.block-option-section:not([data-section="search"])').forEach(el =>
        el.style.display = el.dataset.section === catName ? '' : 'none')
}
window.selectBlockCategory = selectBlockCategory

// Search: every option of every category (once each), whatever column is selected
function filterBlockPicker(query) {
    const modal = document.getElementById('create-block')
    if (!modal) return
    const q = query.trim().toLowerCase()
    const results = modal.querySelector('.block-option-group[data-for="search"]')
    const empty = modal.querySelector('.block-picker-empty')
    if (!q) {
        results.style.display = 'none'
        empty.style.display = 'none'
        const selected = modal.querySelector('.block-cat-item.selected')?.dataset.cat || 'featured'
        modal.querySelectorAll('.block-option-section:not([data-section="search"])').forEach(el =>
            el.style.display = el.dataset.section === selected ? '' : 'none')
        return
    }
    modal.querySelectorAll('.block-option-section:not([data-section="search"])').forEach(el => el.style.display = 'none')
    const seen = new Set()
    const matches = BLOCK_OPTIONS.filter(o => {
        const key = (o.type || o.action) + "/" + o.template
        const hay = (_t(o.name) + " " + _t(o.desc) + " " + o.name + " " + o.keywords).toLowerCase()
        if (seen.has(key) || !hay.includes(q)) return false
        seen.add(key)
        return true
    })
    results.innerHTML = fillWith('block-picker-option', matches)
    results.style.display = matches.length ? '' : 'none'
    empty.style.display = matches.length ? 'none' : ''
}
window.filterBlockPicker = filterBlockPicker

// ── New blocks: what each type starts with (the server stores it as is) ────
const MAX_PARTICIPANTS = 30
const MAX_AMOUNT_CENTS = 1_000_000_000          // 10 million in any currency
const CURRENCIES = ["€", "$", "£", "CHF", "¥", "₹", "kr"]
const HEADER_BG = "#ffffff14", TOTAL_BG = "#5865f233"

const cell = (col, row, value, bg = null) => ({col, row, value, bg})

// Ready-made sheets, labelled in the inserting member's language (rows count from 1)
const SHEET_TEMPLATES = {
    empty: () => ({rows: 5, cols: 3, cells: []}),
    scores() {
        const players = 4
        const cells = [cell(0, 1, _t("Round"), HEADER_BG)]
        for (let p = 1; p <= players; p++) cells.push(cell(p, 1, `${_t("Player")} ${p}`, HEADER_BG))
        for (let r = 2; r <= 7; r++) cells.push(cell(0, r, String(r - 1)))
        cells.push(cell(0, 8, _t("Total"), TOTAL_BG))
        for (let p = 1; p <= players; p++) {
            const col = String.fromCharCode(65 + p)
            cells.push(cell(p, 8, `=SUM(${col}2:${col}7)`, TOTAL_BG))
        }
        return {rows: 8, cols: players + 1, cells}
    },
    budget() {
        const cells = ["Item", "Planned", "Actual", "Left"].map((label, c) => cell(c, 1, _t(label), HEADER_BG))
        ;["Rent", "Groceries", "Utilities", "Internet", "Leisure"].forEach((label, i) => {
            cells.push(cell(0, i + 2, _t(label)), cell(3, i + 2, `=B${i + 2}-C${i + 2}`))
        })
        ;[_t("Total"), "=SUM(B2:B6)", "=SUM(C2:C6)", "=B7-C7"].forEach((value, c) => cells.push(cell(c, 7, value, TOTAL_BG)))
        return {rows: 7, cols: 4, cells}
    },
}

// A member's name as blocks show it
function accountName(id) {
    const user = global.users?.[id] || (String(id) === String(global.user?.id) ? global.user : null)
    const display = (user?.display || "").trim()
    return display && display !== "Mycelium User" ? display : user?.username || "?"
}

function newParticipantId() {
    return "p" + generateUUID().slice(0, 8)
}

// The server stores settings as sent: a participant's id goes into the templates' markup
// and onclick handlers unescaped, so only ids of the form newParticipantId makes count
const PARTICIPANT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/

function participantsOf(settings) {
    return (Array.isArray(settings?.participants) ? settings.participants : [])
        .filter(p => typeof p?.id === "string" && PARTICIPANT_ID_RE.test(p.id))
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isIsoDate = d => typeof d === "string" && ISO_DATE_RE.test(d)

const NEW_BLOCKS = {
    spreadsheet: (template) => (SHEET_TEMPLATES[template] || SHEET_TEMPLATES.empty)(),
    // The conversation's members, the author first; in a channel just the author (they add the others by name)
    tricount(template, convId) {
        const me = global.user.id
        const members = global.privateConvs?.[convId]?.members || [me]
        const accounts = [me, ...members.filter(a => String(a) !== String(me))].slice(0, MAX_PARTICIPANTS)
        return {settings: {title: "", currency: CURRENCIES[0], participants: accounts.map(a => ({
            id: newParticipantId(), name: accountName(a).slice(0, 32), account: Number(a),
        }))}}
    },
    checklist: (template) => ({settings: {title: "", mode: template === "potluck" ? "claim" : "todo"}}),
}

// ── Insert block ───────────────────────────────────────────────────────────
function insertConvBlock(blockType, template = 'empty') {
    closeFM()
    closeMenu('#create-block')
    const search = document.querySelector('#create-block .block-picker-search')
    if (search?.value) { search.value = ""; filterBlockPicker("") }
    const convId = global.state.activeConv
    const onload = function () {
        if (this.status !== 200) {
            uiAlert(_t("Could not insert the block"))
            return
        }
        const response = JSON.parse(this.responseText)
        const msg = response.message
        if (typeof msg.attachments === 'string') {
            try { msg.attachments = JSON.parse(msg.attachments) } catch(e) { msg.attachments = [] }
        }
        if (msg.convBlock) remember(msg.convBlock)
        handleMessageGroup(msg)
        addElement('global.convs[' + convId + '].messages', msg)
    }
    const spec = {type: blockType, template, ...NEW_BLOCKS[blockType](template, convId)}
    xhr("send_message?conv=" + encodeURI(JSON.stringify({id: convId})) + "&content=",
        onload, "POST", true, {conv_block: spec})
}
window.insertConvBlock = insertConvBlock

// ── Spreadsheet blocks ────────────────────────────────────────────────────
function mountAllConvSpreadsheets(containerEl) {
    if (!containerEl) return
    const targets = containerEl.querySelectorAll(
        '.conv-spreadsheet-container[data-block-id]:not([data-mounted])')
    for (const el of targets) {
        const uuid   = el.dataset.blockId
        const convId = el.dataset.convId
        el.dataset.mounted = '1'
        mountSpreadsheet(uuid, null, el, convId)
    }
}
window.mountAllConvSpreadsheets = mountAllConvSpreadsheets

function attachmentsOf(element) {
    let atts = element.attachments
    if (typeof atts === 'string') { try { atts = JSON.parse(atts) } catch(e) { return [] } }
    return Array.isArray(atts) ? atts : []
}

function isConvSpreadsheetMessage(element) {
    return !!element.convSpreadsheet || attachmentsOf(element).some(a => a?.type === 'conv_spreadsheet')
}
window.isConvSpreadsheetMessage = isConvSpreadsheetMessage

function getConvSpreadsheetUuid(element) {
    if (element.convSpreadsheet?.uuid) return element.convSpreadsheet.uuid
    return attachmentsOf(element).find(a => a?.type === 'conv_spreadsheet')?.uuid || ''
}
window.getConvSpreadsheetUuid = getConvSpreadsheetUuid

// A sheet block's header (templates/cb-head.html): what its template made of it
// (older sheets: a plain sheet)
const SHEET_HEADS = {
    scores: {title: "Scoreboard", sub: "Spreadsheet · totals update themselves", icon: "trophy", tint: "purple"},
    budget: {title: "Budget", sub: "Spreadsheet · totals update themselves", icon: "dashboard", tint: "green"},
}
function convSheetHead(element) {
    const template = attachmentsOf(element).find(a => a?.type === 'conv_spreadsheet')?.template
    const h = SHEET_HEADS[template] || {title: "Sheet", sub: "Spreadsheet with formulas", icon: "grid", tint: "accent"}
    return {...h, sub: _t(h.sub)}
}
window.convSheetHead = convSheetHead

// Any block message: no "edit" button on it (its body is the block)
function isBlockMessage(element) {
    return isConvSpreadsheetMessage(element) || isConvBlockMessage(element)
}
window.isBlockMessage = isBlockMessage

// ── Tricount / checklist blocks: state ────────────────────────────────────
// A block lives in its message (global.convs[place].messages[id].convBlock): its
// element (templates/cb-block.html) subscribes to that path and is repainted by
// setElement. `blocks` keeps the newest state seen per uuid, whatever order
// concurrent changes reach this tab in.
const blocks = new Map()     // uuid → newest state seen
const requestedBlocks = new Set()   // uuids fetched (or being fetched) because their message came without them
const ui = new Map()         // uuid → {tab, adding, editing}

function uiOf(uuid) {
    if (!ui.has(uuid)) ui.set(uuid, {tab: "expenses", adding: false, editing: null})
    return ui.get(uuid)
}

function remember(state) {
    const known = blocks.get(state.uuid)
    if (known && known.version >= state.version) return known   // our own change comes back over WS too
    blocks.set(state.uuid, state)
    return state
}

function isConvBlockMessage(element) {
    return !!element.convBlock || attachmentsOf(element).some(a => a?.type === 'conv_block')
}
window.isConvBlockMessage = isConvBlockMessage

// A newer state (our own change, or someone else's): into its message, which repaints the block
function applyConvBlockState(state, place) {
    if (!state?.uuid || remember(state) !== state) return
    const msg = place != null ? global.convs?.[place]?.messages?.[state.messageId] : null
    if (msg) setElement(`global.convs[${place}].messages[${state.messageId}].convBlock`, state)
    else repaintBlock(state.uuid)     // shown outside its conversation's messages
}
window.applyConvBlockState = applyConvBlockState

function renderConvBlockMessage(element) {
    const uuid = element.convBlock?.uuid || attachmentsOf(element).find(a => a?.type === 'conv_block')?.uuid
    if (!uuid) return ''
    const state = element.convBlock ? remember(element.convBlock) : blocks.get(uuid)
    // Asked for once: a block this tab can't load (gone, no access) isn't refetched on every repaint
    if (!state && !requestedBlocks.has(uuid)) {
        requestedBlocks.add(uuid)
        fetchBlock(uuid, element.place, ok => { if (ok) requestedBlocks.delete(uuid) })
    }
    return fillWith('cb-block', [{uuid, place: element.place, messageId: element.id, state}])
}
window.renderConvBlockMessage = renderConvBlockMessage

function fetchBlock(uuid, place, then) {
    xhr("get_conv_block?block_uuid=" + encodeURIComponent(uuid), function () {
        if (this.status === 200) applyConvBlockState(JSON.parse(this.responseText), place)
        then?.(this.status === 200)
    })
}

// What's inside a block's element: its type's template, fed its view model
const BLOCK_VIEWS = {
    tricount: {template: "cb-tricount", model: tricountModel},
    checklist: {template: "cb-checklist", model: checklistModel},
}

function cbInner(state) {
    const view = BLOCK_VIEWS[state.type]
    if (!view) return ''
    loadBlockUsers(state)
    return fillWith(view.template, [view.model(state)])
}
window.cbInner = cbInner

let redrawing = false

// Redraw a block, keeping what is being typed in it (a remote change must not
// eat a half-written expense) and the focus.
function redraw(el) {
    const state = blocks.get(el.dataset.blockUuid)
    if (!state) return
    // Drafts (forms) and the field being typed in; everything else shows the new state
    const values = {}
    el.querySelectorAll('[data-keep]').forEach(input => {
        if (input !== document.activeElement && !input.closest('form')) return
        values[input.dataset.keep] = input.type === "checkbox" ? input.checked : input.value
    })
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset?.keep : null
    const caret = focused ? document.activeElement.selectionStart : null
    el.classList.remove("loading")
    el.classList.add(`cb-${state.type}`)
    // Replacing the focused input fires its blur (Chromium): that's not the user leaving
    // the field, so the inline editors' onblur must not save a half-typed value
    redrawing = true
    try { el.innerHTML = cbInner(state) } finally { redrawing = false }
    el.querySelectorAll('[data-keep]').forEach(input => {
        const v = values[input.dataset.keep]
        if (v === undefined) return
        if (input.type === "checkbox") input.checked = v
        else input.value = v
    })
    if (focused) {
        const input = el.querySelector(`[data-keep="${focused}"]`)
        if (input) {
            input.focus()
            try { if (caret != null) input.setSelectionRange(caret, caret) } catch (e) { /* number inputs */ }
        }
    }
}

// Every element showing this block (its data-repaint, and view-only changes: tab, form)
function repaintBlock(uuid) {
    document.querySelectorAll(`.conv-block[data-block-uuid="${uuid}"]`).forEach(redraw)
}
window.cbRepaint = repaintBlock

function blockEl(uuid) {
    return document.querySelector(`.conv-block[data-block-uuid="${uuid}"]`)
}

function placeOf(uuid) {
    return blockEl(uuid)?.dataset.place
}

// What the server says after its status ("400 Bad Request This block is full")
function serverReason(xhr) {
    return xhr.responseText.replace(/^(400 Bad Request|403 Forbidden|404 Not Found|409 Conflict|413 Payload Too Large|500 Server Error) ?/, "")
}

// Every change goes through here. `build(state)` turns the block's current state into
// the request ({endpoint, body}, with `if_version` when the change depends on that
// state), or refuses it ({error}: a translation key; null: nothing to do). When
// someone changed the block meanwhile, the server refuses the request (409):
// the block is reloaded and `build` runs again on its new state, once.
function change(uuid, build, onDone, retry = true) {
    const state = blocks.get(uuid)
    const request = state ? build(state) : null
    if (!request || request.error) {
        if (request?.error) uiAlert(_t(request.error))
        repaintBlock(uuid)            // puts back what the refused edit typed
        onDone?.(false)
        return
    }
    xhr(request.endpoint, function () {
        if (this.status === 200) {
            applyConvBlockState(JSON.parse(this.responseText), placeOf(uuid))
            onDone?.(true)
        } else if (this.status === 409 && retry) {
            fetchBlock(uuid, placeOf(uuid), ok => ok ? change(uuid, build, onDone, false) : onDone?.(false))
        } else {
            const reason = serverReason(this)
            uiAlert(this.status === 409 ? _t("Someone changed this block at the same time, try again")
                : this.status === 400 || this.status === 413 ? _t(reason) : _t("Could not save the change"))
            onDone?.(false)
        }
    }, "POST", true, {block_uuid: uuid, ...request.body})
}

// One line of text, no runs of spaces (titles, names, labels, tasks)
function cleanText(value, max) {
    return String(value ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, max)
}

function cbRename(uuid, title) {
    if (redrawing) return
    change(uuid, () => ({endpoint: "edit_conv_block", body: {settings: {title: cleanText(title, 80)}}}))
}
window.cbRename = cbRename

function deleteItem(uuid, itemId) {
    change(uuid, () => ({endpoint: "delete_conv_block_item", body: {item_id: itemId}}))
}

function itemOf(state, itemId) {
    return state.items.find(i => i.id === itemId)
}

// "{n} participants" style labels: the key holds the {placeholders}
function fmt(key, values) {
    return Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), _t(key))
}

// ── Avatars (participants, who took an item): templates/cb-avatar.html ─────
// A member shows their profile picture; someone without one, or a participant
// who isn't a member, their initial on a color.
const AVATAR_COLORS = ["#4a54c9", "#1f7a3a", "#9a5b00", "#7a1fbf", "#a3324a", "#16708a"]

// The accounts a block shows: drawn with their initial at once, with their picture
// once loaded (in the background, each account asked for once, even one that
// no longer exists: a redraw on every change must not hit the network again)
const requestedUsers = new Set()

function loadBlockUsers(state) {
    const ids = state.type === "tricount"
        ? participantsOf(state.settings).map(p => p.account)
        : state.items.flatMap(i => [i.data.claimed_by, i.data.done_by])
    const missing = [...new Set(ids.filter(id => id != null).map(String))]
        .filter(id => !global.users?.[id] && !requestedUsers.has(id))
    if (!missing.length || global.state?.offline) return
    missing.forEach(id => requestedUsers.add(id))
    xhr("get_users_info?users=" + encodeURIComponent(JSON.stringify(missing)), function () {
        if (this.status !== 200) return
        const users = JSON.parse(this.responseText)
        for (const user of users) global.users[user.id] = user
        if (users.length) document.querySelectorAll('.conv-block[data-block-uuid]').forEach(redraw)
    })
}

function initialOf(name) {
    const m = String(name || "").match(/[\p{L}\p{N}]/u)
    return m ? m[0].toUpperCase() : "?"
}

function cbAvatar(name, colorIndex, size = "", account = null) {
    return fillWith('cb-avatar', [{
        size,
        photo: (account != null ? global.users?.[account]?.pfp : null) || null,
        color: AVATAR_COLORS[Math.abs(colorIndex || 0) % AVATAR_COLORS.length],
        initial: initialOf(name),
    }])
}

// A tricount participant's avatar (m: the tricount's view model)
function cbPersonAvatar(m, pid, size = "") {
    return cbAvatar(m.name[pid] ?? "?", m.color[pid] ?? 0, size, m.account[pid])
}

// ── Tricount: templates/cb-tricount*.html, cb-expense-*.html ───────────────

function money(cents, currency) {
    const n = (cents / 100).toLocaleString(global.settings?.lang || undefined,
        {minimumFractionDigits: 2, maximumFractionDigits: 2})
    return ["$", "£", "¥", "₹"].includes(currency) ? `${currency}${n}` : `${n} ${currency}`
}

// Each split's shares in cents: its leftover cents go to the first participants of
// the split, so the shares always add up to the amount.
function shares(amount, split) {
    const share = Math.floor(amount / split.length)
    let rest = amount - share * split.length
    return split.map(id => [id, share + (rest-- > 0 ? 1 : 0)])
}

// Cents each participant is owed (> 0) or owes (< 0): they always sum to zero
export function tricountBalances(participants, items) {
    const bal = Object.fromEntries(participants.map(p => [p.id, 0]))
    for (const {data} of items) {
        const split = data.split.filter(id => id in bal)
        if (!(data.payer in bal) || !split.length) continue
        bal[data.payer] += data.amount
        for (const [id, cents] of shares(data.amount, split)) bal[id] -= cents
    }
    return bal
}

// What a participant's own share of the expenses (not the reimbursements) comes to
function tricountShareOf(pid, items) {
    let total = 0
    for (const {data} of items) {
        if (data.transfer || !data.split.includes(pid)) continue
        total += shares(data.amount, data.split).find(([id]) => id === pid)[1]
    }
    return total
}

// Fewest-ish reimbursements: the biggest debtor pays the biggest creditor, again
export function tricountSettlements(balances) {
    const debtors = Object.entries(balances).filter(([, v]) => v < 0).map(([id, v]) => ({id, v: -v}))
    const creditors = Object.entries(balances).filter(([, v]) => v > 0).map(([id, v]) => ({id, v}))
    debtors.sort((a, b) => b.v - a.v)
    creditors.sort((a, b) => b.v - a.v)
    const moves = []
    let i = 0, j = 0
    while (i < debtors.length && j < creditors.length) {
        const amount = Math.min(debtors[i].v, creditors[j].v)
        if (amount > 0) moves.push({from: debtors[i].id, to: creditors[j].id, amount})
        debtors[i].v -= amount
        creditors[j].v -= amount
        if (!debtors[i].v) i++
        if (!creditors[j].v) j++
    }
    return moves
}

// Everything a tricount's templates draw, worked out once per render
// The server stores what clients send: only well-formed expenses count
function isExpense(d, pids) {
    return !!d && Number.isInteger(d.amount) && d.amount > 0 && pids.has(d.payer)
        && Array.isArray(d.split) && d.split.length > 0 && d.split.every(id => pids.has(id))
}

function tricountModel(state) {
    const s = state.settings
    const people = participantsOf(s)
    const pids = new Set(people.map(p => p.id))
    const items = state.items.filter(i => isExpense(i.data, pids))
    const me = people.find(p => p.account === global.user?.id) || null
    const expenses = items.filter(i => !i.data.transfer)
    const bal = tricountBalances(people, items)
    const cur = CURRENCIES.includes(s.currency) ? s.currency : CURRENCIES[0]
    const total = expenses.reduce((sum, i) => sum + i.data.amount, 0)
    const moves = tricountSettlements(bal)
    const view = uiOf(state.uuid)
    const m = {
        state, uuid: state.uuid, view, people, items, me, expenses, bal, cur, total, moves,
        name: Object.fromEntries(people.map(p => [p.id, p.name])),
        // A member keeps the color of their account (the same in every block), others their rank
        color: Object.fromEntries(people.map((p, i) => [p.id, p.account ?? i])),
        account: Object.fromEntries(people.map(p => [p.id, p.account ?? null])),
        sub: fmt("{people} participants · {expenses} expenses", {people: people.length, expenses: expenses.length}),
        tabs: [
            {id: "expenses", label: _t("Expenses"), count: expenses.length},
            {id: "balances", label: _t("Balances"), count: moves.length || ""},
            {id: "people", label: _t("Participants"), count: ""},
        ],
        currencies: CURRENCIES,
    }

    // Total · my share · my balance (or, for someone outside the tricount, the average)
    m.stats = [{label: _t("Total"), value: money(total, cur)}]
    if (me) {
        const v = bal[me.id] || 0
        m.stats.push({label: _t("My share"), value: money(tricountShareOf(me.id, items), cur), optional: true})
        m.stats.push({label: _t(v > 0 ? "I'm owed" : v < 0 ? "I owe" : "My balance"),
            value: v ? money(Math.abs(v), cur) : _t("Settled up"), kind: v > 0 ? "positive" : v < 0 ? "negative" : ""})
    } else if (people.length) {
        m.stats.push({label: _t("Per person"), value: money(Math.round(total / people.length), cur)})
    }

    // Expenses, newest first; the one being edited is its form
    m.rows = [...items].reverse().map(item => ({
        m, item, d: item.data,
        form: view.editing === item.id ? expenseForm(m, item) : null,
        date: isIsoDate(item.data.date) ? formatDate(item.data.date) : "",
        split: item.data.split.length === people.length ? _t("everyone")
            : item.data.split.map(id => m.name[id] ?? "?").join(", "),
    }))
    m.newForm = view.adding ? expenseForm(m) : null

    // Balances, and how to settle up (the sentences are translated with their placeholders)
    const max = Math.max(1, ...Object.values(bal).map(Math.abs))
    m.balances = people.map(p => {
        const v = bal[p.id] || 0
        return {p, v, width: Math.round(Math.abs(v) / max * 100), mine: p.id === me?.id,
            kind: v > 0 ? "positive" : v < 0 ? "negative" : ""}
    })
    m.settles = moves.map(mv => {
        const mineIn = mv.to === me?.id, mineOut = mv.from === me?.id
        return {...mv, mine: mineIn || mineOut,
            sentence: mineIn ? "{from} owes you {amount}" : mineOut ? "You owe {amount} to {to}" : "{from} owes {amount} to {to}",
            button: mineIn ? "Mark as received" : "Mark as paid"}
    })

    // Participants: one with expenses (or the last one) can't be removed
    m.persons = people.map(p => ({
        p, removable: people.length > 1 && !items.some(i => i.data.payer === p.id || i.data.split.includes(p.id)),
    }))
    return m
}

function today() {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function formatDate(iso) {
    const [y, mo, d] = iso.split("-").map(Number)
    return new Date(y, mo - 1, d).toLocaleDateString(global.settings?.lang || undefined, {day: "numeric", month: "short"})
}

// Cents from what the amount field accepts ("12", "12.5", "12,50"); 0 for anything else
function parseAmount(text) {
    const m = String(text ?? "").trim().match(/^(\d{1,9})(?:[.,](\d{1,2}))?$/)
    return m ? Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0")) : 0
}

function shareHint(cents, count, cur) {
    return cents && count ? fmt("{amount} each", {amount: money(Math.floor(cents / count), cur)}) : ""
}

// The add / edit form of an expense (templates/cb-expense-form.html)
function expenseForm(m, item = null) {
    const {people, me} = m
    const d = item?.data || {label: "", amount: "", payer: (me || people[0])?.id, split: people.map(p => p.id), date: today()}
    return {
        uuid: m.uuid, itemId: item ? item.id : null, key: item ? `e${item.id}` : "new",
        d, transfer: !!d.transfer, people, me, cur: m.cur,
        amount: d.amount === "" ? "" : (d.amount / 100).toFixed(2),
        hint: shareHint(d.amount || 0, d.split.length, m.cur),
    }
}

// "32,00 € each", as the amount and the split change
function cbShareHint(form, cur) {
    const hint = form.querySelector('[data-share]')
    if (!hint) return
    hint.textContent = shareHint(parseAmount(form.amount.value), form.querySelectorAll('.cb-split input:checked').length, cur)
}

function cbTab(uuid, tab) { uiOf(uuid).tab = tab; repaintBlock(uuid) }
function cbStartExpense(uuid) {
    Object.assign(uiOf(uuid), {adding: true, editing: null})
    repaintBlock(uuid)
    blockEl(uuid)?.querySelector('[data-keep="new-label"]')?.focus()
}
function cbEditExpense(uuid, itemId) { Object.assign(uiOf(uuid), {adding: false, editing: itemId}); repaintBlock(uuid) }
function cbCancelExpense(uuid) {
    const el = blockEl(uuid)
    el?.querySelectorAll('.cb-form [data-keep]').forEach(i => i.removeAttribute('data-keep'))   // drop the draft
    Object.assign(uiOf(uuid), {adding: false, editing: null})
    repaintBlock(uuid)
}

// An expense as stored (amount in cents), checked against the tricount's participants;
// `item`: the one being edited (its version guards the change)
function expenseRequest(state, data, item = null) {
    const pids = new Set(participantsOf(state.settings).map(p => p.id))
    const d = {...(item?.data || {}), ...data}
    const transfer = !!d.transfer
    const amount = Number.isInteger(d.amount) ? d.amount : parseAmount(d.amount)
    if (amount < 1 || amount > MAX_AMOUNT_CENTS) return {error: "Invalid amount"}
    const label = transfer ? "" : cleanText(d.label, 120)
    if (!transfer && !label) return {error: "What for? (e.g. Pizza)"}
    if (!pids.has(d.payer)) return {error: "Unknown payer"}
    const split = Array.isArray(d.split) ? [...new Set(d.split)].filter(id => pids.has(id)) : []
    if (!split.length) return {error: "Pick at least one person to split with"}
    if (transfer && (split.length !== 1 || split[0] === d.payer)) return {error: "A reimbursement goes from one participant to another"}
    const expense = {label, amount, payer: d.payer, split, date: isIsoDate(d.date) ? d.date : null}
    if (transfer) expense.transfer = true
    return item
        // Against the block's version too: the participants it names are still there
        ? {endpoint: "edit_conv_block_item", body: {item_id: item.id, data: expense, if_version: item.version,
            if_block_version: state.version}}
        : {endpoint: "add_conv_block_item", body: {data: expense, if_version: state.version}}
}

function cbSubmitExpense(uuid, itemId, form) {
    const data = {amount: form.amount.value, payer: form.payer.value, date: form.date.value || null}
    if (form.label) {      // not on a reimbursement
        data.label = form.label.value
        data.split = [...form.querySelectorAll('.cb-split input:checked')].map(i => i.value)
    }
    change(uuid, state => {
        const item = itemId != null ? itemOf(state, itemId) : null
        return itemId != null && !item ? null : expenseRequest(state, data, item)
    }, ok => { if (ok) cbCancelExpense(uuid) })
}

async function cbDeleteItem(uuid, itemId) {
    const state = blocks.get(uuid)
    if (state?.type === "tricount" && !(await uiConfirm(_t("Delete this expense?")))) return
    deleteItem(uuid, itemId)
}

function cbSettle(uuid, from, to, amount) {
    change(uuid, state => expenseRequest(state, {transfer: true, payer: from, split: [to], amount, date: today()}))
}

// A new list of participants, from the block's current one. Checked here: names
// (one each, not twice) and that a removed participant has no expense; the
// block's version guards against an expense added for them meanwhile.
function participantsRequest(state, edit) {
    const current = participantsOf(state.settings)
    const wanted = edit(current.map(p => ({...p})))
    const seen = new Set()
    for (const p of wanted) {
        p.name = cleanText(p.name, 32)
        if (!p.name) return null
        if (seen.has(p.name.toLowerCase())) return {error: "Two participants have the same name"}
        seen.add(p.name.toLowerCase())
    }
    if (!wanted.length || wanted.length > MAX_PARTICIPANTS) return null
    const kept = new Set(wanted.map(p => p.id))
    const removed = new Set(current.map(p => p.id).filter(id => !kept.has(id)))
    if (state.items.some(({data: d}) => removed.has(d?.payer) || (Array.isArray(d?.split) ? d.split : []).some(id => removed.has(id))))
        return {error: "This participant still has expenses"}
    return {endpoint: "edit_conv_block", body: {settings: {participants: wanted}, if_version: state.version}}
}

function cbRenamePerson(uuid, pid, value) {
    if (redrawing) return
    change(uuid, state => participantsRequest(state, ps => ps.map(p => p.id === pid ? {...p, name: value} : p)))
}
function cbRemovePerson(uuid, pid) {
    change(uuid, state => participantsRequest(state, ps => ps.filter(p => p.id !== pid)))
}
function cbAddPerson(uuid, value, form) {
    // Emptied before the answer redraws the block (it keeps drafts), put back if refused
    form.name.value = ""
    change(uuid, state => participantsRequest(state, ps => [...ps, {id: newParticipantId(), name: value, account: null}]), ok => {
        const input = blockEl(uuid)?.querySelector('[data-keep="person-new"]')
        if (!ok && input) input.value = value
        input?.focus()
    })
}
function cbCurrency(uuid, currency) {
    if (!CURRENCIES.includes(currency)) return
    change(uuid, () => ({endpoint: "edit_conv_block", body: {settings: {currency}}}))
}

// ── Checklist: templates/cb-checklist.html, cb-check-row.html ──────────────

const CHECKLIST_LOOKS = {
    empty: {title: "To-do list", icon: "check", tint: "accent"},
    groceries: {title: "Shopping list", icon: "list", tint: "orange"},
    potluck: {title: "Who brings what?", icon: "food", tint: "orange"},
}

function checklistModel(state) {
    const claim = state.settings.mode === "claim"
    const items = state.items.filter(i => typeof i.data?.text === "string")
    const n = items.length
    const done = items.filter(i => i.data.done).length
    const taken = items.filter(i => i.data.claimed_by).length
    const uid = global.user?.id
    const view = uiOf(state.uuid)
    // Ring: done in blue; in a "who brings what" list, taken but not brought in grey
    const pct = v => n ? Math.round(v / n * 100) : 0
    return {
        state, uuid: state.uuid, claim, ...(CHECKLIST_LOOKS[state.template] || CHECKLIST_LOOKS.empty),
        rows: items.map(item => ({
            uuid: state.uuid, item, d: item.data, claim, editing: view.editing === item.id,
            mineClaim: item.data.claimed_by === uid, mineDone: item.data.done_by === uid,
            claimedName: item.data.claimed_by != null ? accountName(item.data.claimed_by) : "",
            doneName: item.data.done_by != null ? accountName(item.data.done_by) : "",
        })),
        ring: n ? {
            complete: done === n, done, total: n, donePct: pct(done),
            takenPct: claim ? pct(Math.max(taken, done)) : pct(done),
            label: fmt(claim ? "{done} of {total} brought" : "{done} of {total} done", {done, total: n}),
        } : null,
        sub: !n ? _t(claim ? "Add what's needed, everyone picks something" : "Add the first item")
            : claim ? fmt("{taken} of {total} taken · {done} brought", {taken, total: n, done})
            : fmt("{done}/{total} done", {done, total: n}),
        placeholder: _t(claim ? "Add something to bring…" : "Add an item…"),
    }
}

function itemRequest(itemId, data, version) {
    return {endpoint: "edit_conv_block_item", body: {item_id: itemId, data, ...(version != null && {if_version: version})}}
}

function cbAddCheck(uuid, form) {
    const text = cleanText(form.text.value, 200)
    if (!text) return
    form.text.value = ""
    change(uuid, () => ({endpoint: "add_conv_block_item", body: {data: {text, done: false}}}), ok => {
        const input = blockEl(uuid)?.querySelector('[data-keep="new-item"]')
        if (!ok && input) input.value = text
        input?.focus()
    })
}

function cbToggle(uuid, itemId, done) {
    // Shown at once; the server's answer (or a refusal) redraws it
    const box = blockEl(uuid)?.querySelector(`.cb-box[onclick*=", ${itemId},"]`)
    box?.classList.toggle("checked", done)
    box?.closest(".cb-check")?.classList.toggle("done", done)
    change(uuid, () => itemRequest(itemId, {done, done_by: done ? global.user.id : null}))
}

// Take on an item (nobody else has), or give back one's own; against the item's
// version, so two people can't take on the same one
function cbClaim(uuid, itemId, claim) {
    change(uuid, state => {
        const item = itemOf(state, itemId)
        const holder = item?.data.claimed_by ?? null
        if (!item || (!claim && holder !== global.user.id)) return null
        if (claim && holder !== null && holder !== global.user.id) return {error: "Someone already takes care of it"}
        return itemRequest(itemId, {claimed_by: claim ? global.user.id : null}, item.version)
    })
}

function cbEditText(uuid, itemId) {
    uiOf(uuid).editing = itemId
    repaintBlock(uuid)
    const input = blockEl(uuid)?.querySelector(`[data-keep="edit-${itemId}"]`)
    input?.focus()
    input?.select()
}

// Touch screens have no double click: a tap edits
function cbTapText(uuid, itemId) {
    if (matchMedia('(hover: none)').matches) cbEditText(uuid, itemId)
}

// Enter saves (on blur); Escape leaves the text as it was
function cbTextKey(event, uuid) {
    if (event.key === 'Enter') event.target.blur()
    else if (event.key === 'Escape') {
        uiOf(uuid).editing = null
        repaintBlock(uuid)      // the input goes, its blur during the redraw saves nothing
    }
}

function cbSaveText(uuid, itemId, value) {
    const view = uiOf(uuid)
    if (redrawing || view.editing !== itemId) return
    view.editing = null
    const old = itemOf(blocks.get(uuid), itemId)?.data.text
    const text = cleanText(value, 200)
    if (!text || text === old) { repaintBlock(uuid); return }
    change(uuid, () => itemRequest(itemId, {text}))
}

// What the templates call (they're evaluated outside this module)
Object.assign(window, {
    cbAvatar, cbPersonAvatar, cbMoney: money, cbFmt: fmt,
    cbTab, cbStartExpense, cbEditExpense, cbCancelExpense, cbSubmitExpense, cbDeleteItem, cbSettle,
    cbRenamePerson, cbRemovePerson, cbAddPerson, cbCurrency, cbShareHint,
    cbAddCheck, cbToggle, cbClaim, cbEditText, cbTapText, cbTextKey, cbSaveText,
})
