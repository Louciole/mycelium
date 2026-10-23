/**
 * Fugue: the text sequence CRDT of a block (Weidner & Kleppmann, "The Art of the Fugue:
 * Minimizing Interleaving in Collaborative Text Editing", 2023), tree form.
 *
 * Every UTF-16 code unit ever typed is a node with a unique id {c: client, k: clock},
 * a parent node and a side (left or right child). The text is the in-order traversal
 * (left children, the node, right children) of the visible nodes; a deleted node stays
 * in the tree as a tombstone, so every id keeps its place and late operations still
 * find it. Siblings are sorted by id, so every replica builds the same tree whatever
 * the order the operations arrived in: replicas that applied the same operations show
 * the same text.
 *
 * Insert rule (local, at a visible index): the new node goes right after `left` (the
 * visible node before the caret, or the root): as its right child if it has none,
 * otherwise as the left child of the node that follows `left` in the traversal. A run of
 * typed characters is a chain of right children, so two people typing at the same spot
 * never get their characters interleaved.
 */

export const compareIds = (a, b) => (a.c - b.c) || (a.k - b.k)
const keyOf = (c, k) => c + ":" + k

export class FugueText {
    constructor() {
        this.root = {c: -1, k: -1, ch: "", deleted: true, left: [], right: []}
        this.nodes = new Map()   // "c:k" → node
        this.byClient = new Map()   // client → its nodes sorted by clock (id ranges → nodes)
        this._invalidate()
    }

    _invalidate() {
        this._order = null       // every node in traversal order, tombstones included
        this._visible = null     // the visible nodes, in order
        this._rank = null        // node → [its index in _order, visible nodes up to and including it]
        this._text = null
    }

    node(id) {
        return id ? this.nodes.get(keyOf(id[0], id[1])) : null
    }

    /**
     * Apply an insert: `text` gets the ids (c, k) … (c, k + length - 1). parent: [c, k] or
     * null (the root); side: "L" or "R". An operation already applied, or whose parent
     * this replica never saw, changes nothing (every replica decides the same way: the
     * server only accepts references to operations stored before it). One partly applied
     * (a run of typing merged by compaction, routes/note_compaction.py, whose first part
     * this replica has) adds only the characters it lacks, where they belong.
     */
    applyInsert(c, k, parent, side, text) {
        if (!text) return false
        const parentNode = parent === null ? this.root : this.node(parent)
        if (!parentNode || (side !== "L" && side !== "R") || (parentNode === this.root && side !== "R")) return false
        let previous = null
        const created = []
        for (let i = 0; i < text.length; i++) {
            const existing = this.nodes.get(keyOf(c, k + i))
            if (existing) {
                previous = existing
                continue
            }
            const node = {c, k: k + i, ch: text[i], deleted: false, left: [], right: [], parent: previous ?? parentNode}
            insertSorted(previous ? previous.right : (side === "L" ? parentNode.left : parentNode.right), node)
            this.nodes.set(keyOf(c, k + i), node)
            created.push(node)
            previous = node
        }
        if (!created.length) return false
        this._index(c, created)
        this._invalidate()
        return true
    }

    /** Add one client's nodes (increasing clocks) to its sorted list. */
    _index(c, nodes) {
        let list = this.byClient.get(c)
        if (!list) this.byClient.set(c, list = [])
        if (!list.length || list[list.length - 1].k < nodes[0].k) {
            for (const node of nodes) list.push(node)
        } else if (nodes[nodes.length - 1].k - nodes[0].k === nodes.length - 1) {
            list.splice(lowerBound(list, nodes[0].k), 0, ...nodes)   // one run: no clock of it is there
        } else {
            for (const node of nodes) list.splice(lowerBound(list, node.k), 0, node)
        }
    }

    /**
     * The nodes of id ranges [[c, from, to], …] that exist. The cost follows the nodes found,
     * never the width of a range (a range can name clocks this note never had).
     */
    *_nodesIn(ranges) {
        for (const [c, from, to] of ranges) {
            const list = this.byClient.get(c)
            if (!list) continue
            for (let i = lowerBound(list, from); i < list.length && list[i].k <= to; i++) yield list[i]
        }
    }

    /** Apply a delete of id ranges [[c, from, to], …] (inclusive). True if a visible node went away. */
    applyDelete(ranges) {
        let changed = false
        for (const node of this._nodesIn(ranges)) {
            if (!node.deleted) {
                node.deleted = true
                changed = true
            }
        }
        if (changed) this._invalidate()
        return changed
    }

    /** Traversal order, iterative: a long typed run is a deep chain of right children. */
    order() {
        if (this._order) return this._order
        const order = []
        const stack = [[this.root, false]]
        while (stack.length) {
            const [node, expanded] = stack.pop()
            if (expanded) {
                if (node !== this.root) order.push(node)
                continue
            }
            for (let i = node.right.length - 1; i >= 0; i--) stack.push([node.right[i], false])
            stack.push([node, true])
            for (let i = node.left.length - 1; i >= 0; i--) stack.push([node.left[i], false])
        }
        this._order = order
        return order
    }

    visible() {
        if (!this._visible) this._visible = this.order().filter(n => !n.deleted)
        return this._visible
    }

    _ranks() {
        if (this._rank) return this._rank
        const rank = new Map()
        let seen = 0
        this.order().forEach((node, i) => {
            if (!node.deleted) seen++
            rank.set(node, [i, seen])
        })
        this._rank = rank
        return rank
    }

    toString() {
        if (this._text === null) this._text = this.visible().map(n => n.ch).join("")
        return this._text
    }

    get length() {
        return this.visible().length
    }

    /** Where a local insert at visible `index` attaches: {parent: [c, k] | null, side}. */
    insertionPoint(index) {
        const visible = this.visible()
        index = Math.max(0, Math.min(index, visible.length))
        const left = index === 0 ? this.root : visible[index - 1]
        if (left.right.length === 0) return {parent: left === this.root ? null : [left.c, left.k], side: "R"}
        const order = this.order()
        const next = order[left === this.root ? 0 : this._ranks().get(left)[0] + 1]
        return {parent: [next.c, next.k], side: "L"}
    }

    /** The text and the id of each of its characters: an edit made on it can be applied later (rebaseText). */
    snapshot() {
        return {text: this.toString(), ids: this.visible().map(n => [n.c, n.k])}
    }

    /** The id ranges of the visible text [index, index + length), compressed: [[c, from, to], …]. */
    rangesAt(index, length) {
        return compressIds(this.visible().slice(index, index + length))
    }

    /** Caret anchor: the id of the character left of `index` (null: the start). It follows edits. */
    anchorAt(index) {
        const visible = this.visible()
        const node = index > 0 ? visible[Math.min(index, visible.length) - 1] : null
        return node ? [node.c, node.k] : null
    }

    /** Visible index right after an anchor (its character may have been deleted since). */
    indexOf(anchor) {
        const node = this.node(anchor)
        return node ? this._ranks().get(node)[1] : 0
    }

    /**
     * The characters of these ids still deleted, in text order, and the visible index
     * where they stood (undo re-inserts them there).
     */
    deletedTextOf(ranges) {
        const rank = this._ranks()
        const nodes = [...this._nodesIn(ranges)].filter(n => n.deleted).sort((a, b) => rank.get(a)[0] - rank.get(b)[0])
        if (!nodes.length) return null
        return {text: nodes.map(n => n.ch).join(""), index: rank.get(nodes[0])[1]}
    }

    /** The visible ids among these ranges (undo deletes what an insert added, if still there). */
    visibleIdsOf(ranges) {
        return compressIds([...this._nodesIn(ranges)].filter(n => !n.deleted))
    }
}

/** First index of a clock-sorted node list whose clock is >= k. */
function lowerBound(list, k) {
    let lo = 0, hi = list.length
    while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (list[mid].k < k) lo = mid + 1
        else hi = mid
    }
    return lo
}

function insertSorted(siblings, node) {
    let i = siblings.length
    while (i > 0 && compareIds(siblings[i - 1], node) > 0) i--
    siblings.splice(i, 0, node)
}

/** Ids [c, k] in a row: consecutive clocks of one client become one range [c, from, to]. */
export function compressRanges(ids) {
    const ranges = []
    for (const [c, k] of ids) {
        const last = ranges[ranges.length - 1]
        if (last && last[0] === c && last[2] + 1 === k) last[2] = k
        else ranges.push([c, k, k])
    }
    return ranges
}

const compressIds = (nodes) => compressRanges(nodes.map(n => [n.c, n.k]))
