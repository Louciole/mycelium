"""Conversation (DM/group) CRUD and content.

Endpoints take the live Mycelium instance as ``self``; shared helpers remain on
the class (see server.py).
"""
import json

from vesta import Server, HTTPError
from message_helpers import (_enrichMessagesWithPolls, _enrichMessagesWithReactions,
                             _enrichMessagesWithConvBlocks)


@Server.expose
def create_conv(self, name, members, private=False):
    members = json.loads(members)
    conv_id = self.newConv(name, members, private)
    conv = self.db.getSomething("conversation", conv_id)
    all_members = self.db.getFilters("accessconversation", ["conversation", "=", conv_id])
    member_ids = [m["account"] for m in all_members]
    conv["members"] = member_ids
    creator_id = self.getUser()
    for member_id in member_ids:
        if member_id != creator_id:
            self.sendNotification(member_id, {"type": "added_conv", "content": conv})
    return json.dumps({"id": conv_id})


@Server.expose
def change_conv_pfp(self, conv_id, value):
    uid = self.getUser()
    conv_id = int(conv_id)
    members = self.db.getFilters("accessconversation", ["conversation", "=", conv_id])
    if not any(m["account"] == uid for m in members):
        raise HTTPError(self.response, 403, "forbidden")
    filename = self.saveFile(value)
    self.db.edit("conversation", conv_id, "pfp", filename)
    for m in members:
        self.sendNotification(m["account"], {"type": "edit_conv", "item": "pfp", "id": conv_id, "content": filename})
    return json.dumps({"pfp": filename})


@Server.expose
def edit_conv(self, element, value, conv_id):
    uid = self.getUser()
    conv_id = int(conv_id)
    if element not in ("name",):
        raise HTTPError(self.response, 400, "Invalid element")

    members = self.db.getAll("accessconversation", conv_id, "conversation")
    for j in range(0, len(members)):
        if members[j]["account"] == uid:
            self.db.edit("conversation", conv_id, element, value)

            for user in members:
                self.sendNotification(user["account"], {"type": "edit_conv", "item":element,"id":conv_id ,"content": value})

            return json.dumps({"status": "ok"})
    raise HTTPError(self.response, 403, "forbidden")


@Server.expose
def get_user_convs(self):
    uid = self.getUser()
    convs = self.db.getSomethingProxied("conversation", "accessconversation", "account", uid)
    for j in range(0, len(convs)):
        # TODO refactor, this is slow for no reason
        convs[j]["members"] = self.db.getFilters("accessconversation", ["conversation", "=", convs[j]["id"]])
        for i in range(0, len(convs[j]["members"])):
            convs[j]["members"][i] = convs[j]["members"][i]["account"]
    return json.dumps(convs, default=str)


@Server.expose
def get_conv_content(self, conv_id):
    uid = self.getUser()
    conv_id = int(conv_id)
    conv = self.db.getFilters("accessconversation", ["conversation", "=", conv_id, "and", "account", "=", uid])
    if conv:
        content = {}
        content["messages"] = self.db.getFilters("message", ["place", "=", conv_id, "order by timestamp"])
        _enrichMessagesWithPolls(self, content["messages"], uid)
        _enrichMessagesWithReactions(self, content["messages"])
        _enrichMessagesWithConvBlocks(self, content["messages"])
        return json.dumps(content, default=str)


@Server.expose
def subscribe(self, client_id, cat, items):
    uid = self.getUser()
    client_infos = self.db.getSomething("active_client",client_id)
    if not client_infos or client_infos.get("userid") != uid:
        raise HTTPError(self.response,403, "forbidden")

    if cat=="user":
        users = self.db.getFilters("mycelium_account", ["id", "in", json.loads(items)])
        for user in users:
            self.db.insertDict("subscription", {"client":client_id,"account": user["id"]})
