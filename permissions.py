"""Catalogue of server permissions and the channel-permission algorithm.

Keys are stored in role.permissions / server.default_permissions (server level)
and in channel_permission.permissions (allow) / .deny (channel overwrites).
The frontend mirror with labels and descriptions lives in static/access.mjs
(`rights`, `channelRightsFor`): keep both in sync.
"""

# Grantable on any server. "server-admin" implies every one of them.
SERVER_PERMISSIONS = {
    "view-channels",       # base: see channels (a channel overwrite can deny/allow it)
    "send-messages",       # base: write in text/forum channels and vocal chats, upload to drives
    "manage-server",       # server profile / community settings (edit_server_property)
    "manage-roles",        # roles below one's own; at channel level: that channel's permissions
    "manage-channels",     # channels, categories, forum settings & tags
    "manage-expressions",  # custom emojis
    "kick-members",
    "ban-members",
    "timeout-members",
    "manage-messages",     # delete others' messages, pin/lock/delete forum posts
    "edit-notes",          # write in notes channels (blocks, databases, spreadsheets)
    "manage-files",        # overwrite/delete other people's drive files and folders
    "server-admin",
}

# New servers give @everyone view-channels + send-messages: column default of
# server.default_permissions (db/migrate_roles.sql), backfilled on existing servers.

# Instance-wide rights, only grantable to roles of an op server (op_servs) — never
# to @everyone, never implied by server-admin: they make the holder a Mycelium admin.
OP_PERMISSIONS = {"dashboard-read", "mycelium-admin"}

ADMIN_IMPLIED = SERVER_PERMISSIONS

# Rights a channel overwrite can allow/deny, per channel type. view-channels is
# the gate: without it a member has no right at all in the channel. A category's
# overwrites may set any of them: each channel of the category keeps its own scope.
_CHANNEL_COMMON = {"view-channels", "manage-channels", "manage-roles"}
CHANNEL_PERMISSIONS = {
    "textual": _CHANNEL_COMMON | {"send-messages", "manage-messages"},
    "forum": _CHANNEL_COMMON | {"send-messages", "manage-messages"},
    "drive": _CHANNEL_COMMON | {"send-messages", "manage-files"},
    "note": _CHANNEL_COMMON | {"edit-notes"},
    "vocal": _CHANNEL_COMMON | {"send-messages", "manage-messages"},  # its text chat
}
CHANNEL_PERMISSIONS["category"] = set().union(*CHANNEL_PERMISSIONS.values())
# Older call sites / stored overwrites used "view".
CHANNEL_ALIASES = {"view": "view-channels"}


def implies(rights, action):
    """True if a set of granted rights covers `action`."""
    return action in rights or ("server-admin" in rights and action in ADMIN_IMPLIED)


def channel_rights(channel_type, server_rights, is_owner, layers, role_ids, uid):
    """Effective rights of a member in one channel (Discord's algorithm, layered).

    server_rights: the member's server-level rights (roles + @everyone defaults).
    layers: [(is_private, overwrites), ...] applied in order — the channel's category
    first, then the channel itself. overwrites are channel_permission rows ({role,
    account, permissions, deny}); role None + account None is @everyone. In each layer:
    @everyone deny/allow, private = @everyone loses view-channels, then the union of
    the member's role denies/allows, then the member's own overwrite. So a channel
    inherits its category and its own overwrites apply on top: moving it to another
    category changes what it inherits.
    """
    scope = CHANNEL_PERMISSIONS.get(channel_type, _CHANNEL_COMMON)
    if is_owner or "server-admin" in server_rights:
        return set(scope)
    rights = {r for r in server_rights if r in scope}

    def keys(row, col):
        return set(row.get(col) or {}) & scope

    for is_private, overwrites in layers:
        everyone = [o for o in overwrites if o.get("role") is None and o.get("account") is None]
        roles = [o for o in overwrites if o.get("role") is not None and o["role"] in role_ids]
        member = [o for o in overwrites if o.get("account") is not None and o["account"] == uid]
        for o in everyone:
            rights = (rights - keys(o, "deny")) | keys(o, "permissions")
        if is_private:
            rights.discard("view-channels")
        role_deny = set().union(*(keys(o, "deny") for o in roles)) if roles else set()
        role_allow = set().union(*(keys(o, "permissions") for o in roles)) if roles else set()
        rights = (rights - role_deny) | role_allow
        for o in member:
            rights = (rights - keys(o, "deny")) | keys(o, "permissions")

    return rights if "view-channels" in rights else set()
