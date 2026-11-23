"""Interactive blocks posted in a conversation: the "Insert a block" picker.

The server only stores blocks. A block is a message whose attachments carry
``{"type": "conv_block", "uuid": …}``, a ``conv_block`` row (its type, template
and ``settings``: JSON the server doesn't read) and ``conv_block_item`` rows (one
``data`` JSON each: an expense, a task…). What a tricount or a checklist means,
its templates and its validation live in the client (``static/conv-blocks.mjs``).
A spreadsheet block (``conv_spreadsheet``) reuses the notes' sheet tables and is
created with the cells its template gives (sent by the client).

What the server keeps is what doesn't depend on the type:

- access: anyone who can read the place can edit a block (like voting in a
  poll), not a member timed out in the server;
- limits: number of items, size of the JSON;
- concurrency: every change bumps the block's ``version`` (and its item's), and
  ``if_version`` refuses a change made against an older one (a 409 ``CONFLICT``).
  An item edit can also be checked against the block's version
  (``if_block_version``: an expense naming participants another change may have
  removed). The client then reloads the block and redoes its change, so two
  people can't take on the same item, nor drop a participant someone just added
  or edited an expense for;
- who: items carry their author and their last editor (``updatedBy``).

Each change is broadcast whole (``conv_block_changed``): a block is small, and a
tab keeps the highest version it saw, whatever order concurrent changes reach it in.
"""
import json
import re
import uuid as _uuid

from psycopg.types.json import Jsonb
from vesta import Server, HTTPError
from vesta.http.response import Response

from message_helpers import _lookupMessagePlace, notifyPlaceMembers, insert_message

MAX_ITEMS = 300
MAX_SETTINGS_BYTES = 16_000
MAX_ITEM_BYTES = 4_000
MAX_SHEET_ROWS, MAX_SHEET_COLS = 100, 26
MAX_CELL_CHARS = 1_000
CONFLICT = "Version conflict"
Response.CODES.setdefault(409, "409 Conflict")   # vesta only lists 400/403/404/413/500
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,19}$")             # block types and templates
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")


# ── Input ──────────────────────────────────────────────────────────────────────

def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _json_object(self, value, max_bytes, field):
    """A JSON object (a dict, or its text) of at most `max_bytes` once encoded."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            raise HTTPError(self.response, 400, f"Invalid {field}")
    if not isinstance(value, dict):
        raise HTTPError(self.response, 400, f"Invalid {field}")
    _check_size(self, value, max_bytes, field)
    return value


def _check_size(self, value, max_bytes, field):
    if len(json.dumps(value, ensure_ascii=False).encode()) > max_bytes:
        raise HTTPError(self.response, 413, f"{field} is too large")


def _version(self, value):
    """`if_version`: None when the client doesn't ask for the check."""
    if value in (None, "", "null", "undefined"):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise HTTPError(self.response, 400, "Invalid version")


def _expect(self, row, expected):
    if expected is not None and row["version"] != expected:
        raise HTTPError(self.response, 409, CONFLICT)


def _sheet_spec(self, spec):
    """rows, cols and [(col, row, value, bg)] of a new sheet: what its template filled in."""
    rows, cols, cells = spec.get("rows", 5), spec.get("cols", 3), spec.get("cells") or []
    if not (_is_int(rows) and _is_int(cols) and 1 <= rows <= MAX_SHEET_ROWS and 1 <= cols <= MAX_SHEET_COLS):
        raise HTTPError(self.response, 400, "Invalid sheet size")
    if not isinstance(cells, list) or len(cells) > rows * cols:
        raise HTTPError(self.response, 400, "Invalid cells")
    result, seen = [], set()
    for cell in cells:
        if not isinstance(cell, dict):
            raise HTTPError(self.response, 400, "Invalid cells")
        col, row, value, bg = cell.get("col"), cell.get("row"), cell.get("value", ""), cell.get("bg")
        if not (_is_int(col) and _is_int(row) and 0 <= col < cols and 1 <= row <= rows) or (col, row) in seen:
            raise HTTPError(self.response, 400, "Invalid cells")
        if not isinstance(value, str) or len(value) > MAX_CELL_CHARS:
            raise HTTPError(self.response, 400, "Invalid cells")
        if bg is not None and not (isinstance(bg, str) and _COLOR_RE.match(bg)):
            raise HTTPError(self.response, 400, "Invalid cells")
        seen.add((col, row))
        result.append((col, row, value, bg))
    return rows, cols, result


# ── Storage ────────────────────────────────────────────────────────────────────

def _states(conn, blocks):
    """The blocks as clients hold them, their items read in one query."""
    items = conn.execute(
        "SELECT id, block_id, data, author, updated_by, version FROM conv_block_item"
        " WHERE block_id = ANY(%s) ORDER BY position, id", ([b["id"] for b in blocks],)).fetchall() if blocks else []
    by_block = {}
    for item in items:
        by_block.setdefault(item["block_id"], []).append(
            {"id": item["id"], "data": item["data"], "author": item["author"],
             "updatedBy": item["updated_by"], "version": item["version"]})
    return [{
        "uuid": b["uuid"], "type": b["type"], "template": b["template"], "settings": b["settings"],
        "version": b["version"], "messageId": b["message_id"], "items": by_block.get(b["id"], []),
    } for b in blocks]


def _state(conn, block_id):
    return _states(conn, [conn.execute("SELECT * FROM conv_block WHERE id = %s", (block_id,)).fetchone()])[0]


def read_block_states(self, block_uuids):
    """{uuid: state} of the blocks that exist, in two queries whatever their number
    (a page of history enriches all its blocks at once)."""
    block_uuids = list({u for u in block_uuids if isinstance(u, str)})
    if not block_uuids:
        return {}
    with self.db.pool.connection() as conn:
        blocks = conn.execute("SELECT * FROM conv_block WHERE uuid = ANY(%s)", (block_uuids,)).fetchall()
        return {s["uuid"]: s for s in _states(conn, blocks)}


def _load_block(self, uid, block_uuid, write=False):
    """The block and its place's (channel, channel_type), access checked."""
    block = self.db.getSomething("conv_block", str(block_uuid), "uuid")
    if not block:
        raise HTTPError(self.response, 404, "Block not found")
    place = _lookupMessagePlace(self, block["place"])
    channel, channel_type = place
    if channel:
        self.require_channel_access(uid, channel["id"], channel_type, "view")
        if write:
            self.enforceNotTimedOut(uid, channel["server"])
    elif not self.db.getFilters("accessconversation",
                                ["conversation", "=", block["place"], "and", "account", "=", uid]):
        raise HTTPError(self.response, 403, "No access to this block")
    return block, place


def _change(self, uid, block_uuid, apply):
    """Run apply(conn, block) with the block locked, bump its version, broadcast it."""
    block, place = _load_block(self, uid, block_uuid, write=True)
    with self.db.pool.connection() as conn, conn.transaction():
        locked = conn.execute("SELECT * FROM conv_block WHERE id = %s FOR UPDATE", (block["id"],)).fetchone()
        apply(conn, locked)
        conn.execute("UPDATE conv_block SET version = version + 1 WHERE id = %s", (block["id"],))
        state = _state(conn, block["id"])
    notifyPlaceMembers(self, block["place"], {"type": "conv_block_changed", "content": {
        "place": block["place"], "messageId": block["message_id"], "block": state}}, place=place)
    return json.dumps(state, default=str)


def _get_item(self, conn, block, item_id):
    try:
        item_id = int(item_id)
    except (TypeError, ValueError):
        raise HTTPError(self.response, 400, "Invalid item")
    row = conn.execute("SELECT * FROM conv_block_item WHERE id = %s AND block_id = %s FOR UPDATE",
                       (item_id, block["id"])).fetchone()
    if not row:
        raise HTTPError(self.response, 404, "Item not found")
    return row


# ── Creation (from send_message) ──────────────────────────────────────────────

def create_conv_block(self, uid, place_id, spec, reply=None):
    """Post the message holding a new block; returns the message as clients hold it.
    `spec`: {"type", "template", "settings"}, or for a sheet {"type": "spreadsheet",
    "template", "rows", "cols", "cells": [{"col", "row", "value", "bg"}]}.
    The place's rights are already checked."""
    if not isinstance(spec, dict):
        raise HTTPError(self.response, 400, "Invalid block")
    block_type, template = spec.get("type"), spec.get("template") or "empty"
    if not all(isinstance(v, str) and _NAME_RE.match(v) for v in (block_type, template)):
        raise HTTPError(self.response, 400, "Invalid block")

    block_uuid = str(_uuid.uuid4())
    if block_type == "spreadsheet":
        rows, cols, cells = _sheet_spec(self, spec)
        attachment = {"type": "conv_spreadsheet", "uuid": block_uuid, "template": template}   # names its header
    else:
        settings = _json_object(self, spec.get("settings") or {}, MAX_SETTINGS_BYTES, "settings")
        attachment = {"type": "conv_block", "uuid": block_uuid}

    # The message and its block in one transaction: no message pointing at a missing block
    with self.db.pool.connection() as conn, conn.transaction():
        message = insert_message(self, uid, place_id, attachments=json.dumps([attachment]), reply=reply, conn=conn)
        if block_type == "spreadsheet":
            sheet_id = conn.execute(
                "INSERT INTO note_spreadsheet (block_uuid, conv_id, message_id, rows, cols)"
                " VALUES (%s, %s, %s, %s, %s) RETURNING id",
                (block_uuid, place_id, message["id"], rows, cols)).fetchone()["id"]
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO note_spreadsheet_cell (spreadsheet_id, row_idx, col_idx, value, bg_color)"
                    " VALUES (%s, %s, %s, %s, %s)", [(sheet_id, row, col, value, bg) for col, row, value, bg in cells])
            message["convSpreadsheet"] = {
                "uuid": block_uuid, "id": sheet_id, "rows": rows, "cols": cols, "col_widths": {},
                "cells": {self._sheet_ref(col, row): value for col, row, value, _ in cells if value},
            }
        else:
            block_id = conn.execute(
                "INSERT INTO conv_block (uuid, message_id, place, type, template, settings)"
                " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                (block_uuid, message["id"], place_id, block_type, template, Jsonb(settings))).fetchone()["id"]
            message["convBlock"] = _state(conn, block_id)
    return message


# ── Endpoints ──────────────────────────────────────────────────────────────────

@Server.expose
def get_conv_block(self, block_uuid):
    uid = self.getUser()
    block, _ = _load_block(self, uid, block_uuid)
    with self.db.pool.connection() as conn:
        return json.dumps(_state(conn, block["id"]), default=str)


@Server.expose
def edit_conv_block(self, block_uuid, settings, if_version=None):
    """Merges `settings` (its keys replace the block's)."""
    uid = self.getUser()
    patch = _json_object(self, settings, MAX_SETTINGS_BYTES, "settings")
    expected = _version(self, if_version)

    def apply(conn, block):
        _expect(self, block, expected)
        merged = {**block["settings"], **patch}
        _check_size(self, merged, MAX_SETTINGS_BYTES, "settings")
        conn.execute("UPDATE conv_block SET settings = %s WHERE id = %s", (Jsonb(merged), block["id"]))
    return _change(self, uid, block_uuid, apply)


@Server.expose
def add_conv_block_item(self, block_uuid, data, if_version=None):
    uid = self.getUser()
    data = _json_object(self, data, MAX_ITEM_BYTES, "item")
    expected = _version(self, if_version)

    def apply(conn, block):
        _expect(self, block, expected)
        stats = conn.execute("SELECT count(*) AS n, coalesce(max(position), 0) AS last"
                             " FROM conv_block_item WHERE block_id = %s", (block["id"],)).fetchone()
        if stats["n"] >= MAX_ITEMS:
            raise HTTPError(self.response, 400, "This block is full")
        conn.execute("INSERT INTO conv_block_item (block_id, position, data, author, updated_by)"
                     " VALUES (%s, %s, %s, %s, %s)", (block["id"], stats["last"] + 1, Jsonb(data), uid, uid))
    return _change(self, uid, block_uuid, apply)


@Server.expose
def edit_conv_block_item(self, block_uuid, item_id, data, if_version=None, if_block_version=None):
    """Merges `data` (its keys replace the item's). `if_version`: the item's version;
    `if_block_version`: the block's (the edit depends on its settings too)."""
    uid = self.getUser()
    patch = _json_object(self, data, MAX_ITEM_BYTES, "item")
    expected = _version(self, if_version)
    expected_block = _version(self, if_block_version)

    def apply(conn, block):
        _expect(self, block, expected_block)
        row = _get_item(self, conn, block, item_id)
        _expect(self, row, expected)
        merged = {**row["data"], **patch}
        _check_size(self, merged, MAX_ITEM_BYTES, "item")
        conn.execute("UPDATE conv_block_item SET data = %s, updated_by = %s, version = version + 1 WHERE id = %s",
                     (Jsonb(merged), uid, row["id"]))
    return _change(self, uid, block_uuid, apply)


@Server.expose
def delete_conv_block_item(self, block_uuid, item_id, if_version=None):
    uid = self.getUser()
    expected = _version(self, if_version)

    def apply(conn, block):
        row = _get_item(self, conn, block, item_id)
        _expect(self, row, expected)
        conn.execute("DELETE FROM conv_block_item WHERE id = %s", (row["id"],))
    return _change(self, uid, block_uuid, apply)
