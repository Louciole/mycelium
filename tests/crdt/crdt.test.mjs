// CRDT core of the notes (static/crdt/). Run: node --test tests/crdt/
import {test} from "node:test"
import assert from "node:assert/strict"
import {keyBetween, isKey, keyToFloat} from "../../static/crdt/keys.mjs"
import {NoteDoc} from "../../static/crdt/doc.mjs"
import {UndoManager} from "../../static/crdt/undo.mjs"

// Small deterministic PRNG: a failing seed can be replayed
function rng(seed) {
    let s = seed >>> 0
    return () => {
        s = (s + 0x6D2B79F5) >>> 0
        let t = s
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)]
const applyAll = (doc, ops) => ops.forEach(op => doc.apply(op))

// ── Fractional keys ──────────────────────────────────────────────────────────

test("keys: always strictly between, valid, and short when appending", () => {
    const rand = rng(1)
    let keys = [keyBetween(null, null)]
    for (let i = 0; i < 3000; i++) {
        const at = Math.floor(rand() * (keys.length + 1))
        const key = keyBetween(keys[at - 1] ?? null, keys[at] ?? null)
        assert.ok(isKey(key), key)
        if (at > 0) assert.ok(keys[at - 1] < key, `${keys[at - 1]} < ${key}`)
        if (at < keys.length) assert.ok(key < keys[at], `${key} < ${keys[at]}`)
        assert.ok(at === 0 || keyToFloat(keys[at - 1]) <= keyToFloat(key))
        keys.splice(at, 0, key)
    }
    let last = null
    for (let i = 0; i < 1000; i++) last = keyBetween(last, null)
    assert.ok(last.length <= 20, last)
    // Typing line after line in the middle of a list
    let a = "1", b = "2"
    for (let i = 0; i < 300; i++) a = keyBetween(a, b)
    assert.ok(a.length <= 12 && a < b, a)
    // Equal bounds (two members inserting at the same place) still give a key after `a`
    assert.ok(keyBetween("V", "V") > "V")
})

// ── Simulation: replicas, a server log, deliveries in any causal order ────────

const FIELDS = {type: ["text", "heading1", "checklist"], deleted: [true, false], position: ["1", "2", "V"]}
const OBJECTS = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]

function randomLocalOp(rand, doc) {
    const o = pick(rand, OBJECTS)
    const roll = rand()
    if (roll < 0.15) {
        const f = pick(rand, Object.keys(FIELDS))
        return [doc.set(o, f, pick(rand, FIELDS[f]))]
    }
    const length = doc.textOf(o).length
    if (roll < 0.65 || length === 0) {
        const text = pick(rand, ["a", "bc", "xyz", "é", "😀", "hello ", "\n"])
        return doc.insert(o, Math.floor(rand() * (length + 1)), text)
    }
    if (roll < 0.9) {
        const index = Math.floor(rand() * length)
        return doc.delete(o, index, 1 + Math.floor(rand() * Math.min(4, length - index)))
    }
    const next = doc.text(o).split("").reverse().join("").slice(0, 8) + "!"
    return doc.replaceText(o, next)
}

const state = (doc) => JSON.stringify(OBJECTS.map(o => [doc.text(o), ...Object.keys(FIELDS).map(f => doc.get(o, f))]))

/** Ids an operation needs to exist before it can apply (its parent, the characters it deletes). */
function requires(op) {
    if (op.t === "ins") return op.p ? [op.p] : []
    if (op.t === "del") return op.r.flatMap(([c, from, to]) => Array.from({length: to - from + 1}, (_, i) => [c, from + i]))
    return []
}

function simulate(seed, replicas = 4, steps = 400) {
    const rand = rng(seed)
    const docs = Array.from({length: replicas}, (_, i) => new NoteDoc(i + 1))
    const outbox = docs.map(() => [])
    const log = []                      // what the server stored, in its order
    const delivered = docs.map(() => 0) // how much of the log each replica applied
    for (let step = 0; step < steps; step++) {
        const roll = rand()
        const r = Math.floor(rand() * replicas)
        if (roll < 0.5) outbox[r].push(...randomLocalOp(rand, docs[r]).filter(Boolean))
        else if (roll < 0.75 && outbox[r].length) log.push(...outbox[r].splice(0, 1 + Math.floor(rand() * outbox[r].length)))
        else {
            // Deliver some of the log (own operations are already applied: skipped)
            const until = delivered[r] + Math.floor(rand() * (log.length - delivered[r] + 1))
            for (; delivered[r] < until; delivered[r]++) if (log[delivered[r]].c !== r + 1) docs[r].apply(log[delivered[r]])
        }
    }
    for (let r = 0; r < replicas; r++) log.push(...outbox[r].splice(0))
    for (let r = 0; r < replicas; r++) for (; delivered[r] < log.length; delivered[r]++) if (log[delivered[r]].c !== r + 1) docs[r].apply(log[delivered[r]])
    return {docs, log}
}

test("convergence: replicas end up identical, and equal to a replay of the server log", () => {
    for (let seed = 1; seed <= 300; seed++) {
        const {docs, log} = simulate(seed)
        const replay = new NoteDoc(999)
        for (const op of log) replay.apply(op)
        const expected = state(replay)
        for (const doc of docs) assert.equal(state(doc), expected, `seed ${seed}`)
    }
})

test("commutativity: any order that respects dependencies gives the same note", () => {
    for (let seed = 1; seed <= 150; seed++) {
        const {log} = simulate(seed, 3, 250)
        const reference = new NoteDoc(999)
        for (const op of log) reference.apply(op)
        const rand = rng(seed * 7919)
        for (let round = 0; round < 3; round++) {
            const doc = new NoteDoc(998)
            const seen = new Set()
            const pending = [...log]
            while (pending.length) {
                const ready = pending.filter(op => requires(op).every(([c, k]) => seen.has(c + ":" + k)))
                const op = pick(rand, ready)
                pending.splice(pending.indexOf(op), 1)
                doc.apply(op)
                if (op.t === "ins") for (let i = 0; i < op.x.length; i++) seen.add(op.c + ":" + (op.k + i))
            }
            assert.equal(state(doc), state(reference), `seed ${seed} round ${round}`)
        }
    }
})

test("applying an operation twice, or one whose parent never existed, changes nothing", () => {
    const a = new NoteDoc(1)
    const [op] = a.insert(OBJECTS[0], 0, "abc")
    const b = new NoteDoc(2)
    b.apply(op)
    assert.equal(b.apply(op), null)
    assert.equal(b.apply({c: 3, k: 50, o: OBJECTS[0], t: "ins", p: [7, 7], s: "R", x: "zz"}), null)
    assert.equal(b.apply({c: 3, k: 51, o: OBJECTS[0], t: "ins", p: null, s: "L", x: "zz"}), null)
    assert.equal(b.text(OBJECTS[0]), "abc")
})

// ── Fugue: no interleaving ───────────────────────────────────────────────────

test("two people typing at the same place never get their words interleaved", () => {
    const o = OBJECTS[0]
    const a = new NoteDoc(1), b = new NoteDoc(2)
    const [base] = a.insert(o, 0, "[]")
    b.apply(base)
    const opsA = [], opsB = []
    for (const ch of "hello") opsA.push(...a.insert(o, a.textOf(o).length - 1, ch))   // typed inside "[]"
    for (const ch of "world") opsB.push(...b.insert(o, b.textOf(o).length - 1, ch))
    for (const op of opsB) a.apply(op)
    for (const op of opsA) b.apply(op)
    assert.equal(a.text(o), b.text(o))
    assert.ok(["[helloworld]", "[worldhello]"].includes(a.text(o)), a.text(o))
    // Backwards typing (caret kept at the start) does not interleave either
    const c = new NoteDoc(3), d = new NoteDoc(4)
    const [start] = c.insert(o, 0, "|")
    d.apply(start)
    const opsC = [], opsD = []
    for (const ch of "cba") opsC.push(...c.insert(o, 0, ch))
    for (const ch of "zyx") opsD.push(...d.insert(o, 0, ch))
    for (const op of opsD) c.apply(op)
    for (const op of opsC) d.apply(op)
    assert.equal(c.text(o), d.text(o))
    assert.ok(["abcxyz|", "xyzabc|"].includes(c.text(o)), c.text(o))
})

test("a caret anchor follows the text other people insert before it", () => {
    const o = OBJECTS[0]
    const a = new NoteDoc(1), b = new NoteDoc(2)
    applyAll(b, a.insert(o, 0, "hello world"))
    const anchor = b.textOf(o).anchorAt(6)            // caret before "world"
    applyAll(a, b.delete(o, 0, 0))
    applyAll(b, a.insert(o, 0, ">> "))
    assert.equal(b.textOf(o).indexOf(anchor), 9)
    applyAll(b, a.delete(o, 3 + 4, 2))                   // "o " deleted: the anchor's character too
    assert.equal(b.text(o), ">> hellworld")
    assert.equal(b.textOf(o).indexOf(anchor), 7)
})

// ── Undo / redo ──────────────────────────────────────────────────────────────

test("undo only removes my own typing; redo puts it back in the same place", () => {
    const o = OBJECTS[0]
    const a = new NoteDoc(1), b = new NoteDoc(2)
    const undo = new UndoManager(a)
    let t = 0
    for (const ch of "hello") {
        const [op] = a.insert(o, a.textOf(o).length, ch)
        undo.record(op, undefined, t += 10)
        b.apply(op)
    }
    const [theirs] = b.insert(o, 5, " world")
    a.apply(theirs)
    assert.equal(a.text(o), "hello world")
    const result = undo.undo()
    assert.equal(a.text(o), " world")
    assert.deepEqual(result.focus, {o, index: 0})
    for (const op of result.ops) b.apply(op)
    assert.equal(b.text(o), " world")
    for (const op of undo.redo().ops) b.apply(op)
    assert.equal(a.text(o), "hello world")
    assert.equal(b.text(o), "hello world")
    assert.equal(undo.canRedo(), false)
})

test("undo of deletes types the text back in order; redo deletes it again", () => {
    const o = OBJECTS[0]
    const a = new NoteDoc(1)
    const undo = new UndoManager(a)
    a.insert(o, 0, "abcdef")
    undo.stopCapturing()
    let t = 1000
    for (let i = 0; i < 3; i++) undo.record(a.delete(o, a.textOf(o).length - 1, 1)[0], undefined, t += 10)   // Backspace ×3
    assert.equal(a.text(o), "abc")
    undo.undo()
    assert.equal(a.text(o), "abcdef")
    undo.redo()
    assert.equal(a.text(o), "abc")
    undo.undo()
    assert.equal(a.text(o), "abcdef")
})

test("undo never overwrites a field someone changed after me; it undoes a block creation", () => {
    const o = OBJECTS[0]
    const a = new NoteDoc(1), b = new NoteDoc(2)
    const undo = new UndoManager(a)
    const created = undo.transact(() => ["deleted", "type"].map(f => {
        const before = a.objects.get(o)?.fields.get(f)
        const op = a.set(o, f, f === "deleted" ? false : "text")
        undo.record(op, before)
        return op
    }))
    created.forEach(op => b.apply(op))
    undo.stopCapturing()
    const before = a.objects.get(o).fields.get("type")
    const mine = a.set(o, "type", "heading1")
    undo.record(mine, before, 5000)
    b.apply(mine)
    a.apply(b.set(o, "type", "heading2"))              // someone else, after me
    undo.undo()                                         // my heading1 step: nothing to revert → the creation
    assert.equal(a.get(o, "type"), "heading2")
    assert.equal(a.get(o, "deleted"), true)
    undo.redo()
    assert.equal(a.get(o, "deleted"), false)
})

// ── Review fixes (2026-10-22) ────────────────────────────────────────────────

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

test("keys: inserting again and again in the same gap stays short", () => {
    let top = keyBetween(null, null)
    for (let i = 0; i < 1000; i++) top = keyBetween(null, top)            // always at the top of the note
    assert.ok(top.length <= 40, top)
    let a = keyBetween(null, null), below = keyBetween(a, null)
    for (let i = 0; i < 1000; i++) below = keyBetween(a, below)         // always right below the same line
    assert.ok(below.length <= 40 && a < below, below)
})

test("an edit never sends half of an emoji (the server refuses lone surrogates)", () => {
    const rand = rng(7)
    const pieces = ["😀", "👍", "😁", "a", "é", "🇫🇷", " "]
    for (let round = 0; round < 300; round++) {
        const doc = new NoteDoc(1)
        const o = OBJECTS[0]
        let text = ""
        for (let step = 0; step < 12; step++) {
            const chars = Array.from(text)                               // whole code points
            const at = Math.floor(rand() * (chars.length + 1))
            const cut = Math.floor(rand() * 3)
            chars.splice(at, cut, ...Array.from({length: Math.floor(rand() * 3)}, () => pick(rand, pieces)))
            text = chars.join("")
            for (const op of doc.replaceText(o, text)) {
                if (op.t === "ins") assert.ok(!LONE_SURROGATE.test(op.x), JSON.stringify(op.x))
            }
            assert.equal(doc.text(o), text)
        }
    }
    const doc = new NoteDoc(1)
    doc.replaceText(OBJECTS[0], "😀")
    const [op] = doc.replaceText(OBJECTS[0], "👍😀")                   // typed right before another emoji
    assert.equal(op.x, "👍")
})

test("a delete costs what exists, not the width of its ranges", () => {
    const doc = new NoteDoc(1), o = OBJECTS[0]
    doc.insert(o, 0, "hello")
    const ranges = Array.from({length: 1000}, (_, i) => [42, 1 + i * 100000, (i + 1) * 100000])
    const start = performance.now()
    doc.apply({c: 42, k: 2 ** 40, o, t: "del", r: ranges})
    doc.apply({c: 1, k: 2 ** 40 + 1, o, t: "del", r: Array(1000).fill([1, 1, 100000])})
    assert.ok(performance.now() - start < 200, `${performance.now() - start} ms`)
    assert.equal(doc.text(o), "")
})

test("big edits are split to the server's per-operation limits", async () => {
    const {MAX_INSERT, MAX_RANGES, MAX_DELETE_SPAN} = await import("../../static/crdt/doc.mjs")
    const a = new NoteDoc(1), b = new NoteDoc(2), o = OBJECTS[0]
    const big = "x".repeat(MAX_INSERT - 1) + "😀" + "y".repeat(MAX_INSERT + 5)
    const inserted = a.insert(o, 0, big)
    assert.ok(inserted.length >= 3 && inserted.every(op => op.x.length <= MAX_INSERT && !LONE_SURROGATE.test(op.x)))
    applyAll(b, inserted)
    assert.equal(b.text(o), big)
    // Every other character deleted, then the rest: many ranges, a wide span
    const holes = []
    for (let i = 0; i < 3000; i += 2) holes.push(...a.delete(o, i / 2, 1))
    const rest = a.delete(o, 0, a.textOf(o).length)
    for (const op of rest) {
        const span = op.r.reduce((sum, [, from, to]) => sum + to - from + 1, 0)
        assert.ok(op.r.length <= MAX_RANGES && span <= MAX_DELETE_SPAN, `${op.r.length} ranges, span ${span}`)
    }
    applyAll(b, holes)
    applyAll(b, rest)
    assert.equal(a.text(o), "")
    assert.equal(b.text(o), "")
})

test("an edit made on an older text (input method composing) keeps what others typed meanwhile", () => {
    const o = OBJECTS[0]
    const me = new NoteDoc(1), other = new NoteDoc(2)
    applyAll(other, me.insert(o, 0, "hello world"))
    const base = me.textOf(o).snapshot()
    // While composing "é" after "hello", someone types at the start and deletes "world"
    const theirs = [...other.insert(o, 0, ">> "), ...other.delete(o, 9, 5)]
    applyAll(me, theirs)
    const {ops, index} = me.rebaseText(o, base, "helloé world")
    applyAll(other, ops)
    assert.equal(me.text(o), ">> helloé ")
    assert.equal(other.text(o), me.text(o))
    assert.equal(index, ">> helloé".length)
    // A character the edit removed, already deleted by someone else, is skipped
    const base2 = me.textOf(o).snapshot()
    applyAll(me, other.delete(o, 0, 3))
    me.rebaseText(o, base2, "helloé ")
    assert.equal(me.text(o), "helloé ")
})

test("an insert partly applied already (compacted run of typing) adds only what is missing", () => {
    const o = OBJECTS[0]
    const a = new NoteDoc(1)
    const [first] = a.insert(o, 0, "abc")
    const [second] = a.insert(o, 3, "def")
    assert.deepEqual(second.p, [1, first.k + 2])
    const merged = {...first, x: first.x + second.x}
    // A replica that had the first part, one that had nothing, one that had both
    const partial = new NoteDoc(2), fresh = new NoteDoc(3), both = new NoteDoc(4)
    partial.apply(first)
    applyAll(both, [first, second])
    for (const doc of [partial, fresh, both]) doc.apply(merged)
    for (const doc of [partial, fresh, both]) assert.equal(doc.text(o), "abcdef")
    assert.equal(both.apply(merged), null)
    // Typing after the merged run lands at the same place everywhere
    const [next] = a.insert(o, 6, "!")
    for (const doc of [partial, fresh, both]) doc.apply(next)
    for (const doc of [partial, fresh, both]) assert.equal(doc.text(o), "abcdef!")
})
