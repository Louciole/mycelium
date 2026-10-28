"""Mycelium MCP server.

Exposes Mycelium notes, databases and live metrics to an MCP client (Claude
Desktop / Claude Code) so Claude can read notes, create/append blocks, build
live-metric dashboards, and analyze results — writing its findings back into a
note.

It is a thin AUTHENTICATED CLIENT over Mycelium's existing REST API. It holds no
privileges of its own: it logs in (or reuses a JWT) as a real account, so every
permission and the admin-only gating on metrics apply exactly as in the web app.
No backend changes are required.

Auth (env):
    MYCELIUM_URL       base URL, e.g. https://mycelium.carbonlab.dev  (default http://localhost:8080)
    MYCELIUM_JWT       a JWT cookie value (copy from the browser; lasts ~100 days)   [preferred]
    MYCELIUM_EMAIL  +  MYCELIUM_PASSWORD   login credentials                          [alternative]

Run:  python mcp_server/server.py     (stdio transport)
"""
import json
import os
import sys
import uuid

import requests
from mcp.server.fastmcp import FastMCP

MYCELIUM_URL = os.environ.get("MYCELIUM_URL", "http://localhost:808").rstrip("/")
MYCELIUM_JWT = os.environ.get("MYCELIUM_JWT")
MYCELIUM_EMAIL = os.environ.get("MYCELIUM_EMAIL")
MYCELIUM_PASSWORD = os.environ.get("MYCELIUM_PASSWORD")


class MyceliumError(Exception):
    pass


class MyceliumClient:
    """Cookie-authenticated HTTP client. Logs in lazily; re-auths once on 401/redirect."""

    def __init__(self):
        self.s = requests.Session()
        if MYCELIUM_JWT:
            self.s.cookies.set("JWT", MYCELIUM_JWT)
        self._logged_in = bool(MYCELIUM_JWT)
        # NB: stdio MCP uses stdout for protocol — debug logs MUST go to stderr.
        print(f"MyceliumClient initialized: {self._logged_in}", file=sys.stderr)

    def _login(self):
        if not (MYCELIUM_EMAIL and MYCELIUM_PASSWORD):
            raise MyceliumError(
                "Not authenticated: set MYCELIUM_JWT, or MYCELIUM_EMAIL + MYCELIUM_PASSWORD.")
        # POST as JSON so the password is not written to the server's query logs.
        r = self.s.post(f"{MYCELIUM_URL}/login",
                        json={"email": MYCELIUM_EMAIL, "password": MYCELIUM_PASSWORD},
                        allow_redirects=False, timeout=15)
        if "JWT" not in self.s.cookies:
            raise MyceliumError(f"Login failed: {r.text[:200]}")
        self._logged_in = True

    def call(self, endpoint, **params):
        """GET an exposed endpoint, returning parsed JSON (or raw text)."""
        if not self._logged_in:
            self._login()
        for attempt in (1, 2):
            r = self.s.get(f"{MYCELIUM_URL}/{endpoint}", params=params,
                           allow_redirects=False, timeout=30)
            # An auth failure redirects to /auth or returns 403 — re-login once.
            if r.status_code in (301, 302, 401, 403) and attempt == 1:
                self._login()
                continue
            if r.status_code >= 400:
                raise MyceliumError(f"{endpoint} -> HTTP {r.status_code}: {r.text[:200]}")
            try:
                return r.json()
            except ValueError:
                return r.text
        raise MyceliumError(f"{endpoint}: authentication failed")


client = MyceliumClient()
mcp = FastMCP("mycelium")


# ─── Discovery ─────────────────────────────────────────────────────────

@mcp.tool()
def list_servers() -> list:
    """List the servers (communities) the account belongs to. Returns id + name."""
    servers = client.call("get_user_servers")
    return [{"id": s["id"], "name": s.get("name")} for s in servers]


@mcp.tool()
def list_note_channels(server_id: int) -> dict:
    """List the collaborative-note channels in a server (plus whether it is an op/admin server)."""
    content = client.call("get_serv_content", server_id=server_id)
    return {
        "is_op_server": bool(content.get("op")),
        "notes": [{"id": c["id"], "name": c.get("name")} for c in content.get("notes", [])],
    }


# ─── Notes (read / write) ──────────────────────────────────────────────

@mcp.tool()
def read_note(channel_id: int) -> dict:
    """Read a note channel's content as an ordered list of blocks (uuid, type, text; list
    items — types bullet / numbered — also have their level, indent 0 … 5). A file block's
    content is a drive link: "<#drive:12/f:301>"."""
    content = client.call("get_note_content", channel_id=channel_id)
    blocks = sorted(content.get("blocks", []), key=lambda b: b.get("position", 0))
    return {
        "name": content.get("name"),
        "channel_id": channel_id,
        "blocks": [{"uuid": b.get("uuid"), "type": b.get("type"), "content": b.get("content", ""),
                    **({"indent": b["indent"]} if b.get("indent") else {})} for b in blocks],
    }


@mcp.tool()
def create_note_channel(server_id: int, name: str = "new note") -> dict:
    """Create a new collaborative-note channel in a server. Returns the new channel id."""
    res = client.call("edit_server_channel", server_id=server_id,
                      action="create", channel_type="note")
    chan = res.get("channel", {})
    if name and name != chan.get("name") and chan.get("id"):
        client.call("edit_server_channel", server_id=server_id, action="edit",
                    channel_type="note", targetId=chan["id"], field="name", value=name)
    return {"id": chan.get("id"), "name": name}


@mcp.tool()
def append_block(channel_id: int, content: str, type: str = "text", indent: int = 0) -> dict:
    """Append a block to a note. `type` is text, heading1, heading2, heading3, small, bullet,
    numbered (one block per list item, `indent` 0 … 5 for nested items) or checklist
    (lines "[ ] task" / "[x] done"). The content is markdown.

    Use this to write analysis or summaries back into a note.
    """
    note = client.call("get_note_content", channel_id=channel_id)
    positions = [b.get("position", 0) for b in note.get("blocks", [])]
    position = (max(positions) + 1) if positions else 0.1
    block = {"type": type, "uuid": str(uuid.uuid4()), "content": content, "position": position}
    if indent:
        block["indent"] = indent
    client.call("save_block", channel=channel_id, block=json.dumps(block), op="create")
    return {"uuid": block["uuid"], "position": position}


# ─── Databases & live metrics ──────────────────────────────────────────

@mcp.tool()
def read_database(channel_id: int, block_uuid: str) -> dict:
    """Read a database block (manual or computed live metric) as columns + rows."""
    data = client.call("get_database_content", channel=channel_id, block_uuid=block_uuid)
    cols = data.get("columns", [])
    rows = []
    for r in data.get("rows", []):
        cell = data.get("cells", {}).get(str(r["id"]), {})
        rows.append({c["name"]: cell.get(str(c["id"]), "") for c in cols})
    return {"name": data.get("name"), "source": data.get("source"),
            "columns": [c["name"] for c in cols], "rows": rows}


@mcp.tool()
def list_metric_datasets() -> dict:
    """List the live-metric catalog (datasets, dimensions, measures) and presets. Admin-only."""
    return client.call("describe_datasets")


@mcp.tool()
def run_metric(spec: dict) -> dict:
    """Run a MetricSpec live and return the result (without saving). Admin-only.

    spec example: {"dataset":"messages","dimensions":["day"],"measures":["count"],
                   "filters":[{"field":"since","op":"last_days","value":30}]}
    Use list_metric_datasets() first to see valid dataset/dimension/measure keys.
    """
    data = client.call("run_metric_spec", spec=json.dumps(spec))
    cols = data.get("columns", [])
    rows = []
    for r in data.get("rows", []):
        cell = data.get("cells", {}).get(str(r["id"]), {})
        rows.append({c["name"]: cell.get(str(c["id"]), "") for c in cols})
    return {"columns": [c["name"] for c in cols], "rows": rows}


@mcp.tool()
def create_metric_block(channel_id: int, spec: dict, name: str = "Live metric") -> dict:
    """Create a live-metric (computed) database block in a note. Admin-only.

    Creates a database block, then points it at `spec`. Returns the block uuid.
    """
    block_uuid = str(uuid.uuid4())
    note = client.call("get_note_content", channel_id=channel_id)
    positions = [b.get("position", 0) for b in note.get("blocks", [])]
    position = (max(positions) + 1) if positions else 0.1
    block = {"type": "database", "uuid": block_uuid, "content": "", "position": position}
    client.call("save_block", channel=channel_id, block=json.dumps(block), op="create")

    db = client.call("get_database_content", channel=channel_id, block_uuid=block_uuid)
    client.call("save_database", channel=channel_id, op="edit",
                database=json.dumps({"id": db["id"], "name": name,
                                     "source": "computed", "metric_spec": spec}))
    return {"block_uuid": block_uuid, "name": name}


if __name__ == "__main__":
    mcp.run()
