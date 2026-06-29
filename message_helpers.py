"""Message display-enrichment and notification helpers shared between the
messaging/conversation/server route modules and forumManager.

Module-level functions taking the live Mycelium instance as ``self``; they call
back into class methods (db access, checkChannelAccess, sendPushNotification,
_sheet_ref, _get_sheet_col_widths) via ``self``.
"""
import json
import re
import datetime


def notifyChannelMesage(self, uid, channel, message, channel_type="textual"):
    if channel:
        server_id = channel["server"]
        mention_targets = set()

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

        # For private channels, filter targets to only those who can view the channel
        if channel.get("is_private"):
            mention_targets = {t for t in mention_targets if self.checkChannelAccess(t, channel["id"], channel_type, "view")}

        # Fetch channel mutes for this channel
        now = datetime.datetime.now()
        mute_rows = self.db.getFilters("channel_mute", ["channel", "=", channel["id"]]) or []
        channel_muted_for = {
            m["account"] for m in mute_rows
            if m["muted_until"] is None or m["muted_until"] > now
        }

        # Prefetch existing unread markers once so the broadcast loop below stays O(1)
        # per member instead of issuing a SELECT per member.
        already_unread = {
            r["account"] for r in (self.db.getFilters("channel_unread", ["channel", "=", channel["id"]]) or [])
        }

        # Tag the broadcast with the server id so the frontend can tell a channel message
        # from a DM by the payload, instead of guessing from the rendered DOM (which only
        # exists for the server the user is currently viewing).
        message["server"] = server_id

        # Muted / server-muted members never get offline notifs or a red badge,
        # even when directly @mentioned (matches Discord muting semantics).
        mention_targets = {t for t in mention_targets if pref_level.get(t, 1) != 2 and t not in channel_muted_for}

        # Broadcast the message to ALL server members (for live display in active channel views)
        notify_only = set()  # "All Messages" members: sound + push, but no red badge
        for m in all_members:
            member_uid = m["account"]
            if member_uid == uid:
                continue
            # Skip private channel members without access
            if channel.get("is_private") and not self.checkChannelAccess(member_uid, channel["id"], channel_type, "view"):
                continue
            self.sendNotification(member_uid, {"type": "message", "content": message})

            # Channel mute takes priority over server-level pref
            if member_uid in channel_muted_for:
                continue

            level = pref_level.get(member_uid, 1)
            if level == 2:
                continue  # server muted: no unread tracking or notifications

            # Track unread state for all non-muted members (the "white" unread marker)
            if member_uid not in already_unread:
                self.db.insertDict("channel_unread", {"account": member_uid, "channel": channel["id"]})
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
        # channel (drives navigation + a distinct thread id); groupTitle is the channel name.
        push_payload = {
            "title": sender_name,
            "body": message.get("body", "New message"),
            "data": {
                "type": "message",
                "convId": str(channel["id"]),
                "serverId": str(server_id),
                "groupTitle": channel.get("name", "channel"),
                "avatarUrl": avatar_url,
            }
        }

        # Real @mentions: persistent offline notif + red badge (badge=True) + sound + push.
        for target_uid in mention_targets:
            notif = self.db.getFilters("offline_notifs", ["account", "=", target_uid, "and", "conversation", "=", channel["id"]])
            if notif:
                self.db.edit("offline_notifs", notif[0]["id"], "number", notif[0]["number"] + 1)
            else:
                self.db.insertDict("offline_notifs", {"account": target_uid, "conversation": channel["id"]})

            self.sendNotification(target_uid, {
                "type": "mention",
                "content": {"server_id": server_id, "channel_id": channel["id"], "badge": True}
            })
            self.sendPushNotification(target_uid, push_payload)

        # "All Messages" members: sound + push only (badge=False, no offline notif).
        for target_uid in notify_only:
            self.sendNotification(target_uid, {
                "type": "mention",
                "content": {"server_id": server_id, "channel_id": channel["id"], "badge": False}
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
