"""Notes blocks, spreadsheets and databases.

Endpoints take the live Mycelium instance as ``self``; shared helpers remain on
the class (see server.py).
"""
import json
import math
import re

from vesta import Server, HTTPError

import metrics


def ensure_block_resources(self, channel, uuid, block_type):
    """The tables a database or spreadsheet block reads (its note_block row must exist).
    Created once; called when a block becomes one (routes/notes_sync.py)."""
    if block_type == "database" and not self.db.getSomething("note_database", uuid, "block_uuid"):
        db_id = self.db.insertDict("note_database", {
            "block_uuid": uuid,
            "channel": int(channel),
            "name": "Untitled Database",
            "view_type": "table"
        }, getId=True)
        self.db.insertDict("note_database_column", {
            "database_id": db_id,
            "name": "Name",
            "type": "text",
            "position": 0.1
        })
        self.db.insertDict("note_database_row", {
            "database_id": db_id,
            "position": 0.1
        })
    elif block_type == "spreadsheet" and not self.db.getSomething("note_spreadsheet", uuid, "block_uuid"):
        self.db.insertDict("note_spreadsheet", {
            "block_uuid": uuid,
            "channel": int(channel),
            "rows": 3,
            "cols": 2
        })


@Server.expose
def get_database_content(self, channel, block_uuid):
    uid = self.getUser()
    self.require_channel_access(uid, channel, "note", "view")

    db_info = self.db.getSomething("note_database", block_uuid, "block_uuid")
    if not db_info or int(db_info["channel"]) != int(channel):
        raise HTTPError(self.response, 404)

    db_id = db_info["id"]

    # Computed databases expose platform-wide aggregate metrics — strictly
    # admin-only, regardless of who can view the notes channel.
    if db_info.get("source") == "computed":
        if not self.isAdmin(uid):
            raise HTTPError(self.response, 403)
        spec = metrics.resolve_spec(db_info)
        # Return metadata only — the frontend fetches data asynchronously via
        # run_metric_spec so the note paints immediately.
        result = {
            "id": db_id,
            "block_uuid": db_info["block_uuid"],
            "name": db_info["name"],
            "view_type": db_info.get("view_type", "table"),
            "gallery_cover_column": db_info.get("gallery_cover_column"),
            "source": "computed",
            "metric_key": db_info.get("metric_key"),
            "metric_spec": spec,
            "read_only": True,
            "columns": [], "rows": [], "cells": {},
        }
        return json.dumps(result, default=str)

    columns = self.db.getFilters("note_database_column", ["database_id", "=", db_id, "order by position"]) or []
    rows = self.db.getFilters("note_database_row", ["database_id", "=", db_id, "order by position"]) or []

    cells = {}
    for row in rows:
        row_cells = self.db.getFilters("note_database_cell", ["row_id", "=", row["id"]]) or []
        cells[str(row["id"])] = {str(c["column_id"]): c["value"] for c in row_cells}

    result = {
        "id": db_id,
        "block_uuid": db_info["block_uuid"],
        "name": db_info["name"],
        "view_type": db_info.get("view_type", "table"),
        "gallery_cover_column": db_info.get("gallery_cover_column"),
        "source": db_info.get("source", "manual"),
        "metric_key": db_info.get("metric_key"),
        "metric_spec": db_info.get("metric_spec"),
        "read_only": False,
        "columns": columns,
        "rows": rows,
        "cells": cells
    }
    return json.dumps(result, default=str)


@Server.expose
def describe_datasets(self):
    """Catalog + presets for the live-metric builder. Admin-only."""
    uid = self.getUser()
    if not self.isAdmin(uid):
        raise HTTPError(self.response, 403)
    return json.dumps({
        "datasets": metrics.describe_datasets(),
        "presets": metrics.list_presets(),
    }, default=str)


@Server.expose
def run_metric_spec(self, spec):
    """Compile + run a MetricSpec without saving it (builder preview). Admin-only."""
    uid = self.getUser()
    if not self.isAdmin(uid):
        raise HTTPError(self.response, 403)
    try:
        spec = json.loads(spec)
        return json.dumps(metrics.run_spec(self, spec), default=str)
    except metrics.SpecError as e:
        raise HTTPError(self.response, 400, str(e))
    except (ValueError, TypeError):
        raise HTTPError(self.response, 400)


@Server.expose
def get_spreadsheet_content(self, block_uuid, channel=None, conv_id=None):
    uid = self.getUser()
    if conv_id is not None:
        _checkConvAccess(self, uid, conv_id)
    elif channel is not None:
        self.require_channel_access(uid, channel, "note", "view")
    else:
        raise HTTPError(self.response, 400)

    sheet_info = self.db.getSomething("note_spreadsheet", block_uuid, "block_uuid")
    if not sheet_info:
        raise HTTPError(self.response, 404)
    if conv_id is not None and str(sheet_info.get("conv_id")) != str(conv_id):
        raise HTTPError(self.response, 404)
    if conv_id is None and str(sheet_info.get("channel")) != str(channel):
        raise HTTPError(self.response, 404)

    sheet_id = sheet_info["id"]
    cells_data = self.db.getFilters("note_spreadsheet_cell", ["spreadsheet_id", "=", sheet_id]) or []
    cells = {}
    cell_formats = {}
    for c in cells_data:
        ref = self._sheet_ref(c["col_idx"], c["row_idx"])
        if c["value"] not in (None, ""):
            cells[ref] = c["value"]
        fmt = _cell_format(c)
        if fmt:
            cell_formats[ref] = fmt
    col_widths = self._get_sheet_col_widths(sheet_id)

    result = {
        "id": sheet_id,
        "block_uuid": sheet_info["block_uuid"],
        "rows": sheet_info["rows"],
        "cols": sheet_info["cols"],
        "cells": cells,
        "cell_formats": cell_formats,
        "col_widths": col_widths,
    }
    return json.dumps(result, default=str)


@Server.expose
def get_spreadsheet_snapshot(self, channel, block_uuid):
    uid = self.getUser()
    self.require_channel_access(uid, channel, "note", "view")

    sheet_info = self.db.getSomething("note_spreadsheet", block_uuid, "block_uuid")
    if not sheet_info or int(sheet_info["channel"]) != int(channel):
        raise HTTPError(self.response, 404)

    cells_data = self.db.getFilters("note_spreadsheet_cell", ["spreadsheet_id", "=", sheet_info["id"]]) or []
    cells = {self._sheet_ref(c["col_idx"], c["row_idx"]): c["value"] for c in cells_data}

    return json.dumps({
        "id": sheet_info["id"],
        "block_uuid": sheet_info["block_uuid"],
        "rows": sheet_info["rows"],
        "cols": sheet_info["cols"],
        "cells": cells,
    }, default=str)


def _cell_format(cell):
    """A cell row's formatting as clients hold it (None: no formatting)."""
    tc, bc, al, dc = cell.get("text_color"), cell.get("bg_color"), cell.get("align"), cell.get("decimals")
    if not (tc or bc or al or dc is not None):
        return None
    return {"color": tc or "", "bg": bc or "", "align": al or "", "decimals": dc if dc is not None else ""}


def _announce_sheet(self, uid, sheet_info, client_id, read):
    """Tell the viewers of a notes channel what an edit of one of its sheets changed (a sheet's
    content is not in the note's CRDT: routes/notes_sync.py relays this to the note's room).

    `read(conn)` gives the change as the database holds it now, read with the sheet's row
    locked: announcements reach the tabs in the order of their reads, so the last one a tab
    gets about a cell is what is stored, whatever order concurrent edits were written in.
    `client_id`: the editing tab's socket (it ignores its own while its edits are on their
    way), only when it is this user's."""
    if sheet_info.get("channel") is None:
        return   # a conversation's sheet: no room
    from routes.notes_sync import notify_sheet   # (notes_sync imports this module)
    client_id = str(client_id or "")
    client = self.db.getSomething("active_client", int(client_id)) if client_id.isascii() and client_id.isdigit() and len(client_id) < 19 else None
    try:
        with self.db.pool.connection() as conn, conn.transaction():
            conn.execute("SELECT id FROM note_spreadsheet WHERE id = %s FOR UPDATE", (sheet_info["id"],))
            notify_sheet(conn, int(sheet_info["channel"]), sheet_info["block_uuid"], read(conn),
                         int(client_id) if client and client["userid"] == uid else None)
    except Exception as e:
        # The edit is stored anyway: the other tabs miss it until they read the sheet again
        # (reopening the note, or their socket coming back)
        print("[sheets] could not announce a change:", repr(e))


def _announce_cell(self, uid, sheet_info, client_id, row_idx, col_idx):
    def read(conn):
        cell = conn.execute(
            "SELECT value, text_color, bg_color, align, decimals FROM note_spreadsheet_cell"
            " WHERE spreadsheet_id = %s AND row_idx = %s AND col_idx = %s",
            (sheet_info["id"], row_idx, col_idx)).fetchone()
        return {"kind": "cell", "ref": self._sheet_ref(col_idx, row_idx), "value": (cell or {}).get("value") or "",
                "format": _cell_format(cell) if cell else None}
    _announce_sheet(self, uid, sheet_info, client_id, read)


@Server.expose
def save_spreadsheet_cell(self, spreadsheet_id, cell_id, value, channel=None, conv_id=None, client_id=None):
    uid = self.getUser()
    sheet_info = _get_sheet_info(self, uid, spreadsheet_id, channel=channel, conv_id=conv_id)

    if value is None:
        value = ""
    elif isinstance(value, str) and value.strip() == "":
        value = ""

    parsed = _parse_sheet_ref(self, cell_id)
    if not parsed:
        raise HTTPError(self.response, 400)

    row_idx = parsed["row"]
    col_idx = parsed["col"]
    if row_idx < 1 or row_idx > int(sheet_info["rows"]) or col_idx < 0 or col_idx >= int(sheet_info["cols"]):
        raise HTTPError(self.response, 400)

    existing = self.db.getFilters(
        "note_spreadsheet_cell",
        ["spreadsheet_id", "=", spreadsheet_id, "and", "row_idx", "=", row_idx, "and", "col_idx", "=", col_idx]
    )
    if existing:
        row = existing[0]
        # Keep a value-less cell alive when it still carries formatting.
        has_format = (bool(row.get("text_color")) or bool(row.get("bg_color"))
                      or bool(row.get("align")) or row.get("decimals") is not None)
        if value == "" and not has_format:
            self.db.deleteSomething("note_spreadsheet_cell", row["id"])
        else:
            self.db.edit("note_spreadsheet_cell", row["id"], "value", value)
    else:
        if value != "":
            self.db.insertDict("note_spreadsheet_cell", {
                "spreadsheet_id": spreadsheet_id,
                "row_idx": row_idx,
                "col_idx": col_idx,
                "value": value
            })
    _announce_cell(self, uid, sheet_info, client_id, row_idx, col_idx)


@Server.expose
def save_spreadsheet_cell_format(self, spreadsheet_id, cell_id, text_color=None, bg_color=None,
                                 align=None, decimals=None, channel=None, conv_id=None, client_id=None):
    uid = self.getUser()
    sheet_info = _get_sheet_info(self, uid, spreadsheet_id, channel=channel, conv_id=conv_id)

    parsed = _parse_sheet_ref(self, cell_id)
    if not parsed:
        raise HTTPError(self.response, 400)

    row_idx = parsed["row"]
    col_idx = parsed["col"]
    if row_idx < 1 or row_idx > int(sheet_info["rows"]) or col_idx < 0 or col_idx >= int(sheet_info["cols"]):
        raise HTTPError(self.response, 400)

    tc = _clean_sheet_color(text_color)
    bc = _clean_sheet_color(bg_color)
    al = _clean_sheet_align(align)
    dc = _clean_sheet_decimals(decimals)
    if tc is None or bc is None or al is None or dc is None:
        raise HTTPError(self.response, 400)

    # "" / None means the column carries no override.
    tc_val = tc or None
    bc_val = bc or None
    al_val = al or None
    dc_val = dc if dc != "" else None
    has_format = bool(tc) or bool(bc) or bool(al) or dc_val is not None

    existing = self.db.getFilters(
        "note_spreadsheet_cell",
        ["spreadsheet_id", "=", spreadsheet_id, "and", "row_idx", "=", row_idx, "and", "col_idx", "=", col_idx]
    )
    if existing:
        row = existing[0]
        # A cell with no value and no formatting has nothing left to store.
        if not has_format and (row.get("value") or "") == "":
            self.db.deleteSomething("note_spreadsheet_cell", row["id"])
        else:
            self.db.edit("note_spreadsheet_cell", row["id"], "text_color", tc_val)
            self.db.edit("note_spreadsheet_cell", row["id"], "bg_color", bc_val)
            self.db.edit("note_spreadsheet_cell", row["id"], "align", al_val)
            self.db.edit("note_spreadsheet_cell", row["id"], "decimals", dc_val)
    elif has_format:
        self.db.insertDict("note_spreadsheet_cell", {
            "spreadsheet_id": spreadsheet_id,
            "row_idx": row_idx,
            "col_idx": col_idx,
            "value": "",
            "text_color": tc_val,
            "bg_color": bc_val,
            "align": al_val,
            "decimals": dc_val,
        })
    _announce_cell(self, uid, sheet_info, client_id, row_idx, col_idx)


@Server.expose
def save_spreadsheet(self, spreadsheet_id, data, channel=None, conv_id=None, client_id=None):
    uid = self.getUser()

    try:
        data = json.loads(data)
    except Exception:
        raise HTTPError(self.response, 400)

    if not isinstance(data, dict):
        raise HTTPError(self.response, 400)

    sheet_info = _get_sheet_info(self, uid, spreadsheet_id, channel=channel, conv_id=conv_id)

    limits = {
        "rows": (1, 500),
        "cols": (1, 200),
    }

    for key, (min_val, max_val) in limits.items():
        if key not in data:
            continue

        try:
            value = int(data[key])
        except Exception:
            raise HTTPError(self.response, 400)

        if value < min_val or value > max_val:
            raise HTTPError(self.response, 400)

        if value != int(sheet_info.get(key)):
            self.db.edit("note_spreadsheet", spreadsheet_id, key, value)
    _announce_sheet(self, uid, sheet_info, client_id, lambda conn: {"kind": "reload"})


@Server.expose
def save_spreadsheet_col_width(self, spreadsheet_id, col_idx, width, channel=None, conv_id=None, client_id=None):
    uid = self.getUser()
    sheet_info = _get_sheet_info(self, uid, spreadsheet_id, channel=channel, conv_id=conv_id)

    col_idx = int(col_idx)
    width = int(width)
    if col_idx < 0 or col_idx >= int(sheet_info["cols"]):
        raise HTTPError(self.response, 400)
    if width < 40 or width > 1200:
        raise HTTPError(self.response, 400)

    existing = self.db.getFilters(
        "note_spreadsheet_col",
        ["spreadsheet_id", "=", spreadsheet_id, "and", "col_idx", "=", col_idx]
    )
    if existing:
        self.db.edit("note_spreadsheet_col", existing[0]["id"], "width_px", width)
    else:
        self.db.insertDict("note_spreadsheet_col", {
            "spreadsheet_id": spreadsheet_id,
            "col_idx": col_idx,
            "width_px": width,
        })

    def read(conn):
        col = conn.execute("SELECT width_px FROM note_spreadsheet_col WHERE spreadsheet_id = %s AND col_idx = %s",
                           (sheet_info["id"], col_idx)).fetchone()
        return {"kind": "width", "col": col_idx, "width": col["width_px"] if col else None}
    _announce_sheet(self, uid, sheet_info, client_id, read)
    return json.dumps({"ok": True})


@Server.expose
def save_spreadsheet_structure(self, spreadsheet_id, op, ref, channel=None, conv_id=None, client_id=None):
    uid = self.getUser()
    sheet_info = _get_sheet_info(self, uid, spreadsheet_id, channel=channel, conv_id=conv_id)

    parsed = _parse_sheet_ref(self, ref)
    if not parsed:
        raise HTTPError(self.response, 400)

    rows = int(sheet_info["rows"])
    cols = int(sheet_info["cols"])
    if parsed["row"] < 1 or parsed["row"] > rows or parsed["col"] < 0 or parsed["col"] >= cols:
        raise HTTPError(self.response, 400)

    insert_col = None
    insert_row = None
    delete_col = None
    delete_row = None

    if op == "add-col-left":
        insert_col = parsed["col"]
        cols += 1
    elif op == "add-col-right":
        insert_col = parsed["col"] + 1
        cols += 1
    elif op == "add-row-top":
        insert_row = parsed["row"]
        rows += 1
    elif op == "add-row-bottom":
        insert_row = parsed["row"] + 1
        rows += 1
    elif op == "delete-col":
        if cols <= 1:
            raise HTTPError(self.response, 400)
        delete_col = parsed["col"]
        cols -= 1
    elif op == "delete-row":
        if rows <= 1:
            raise HTTPError(self.response, 400)
        delete_row = parsed["row"]
        rows -= 1
    else:
        raise HTTPError(self.response, 400)

    existing = self.db.getFilters("note_spreadsheet_cell", ["spreadsheet_id", "=", spreadsheet_id]) or []
    shifted = []
    col_width_rows = self.db.getFilters("note_spreadsheet_col", ["spreadsheet_id", "=", spreadsheet_id]) or []

    for cell in existing:
        c = int(cell.get("col_idx"))
        r = int(cell.get("row_idx"))

        if insert_col is not None and c >= insert_col:
            c += 1
        if insert_row is not None and r >= insert_row:
            r += 1

        if delete_col is not None:
            if c == delete_col:
                continue
            if c > delete_col:
                c -= 1

        if delete_row is not None:
            if r == delete_row:
                continue
            if r > delete_row:
                r -= 1

        shifted.append({
            "col_idx": c,
            "row_idx": r,
            "value": cell.get("value", ""),
            "text_color": cell.get("text_color"),
            "bg_color": cell.get("bg_color"),
            "align": cell.get("align"),
            "decimals": cell.get("decimals"),
        })

    # Rewrite cells to avoid UNIQUE collisions while shifting coordinates.
    for cell in existing:
        self.db.deleteSomething("note_spreadsheet_cell", cell["id"])

    for cell in shifted:
        value = cell.get("value", "")
        tc = cell.get("text_color")
        bc = cell.get("bg_color")
        al = cell.get("align")
        dc = cell.get("decimals")
        # Drop cells that carry neither a value nor any formatting.
        if value == "" and not tc and not bc and not al and dc is None:
            continue
        self.db.insertDict("note_spreadsheet_cell", {
            "spreadsheet_id": spreadsheet_id,
            "row_idx": cell["row_idx"],
            "col_idx": cell["col_idx"],
            "value": value,
            "text_color": tc,
            "bg_color": bc,
            "align": al,
            "decimals": dc,
        })

    # Shift persisted column widths on column insert/delete.
    if insert_col is not None or delete_col is not None:
        width_map = {}
        for row in col_width_rows:
            idx = int(row["col_idx"])
            width_map[idx] = int(row["width_px"])

        shifted_widths = {}
        for idx, width in width_map.items():
            next_idx = idx
            if insert_col is not None and next_idx >= insert_col:
                next_idx += 1
            if delete_col is not None:
                if next_idx == delete_col:
                    continue
                if next_idx > delete_col:
                    next_idx -= 1
            if 0 <= next_idx < cols:
                shifted_widths[next_idx] = width

        if insert_col is not None and 0 <= insert_col < cols and insert_col not in shifted_widths:
            fallback = width_map.get(insert_col, width_map.get(insert_col - 1, 120))
            shifted_widths[insert_col] = fallback

        for row in col_width_rows:
            self.db.deleteSomething("note_spreadsheet_col", row["id"])

        for idx, width in shifted_widths.items():
            self.db.insertDict("note_spreadsheet_col", {
                "spreadsheet_id": spreadsheet_id,
                "col_idx": idx,
                "width_px": width,
            })

    self.db.edit("note_spreadsheet", spreadsheet_id, "rows", rows)
    self.db.edit("note_spreadsheet", spreadsheet_id, "cols", cols)
    # Cells moved: viewers read the sheet again (the op says where, for a cell being typed in)
    _announce_sheet(self, uid, sheet_info, client_id, lambda conn: {
        "kind": "structure", "op": op, "ref": self._sheet_ref(parsed["col"], parsed["row"])})
    return json.dumps({"rows": rows, "cols": cols, "col_widths": self._get_sheet_col_widths(spreadsheet_id)})


@Server.expose
def save_database(self, channel, database, op="create"):
    uid = self.getUser()
    _checkDatabaseAccess(self, uid, channel)
    database = _load_json_dict(self, database)

    if op == "create":
        block_uuid = database.get("block_uuid")
        if not isinstance(block_uuid, str) or not block_uuid:
            raise HTTPError(self.response, 400)
        # The database belongs to a block of this very channel
        block_info = self.db.getSomething("note_block", block_uuid, "uuid")
        if not block_info or int(block_info["channel"]) != int(channel):
            raise HTTPError(self.response, 404)
        # Idempotent: if database already exists for this block, return existing
        existing = self.db.getSomething("note_database", block_uuid, "block_uuid")
        if existing:
            return str(existing["id"])
        fields = _clean_database_fields(self, database, None)
        db_id = self.db.insertDict("note_database", {
            "block_uuid": block_uuid,
            "channel": channel,
            "name": fields.get("name", "Untitled Database"),
            "view_type": fields.get("view_type", "table")
        }, getId=True)
        # Create a default first column
        self.db.insertDict("note_database_column", {
            "database_id": db_id,
            "name": "Name",
            "type": "text",
            "position": 0.1
        })
        # Create a default first row
        self.db.insertDict("note_database_row", {
            "database_id": db_id,
            "position": 0.1
        })
        return str(db_id)
    elif op == "edit":
        db_info = self.db.getSomething("note_database", database["id"])
        if not db_info or int(db_info["channel"]) != int(channel):
            raise HTTPError(self.response, 404)
        # A computed database must reference a valid, compilable metric.
        if "source" in database and database["source"] not in ("manual", "computed"):
            raise HTTPError(self.response, 400)
        new_source = database.get("source", db_info.get("source", "manual"))
        # Configuring a live metric, or editing one that is already computed,
        # is admin-only — these expose platform-wide aggregate data.
        if new_source == "computed" or db_info.get("source") == "computed":
            if not self.isAdmin(uid):
                raise HTTPError(self.response, 403)
        if new_source == "computed":
            spec = database.get("metric_spec", db_info.get("metric_spec"))
            if not spec:
                preset = metrics.METRIC_PRESETS.get(
                    database.get("metric_key", db_info.get("metric_key")))
                spec = preset["spec"] if preset else None
            try:
                metrics.validate_spec(spec)
            except metrics.SpecError:
                raise HTTPError(self.response, 400)
        _clean_database_fields(self, database, db_info["id"])   # 400 on an invalid value
        allowed = ["name", "view_type", "gallery_cover_column", "source", "metric_key", "metric_spec"]
        for key in allowed:
            if key in database and database[key] != db_info.get(key):
                value = database[key]
                if key == "metric_spec" and value is not None:
                    value = json.dumps(value)   # store as jsonb text
                self.db.edit("note_database", database["id"], key, value)
    elif op == "delete":
        db_info = self.db.getSomething("note_database", database["id"])
        if not db_info or int(db_info["channel"]) != int(channel):
            raise HTTPError(self.response, 404)
        self.db.deleteSomething("note_database", database["id"])


@Server.expose
def save_database_column(self, channel, database_id, column, op="create"):
    uid = self.getUser()
    _checkDatabaseAccess(self, uid, channel)
    column = _load_json_dict(self, column)
    if (("name" in column and not _is_short_str(column["name"], 255))
            or ("position" in column and not _is_number(column["position"]))
            or ("options" in column and not isinstance(column["options"], dict))):
        raise HTTPError(self.response, 400)

    db_info = self.db.getSomething("note_database", database_id)
    if not db_info or int(db_info["channel"]) != int(channel):
        raise HTTPError(self.response, 404)
    if db_info.get("source") == "computed":
        raise HTTPError(self.response, 403)

    valid_types = ["text", "number", "checkbox", "date", "select", "relation", "formula"]

    if op == "create":
        col_type = column.get("type", "text")
        if col_type not in valid_types:
            raise HTTPError(self.response, 400)
        col_id = self.db.insertDict("note_database_column", {
            "database_id": database_id,
            "name": column.get("name", "Column"),
            "type": col_type,
            "position": column.get("position", 0.1),
            "options": json.dumps(column.get("options", {}))
        }, getId=True)
        return str(col_id)
    elif op == "edit":
        col_info = self.db.getSomething("note_database_column", column["id"])
        if not col_info or int(col_info["database_id"]) != int(database_id):
            raise HTTPError(self.response, 404)
        allowed = ["name", "type", "position", "options"]
        for key in allowed:
            if key in column:
                val = column[key]
                if key == "type" and val not in valid_types:
                    raise HTTPError(self.response, 400)
                if key == "options":
                    val = json.dumps(val)
                if str(val) != str(col_info.get(key)):
                    self.db.edit("note_database_column", column["id"], key, val)
    elif op == "delete":
        col_info = self.db.getSomething("note_database_column", column["id"])
        if not col_info or int(col_info["database_id"]) != int(database_id):
            raise HTTPError(self.response, 404)
        self.db.deleteSomething("note_database_column", column["id"])


@Server.expose
def save_database_row(self, channel, database_id, row, op="create"):
    uid = self.getUser()
    _checkDatabaseAccess(self, uid, channel)
    row = _load_json_dict(self, row)
    if "position" in row and not _is_number(row["position"]):
        raise HTTPError(self.response, 400)

    db_info = self.db.getSomething("note_database", database_id)
    if not db_info or int(db_info["channel"]) != int(channel):
        raise HTTPError(self.response, 404)
    if db_info.get("source") == "computed":
        raise HTTPError(self.response, 403)

    if op == "create":
        row_id = self.db.insertDict("note_database_row", {
            "database_id": database_id,
            "position": row.get("position", 0.1)
        }, getId=True)
        return str(row_id)
    elif op == "edit":
        row_info = self.db.getSomething("note_database_row", row["id"])
        if not row_info or int(row_info["database_id"]) != int(database_id):
            raise HTTPError(self.response, 404)
        if "position" in row:
            self.db.edit("note_database_row", row["id"], "position", row["position"])
    elif op == "delete":
        row_info = self.db.getSomething("note_database_row", row["id"])
        if not row_info or int(row_info["database_id"]) != int(database_id):
            raise HTTPError(self.response, 404)
        self.db.deleteSomething("note_database_row", row["id"])


@Server.expose
def save_database_cell(self, channel, database_id, cell):
    uid = self.getUser()
    _checkDatabaseAccess(self, uid, channel)
    cell = _load_json_dict(self, cell)

    db_info = self.db.getSomething("note_database", database_id)
    if not db_info or int(db_info["channel"]) != int(channel):
        raise HTTPError(self.response, 404)
    if db_info.get("source") == "computed":
        raise HTTPError(self.response, 403)

    row_id = cell["row_id"]
    column_id = cell["column_id"]
    value = cell.get("value", "")

    # Validate row belongs to this database
    row_info = self.db.getSomething("note_database_row", row_id)
    if not row_info or int(row_info["database_id"]) != int(database_id):
        raise HTTPError(self.response, 404)

    # Validate column belongs to this database
    col_info = self.db.getSomething("note_database_column", column_id)
    if not col_info or int(col_info["database_id"]) != int(database_id):
        raise HTTPError(self.response, 404)

    # For relation columns, validate target row exists
    if col_info["type"] == "relation":
        options = col_info.get("options", {})
        if isinstance(options, str):
            options = json.loads(options)
        target_db_id = options.get("database_id")
        if target_db_id and value:
            target_row = self.db.getSomething("note_database_row", value)
            if not target_row or int(target_row["database_id"]) != int(target_db_id):
                raise HTTPError(self.response, 400)

    # Upsert: try update, then insert
    existing = self.db.getFilters("note_database_cell", ["row_id", "=", row_id, "and", "column_id", "=", column_id])
    if existing:
        self.db.edit("note_database_cell", existing[0]["id"], "value", value)
    else:
        self.db.insertDict("note_database_cell", {
            "row_id": row_id,
            "column_id": column_id,
            "value": value
        })
    return json.dumps({"status": "ok"})


@Server.expose
def get_relation_display(self, database_id, row_id):
    """Get the display name (first text column value) for a row in a database."""
    uid = self.getUser()
    db_info = self.db.getSomething("note_database", database_id)
    if not db_info:
        raise HTTPError(self.response, 404)

    self.require_channel_access(uid, db_info["channel"], "note", "view")

    # Find first text column
    columns = self.db.getFilters("note_database_column", ["database_id", "=", database_id, "order by position"]) or []
    text_col = None
    for col in columns:
        if col["type"] == "text":
            text_col = col
            break

    if not text_col:
        return json.dumps({"display": "Row " + str(row_id)})

    cell = self.db.getFilters("note_database_cell", ["row_id", "=", row_id, "and", "column_id", "=", text_col["id"]]) or []
    display = cell[0]["value"] if cell else ""
    return json.dumps({"display": display or "Untitled"}, default=str)


_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
# type, uuid and row_group end up unescaped in the note-block / note-row templates
# (class and on* attributes): keep them to plain identifiers.
_BLOCK_TYPE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,49}$")
_DATABASE_VIEWS = ("table", "gallery")


def _load_json_dict(self, raw):
    if isinstance(raw, dict):   # already parsed: a JSON request body
        return raw
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise HTTPError(self.response, 400)
    if not isinstance(value, dict):
        raise HTTPError(self.response, 400)
    return value


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_int(value, low, high):
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def _is_short_str(value, max_len):
    return isinstance(value, str) and len(value) <= max_len


# note_block columns a client may set, with their validators. id and channel are
# server-owned; uuid is only taken on create (it is the block's key afterwards).
_BLOCK_FIELDS = {
    "type": lambda v: isinstance(v, str) and bool(_BLOCK_TYPE_RE.match(v)),
    "position": _is_number,
    "content": lambda v: v is None or isinstance(v, str),
    "row_group": lambda v: v is None or (isinstance(v, str) and bool(_UUID_RE.match(v))),
    "column_index": lambda v: v is None or _is_int(v, 0, 1000),
    "sub_position": lambda v: v is None or _is_number(v),
    "parent_block": lambda v: v is None or _is_int(v, 1, 2**63 - 1),
}


def _clean_block_fields(self, block):
    """Return the editable note_block fields of a client block. Other keys are dropped,
    an invalid value is a 400."""
    fields = {}
    for key, valid in _BLOCK_FIELDS.items():
        if key in block:
            if not valid(block[key]):
                raise HTTPError(self.response, 400)
            fields[key] = block[key]
    return fields


def _check_parent_block(self, parent_id, channel):
    """A parent block must live in the same notes channel."""
    if parent_id is None:
        return
    parent = self.db.getSomething("note_block", parent_id)
    if not parent or int(parent["channel"]) != int(channel):
        raise HTTPError(self.response, 400)


def _clean_database_fields(self, database, db_id):
    """Validate the plain note_database fields a client may set (name, view_type,
    gallery_cover_column). The metric fields are validated by save_database."""
    fields = {}
    if "name" in database:
        if not _is_short_str(database["name"], 255):
            raise HTTPError(self.response, 400)
        fields["name"] = database["name"]
    if "view_type" in database:
        if database["view_type"] not in _DATABASE_VIEWS:
            raise HTTPError(self.response, 400)
        fields["view_type"] = database["view_type"]
    if "gallery_cover_column" in database:
        col = database["gallery_cover_column"]
        if col is not None:
            col_info = self.db.getSomething("note_database_column", col) if _is_int(col, 1, 2**63 - 1) else None
            if not col_info or db_id is None or int(col_info["database_id"]) != int(db_id):
                raise HTTPError(self.response, 400)
        fields["gallery_cover_column"] = col
    return fields


def require_note_edit(self, uid, channel):
    """The notes channel `uid` may change (its text, sheets, databases): "edit-notes" in it
    (implies view-channels), and not timed out on its server (a timed-out member still reads
    it). Returns the channel row; raises 404, or 403 (the timeout's body: timed_out)."""
    chan = self.require_channel_access(uid, channel, "note", "edit-notes")
    self.enforceNotTimedOut(uid, chan["server"])
    return chan


def _checkDatabaseAccess(self, uid, channel):
    """Check that user may edit a notes channel's content. Returns server_id or raises."""
    return require_note_edit(self, uid, channel)["server"]


def _checkConvAccess(self, uid, conv_id):
    """Check that user can access the place (DM conv or textual channel). Returns conv_id as int or raises."""
    cid = int(conv_id)
    # DM / group conversation
    access = self.db.getFilters(
        "accessconversation",
        ["conversation", "=", cid, "and", "account", "=", uid]
    )
    if access:
        return cid
    # Server textual channel — any member of the server with view permission
    if self.checkChannelAccess(uid, cid, "textual", "view"):
        return cid
    raise HTTPError(self.response, 403)


def _get_sheet_info(self, uid, spreadsheet_id, channel=None, conv_id=None):
    """Auth-check and load note_spreadsheet row by ID. Raises on bad access or ownership mismatch.
    Only write endpoints use it, so a conv block in a server channel also requires not being timed out."""
    if conv_id is not None:
        _checkConvAccess(self, uid, conv_id)
        place = self.db.getSomething("textual_channel", int(conv_id))
        if place:
            self.enforceNotTimedOut(uid, place["server"])
        sheet_info = self.db.getSomething("note_spreadsheet", spreadsheet_id)
        if not sheet_info or str(sheet_info.get("conv_id")) != str(conv_id):
            raise HTTPError(self.response, 404)
    elif channel is not None:
        _checkDatabaseAccess(self, uid, channel)
        sheet_info = self.db.getSomething("note_spreadsheet", spreadsheet_id)
        if not sheet_info or int(sheet_info.get("channel", -1)) != int(channel):
            raise HTTPError(self.response, 404)
    else:
        raise HTTPError(self.response, 400)
    return sheet_info


_SHEET_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")


def _clean_sheet_color(value):
    """Return a normalized hex color, "" for no color, or None if invalid.

    Colors are rendered into inline CSS on the client, so we only ever accept a
    plain hex literal — never arbitrary CSS — to keep style injection impossible.
    """
    if value is None:
        return ""
    value = str(value).strip()
    if value == "":
        return ""
    if _SHEET_COLOR_RE.match(value):
        return value.lower()
    return None


_SHEET_ALIGNS = ("left", "center", "right")


def _clean_sheet_align(value):
    """Return a valid alignment, "" for default, or None if invalid."""
    if value is None:
        return ""
    value = str(value).strip().lower()
    if value == "":
        return ""
    if value in _SHEET_ALIGNS:
        return value
    return None


def _clean_sheet_decimals(value):
    """Return an int in [0, 10], "" for no override, or None if invalid."""
    if value is None:
        return ""
    value = str(value).strip()
    if value == "":
        return ""
    try:
        n = int(value)
    except (ValueError, TypeError):
        return None
    if n < 0 or n > 10:
        return None
    return n


def _parse_sheet_ref(self, cell_id):
    m = re.match(r"^([A-Z]+)(\d+)$", str(cell_id or ""))
    if not m:
        return None

    letters = m.group(1)
    row_num = int(m.group(2))
    if row_num < 1:
        return None
    col_idx = 0
    for ch in letters:
        col_idx = col_idx * 26 + (ord(ch) - 64)
    return {"col": col_idx - 1, "row": row_num}

