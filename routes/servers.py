"""Server, channel, role, category, emoji and permission endpoints.

Endpoints take the live Mycelium instance as ``self``; shared helpers remain on
the class (see server.py).
"""
import json
import re

from vesta import Server, HTTPError, HTTPRedirect
from message_helpers import (_enrichMessagesWithPolls, _enrichMessagesWithReactions,
                             _enrichMessagesWithConvBlocks)
from constants import USER_STORAGE_QUOTA, SERVER_STORAGE_QUOTA


@Server.expose
def create_server(self, name=None):
    account_id = self.getUser()
    # Name typed in the creation modal; left empty → default name.
    name = (name or "").strip() or "New Server"
    if len(name) > MAX_SERVER_NAME:
        raise HTTPError(self.response, 400, f"Server name must be 1 to {MAX_SERVER_NAME} characters")
    server_id = self.db.insertDict('server', {'name': name, "owner": account_id}, getId=True)
    self.db.insertDict('accessserver', {'account': account_id, 'server': server_id})
    textCatID = self.db.insertDict('server_cat', {'name': "salons textuels", 'server': server_id},getId=True)
    self.db.insertDict('server_cat', {'name': "salons vocaux", 'server': server_id})
    self.db.insertDict('textual_channel', {'name': "général", 'server': server_id, "category": textCatID})
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
def get_serv_content(self, server_id, channel_id=None):
    uid = self.getUser()
    self.require_member(uid, server_id)
    content = {}
    if not channel_id:
        content["channels"] = self.db.getAll("textual_channel", server_id,"server")
        content["vocals"] = self.db.getAll("vocal_channel", server_id,"server")
        content["drives"] = self.db.getAll("drive_channel", server_id,"server")
        content["notes"] = self.db.getAll("notes_channel", server_id,"server")
        content["forums"] = self.db.getAll("forum_channel", server_id,"server")
        # content["whiteboard"] = self.db.getAll("drive_channel", server_id,"server")
        op = self.db.getSomething("op_servs", server_id, "server")
        if op:
            content["op"] = True
        content["cat"] = self.db.getAll("server_cat", server_id,"server")
        content["roles"] = self.db.getAll("role", server_id,"server")

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

        content["members"] = self.db.getFilters("accessserver", ["server", "=", server_id])
        for i in range(0, len(content["members"])):
            userRoles = self.db.getFilters("role_attribution", ["server", "=", server_id, "and", "account", "=", content["members"][i]["account"]])
            for j in range (0,len(userRoles)):
                userRoles[j] = userRoles[j]["role"]
            content["members"][i] = {"id": content["members"][i]["account"], "roles": userRoles}

        # Filter private channels: only show if user has view access
        content["channels"] = [ch for ch in content["channels"] if not ch.get("is_private") or self.checkChannelAccess(uid, ch["id"], "textual", "view")]
        content["vocals"] = [ch for ch in content["vocals"] if not ch.get("is_private") or self.checkChannelAccess(uid, ch["id"], "vocal", "view")]

        # Attach live occupant lists to each vocal channel
        for chan in content["vocals"]:
            call = self.callManager.get_call_by_vocal_channel(chan["id"])
            chan["occupants"] = call.participants if call else []
        content["drives"] = [ch for ch in content["drives"] if not ch.get("is_private") or self.checkChannelAccess(uid, ch["id"], "drive", "view")]
        content["notes"] = [ch for ch in content["notes"] if not ch.get("is_private") or self.checkChannelAccess(uid, ch["id"], "note", "view")]
        content["forums"] = [ch for ch in content["forums"] if not ch.get("is_private") or self.checkChannelAccess(uid, ch["id"], "forum", "view")]

        # Include channel_permissions for this server
        content["channel_permissions"] = self.db.getAll("channel_permission", server_id, "server") or []
    else:
        content["messages"] = self.db.getFilters("message", ["place", "=", channel_id, "order by timestamp"])
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
def edit_channel_permissions(self, channelId, channelType, action, roleId=None, permission=None, value=None):
    """Manage channel privacy and per-role channel permissions.
    Actions:
        togglePrivacy - toggle is_private on the channel
        addRole - add a role to the channel's allowed roles
        removeRole - remove a role from the channel's allowed roles
        editPermission - toggle a specific permission for a role on this channel
    """
    uid = self.getUser()

    table = self._getChannelTable(channelType)
    if not table:
        raise HTTPError(self.response, 400, "invalid channel type")

    chan = self.db.getSomething(table, channelId)
    if not chan:
        raise HTTPError(self.response, 404, "channel not found")

    serverId = chan["server"]
    self.require_server_perm(uid, serverId, "server-admin")

    if action == "togglePrivacy":
        newValue = not chan.get("is_private", False)
        self.db.edit(table, channelId, "is_private", newValue)
        return json.dumps({"is_private": newValue})

    elif action == "addRole":
        if not roleId:
            raise HTTPError(self.response, 400, "roleId required")
        # Check role belongs to this server
        role = self.db.getSomething("role", roleId)
        if not role or role["server"] != int(serverId):
            raise HTTPError(self.response, 403, "role not in server")
        # Check if already exists
        existing = self.db.getFilters("channel_permission", [
            "channel", "=", channelId, "and",
            "channel_type", "=", channelType, "and",
            "role", "=", roleId
        ])
        if existing:
            return json.dumps(existing[0], default=str)
        permId = self.db.insertDict("channel_permission", {
            "channel": channelId,
            "channel_type": channelType,
            "role": roleId,
            "server": serverId,
            "permissions": json.dumps({"view": "", "send-messages": ""})
        }, getId=True)
        perm = self.db.getSomething("channel_permission", permId)
        return json.dumps(perm, default=str)

    elif action == "removeRole":
        if not roleId:
            raise HTTPError(self.response, 400, "roleId required")
        existing = self.db.getFilters("channel_permission", [
            "channel", "=", channelId, "and",
            "channel_type", "=", channelType, "and",
            "role", "=", roleId
        ])
        if existing:
            self.db.deleteSomething("channel_permission", existing[0]["id"])
        return json.dumps({"success": True})

    elif action == "editPermission":
        if not roleId or not permission:
            raise HTTPError(self.response, 400, "roleId and permission required")
        existing = self.db.getFilters("channel_permission", [
            "channel", "=", channelId, "and",
            "channel_type", "=", channelType, "and",
            "role", "=", roleId
        ])
        if not existing:
            raise HTTPError(self.response, 404, "role not added to channel")
        perms = existing[0].get("permissions", {})
        if isinstance(perms, str):
            perms = json.loads(perms)
        if value == "true":
            perms[permission] = ""
        else:
            perms.pop(permission, None)
        self.db.edit("channel_permission", existing[0]["id"], "permissions", json.dumps(perms))
        return json.dumps({"permissions": perms})

    raise HTTPError(self.response, 400, "invalid action")


@Server.expose
def get_channel_permissions(self, channelId, channelType):
    """Get all channel_permission rows for a specific channel."""
    uid = self.getUser()

    table = self._getChannelTable(channelType)
    if not table:
        raise HTTPError(self.response, 400, "invalid channel type")

    chan = self.db.getSomething(table, channelId)
    if not chan:
        raise HTTPError(self.response, 404, "channel not found")

    serverId = chan["server"]
    self.require_member(uid, serverId)

    perms = self.db.getFilters("channel_permission", [
        "channel", "=", channelId, "and",
        "channel_type", "=", channelType
    ])
    return json.dumps(perms or [], default=str)


@Server.expose
def create_server_emoji(self, server_id, name, value):
    uid = self.getUser()
    self.require_server_perm(uid, server_id, "edit")
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
    self.require_server_perm(uid, emoji["server"], "edit")
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
    self.require_server_perm(uid, server_id, "edit")

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
def edit_server_channel(self, server_id, action="edit", field=None, value=None, targetId=None, channel_type=None):
    uid = self.getUser()
    self.require_server_perm(uid, server_id, "edit")

    if action == "create":
        channel_type = channel_type if channel_type else "textual"
        table = self._getChannelTable(channel_type) or "textual_channel"

        defaults = {"server": server_id}
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

        channel_id = self.db.insertDict(table, defaults, getId=True)
        channel = self.db.getSomething(table, channel_id)
        return json.dumps({"channel": channel, "type": channel_type}, default=str)

    table_name = self._getChannelTable(channel_type) or "textual_channel"
    chan = self.db.getSomething(table_name, targetId)
    if chan and chan["server"] == int(server_id):
        if action == "delete":
            if channel_type == "forum":
                for post in self.db.getFilters("forum_post", ["forum", "=", int(targetId)]):
                    for msg in self.db.getFilters("message", ["place", "=", post["id"]]):
                        self.db.deleteSomething("message", msg["id"])
                    self.db.deleteSomething("forum_post", post["id"])
            self.db.deleteSomething(table_name, targetId)
            return json.dumps({"status": "ok"})
        allowed_channel_fields = ("name", "place", "category")
        if field not in allowed_channel_fields:
            raise HTTPError(self.response, 400, "invalid field for channel")
        if field == "category":
            value = int(value) if value else None
        elif field == "place":
            value = float(value)
        self.db.edit(table_name, targetId, field, value)
        return json.dumps({"status": "ok"})

    raise HTTPError(self.response, 403, "forbidden")


@Server.expose
def edit_server_category(self, server_id, action=None, field=None, value=None, targetId=None):
    uid = self.getUser()
    self.require_server_perm(uid, server_id, "edit")

    if action == "create":
        cat_id = self.db.insertDict("server_cat", {"name": "New Category", "server": server_id}, getId=True)
        cat = self.db.getSomething("server_cat", cat_id)
        return json.dumps(cat, default=str)

    cat = self.db.getSomething("server_cat", targetId)
    if not cat or cat["server"] != int(server_id):
        raise HTTPError(self.response, 403, "forbidden")

    if action == "delete":
        for table in ["textual_channel", "vocal_channel", "drive_channel", "notes_channel", "forum_channel"]:
            channels = self.db.getFilters(table, ["category", "=", targetId])
            for ch in channels:
                self.db.edit(table, ch["id"], "category", None)
        self.db.deleteSomething("server_cat", targetId)
        return json.dumps({"status": "ok"})

    if field in ("name", "place"):
        val = float(value) if field == "place" else value
        self.db.edit("server_cat", targetId, field, val)
        return json.dumps({"status": "ok"})

    raise HTTPError(self.response, 400, "invalid field for category")


@Server.expose
def edit_server_role(self, server_id, action=None, field=None, value=None, targetId=None):
    uid = self.getUser()
    # Role/permission management requires admin — otherwise an "edit" holder
    # could grant themselves a role carrying "server-admin".
    self.require_server_perm(uid, server_id, "server-admin")

    if action == "create":
        role_id = self.db.insertDict("role", {"name": "new role", "server": server_id}, getId=True)
        return json.dumps({"id": role_id})

    role = self.db.getSomething("role", targetId)
    if not role or role["server"] != int(server_id) or field == "server":
        raise HTTPError(self.response, 403)

    if action == "delete":
        self.db.deleteSomething("role", targetId)
        return json.dumps({"status": "ok"})

    if action == "attribute":
        if self.db.getFilters("role_attribution", ["account", "=", value, "and", "role", "=", targetId, "and", "server", "=", server_id]):
            raise HTTPError(self.response, 403, "already attributed")
        self.db.insertDict("role_attribution", {"account": value, "role": targetId, "server": server_id}, getId=True)
        self.invalidateAdminCache()
        return json.dumps({"status": "ok"})

    if action == "unattribute":
        rows = self.db.getFilters("role_attribution", ["account", "=", value, "and", "role", "=", targetId, "and", "server", "=", server_id]) or []
        for row in rows:
            self.db.deleteSomething("role_attribution", row["id"])
        self.invalidateAdminCache()
        return json.dumps({"status": "ok"})

    if field == "permissions":
        permissions = json.loads(value)
        serv_op = self.db.getSomething("op_servs", server_id, "server")
        if permissions.get("mycelium-admin") is not None and serv_op == []:
            raise HTTPError(self.response, 403)

    self.db.edit("role", targetId, field, value)
    self.invalidateAdminCache()
    return json.dumps({"status": "ok"})


@Server.expose
def create_personal_server(self, server_id):
    uid = self.getUser()
    server = self.db.getSomething("server", server_id)
    if not server or server["owner"] != uid:
        raise HTTPError(self.response, 403, "forbidden")

    if self.db.getSomething("personal_server", uid, "owner"):
        raise HTTPError(self.response, 403, "You already have a personal server")
    self.db.insertDict("personal_server", {"owner": uid, "server": server["id"]})
