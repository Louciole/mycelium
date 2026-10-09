"""User-account endpoints: identity/profile, friends & blocks, additional
emails, device push tokens, and personal API keys.

All functions take the live ``Mycelium`` instance as ``self`` and rely on
methods that remain on the class (``getUser``, ``getUsersStatus``, ``isAdmin``,
``sendNotification``, ``sendStatusUpdates``, ``saveFile``, ``db``, ``uniauth``).
"""
import json
import re
import random
import datetime

from vesta import Server, HTTPError
from constants import B62, USER_STORAGE_QUOTA

# Username rule: >=3 chars, letters/digits/underscore/dash/dot only.
REGEX_USERNAME = re.compile(r'^(?=.{3,}$)[a-zA-Z0-9_\-\.]*$')


# ------------------------------- devices -----------------------------------

@Server.expose
def register_device(self, token, platform='android'):
    """
    Register a mobile device push token.
    Called by the Capacitor app when it receives a FCM / APNs token.

    POST body (JSON): { "token": "...", "platform": "ios" | "android" }
    """
    uid = self.getUser()
    token = (token or '').strip()
    platform = (platform or 'android').strip()[:10]

    if not token:
        raise HTTPError(self.response, 400, "Missing token")

    # Upsert: update timestamp if token already exists for this account
    existing = self.db.getFilters("device_token", [
        "account", "=", uid, "AND", "token", "=", token
    ])
    if existing:
        self.db._do(lambda conn: conn.execute(
            "UPDATE device_token SET updated_at = NOW(), platform = %s WHERE account = %s AND token = %s",
            (platform, uid, token)
        ))
    else:
        self.db.insertDict("device_token", {
            "account": uid,
            "token": token,
            "platform": platform,
        })

    return json.dumps({"status": "ok"})


@Server.expose
def unregister_device(self, token=''):
    """
    Remove a device token when the user logs out.
    POST body (JSON): { "token": "..." }
    """
    uid = self.getUser()
    token = (token or '').strip()
    if token:
        self.db._do(lambda conn: conn.execute(
            "DELETE FROM device_token WHERE account = %s AND token = %s",
            (uid, token)
        ))
    return json.dumps({"status": "ok"})


# ----------------------------- identity ------------------------------------

@Server.expose
def get_users_info(self, users):
    uid = self.getUser()
    users = self.db.getFilters("mycelium_account", ["id", "in", json.loads(users)])
    self.getUsersStatus(users)
    return json.dumps(users, default=str)


@Server.expose
def get_user_info(self):
    uid = self.getUser()
    user = self.db.getSomething("mycelium_account", uid)
    self.getUsersStatus([user], detailed=True)
    user["channel_unreads"] = self.db.getAll("channel_unread", uid, "account") or []
    # Split offline notifs: DM notifs become standalone first-column bubbles, while
    # channel mentions only feed the per-server badge (never a separate notif bubble —
    # those are exclusively for DMs).
    all_notifs = self.db.getAll("offline_notifs", uid, "account") or []
    dm_notifs = []
    server_mention_counts = {}
    for notif in all_notifs:
        # A first-column bubble is only valid for a real DM/group conversation.
        if self.db.getSomething("conversation", notif["conversation"]):
            dm_notifs.append(notif)
            continue
        # Otherwise it's a channel mention → feed the per-server badge instead of
        # rendering a broken standalone bubble. (Forum/other channels just drop here.)
        ch = self.db.getSomething("textual_channel", notif["conversation"])
        if ch:
            sid = str(ch["server"])
            server_mention_counts[sid] = server_mention_counts.get(sid, 0) + notif["number"]
    user["notifs"] = dm_notifs
    user["server_mention_counts"] = server_mention_counts
    # Per-server unread flag: how many channels in each server have unread messages
    # (mention or not) — drives the small white indicator on the server icon.
    server_unread = {}
    for cu in user["channel_unreads"]:
        ch = self.db.getSomething("textual_channel", cu["channel"])
        if ch:
            sid = str(ch["server"])
            server_unread[sid] = server_unread.get(sid, 0) + 1
    user["server_unread"] = server_unread
    prefs = self.db.getAll("notification_pref", uid, "account")
    user["notif_prefs"] = {str(p["server"]): {"level": p["level"], "suppress_everyone": p["suppress_everyone"]} for p in prefs} if prefs else {}
    mutes = self.db.getAll("channel_mute", uid, "account")
    user["channel_mutes"] = [{"channel": m["channel"], "muted_until": str(m["muted_until"]) if m["muted_until"] else None} for m in mutes] if mutes else []
    # Active server timeouts ({server_id: expires_at}) so the composer lock
    # survives a reload (static/moderation.mjs → updateComposerLock).
    user["server_timeouts"] = {}
    for t in self.db.getAll("server_timeout", uid, "account") or []:
        if self.activeServerTimeout(uid, t["server"]):
            user["server_timeouts"][str(t["server"])] = str(t["expires_at"]) if t["expires_at"] else None
    user["additional_emails"] = self.uniauth.getAll("additional_mail", uid, "account")
    user["isAdmin"] = self.isAdmin(uid)
    user["storage_quota"] = USER_STORAGE_QUOTA
    return json.dumps(user, default=str)


@Server.expose
def set_server_notif_pref(self, server_id, level=None, suppress_everyone=None):
    uid = self.getUser()
    if level is not None:
        level = int(level)
        if level not in (0, 1, 2):
            raise HTTPError(self.response, 400, "invalid level")
    existing = self.db.getFilters("notification_pref", ["account", "=", uid, "and", "server", "=", int(server_id)])
    if existing:
        row_id = existing[0]["id"]
        if level is not None:
            self.db.edit("notification_pref", row_id, "level", level)
        if suppress_everyone is not None:
            self.db.edit("notification_pref", row_id, "suppress_everyone", suppress_everyone == "true")
    else:
        row = {"account": uid, "server": int(server_id)}
        if level is not None:
            row["level"] = level
        if suppress_everyone is not None:
            row["suppress_everyone"] = suppress_everyone == "true"
        self.db.insertDict("notification_pref", row)
    return json.dumps({"ok": True})


# --------------------------- friends & blocks ------------------------------

@Server.expose
def block_user(self, user_id):
    uid = self.getUser()
    if self.db.getFilters("blockship", ["blocker", "=", uid, "and", "blocked", "=", user_id]):
        return json.dumps({"status": "already_blocked"})
    block_id = self.db.insertDict("blockship", {"blocker": uid, "blocked": user_id}, getId=True)
    return json.dumps({"status": "ok", "id": block_id})


@Server.expose
def add_friend(self, username):
    uid = self.getUser()
    friend = self.db.getSomething("mycelium_account", username, "username")
    if not friend:
        return json.dumps({"error": "user not found"})
    if friend['id'] == uid:
        return json.dumps({"error": "You can't add yourself as a friend"})

    friendship = self.db.getFilters("boatakopin",
                                    ["kopinprincipal", "=", uid, "and", "kopinsecondaire", "=", friend['id'],
                                     ") or (", "kopinprincipal", "=", friend['id'], "and", "kopinsecondaire",
                                     "=", uid, ')'], "(")
    if friendship:
        return json.dumps({"error": "already friends or invitation already sent"})

    request = {"kopinprincipal": uid, "kopinsecondaire": friend['id'], "accepted": False}
    request["id"] = self.db.insertDict("boatakopin", request, True)
    self.sendNotification(friend['id'], {"type": "friend_request", "content": request})
    return json.dumps({"status": "ok"})


@Server.expose
def accept_friend(self, invitation_id):
    uid = self.getUser()
    friendship = self.db.getFilters("boatakopin", ["id", "=", invitation_id, "and", "kopinsecondaire", "=", uid])
    if friendship:
        self.db.edit("boatakopin", invitation_id, "accepted", True)
        conv_id = self.db.insertDict('conversation', {'name': ""}, getId=True)
        self.db.insertDict('accessconversation', {'account': uid, 'conversation': conv_id})
        self.db.insertDict('accessconversation',
                           {'account': friendship[0]["kopinprincipal"], 'conversation': conv_id})
        self.db.edit("boatakopin", invitation_id, "conv", conv_id)

        friendship[0]["conv"] = conv_id
        self.sendNotification(friendship[0]["kopinprincipal"], {"type": "accepted_request", "content": friendship[0]})

        conv = {"id": conv_id, "name": "", "members": [uid, friendship[0]["kopinprincipal"]], "private": True}
        self.sendNotification(uid, {"type": "added_conv", "content": conv})
        self.sendNotification(friendship[0]["kopinprincipal"], {"type": "added_conv", "content": conv})
        return json.dumps({"status": "ok", "conv": conv_id})
    raise HTTPError(self.response, 403, "forbidden")


@Server.expose
def get_friends(self):
    uid = self.getUser()
    friends = self.db.getFilters("boatakopin",
                                 ["accepted", "=", True, "and (", "kopinprincipal", "=", uid, "or",
                                  "kopinsecondaire", "=", uid, ")"])
    return json.dumps(friends)


@Server.expose
def get_blocked(self):
    uid = self.getUser()
    enemies = self.db.getAll("blockship", uid, "blocker")
    return json.dumps(enemies)


@Server.expose
def get_friend_invitations(self):
    uid = self.getUser()
    invitations = self.db.getFilters("boatakopin",
                                     ["accepted", "=", False, "and (", "kopinprincipal", "=", uid, "or",
                                      "kopinsecondaire", "=", uid, ")"])
    return json.dumps(invitations)


@Server.expose
def remove_friend(self, friendship_id):
    uid = self.getUser()
    friendship = self.db.getSomething("boatakopin", friendship_id)
    if friendship and friendship["accepted"] and (friendship["kopinprincipal"] == uid or friendship["kopinsecondaire"] == uid):
        self.db.deleteSomething("boatakopin", friendship_id)
        return json.dumps({"status": "ok"})
    raise HTTPError(self.response, 403, "forbidden")


# ------------------------------- profile -----------------------------------

@Server.expose
def change_username(self, value):
    uid = self.getUser()
    if re.fullmatch(REGEX_USERNAME, value):
        if not self.db.getSomething("mycelium_account", value, "username"):
            self.db.edit("mycelium_account", uid, "username", value)
            return json.dumps({"status": "ok"})
        else:
            return json.dumps({"error": "this username already exists"})
    return json.dumps({"error": "invalid username"})


@Server.expose
def change_status(self, value):
    uid = self.getUser()
    status = json.loads(value)
    self.db.edit("status", uid, "mode", status["mode"])
    self.db.edit("status", uid, "text", status["text"])
    self.db.edit("status", uid, "emoji", status["emoji"])
    if status["expiration"]:
        self.db.edit("status", uid, "expiration", status["expiration"])
    else:
        self.db.edit("status", uid, "expiration", None)
    self.sendStatusUpdates(uid)
    return json.dumps({"status": "ok"})


@Server.expose
def change_pfp(self, value):
    uid = self.getUser()
    filename = self.saveFile(value)
    self.db.edit("mycelium_account", uid, "pfp", filename)
    return json.dumps({"pfp": filename}, default=str)


@Server.expose
def change_banner(self, value):
    uid = self.getUser()
    filename = self.saveFile(value)
    self.db.edit("mycelium_account", uid, "banner", filename)
    return json.dumps({"banner": filename}, default=str)


@Server.expose
def change_profile(self, element, value):
    uid = self.getUser()
    allowed = ("display", "pronouns", "description", "faction", "pfp", "banner")
    if element not in allowed:
        return json.dumps({"error": "forbidden"})
    self.db.edit("mycelium_account", uid, element, value)
    return json.dumps({"status": "ok"})


# ----------------------------- emails --------------------------------------

@Server.expose
def add_email(self, email):
    uid = self.getUser()

    # Basic email validation
    email = email.strip().lower()
    if not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', email):
        return json.dumps({"error": "Invalid email address"})

    # Check if email already exists in main accounts
    existing_user = self.uniauth.getUserCredentials(email)
    if existing_user:
        return json.dumps({"error": "This email is already registered to an account"})

    # Check if email already exists in additional emails
    existing_additional = self.uniauth.getSomething("additional_mail", email, "email")
    if existing_additional:
        return json.dumps({"error": "This email is already added to an account"})

    # Insert the new email
    email_id = self.uniauth.insertDict("additional_mail", {
        "account": uid,
        "email": email
    }, getId=True)

    return json.dumps({"id": email_id, "email": email, "account": uid})


@Server.expose
def remove_email(self, email_id):
    uid = self.getUser()

    # Check if the email belongs to the current user
    email_entry = self.uniauth.getSomething("additional_mail", email_id)
    if not email_entry or email_entry["account"] != uid:
        return json.dumps({"error": "Email not found or access denied"})

    # Delete the email
    self.uniauth.deleteSomething("additional_mail", email_id)

    return json.dumps({"success": True})


# ----------------------------- API keys ------------------------------------

@Server.expose
def create_api_key(self, name="", permissions="[]"):
    """Create a new API key for the authenticated user."""
    uid = self.getUser()
    try:
        if isinstance(permissions, str):
            permissions_parsed = json.loads(permissions)
        else:
            permissions_parsed = permissions
    except Exception:
        permissions_parsed = []

    new_key = ''.join(random.choices(B62, k=40))
    while self.db.getSomething("api_key", new_key, "key"):
        new_key = ''.join(random.choices(B62, k=40))

    key_id = self.db.insertDict("api_key", {"key": new_key, "owner": uid, "name": name}, getId=True)
    created = datetime.datetime.now()

    resp = {"id": key_id, "name": name, "key": new_key, "created": str(created), "permissions": permissions_parsed}
    return json.dumps(resp)


@Server.expose
def revoke_api_key(self, key_id):
    """Revoke (delete) an API key by its id. Only the owner can revoke their key."""
    uid = self.getUser()
    keyrow = self.db.getSomething("api_key", key_id)
    if not keyrow:
        raise HTTPError(self.response, 404, "Not Found")
    if keyrow.get("owner") != uid:
        raise HTTPError(self.response, 403, "forbidden")

    self.db.deleteSomething("api_key", key_id)
    return json.dumps({"status": "ok"})


@Server.expose
def regenerate_api_key(self, key_id):
    """Generate a new key value for an existing API key entry. Only the owner may regenerate."""
    uid = self.getUser()
    keyrow = self.db.getSomething("api_key", key_id)
    if not keyrow:
        raise HTTPError(self.response, 404, "Not Found")
    if keyrow.get("owner") != uid:
        raise HTTPError(self.response, 403, "forbidden")

    new_key = ''.join(random.choices(B62, k=40))
    while self.db.getSomething("api_key", new_key, "key"):
        new_key = ''.join(random.choices(B62, k=40))

    self.db.edit("api_key", key_id, "key", new_key)
    return json.dumps({"key": new_key})


@Server.expose
def get_user_api_keys(self):
    """Return the API keys for the authenticated user."""
    uid = self.getUser()
    keys = self.db.getAll("api_key", uid, "owner")
    for k in keys:
        if 'key' in k:
            k.pop('key')
    return json.dumps(keys, default=str)
