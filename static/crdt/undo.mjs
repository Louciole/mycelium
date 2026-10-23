/**
 * Undo / redo of this tab's own operations on a NoteDoc. Undoing makes new operations
 * (sent like any edit), so it reaches everyone; it never touches what someone else did:
 *   - a field goes back to its previous value only if it still holds the value written
 *     here (nobody changed it since);
 *   - typed text is deleted again (only the characters still there);
 *   - deleted text is typed again where it stood.
 * Operations made within `captureTimeout` ms in the same object form one step, and
 * `stopCapturing()` closes a step (Enter, another block, a menu action…).
 */

export class UndoManager {
    constructor(doc, {captureTimeout = 500, limit = 200} = {}) {
        this.doc = doc
        this.captureTimeout = captureTimeout
        this.limit = limit
        this.undoStack = []
        this.redoStack = []
        this._lastTime = 0
        this._closed = true
    }

    /**
     * Record a local operation the user made. `before`: for a "set", the field's entry
     * before it ({v, k, c} or undefined). Clears the redo stack, like any editor.
     */
    record(op, before, now = Date.now()) {
        if (!op) return
        const entry = toEntry(op, before)
        if (!entry) return
        const top = this.undoStack[this.undoStack.length - 1]
        // In transact(): the first operation opens the step, the others join it
        const joins = top && !this._startGroup && (this._grouping
            || (!this._closed && now - this._lastTime < this.captureTimeout && top.objects.has(entry.o)))
        if (this._startGroup) {
            this._startGroup = false
            this._grouping = true
        }
        if (joins) {
            top.entries.push(entry)
            top.objects.add(entry.o)
        } else {
            this.undoStack.push({entries: [entry], objects: new Set([entry.o])})
            if (this.undoStack.length > this.limit) this.undoStack.shift()
        }
        this._closed = false
        this._lastTime = now
        this.redoStack = []
    }

    stopCapturing() {
        this._closed = true
    }

    /** Everything recorded during fn() is one step (Enter: the end of a block moves to a new one). */
    transact(fn) {
        this.stopCapturing()
        this._grouping = false
        this._startGroup = true
        try {
            return fn()
        } finally {
            this._grouping = false
            this._startGroup = false
            this.stopCapturing()
        }
    }

    canUndo() {
        return this.undoStack.length > 0
    }

    canRedo() {
        return this.redoStack.length > 0
    }

    /** Undo one step: {ops, focus: {o, index} | null}, or null if there is nothing to undo. */
    undo() {
        return this._revert(this.undoStack, this.redoStack)
    }

    redo() {
        return this._revert(this.redoStack, this.undoStack)
    }

    _revert(from, to) {
        this.stopCapturing()
        // A step whose every change was overwritten by someone else is skipped
        while (from.length) {
            const step = from.pop()
            const ops = []
            const inverse = []
            let focus = null
            for (const entry of [...step.entries].reverse()) {
                const result = this._invert(entry)
                if (!result) continue
                ops.push(...result.ops)
                inverse.push(result.entry)   // reverted in reverse order again: the original order
                if (result.focus) focus = result.focus
            }
            if (ops.length) {
                to.push({entries: inverse, objects: new Set(inverse.map(e => e.o))})
                return {ops, focus}
            }
        }
        return null
    }

    _invert(entry) {
        const doc = this.doc
        if (entry.kind === "set") {
            const stamp = doc.stamp(entry.o, entry.f)
            if (!stamp || stamp.k !== entry.k || stamp.c !== entry.c) return null   // changed by someone since
            // A block that did not exist before: undoing its creation deletes it
            const value = entry.before ? entry.before.v : (entry.f === "deleted" ? true : undefined)
            if (value === undefined) return null
            const before = {v: entry.v, k: entry.k, c: entry.c}
            const op = doc.set(entry.o, entry.f, value)
            return {ops: [op], entry: {kind: "set", o: entry.o, f: entry.f, v: value, k: op.k, c: op.c, before}}
        }
        const text = doc.textOf(entry.o)
        if (entry.kind === "ins") {
            const ranges = text.visibleIdsOf(entry.ranges)
            if (!ranges.length) return null
            const index = text.indexOf([ranges[0][0], ranges[0][1]]) - 1
            return {ops: doc.deleteIds(entry.o, ranges), entry: {kind: "del", o: entry.o, ranges}, focus: {o: entry.o, index}}
        }
        // "del": type the deleted characters again where they stood
        const deleted = text.deletedTextOf(entry.ranges)
        if (!deleted) return null
        const ops = doc.insert(entry.o, deleted.index, deleted.text)
        return {
            ops,
            entry: {kind: "ins", o: entry.o, ranges: ops.map(op => [op.c, op.k, op.k + op.x.length - 1])},
            focus: {o: entry.o, index: deleted.index + deleted.text.length},
        }
    }
}

function toEntry(op, before) {
    if (op.t === "set") return {kind: "set", o: op.o, f: op.f, v: op.v, k: op.k, c: op.c, before}
    if (op.t === "ins") return {kind: "ins", o: op.o, ranges: [[op.c, op.k, op.k + op.x.length - 1]]}
    if (op.t === "del") return {kind: "del", o: op.o, ranges: op.r}
    return null
}
