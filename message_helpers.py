"""Message display-enrichment and notification helpers shared between the
messaging/conversation/server route modules and forumManager.

Module-level functions taking the live Mycelium instance as ``self``; they call
back into class methods (db access, checkChannelAccess, sendPushNotification,
_sheet_ref, _get_sheet_col_widths) via ``self``.
"""
import json
import re
import datetime


def notifyConvMessage(self,uid ,conv, message):
    members = self.db.getAll("accessconversation", conv["id"], "conversation")
    sender = self.db.getSomething("mycelium_account", uid)
    sender_name = sender.get("display", "User") if sender else "User"
    sender_pfp = sender.get("pfp") if sender else None
    avatar_url = f"https://mycelium.carbonlab.dev/static/attachments/{sender_pfp}" if sender_pfp else ""

    for user in members:
        if user["account"] != uid:
            self.sendNotification(user["account"], {"type": "message", "content": message})

            # Push Notification for DM
            self.sendPushNotification(user["account"], {
                "title": sender_name,
                "body": message.get("body", "New message"),
                "data": {"type": "message", "convId": str(conv["id"]), "avatarUrl": avatar_url}
            })

            notif  = self.db.getFilters("offline_notifs", ["account", "=", user['account'], "and", "conversation", "=", conv["id"]])
            if notif != []:
                self.db.edit("offline_notifs", notif[0]["id"], "number", notif[0]["number"] + 1)
            else :
                self.db.insertDict("offline_notifs", {"account": user['account'] , "conversation": conv["id"]})


def _parseAttachments(message):
    atts = message.get("attachments") or []
    if isinstance(atts, str):
        try: atts = json.loads(atts)
        except: atts = []
    return atts if isinstance(atts, list) else []


def is_system_message(message):
    return any(isinstance(a, dict) and a.get("type") == "system" for a in _parseAttachments(message))


def _lookupMessagePlace(self, place_id):
    """(channel, channel_type) of a message place, WITHOUT any permission check:
    a textual channel, the forum of a forum post, the vocal channel of a vocal
    chat, or (None, None) for a conv.

    Every place inherits conversationElement (one id sequence), so one query says
    which table holds the id (and the forum / vocal channel above it): a DM costs a
    single SELECT instead of a miss per channel table — typing calls this per keystroke."""
    try:
        place_id = int(place_id)
    except (TypeError, ValueError):
        return None, None
    with self.db.pool.connection() as conn:
        row = conn.execute(
            "SELECT ce.tableoid::regclass::text AS kind, COALESCE(fp.forum, vc.vocal) AS parent"
            " FROM conversationElement ce"
            " LEFT JOIN forum_post fp ON ce.tableoid = 'forum_post'::regclass AND fp.id = ce.id"
            " LEFT JOIN vocal_chat vc ON ce.tableoid = 'vocal_chat'::regclass AND vc.id = ce.id"
            " WHERE ce.id = %s LIMIT 1", (place_id,)).fetchone()
    kind = row["kind"] if row else None
    if kind == "textual_channel":
        return self.db.getSomething("textual_channel", place_id), "textual"
    if kind == "forum_post":
        return self.db.getSomething("forum_channel", row["parent"]), "forum"
    if kind == "vocal_chat":
        return self.db.getSomething("vocal_channel", row["parent"]), "vocal"
    return None, None


def notifyPlaceMembers(self, place_id, notif, exclude=None, place=None):
    """Send a WS notif about a message place to whoever can read it: the members
    who can view the channel (private channels, overwrites) or the conv's members.
    `place` is the (channel, channel_type) already resolved by the caller."""
    channel, channel_type = place if place is not None else _lookupMessagePlace(self, place_id)
    if channel:
        accounts = [a for a, rights in self.channelMembersRights(channel, channel_type).items()
                    if "view-channels" in rights]
    else:
        accounts = [m["account"] for m in self.db.getAll("accessconversation", place_id, "conversation") or []]
    for account in accounts:
        if account != exclude:
            self.sendNotification(account, notif)


def vocal_chat_place(self, vocal_id):
    """Message place id of a vocal channel's text chat, created on first use.
    Access control is the caller's job."""
    chat = self.db.getSomething("vocal_chat", vocal_id, "vocal")
    if not chat:
        # ON CONFLICT DO NOTHING (vesta insertDict): a concurrent first open just re-reads
        self.db.insertDict("vocal_chat", {"vocal": int(vocal_id)})
        chat = self.db.getSomething("vocal_chat", vocal_id, "vocal")
    return chat["id"]


def post_system_message(self, actor, place_id, kind, params, body, icon=None, place=None, notify_actor=False):
    """Post a system notification (dice roll, and later: call ended, member added, rename…)
    in a conv / channel / forum post, and broadcast it like a regular message.

    Stored as a plain `message` row whose attachments carry the marker
    {"type": "system", "kind", "icon", "params"}; the client builds the translated
    sentence from kind + params. `body` is a language-neutral fallback used by push
    notifications, search and previews.

    Access control is the caller's job. `place` is the (channel, channel_type) already
    resolved by the caller, looked up if omitted. The actor doesn't get the WS broadcast
    (send_message answers them over HTTP) unless `notify_actor` is set, which is what
    server-triggered events need."""
    attachments = json.dumps([{"type": "system", "kind": kind, "icon": icon, "params": params}])
    message = {"sender": actor, "place": place_id, "body": body, "attachments": attachments}
    message["id"] = self.db.insertDict("message", message, getId=True)

    channel, channel_type = place if place is not None else _lookupMessagePlace(self, place_id)
    if channel_type:
        notifyChannelMesage(self, actor, channel, message, channel_type)
    else:
        notifyConvMessage(self, actor, {"id": place_id}, message)
    if notify_actor:
        self.sendNotification(actor, {"type": "message", "content": message})
    return message


def notifyChannelMesage(self, uid, channel, message, channel_type="textual"):
    if channel:
        server_id = channel["server"]
        mention_targets = set()
        # Override / unread / mention rows are keyed by channel id. A vocal channel's id comes
        # from another sequence than message places (it could equal a text channel's), so
        # its chat is keyed by its own place id — the id the client reads and clears.
        key = message["place"] if channel_type == "vocal" else channel["id"]

        # Fetch prefs and the member list once; both are reused below.
        prefs_rows = self.db.getFilters("notification_pref", ["server", "=", server_id]) or []
        pref_level = {p["account"]: p["level"] for p in prefs_rows}
        suppress_everyone_for = {p["account"] for p in prefs_rows if p.get("suppress_everyone")}
        all_members = self.db.getFilters("accessserver", ["server", "=", server_id]) or []

        # Parse <@everyone> – notify all server members (respecting suppress_everyone pref)
        if "<@everyone>" in message["body"]:
            for m in all_members:
                if m["account"] not in suppress_everyone_for:
                    mention_targets.add(m["account"])

        # Parse <@here> – notify online server members (respecting suppress_everyone pref)
        if "<@here>" in message["body"]:
            for m in all_members:
                if m["account"] in suppress_everyone_for:
                    continue
                online = self.db.getSomething("active_client", m["account"], "userid")
                if online:
                    mention_targets.add(m["account"])

        # Parse <@&roleId> – notify all members with that role
        role_mentions = re.findall(r'<@&(\d+)>', message["body"])
        for role_id in role_mentions:
            role_members = self.db.getFilters("role_attribution", ["role", "=", int(role_id), "and", "server", "=", server_id])
            for rm in role_members:
                mention_targets.add(rm["account"])

        # Parse <@userId> – notify specific users (for explicit @user mentions)
        user_mentions = re.findall(r'<@(\d+)>', message["body"])
        for mentioned_uid in user_mentions:
            mention_targets.add(int(mentioned_uid))

        # Notify the author of the message being replied to
        if message.get("reply"):
            original = self.db.getSomething("message", message["reply"])
            if original and original.get("sender"):
                mention_targets.add(original["sender"])

        mention_targets.discard(uid)  # Don't notify the sender

        # Only members who can view the channel are notified or receive the message
        # (private channels, view overwrites; also drops @mentions of non-members).
        viewers = {account for account, rights in self.channelMembersRights(channel, channel_type).items()
                   if "view-channels" in rights}
        mention_targets &= viewers

        # Members' own settings for this channel and for its category (right-click menus):
        # muted by either, and a level set on the channel, else on the category, else the server's.
        now = datetime.datetime.now()
        with self.db.pool.connection() as conn:
            override_rows = conn.execute(
                "SELECT * FROM notification_override WHERE (target = %s AND NOT is_category) "
                "OR (target = %s AND is_category)", (key, channel.get("category") or -1)).fetchall()
        channel_muted_for = {
            o["account"] for o in override_rows
            if o["muted"] and (o["muted_until"] is None or o["muted_until"] > now)
        }
        channel_level = {o["account"]: o["level"] for o in override_rows if o["is_category"] and o["level"] is not None}
        channel_level.update({o["account"]: o["level"] for o in override_rows
                              if not o["is_category"] and o["level"] is not None})
        level_of = lambda account: channel_level.get(account, pref_level.get(account, 1))

        # Prefetch existing unread markers once so the broadcast loop below stays O(1)
        # per member instead of issuing a SELECT per member.
        already_unread = {
            r["account"] for r in (self.db.getFilters("channel_unread", ["channel", "=", key]) or [])
        }

        # Tag the broadcast with the server id so the frontend can tell a channel message
        # from a DM by the payload, instead of guessing from the rendered DOM (which only
        # exists for the server the user is currently viewing).
        message["server"] = server_id
        if channel_type == "vocal":
            message["vocal"] = channel["id"]

        # Muted / server-muted members never get offline notifs or a red badge,
        # even when directly @mentioned (matches Discord muting semantics).
        mention_targets = {t for t in mention_targets if level_of(t) != 2 and t not in channel_muted_for}

        # Broadcast the message to ALL server members (for live display in active channel views)
        notify_only = set()  # "All Messages" members: sound + push, but no red badge
        for m in all_members:
            member_uid = m["account"]
            if member_uid == uid:
                continue
            if member_uid not in viewers:
                continue
            self.sendNotification(member_uid, {"type": "message", "content": message})

            # A mute (channel or category) takes priority over the level
            if member_uid in channel_muted_for:
                continue

            level = level_of(member_uid)
            if level == 2:
                continue  # "nothing": no unread tracking or notifications

            # Track unread state for all non-muted members (the "white" unread marker).
            # Not for vocal chats yet: the sidebar has no unread marker for them.
            if channel_type != "vocal" and member_uid not in already_unread:
                self.db.insertDict("channel_unread", {"account": member_uid, "channel": key})
                already_unread.add(member_uid)

            # "All Messages" level: notify (sound + push) without a persistent red
            # mention badge, unless they were also actually @mentioned.
            if level == 0 and member_uid not in mention_targets:
                notify_only.add(member_uid)

        sender = self.db.getSomething("mycelium_account", uid)
        sender_name = sender.get("display", "Someone") if sender else "Someone"
        sender_pfp = sender.get("pfp") if sender else None
        avatar_url = f"https://mycelium.carbonlab.dev/static/attachments/{sender_pfp}" if sender_pfp else ""

        # Unified "message" push contract (repliable + threaded). serverId marks it as a
        # channel (a distinct thread id), channelType + channelId say which one a tap opens
        # (the client builds the route); groupTitle is the channel name.
        push_payload = {
            "title": sender_name,
            "body": message.get("body", "New message"),
            "data": {
                "type": "message",
                "convId": str(key),
                "serverId": str(server_id),
                "groupTitle": channel.get("name", "channel"),
                "avatarUrl": avatar_url,
                "channelType": channel_type,
                "channelId": str(channel["id"]),
            }
        }

        # Real @mentions: persistent offline notif + red badge (badge=True) + sound + push.
        for target_uid in mention_targets:
            notif = self.db.getFilters("offline_notifs", ["account", "=", target_uid, "and", "conversation", "=", key])
            if notif:
                self.db.edit("offline_notifs", notif[0]["id"], "number", notif[0]["number"] + 1)
            else:
                self.db.insertDict("offline_notifs", {"account": target_uid, "conversation": key})

            self.sendNotification(target_uid, {
                "type": "mention",
                "content": {"server_id": server_id, "channel_id": key, "badge": True}
            })
            self.sendPushNotification(target_uid, push_payload)

        # "All Messages" members: sound + push only (badge=False, no offline notif).
        for target_uid in notify_only:
            self.sendNotification(target_uid, {
                "type": "mention",
                "content": {"server_id": server_id, "channel_id": key, "badge": False}
            })
            self.sendPushNotification(target_uid, push_payload)


def _enrichMessagesWithPolls(self, messages, uid):
    """Enrich messages that have poll attachments with full poll data."""
    for msg in messages:
        attachments = msg.get("attachments")
        if attachments:
            if isinstance(attachments, str):
                try:
                    attachments = json.loads(attachments)
                except:
                    continue
            for att in attachments:
                if isinstance(att, dict) and att.get("type") == "poll":
                    poll = self.db.getSomething("poll", att["pollId"])
                    if poll:
                        options = self.db.getAll("poll_option", poll["id"], "poll")
                        votes = self.db.getAll("poll_vote", poll["id"], "poll")
                        # Build votes dict: {option_id: [voter_ids]}
                        votes_dict = {}
                        for v in votes:
                            oid = v["option"]
                            if oid not in votes_dict:
                                votes_dict[oid] = []
                            votes_dict[oid].append(v["voter"])
                        msg["poll"] = {
                            "id": poll["id"],
                            "question": poll["question"],
                            "multiple_choice": poll["multiple_choice"],
                            "allow_user_options": poll["allow_user_options"],
                            "options": [{"id": o["id"], "text": o["text"], "creator": o["creator"]} for o in options],
                            "votes": {str(k): v for k, v in votes_dict.items()}
                        }


def _enrichMessagesWithReactions(self, messages):
    for msg in messages:
        reactions = self.db.getAll("message_reaction", msg["id"], "message")
        reactions_dict = {}
        for r in reactions:
            emoji = r["emoji"]
            if emoji not in reactions_dict:
                reactions_dict[emoji] = []
            reactions_dict[emoji].append(r["account"])
        msg["reactions"] = reactions_dict


def _enrichMessagesWithConvBlocks(self, messages):
    for msg in messages:
        atts = msg.get("attachments") or []
        if isinstance(atts, str):
            try: atts = json.loads(atts)
            except: atts = []
        if not isinstance(atts, list):
            atts = []
        for att in atts:
            if isinstance(att, dict) and att.get("type") == "conv_spreadsheet":
                sheet = self.db.getSomething("note_spreadsheet", att["uuid"], "block_uuid")
                if sheet:
                    cells_data = self.db.getFilters("note_spreadsheet_cell",
                        ["spreadsheet_id", "=", sheet["id"]]) or []
                    cells = {self._sheet_ref(c["col_idx"], c["row_idx"]): c["value"]
                             for c in cells_data}
                    col_widths = self._get_sheet_col_widths(sheet["id"])
                    msg["convSpreadsheet"] = {
                        "uuid": sheet["block_uuid"], "id": sheet["id"],
                        "rows": sheet["rows"], "cols": sheet["cols"],
                        "cells": cells, "col_widths": col_widths
                    }
