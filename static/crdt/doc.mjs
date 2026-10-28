/**
 * A note as a CRDT: a set of objects (the blocks) keyed by uuid, each with fields where
 * the last write wins and a text (the block's markdown source, a Fugue sequence).
 *
 * Operations (JSON, what the server stores and relays, see routes/notes_sync.py):
 *   {c, k, o, t: "set", f, v}            field f of object o becomes v
 *   {c, k, o, t: "ins", p, s, x}         text x inserted (ids k … k + x.length - 1)
 *   {c, k, o, t: "del", r}               the characters of the id ranges r deleted
 * c: the client (a random id per tab, bound to an account by the server); k: its Lamport
 * clock (above every clock this replica has seen). A field's value is the one written
 * by the highest (k, c): replicas that saw the same operations agree, in any order.
 */
import {FugueText, compressRanges} from "./fugue.mjs"

/** Fields a block has in the CRDT (the server accepts no other). */
export const BLOCK_FIELDS = ["type", "position", "row_group", "column_index", "sub_position", "indent", "deleted"]
/** What a field never set reads as (a field added after notes existed): setting it to that changes nothing. */
export const FIELD_DEFAULTS = {indent: 0}

// Per-operation limits, the same as the server's (routes/notes_sync.py): bigger edits are split
export const MAX_INSERT = 100_000     // characters (UTF-16 units) of one insert
export const MAX_RANGES = 1000        // id ranges of one delete
export const MAX_DELETE_SPAN = 100_000   // clocks covered by the ranges of one delete
export const MAX_INDENT = 5             // list item levels below the first one (indent 0 … 5)

const isHighSurrogate = (s, i) => (s.charCodeAt(i) & 0xFC00) === 0xD800
const isLowSurrogate = (s, i) => (s.charCodeAt(i) & 0xFC00) === 0xDC00

const newer = (a, b) => (a.k - b.k || a.c - b.c) > 0

/**
 * What changed between two texts: {start, end} = the lengths of their common prefix and suffix.
 * The cut never falls inside a surrogate pair (an emoji): half of one is not text, and the
 * server refuses it.
 */
export function changedSpan(current, next) {
    let start = 0
    while (start < current.length && start < next.length && current[start] === next[start]) start++
    if (start > 0 && isHighSurrogate(current, start - 1)) start--
    let end = 0
    while (end < current.length - start && end < next.length - start
           && current[current.length - 1 - end] === next[next.length - 1 - end]) end++
    if (end > 0 && isLowSurrogate(current, current.length - end)) end--
    return {start, end}
}

export class NoteDoc {
    constructor(clientId) {
        this.clientId = clientId
        this.clock = 0
        this.objects = new Map()   // uuid → {fields: Map(field → {v, k, c}), text: FugueText | null}
    }

    _obj(id) {
        let obj = this.objects.get(id)
        if (!obj) {
            obj = {fields: new Map(), text: null}
            this.objects.set(id, obj)
        }
        return obj
    }

    _text(id) {
        const obj = this._obj(id)
        return obj.text ?? (obj.text = new FugueText())
    }

    /** Clocks [k, k + n) for a local operation. */
    _tick(n = 1) {
        const k = this.clock + 1
        this.clock += n
        return k
    }

    /**
     * Apply an operation (local or from the server). Returns {o, field} / {o, text: true}
     * when it changed something, null otherwise (already applied, superseded, or
     * referencing something this note never had).
     */
    apply(op) {
        if (!op || typeof op.o !== "string" || !Number.isSafeInteger(op.c) || !Number.isSafeInteger(op.k)) return null
        if (op.t === "set") {
            this.clock = Math.max(this.clock, op.k)
            const fields = this._obj(op.o).fields
            const current = fields.get(op.f)
            if (current && !newer(op, current)) return null
            fields.set(op.f, {v: op.v, k: op.k, c: op.c})
            return {o: op.o, field: op.f}
        }
        if (op.t === "ins") {
            if (typeof op.x !== "string" || !op.x) return null
            this.clock = Math.max(this.clock, op.k + op.x.length - 1)
            return this._text(op.o).applyInsert(op.c, op.k, op.p ?? null, op.s, op.x) ? {o: op.o, text: true} : null
        }
        if (op.t === "del") {
            if (!Array.isArray(op.r)) return null
            this.clock = Math.max(this.clock, op.k)
            return this._text(op.o).applyDelete(op.r) ? {o: op.o, text: true} : null
        }
        return null
    }

    // ── Local operations: built, applied here, returned to be sent ──────────────

    set(o, f, v) {
        const op = {c: this.clientId, k: this._tick(), o, t: "set", f, v}
        this.apply(op)
        return op
    }

    /** Insert text at a visible index: one operation per MAX_INSERT characters (a pair never split). */
    insert(o, index, text) {
        const ops = []
        for (let at = 0; at < text.length;) {
            let end = Math.min(at + MAX_INSERT, text.length)
            if (end < text.length && isLowSurrogate(text, end)) end--
            const chunk = text.slice(at, end)
            const {parent, side} = this._text(o).insertionPoint(index + at)
            const op = {c: this.clientId, k: this._tick(chunk.length), o, t: "ins", p: parent, s: side, x: chunk}
            this.apply(op)
            ops.push(op)
            at = end
        }
        return ops
    }

    delete(o, index, length) {
        if (length <= 0) return []
        return this.deleteIds(o, this._text(o).rangesAt(index, length))
    }

    /** Delete id ranges: one operation per MAX_RANGES ranges / MAX_DELETE_SPAN clocks. */
    deleteIds(o, ranges) {
        const ops = []
        let batch = [], span = 0
        const flush = () => {
            if (!batch.length) return
            const op = {c: this.clientId, k: this._tick(), o, t: "del", r: batch}
            this.apply(op)
            ops.push(op)
            batch = []
            span = 0
        }
        for (let [c, from, to] of ranges) {
            while (from <= to) {
                const take = Math.min(to - from + 1, MAX_DELETE_SPAN - span)
                batch.push([c, from, from + take - 1])
                span += take
                from += take
                if (batch.length === MAX_RANGES || span === MAX_DELETE_SPAN) flush()
            }
        }
        flush()
        return ops
    }

    /** The operations turning the text of `o` into `next` (deletes, then inserts). */
    replaceText(o, next) {
        const current = this.text(o)
        if (current === next) return []
        const {start, end} = changedSpan(current, next)
        return [
            ...this.delete(o, start, current.length - start - end),
            ...this.insert(o, start, next.slice(start, next.length - end)),
        ]
    }

    /**
     * An edit made on an older state of the text of `o` (`base`: {text, ids}, from
     * textOf(o).snapshot()), turning it into `next`, applied to the text as it is now: what
     * others changed meanwhile stays. Returns {ops, index}: the visible index right after
     * the inserted text (the caret).
     */
    rebaseText(o, base, next) {
        const {start, end} = changedSpan(base.text, next)
        const text = this._text(o)
        // The characters the edit removed, by id: those someone else deleted already are skipped
        const removed = text.visibleIdsOf(compressRanges(base.ids.slice(start, base.text.length - end)))
        const ops = this.deleteIds(o, removed)
        // The insert goes right after the character it followed (wherever it is now)
        const index = start > 0 ? text.indexOf(base.ids[start - 1]) : 0
        const inserted = next.slice(start, next.length - end)
        ops.push(...this.insert(o, index, inserted))
        return {ops, index: index + inserted.length}
    }

    // ── Reading ────────────────────────────────────────────────────────────────

    has(o) {
        return this.objects.has(o)
    }

    ids() {
        return [...this.objects.keys()]
    }

    get(o, f) {
        return this.objects.get(o)?.fields.get(f)?.v
    }

    /** The stamp {k, c} of the current value of a field (undefined: never written). */
    stamp(o, f) {
        const entry = this.objects.get(o)?.fields.get(f)
        return entry ? {k: entry.k, c: entry.c} : undefined
    }

    text(o) {
        return this.objects.get(o)?.text?.toString() ?? ""
    }

    textOf(o) {
        return this._text(o)
    }
}
