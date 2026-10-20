"""Server, channel, role, category, emoji and permission endpoints.

Endpoints take the live Mycelium instance as ``self``; shared helpers remain on
the class (see server.py).
"""
import json
import math
import re

from vesta import Server, HTTPError, HTTPRedirect
from message_helpers import (_enrichMessagesWithPolls, _enrichMessagesWithReactions,
                             _enrichMessagesWithConvBlocks, vocal_chat_place)
from constants import USER_STORAGE_QUOTA, SERVER_STORAGE_QUOTA
import permissions
from routes.roles import notify_permissions_changed

CHANNEL_TYPES = ("textual", "vocal", "drive", "note", "forum")
CHANNEL_TABLES = ("textual_channel", "vocal_channel", "drive_channel", "notes_channel", "forum_channel")

# Sidebar order: `place` floats, one list per container — the top level (categories +
# channels without a category) and each category (its channels, every type together).
# A reorder writes the dragged item's place only (static/drag.mjs).


def _parse_place(self, value):
    """A finite float: NaN/inf would break the sort on every client."""
    try:
        place = float(value)
    except (TypeError, ValueError):
        raise HTTPError(self.response, 400, "place must be a number")
    if not math.isfinite(place):
        raise HTTPError(self.response, 400, "place must be a number")
    return place


def _top_level_places_sql():
    """Places of the top-level list of server %(server)s: categories + channels without one."""
    return " UNION ALL ".join(
        ["SELECT place FROM server_cat WHERE server = %(server)s"]
        + [f"SELECT place FROM {t} WHERE server = %(server)s AND category IS NULL" for t in CHANNEL_TABLES])


def _insert_at_end(self, table, row):
    """Insert a channel or category at the end of the top level of its server's
    sidebar (after the last category / channel without category), in one statement.
    `table` and the columns come from this module, never from the request."""
    columns = list(row)
    sql = (f"INSERT INTO {table} ({', '.join(columns)}, place) "
           f"SELECT {', '.join(f'%({c})s' for c in columns)}, coalesce(max(place), 0) + 1 "
           f"FROM ({_top_level_places_sql()}) t RETURNING id")
    with self.db.pool.connection() as conn:
        return conn.execute(sql, row).fetchone()["id"]


@Server.expose
def create_server(self, name=None):
    account_id = self.getUser()
    # Name typed in the creation modal; left empty → default name.
    name = (name or "").strip() or "New Server"
    if len(name) > MAX_SERVER_NAME:
        raise HTTPError(self.response, 400, f"Server name must be 1 to {MAX_SERVER_NAME} characters")
    server_id = self.db.insertDict('server', {'name': name, "owner": account_id}, getId=True)
    self.db.insertDict('accessserver', {'account': account_id, 'server': server_id})
    textCatID = self.db.insertDict('server_cat', {'name': "salons textuels", 'server': server_id, 'place': 1}, getId=True)
    self.db.insertDict('server_cat', {'name': "salons vocaux", 'server': server_id, 'place': 2})
    self.db.insertDict('textual_channel', {'name': "général", 'server': server_id, "category": textCatID, 'place': 1})
    server = self.db.getSomething('server', server_id)
    server["customEmojis"] = []
    return json.dumps(server, default=str)


@Server.expose
def delete_server(self, server_id):
    uid = self.getUser()
    self.require_server_perm(uid, server_id, "server-admin")

    # If this is a personal server, deduct its usage from the owner's quota
    personal = self.db.getFilters("personal_server", ["server", "=", server_id])
    if personal:
        server = self.db.getSomething("server", server_id)
        if server and server.get("storage_usage", 0) > 0:
            self._adjustUserStorage(personal[0]["owner"], -server["storage_usage"])

    self.db.deleteSomething("server", server_id)
    raise HTTPRedirect(self.response, "/channels")


@Server.expose
def get_user_servers(self):
    uid = self.getUser()
    servers = self.db.getSomethingProxied("server", "accessserver", "account", uid)
    for server in servers:
        server["customEmojis"] = self.db.getAll("server_emoji", server["id"], "server")
    return json.dumps(servers, default=str)


@Server.expose
def leave_server(self, server_id):
    uid = self.getUser()
    record = self.require_member(uid, server_id)
    self.db.deleteSomething("accessserver", record["id"])
    return json.dumps({"ok": True})


@Server.expose
def get_serv_content(self, server_id):
    uid = self.getUser()
    self.require_member(uid, server_id)
    content = {}
    # Sidebar order (place), then creation order for ties (data from before
    # db/migrate_channel_order.sql): rows come back unordered from the DB.
    by_place = lambda table: sorted(self.db.getAll(table, server_id, "server") or [], key=lambda r: (r["place"], r["id"]))
    content["channels"] = by_place("textual_channel")
    content["vocals"] = by_place("vocal_channel")
    content["drives"] = by_place("drive_channel")
    content["notes"] = by_place("notes_channel")
    content["forums"] = by_place("forum_channel")
    op = self.db.getSomething("op_servs", server_id, "server")
    if op:
        content["op"] = True
    content["cat"] = by_place("server_cat")
    content["roles"] = sorted(self.db.getAll("role", server_id, "server") or [], key=lambda r: (r["position"], r["id"]))
    content["default_permissions"] = (self.db.getSomething("server", server_id) or {}).get("default_permissions") or {}

    personal = self.db.getFilters("personal_server", ["server", "=", server_id])
    if personal:
        content["type"] = "personal"
        owner = self.db.getSomething("mycelium_account", personal[0]["owner"])
        content["storage_usage"] = owner.get("storage_usage", 0) if owner else 0
        content["storage_quota"] = USER_STORAGE_QUOTA
    else:
        content["type"] = "standard"
        server_data = self.db.getSomething("server", server_id)
        content["storage_usage"] = server_data.get("storage_usage", 0) if server_data else 0
        content["storage_quota"] = SERVER_STORAGE_QUOTA

    # Every member's role ids: one query for the whole server, not one per member
    roles_of = {}
    for attribution in self.db.getAll("role_attribution", server_id, "server") or []:
        roles_of.setdefault(attribution["account"], []).append(attribution["role"])
    content["members"] = [{"id": m["account"], "roles": roles_of.get(m["account"], [])}
                          for m in self.db.getFilters("accessserver", ["server", "=", server_id]) or []]

    # Only the channels the user can view (private channels, view overwrites)
    ctx = self.channelContext(uid, server_id)
    visible = lambda chans, ctype: [ch for ch in chans if "view-channels" in self.channelRights(ctx, ch, ctype)]
    content["channels"] = visible(content["channels"], "textual")
    content["vocals"] = visible(content["vocals"], "vocal")

    # Attach live occupant lists to each vocal channel
    for chan in content["vocals"]:
        call = self.callManager.get_call_by_vocal_channel(chan["id"])
        chan["occupants"] = call.participants if call else []
        chan["voice_states"] = call.voice_states if call else {}
        chan["started_at_ms"] = call.to_dict()["started_at_ms"] if call else None
    content["drives"] = visible(content["drives"], "drive")
    content["notes"] = visible(content["notes"], "note")
    content["forums"] = visible(content["forums"], "forum")

    # Overwrites of the visible channels only: the client mirrors the rights
    # computation (access.mjs channelRightsFor) to lock what you can't do.
    shown = {(ch["id"], t) for key, t in (("channels", "textual"), ("vocals", "vocal"), ("drives", "drive"),
                                            ("notes", "note"), ("forums", "forum")) for ch in content[key]}
    # A category shows if you can view it or one of its channels (a channel can
    # re-allow what its category hides); its overwrites come along for the mirror.
    used = {ch.get("category") for key in ("channels", "vocals", "drives", "notes", "forums") for ch in content[key]}
    content["cat"] = [c for c in content["cat"]
                      if c["id"] in used or "view-channels" in self.channelRights(ctx, c, "category")]
    shown |= {(c["id"], "category") for c in content["cat"]}
    content["channel_permissions"] = [row for rows in ctx["overwrites"].values() for row in rows
                                      if (row["channel"], row["channel_type"]) in shown]
    return json.dumps(content, default=str)


@Server.expose
def get_chan_content(self, channel_id):
    uid = self.getUser()
    chan = self.require_channel_access(uid, channel_id, "textual", "view")

    content = {"name": chan["name"], "id": channel_id}
    content["messages"] = self.db.getFilters("message", ["place", "=", channel_id, "order by timestamp"])
    _enrichMessagesWithPolls(self, content["messages"], uid)
    _enrichMessagesWithReactions(self, content["messages"])
    _enrichMessagesWithConvBlocks(self, content["messages"])
    return json.dumps(content, default=str)


@Server.expose
def get_vocal_chat(self, channel_id):
    """Text chat of a vocal channel: anyone who can view the channel reads it, in
    the call or not. `id` is the message place to post to (send_message)."""
    uid = self.getUser()
    chan = self.require_channel_access(uid, channel_id, "vocal", "view")

    place = vocal_chat_place(self, chan["id"])
    content = {"id": place, "vocal": chan["id"], "name": chan["name"]}
    content["messages"] = self.db.getFilters("message", ["place", "=", place, "order by timestamp"])
    _enrichMessagesWithPolls(self, content["messages"], uid)
    _enrichMessagesWithReactions(self, content["messages"])
    _enrichMessagesWithConvBlocks(self, content["messages"])
    return json.dumps(content, default=str)


@Server.expose
def get_note_content(self, channel_id):
    uid = self.getUser()
    chan = self.require_channel_access(uid, channel_id, "note", "view")

    content = {"name": chan["name"], "id": channel_id}
    content["blocks"] = self.db.getFilters("note_block", ["channel", "=", channel_id])
    return json.dumps(content, default=str)


@Server.expose
def set_server_featured(self, server_id, featured):
    """
    Set a server as featured (admin only).

    Args:
        server_id: ID of the server
        featured: "true" or "false"

    Returns:
        Success message
    """
    uid = self.getUser()

    # Check if user is admin
    if not self.isAdmin(uid):
        raise HTTPError(self.response, 403, "Only admins can feature servers")

    # Check if server exists and is a community server
    server = self.db.getSomething("server", server_id)
    if not server:
        raise HTTPError(self.response, 404, "Server not found")

    if not server.get('is_community', False):
        raise HTTPError(self.response, 400, "Only community servers can be featured")

    # Update featured status
    self.db.edit("server", server_id, "is_featured", featured == "true")

    return json.dumps({"success": True, "server_id": server_id, "is_featured": featured == "true"})


@Server.expose
def create_server_emoji(self, server_id, name, value):
    uid = self.getUser()
    self.require_server_perm(uid, server_id, "manage-expressions")
    existing = self.db.getAll("server_emoji", server_id, "server")
    if len(existing) >= 20:
        return json.dumps({"error": "max_emojis"})
    filename = self.saveFile(value)
    emoji_id = self.db.insertDict("server_emoji", {
        "server": int(server_id),
        "name": name,
        "file": filename
    }, getId=True)
    emoji = self.db.getSomething("server_emoji", emoji_id)
    return json.dumps(emoji, default=str)


@Server.expose
def delete_server_emoji(self, emoji_id):
    uid = self.getUser()
    emoji = self.db.getSomething("server_emoji", emoji_id)
    if not emoji:
        raise HTTPError(self.response, 404)
    self.require_server_perm(uid, emoji["server"], "manage-expressions")
    self.db.deleteSomething("server_emoji", emoji_id)
    return json.dumps({"status": "ok"})


@Server.expose
def get_custom_emoji(self, emoji_id):
    """Returns public emoji metadata so users outside the server can display it."""
    uid = self.getUser()
    emoji = self.db.getSomething("server_emoji", emoji_id)
    if not emoji:
        raise HTTPError(self.response, 404)
    return json.dumps({"id": emoji["id"], "name": emoji["name"], "file": emoji["file"]}, default=str)


# Limits for the community (Discover) metadata; the settings UI enforces the same.
MAX_SERVER_NAME = 44          # server.name is varchar(44)
MAX_SERVER_DESCRIPTION = 500
MAX_SERVER_TAGS = 10
MAX_SERVER_TAG_LENGTH = 20
MAX_SERVER_LANGUAGES = 20
LANGUAGE_CODE = re.compile(r"^[a-z]{2,3}$")  # ISO 639-1 (or 639-2) code


def _parse_string_list(self, value, what):
    """Parse a JSON array of strings sent as ``value``; 400 on anything else."""
    try:
        items = json.loads(value) if isinstance(value, str) else value
    except (TypeError, ValueError):
        raise HTTPError(self.response, 400, f"{what} must be a JSON array")
    if not isinstance(items, list) or not all(isinstance(i, str) for i in items):
        raise HTTPError(self.response, 400, f"{what} must be an array of strings")
    return [i.strip() for i in items]


def _validate_tags(self, value):
    tags = _parse_string_list(self, value, "tags")
    if len(tags) > MAX_SERVER_TAGS:
        raise HTTPError(self.response, 400, f"Too many tags (max {MAX_SERVER_TAGS})")
    if any(not t or len(t) > MAX_SERVER_TAG_LENGTH for t in tags):
        raise HTTPError(self.response, 400, f"Tags must be 1 to {MAX_SERVER_TAG_LENGTH} characters")
    if len({t.lower() for t in tags}) != len(tags):
        raise HTTPError(self.response, 400, "Duplicate tag")
    return tags


def _validate_languages(self, value):
    languages = [lang.lower() for lang in _parse_string_list(self, value, "languages")]
    if len(languages) > MAX_SERVER_LANGUAGES:
        raise HTTPError(self.response, 400, f"Too many languages (max {MAX_SERVER_LANGUAGES})")
    if any(not LANGUAGE_CODE.match(lang) for lang in languages):
        raise HTTPError(self.response, 400, "Invalid language code")
    if len(set(languages)) != len(languages):
        raise HTTPError(self.response, 400, "Duplicate language")
    return languages


@Server.expose
def edit_server_property(self, server_id, property, value=None):
    uid = self.getUser()
    forbidden_fields = ["id", "owner", "is_featured", "member_count"]
    if property in forbidden_fields:
        raise HTTPError(self.response, 403)
    self.require_server_perm(uid, server_id, "manage-server")

    if property == "name":
        name = (value or "").strip()
        if not name or len(name) > MAX_SERVER_NAME:
            raise HTTPError(self.response, 400, f"Server name must be 1 to {MAX_SERVER_NAME} characters")
        self.db.edit("server", server_id, "name", name)
    elif property == "pfp":
        filename = self.saveFile(value)
        self.db.edit("server", server_id, "pfp", filename)
        return json.dumps({"pfp": filename}, default=str)
    elif property == "is_community":
        if value not in ("true", "false"):
            raise HTTPError(self.response, 400, "is_community must be true or false")
        server = self.db.getSomething("server", server_id)
        if server["owner"] != uid:
            raise HTTPError(self.response, 403, "Only server owner can change community status")
        self.db.edit("server", server_id, "is_community", value == "true")
    elif property == "tags":
        self.db.edit("server", server_id, "tags", json.dumps(_validate_tags(self, value)))
    elif property == "languages":
        self.db.edit("server", server_id, "languages", json.dumps(_validate_languages(self, value)))
    elif property == "description":
        description = value or ""
        if len(description) > MAX_SERVER_DESCRIPTION:
            raise HTTPError(self.response, 400, f"Description too long (max {MAX_SERVER_DESCRIPTION})")
        self.db.edit("server", server_id, "description", description)
    else:
        raise HTTPError(self.response, 400, "Unknown server property")
    return json.dumps({"status": "ok"})


@Server.expose
def edit_server_channel(self, server_id, action="edit", field=None, value=None, targetId=None, channel_type=None,
                        place=None):
    uid = self.getUser()

    channel_type = channel_type or "textual"
    if channel_type not in CHANNEL_TYPES:
        raise HTTPError(self.response, 400, "invalid channel type")

    if action == "create":
        self.require_server_perm(uid, server_id, "manage-channels")
        table = self._getChannelTable(channel_type)

        defaults = {"server": int(server_id)}
        if channel_type == "vocal":
            defaults["name"] = "Salon vocal"
        elif channel_type == "drive":
            defaults["name"] = "new storage"
        elif channel_type == "note":
            defaults["name"] = "new note"
        elif channel_type == "forum":
            defaults["name"] = "new forum"
        else:
            defaults["name"] = "new channel"

        channel_id = _insert_at_end(self, table, defaults)
        channel = self.db.getSomething(table, channel_id)
        return json.dumps({"channel": channel, "type": channel_type}, default=str)

    table_name = self._getChannelTable(channel_type)
    chan = self.db.getSomething(table_name, targetId)
    # Editing/deleting one channel: "manage-channels" in that channel (server right
    # or a channel overwrite).
    if chan and chan["server"] == int(server_id) and self.checkChannelAccess(uid, chan["id"], channel_type, "manage-channels"):
        if action == "delete":
            # channel_permission is polymorphic (no FK on channel): drop its overwrites
            for row in self.db.getFilters("channel_permission", ["channel", "=", chan["id"], "and", "channel_type", "=", channel_type]) or []:
                self.db.deleteSomething("channel_permission", row["id"])
            # Messages go through deleteMessageWithCleanup (attachment files + quota
            # refund), while their place row still exists to say whose quota it was.
            if channel_type == "forum":
                for post in self.db.getFilters("forum_post", ["forum", "=", int(targetId)]):
                    for msg in self.db.getFilters("message", ["place", "=", post["id"]]):
                        self.deleteMessageWithCleanup(msg)
                    self.db.deleteSomething("forum_post", post["id"])
            if channel_type == "vocal":
                chat = self.db.getSomething("vocal_chat", chan["id"], "vocal")
                if chat:   # newest first: a reply references an older message
                    for msg in reversed(self.db.getFilters("message", ["place", "=", chat["id"], "order by id"]) or []):
                        self.deleteMessageWithCleanup(msg)
                    # Rows keyed by the chat's place id (no FK on these polymorphic columns)
                    for table, column in (("offline_notifs", "conversation"), ("channel_mute", "channel"),
                                          ("channel_unread", "channel")):
                        for row in self.db.getFilters(table, [column, "=", chat["id"]]) or []:
                            self.db.deleteSomething(table, row["id"])
                # the vocal_chat row goes with the channel (ON DELETE CASCADE)
            self.db.deleteSomething(table_name, targetId)
            return json.dumps({"status": "ok"})
        allowed_channel_fields = ("name", "place", "category")
        if field not in allowed_channel_fields:
            raise HTTPError(self.response, 400, "invalid field for channel")
        moved = False
        if field == "category":
            value = int(value) if value else None
            moved = value != chan.get("category")
            if moved:
                _require_category_move(self, uid, chan, channel_type, value)
            if place is None:
                self.db.edit(table_name, chan["id"], "category", value)
            else:
                # A drag into another category: its place in the new list, same UPDATE
                new_place = _parse_place(self, place)
                with self.db.pool.connection() as conn:
                    conn.execute(f"UPDATE {table_name} SET category = %s, place = %s WHERE id = %s",
                                 (value, new_place, chan["id"]))
        else:
            if field == "place":
                value = _parse_place(self, value)
            self.db.edit(table_name, chan["id"], field, value)
        if moved:
            # The channel now inherits another category's permissions
            notify_permissions_changed(self, chan["server"], exclude=uid)
        return json.dumps({"status": "ok"})

    raise HTTPError(self.response, 403, "forbidden")


def _require_category_move(self, uid, chan, channel_type, new_category):
    """Moving a channel to another category changes what it inherits (its category's
    permissions): it needs manage-roles in the channel, and manage-channels in the
    destination category."""
    if not self.checkChannelAccess(uid, chan["id"], channel_type, "manage-roles"):
        raise HTTPError(self.response, 403, "moving a channel changes its permissions: manage-roles needed")
    if new_category is not None:
        cat = self.db.getSomething("server_cat", new_category)
        if not cat or cat["server"] != chan["server"]:
            raise HTTPError(self.response, 400, "unknown category")
        if not self.checkChannelAccess(uid, cat["id"], "category", "manage-channels"):
            raise HTTPError(self.response, 403, "you can't manage channels of that category")


def _detach_from_category(self, cat):
    """Before a category disappears, copy what its channels inherited onto them so
    deleting e.g. a private category doesn't expose its channels: privacy is kept
    and, per target, the channel's own setting of a right wins over the category's."""
    cat_rows = self.db.getFilters("channel_permission", ["channel", "=", cat["id"], "and", "channel_type", "=", "category"]) or []
    # Its channels take its spot in the top-level list (between it and the next item),
    # in the order they were shown: place, then type, then id (crud.mjs sidebarOrder).
    channels = sorted(((channel_type, ch) for channel_type in CHANNEL_TYPES
                       for ch in self.db.getFilters(self._getChannelTable(channel_type), ["category", "=", cat["id"]]) or []),
                      key=lambda tc: (tc[1]["place"], CHANNEL_TYPES.index(tc[0]), tc[1]["id"]))
    with self.db.pool.connection() as conn:
        after = conn.execute(f"SELECT min(place) AS place FROM ({_top_level_places_sql()}) t WHERE place > %(place)s",
                             {"server": cat["server"], "place": cat["place"]}).fetchone()["place"]
    step = (after - cat["place"] if after is not None else len(channels) + 1) / (len(channels) + 1)
    for position, (channel_type, ch) in enumerate(channels, start=1):
        table = self._getChannelTable(channel_type)
        scope = permissions.CHANNEL_PERMISSIONS[channel_type]
        if cat.get("is_private") and not ch.get("is_private"):
            self.db.edit(table, ch["id"], "is_private", True)
        own = {(r.get("role"), r.get("account")): r for r in self.db.getFilters("channel_permission", [
            "channel", "=", ch["id"], "and", "channel_type", "=", channel_type]) or []}
        for row in cat_rows:
            target = (row.get("role"), row.get("account"))
            mine = own.get(target)
            set_here = set((mine or {}).get("permissions") or {}) | set((mine or {}).get("deny") or {})
            allow = (set((mine or {}).get("permissions") or {}) | (set(row.get("permissions") or {}) - set_here)) & scope
            deny = (set((mine or {}).get("deny") or {}) | (set(row.get("deny") or {}) - set_here)) & scope
            values = {"permissions": json.dumps({r: "" for r in allow}), "deny": json.dumps({r: "" for r in deny})}
            if mine:
                for field, value in values.items():
                    self.db.edit("channel_permission", mine["id"], field, value)
            else:
                self.db.insertDict("channel_permission", {"channel": ch["id"], "channel_type": channel_type,
                                                          "server": ch["server"], "role": target[0],
                                                          "account": target[1], **values})
        with self.db.pool.connection() as conn:
            conn.execute(f"UPDATE {table} SET category = NULL, place = %s WHERE id = %s",
                         (cat["place"] + step * position, ch["id"]))
    for row in cat_rows:
        self.db.deleteSomething("channel_permission", row["id"])


@Server.expose
def edit_server_category(self, server_id, action=None, field=None, value=None, targetId=None):
    uid = self.getUser()

    if action == "create":
        self.require_server_perm(uid, server_id, "manage-channels")
        cat_id = _insert_at_end(self, "server_cat", {"name": "New Category", "server": int(server_id)})
        cat = self.db.getSomething("server_cat", cat_id)
        return json.dumps(cat, default=str)

    cat = self.db.getSomething("server_cat", targetId)
    # One category: "manage-channels" in it (server right or a category overwrite)
    if not cat or cat["server"] != int(server_id) \
            or not self.checkChannelAccess(uid, cat["id"], "category", "manage-channels"):
        raise HTTPError(self.response, 403, "forbidden")

    if action == "delete":
        _detach_from_category(self, cat)
        self.db.deleteSomething("server_cat", targetId)
        # Its channels got the overwrites they inherited: the author's client only
        # moved them out locally, so it reloads too (no exclude).
        notify_permissions_changed(self, cat["server"])
        return json.dumps({"status": "ok"})

    if field in ("name", "place"):
        val = _parse_place(self, value) if field == "place" else value
        self.db.edit("server_cat", targetId, field, val)
        return json.dumps({"status": "ok"})

    raise HTTPError(self.response, 400, "invalid field for category")


@Server.expose
def create_personal_server(self, server_id):
    uid = self.getUser()
    server = self.db.getSomething("server", server_id)
    if not server or server["owner"] != uid:
        raise HTTPError(self.response, 403, "forbidden")

    if self.db.getSomething("personal_server", uid, "owner"):
        raise HTTPError(self.response, 403, "You already have a personal server")
    self.db.insertDict("personal_server", {"owner": uid, "server": server["id"]})
