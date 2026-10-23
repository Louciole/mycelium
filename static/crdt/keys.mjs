/**
 * Fractional position keys: strings that sort like fractions 0.d1d2d3… in base 62
 * ("0-9A-Za-z", which is also their ASCII order, so a plain `<` compares them).
 * A key never ends with "0": "a" and "a0" would be the same fraction, with no room
 * between them. Moving a block is one write of its key, and the list never needs
 * renumbering (keyBetween always finds a key strictly between two others).
 */

export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const BASE = DIGITS.length   // 62
const MIDDLE = BASE >> 1     // "V": where a new digit starts
export const MAX_KEY_LENGTH = 200
const KEY_RE = new RegExp(`^[0-9A-Za-z]{0,${MAX_KEY_LENGTH - 1}}[1-9A-Za-z]$`)

export function isKey(key) {
    return typeof key === "string" && KEY_RE.test(key)
}

const digit = (key, i) => (i < key.length ? DIGITS.indexOf(key[i]) : 0)

/**
 * A key strictly between `a` and `b` (null: the start / the end of the list).
 * It steps one digit up from `a` when there is room (or one down from `b` when `a` has
 * no digit left there): a list typed line after line, at the end or in the middle,
 * then grows by one character every ~60 lines instead of every few with midpoints.
 * A new digit: "1" past the end of the list (appending stays dense), but in the middle
 * ("V") for the first key and when squeezing into a gap. Then inserting again and again
 * in the same gap (above the same line, at the top of the note) steps ~30 times before
 * the key grows, instead of growing at every insert.
 * Equal or reversed bounds (two members inserted at the same place at once) give a
 * key right after `a`.
 */
export function keyBetween(a = null, b = null) {
    if (a !== null && b !== null && !(a < b)) b = null
    return between(a ?? "", b, a === null ? MIDDLE : 1)
}

/** `fresh`: the digit a key takes where `a` has no digit left and nothing bounds it above. */
function between(lo, b, fresh) {
    let prefix = ""
    for (let i = 0; ; i++) {
        const da = digit(lo, i)
        const db = b === null ? BASE : digit(b, i)
        if (da === db) {
            prefix += DIGITS[da]
            continue
        }
        if (b === null) {
            if (i >= lo.length) return prefix + DIGITS[fresh]
            if (da < BASE - 1) return prefix + DIGITS[da + 1]
            // "z": keep it, the key goes on after it (still the end of the list)
            return prefix + DIGITS[da] + between(lo.slice(i + 1), null, 1)
        }
        if (i >= lo.length && db > 1) {
            // Nothing left of `a`: step just below `b`'s digit (prepending stays short)
            return prefix + DIGITS[db - 1]
        }
        if (db - da > 1) return prefix + DIGITS[da + 1]
        // Adjacent digits: keep `a`'s and find room after the rest of `a`, from the middle
        return prefix + DIGITS[da] + between(lo.slice(i + 1), null, MIDDLE)
    }
}

/** The fraction a key stands for, as a float (note_block.position for search and the MCP). */
export function keyToFloat(key) {
    let value = 0
    let scale = 1 / BASE
    for (const ch of key || "") {
        value += DIGITS.indexOf(ch) * scale
        scale /= BASE
    }
    return value
}
