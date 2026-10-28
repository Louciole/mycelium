/**
 * A notes channel's local copy (CRDT, static/crdt/) and its link to the server
 * (routes/notes_sync.py), one per note opened in this tab.
 *
 * - Confirmed: the operations of the server log up to `lastSeq`, applied in order.
 * - Pending: this tab's operations, applied at once, sent (note_push) until they come back
 *   in the log. Operations commute, so others' operations can arrive in between. The server
 *   judges each one: a refused operation is dropped here alone, the others stay.
 * - Live: the tab joins the note's room on the WebSocket (note_join) and receives the new
 *   operations in order (note_ops); a gap is filled from note_sync.
 * - Offline: the log and the pending operations live in IndexedDB, per account. A tab holds
 *   a Web Lock named after its client id and writes only its own pending operations; those
 *   of a tab that went away (its lock is free) are taken over and sent by the next tab that
 *   opens the note.
 * - note_block: once this tab's operations are confirmed, it writes back the blocks they
 *   touched (note_project), so search and the MCP server see the note. When the note is
 *   opened, a row whose fingerprint differs from this tab's copy is written again.
 */
import {xhr} from "../framework/templating.mjs"
import {NoteDoc, BLOCK_FIELDS, FIELD_DEFAULTS, MAX_INSERT, MAX_RANGES, MAX_DELETE_SPAN, MAX_INDENT} from "../crdt/doc.mjs"
import {UndoManager} from "../crdt/undo.mjs"
import {keyToFloat, isKey} from "../crdt/keys.mjs"

const PUSH_DELAY = 150         // ms: keystrokes close together go in one request (and one operation)
const PROJECT_DELAY = 1500     // ms of quiet before note_block is written back
const MAX_BATCH = 500          // operations per request, and…
const MAX_BATCH_COST = 1_000_000   // …characters inserted + deleted per request (routes/notes_sync.py)
const KEEPALIVE_BUDGET = 60000 // bytes of keepalive requests a page may leave behind (64 KB in all)
const KEEP_IDLE = 3            // notes left (nothing pending) kept loaded in this tab
const CACHE_DB = "mycelium-notes"
const LOCK_PREFIX = "mycelium-note-client-"

const syncs = new Map()        // channel → NoteSync, the most recently opened last

const randomClientId = () => {
    const words = crypto.getRandomValues(new Uint32Array(2))
    return (words[0] & 0x1fffff) * 2 ** 32 + words[1] || 1   // 53 bits, never 0 (the server's)
}
const opKey = (op) => op.c + ":" + op.k
const span = (ranges) => ranges.reduce((sum, [, from, to]) => sum + to - from + 1, 0)
const opCost = (op) => op.t === "ins" ? op.x.length : op.t === "del" ? 1 + span(op.r) : 1

/** The NoteSync of a channel, loaded (cache, then the server). */
export async function getNoteSync(channel) {
    let sync = syncs.get(channel)
    if (sync) {
        syncs.delete(channel)   // most recently opened: last
        syncs.set(channel, sync)
    } else {
        sync = new NoteSync(channel)
        syncs.set(channel, sync)
        sync.ready = sync._load()
        // A load that failed isn't kept: opening the note again tries again
        sync.ready.catch(() => {
            if (syncs.get(channel) === sync) sync.dispose({save: false})
        })
        evictIdle(sync)
    }
    await sync.ready
    return sync
}

/** Notes left long ago, with nothing left to send, leave memory (their cache stays). */
function evictIdle(current) {
    const idle = [...syncs.values()].filter(s => s !== current && s.idle())
    while (idle.length > KEEP_IDLE) idle.shift().dispose()
}

/**
 * After a WebSocket (re)connection: join the open note again, send what is pending. What the
 * server already answered for stays answered: pushes go over HTTP, not this socket, and a new
 * keystroke must never be merged into an operation the server already stored (it would skip
 * the merged one as sent again, and the new characters with it).
 */
export function onNotesSocketReady() {
    for (const sync of syncs.values()) {
        if (sync.joined) sync.join()
        if (sync.pending.length || sync.orphans.length) sync.pushSoon()
    }
}

export function noteSyncFor(channel) {
    return syncs.get(Number(channel))
}

export class NoteSync {
    constructor(channel) {
        this.channel = Number(channel)
        this.account = global.user?.id ?? null   // the cache is per account (null: no cache)
        this.clientId = randomClientId()
        this.doc = new NoteDoc(this.clientId)
        this.undo = new UndoManager(this.doc)
        this.name = ""
        this.log = []               // confirmed operations, with their seq
        this.lastSeq = 0
        this.proj = {}              // object → [proj_seq, hash] of its note_block row
        this.pending = []           // this tab's operations not in the log yet
        this.pendingKeys = new Set()
        this.orphans = []           // pending operations of tabs that went away, sent by this one
        this.dirty = new Set()      // objects whose note_block row must be written back
        this.joined = false
        this.failed = false         // the last push failed (the page shows "not saved")
        this.listeners = new Set()  // fn(changedObjects: Set, {remote}) called after changes
        this.beforeListeners = new Set()   // fn() called before others' operations apply (caret anchors)
        this._pushedClock = 0       // own clocks the server already answered for
        // Own clocks sent at least once: never merged into again. The server may have stored
        // them even when its answer was lost (it would skip the merged one as sent again)
        this._sentClock = 0
        this._cachedSeq = 0         // log operations already in IndexedDB
        this._cachedClients = new Set()   // pending entries this tab wrote in IndexedDB
        this._holdLock()
    }

    // ── Loading ────────────────────────────────────────────────────────────

    async _load() {
        const cached = await cacheGet(this.account, this.channel)
        if (cached) {
            this.name = cached.meta?.name || ""
            this.proj = cached.meta?.proj || {}
            this._receive(cached.ops, {silent: true})
            this._cachedSeq = this.lastSeq
            await this._adoptOrphans(cached.pending)
        }
        // Never opened on this device: offline, there is nothing to show (an empty page would
        // be taken for the note, and what is typed there added to it once back online)
        if (global.state.offline && !cached) throw Object.assign(new Error("note not cached"), {offline: true})
        if (!global.state.offline) {
            try {
                await this.fetchMissing()
            } catch (e) {
                // No access (anymore), or no such note: nothing of it stays on this device
                if (e.status === 403 || e.status === 404) {
                    await this.forget()
                    throw e
                }
                if (!cached) throw e
            }
            await this._checkProjections()
        }
    }

    /** note_sync: the operations after lastSeq (first load, or a gap in the live stream). */
    fetchMissing() {
        return new Promise((resolve, reject) => {
            const request = xhr("note_sync?channel=" + this.channel + "&after=" + this.lastSeq, function () {
                if (this.status !== 200) return reject(Object.assign(new Error("note_sync " + this.status), {status: this.status}))
                resolve(JSON.parse(this.responseText))
            })
            request.onerror = () => reject(new Error("note_sync network error"))
        }).then((data) => {
            this.name = data.name
            this.proj = data.proj || {}
            this._receive(data.ops)
            this._saveCacheSoon()
        })
    }

    // ── The live room ──────────────────────────────────────────────────────

    join() {
        this.joined = true
        this._ws({type: "note_join", channel: this.channel, after: this.lastSeq})
    }

    leave() {
        if (!this.joined) return
        this.joined = false
        this._ws({type: "note_leave", channel: this.channel})
    }

    _ws(message) {
        const socket = global.state.websocket
        if (socket?.readyState === WebSocket.OPEN && global.state.clientID != null) {
            socket.send(JSON.stringify({...message, clientID: global.state.clientID}))
            return true
        }
        return false
    }

    sendPresence(cursor) {
        if (this.joined) this._ws({type: "note_presence", channel: this.channel, cursor})
    }

    /**
     * WS note_ops: the next operations of the log, following seq `after` (the log has gaps
     * where the server compacted it: consecutive seqs prove nothing).
     */
    onServerOps(ops, after) {
        if (!ops.length) return
        if (after === undefined ? ops[0].seq > this.lastSeq + 1 : after > this.lastSeq) {
            this.fetchMissing().catch(() => {})   // a gap: fill it (the stream's ones are skipped as already seen)
            return
        }
        this._receive(ops)
        this._saveCacheSoon()
    }

    /**
     * Apply confirmed operations in log order. Applying is idempotent: this tab's own come back
     * applied already (they just leave the pending list), and one applied before what it
     * builds on was here (a closed tab's, taken over before the log caught up) takes effect now.
     */
    _receive(ops, {silent = false} = {}) {
        const changed = new Set()
        const confirmed = new Set()
        if (!silent && ops.some(op => op.seq > this.lastSeq && !this.pendingKeys.has(opKey(op)))) {
            for (const fn of this.beforeListeners) fn()
        }
        for (const op of ops) {
            if (op.seq <= this.lastSeq) continue
            for (const key of this._confirmedBy(op)) {
                confirmed.add(key)
                this.dirty.add(op.o)
            }
            const change = this.doc.apply(op)
            if (change) changed.add(change.o)
            this.log.push(op)
            this.lastSeq = op.seq
        }
        if (confirmed.size) {
            this.pending = this.pending.filter(p => !confirmed.has(opKey(p)))
            this._scheduleProjection()
        }
        if (changed.size && !silent) this._emit(changed, {remote: true})
    }

    /**
     * The pending operations (this tab's, closed tabs') a log operation confirms, taken off
     * their lists: itself, and the inserts compaction merged into it (routes/note_compaction.py).
     */
    _confirmedBy(op) {
        const keys = [opKey(op)]
        if (op.t === "ins" && op.x.length > 1) {
            const mine = op.c === this.clientId ? this.pending : this.orphans.find(o => o.client === op.c)?.ops
            for (const p of mine || []) {
                if (p.t === "ins" && p.o === op.o && p.k > op.k && p.k < op.k + op.x.length) keys.push(opKey(p))
            }
        }
        const found = []
        for (const key of keys) {
            if (this.pendingKeys.has(key)) {
                this.pendingKeys.delete(key)
                found.push(key)
            } else if (this._takeOrphan(key)) {
                found.push(key)
            }
        }
        return found
    }

    // ── Local edits ────────────────────────────────────────────────────────

    /**
     * Turn a block as the editor holds it ({uuid, type, position, …, content}) into
     * operations: the fields that differ, then the text difference. Recorded for undo.
     */
    commitBlock(block) {
        const o = block.uuid
        const ops = []
        for (const f of BLOCK_FIELDS) {
            const value = f === "deleted" ? false : normalizeField(f, block[f])
            if (value === undefined || (this.doc.get(o, f) ?? FIELD_DEFAULTS[f]) === value) continue
            const before = this.doc.objects.get(o)?.fields.get(f)
            const op = this.doc.set(o, f, value)
            this.undo.record(op, before)
            ops.push(op)
        }
        for (const op of this.doc.replaceText(o, block.content || "")) {
            this.undo.record(op)
            ops.push(op)
        }
        this._queue(ops)
        return ops.length > 0
    }

    /**
     * A text edit made on an older state of the block (`base`, FugueText.snapshot()), applied
     * to the text as it is now. Recorded for undo. Returns the caret index after it.
     */
    commitRebased(o, base, next) {
        const {ops, index} = this.doc.rebaseText(o, base, next)
        for (const op of ops) this.undo.record(op)
        this._queue(ops)
        return index
    }

    deleteBlock(o) {
        if (this.doc.get(o, "deleted") === true) return
        const before = this.doc.objects.get(o)?.fields.get("deleted")
        const op = this.doc.set(o, "deleted", true)
        // An undo step of its own, never merged with the typing that came before
        this.undo.stopCapturing()
        this.undo.record(op, before)
        this.undo.stopCapturing()
        this._queue([op])
    }

    /** Ctrl+Z / Ctrl+Y: {changed: Set, focus} or null. */
    undoStep(redo = false) {
        const result = redo ? this.undo.redo() : this.undo.undo()
        if (!result) return null
        this._queue(result.ops)
        return {changed: new Set(result.ops.map(op => op.o)), focus: result.focus}
    }

    /**
     * Queue operations to send. A keystroke right after the previous one, not sent yet,
     * joins its operation (one stored row for a typed word, not one per character).
     */
    _queue(ops) {
        ops = ops.filter(Boolean)
        if (!ops.length) return
        for (const op of ops) {
            const last = this.pending[this.pending.length - 1]
            const merged = last && last.k > this._sentClock ? mergeOps(last, op) : null
            if (merged) {
                this.pending[this.pending.length - 1] = merged   // keeps the key of `last`
            } else {
                this.pending.push(op)
                this.pendingKeys.add(opKey(op))
            }
            this.dirty.add(op.o)
        }
        this._saveCacheSoon()
        this.pushSoon()
    }

    // ── Sending ────────────────────────────────────────────────────────────

    pushSoon(delay = PUSH_DELAY) {
        if (this._pushTimer) return
        this._pushTimer = setTimeout(() => {
            this._pushTimer = null
            this._push()
        }, delay)
    }

    _unsent() {
        const orphan = this.orphans.find(o => o.ops.some(op => op.k > o.pushed))
        if (orphan) return {orphan, client: orphan.client, ops: orphan.ops.filter(op => op.k > orphan.pushed)}
        return {orphan: null, client: this.clientId, ops: this.pending.filter(op => op.k > this._pushedClock)}
    }

    _push() {
        if (this._pushing || this.disposed) return
        // The operations of a tab that went away first (they are older), then this tab's
        const {orphan, client, ops: unsent} = this._unsent()
        const ops = takeBatch(unsent)
        if (!ops.length) return
        this._pushing = true
        const sentClock = Math.max(...ops.map(op => op.k))
        if (!orphan) this._sentClock = Math.max(this._sentClock, sentClock)
        const sync = this
        const request = xhr("note_push?channel=" + this.channel, function () {
            sync._pushing = false
            window.handleTimeoutError?.(this)   // timed out (its notification missed): the note turns read-only
            if (this.status === 200) {
                if (orphan) orphan.pushed = Math.max(orphan.pushed, sentClock)
                else sync._pushedClock = Math.max(sync._pushedClock, sentClock)
                sync._setFailed(false)
                sync._retryDelay = 0
                const rejected = JSON.parse(this.responseText || "{}").rejected || []
                if (rejected.length) sync._dropRefused(client, rejected)
                // Not in the room: the confirmations won't come by themselves
                if (!sync.joined) sync.fetchMissing().catch(() => {})
                if (sync._unsent().ops.length) sync.pushSoon()
            } else if (this.status === 403 && orphan) {
                // A closed tab of another account on this device, or rights taken away
                sync._dropRefused(client, orphan.ops.map(op => op.k))
            } else if (this.status === 403 || this.status === 404) {
                sync.resetToLog()   // rights taken away: back to what everyone else sees
            } else if (this.status === 400) {
                sync._dropRefused(client, ops.map(op => op.k))   // the request as a whole was refused
            } else {
                sync._retryLater()
            }
        }, "POST", true, {client, ops})
        request.onerror = () => {
            sync._pushing = false
            sync._retryLater()
        }
    }

    _retryLater() {
        this._setFailed(true)
        this._retryDelay = Math.min((this._retryDelay || 1000) * 2, 30000)
        this.pushSoon(this._retryDelay)
    }

    _setFailed(failed) {
        if (this.failed === failed) return
        this.failed = failed
        for (const fn of this.listeners) fn(new Set(), {status: true})
    }

    /** The server refused these operations of `client`: they go, the note is rebuilt without them. */
    _dropRefused(client, clocks) {
        const gone = new Set(clocks.map(k => client + ":" + k))
        if (client === this.clientId) {
            this.pending = this.pending.filter(op => !gone.has(opKey(op)))
            for (const key of gone) this.pendingKeys.delete(key)
        }
        for (const orphan of this.orphans.filter(o => o.client === client)) {
            orphan.ops = orphan.ops.filter(op => !gone.has(opKey(op)))
            for (const key of gone) orphan.keys.delete(key)
            if (!orphan.ops.length) this._releaseOrphan(orphan)
        }
        console.warn("[notes] the server refused", clocks.length, "operation(s) of client", client)
        window.uiAlert?.(_t("Une partie de tes dernières modifications a été refusée par le serveur et retirée de la note."))
        this._rebuild()
    }

    /**
     * Drop every operation the server didn't take (rights taken away) and rebuild the note
     * from the log: what is shown is again what everyone else sees. A new client id: what
     * the server stored under the old one comes back through the log like anyone's.
     */
    resetToLog() {
        this.pending = []
        this.pendingKeys.clear()
        for (const orphan of [...this.orphans]) this._releaseOrphan(orphan)
        this._newClient()
        this._pushedClock = 0
        this._rebuild()
        this.undo = new UndoManager(this.doc)
        this._setFailed(false)
    }

    /** The note again from the log, then what is still pending (this tab's and closed tabs'). */
    _rebuild() {
        const changed = new Set(this.doc.ids())
        const clock = this.doc.clock
        this.doc = new NoteDoc(this.clientId)
        // The clock never goes back: a dropped operation's clocks were answered for (an op
        // reusing one would never be sent), and the undo steps still name its ids
        this.doc.clock = clock
        for (const op of this.log) this.doc.apply(op)
        for (const orphan of this.orphans) for (const op of orphan.ops) this.doc.apply(op)
        for (const op of this.pending) this.doc.apply(op)
        this.undo.doc = this.doc   // its steps name characters by id: still valid
        for (const o of this.doc.ids()) changed.add(o)
        this._saveCacheSoon()
        this._emit(changed, {remote: true, reset: true})
    }

    // ── note_block, written back ───────────────────────────────────────────

    _scheduleProjection() {
        clearTimeout(this._projectTimer)
        this._projectTimer = setTimeout(() => this._project(), PROJECT_DELAY)
    }

    /** A block's note_block row as of this copy (null: not a block, or no valid place). */
    _projection(o) {
        const block = this.block(o, {withDeleted: true})
        if (!block || !isKey(block.position)) return null
        return {
            uuid: o, type: block.type, position: keyToFloat(block.position), pos_key: block.position,
            row_group: block.row_group ?? null, column_index: block.column_index ?? 0,
            sub_position: keyToFloat(block.sub_position), sub_key: isKey(block.sub_position) ? block.sub_position : "V",
            content: block.content, deleted: block.deleted, indent: block.indent,
        }
    }

    /**
     * When the note opens: a row the server holds that isn't what this copy computes (older,
     * missing, or written wrong by another client) is written again.
     */
    async _checkProjections() {
        if (!crypto.subtle) return   // not a secure context: rows are only written after edits
        await Promise.all(this.doc.ids().map(async (o) => {
            const row = this._projection(o)
            const [seq, hash] = this.proj[o] || [0, null]
            if (!row || seq > this.lastSeq) return   // not a block, or written from a newer state than this one
            if (!hash || hash !== await projectionHash(row)) this.dirty.add(o)
        }))
        if (this.dirty.size) this._scheduleProjection()
    }

    _project() {
        if (!this.dirty.size || this.disposed || !window.canEditNotes?.(this.channel)) return
        // Only what every client would compute at lastSeq: nothing of this tab pending
        if (this.pending.length || this.orphans.length) return this._scheduleProjection()
        const blocks = [...this.dirty].map(o => this._projection(o)).filter(Boolean).slice(0, MAX_BATCH)
        const sent = new Set(blocks.map(b => b.uuid))
        for (const o of [...this.dirty]) if (sent.has(o) || !this._projection(o)) this.dirty.delete(o)
        const seq = this.lastSeq
        if (!blocks.length || !seq) return
        if (this.dirty.size) this._scheduleProjection()   // more than one request's worth
        const sync = this
        const request = xhr("note_project?channel=" + this.channel, function () {
            if (this.status === 200) {
                for (const b of blocks) sync.proj[b.uuid] = [seq, null]
            } else if (this.status >= 500) {
                for (const o of sent) sync.dirty.add(o)
                sync._scheduleProjection()
            }
        }, "POST", true, {seq, blocks})
        request.onerror = () => {
            for (const o of sent) this.dirty.add(o)
            this._scheduleProjection()
        }
    }

    // ── Reading ────────────────────────────────────────────────────────────

    /** A block as the editor holds it, or null (deleted, or not a block yet). */
    block(o, {withDeleted = false} = {}) {
        const type = this.doc.get(o, "type")
        const deleted = this.doc.get(o, "deleted") !== false
        if (!type || (deleted && !withDeleted)) return null
        const block = {uuid: o, content: this.doc.text(o), deleted}
        for (const f of BLOCK_FIELDS) if (f !== "deleted") block[f] = this.doc.get(o, f)
        block.row_group ??= o
        block.column_index ??= 0
        block.indent ??= 0
        return block
    }

    blocks() {
        const blocks = {}
        for (const o of this.doc.ids()) {
            const block = this.block(o)
            if (block) blocks[o] = block
        }
        return blocks
    }

    onChange(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }

    onBeforeRemote(fn) {
        this.beforeListeners.add(fn)
        return () => this.beforeListeners.delete(fn)
    }

    _emit(changed, info) {
        for (const fn of this.listeners) fn(changed, info)
    }

    // ── Client ids, and the pending operations of closed tabs ──────────────

    _holdLock() {
        // Held while this tab lives: another tab sees this client's pending operations as taken
        navigator.locks?.request(LOCK_PREFIX + this.clientId, () => new Promise((resolve) => {
            this._releaseLock = resolve
        }))
    }

    _newClient() {
        this._releaseLock?.()
        this._releaseLock = null
        this.clientId = randomClientId()
        this._holdLock()
    }

    async _adoptOrphans(entries) {
        const confirmed = new Set(this.log.map(opKey))
        for (const {client, ops} of entries || []) {
            if (client === this.clientId || !navigator.locks) continue
            const release = await new Promise((resolve) => {
                navigator.locks.request(LOCK_PREFIX + client, {ifAvailable: true}, (lock) => {
                    if (!lock) return resolve(null)
                    return new Promise((done) => resolve(done))   // kept: this tab sends them now
                })
            })
            if (!release) continue
            const orphan = {client, ops: ops.filter(op => !confirmed.has(opKey(op))), keys: null, pushed: 0, release}
            orphan.keys = new Set(orphan.ops.map(opKey))
            this.orphans.push(orphan)
            this._cachedClients.add(client)   // its IndexedDB entry is this tab's to update now
            for (const op of orphan.ops) this.doc.apply(op)
            if (!orphan.ops.length) this._releaseOrphan(orphan)
        }
        if (this.orphans.length) this.pushSoon()
        this._saveCacheSoon()
    }

    _takeOrphan(key) {
        for (const orphan of this.orphans) {
            if (!orphan.keys.has(key)) continue
            orphan.keys.delete(key)
            orphan.ops = orphan.ops.filter(op => opKey(op) !== key)
            if (!orphan.ops.length) this._releaseOrphan(orphan)
            return true
        }
        return false
    }

    _releaseOrphan(orphan) {
        const index = this.orphans.indexOf(orphan)
        if (index >= 0) this.orphans.splice(index, 1)
        orphan.release?.()
        this._saveCacheSoon()
    }

    /** Nothing to send or write back, not on screen: can leave memory. */
    idle() {
        return !this.joined && !this._pushing && !this.pending.length && !this.orphans.length && !this.dirty.size
    }

    dispose({save = true} = {}) {
        this.disposed = true
        if (save) this.saveCache()
        for (const timer of [this._pushTimer, this._projectTimer, this._cacheTimer]) clearTimeout(timer)
        this._releaseLock?.()
        for (const orphan of this.orphans) orphan.release?.()
        if (syncs.get(this.channel) === this) syncs.delete(this.channel)
    }

    /** No access to this note anymore: it leaves memory and this device. */
    async forget() {
        this.leave()
        this.dispose({save: false})
        this.pending = []
        this.orphans = []
        await cacheDelete(this.account, this.channel)
    }

    // ── Offline cache (IndexedDB) ───────────────────────────────────────────

    _saveCacheSoon() {
        clearTimeout(this._cacheTimer)
        this._cacheTimer = setTimeout(() => this.saveCache(), 300)
    }

    /**
     * The page goes away: send what is pending with keepalive requests, which outlive it
     * (the server skips what it already has). IndexedDB keeps them, and the log, for the next tab.
     */
    flushOnExit() {
        const batches = this.orphans.map(o => ({client: o.client, ops: o.ops}))
        if (this.pending.length) batches.push({client: this.clientId, ops: this.pending})
        let budget = KEEPALIVE_BUDGET
        for (const {client, ops: all} of batches) {
            for (let ops = all; ops.length;) {
                const batch = takeBatch(ops)
                ops = ops.slice(batch.length)
                const body = JSON.stringify({client, ops: batch})
                const keepalive = body.length <= budget   // the limit is shared by every request in flight
                if (keepalive) budget -= body.length
                fetch("note_push?channel=" + this.channel, {
                    method: "POST", headers: {"Content-Type": "application/json"}, body, keepalive,
                }).catch(() => {})
            }
        }
        // Always: the last operations received too (a tab taking over pending ones builds on them)
        if (!this.disposed) this.saveCache()
    }

    /**
     * Write what changed: the note's name, the log operations not cached yet (appended, never
     * rewritten), and this tab's pending entries (its own, and those of closed tabs it took).
     */
    saveCache() {
        clearTimeout(this._cacheTimer)
        const fresh = []
        for (let i = this.log.length - 1; i >= 0 && this.log[i].seq > this._cachedSeq; i--) fresh.push(this.log[i])
        const pending = new Map()
        if (this.pending.length) pending.set(this.clientId, this.pending)
        for (const orphan of this.orphans) pending.set(orphan.client, orphan.ops)
        const gone = [...this._cachedClients].filter(client => !pending.has(client))
        const seq = this.lastSeq
        return cachePut(this.account, this.channel, {name: this.name, proj: this.proj}, fresh, pending, gone).then((ok) => {
            if (!ok) return
            this._cachedSeq = Math.max(this._cachedSeq, seq)
            for (const client of gone) this._cachedClients.delete(client)
            for (const client of pending.keys()) this._cachedClients.add(client)
        })
    }
}

/** Two consecutive operations of this tab as one (same effect, same ids), or null. */
function mergeOps(a, b) {
    if (a.o !== b.o || a.c !== b.c || a.t !== b.t) return null
    if (a.t === "ins" && b.s === "R" && b.p?.[0] === a.c && b.p[1] === a.k + a.x.length - 1
        && b.k === a.k + a.x.length && a.x.length + b.x.length <= MAX_INSERT) {
        return {...a, x: a.x + b.x}   // typed right after: a chain of right children either way
    }
    if (a.t === "del" && b.k === a.k + 1 && a.r.length + b.r.length <= MAX_RANGES
        && span(a.r) + span(b.r) <= MAX_DELETE_SPAN) {
        return {...a, r: [...a.r, ...b.r]}
    }
    return null
}

/** The first operations, as many as one request may hold. */
function takeBatch(ops) {
    let cost = 0
    let count = 0
    for (const op of ops) {
        cost += opCost(op)
        if (count && (count === MAX_BATCH || cost > MAX_BATCH_COST)) break
        count++
    }
    return ops.slice(0, count)
}

/** A field value as the CRDT stores it (keys stay keys, numbers stay integers). */
function normalizeField(f, value) {
    if (f === "position" || f === "sub_position") return isKey(value) ? value : undefined
    if (f === "column_index") return Number.isInteger(value) && value >= 0 ? value : 0
    if (f === "row_group") return value ?? null
    if (f === "indent") return Number.isInteger(value) && value >= 0 ? Math.min(value, MAX_INDENT) : undefined
    return value ?? undefined
}

/**
 * Fingerprint of a note_block row, the same as routes/notes_sync.py projection_hash. The
 * indent counts only when there is one: rows written before it existed keep their hash.
 */
export async function projectionHash(row) {
    const fields = [row.type, row.pos_key, row.row_group, row.column_index, row.sub_key,
                    Boolean(row.deleted), row.content || ""]
    if (row.indent) fields.push(row.indent)
    const text = JSON.stringify(fields)
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")
}

// ── IndexedDB, per account (built in: the framework snapshot is separate, see persistence.mjs) ──
// notes: [account, channel] → {name, proj}; ops: [account, channel, seq] → op;
// pending: [account, channel, client] → {client, ops}

const STORES = ["notes", "ops", "pending"]
let dbPromise = null

function cacheDB(account) {
    if (account === null) return Promise.resolve(null)
    if (!dbPromise) {
        dbPromise = new Promise((resolve) => {
            try {
                const request = indexedDB.open(CACHE_DB, 2)
                request.onupgradeneeded = () => {
                    const db = request.result
                    for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name)   // v1: one record per note
                    for (const name of STORES) db.createObjectStore(name)
                }
                request.onsuccess = () => {
                    const db = request.result
                    db.onversionchange = () => db.close()   // a newer page upgrades, or logout deletes it
                    resolve(db)
                }
                request.onerror = request.onblocked = () => resolve(null)
            } catch (e) {
                resolve(null)
            }
        }).then((db) => db && purgeOtherAccounts(db, account))
    }
    return dbPromise
}

/** Another account used this device before: its notes go. */
function purgeOtherAccounts(db, account) {
    return new Promise((resolve) => {
        const tx = db.transaction(STORES, "readwrite")
        for (const name of STORES) {
            tx.objectStore(name).delete(IDBKeyRange.upperBound([account], true))
            tx.objectStore(name).delete(IDBKeyRange.lowerBound([account, Infinity], true))
        }
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve(db)
    })
}

const noteRange = (account, channel) => IDBKeyRange.bound([account, channel, -Infinity], [account, channel, Infinity])

async function cacheGet(account, channel) {
    const db = await cacheDB(account)
    if (!db) return null
    return new Promise((resolve) => {
        const tx = db.transaction(STORES)
        const result = {}
        tx.objectStore("notes").get([account, channel]).onsuccess = (e) => { result.meta = e.target.result }
        tx.objectStore("ops").getAll(noteRange(account, channel)).onsuccess = (e) => { result.ops = e.target.result }
        tx.objectStore("pending").getAll(noteRange(account, channel)).onsuccess = (e) => { result.pending = e.target.result }
        tx.oncomplete = () => resolve(result.meta || result.ops?.length || result.pending?.length ? result : null)
        tx.onerror = tx.onabort = () => resolve(null)
    })
}

async function cachePut(account, channel, meta, ops, pending, gone) {
    const db = await cacheDB(account)
    if (!db) return false
    return new Promise((resolve) => {
        const tx = db.transaction(STORES, "readwrite")
        tx.objectStore("notes").put(meta, [account, channel])
        for (const op of ops) tx.objectStore("ops").put(op, [account, channel, op.seq])
        for (const [client, clientOps] of pending) tx.objectStore("pending").put({client, ops: clientOps}, [account, channel, client])
        for (const client of gone) tx.objectStore("pending").delete([account, channel, client])
        tx.oncomplete = () => resolve(true)
        tx.onerror = tx.onabort = () => resolve(false)
    })
}

async function cacheDelete(account, channel) {
    const db = await cacheDB(account)
    if (!db) return
    return new Promise((resolve) => {
        const tx = db.transaction(STORES, "readwrite")
        tx.objectStore("notes").delete([account, channel])
        tx.objectStore("ops").delete(noteRange(account, channel))
        tx.objectStore("pending").delete(noteRange(account, channel))
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve()
    })
}

/** Logout (main.mjs): every note cached on this device goes. */
export async function clearNotesCache() {
    for (const sync of [...syncs.values()]) sync.dispose({save: false})   // the database goes anyway
    const db = await dbPromise?.catch(() => null)
    db?.close()
    dbPromise = null
    await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(CACHE_DB)
        request.onsuccess = request.onerror = request.onblocked = () => resolve()
    })
}

// Pending operations leave with the page (and reach IndexedDB) before the tab goes away
window.addEventListener("pagehide", () => {
    for (const sync of syncs.values()) sync.flushOnExit()
})
