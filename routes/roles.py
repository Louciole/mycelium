"""Server roles: CRUD, @everyone defaults, hierarchy and membership.

Every action needs "manage-roles" (implied by server-admin). Below the owner,
the hierarchy applies (Discord rules): you can only touch roles strictly below
your highest one, and only grant or revoke permissions you hold yourself.
Positions: 0 = top of the list; new roles are appended at the bottom.
"""
import json
import re

from vesta import Server, HTTPError
import permissions
from routes.moderation import _notify_server

MAX_ROLE_NAME = 24            # role.name is varchar(24)
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
EVERYONE = "everyone"         # targetId of the @everyone pseudo-role (server.default_permissions)
MAX_BULK_MEMBERS = 200        # add_role_members


def notify_permissions_changed(self, server_id, exclude=None):
    """Roles, attributions, @everyone or channel/category overwrites changed: every
    member's client reloads the server and re-evaluates what it shows
    (static/ws/onMessage.mjs → onServerPermissionsChanged). The author is usually
    excluded: their client already applied the change locally."""
    _notify_server(self, int(server_id), {"type": "server_permissions_changed",
                                          "content": {"server_id": int(server_id)}}, exclude=exclude)


def _int(self, value, name):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise HTTPError(self.response, 400, f"invalid {name}")


def _parse_json(self, value, kind, name):
    try:
        parsed = json.loads(value or "")
    except ValueError:
        raise HTTPError(self.response, 400, f"invalid {name}")
    if not isinstance(parsed, kind):
        raise HTTPError(self.response, 400, f"invalid {name}")
    return parsed


def _server_roles(self, server_id):
    return sorted(self.db.getAll("role", server_id, "server") or [], key=lambda r: (r["position"], r["id"]))


def _require_outranks(self, uid, server_id, role):
    """403 unless uid sits strictly above `role` (None = @everyone)."""
    if not self.outranks(server_id, uid, role["position"] if role else None):
        raise HTTPError(self.response, 403, "this role is not below your highest role")


def _validated_permissions(self, uid, server_id, value, current, everyone=False):
    """Parse a permissions dict, check its keys and that every toggled right is
    held by uid. Returns the normalised dict ({right: ""}).
    Op rights only exist on op servers and never for @everyone (it would make every
    member a Mycelium admin). Keys already stored but no longer in the catalogue
    (legacy "mycelium_admin"…) are kept as long as they're not added."""
    wanted = _parse_json(self, value, dict, "permissions")
    allowed = set(permissions.SERVER_PERMISSIONS)
    if not everyone and self.db.getSomething("op_servs", server_id, "server"):
        allowed |= permissions.OP_PERMISSIONS
    unknown = set(wanted) - allowed - set(current or {})
    if unknown:
        raise HTTPError(self.response, 400, "unknown permission: " + ", ".join(sorted(unknown)))
    for right in set(wanted) ^ set(current or {}):
        if not self.checkAccessRights(uid, server_id, right):
            raise HTTPError(self.response, 403, f"you can't grant or revoke {right}")
    return {right: "" for right in wanted}


def _require_holds_role_rights(self, uid, server_id, role):
    """403 unless uid holds every right the role carries: otherwise assigning a
    lower role that someone above gave e.g. "ban-members" would hand it out."""
    for right in role["permissions"] or {}:
        if not self.checkAccessRights(uid, server_id, right):
            raise HTTPError(self.response, 403, f"this role grants {right}, which you don't have")


def _attribute(self, server_id, account_id, role_id):
    """Give a role to a member; False if they already had it."""
    if self.db.getFilters("role_attribution", ["account", "=", account_id, "and", "role", "=", role_id]):
        return False
    self.db.insertDict("role_attribution", {"account": account_id, "role": role_id, "server": server_id})
    return True


@Server.expose
def edit_server_role(self, server_id, action=None, field=None, value=None, targetId=None):
    uid = self.getUser()
    server_id = _int(self, server_id, "server_id")
    self.require_server_perm(uid, server_id, "manage-roles")
    result = _edit_server_role(self, uid, server_id, action, field, value, targetId)
    notify_permissions_changed(self, server_id, exclude=uid)   # only reached on success
    return result


def _edit_server_role(self, uid, server_id, action, field, value, targetId):
    if action == "create":
        roles = _server_roles(self, server_id)
        position = roles[-1]["position"] + 1 if roles else 0
        role_id = self.db.insertDict("role", {"name": "new role", "server": server_id, "position": position}, getId=True)
        return json.dumps(self.db.getSomething("role", role_id), default=str)

    if targetId == EVERYONE:
        # @everyone sits below every role: anyone holding a role outranks it.
        if field != "permissions":
            raise HTTPError(self.response, 400, "only permissions can be edited on @everyone")
        _require_outranks(self, uid, server_id, None)
        server = self.db.getSomething("server", server_id)
        perms = _validated_permissions(self, uid, server_id, value, server.get("default_permissions"), everyone=True)
        self.db.edit("server", server_id, "default_permissions", json.dumps(perms))
        self.invalidateAdminCache()
        return json.dumps({"status": "ok", "permissions": perms})

    role = self.db.getSomething("role", _int(self, targetId, "targetId"))
    if not role or role["server"] != server_id:
        raise HTTPError(self.response, 404, "role not found")
    _require_outranks(self, uid, server_id, role)

    if action == "delete":
        # role_attribution and channel_permission rows cascade (db/migrate_roles.sql)
        for row in self.db.getFilters("role_attribution", ["role", "=", role["id"]]) or []:
            self.db.deleteSomething("role_attribution", row["id"])
        self.db.deleteSomething("role", role["id"])
        self.invalidateAdminCache()
        return json.dumps({"status": "ok"})

    if action in ("attribute", "unattribute"):
        account_id = _int(self, value, "value")
        if action == "attribute":
            _require_holds_role_rights(self, uid, server_id, role)
            if not self.db.getFilters("accessserver", ["account", "=", account_id, "and", "server", "=", server_id]):
                raise HTTPError(self.response, 400, "not a member of this server")
            if not _attribute(self, server_id, account_id, role["id"]):
                raise HTTPError(self.response, 400, "already attributed")  # vesta has no 409
        else:
            for row in self.db.getFilters("role_attribution", ["account", "=", account_id, "and", "role", "=", role["id"]]) or []:
                self.db.deleteSomething("role_attribution", row["id"])
        self.invalidateAdminCache()
        return json.dumps({"status": "ok"})

    if field == "name":
        name = (value or "").strip()
        if not name or len(name) > MAX_ROLE_NAME:
            raise HTTPError(self.response, 400, f"Role name must be 1 to {MAX_ROLE_NAME} characters")
        self.db.edit("role", role["id"], "name", name)
        return json.dumps({"status": "ok", "name": name})

    if field == "color":
        if not COLOR_RE.match(value or ""):
            raise HTTPError(self.response, 400, "color must be #rrggbb")
        self.db.edit("role", role["id"], "color", value.lower())
        return json.dumps({"status": "ok", "color": value.lower()})

    if field == "permissions":
        perms = _validated_permissions(self, uid, server_id, value, role["permissions"])
        self.db.edit("role", role["id"], "permissions", json.dumps(perms))
        self.invalidateAdminCache()
        return json.dumps({"status": "ok", "permissions": perms})

    raise HTTPError(self.response, 400, "invalid action or field")


@Server.expose
def reorder_server_roles(self, server_id, order):
    """Rewrite the role hierarchy. `order` = JSON list of every role id of the
    server, top first. Below the owner, roles at or above your highest role
    must keep their place."""
    uid = self.getUser()
    server_id = _int(self, server_id, "server_id")
    self.require_server_perm(uid, server_id, "manage-roles")

    order = [_int(self, rid, "order") for rid in _parse_json(self, order, list, "order")]
    roles = _server_roles(self, server_id)
    current = [r["id"] for r in roles]
    if len(order) != len(current) or set(order) != set(current):
        raise HTTPError(self.response, 400, "order must list every role of the server once")

    for index, role in enumerate(roles):
        if not self.outranks(server_id, uid, role["position"]) and order[index] != role["id"]:
            raise HTTPError(self.response, 403, "you can only move roles below your highest role")

    by_id = {r["id"]: r for r in roles}
    for position, role_id in enumerate(order):
        if by_id[role_id]["position"] != position:
            self.db.edit("role", role_id, "position", position)
    notify_permissions_changed(self, server_id, exclude=uid)
    return json.dumps({"status": "ok", "order": order})


@Server.expose
def add_role_members(self, server_id, role_id, members):
    """Give a role to several members at once. `members` = JSON list of account ids."""
    uid = self.getUser()
    server_id = _int(self, server_id, "server_id")
    self.require_server_perm(uid, server_id, "manage-roles")

    role = self.db.getSomething("role", _int(self, role_id, "role_id"))
    if not role or role["server"] != server_id:
        raise HTTPError(self.response, 404, "role not found")
    _require_outranks(self, uid, server_id, role)
    _require_holds_role_rights(self, uid, server_id, role)

    accounts = [_int(self, m, "members") for m in _parse_json(self, members, list, "members")]
    if len(accounts) > MAX_BULK_MEMBERS:
        raise HTTPError(self.response, 400, f"at most {MAX_BULK_MEMBERS} members at once")
    member_ids = {row["account"] for row in self.db.getFilters("accessserver", ["server", "=", server_id]) or []}
    if any(a not in member_ids for a in accounts):
        raise HTTPError(self.response, 400, "not a member of this server")

    added = [a for a in dict.fromkeys(accounts) if _attribute(self, server_id, a, role["id"])]
    self.invalidateAdminCache()
    notify_permissions_changed(self, server_id, exclude=uid)
    return json.dumps({"status": "ok", "added": added})


# ── Channel permissions (overwrites) ──────────────────────────────────────────
# channel_permission rows: role (a role), account (a member) or neither (@everyone);
# `permissions` = allowed rights, `deny` = denied ones. See permissions.channel_rights.

def _channel(self, channelId, channelType):
    channel_type = "textual" if channelType == "conv" else channelType
    table = self._getChannelTable(channel_type)
    if not table or channel_type not in permissions.CHANNEL_PERMISSIONS:
        raise HTTPError(self.response, 400, "invalid channel type")
    chan = self.db.getSomething(table, _int(self, channelId, "channelId"))
    if not chan:
        raise HTTPError(self.response, 404, "channel not found")
    return chan, channel_type, table


def _overwrite_target(self, uid, server_id, roleId, accountId):
    """(role, account) of the overwrite to edit, checked against the hierarchy:
    a role below yours, a member whose highest role is below yours, or @everyone."""
    if accountId not in (None, ""):
        account = _int(self, accountId, "accountId")
        if not self.db.getFilters("accessserver", ["account", "=", account, "and", "server", "=", server_id]):
            raise HTTPError(self.response, 400, "not a member of this server")
        if self.db.getSomething("server", server_id)["owner"] == account \
                or not self.outranks(server_id, uid, self.memberTopPosition(server_id, account)):
            raise HTTPError(self.response, 403, "this member is not below your highest role")
        return None, account
    if roleId in (None, "", EVERYONE):
        return None, None
    role = self.db.getSomething("role", _int(self, roleId, "roleId"))
    if not role or role["server"] != server_id:
        raise HTTPError(self.response, 403, "role not in server")
    _require_outranks(self, uid, server_id, role)
    return role["id"], None


def _find_overwrite(self, chan, channel_type, role, account):
    rows = self.db.getFilters("channel_permission", ["channel", "=", chan["id"], "and", "channel_type", "=", channel_type]) or []
    for row in rows:
        if row.get("role") == role and row.get("account") == account:
            return row
    return None


def _save_overwrite(self, uid, chan, channel_type, role, account, allow, deny, row):
    """Upsert an overwrite. Every right whose state changes must be one uid holds
    in this channel: you can neither hand out nor take away what you lack."""
    scope = permissions.CHANNEL_PERMISSIONS[channel_type]
    allow = {permissions.CHANNEL_ALIASES.get(r, r) for r in allow}
    deny = {permissions.CHANNEL_ALIASES.get(r, r) for r in deny}
    if (allow | deny) - scope:
        raise HTTPError(self.response, 400, "unknown channel permission: " + ", ".join(sorted((allow | deny) - scope)))
    if allow & deny:
        raise HTTPError(self.response, 400, "a permission can not be both allowed and denied")
    old_allow = set((row or {}).get("permissions") or {})
    old_deny = set((row or {}).get("deny") or {})
    mine = self.channelRights(self.channelContext(uid, chan["server"]), chan, channel_type)
    changed = (allow ^ old_allow) | (deny ^ old_deny)
    if changed - mine:
        raise HTTPError(self.response, 403, "you can only change permissions you have in this channel: "
                        + ", ".join(sorted(changed - mine)))
    values = {"permissions": json.dumps({r: "" for r in allow}), "deny": json.dumps({r: "" for r in deny})}
    if row:
        for field, value in values.items():
            self.db.edit("channel_permission", row["id"], field, value)
        row_id = row["id"]
    else:
        row_id = self.db.insertDict("channel_permission", {
            "channel": chan["id"], "channel_type": channel_type, "server": chan["server"],
            "role": role, "account": account, **values}, getId=True)
    return self.db.getSomething("channel_permission", row_id)


@Server.expose
def edit_channel_permissions(self, channelId, channelType, action, roleId=None, accountId=None,
                             permission=None, value=None, allow=None, deny=None):
    """Channel privacy and permission overwrites. Needs "manage-roles" in the channel
    (server right or overwrite); targets must sit below you in the hierarchy.
    Target: roleId (a role id, or "everyone"/omitted for @everyone) or accountId (a member).
    Actions:
        togglePrivacy                 - private = @everyone can not view the channel
        add                           - create an empty overwrite for the target
        set (allow, deny: JSON lists) - replace the target's overwrite
        setPermission (permission, value=allow|deny|inherit) - one tri-state switch
        remove                        - delete the target's overwrite
        addRole / removeRole          - legacy: allow view + send / remove (roleId)
    """
    uid = self.getUser()
    chan, channel_type, table = _channel(self, channelId, channelType)
    if not self.checkChannelAccess(uid, chan["id"], channel_type, "manage-roles"):
        raise HTTPError(self.response, 403, "you need manage-roles in this channel")
    result = _edit_channel_permissions(self, uid, chan, channel_type, table, action, roleId, accountId,
                                       permission, value, allow, deny)
    notify_permissions_changed(self, chan["server"], exclude=uid)   # only reached on success
    return result


def _edit_channel_permissions(self, uid, chan, channel_type, table, action, roleId, accountId,
                              permission, value, allow, deny):
    server_id = chan["server"]
    if action == "togglePrivacy":
        private = not chan.get("is_private", False)
        self.db.edit(table, chan["id"], "is_private", private)
        return json.dumps({"is_private": private})

    role, account = _overwrite_target(self, uid, server_id, roleId, accountId)
    row = _find_overwrite(self, chan, channel_type, role, account)
    allow_now = set((row or {}).get("permissions") or {})
    deny_now = set((row or {}).get("deny") or {})

    if action in ("remove", "removeRole"):
        if row:
            # Removing clears every right it set: same "only what you have" check
            _save_overwrite(self, uid, chan, channel_type, role, account, set(), set(), row)
            self.db.deleteSomething("channel_permission", row["id"])
        return json.dumps({"status": "ok", "removed": bool(row)})

    if action == "add":
        row = row or _save_overwrite(self, uid, chan, channel_type, role, account, set(), set(), None)
    elif action == "addRole":
        if not row:
            scope = permissions.CHANNEL_PERMISSIONS[channel_type]
            row = _save_overwrite(self, uid, chan, channel_type, role, account,
                                  {"view-channels", "send-messages"} & scope, set(), None)
    elif action == "set":
        row = _save_overwrite(self, uid, chan, channel_type, role, account,
                              _parse_json(self, allow or "[]", list, "allow"),
                              _parse_json(self, deny or "[]", list, "deny"), row)
    elif action == "setPermission":
        right = permissions.CHANNEL_ALIASES.get(permission, permission)
        if value not in ("allow", "deny", "inherit"):
            raise HTTPError(self.response, 400, "value must be allow, deny or inherit")
        allow_now.discard(right)
        deny_now.discard(right)
        if value == "allow":
            allow_now.add(right)
        elif value == "deny":
            deny_now.add(right)
        row = _save_overwrite(self, uid, chan, channel_type, role, account, allow_now, deny_now, row)
    else:
        raise HTTPError(self.response, 400, "invalid action")
    return json.dumps(row, default=str)


@Server.expose
def get_channel_permissions(self, channelId, channelType):
    """The channel's overwrites (only for members who can view it)."""
    uid = self.getUser()
    chan, channel_type, _ = _channel(self, channelId, channelType)
    if not self.checkChannelAccess(uid, chan["id"], channel_type, "view-channels"):
        raise HTTPError(self.response, 403, "forbidden")
    rows = self.db.getFilters("channel_permission", ["channel", "=", chan["id"], "and", "channel_type", "=", channel_type])
    return json.dumps(rows or [], default=str)
