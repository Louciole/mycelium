"""Voice/video call lifecycle (P2P/SFU via callManager).

Endpoints take the live Mycelium instance as ``self``; shared helpers remain on
the class (see server.py).
"""
import json

from vesta import Server, HTTPError


@Server.expose
def start_call(self, conversation_id, call_type="audio"):
    uid = self.getUser()

    access = self.db.getFilters("accessconversation", ["conversation", "=", conversation_id, "and", "account", "=", uid])

    if not access:
        raise HTTPError(self.response, 403, "Forbidden - No access to this conversation")

    conv = self.db.getSomething("conversation", conversation_id)
    if not conv:
        raise HTTPError(self.response, 403, "Calls are only available in conversations")

    call = self.callManager.create_call(conversation_id, uid, call_type)
    return json.dumps(call.to_dict(), default=str)


@Server.expose
def join_call(self, call_id):
    uid = self.getUser()

    call = self.callManager.active_calls.get(int(call_id))
    if not call:
        raise HTTPError(self.response, 404, "Call not found")

    access = self.db.getFilters("accessconversation", ["conversation", "=", call.conversation_id, "and", "account", "=", uid])

    if not access:
        raise HTTPError(self.response, 403, "Forbidden - No access to this conversation")

    result = self.callManager.join_call(int(call_id), uid)

    if result:
        response = {
            'call': result['call'].to_dict(),
            'mode_changed': result['mode_changed']
        }
        # Include old_mode and new_mode if mode changed
        if result.get('old_mode'):
            response['old_mode'] = result['old_mode']
        if result.get('new_mode'):
            response['new_mode'] = result['new_mode']

        return json.dumps(response, default=str)

    raise HTTPError(self.response, 500, "Failed to join call")


@Server.expose
def leave_call(self, call_id):
    uid = self.getUser()

    result = self.callManager.leave_call(int(call_id), uid)

    if result:
        response = {
            'ended': result['ended'],
            'mode_changed': result.get('mode_changed', False)
        }
        if not result['ended']:
            response['call'] = result['call'].to_dict()

        # Include old_mode and new_mode if mode changed
        if result.get('old_mode'):
            response['old_mode'] = result['old_mode']
        if result.get('new_mode'):
            response['new_mode'] = result['new_mode']

        return json.dumps(response, default=str)

    raise HTTPError(self.response, 404, "Call not found")


@Server.expose
def get_call_state(self, conversation_id):
    uid = self.getUser()

    access = self.db.getFilters("accessconversation", ["conversation", "=", conversation_id, "and", "account", "=", uid])

    if not access:
        raise HTTPError(self.response, 403, "Forbidden")

    call_state = self.callManager.get_call_state(int(conversation_id))

    if call_state:
        return json.dumps(call_state, default=str)

    return json.dumps({"active": False}, default=str)


@Server.expose
def join_vocal_channel(self, channel_id):
    uid = self.getUser()
    chan = self.db.getSomething("vocal_channel", channel_id)
    if not chan:
        raise HTTPError(self.response, 404, "Vocal channel not found")

    self.require_member(uid, chan["server"])

    if not self.checkChannelAccess(uid, int(channel_id), "vocal", "view"):
        raise HTTPError(self.response, 403, "No access to this vocal channel")
    self.enforceNotTimedOut(uid, chan["server"])

    result = self.callManager.create_call_for_vocal_channel(int(channel_id), uid)
    if not result:
        raise HTTPError(self.response, 500, "Failed to join vocal channel")
    call = result['call']
    return json.dumps({
        'call': call.to_dict(),
        'created': result.get('created', False)
    }, default=str)


@Server.expose
def get_vocal_channel_state(self, channel_id):
    uid = self.getUser()
    chan = self.db.getSomething("vocal_channel", channel_id)
    if not chan:
        raise HTTPError(self.response, 404, "Vocal channel not found")

    self.require_member(uid, chan["server"])

    call_state = self.callManager.get_call_by_vocal_channel(int(channel_id))
    if call_state:
        return json.dumps(call_state.to_dict(), default=str)
    return json.dumps({"active": False}, default=str)


@Server.expose
def register_activity(self, SDP):
    uid = self.getUser()
    self.db.insertDict("active_client", {"userid": uid, "SDP": SDP})
