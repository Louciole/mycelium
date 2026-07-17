"""Moderation endpoints — server-level (Discord-parity) and platform-level (op users).

Endpoints take the live Mycelium instance as ``self``; shared enforcement helpers
(hasServerPerm, isBannedFromServer, activeServerTimeout, enforceNotTimedOut,
logModeration, deleteMessageWithCleanup, isAdmin) live on the class in server.py.

See docs/moderation.md for the full spec.
"""
import json
import datetime

from vesta import Server, HTTPError


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _notify_server(self, server_id, notif, exclude=None):
    """WS-notify every member of a server (optionally excluding one account)."""
    members = self.db.getFilters("accessserver", ["server", "=", server_id]) or []
    for member in members:
        if exclude is not None and member["account"] == exclude:
            continue
        self.sendNotification(member["account"], notif)


def _remove_membership(self, server_id, account_id):
    """Drop a user's accessserver + role_attribution rows for a server (kick/ban)."""
    rows = self.db.getFilters("accessserver", ["account", "=", account_id, "and", "server", "=", server_id]) or []
    for row in rows:
        self.db.deleteSomething("accessserver", row["id"])
    roles = self.db.getFilters("role_attribution", ["account", "=", account_id, "and", "server", "=", server_id]) or []
    for role in roles:
        self.db.deleteSomething("role_attribution", role["id"])


def _guard_target(self, server_id, account_id):
    """Reject moderation actions aimed at the server owner."""
    server = self.db.getSomething("server", server_id)
    if not server:
        raise HTTPError(self.response, 404, "server not found")
    if server["owner"] == account_id:
        raise HTTPError(self.response, 403, "cannot moderate the server owner")


def _account_label(self, account_id):
    acc = self.db.getSomething("mycelium_account", account_id)
    if not acc:
        return None
    return acc.get("display") or acc.get("username")


# ---------------------------------------------------------------------------
# A. Server-level moderation
# ---------------------------------------------------------------------------

@Server.expose
def kick_member(self, server_id, account_id, reason=None):
    uid = self.getUser()
    server_id, account_id = int(server_id), int(account_id)
    self.require_server_perm(uid, server_id, "kick-members")
    _guard_target(self, server_id, account_id)

    _remove_membership(self, server_id, account_id)
    self.logModeration(server_id, uid, "kick", target_account=account_id, reason=reason)

    self.sendNotification(account_id, {"type": "server_removed",
                                       "content": {"server_id": server_id, "reason": reason, "kind": "kick"}})
    _notify_server(self, server_id, {"type": "server_member_removed",
                                     "content": {"server_id": server_id, "account": account_id}})
    return json.dumps({"ok": True})


@Server.expose
def ban_member(self, server_id, account_id, reason=None, purge_days=0):
    uid = self.getUser()
    server_id, account_id, purge_days = int(server_id), int(account_id), int(purge_days or 0)
    self.require_server_perm(uid, server_id, "ban-members")
    _guard_target(self, server_id, account_id)

    # Record the ban (idempotent on the UNIQUE(server, account) constraint).
    existing = self.db.getFilters("server_ban", ["server", "=", server_id, "and", "account", "=", account_id])
    if not existing:
        self.db.insertDict("server_ban", {
            "server": server_id, "account": account_id,
            "reason": reason, "banned_by": uid,
        })

    _remove_membership(self, server_id, account_id)

    purged = 0
    if purge_days > 0:
        purged = _purge_member_messages(self, server_id, account_id, purge_days)

    self.logModeration(server_id, uid, "ban", target_account=account_id, reason=reason,
                       metadata={"purge_days": purge_days, "purged": purged})
    if purged:
        self.logModeration(server_id, uid, "purge", target_account=account_id,
                           metadata={"purge_days": purge_days, "purged": purged})

    self.sendNotification(account_id, {"type": "server_removed",
                                       "content": {"server_id": server_id, "reason": reason, "kind": "ban"}})
    _notify_server(self, server_id, {"type": "server_member_removed",
                                     "content": {"server_id": server_id, "account": account_id}})
    return json.dumps({"ok": True, "purged": purged})


def _purge_member_messages(self, server_id, account_id, purge_days):
    """Delete a member's recent messages across a server's textual channels,
    reusing the attachment-cleanup path (deleteMessageWithCleanup). Broadcasts a
    message_deleted for each removed message. Returns the count purged."""
    cutoff = datetime.datetime.now() - datetime.timedelta(days=purge_days)
    channels = self.db.getAll("textual_channel", server_id, "server") or []
    members = self.db.getFilters("accessserver", ["server", "=", server_id]) or []
    purged = 0
    for chan in channels:
        msgs = self.db.getFilters("message", [
            "place", "=", chan["id"], "and",
            "sender", "=", account_id, "and",
            "timestamp", ">", cutoff
        ]) or []
        for msg in msgs:
            mid = msg["id"]
            self.deleteMessageWithCleanup(msg)
            purged += 1
            del_notif = {"type": "message_deleted", "content": {"id": mid}}
            for member in members:
                self.sendNotification(member["account"], del_notif)
    return purged


@Server.expose
def unban_member(self, server_id, account_id):
    uid = self.getUser()
    server_id, account_id = int(server_id), int(account_id)
    self.require_server_perm(uid, server_id, "ban-members")

    rows = self.db.getFilters("server_ban", ["server", "=", server_id, "and", "account", "=", account_id]) or []
    for row in rows:
        self.db.deleteSomething("server_ban", row["id"])
    self.logModeration(server_id, uid, "unban", target_account=account_id)
    return json.dumps({"ok": True})


@Server.expose
def get_server_bans(self, server_id):
    uid = self.getUser()
    server_id = int(server_id)
    self.require_server_perm(uid, server_id, "ban-members")

    bans = self.db.getFilters("server_ban", ["server", "=", server_id]) or []
    out = []
    for b in bans:
        out.append({
            "id": b["id"],
            "account": b["account"],
            "account_name": _account_label(self, b["account"]),
            "reason": b.get("reason"),
            "banned_by": b["banned_by"],
            "created_at": str(b["created_at"]) if b.get("created_at") else None,
        })
    return json.dumps(out, default=str)


@Server.expose
def timeout_member(self, server_id, account_id, minutes, reason=None):
    uid = self.getUser()
    server_id, account_id, minutes = int(server_id), int(account_id), int(minutes)
    self.require_server_perm(uid, server_id, "timeout-members")
    _guard_target(self, server_id, account_id)

    expires_at = datetime.datetime.now() + datetime.timedelta(minutes=minutes)
    existing = self.db.getFilters("server_timeout", ["server", "=", server_id, "and", "account", "=", account_id])
    if existing:
        self.db.edit("server_timeout", existing[0]["id"], "expires_at", expires_at)
        self.db.edit("server_timeout", existing[0]["id"], "reason", reason)
        self.db.edit("server_timeout", existing[0]["id"], "moderator", uid)
    else:
        self.db.insertDict("server_timeout", {
            "server": server_id, "account": account_id,
            "reason": reason, "moderator": uid, "expires_at": expires_at,
        })
    self.logModeration(server_id, uid, "timeout", target_account=account_id, reason=reason,
                       metadata={"minutes": minutes, "expires_at": str(expires_at)})

    self.sendNotification(account_id, {"type": "server_timeout",
                                       "content": {"server_id": server_id,
                                                   "expires_at": str(expires_at), "reason": reason}})
    return json.dumps({"ok": True, "expires_at": str(expires_at)})


@Server.expose
def remove_timeout(self, server_id, account_id):
    uid = self.getUser()
    server_id, account_id = int(server_id), int(account_id)
    self.require_server_perm(uid, server_id, "timeout-members")

    rows = self.db.getFilters("server_timeout", ["server", "=", server_id, "and", "account", "=", account_id]) or []
    for row in rows:
        self.db.deleteSomething("server_timeout", row["id"])
    self.logModeration(server_id, uid, "untimeout", target_account=account_id)

    self.sendNotification(account_id, {"type": "server_timeout_removed",
                                       "content": {"server_id": server_id}})
    return json.dumps({"ok": True})


@Server.expose
def get_moderation_log(self, server_id, limit=50, before=None):
    uid = self.getUser()
    server_id = int(server_id)
    # Read access = the lowest mod tier (kick-members).
    self.require_server_perm(uid, server_id, "kick-members")

    lim = max(1, min(int(limit), 200))
    with self.db.pool.connection() as conn:
        if before:
            rows = conn.execute(
                "SELECT * FROM moderation_log WHERE server = %s AND id < %s ORDER BY id DESC LIMIT %s",
                (server_id, int(before), lim)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM moderation_log WHERE server = %s ORDER BY id DESC LIMIT %s",
                (server_id, lim)).fetchall()

    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "moderator": r["moderator"],
            "moderator_name": _account_label(self, r["moderator"]),
            "target_account": r.get("target_account"),
            "target_name": _account_label(self, r["target_account"]) if r.get("target_account") else None,
            "action": r["action"],
            "reason": r.get("reason"),
            "metadata": r.get("metadata"),
            "created_at": str(r["created_at"]) if r.get("created_at") else None,
        })
    return json.dumps(out, default=str)


# ---------------------------------------------------------------------------
# B. Platform-level moderation (op users)
#
# Every endpoint below is an authz bypass by design: ops act instance-wide and
# are NOT necessarily members of the servers/DMs they touch, so the normal
# require_member/checkAccessRights membership checks are skipped. The guard is
# self.isAdmin(uid) — the exact style used for the computed-dashboard branch in
# routes/workspaces.py (do not add a second admin-check helper) — and every
# action is written to platform_action_log.
# ---------------------------------------------------------------------------

@Server.expose
def my_suspension(self):
    """Current account's suspension status. Bypasses the suspension gate (via the
    base checkJwt) so the suspended-account screen can read its own reason/expiry."""
    import vesta
    info = vesta.Server.checkJwt(self)
    uid = info.get("username") if info else None
    row = self.activeSuspension(uid) if uid else None
    if not row:
        return json.dumps({"suspended": False})
    return json.dumps({
        "suspended": True,
        "reason": row.get("reason"),
        "expires_at": str(row["expires_at"]) if row.get("expires_at") else None,
    })


@Server.expose
def report_content(self, target_message=None, target_account=None, reason=""):
    """Any authenticated user can file a report. `server` is derived from the
    reported message's channel when applicable (DM reports have no server)."""
    uid = self.getUser()
    if not reason or not reason.strip():
        raise HTTPError(self.response, 400, "reason required")
    if not target_message and not target_account:
        raise HTTPError(self.response, 400, "must report a message or an account")

    server_id = None
    tmsg = None
    if target_message:
        tmsg = int(target_message)
        message = self.db.getSomething("message", tmsg)
        if not message:
            raise HTTPError(self.response, 404, "message not found")
        channel = self.db.getSomething("textual_channel", message["place"])
        if channel:
            server_id = channel["server"]
        # Default the reported account to the message author if not given.
        if not target_account:
            target_account = message["sender"]

    row_id = self.db.insertDict("report", {
        "reporter": uid,
        "target_message": tmsg,
        "target_account": int(target_account) if target_account else None,
        "server": server_id,
        "reason": reason.strip(),
        "status": "open",
    }, getId=True)
    return json.dumps({"ok": True, "id": row_id})


@Server.expose
def get_reports(self, status="open", limit=50):
    uid = self.getUser()
    if not self.isAdmin(uid):
        raise HTTPError(self.response, 403)

    lim = max(1, min(int(limit), 200))
    with self.db.pool.connection() as conn:
        rows = conn.execute(
            "SELECT * FROM report WHERE status = %s ORDER BY id DESC LIMIT %s",
            (status, lim)).fetchall()

    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "reporter": r["reporter"],
            "reporter_name": _account_label(self, r["reporter"]),
            "target_message": r.get("target_message"),
            "target_account": r.get("target_account"),
            "target_name": _account_label(self, r["target_account"]) if r.get("target_account") else None,
            "server": r.get("server"),
            "reason": r.get("reason"),
            "status": r["status"],
            "created_at": str(r["created_at"]) if r.get("created_at") else None,
            "resolved_by": r.get("resolved_by"),
            "resolved_at": str(r["resolved_at"]) if r.get("resolved_at") else None,
        })
    return json.dumps(out, default=str)


@Server.expose
def resolve_report(self, report_id, status, note=None):
    uid = self.getUser()
    if not self.isAdmin(uid):
        raise HTTPError(self.response, 403)
    if status not in ("actioned", "dismissed", "open"):
        raise HTTPError(self.response, 400, "invalid status")

    report = self.db.getSomething("report", int(report_id))
    if not report:
        raise HTTPError(self.response, 404, "report not found")

    self.db.edit("report", int(report_id), "status", status)
    self.db.edit("report", int(report_id), "resolved_by", uid)
    self.db.edit("report", int(report_id), "resolved_at", datetime.datetime.now())

    self.logPlatform(uid, "dismiss_report" if status == "dismissed" else "resolve_report",
                     target_account=report.get("target_account"),
                     target_server=report.get("server"),
                     reason=note, metadata={"report_id": int(report_id), "status": status})
    return json.dumps({"ok": True})


@Server.expose
def suspend_user(self, account_id, reason, duration_minutes=None):
    uid = self.getUser()
    if not self.isAdmin(uid):
        raise HTTPError(self.response, 403)
    account_id = int(account_id)
    if not reason or not str(reason).strip():
        raise HTTPError(self.response, 400, "reason required")

    expires_at = None
    if duration_minutes not in (None, "", "null"):
        expires_at = datetime.datetime.now() + datetime.timedelta(minutes=int(duration_minutes))

    existing = self.db.getFilters("account_suspension", ["account", "=", account_id])
    if existing:
        self.db.edit("account_suspension", existing[0]["id"], "reason", str(reason).strip())
        self.db.edit("account_suspension", existing[0]["id"], "suspended_by", uid)
        self.db.edit("account_suspension", existing[0]["id"], "expires_at", expires_at)
    else:
        self.db.insertDict("account_suspension", {
            "account": account_id, "reason": str(reason).strip(),
            "suspended_by": uid, "expires_at": expires_at,
        })

    # Force-disconnect any live WS sessions so the suspension bites immediately.
    self.forceDisconnectUser(account_id, {
        "type": "account_suspended",
        "content": {"reason": str(reason).strip(),
                    "expires_at": str(expires_at) if expires_at else None},
    })

    self.logPlatform(uid, "suspend_user", target_account=account_id, reason=str(reason).strip(),
                     metadata={"expires_at": str(expires_at) if expires_at else None})
    return json.dumps({"ok": True, "expires_at": str(expires_at) if expires_at else None})


@Server.expose
def unsuspend_user(self, account_id):
    uid = self.getUser()
    if not self.isAdmin(uid):
        raise HTTPError(self.response, 403)
    account_id = int(account_id)

    rows = self.db.getFilters("account_suspension", ["account", "=", account_id]) or []
    for row in rows:
        self.db.deleteSomething("account_suspension", row["id"])
    self.logPlatform(uid, "unsuspend_user", target_account=account_id)
    return json.dumps({"ok": True})


@Server.expose
def platform_delete_message(self, message_id, reason):
    uid = self.getUser()
    if not self.isAdmin(uid):
        raise HTTPError(self.response, 403)

    message = self.db.getSomething("message", int(message_id))
    if not message:
        raise HTTPError(self.response, 404, "message not found")

    sender = message["sender"]
    place = message["place"]
    channel = self.db.getSomething("textual_channel", place)

    # Same cleanup path as delete_message, but no sender/permission check.
    self.deleteMessageWithCleanup(message)

    del_notif = {"type": "message_deleted", "content": {"id": int(message_id)}}
    if channel:
        members = self.db.getFilters("accessserver", ["server", "=", channel["server"]]) or []
        for m in members:
            self.sendNotification(m["account"], del_notif)
    else:
        members = self.db.getAll("accessconversation", place, "conversation") or []
        for m in members:
            self.sendNotification(m["account"], del_notif)

    self.logPlatform(uid, "delete_message", target_account=sender,
                     target_server=channel["server"] if channel else None,
                     reason=reason, metadata={"message_id": int(message_id)})
    return json.dumps({"ok": True})


@Server.expose
def platform_delete_server(self, server_id, reason):
    uid = self.getUser()
    if not self.isAdmin(uid):
        raise HTTPError(self.response, 403)
    server_id = int(server_id)

    server = self.db.getSomething("server", server_id)
    if not server:
        raise HTTPError(self.response, 404, "server not found")

    # Mirrors delete_server's cascade + personal-quota refund, minus the
    # owner-only guard (ops bypass it by design).
    personal = self.db.getFilters("personal_server", ["server", "=", server_id])
    if personal:
        if server.get("storage_usage", 0) > 0:
            self._adjustUserStorage(personal[0]["owner"], -server["storage_usage"])

    self.db.deleteSomething("server", server_id)
    self.logPlatform(uid, "delete_server", target_server=server_id, reason=reason,
                     metadata={"name": server.get("name")})
    return json.dumps({"ok": True})


@Server.expose
def get_platform_action_log(self, limit=50, before=None):
    uid = self.getUser()
    if not self.isAdmin(uid):
        raise HTTPError(self.response, 403)

    lim = max(1, min(int(limit), 200))
    with self.db.pool.connection() as conn:
        if before:
            rows = conn.execute(
                "SELECT * FROM platform_action_log WHERE id < %s ORDER BY id DESC LIMIT %s",
                (int(before), lim)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM platform_action_log ORDER BY id DESC LIMIT %s",
                (lim,)).fetchall()

    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "moderator": r["moderator"],
            "moderator_name": _account_label(self, r["moderator"]),
            "action": r["action"],
            "target_account": r.get("target_account"),
            "target_name": _account_label(self, r["target_account"]) if r.get("target_account") else None,
            "target_server": r.get("target_server"),
            "reason": r.get("reason"),
            "metadata": r.get("metadata"),
            "created_at": str(r["created_at"]) if r.get("created_at") else None,
        })
    return json.dumps(out, default=str)
