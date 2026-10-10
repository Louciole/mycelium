"""Tests for global search (Ctrl+K) — routes/search.py.

Covers: trigram+unaccent matching, accessserver isolation, private-channel
filtering through checkChannelAccess, forum post and drive folder results
(including ancestor paths), frecency shape, and query validation.

Requires db/migrate_search.sql to be applied to the test database (pg_trgm,
unaccent, f_unaccent + indexes).
"""

import json
import os
import time

import requests

# These tests run against a real, already-started Mycelium server (DEBUG mode,
# for /get_debug_otp): `python server.py` locally, or the CI job's background
# server. Override with TEST_SERVER_URL.
TEST_SERVER_URL = os.environ.get('TEST_SERVER_URL', 'http://localhost:9876')


def _ts():
    return int(time.time() * 1000)


def _desecure(session):
    """Vesta sets the JWT/refresh cookies with the Secure flag; browsers still
    send them to http://localhost but python-requests does not. Strip the flag
    so the test session stays authenticated over plain http."""
    for cookie in session.cookies:
        cookie.secure = False


def create_test_user(username):
    """Register + verify a user against a full Mycelium server, following the
    real client flow (static/home/auth.js): POST /login → "verif" for a new
    account → OTP via /get_debug_otp (DEBUG mode) → POST /signup."""
    email = f"{username}@test.com"
    try:
        session = requests.Session()
        r = session.post(f'{TEST_SERVER_URL}/login', params={'email': email, 'password': 'Test123!'})
        _desecure(session)  # JWT cookie is Secure; requests drops it over http
        if r.text.strip() == 'verif' or 'verif' in r.url:
            otp = session.post(f'{TEST_SERVER_URL}/get_debug_otp', params={'email': email}).json().get('code')
            r = session.post(f'{TEST_SERVER_URL}/signup', params={'code': otp})
            _desecure(session)
        if r.text.strip() == 'ok':
            return session
        print(f"Auth failed for {username}: {r.status_code} url={r.url} {r.text[:80]!r}")
    except requests.RequestException as e:
        print(f"Network error creating user {username}: {e}")
    return None


def get_user_id(session):
    return session.post(f'{TEST_SERVER_URL}/get_user_info').json().get('id')


def _make_community_server(owner):
    server_id = owner.post(f'{TEST_SERVER_URL}/create_server').json()['id']
    owner.post(f'{TEST_SERVER_URL}/edit_server_property',
               params={'property': 'is_community', 'server_id': server_id, 'value': 'true'})
    return server_id


def _join(session, server_id):
    return session.post(f'{TEST_SERVER_URL}/join_community_server', params={'server_id': server_id})


def _general_channel(session, server_id):
    content = session.get(f'{TEST_SERVER_URL}/get_serv_content',
                          params={'server_id': server_id}).json()
    return content['channels'][0]['id']


def _rename_channel(owner, server_id, channel_id, name, channel_type='textual'):
    r = owner.post(f'{TEST_SERVER_URL}/edit_server_channel',
                   params={'server_id': server_id, 'action': 'edit', 'field': 'name',
                           'value': name, 'targetId': channel_id, 'channel_type': channel_type})
    assert r.status_code == 200, f"rename failed: {r.status_code} {r.text}"


def _create_channel(owner, server_id, channel_type):
    r = owner.post(f'{TEST_SERVER_URL}/edit_server_channel',
                   params={'server_id': server_id, 'action': 'create', 'channel_type': channel_type})
    assert r.status_code == 200, f"create channel failed: {r.status_code} {r.text}"
    return r.json()['channel']['id']


def _search(session, query):
    r = session.get(f'{TEST_SERVER_URL}/global_search', params={'query': query})
    assert r.status_code == 200, f"global_search failed: {r.status_code} {r.text}"
    return r.json()


def _ids(rows):
    return [row['id'] for row in rows]


# --------------------------------------------------------------------------
# tests
# --------------------------------------------------------------------------

def test_finds_channel_accent_insensitive():
    """A member finds a renamed channel; accents in the name don't matter."""
    try:
        owner = create_test_user(f"srch_own_a_{_ts()}")
        member = create_test_user(f"srch_mem_a_{_ts()}")
        if not (owner and member):
            return ("Failed to create users", False)

        token = f"zorglub{_ts()}"
        server_id = _make_community_server(owner)
        _join(member, server_id)
        chan = _general_channel(owner, server_id)
        _rename_channel(owner, server_id, chan, f"Général-{token}")

        res = _search(member, token)
        assert chan in _ids(res['channels']), f"channel not found: {res}"
        row = next(r for r in res['channels'] if r['id'] == chan)
        assert row['kind'] == 'textual' and row['server'] == server_id, f"bad row: {row}"

        # accent-insensitive: plain-ascii query matches the accented name
        res = _search(member, f"general-{token}")
        assert chan in _ids(res['channels']), f"accent-insensitive match failed: {res}"
        return ("Member finds channel, accents ignored", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_non_member_sees_nothing():
    """Search is scoped by accessserver: outsiders get zero hits."""
    try:
        owner = create_test_user(f"srch_own_b_{_ts()}")
        outsider = create_test_user(f"srch_out_b_{_ts()}")
        if not (owner and outsider):
            return ("Failed to create users", False)

        token = f"isolat{_ts()}"
        server_id = _make_community_server(owner)
        chan = _general_channel(owner, server_id)
        _rename_channel(owner, server_id, chan, token)

        assert chan in _ids(_search(owner, token)['channels']), "owner should find own channel"
        res = _search(outsider, token)
        total = sum(len(v) for v in res.values())
        assert total == 0, f"outsider should get nothing, got: {res}"
        return ("Non-member gets zero results", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_private_channel_hidden():
    """A private channel is invisible to role-less members but not the owner."""
    try:
        owner = create_test_user(f"srch_own_c_{_ts()}")
        member = create_test_user(f"srch_mem_c_{_ts()}")
        if not (owner and member):
            return ("Failed to create users", False)

        token = f"secret{_ts()}"
        server_id = _make_community_server(owner)
        _join(member, server_id)
        chan = _create_channel(owner, server_id, 'textual')
        _rename_channel(owner, server_id, chan, token)

        r = owner.post(f'{TEST_SERVER_URL}/edit_channel_permissions',
                       params={'channelId': chan, 'channelType': 'textual', 'action': 'togglePrivacy'})
        assert r.status_code == 200 and r.json().get('is_private') is True, f"togglePrivacy failed: {r.text}"

        assert chan in _ids(_search(owner, token)['channels']), "owner should see private channel"
        assert chan not in _ids(_search(member, token)['channels']), "member must NOT see private channel"
        return ("Private channel filtered per checkChannelAccess", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_forum_post_found():
    """Forum post titles are searchable and carry their forum id."""
    try:
        owner = create_test_user(f"srch_own_d_{_ts()}")
        if not owner:
            return ("Failed to create user", False)

        token = f"zorgpost{_ts()}"
        server_id = _make_community_server(owner)
        forum = _create_channel(owner, server_id, 'forum')
        r = owner.post(f'{TEST_SERVER_URL}/create_forum_post',
                       params={'forum_id': forum, 'title': f"Plan de migration {token}", 'content': 'corps'})
        assert r.status_code == 200, f"create_forum_post failed: {r.status_code} {r.text}"

        res = _search(owner, token)
        posts = [p for p in res['posts'] if token in p['name']]
        assert posts, f"post not found: {res}"
        assert posts[0]['forum'] == forum and posts[0]['server'] == server_id, f"bad post row: {posts[0]}"
        return ("Forum post searchable with forum id", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_drive_folder_with_path():
    """Nested drive folders are found and expose their ancestor path."""
    try:
        owner = create_test_user(f"srch_own_e_{_ts()}")
        if not owner:
            return ("Failed to create user", False)

        ts = _ts()
        server_id = _make_community_server(owner)
        drive = _create_channel(owner, server_id, 'drive')

        r = owner.post(f'{TEST_SERVER_URL}/create_drive_folder',
                       params={'drive_id': drive, 'foldername': f"racine{ts}"})
        assert r.status_code == 200, f"create root folder failed: {r.text}"
        folders = owner.get(f'{TEST_SERVER_URL}/get_drive_folders', params={'drive_id': drive}).json()
        root = next(f for f in folders if f['foldername'] == f"racine{ts}")

        r = owner.post(f'{TEST_SERVER_URL}/create_drive_folder',
                       params={'drive_id': drive, 'foldername': f"feuille{ts}", 'parent_folder': root['id']})
        assert r.status_code == 200, f"create nested folder failed: {r.text}"

        res = _search(owner, f"feuille{ts}")
        hits = [f for f in res['folders'] if f['name'] == f"feuille{ts}"]
        assert hits, f"nested folder not found: {res}"
        hit = hits[0]
        assert hit['drive_channel'] == drive, f"bad drive id: {hit}"
        assert [p['id'] for p in hit['path']] == [root['id']], f"bad ancestor path: {hit}"
        return ("Drive folder found with ancestor path", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_frecency_counts_messages():
    """get_frecency reflects where the caller talks, rolled up per server."""
    try:
        owner = create_test_user(f"srch_own_f_{_ts()}")
        if not owner:
            return ("Failed to create user", False)

        server_id = _make_community_server(owner)
        chan = _general_channel(owner, server_id)
        for i in range(3):
            r = owner.post(f'{TEST_SERVER_URL}/send_message',
                           params={'conv': json.dumps({'id': chan}), 'content': f"msg {i}", 'reply': ''})
            assert r.status_code == 200, f"send_message failed: {r.text}"

        res = owner.get(f'{TEST_SERVER_URL}/get_frecency').json()
        place_score = res['places'].get(str(chan), 0)
        server_score = res['servers'].get(str(server_id), 0)
        # fresh messages decay negligibly: score ≈ message count
        assert 2.5 < place_score <= 3.001, f"unexpected place score: {res}"
        assert 2.5 < server_score <= 3.001, f"unexpected server score: {res}"
        return ("Frecency counts decayed messages per place and server", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_query_validation():
    """Queries shorter than 2 chars or longer than 100 are rejected."""
    try:
        owner = create_test_user(f"srch_own_g_{_ts()}")
        if not owner:
            return ("Failed to create user", False)

        r = owner.get(f'{TEST_SERVER_URL}/global_search', params={'query': 'a'})
        assert r.status_code == 400, f"1-char query should 400, got {r.status_code}"
        r = owner.get(f'{TEST_SERVER_URL}/global_search', params={'query': 'x' * 101})
        assert r.status_code == 400, f"101-char query should 400, got {r.status_code}"
        return ("Query length validated", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def run():
    # Flatten to (label, bool) so the vesta runner reports failures correctly
    # (nested (name, (msg, ok)) tuples always compare unequal to False).
    results = []
    for name, fn in [
        ("Search Finds Channel (accents)", test_finds_channel_accent_insensitive),
        ("Search Non-Member Isolation", test_non_member_sees_nothing),
        ("Search Private Channel Hidden", test_private_channel_hidden),
        ("Search Forum Post", test_forum_post_found),
        ("Search Drive Folder Path", test_drive_folder_with_path),
        ("Search Frecency", test_frecency_counts_messages),
        ("Search Query Validation", test_query_validation),
    ]:
        msg, ok = fn()
        results.append((f"{name} — {msg}", ok))
    return results
