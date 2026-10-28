"""Collaborative notes: the server side of the notes CRDT (static/crdt/).

The CRDT itself only runs in the browsers. The server never merges anything: it checks
operations, gives them their order (``seq``) in the database, stores them and relays them.

- **Order.** A batch is stored in one transaction holding the note's ``note_head`` row
  lock, so ``seq`` values commit in order per note, whichever process stores them. A
  client only builds on operations it received (committed, lower seq) and on its own
  (sent in order): the log is always in causal order.
- **Checks** without knowing the CRDT: rights, the shape and values of each operation,
  the client id bound to its account, clocks strictly increasing per client and bounded,
  and references only to operations already stored (an operation pointing at a parent
  that doesn't exist is then ignored the same way by every client).
- **Relay** across processes: each batch ends with ``pg_notify('note_ops', 'channel:seq')``
  (Postgres delivers it at commit). Every process LISTENs and pushes the new operations
  to its own sockets in the note's room, in order (``_deliver``).
- **Compaction** (routes/note_compaction.py): old operations are rewritten into fewer with the
  same effect (``_maybe_compact``, when a note is fetched), so seq has gaps: a WS batch says
  which seq it follows (``after``).
- **note_block** stays as a copy (search, MCP, get_note_content): clients write it back
  (``note_project``); a row only moves forward in ``proj_seq``.

Live cursors (``note_presence``) go straight to this process's sockets, and to the others
through NOTIFY, gathered (``_notify_presence``); nothing about them is stored.

Spreadsheets keep their content in their own tables (routes/workspaces.py, not the CRDT): each
saved change is announced with ``pg_notify('note_sheet')`` (``notify_sheet``) and relayed to the
note's room in that order (``_relay_sheet``). Nothing replays them: a socket joining the room
(opening the note, reconnecting) is told to read the note's sheets again once it is in, and so
is every room when this process's listener reconnects.
"""
import asyncio
import hashlib
import json
import re
import secrets
import threading
import time
import weakref

import psycopg
from vesta import Server, HTTPError

from routes.note_compaction import compact, utf16_len
from routes.workspaces import (_UUID_RE, _BLOCK_TYPE_RE, _clean_block_fields, _check_parent_block,
                               _load_json_dict, _is_int, _is_number, ensure_block_resources,
                               require_note_edit, sweep_note_images, LIST_TYPES, MAX_INDENT)

SERVER_CLIENT = 0          # the server's own operations (first import of a note, legacy save_block)
MAX_CLIENT_ID = 2 ** 53 - 1
MAX_BATCH = 500
# Per operation and per batch, the same as static/crdt/doc.mjs: every browser applies every
# stored operation, so what one may cost there is bounded here
MAX_TEXT = 100_000         # UTF-16 code units per insert (a bigger paste is split)
MAX_RANGES = 1000          # id ranges per delete
MAX_DELETE_SPAN = 100_000  # clocks covered by the ranges of one delete
MAX_BATCH_COST = 1_000_000   # characters inserted + clocks deleted, per batch
CLOCK_SLACK = 100_000      # how far an operation's clock may jump ahead of what precedes it
MAX_CONTENT = 1_000_000
RIGHTS_TTL = 10            # seconds a socket's view right is trusted before it is checked again
MAX_WS_CATCHUP = 2000      # operations a joining socket gets over the WS; further back: note_sync
DELIVERY_RETRY = 2         # seconds before a delivery that failed (database down) is tried again
PRESENCE_FLUSH = 0.1       # seconds of carets gathered into one NOTIFY to the other processes
NOTIFY_MAX = 7000          # bytes per NOTIFY payload (Postgres refuses more than 8000)
_PROCESS = secrets.token_hex(8)   # this process, in its presence NOTIFYs (its own are relayed already)
# Compaction (routes/note_compaction.py): only operations this old, whose answers every client
# got long ago (a batch sent again after that finds some of its operations merged away)
COMPACT_AGE = 7 * 24 * 3600   # seconds
COMPACT_MIN = 500             # operations worth a compaction
COMPACT_BATCH = 20000         # operations compacted at most per pass

DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_KEY_RE = re.compile(r"^[0-9A-Za-z]{0,199}[1-9A-Za-z]$")
# Half of a UTF-16 surrogate pair: not text (Postgres refuses it, a browser shows garbage)
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def key_after(key):
    """A position key after `key` (None: the first one). Same as keyBetween(key, null) in
    static/crdt/keys.mjs: "V", "W" … "z", "z1" …"""
    if not key:
        return DIGITS[len(DIGITS) // 2]
    prefix = ""
    for i in range(len(key) + 1):
        if i == len(key):
            return prefix + "1"
        d = DIGITS.index(key[i])
        if d < len(DIGITS) - 1:
            return prefix + DIGITS[d + 1]
        prefix += DIGITS[d]


def _is_text(value, max_len):
    return isinstance(value, str) and len(value) <= max_len and not _LONE_SURROGATE.search(value)


def _is_key(value):
    return isinstance(value, str) and bool(_KEY_RE.match(value))


def _is_id(value):
    return (isinstance(value, list) and len(value) == 2
            and _is_int(value[0], 0, MAX_CLIENT_ID) and _is_int(value[1], 1, MAX_CLIENT_ID))


# Block fields in the CRDT (static/crdt/doc.mjs BLOCK_FIELDS) and their values
_OP_FIELDS = {
    "type": lambda v: isinstance(v, str) and bool(_BLOCK_TYPE_RE.match(v)),
    "position": _is_key,
    "sub_position": _is_key,
    "row_group": lambda v: v is None or (isinstance(v, str) and bool(_UUID_RE.match(v))),
    "column_index": lambda v: _is_int(v, 0, 1000),
    "indent": lambda v: _is_int(v, 0, MAX_INDENT),
    "deleted": lambda v: isinstance(v, bool),
}


def _clean_op(op, client):
    """The stored form of a client operation (known keys only), or None if it is invalid."""
    if (not isinstance(op, dict) or not _is_int(op.get("c"), 1, MAX_CLIENT_ID) or op["c"] != client
            or not _is_int(op.get("k"), 1, MAX_CLIENT_ID)):
        return None
    obj = op.get("o")
    if not isinstance(obj, str) or not _UUID_RE.match(obj):
        return None
    clean = {"c": client, "k": op["k"], "o": obj, "t": op.get("t")}
    if clean["t"] == "set":
        field, value = op.get("f"), op.get("v")
        if field not in _OP_FIELDS or not _OP_FIELDS[field](value):
            return None
        clean.update(f=field, v=value)
    elif clean["t"] == "ins":
        parent, side, text = op.get("p"), op.get("s"), op.get("x")
        if (parent is not None and not _is_id(parent)) or side not in ("L", "R"):
            return None
        if not text or not _is_text(text, MAX_TEXT) or utf16_len(text) > MAX_TEXT:
            return None
        clean.update(p=parent, s=side, x=text)
    elif clean["t"] == "del":
        ranges = op.get("r")
        if not isinstance(ranges, list) or not 0 < len(ranges) <= MAX_RANGES:
            return None
        for r in ranges:
            if (not isinstance(r, list) or len(r) != 3 or not _is_int(r[0], 0, MAX_CLIENT_ID)
                    or not _is_int(r[1], 1, MAX_CLIENT_ID) or not _is_int(r[2], r[1], MAX_CLIENT_ID)):
                return None
        if _span(ranges) > MAX_DELETE_SPAN:
            return None
        clean.update(r=ranges)
    else:
        return None
    return clean


def _span(ranges):
    return sum(to - start + 1 for _c, start, to in ranges)


def _cost(op):
    """What applying an operation costs a browser (static/crdt/fugue.mjs): characters
    inserted, clocks deleted. Counted before checking, so it must not trust the shape."""
    if isinstance(op, dict) and op.get("t") == "ins" and isinstance(op.get("x"), str):
        return len(op["x"])
    if isinstance(op, dict) and op.get("t") == "del" and isinstance(op.get("r"), list):
        return 1 + sum(r[2] - r[1] + 1 for r in op["r"]
                       if isinstance(r, list) and len(r) == 3 and _is_int(r[1], 1, MAX_CLIENT_ID)
                       and _is_int(r[2], r[1], MAX_CLIENT_ID))
    return 1


def _clocks(op):
    """How many clock values an operation uses (one per inserted character)."""
    return utf16_len(op["x"]) if op["t"] == "ins" else 1


def _references(op):
    """The (client, clock) ids an operation points at: they must already be stored."""
    if op["t"] == "ins":
        return [tuple(op["p"])] if op["p"] else []
    if op["t"] == "del":
        return [(c, to) for c, _from, to in op["r"]]
    return []


# ── The log ──────────────────────────────────────────────────────────────────


def _lock_head(conn, channel):
    """Lock the note's head row for this transaction (creating it, and the note's first
    operations from its note_block rows, the first time)."""
    created = conn.execute("INSERT INTO note_head (channel) VALUES (%s) ON CONFLICT DO NOTHING",
                           (channel,)).rowcount
    head = conn.execute("SELECT seq, max_clock FROM note_head WHERE channel = %s FOR UPDATE", (channel,)).fetchone()
    if created:
        head = _import_blocks(conn, channel, head)
    return head


def _import_blocks(conn, channel, head):
    """A note that existed before the CRDT: its blocks become its first operations (by the
    server's client), keeping today's order. Positions become keys by rank."""
    rows = conn.execute("SELECT * FROM note_block WHERE channel = %s AND NOT deleted ORDER BY id",
                        (channel,)).fetchall()

    def keys_by_rank(values):
        keys, key = {}, None
        for value in sorted(set(values)):
            key = key_after(key)
            keys[value] = key
        return keys

    positions = keys_by_rank([float(r["position"] or 0) for r in rows])
    subs = keys_by_rank([float(r["sub_position"] or 0) for r in rows])
    ops = []
    for r in rows:
        fields = {"type": r["type"], "position": positions[float(r["position"] or 0)],
                  "row_group": r["row_group"] if r["row_group"] and _UUID_RE.match(r["row_group"]) else r["uuid"],
                  "column_index": int(r["column_index"] or 0), "sub_position": subs[float(r["sub_position"] or 0)],
                  "deleted": False}
        ops += [{"o": r["uuid"], "t": "set", "f": f, "v": v} for f, v in fields.items() if _OP_FIELDS[f](v)]
        if r["content"]:
            ops.append({"o": r["uuid"], "t": "ins", "p": None, "s": "R", "x": r["content"]})
    head = _append_server_ops(conn, channel, head, ops)
    for r in rows:
        conn.execute("UPDATE note_block SET pos_key = %s, sub_key = %s, proj_seq = %s WHERE id = %s",
                     (positions[float(r["position"] or 0)], subs[float(r["sub_position"] or 0)], head["seq"], r["id"]))
    return head


def _store(conn, channel, head, ops, account):
    """Number and store operations (already checked), notify every process. Returns the head."""
    seq, max_clock = head["seq"], head["max_clock"]
    rows = []
    for op in ops:
        seq += 1
        max_clock = max(max_clock, op["k"] + _clocks(op) - 1)
        rows.append((channel, seq, op["c"], op["k"], account, op["o"], json.dumps(op)))
    if not rows:
        return head
    with conn.cursor() as cur:
        cur.executemany("INSERT INTO note_op (channel, seq, client_id, clock, account, obj, op) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s)", rows)
    conn.execute("UPDATE note_head SET seq = %s, max_clock = %s WHERE channel = %s", (seq, max_clock, channel))
    conn.execute("SELECT pg_notify('note_ops', %s)", (f"{channel}:{seq}",))
    return {"seq": seq, "max_clock": max_clock}


def _append_server_ops(conn, channel, head, ops):
    """Operations made by the server itself (client 0): clocks after everything in the note."""
    if not ops:
        return head
    k = head["max_clock"] + 1
    stored = []
    for op in ops:
        op = {"c": SERVER_CLIENT, "k": k, **op}
        k += _clocks(op)
        stored.append(op)
    conn.execute("INSERT INTO note_client (channel, client_id, account, max_clock) VALUES (%s, %s, 0, %s) "
                 "ON CONFLICT (channel, client_id) DO UPDATE SET max_clock = EXCLUDED.max_clock",
                 (channel, SERVER_CLIENT, k - 1))
    return _store(conn, channel, head, stored, None)


def _stored_chars(conn, channel, client, clocks):
    """The clocks among these that are characters this client inserted (stored)."""
    rows = conn.execute(
        "SELECT k, n.clock, n.op->>'x' AS x FROM unnest(%s::bigint[]) AS k "
        "CROSS JOIN LATERAL (SELECT clock, op FROM note_op WHERE channel = %s AND client_id = %s "
        "AND clock <= k ORDER BY clock DESC LIMIT 1) n WHERE n.op->>'t' = 'ins'",
        (clocks, channel, client)).fetchall()
    return {row["k"] for row in rows if row["clock"] + utf16_len(row["x"]) - 1 >= row["k"]}


def _maybe_compact(conn, channel):
    """Compact the note's old operations not compacted yet, if there are enough of them. Under
    the head lock, released at once (pushes to the note wait for it)."""
    head = conn.execute("SELECT seq, compacted_seq FROM note_head WHERE channel = %s", (channel,)).fetchone()
    if not head or head["seq"] - head["compacted_seq"] < COMPACT_MIN:
        return
    done = head["compacted_seq"]
    upto = conn.execute(
        "SELECT max(seq) AS seq FROM note_op WHERE channel = %s AND seq > %s AND seq <= %s "
        "AND created_at < now() - make_interval(secs => %s)",
        (channel, done, done + COMPACT_BATCH, COMPACT_AGE)).fetchone()["seq"]
    if not upto or upto - done < COMPACT_MIN:
        return
    with conn.transaction():
        locked = conn.execute("SELECT compacted_seq FROM note_head WHERE channel = %s FOR UPDATE",
                              (channel,)).fetchone()
        if locked["compacted_seq"] == done:   # else another request compacted it meanwhile
            rows = [(row["seq"], row["op"]) for row in conn.execute(
                "SELECT seq, op FROM note_op WHERE channel = %s AND seq > %s AND seq <= %s ORDER BY seq",
                (channel, done, upto)).fetchall()]
            removed, rewritten = compact(rows, MAX_TEXT, MAX_RANGES, MAX_DELETE_SPAN)
            # Deleted first: a merged insert takes the clock of the row it absorbed (unique per client)
            if removed:
                conn.execute("DELETE FROM note_op WHERE channel = %s AND seq = ANY(%s)", (channel, list(removed)))
            for seq, op in rewritten.items():
                conn.execute("UPDATE note_op SET op = %s, clock = %s WHERE channel = %s AND seq = %s",
                             (json.dumps(op), op["k"], channel, seq))
            conn.execute("UPDATE note_head SET compacted_seq = %s WHERE channel = %s", (upto, channel))
    conn.commit()   # the head lock goes now, not when the caller is done with this connection


def _ops_after(conn, channel, after, limit=None):
    query = "SELECT seq, op FROM note_op WHERE channel = %s AND seq > %s ORDER BY seq"
    if limit:
        query += f" LIMIT {int(limit)}"
    return [{**row["op"], "seq": row["seq"]} for row in conn.execute(query, (channel, after)).fetchall()]


def notify_sheet(conn, channel, block, change, client=None):
    """Announce a sheet change to the note's room (in `conn`'s transaction: sent at commit).
    Too big for a NOTIFY (a long value): the viewers read the sheet again instead."""
    payload = json.dumps({"channel": channel, "block": block, "change": change, "from": client})
    if len(payload.encode()) > NOTIFY_MAX:
        payload = json.dumps({"channel": channel, "block": block, "change": {"kind": "reload"}, "from": client})
    conn.execute("SELECT pg_notify('note_sheet', %s)", (payload,))


def projection_hash(row):
    """Fingerprint of a note_block row as clients write it back (noteSync.mjs projectionHash):
    a client whose own copy of the note differs writes the row again."""
    fields = [row.get("type"), row.get("pos_key"), row.get("row_group"), row.get("column_index"),
              row.get("sub_key"), bool(row.get("deleted")), row.get("content") or ""]
    # Only when there is one: rows written before the indent existed keep their hash
    if row.get("indent"):
        fields.append(row["indent"])
    text = json.dumps(fields, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@Server.expose
def note_sync(self, channel, after=0):
    """A note's operations after `after` (0: all of them), and the state of each note_block
    row (proj: {uuid: [proj_seq, hash]}) so clients rewrite the stale or wrong ones."""
    uid = self.getUser()
    chan = self.require_channel_access(uid, channel, "note", "view")
    channel = int(chan["id"])
    after = int(after) if str(after).isdigit() else 0
    sweep_note_images(self, chan)
    with self.db.pool.connection() as conn:
        if not conn.execute("SELECT 1 FROM note_head WHERE channel = %s", (channel,)).fetchone():
            with conn.transaction():
                _lock_head(conn, channel)
        _maybe_compact(conn, channel)
        head = conn.execute("SELECT seq FROM note_head WHERE channel = %s", (channel,)).fetchone()
        ops = _ops_after(conn, channel, after)
        proj = {row["uuid"]: [row["proj_seq"], projection_hash(row)] for row in conn.execute(
            "SELECT uuid, proj_seq, type, pos_key, row_group, column_index, sub_key, deleted, content, indent "
            "FROM note_block WHERE channel = %s", (channel,)).fetchall()}
    return json.dumps({"id": channel, "name": chan["name"], "seq": head["seq"], "ops": ops, "proj": proj})


@Server.expose
def note_push(self, channel, client, ops):
    """Store a batch of one client's operations (JSON body {channel, client, ops}). A batch
    sent again (lost answer, reconnection, offline queue) is harmless: what is already
    stored is skipped.

    Each operation is checked on its own: one the note can't take (invalid, a clock out of
    order, a reference to something never stored or to a refused operation of this batch)
    is refused and the others are stored. Answer: {seq, rejected: [clocks of the refused]},
    so the client drops only those."""
    uid = self.getUser()
    chan = require_note_edit(self, uid, channel)
    channel = int(chan["id"])
    if (not _is_int(client, 1, MAX_CLIENT_ID) or not isinstance(ops, list) or len(ops) > MAX_BATCH
            or sum(_cost(op) for op in ops) > MAX_BATCH_COST):
        raise HTTPError(self.response, 400)

    with self.db.pool.connection() as conn, conn.transaction():
        head = _lock_head(conn, channel)
        bound = conn.execute("SELECT account, max_clock FROM note_client WHERE channel = %s AND client_id = %s "
                             "FOR UPDATE", (channel, client)).fetchone()
        if bound and bound["account"] != uid:
            raise HTTPError(self.response, 403, "client id taken")
        stored_max = bound["max_clock"] if bound else 0

        rejected, again, fresh = [], [], []
        for raw in ops:
            op = _clean_op(raw, client)
            if op is None:
                if isinstance(raw, dict) and _is_int(raw.get("k"), 1, MAX_CLIENT_ID):
                    rejected.append(raw["k"])
            elif op["k"] <= stored_max:
                again.append(op["k"])
            else:
                fresh.append(op)
        # Sent again: stored then, or refused then (and that answer never arrived)
        if again:
            stored = {row["clock"] for row in conn.execute(
                "SELECT clock FROM note_op WHERE channel = %s AND client_id = %s AND clock = ANY(%s)",
                (channel, client, again)).fetchall()}
            # An insert merged into the one before it by compaction has no row of its own
            missing = [k for k in again if k not in stored]
            if missing:
                stored |= _stored_chars(conn, channel, client, missing)
            rejected += [k for k in again if k not in stored]

        others = {c for op in fresh for c, _k in _references(op) if c != client}
        known = {row["client_id"]: row["max_clock"] for row in conn.execute(
            "SELECT client_id, max_clock FROM note_client WHERE channel = %s AND client_id = ANY(%s)",
            (channel, list(others))).fetchall()} if others else {}
        # This client's own earlier characters: one of its operations may have been refused,
        # so a clock below its max isn't necessarily stored
        older = sorted({k for op in fresh for c, k in _references(op) if c == client and k <= stored_max})
        stored_chars = _stored_chars(conn, channel, client, older) if older else set()

        # Clocks: increasing, each op after the clocks the previous one used, and not far
        # ahead of what precedes it (a huge clock would win every last-write-wins conflict).
        # References: only to characters already stored, or stored earlier in this batch.
        accepted = []
        typed = []   # (from, to) clocks of the characters this batch stored
        last = stored_max
        for op in fresh:
            ok = last < op["k"] <= max(head["max_clock"], last) + CLOCK_SLACK
            for c, k in _references(op) if ok else ():
                if c != client:
                    ok = k <= known.get(c, 0)
                else:
                    ok = k in stored_chars if k <= stored_max else any(lo <= k <= hi for lo, hi in typed)
                if not ok:
                    break
            if not ok:
                rejected.append(op["k"])
                continue
            last = op["k"] + _clocks(op) - 1
            if op["t"] == "ins":
                typed.append((op["k"], last))
            accepted.append(op)

        if accepted:
            conn.execute("INSERT INTO note_client (channel, client_id, account, max_clock) VALUES (%s, %s, %s, %s) "
                         "ON CONFLICT (channel, client_id) DO UPDATE SET max_clock = EXCLUDED.max_clock",
                         (channel, client, uid, last))
            head = _store(conn, channel, head, accepted, uid)
    return json.dumps({"seq": head["seq"], "rejected": rejected})


# ── note_block, the copy ─────────────────────────────────────────────────────

_PROJECTION_FIELDS = {
    "type": lambda v: isinstance(v, str) and bool(_BLOCK_TYPE_RE.match(v)),
    "position": _is_number,
    "pos_key": _is_key,
    "row_group": lambda v: v is None or (isinstance(v, str) and bool(_UUID_RE.match(v))),
    "column_index": lambda v: _is_int(v, 0, 1000),
    "sub_position": _is_number,
    "sub_key": _is_key,
    "content": lambda v: _is_text(v, MAX_CONTENT),
    "deleted": lambda v: isinstance(v, bool),
}
# Written when sent (a client older than the field doesn't send it)
_PROJECTION_OPTIONAL = {
    "indent": lambda v: _is_int(v, 0, MAX_INDENT),
}


@Server.expose
def note_project(self, channel, seq, blocks):
    """Clients write back what the note's blocks are as of `seq` (JSON body). Every client
    computes the same thing at the same seq; a row never goes back to an older one. The same
    seq is accepted again: a client that finds a row different from its own copy (its hash,
    note_sync) puts it right, so a wrong copy written by one client doesn't stay."""
    uid = self.getUser()
    chan = require_note_edit(self, uid, channel)
    channel = int(chan["id"])
    if not _is_int(seq, 1, 2 ** 62) or not isinstance(blocks, list) or len(blocks) > MAX_BATCH:
        raise HTTPError(self.response, 400)
    for block in blocks:
        if (not isinstance(block, dict) or not isinstance(block.get("uuid"), str) or not _UUID_RE.match(block["uuid"])
                or set(_PROJECTION_FIELDS) - set(block)
                or not all(valid(block[f]) for f, valid in _PROJECTION_FIELDS.items())
                or not all(valid(block[f]) for f, valid in _PROJECTION_OPTIONAL.items() if f in block)):
            raise HTTPError(self.response, 400)

    resources = []
    with self.db.pool.connection() as conn:
        head = conn.execute("SELECT seq FROM note_head WHERE channel = %s", (channel,)).fetchone()
        if not head or seq > head["seq"]:
            raise HTTPError(self.response, 400, "unknown seq")
        for block in blocks:
            # Only blocks of this note's log
            if not conn.execute("SELECT 1 FROM note_op WHERE channel = %s AND obj = %s AND seq <= %s LIMIT 1",
                                (channel, block["uuid"], seq)).fetchone():
                continue
            values = {f: block[f] for f in (*_PROJECTION_FIELDS, *_PROJECTION_OPTIONAL) if f in block}
            written = conn.execute(
                "UPDATE note_block SET " + ", ".join(f"{f} = %s" for f in values) + ", proj_seq = %s "
                "WHERE uuid = %s AND channel = %s AND proj_seq <= %s",
                (*values.values(), seq, block["uuid"], channel, seq)).rowcount
            if not written:
                # A uuid already taken by a block of another note stays theirs (DO NOTHING)
                written = conn.execute(
                    "INSERT INTO note_block (uuid, channel, " + ", ".join(values) + ", proj_seq) "
                    "VALUES (%s, %s, " + ", ".join(["%s"] * len(values)) + ", %s) ON CONFLICT (uuid) DO NOTHING",
                    (block["uuid"], channel, *values.values(), seq)).rowcount
            if written and not block["deleted"] and block["type"] in ("database", "spreadsheet"):
                resources.append(block)
    for block in resources:
        ensure_block_resources(self, channel, block["uuid"], block["type"])
    return json.dumps({"status": "ok"})


@Server.expose
def note_ensure_block(self, channel, uuid, type):
    """A block just turned into a database or a spreadsheet: its tables must exist before
    it mounts (its operations may still be on their way to the log). A row created here is
    hidden (deleted) until its block reaches the log and a client writes it (note_project):
    if its operations never land, it is never shown to search, the MCP or get_note_content."""
    uid = self.getUser()
    chan = require_note_edit(self, uid, channel)
    channel = int(chan["id"])
    if not isinstance(uuid, str) or not _UUID_RE.match(uuid) or type not in ("database", "spreadsheet"):
        raise HTTPError(self.response, 400)
    row = self.db.getSomething("note_block", uuid, "uuid")
    if row and int(row["channel"]) != channel:
        raise HTTPError(self.response, 404)
    if not row:
        with self.db.pool.connection() as conn:
            conn.execute("INSERT INTO note_block (uuid, channel, type, position, content, deleted) "
                         "VALUES (%s, %s, %s, 0, '', true) ON CONFLICT (uuid) DO NOTHING", (uuid, channel, type))
    ensure_block_resources(self, channel, uuid, type)
    return json.dumps({"status": "ok"})


# ── Legacy write endpoint (MCP server): blocks written whole, turned into operations ──


@Server.expose
def save_block(self, channel, block, op="edit", client_id=None):
    """Create, edit or delete a block written whole (the MCP server; `block` is a JSON
    string, or a dict in a JSON body). The note_block row is written as before and the
    change becomes server operations, so open notes show it live."""
    uid = self.getUser()
    chan = require_note_edit(self, uid, channel)
    channel = int(chan["id"])
    block = _load_json_dict(self, block)
    if op not in ("create", "edit", "delete") or (block.get("content") and not _is_text(block["content"], MAX_CONTENT)):
        raise HTTPError(self.response, 400)

    with self.db.pool.connection() as conn, conn.transaction():
        head = _lock_head(conn, channel)
        if op == "create":
            fields = _clean_block_fields(self, block)
            if not isinstance(block.get("uuid"), str) or not _UUID_RE.match(block["uuid"]) or "type" not in fields:
                raise HTTPError(self.response, 400)
            if self.db.getSomething("note_block", block["uuid"], "uuid"):
                raise HTTPError(self.response, 400)
            _check_parent_block(self, fields.get("parent_block"), channel)
            # After every position the log ever set (under the head lock): note_block is written
            # back by clients later, so it may not have the latest blocks yet. Keys compare byte
            # by byte (JS string order), whatever the database's collation
            last = conn.execute("SELECT max(op->>'v' COLLATE \"C\") AS k FROM note_op WHERE channel = %s "
                                "AND op->>'t' = 'set' AND op->>'f' = 'position'", (channel,)).fetchone()
            pos_key = key_after(last["k"])
            row_group = fields.get("row_group") or block["uuid"]
            ops = [{"o": block["uuid"], "t": "set", "f": f, "v": v} for f, v in (
                ("type", fields["type"]), ("position", pos_key), ("row_group", row_group),
                ("column_index", fields.get("column_index") or 0), ("sub_position", key_after(None)),
                ("deleted", False))]
            if fields["type"] not in LIST_TYPES:
                fields.pop("indent", None)   # only list items have a level
            if fields.get("indent"):
                ops.append({"o": block["uuid"], "t": "set", "f": "indent", "v": fields["indent"]})
            if fields.get("content"):
                ops.append({"o": block["uuid"], "t": "ins", "p": None, "s": "R", "x": fields["content"]})
            head = _append_server_ops(conn, channel, head, ops)
            fields.update(uuid=block["uuid"], channel=channel, pos_key=pos_key, sub_key=key_after(None),
                          proj_seq=head["seq"])
            fields.setdefault("position", 0)
            columns = list(fields)
            block_id = conn.execute(
                "INSERT INTO note_block (" + ", ".join(columns) + ") VALUES (" + ", ".join(["%s"] * len(columns))
                + ") RETURNING id", list(fields.values())).fetchone()["id"]
            created_type = fields["type"]
        else:
            row = conn.execute("SELECT * FROM note_block WHERE uuid = %s", (str(block.get("uuid")),)).fetchone()
            if not row or int(row["channel"]) != channel or row["deleted"]:
                raise HTTPError(self.response, 404)
            if op == "delete":
                head = _append_server_ops(conn, channel, head, [{"o": row["uuid"], "t": "set", "f": "deleted", "v": True}])
                conn.execute("UPDATE note_block SET deleted = true, proj_seq = %s WHERE id = %s", (head["seq"], row["id"]))
                return
            # The client sends the whole row back: only changed editable columns count. The place
            # in the page is the CRDT's (keys): a float position here would be overwritten
            changes = {k: v for k, v in _clean_block_fields(self, block).items()
                       if v != row.get(k) and k not in ("position", "sub_position")}
            # Only list items have a level: a block that isn't one (any more) has none
            if changes.get("type", row["type"]) not in LIST_TYPES:
                changes.pop("indent", None)
                if row.get("indent"):
                    changes["indent"] = 0
            if changes.get("parent_block") is not None:
                if int(changes["parent_block"]) == int(row["id"]):
                    raise HTTPError(self.response, 400)
                _check_parent_block(self, changes["parent_block"], channel)
            ops = [{"o": row["uuid"], "t": "set", "f": f, "v": changes[f]}
                   for f in ("type", "row_group", "column_index", "indent") if f in changes and _OP_FIELDS[f](changes[f])]
            if "content" in changes:
                # Replace the whole text: every character typed so far goes, the new text comes
                ranges = [[r["client_id"], r["clock"], r["clock"] + utf16_len(r["op"]["x"]) - 1]
                          for r in conn.execute("SELECT client_id, clock, op FROM note_op WHERE channel = %s "
                                                "AND obj = %s AND op->>'t' = 'ins'", (channel, row["uuid"])).fetchall()]
                for i in range(0, len(ranges), MAX_RANGES):
                    ops.append({"o": row["uuid"], "t": "del", "r": ranges[i:i + MAX_RANGES]})
                if changes["content"]:
                    ops.append({"o": row["uuid"], "t": "ins", "p": None, "s": "R", "x": changes["content"]})
            head = _append_server_ops(conn, channel, head, ops)
            for key, value in changes.items():
                conn.execute(f"UPDATE note_block SET {key} = %s WHERE id = %s", (value, row["id"]))
            conn.execute("UPDATE note_block SET proj_seq = %s WHERE id = %s", (head["seq"], row["id"]))
            created_type = changes.get("type")
            block_id = None
    if created_type in ("database", "spreadsheet"):
        ensure_block_resources(self, channel, block["uuid"], created_type)
    return str(block_id) if block_id is not None else None


# ── WebSocket rooms (per process) and the relay ──────────────────────────────


def _rooms(self):
    """{channel: {websocket: {"uid", "client", "sent": last seq sent, "checked": time}}}"""
    if not hasattr(self, "_note_rooms"):
        self._note_rooms = {}
        # {channel: asyncio.Lock}: a lock leaves once no delivery holds or awaits it, so the
        # notes ever opened don't each keep one for the life of the process
        self._note_locks = weakref.WeakValueDictionary()
    return self._note_rooms


def _spawn(self, coro):
    """A background task of the WS loop, kept referenced until it ends (the loop itself only
    holds weak references: an unreferenced task can be collected mid-run). Failures are logged."""
    tasks = self.__dict__.setdefault("_note_tasks", set())
    task = asyncio.ensure_future(coro)
    tasks.add(task)

    def done(t):
        tasks.discard(t)
        if not t.cancelled() and t.exception():
            print("[notes] background task failed:", repr(t.exception()))
    task.add_done_callback(done)
    return task


def _start_listener(self):
    """Once per process: LISTEN on its own connection, hand notifications to the WS loop."""
    if getattr(self, "_note_listener", None):
        return
    self._note_listener = threading.Thread(target=_listen, args=(self,), daemon=True, name="note-listener")
    self._note_listener.start()


def _listen(self):
    """The listener thread: it only hands notifications over to the WS loop, which owns the
    rooms (they change there while this thread runs)."""
    pool = self.db.pool

    def hand_over(fn, *args):
        self._note_loop.call_soon_threadsafe(lambda: _spawn(self, fn(self, *args)))

    reconnected = False
    while True:
        try:
            with psycopg.connect(pool.conninfo, **{**pool.kwargs, "autocommit": True}) as conn:
                conn.execute("LISTEN note_ops")
                conn.execute("LISTEN note_presence")
                conn.execute("LISTEN note_sheet")
                # Anything stored while this connection was down
                hand_over(_on_ops_stored, None)
                if reconnected:   # sheet changes are not replayed: every room reads its sheets again
                    hand_over(_relay_sheet, {"channel": None, "block": None, "change": {"kind": "reload"}})
                reconnected = True
                for notify in conn.notifies():
                    if notify.channel == "note_ops":
                        hand_over(_on_ops_stored, int(notify.payload.split(":")[0]))
                    elif notify.channel == "note_sheet":
                        hand_over(_relay_sheet, json.loads(notify.payload))
                    else:
                        batch = json.loads(notify.payload)
                        if batch.get("from") != _PROCESS:   # this process's own: relayed already
                            for payload in batch.get("items", []):
                                hand_over(_relay_presence, payload)
        except Exception as e:   # the database restarted…: listen again
            print("[notes] listener error, reconnecting:", e)
            time.sleep(2)


async def _on_ops_stored(self, channel):
    """New operations in a note (None: maybe in any): deliver them to its room, once. A
    delivery already waiting for the room's lock will read them too."""
    waiting = self.__dict__.setdefault("_note_waiting", set())
    for chan in (list(_rooms(self)) if channel is None else [channel]):
        if chan in _rooms(self) and chan not in waiting:
            waiting.add(chan)
            _spawn(self, _deliver(self, chan))


def _fetch_ops(self, channel, after, limit):
    with self.db.pool.connection() as conn:
        return _ops_after(conn, channel, after, limit=limit)


def _head_seq(self, channel):
    with self.db.pool.connection() as conn:
        head = conn.execute("SELECT seq FROM note_head WHERE channel = %s", (channel,)).fetchone()
    return head["seq"] if head else 0


async def _send(websocket, message):
    try:
        await websocket.send(json.dumps(message, default=str))
    except Exception:
        pass   # a closed socket: _cleanup_connection removes it


async def _deliver(self, channel):
    """Push the operations each socket of the room hasn't received yet, in order. The
    database is read in a worker thread: the WS loop carries chat and calls too."""
    lock = self._note_locks.setdefault(channel, asyncio.Lock())
    async with lock:
        self.__dict__.setdefault("_note_waiting", set()).discard(channel)
        room = _rooms(self).get(channel)
        if not room:
            return
        try:
            await _check_rights(self, channel, room)
            while room:
                low = min(entry["sent"] for entry in room.values())
                ops = await asyncio.to_thread(_fetch_ops, self, channel, low, 1000)
                if not ops:
                    break
                for websocket, entry in list(room.items()):
                    batch = [op for op in ops if op["seq"] > entry["sent"]]
                    if batch:
                        # `after`: the batch follows this seq (the log has gaps where it was compacted)
                        message = {"type": "note_ops", "channel": channel, "after": entry["sent"], "ops": batch}
                        entry["sent"] = batch[-1]["seq"]
                        await _send(websocket, message)
                if len(ops) < 1000:
                    break
        except Exception as e:
            # The database is unreachable…: the room would wait for the next edit, try again soon
            print("[notes] delivery failed, retrying:", repr(e))
            asyncio.get_running_loop().call_later(DELIVERY_RETRY, lambda: _spawn(self, _on_ops_stored(self, channel)))
        if not room:
            _rooms(self).pop(channel, None)


async def _check_rights(self, channel, room):
    """The sockets whose view right was checked more than RIGHTS_TTL ago are checked again:
    those who lost it leave the room."""
    now = time.monotonic()
    for websocket, entry in list(room.items()):
        if now - entry["checked"] > RIGHTS_TTL:
            if not await asyncio.to_thread(self.checkChannelAccess, entry["uid"], channel, "note", "view"):
                room.pop(websocket, None)
                await _send(websocket, {"type": "note_error", "channel": channel, "error": "forbidden"})
                continue
            entry["checked"] = now


async def _relay_sheet(self, payload):
    """A sheet change (notify_sheet) to the room's sockets, under the room's lock: in the order
    they were announced. `from`: the socket of the tab that made it, told it is its own."""
    channels = list(_rooms(self)) if payload["channel"] is None else [payload["channel"]]
    sender = payload.pop("from", None)
    for channel in channels:
        async with self._note_locks.setdefault(channel, asyncio.Lock()):
            room = _rooms(self).get(channel)
            if not room:
                continue
            try:
                await _check_rights(self, channel, room)
            except Exception as e:   # the database is down: who may see it is unknown, nobody gets it
                print("[notes] sheet relay failed:", repr(e))
                continue
            for websocket, entry in list(room.items()):
                await _send(websocket, {"type": "note_sheet", **payload, "channel": channel,
                                        "own": sender is not None and str(entry["client"]) == str(sender)})
            if not room:
                _rooms(self).pop(channel, None)


async def _relay_presence(self, payload):
    room = _rooms(self).get(payload.get("channel"))
    for websocket, entry in list((room or {}).items()):
        if entry["client"] != payload.get("sid"):
            await _send(websocket, {"type": "note_presence", **payload})


def _pg_notify_presence(payloads, pool):
    """The carets gathered, to the other processes: as few NOTIFYs as their size allows."""
    batches, batch, size = [], [], 0
    for payload in payloads:
        item = json.dumps(payload)
        if batch and size + len(item) > NOTIFY_MAX:
            batches.append(batch)
            batch, size = [], 0
        batch.append(payload)
        size += len(item) + 1
    if batch:
        batches.append(batch)
    with pool.connection() as conn:
        for batch in batches:
            conn.execute("SELECT pg_notify('note_presence', %s)", (json.dumps({"from": _PROCESS, "items": batch}),))


async def _flush_presence(self):
    await asyncio.sleep(PRESENCE_FLUSH)
    queue, self._note_presence_queue = self._note_presence_queue, {}
    self._note_presence_flush = None
    try:
        await asyncio.to_thread(_pg_notify_presence, list(queue.values()), self.db.pool)
    except Exception as e:   # carets are ephemeral: the next move (or heartbeat) sends them again
        print("[notes] presence notify failed:", repr(e))


async def _notify_presence(self, channel, uid, client, cursor):
    """A caret moved: the sockets of this process get it at once; the other processes get the
    latest caret of each tab once per PRESENCE_FLUSH (a caret moves many times a second)."""
    payload = {"channel": channel, "uid": uid, "sid": client, "cursor": cursor}
    await _relay_presence(self, payload)
    queue = self.__dict__.setdefault("_note_presence_queue", {})
    queue[(channel, client)] = payload
    if not getattr(self, "_note_presence_flush", None):
        self._note_presence_flush = _spawn(self, _flush_presence(self))


def _socket_user(self, websocket, data):
    if not self.checkWSAuth(websocket, data.get("clientID")):
        return None
    client = self.db.getSomething("active_client", data["clientID"])
    return client["userid"] if client else None


async def ws_note_join(self, websocket, data):
    """{type: "note_join", clientID, channel, after}: receive the note's operations live,
    starting after `after` (what this tab already has)."""
    uid = _socket_user(self, websocket, data)
    channel = data.get("channel")
    if uid is None or not _is_int(channel, 1, 2 ** 31):
        return
    if not await asyncio.to_thread(self.checkChannelAccess, uid, channel, "note", "view"):
        await _send(websocket, {"type": "note_error", "channel": channel, "error": "forbidden"})
        return
    self._note_loop = asyncio.get_running_loop()
    _start_listener(self)
    after = data.get("after") if _is_int(data.get("after"), 0, 2 ** 62) else 0
    # Far behind: only the last operations come over the WS; the client sees the gap and
    # fetches the rest from note_sync (HTTP), instead of the whole log through this loop
    after = max(after, await asyncio.to_thread(_head_seq, self, channel) - MAX_WS_CATCHUP)
    _rooms(self).setdefault(channel, {})[websocket] = {
        "uid": uid, "client": data["clientID"], "sent": after, "checked": time.monotonic()}
    # The sheets' changes saved before this point never reach it: they are read again from here
    await _send(websocket, {"type": "note_sheet", "channel": channel, "block": None,
                            "change": {"kind": "reload"}, "own": False})
    await _deliver(self, channel)


async def ws_note_leave(self, websocket, data):
    uid = _socket_user(self, websocket, data)
    channel = data.get("channel")
    room = _rooms(self).get(channel)
    if uid is None or not room or room.pop(websocket, None) is None:
        return
    if not room:
        _rooms(self).pop(channel, None)
    await _notify_presence(self, channel, uid, data["clientID"], "leave")


def _clean_cursor(cursor):
    """{o: block uuid} (in a block), {o, a, h} (caret / selection: anchor ids, null = the
    start of the text), or None (in the note, no caret). False if invalid."""
    if cursor is None:
        return None
    if (not isinstance(cursor, dict) or not isinstance(cursor.get("o"), str) or not _UUID_RE.match(cursor["o"])
            or not all(cursor.get(x) is None or _is_id(cursor.get(x)) for x in ("a", "h"))):
        return False
    clean = {"o": cursor["o"]}
    for x in ("a", "h"):
        if x in cursor:
            clean[x] = cursor[x]
    return clean


async def ws_note_presence(self, websocket, data):
    """{type: "note_presence", clientID, channel, cursor}: where this tab's caret is. The
    server says who it is (uid); nothing is stored."""
    room = _rooms(self).get(data.get("channel"))
    entry = room.get(websocket) if room else None
    cursor = _clean_cursor(data.get("cursor"))
    if not entry or entry["client"] != data.get("clientID") or cursor is False:
        return
    await _notify_presence(self, data["channel"], entry["uid"], entry["client"], cursor)


async def on_socket_closed(self, websocket):
    """A socket went away: out of its rooms, its cursors disappear for the others. Never
    raises: the rest of the socket's cleanup (calls, presence…) must run whatever happens here."""
    left = []
    for channel, room in list(_rooms(self).items()):
        entry = room.pop(websocket, None)
        if entry:
            left.append((channel, entry))
        if not room:
            _rooms(self).pop(channel, None)
    for channel, entry in left:
        try:
            await _notify_presence(self, channel, entry["uid"], entry["client"], "leave")
        except Exception as e:
            print("[notes] could not announce a socket leaving:", repr(e))


WS_HANDLERS = {
    "note_join": ws_note_join,
    "note_leave": ws_note_leave,
    "note_presence": ws_note_presence,
}
