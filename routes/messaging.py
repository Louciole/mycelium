"""Messages, edits/deletes, reactions and polls.

Endpoints take the live Mycelium instance as ``self``; shared helpers remain on
the class (see server.py).
"""
import json
import datetime
import secrets

from vesta import Server, HTTPError
from message_helpers import notifyChannelMesage, notifyConvMessage, post_system_message, is_system_message, _lookupMessagePlace

DICE_MAX_COUNT = 20
DICE_MIN_FACES, DICE_MAX_FACES = 2, 1000


@Server.expose
def send_message(self, conv, content, reply=False, attachments = [], poll=None, conv_block=None, command=None):
    uid = self.getUser()

    conv = json.loads(conv)
    if not conv.get("id"):
        conv["id"] = self.newConv("Noname", [uid, conv["dest"]])

    # Check the right to post BEFORE writing anything (files, message rows)
    channel, channel_type = _resolveMessagePlace(self, uid, conv)

    # Slash command the server runs itself (the client expands the pure text ones).
    # Validated now so an invalid one leaves nothing behind; run once the message is posted.
    dice = _parseDiceCommand(self, command) if command else None

    total_attachment_size = sum(
        self._estimateBase64Size(a.get('dataUrl', ''))
        for a in attachments if a.get('dataUrl')
    )
    if total_attachment_size > 0:
        if channel:
            self._checkQuota(channel["server"], total_attachment_size)
        else:
            self._checkUserQuota(uid, total_attachment_size)

    attachmentList = []
    for attachment in attachments:
        filepath = self.saveFile(attachment.get('dataUrl', ''))
        attachmentList.append({"mime": attachment.get('mimeType', ''), "filename": attachment.get('filename', 'file'), "filepath": filepath})

    # Handle poll creation
    if poll:
        question = poll.get("question", "").strip()
        options = poll.get("options", [])
        if not question:
            raise HTTPError(self.response, 400, "Poll requires a question")
        multiple_choice = bool(poll.get("multipleChoice", False))
        allow_user_options = bool(poll.get("allowUserOptions", False))

        # Insert message with empty body for polls
        message = {"sender": uid, "place": conv["id"], "body": "", "attachments": "[]"}
        if reply and reply != "undefined" and reply != "null":
            message["reply"] = reply
        msgId = self.db.insertDict("message", message, getId=True)
        message["id"] = msgId

        # Insert poll
        pollId = self.db.insertDict("poll", {
            "message": msgId,
            "question": question,
            "multiple_choice": multiple_choice,
            "allow_user_options": allow_user_options
        }, getId=True)

        # Insert poll options
        poll_options = []
        for opt_text in options:
            opt_text = opt_text.strip()
            if opt_text:
                optId = self.db.insertDict("poll_option", {
                    "poll": pollId,
                    "text": opt_text,
                    "creator": uid
                }, getId=True)
                poll_options.append({"id": optId, "text": opt_text, "creator": uid})

        # Store poll reference as attachment
        pollAttachment = [{"type": "poll", "pollId": pollId}]
        self.db.edit("message", msgId, "attachments", json.dumps(pollAttachment))
        message["attachments"] = json.dumps(pollAttachment)

        # Enrich message with poll data for notifications
        message["poll"] = {
            "id": pollId,
            "question": question,
            "multiple_choice": multiple_choice,
            "allow_user_options": allow_user_options,
            "options": poll_options,
            "votes": {}
        }

        if channel_type:
            notifyChannelMesage(self, uid, channel, message, channel_type)
        else:
            notifyConvMessage(self, uid, conv, message)

        return json.dumps({"message": message}, default=str)

    # Handle conv block (spreadsheet) creation
    if conv_block:
        import uuid as _uuid
        block_type = conv_block.get("type", "")
        template   = conv_block.get("template", "empty")
        if block_type != "spreadsheet":
            raise HTTPError(self.response, 400, "Unsupported block type")

        block_uuid = str(_uuid.uuid4())
        msg_body = {"sender": uid, "place": conv["id"], "body": "", "attachments": "[]"}
        if reply and reply != "undefined" and reply != "null":
            msg_body["reply"] = reply
        msg_id = self.db.insertDict("message", msg_body, getId=True)
        msg_body["id"] = msg_id

        rows, cols = 5, 3
        sheet_id = self.db.insertDict("note_spreadsheet", {
            "block_uuid": block_uuid,
            "conv_id": conv["id"],
            "message_id": msg_id,
            "rows": rows,
            "cols": cols
        }, getId=True)

        cells = {}
        if template == "tricount":
            for i, header in enumerate(["Name", "Amount", "Paid By"]):
                self.db.insertDict("note_spreadsheet_cell", {
                    "spreadsheet_id": sheet_id,
                    "row_idx": 1,
                    "col_idx": i,
                    "value": header
                })
                cells[self._sheet_ref(i, 1)] = header

        attachment = [{"type": "conv_spreadsheet", "uuid": block_uuid}]
        self.db.edit("message", msg_id, "attachments", json.dumps(attachment))
        msg_body["attachments"]     = json.dumps(attachment)
        msg_body["convSpreadsheet"] = {
            "uuid": block_uuid, "id": sheet_id,
            "rows": rows, "cols": cols, "cells": cells, "col_widths": {}
        }

        if channel_type:
            notifyChannelMesage(self, uid, channel, msg_body, channel_type)
        else:
            notifyConvMessage(self, uid, conv, msg_body)

        return json.dumps({"message": msg_body}, default=str)

    if dice and not content.strip():
        content = f"/d {dice[0]}d{dice[1]}"   # keep the command visible in the conversation
    message = {"sender": uid, "place": conv["id"], "body": content, "attachments": json.dumps(attachmentList)}
    if reply and reply != "undefined" and reply != "null":
        message["reply"] = reply

    msgId = self.db.insertDict("message", message, getId=True)
    message["id"] = msgId

    if channel_type:
        notifyChannelMesage(self, uid, channel, message, channel_type)
        if total_attachment_size > 0:
            self._adjustStorage(channel["server"], total_attachment_size)
    else:
        notifyConvMessage(self, uid, conv, message)
        if total_attachment_size > 0:
            self._adjustUserStorage(uid, total_attachment_size)

    # Return the saved message (with its real DB id) so the client can reconcile
    # its optimistic placeholder. ``attachments`` is the JSON string stored in DB.
    response = {"message": message}
    if dice:
        # Posted after the "/d 6" message so everyone sees the command then its result
        response["notice"] = _rollDice(self, uid, conv["id"], (channel, channel_type), *dice)
    return json.dumps(response, default=str)


@Server.expose
def mute_channel(self, channel_id, minutes=None):
    uid = self.getUser()
    muted_until = None
    if minutes is not None:
        muted_until = datetime.datetime.now() + datetime.timedelta(minutes=int(minutes))
    existing = self.db.getFilters("channel_mute", ["account", "=", uid, "and", "channel", "=", int(channel_id)])
    if existing:
        self.db.edit("channel_mute", existing[0]["id"], "muted_until", muted_until)
    else:
        self.db.insertDict("channel_mute", {"account": uid, "channel": int(channel_id), "muted_until": muted_until})
    return json.dumps({"ok": True, "muted_until": str(muted_until) if muted_until else None})


@Server.expose
def unmute_channel(self, channel_id):
    uid = self.getUser()
    rows = self.db.getFilters("channel_mute", ["account", "=", uid, "and", "channel", "=", int(channel_id)])
    for row in rows:
        self.db.deleteSomething("channel_mute", row["id"])


@Server.expose
def mark_channel_read(self, channel_id):
    uid = self.getUser()
    cid = int(channel_id)
    rows = self.db.getFilters("channel_unread", ["account", "=", uid, "and", "channel", "=", cid])
    for row in rows:
        self.db.deleteSomething("channel_unread", row["id"])
    # Reading a channel also clears its mention notifications (Discord-style), so the
    # server's red badge drops by however many mentions were pending in this channel.
    mentions_cleared = 0
    notif_rows = self.db.getFilters("offline_notifs", ["account", "=", uid, "and", "conversation", "=", cid]) or []
    for n in notif_rows:
        mentions_cleared += n.get("number", 1)
        self.db.deleteSomething("offline_notifs", n["id"])
    return json.dumps({"ok": True, "mentions_cleared": mentions_cleared})


@Server.expose
def consult_notifs(self, notif_id):
    uid = self.getUser()
    if not self.db.getFilters("offline_notifs", ["account", "=", uid, "and", "id", "=", notif_id]):
        raise HTTPError(self.response, 403, "forbidden")
    self.db.deleteSomething("offline_notifs", notif_id)


@Server.expose
def edit_message(self, message_id, content):
    uid = self.getUser()

    message = self.db.getSomething("message", message_id)

    if not message or message["sender"] != uid:
        raise HTTPError(self.response, 403, "forbidden")
    if is_system_message(message):
        raise HTTPError(self.response, 403, "system messages can't be edited")
    # A timed-out member can't rewrite their messages either
    channel, _ = _lookupMessagePlace(self, message["place"])
    if channel:
        self.enforceNotTimedOut(uid, channel["server"])

    self.db.edit("message", message["id"], "body", content)
    self.db.edit("message", message["id"], "edited", True)

    # If message has a poll, update the poll question
    attachments = message.get("attachments")
    if attachments:
        if isinstance(attachments, str):
            try:
                attachments = json.loads(attachments)
            except:
                attachments = []
        for att in attachments:
            if isinstance(att, dict) and att.get("type") == "poll":
                self.db.edit("poll", att["pollId"], "question", content)

    notif = {"type": "message_edited", "content": {"id": message, "content": content}}
    channel = self.db.getSomething("textual_channel", message["place"])
    if channel:
        members = self.db.getFilters("accessserver", ["server", "=", channel["server"]])
        for member in members:
            if member["account"] != uid:
                self.sendNotification(member["account"], notif)
    else:
        members = self.db.getAll("accessconversation", message["place"], "conversation")
        for member in members:
            if member["account"] != uid:
                self.sendNotification(member["account"], notif)


@Server.expose
def delete_message(self, message_id):
    uid = self.getUser()

    messageId = message_id
    message = self.db.getSomething("message", message_id)
    if not message:
        raise HTTPError(self.response, 403, "forbidden")

    # Own message, or someone else's channel/forum message with manage-messages
    # (DMs stay sender-only: there is no DM moderation by server mods).
    channel, channel_type = _lookupMessagePlace(self, message["place"])
    moderated = False
    if message["sender"] != uid:
        if not channel or not self.checkChannelAccess(uid, channel["id"], channel_type, "manage-messages"):
            raise HTTPError(self.response, 403, "forbidden")
        moderated = True

    # Removes orphaned attachment files and refunds the quota
    self.deleteMessageWithCleanup(message)
    if moderated:
        self.logModeration(channel["server"], uid, "manage_messages_delete",
                           target_account=message["sender"], metadata={"message_id": message["id"]})

    del_notif = {"type": "message_deleted", "content": {"id": messageId}}
    if channel:
        members = self.db.getFilters("accessserver", ["server", "=", channel["server"]])
        for member in members:
            if member["account"] != uid:
                self.sendNotification(member["account"], del_notif)
    else:
        members = self.db.getAll("accessconversation", message["place"], "conversation")
        for member in members:
            if member["account"] != uid:
                self.sendNotification(member["account"], del_notif)


@Server.expose
def toggle_reaction(self, message_id, emoji):
    uid = self.getUser()

    # Check if user has access to the message
    message = self.db.getSomething("message", message_id)
    if not message:
        raise HTTPError(self.response, 404, "Message not found")
        
    channel, channel_type = _lookupMessagePlace(self, message["place"])
    if channel:
        # checkChannelAccess also requires membership, so kicked/banned users can't react.
        if not self.checkChannelAccess(uid, channel["id"], channel_type, "view"):
            raise HTTPError(self.response, 403, "no permission to view this channel")
        self.enforceNotTimedOut(uid, channel["server"])
    else:
        conv = self.db.getFilters("accessconversation", ["conversation", "=", message["place"], "and", "account", "=", uid])
        if not conv:
             raise HTTPError(self.response, 403, "no permission to view this conversation")

    existing_reaction = self.db.getFilters("message_reaction", [
        "message", "=", message_id, "and",
        "account", "=", uid, "and",
        "emoji", "=", emoji
    ])

    if existing_reaction:
        self.db.deleteSomething("message_reaction", existing_reaction[0]["id"])
        action = "removed"
    else:
        self.db.insertDict("message_reaction", {
            "message": message_id,
            "account": uid,
            "emoji": emoji
        })
        action = "added"
        
    # Re-fetch reactions for this message to broadcast the updated state
    reactions = self.db.getAll("message_reaction", message_id, "message")

    broadcast_reactions_dict = {}
    for r in reactions:
        e = r["emoji"]
        if e not in broadcast_reactions_dict:
            broadcast_reactions_dict[e] = []
        broadcast_reactions_dict[e].append(r["account"])
        
    notif_data = {
        "type": "reaction_updated",
        "content": {
            "messageId": message_id,
            "place": message["place"],
            "emoji": emoji,
            "reactions": broadcast_reactions_dict
        }
    }

    if channel:
        members = self.db.getFilters("accessserver", ["server", "=", channel["server"]])
        for m in members:
            if m["account"] != uid:
                self.sendNotification(m["account"], notif_data)
    else:
        members = self.db.getAll("accessconversation", message["place"], "conversation")
        for m in members:
            if m["account"] != uid:
                self.sendNotification(m["account"], notif_data)

    return json.dumps({"success": True, "action": action, "reactions": broadcast_reactions_dict})


@Server.expose
def vote_poll(self, poll_id, option_ids):
    uid = self.getUser()
    poll, message = _getPollConvAccess(self, uid, poll_id)
    option_ids = json.loads(option_ids) if isinstance(option_ids, str) else option_ids

    if not isinstance(option_ids, list) or len(option_ids) == 0:
        raise HTTPError(self.response, 400, "Must select at least one option")

    # Enforce single-choice policy
    if not poll["multiple_choice"] and len(option_ids) > 1:
        raise HTTPError(self.response, 400, "This poll only allows a single answer")

    # Validate all option IDs belong to this poll
    poll_options = self.db.getAll("poll_option", poll["id"], "poll")
    valid_option_ids = {o["id"] for o in poll_options}
    for oid in option_ids:
        if int(oid) not in valid_option_ids:
            raise HTTPError(self.response, 400, "Invalid option for this poll")

    # Remove previous votes for this user on this poll
    existing_votes = self.db.getFilters("poll_vote", ["poll", "=", poll["id"], "and", "voter", "=", uid])
    for v in existing_votes:
        self.db.deleteSomething("poll_vote", v["id"])

    # Insert new votes
    for oid in option_ids:
        self.db.insertDict("poll_vote", {"poll": poll["id"], "option": int(oid), "voter": uid})

    # Re-fetch all votes for notification
    all_votes = self.db.getAll("poll_vote", poll["id"], "poll")
    votes_dict = {}
    for v in all_votes:
        k = str(v["option"])
        if k not in votes_dict:
            votes_dict[k] = []
        votes_dict[k].append(v["voter"])

    # Notify conversation members
    notif_data = {"type": "poll_voted", "content": {
        "messageId": message["id"],
        "place": message["place"],
        "pollId": poll["id"],
        "votes": votes_dict
    }}
    channel = self.db.getSomething("textual_channel", message["place"])
    if channel:
        members = self.db.getFilters("accessserver", ["server", "=", channel["server"]])
        for m in members:
            if m["account"] != uid:
                self.sendNotification(m["account"], notif_data)
    else:
        members = self.db.getAll("accessconversation", message["place"], "conversation")
        for m in members:
            if m["account"] != uid:
                self.sendNotification(m["account"], notif_data)

    return json.dumps({"success": True, "votes": votes_dict})


@Server.expose
def add_poll_option(self, poll_id, text):
    uid = self.getUser()
    poll, message = _getPollConvAccess(self, uid, poll_id)

    if not poll["allow_user_options"]:
        raise HTTPError(self.response, 403, "This poll does not allow user-added options")

    text = text.strip()
    if not text:
        raise HTTPError(self.response, 400, "Option text cannot be empty")

    optId = self.db.insertDict("poll_option", {
        "poll": poll["id"],
        "text": text,
        "creator": uid
    }, getId=True)

    new_option = {"id": optId, "text": text, "creator": uid}

    # Notify conversation members
    notif_data = {"type": "poll_option_added", "content": {
        "messageId": message["id"],
        "place": message["place"],
        "pollId": poll["id"],
        "option": new_option
    }}
    channel = self.db.getSomething("textual_channel", message["place"])
    if channel:
        members = self.db.getFilters("accessserver", ["server", "=", channel["server"]])
        for m in members:
            if m["account"] != uid:
                self.sendNotification(m["account"], notif_data)
    else:
        members = self.db.getAll("accessconversation", message["place"], "conversation")
        for m in members:
            if m["account"] != uid:
                self.sendNotification(m["account"], notif_data)

    return json.dumps(new_option)


@Server.expose
def get_poll_results(self, poll_id):
    uid = self.getUser()
    poll, message = _getPollConvAccess(self, uid, poll_id)

    options = self.db.getAll("poll_option", poll["id"], "poll")
    votes = self.db.getAll("poll_vote", poll["id"], "poll")

    votes_dict = {}
    for v in votes:
        k = str(v["option"])
        if k not in votes_dict:
            votes_dict[k] = []
        votes_dict[k].append(v["voter"])

    total_votes = len(set(v["voter"] for v in votes))

    return json.dumps({
        "poll": {
            "id": poll["id"],
            "question": poll["question"],
            "multiple_choice": poll["multiple_choice"],
            "allow_user_options": poll["allow_user_options"]
        },
        "options": [{"id": o["id"], "text": o["text"], "creator": o["creator"]} for o in options],
        "votes": votes_dict,
        "totalVoters": total_votes
    })


def _resolveMessagePlace(self, uid, conv):
    """Resolve a message 'place' id to a server channel for permission checks and notification.
    Returns (channel, channel_type): channel is a textual_channel or forum_channel dict suitable
    for notifyChannelMesage; channel_type is None for plain conversations (DMs/groups).
    Raises 403 if the user cannot post. Bumps a forum post's last_activity on success."""
    place_id = conv.get("id")
    channel = self.db.getSomething("textual_channel", place_id) if place_id else None
    if channel:
        if not self.checkChannelAccess(uid, place_id, "textual", "send-messages"):
            raise HTTPError(self.response, 403, "no permission to send messages in this channel")
        self.enforceNotTimedOut(uid, channel["server"])
        return channel, "textual"

    post = self.db.getSomething("forum_post", place_id) if place_id else None
    if post:
        if post.get("locked"):
            raise HTTPError(self.response, 403, "post is locked")
        if not self.checkChannelAccess(uid, post["forum"], "forum", "send-messages"):
            raise HTTPError(self.response, 403, "no permission to send messages in this forum")
        forum = self.db.getSomething("forum_channel", post["forum"])
        self.enforceNotTimedOut(uid, forum["server"])
        self.db.edit("forum_post", post["id"], "last_activity", datetime.datetime.now())
        return forum, "forum"

    if place_id and not self.db.getFilters("accessconversation", ["conversation", "=", place_id, "and", "account", "=", uid]):
        raise HTTPError(self.response, 403, "no access to this conversation")
    return None, None


def _parseDiceCommand(self, command):
    """Validate a client-parsed `/d` command → (count, faces). The client only
    does the parsing; the server re-checks every bound since the payload is untrusted."""
    if not isinstance(command, dict) or command.get("name") != "dice":
        raise HTTPError(self.response, 400, "Unknown command")
    try:
        count = int(str(command.get("count", 1)))
        faces = int(str(command.get("faces")))
    except (TypeError, ValueError):
        raise HTTPError(self.response, 400, "Invalid dice")
    if not (1 <= count <= DICE_MAX_COUNT and DICE_MIN_FACES <= faces <= DICE_MAX_FACES):
        raise HTTPError(self.response, 400, "Invalid dice")
    return count, faces


def _rollDice(self, uid, place_id, place, count, faces):
    """Roll and post the result as a system notice. Rolled here, never on the
    client, so nobody can forge a result."""
    rolls = [secrets.randbelow(faces) + 1 for _ in range(count)]
    total = sum(rolls)
    return post_system_message(
        self, uid, place_id, "dice",
        {"count": count, "faces": faces, "rolls": rolls, "total": total},
        body=f"🎲 {count}d{faces} → {total}", icon="dice", place=place,
    )


def _getPollConvAccess(self, uid, poll_id):
    """Check if user has access to the conversation containing a poll. Returns (poll, message) or raises 403."""
    poll = self.db.getSomething("poll", poll_id)
    if not poll:
        raise HTTPError(self.response, 404, "Poll not found")
    message = self.db.getSomething("message", poll["message"])
    if not message:
        raise HTTPError(self.response, 404, "Poll message not found")
    # Check access: either via accessconversation (DMs) or channel access (channels)
    channel = self.db.getSomething("textual_channel", message["place"])
    if channel:
        self.require_channel_access(uid, message["place"], "textual", "view")
    else:
        access = self.db.getFilters("accessconversation", ["conversation", "=", message["place"], "and", "account", "=", uid])
        if not access:
            raise HTTPError(self.response, 403, "No access to this poll")
    return poll, message

