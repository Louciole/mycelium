/**
 * Live cursors of the note on screen: who else is writing in it (readers don't show), the
 * block each one is in, their caret and selection (templates/note-cursors.html, note-people.html).
 *
 * A caret travels as CRDT anchors (the id of the character before it, crdt/fugue.mjs), so
 * it stays on the right character while the text changes. Others see a block either as
 * its markdown source (the block they are typing in) or rendered (syntax hidden): an
 * anchor's index in the source is mapped to the rendered text by rendering what comes
 * before it. Nothing is stored: the server stamps who sent it and relays it
 * (routes/notes_sync.py note_presence); a peer silent for EXPIRE ms disappears.
 */
import {setElement} from "../framework/vesta.mjs"

const COLORS = ["#e5484d", "#f76b15", "#e2a336", "#46a758", "#12a594", "#0090ff", "#8e4ec6", "#d6409f"]
const SEND_EVERY = 80
const HEARTBEAT = 10000
const EXPIRE = 30000

const colorFor = (uid) => COLORS[Math.abs(Number(uid) * 2654435761 % COLORS.length)]

export class NotePresence {
    constructor(editor) {
        this.editor = editor
        this.sync = editor.sync
        this.peers = new Map()   // sid (their socket) → {uid, cursor, at}
        this._last = undefined
        this._onSelection = () => this._scheduleSend()
        this._onResize = () => this.refresh()
        document.addEventListener("selectionchange", this._onSelection)
        window.addEventListener("resize", this._onResize)
        this._heartbeat = setInterval(() => {
            this._send(true)
            this._expire()
        }, HEARTBEAT)
        this._send(true)
    }

    destroy() {
        document.removeEventListener("selectionchange", this._onSelection)
        window.removeEventListener("resize", this._onResize)
        clearInterval(this._heartbeat)
        clearTimeout(this._sendTimer)
        this.peers.clear()
        setElement("global.state.noteCursors", null)
    }

    _onScreen() {
        return global.state.noteEditor === this.editor && global.state.activeChan?.type === "note"
            && Number(global.state.activeChan.id) === this.sync.channel
    }

    // ── This tab's caret ─────────────────────────────────────────────────────

    _scheduleSend() {
        if (this._sendTimer) return
        this._sendTimer = setTimeout(() => {
            this._sendTimer = null
            this._send(false)
        }, SEND_EVERY)
    }

    /** {o} (in a block), {o, a, h} (caret / selection in its text) or null. */
    _localCursor() {
        if (!this._onScreen() || document.hidden) return null
        const el = document.activeElement
        const blockEl = el?.closest?.("#note-editor .block")
        const o = blockEl?.dataset.blockId
        if (!o || !this.editor.blocks[o]) return null
        if (!el.classList.contains("editable-block")) return {o}
        const selection = window.getSelection()
        if (!selection.rangeCount || !el.contains(selection.anchorNode)) return {o}
        const text = this.sync.doc.textOf(o)
        return {
            o,
            a: text.anchorAt(offsetIn(el, selection.anchorNode, selection.anchorOffset)),
            h: text.anchorAt(offsetIn(el, selection.focusNode, selection.focusOffset)),
        }
    }

    _send(force) {
        const cursor = this._localCursor()
        const key = JSON.stringify(cursor)
        if (!force && key === this._last) return
        this._last = key
        this.sync.sendPresence(cursor)
    }

    // ── Others ───────────────────────────────────────────────────────────────

    onMessage({channel, uid, sid, cursor}) {
        if (Number(channel) !== this.sync.channel || sid === global.state.clientID) return
        if (cursor === "leave") this.peers.delete(sid)
        else {
            const known = this.peers.has(sid)
            this.peers.set(sid, {uid, cursor, at: Date.now()})
            // Someone arrived: they learn where this tab's caret is without waiting for the heartbeat
            if (!known) this._send(true)
        }
        this.refresh()
    }

    _expire() {
        const now = Date.now()
        let changed = false
        for (const [sid, peer] of this.peers) {
            if (now - peer.at > EXPIRE) {
                this.peers.delete(sid)
                changed = true
            }
        }
        if (changed) this.refresh()
    }

    /** Draw again on the next frame (the text, the layout or a peer changed). */
    refresh() {
        if (this._frame) return
        this._frame = requestAnimationFrame(() => {
            this._frame = null
            this._render()
        })
    }

    _render() {
        const page = document.querySelector(".note-page")
        if (!page || !this._onScreen()) return
        const pageRect = page.getBoundingClientRect()
        const local = (r) => ({x: r.left - pageRect.left + page.scrollLeft, y: r.top - pageRect.top + page.scrollTop,
                               w: r.width, h: r.height})
        const people = new Map()
        const bars = []
        const cursors = []
        for (const peer of this.peers.values()) {
            // Only those who may write show: a reader has no caret to follow (rights as they are
            // now, access.mjs: the editor refreshes this when they change)
            if (!window.channelRightsFor(this.sync.channel, "note", Number(peer.uid)).has("edit-notes")) continue
            const user = voiceUser(peer.uid)   // webrtc.mjs: global.users, or ourselves
            const name = user.display || user.username || "#" + peer.uid
            const color = colorFor(peer.uid)
            people.set(peer.uid, {uid: Number(peer.uid), name, color})
            const o = peer.cursor?.o
            const blockEl = o && document.querySelector(`#note-editor .block[data-block-id="${o}"]`)
            if (!blockEl) continue
            bars.push({...local(blockEl.getBoundingClientRect()), color})
            const contentEl = blockEl.querySelector(":scope > .content.editable-block")
            if (!contentEl || !("h" in peer.cursor)) continue
            const text = this.sync.doc.textOf(o)
            const head = this._domPoint(contentEl, o, text.indexOf(peer.cursor.h))
            if (!head) continue
            const caret = caretRect(head, contentEl)
            const rects = []
            const anchor = peer.cursor.a !== undefined ? this._domPoint(contentEl, o, text.indexOf(peer.cursor.a)) : null
            if (anchor && (anchor.node !== head.node || anchor.offset !== head.offset)) {
                const range = document.createRange()
                const [start, end] = before(anchor, head) ? [anchor, head] : [head, anchor]
                range.setStart(start.node, start.offset)
                range.setEnd(end.node, end.offset)
                for (const r of range.getClientRects()) if (r.width > 0) rects.push(local(r))
            }
            const at = local(caret)
            cursors.push({x: at.x, y: at.y, h: at.h, color, name, rects})
        }
        setElement("global.state.noteCursors", {people: [...people.values()], bars, cursors})
    }

    /**
     * The DOM position of a source index: the same index in the text being typed (the
     * preview keeps every character), the length of what renders before it otherwise.
     */
    _domPoint(el, o, index) {
        const raw = this.editor.blocks[o]?.content ?? ""
        const offset = document.activeElement === el ? index : this.editor.renderedLength(raw.slice(0, index))
        return pointAt(el, offset)
    }
}

/** Characters of `el`'s text before (node, offset). */
function offsetIn(el, node, offset) {
    const range = document.createRange()
    range.selectNodeContents(el)
    try {
        range.setEnd(node, offset)
    } catch (e) {
        return 0
    }
    return range.toString().length
}

/** The text node and offset holding character `offset` of `el` (its end if beyond). */
export function pointAt(el, offset) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let seen = 0
    let last = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent.length
        if (seen + length >= offset) return {node, offset: offset - seen}
        seen += length
        last = node
    }
    return last ? {node: last, offset: last.textContent.length} : {node: el, offset: 0}
}

/**
 * The caret's rectangle at a DOM point: one line high, never the whole block. A collapsed
 * range at the edge of a text node often has no rectangle: then the edge of the character
 * next to it, and in an empty block its first line.
 */
function caretRect(point, el) {
    const line = (left, top, height) => ({left, top, width: 0, height})
    const range = document.createRange()
    range.setStart(point.node, point.offset)
    range.collapse(true)
    const own = [...range.getClientRects()].find(r => r.height > 0)
    if (own) return line(own.left, own.top, own.height)
    const text = point.node.nodeType === Node.TEXT_NODE ? point.node.textContent : ""
    if (point.offset < text.length) {
        range.setEnd(point.node, point.offset + 1)
        const next = [...range.getClientRects()].find(r => r.height > 0)
        if (next) return line(next.left, next.top, next.height)
    }
    if (point.offset > 0 && text) {
        range.setStart(point.node, point.offset - 1)
        range.setEnd(point.node, point.offset)
        const previous = [...range.getClientRects()].find(r => r.height > 0)
        if (previous) return line(previous.right, previous.top, previous.height)
    }
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 20
    return line(box.left, box.top, Math.min(lineHeight, box.height || lineHeight))
}

function before(a, b) {
    if (a.node === b.node) return a.offset <= b.offset
    return Boolean(a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING)
}
