import json
import uuid
from vesta import Server, HTTPError
from message_helpers import (_enrichMessagesWithPolls, _enrichMessagesWithReactions,
                             _enrichMessagesWithConvBlocks,
                             notifyChannelMesage)


class ForumMixin:

    @Server.expose
    def get_forum_content(self, channel_id):
        """Return forum metadata and the list of posts (with reply counts)."""
        uid = self.getUser()
        forum = self.db.getSomething("forum_channel", channel_id)
        if not forum:
            raise HTTPError(self.response, 404, "Not Found")

        if not self.checkChannelAccess(uid, channel_id, "forum", "view"):
            raise HTTPError(self.response, 403, "forbidden")

        available_tags = forum.get("available_tags", [])
        if isinstance(available_tags, str):
            available_tags = json.loads(available_tags)

        content = {
            "name": forum["name"],
            "id": channel_id,
            "available_tags": available_tags,
            "default_layout": forum.get("default_layout", "list"),
            "default_sort": forum.get("default_sort", "activity"),
            "guidelines": forum.get("guidelines"),
            "is_private": forum.get("is_private", False),
        }

        posts = self.db.getFilters("forum_post", ["forum", "=", channel_id, "order by pinned desc, last_activity desc"])
        for post in posts:
            if isinstance(post.get("tags"), str):
                post["tags"] = json.loads(post["tags"])
            msgs = self.db.getFilters("message", ["place", "=", post["id"], "order by timestamp"])
            post["reply_count"] = max(len(msgs) - 1, 0)
            post["snippet"] = (msgs[0].get("body") or "")[:160] if msgs else ""
        content["posts"] = posts
        return json.dumps(content, default=str)

    @Server.expose
    def get_forum_post(self, post_id):
        """Return a single forum post and its thread (starter message + replies)."""
        uid = self.getUser()
        post = self.db.getSomething("forum_post", post_id)
        if not post:
            raise HTTPError(self.response, 404, "Not Found")

        if not self.checkChannelAccess(uid, post["forum"], "forum", "view"):
            raise HTTPError(self.response, 403, "forbidden")

        if isinstance(post.get("tags"), str):
            post["tags"] = json.loads(post["tags"])

        content = {
            "id": post["id"],
            "forum": post["forum"],
            "title": post["title"],
            "author": post["author"],
            "tags": post.get("tags", []),
            "pinned": post.get("pinned", False),
            "locked": post.get("locked", False),
            "created_at": post.get("created_at"),
        }
        content["messages"] = self.db.getFilters("message", ["place", "=", post_id, "order by timestamp"])
        _enrichMessagesWithPolls(self, content["messages"], uid)
        _enrichMessagesWithReactions(self, content["messages"])
        _enrichMessagesWithConvBlocks(self, content["messages"])
        return json.dumps(content, default=str)

    @Server.expose
    def create_forum_post(self, forum_id, title, content="", tags=None, attachments=None):
        """Create a forum post (a conversationElement) with a starter message."""
        uid = self.getUser()
        forum = self.db.getSomething("forum_channel", forum_id)
        if not forum:
            raise HTTPError(self.response, 404, "forum not found")
        if not self.checkChannelAccess(uid, forum_id, "forum", "send-messages"):
            raise HTTPError(self.response, 403, "forbidden")
        self.enforceNotTimedOut(uid, forum["server"])

        title = (title or "").strip()
        if not title:
            raise HTTPError(self.response, 400, "title required")

        if isinstance(tags, str):
            tags = json.loads(tags)
        tags = tags or []

        available_tags = forum.get("available_tags", [])
        if isinstance(available_tags, str):
            available_tags = json.loads(available_tags)
        valid_tag_ids = {str(t.get("id")) for t in available_tags}
        tags = [t for t in tags if str(t) in valid_tag_ids]

        if isinstance(attachments, str):
            attachments = json.loads(attachments)
        attachments = attachments or []

        total_attachment_size = sum(
            self._estimateBase64Size(a.get('dataUrl', ''))
            for a in attachments if a.get('dataUrl')
        )
        if total_attachment_size > 0:
            self._checkQuota(forum["server"], total_attachment_size)

        attachmentList = []
        for attachment in attachments:
            filepath = self.saveFile(attachment.get('dataUrl', ''))
            attachmentList.append({"mime": attachment.get('mimeType', ''), "filename": attachment.get('filename', 'file'), "filepath": filepath})

        post_id = self.db.insertDict("forum_post", {
            "forum": forum_id,
            "server": forum["server"],
            "author": uid,
            "title": title,
            "tags": json.dumps(tags),
        }, getId=True)

        message = {"sender": uid, "place": post_id, "body": content or "", "attachments": json.dumps(attachmentList)}
        msgId = self.db.insertDict("message", message, getId=True)
        message["id"] = msgId

        if total_attachment_size > 0:
            self._adjustStorage(forum["server"], total_attachment_size)

        notifyChannelMesage(self, uid, forum, message, "forum")

        post = self.db.getSomething("forum_post", post_id)
        if isinstance(post.get("tags"), str):
            post["tags"] = json.loads(post["tags"])
        post["reply_count"] = 0
        return json.dumps({"post": post}, default=str)

    @Server.expose
    def edit_forum_post(self, post_id, action, value=None):
        """Pin/lock/edit/delete a forum post. Author may edit/delete own; admins may do anything."""
        uid = self.getUser()
        post = self.db.getSomething("forum_post", post_id)
        if not post:
            raise HTTPError(self.response, 404, "post not found")

        is_admin = self.checkAccessRights(uid, post["server"], "server-admin")
        is_author = post["author"] == uid

        if action in ("pin", "unpin", "lock", "unlock"):
            if not is_admin:
                raise HTTPError(self.response, 403, "forbidden")
            field = "pinned" if action in ("pin", "unpin") else "locked"
            self.db.edit("forum_post", post_id, field, action in ("pin", "lock"))
            return json.dumps({field: action in ("pin", "lock")})

        if action == "editTitle":
            if not (is_author or is_admin):
                raise HTTPError(self.response, 403, "forbidden")
            title = (value or "").strip()
            if not title:
                raise HTTPError(self.response, 400, "title required")
            self.db.edit("forum_post", post_id, "title", title)
            return json.dumps({"title": title})

        if action == "editTags":
            if not (is_author or is_admin):
                raise HTTPError(self.response, 403, "forbidden")
            tags = json.loads(value) if isinstance(value, str) else (value or [])
            self.db.edit("forum_post", post_id, "tags", json.dumps(tags))
            return json.dumps({"tags": tags})

        if action == "delete":
            if not (is_author or is_admin):
                raise HTTPError(self.response, 403, "forbidden")
            for msg in self.db.getFilters("message", ["place", "=", post_id]):
                self.db.deleteSomething("message", msg["id"])
            self.db.deleteSomething("forum_post", post_id)
            return json.dumps({"status": "ok"})

        raise HTTPError(self.response, 400, "invalid action")

    @Server.expose
    def edit_forum_tags(self, forum_id, action, tag=None, tagId=None):
        """Manage a forum's admin-defined available_tags (add/remove/edit)."""
        uid = self.getUser()
        forum = self.db.getSomething("forum_channel", forum_id)
        if not forum:
            raise HTTPError(self.response, 404, "forum not found")
        if not self.checkAccessRights(uid, forum["server"], "edit"):
            raise HTTPError(self.response, 403, "forbidden")

        tags = forum.get("available_tags", [])
        if isinstance(tags, str):
            tags = json.loads(tags)

        if action == "add":
            new_tag = json.loads(tag) if isinstance(tag, str) else tag
            new_tag["id"] = str(uuid.uuid4())
            tags.append(new_tag)
        elif action == "remove":
            tags = [t for t in tags if str(t.get("id")) != str(tagId)]
        elif action == "edit":
            edited = json.loads(tag) if isinstance(tag, str) else tag
            for i, t in enumerate(tags):
                if str(t.get("id")) == str(tagId):
                    edited["id"] = t.get("id")
                    tags[i] = edited
                    break
        else:
            raise HTTPError(self.response, 400, "invalid action")

        self.db.edit("forum_channel", forum_id, "available_tags", json.dumps(tags))
        return json.dumps({"available_tags": tags})

    @Server.expose
    def edit_forum_settings(self, forum_id, field, value):
        """Edit a forum's layout/sort/guidelines (admin only)."""
        uid = self.getUser()
        forum = self.db.getSomething("forum_channel", forum_id)
        if not forum:
            raise HTTPError(self.response, 404, "forum not found")
        if not self.checkAccessRights(uid, forum["server"], "edit"):
            raise HTTPError(self.response, 403, "forbidden")
        if field not in ("default_layout", "default_sort", "guidelines"):
            raise HTTPError(self.response, 400, "invalid field")
        if field == "default_layout" and value not in ("list", "gallery"):
            raise HTTPError(self.response, 400, "invalid layout value")
        if field == "default_sort" and value not in ("activity", "newest", "oldest"):
            raise HTTPError(self.response, 400, "invalid sort value")
        self.db.edit("forum_channel", forum_id, field, value)
        return json.dumps({field: value})
