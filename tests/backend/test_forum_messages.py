"""Message endpoints on forum-post messages — routes/messaging.py.

A forum post's messages have `place` = the forum_post id (not a textual
channel), so every endpoint that resolves a message's place must go through
_lookupMessagePlace (message_helpers.py) or forum messages fall into the DM
branch. Covers: reactions, manage-messages deletes (and the plain-member 403),
and the attachment refund landing on the server quota send_message charged.

Runs against the real dev server, like test_search.py:
TEST_SERVER_URL=http://localhost:9876 python -c "import tests.backend.test_forum_messages as t; [print(ok, l) for l, ok in t.run()]"
"""

import base64
import json

from tests.backend.test_search import (
    TEST_SERVER_URL,
    create_test_user,
    _ts,
    _make_community_server,
    _join,
    _create_channel,
)


def _user_id(session):
    return session.post(f'{TEST_SERVER_URL}/get_user_info').json()['id']


def _grant(owner, server_id, account_id, perms):
    """Create a role carrying `perms` (dict) and attribute it to account_id.
    (test_moderation's copy is pinned to the harness URL.)"""
    role_id = owner.post(f'{TEST_SERVER_URL}/edit_server_role',
                         params={'server_id': server_id, 'action': 'create'}).json()['id']
    owner.post(f'{TEST_SERVER_URL}/edit_server_role',
               params={'server_id': server_id, 'action': 'edit', 'field': 'permissions',
                       'value': json.dumps(perms), 'targetId': role_id})
    owner.post(f'{TEST_SERVER_URL}/edit_server_role',
               params={'server_id': server_id, 'action': 'attribute',
                       'value': account_id, 'targetId': role_id})
    return role_id


def _forum_post(owner, server_id):
    """A forum channel + one post in it → (forum_id, post_id)."""
    forum = _create_channel(owner, server_id, 'forum')
    r = owner.post(f'{TEST_SERVER_URL}/create_forum_post',
                   params={'forum_id': forum, 'title': f"Sujet {_ts()}", 'content': 'starter'})
    assert r.status_code == 200, f"create_forum_post failed: {r.status_code} {r.text}"
    return forum, r.json()['post']['id']


def _send(session, place_id, content='hello', attachments=None):
    r = session.post(f'{TEST_SERVER_URL}/send_message',
                     params={'conv': json.dumps({'id': place_id}), 'content': content, 'reply': ''},
                     json={'attachments': attachments or []})
    assert r.status_code == 200, f"send_message failed: {r.status_code} {r.text}"
    return r.json()['message']['id']


def _server_storage(session, server_id):
    return session.get(f'{TEST_SERVER_URL}/get_storage_usage',
                       params={'server_id': server_id}).json()['storage_usage']


def _user_storage(session):
    return session.get(f'{TEST_SERVER_URL}/get_storage_usage').json()['storage_usage']


# --------------------------------------------------------------------------
# tests
# --------------------------------------------------------------------------

def test_reaction_on_forum_message():
    """A server member can react to a message in a forum post."""
    try:
        owner = create_test_user(f"fmsg_own_a_{_ts()}")
        member = create_test_user(f"fmsg_mem_a_{_ts()}")
        if not (owner and member):
            return ("Failed to create users", False)

        server_id = _make_community_server(owner)
        _join(member, server_id)
        _, post = _forum_post(owner, server_id)
        msg_id = _send(owner, post, 'react to me')

        r = member.post(f'{TEST_SERVER_URL}/toggle_reaction', params={'message_id': msg_id, 'emoji': '👍'})
        assert r.status_code == 200, f"reaction should be 200, got {r.status_code} {r.text}"
        assert r.json()['action'] == 'added', f"bad reaction result: {r.text}"

        outsider = create_test_user(f"fmsg_out_a_{_ts()}")
        r = outsider.post(f'{TEST_SERVER_URL}/toggle_reaction', params={'message_id': msg_id, 'emoji': '👍'})
        assert r.status_code == 403, f"non-member reaction should be 403, got {r.status_code}"
        return ("Members react to forum messages, outsiders can't", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_manage_messages_on_forum():
    """A plain member cannot delete another's forum message; a manage-messages
    holder can."""
    try:
        owner = create_test_user(f"fmsg_own_b_{_ts()}")
        author = create_test_user(f"fmsg_aut_b_{_ts()}")
        other = create_test_user(f"fmsg_oth_b_{_ts()}")
        if not (owner and author and other):
            return ("Failed to create users", False)

        server_id = _make_community_server(owner)
        _join(author, server_id)
        _join(other, server_id)
        _, post = _forum_post(owner, server_id)
        msg_id = _send(author, post, 'delete me')

        r1 = other.post(f'{TEST_SERVER_URL}/delete_message', params={'message_id': msg_id})
        assert r1.status_code == 403, f"plain member delete should be 403, got {r1.status_code}"

        _grant(owner, server_id, _user_id(other), {"manage-messages": ""})
        r2 = other.post(f'{TEST_SERVER_URL}/delete_message', params={'message_id': msg_id})
        assert r2.status_code == 200, f"manage-messages delete should be 200, got {r2.status_code} {r2.text}"
        return ("manage-messages applies to forum messages", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_forum_attachment_refund_goes_to_server():
    """send_message charges a forum attachment to the server; deleting it must
    refund the server, not the sender's personal quota."""
    try:
        owner = create_test_user(f"fmsg_own_c_{_ts()}")
        member = create_test_user(f"fmsg_mem_c_{_ts()}")
        if not (owner and member):
            return ("Failed to create users", False)

        server_id = _make_community_server(owner)
        _join(member, server_id)
        _, post = _forum_post(owner, server_id)

        # Unique bytes so the file can't be shared with another message (no orphan check skip)
        payload = f"forum attachment {_ts()} ".encode() * 64
        data_url = "data:text/plain;base64," + base64.b64encode(payload).decode()
        attachments = [{'dataUrl': data_url, 'mimeType': 'text/plain', 'filename': 'a.txt'}]

        server_before = _server_storage(owner, server_id)
        user_before = _user_storage(member)
        msg_id = _send(member, post, 'with file', attachments)
        server_charged = _server_storage(owner, server_id)
        assert server_charged > server_before, f"send should charge the server: {server_before} → {server_charged}"
        assert _user_storage(member) == user_before, "send should not charge the sender"

        r = member.post(f'{TEST_SERVER_URL}/delete_message', params={'message_id': msg_id})
        assert r.status_code == 200, f"delete failed: {r.status_code} {r.text}"
        server_after = _server_storage(owner, server_id)
        assert server_after < server_charged, f"delete should refund the server: {server_charged} → {server_after}"
        assert _user_storage(member) == user_before, "delete should not touch the sender's quota"
        return ("Forum attachment refund goes to the server", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def run():
    # Flattened (label, bool) like test_search.py so the vesta runner reports failures.
    results = []
    for name, fn in [
        ("Forum Message Reaction", test_reaction_on_forum_message),
        ("Forum Manage-Messages Delete", test_manage_messages_on_forum),
        ("Forum Attachment Refund", test_forum_attachment_refund_goes_to_server),
    ]:
        msg, ok = fn()
        results.append((f"{name} — {msg}", ok))
    return results
