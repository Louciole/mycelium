"""Tests for the moderation system (docs/moderation.md).

Phase 1 (server-level): kick, ban-blocks-rejoin, timeout blocks messaging and
clears after expiry, manage-messages permission boundary, non-moderator 403.
Phase 2 (platform-level) tests live further down in run().
"""

import json
import os
import configparser
import datetime

import psycopg
from psycopg.rows import dict_row

from tests.backend.test_search import (
    TEST_SERVER_URL,
    create_test_user,
    get_user_id,
)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _db_conn():
    """Direct connection to the same DB the test server uses (for time-travel
    on server_timeout / suspension rows that HTTP can't fast-forward)."""
    cfg = configparser.ConfigParser()
    cfg.read(os.path.join(os.path.dirname(__file__), "server.ini"))
    return psycopg.connect(
        host=cfg.get("DB", "DB_HOST"), port=cfg.getint("DB", "DB_PORT"),
        user=cfg.get("DB", "DB_USER"), password=cfg.get("DB", "DB_PASSWORD"),
        dbname=cfg.get("DB", "DB_NAME"), row_factory=dict_row, autocommit=True,
    )


def _make_community_server(owner):
    server_id = owner.post(f'{TEST_SERVER_URL}/create_server').json()['id']
    owner.post(f'{TEST_SERVER_URL}/edit_server_property',
               params={'property': 'is_community', 'server_id': server_id, 'value': 'true'})
    return server_id


def _join(session, server_id):
    return session.post(f'{TEST_SERVER_URL}/join_community_server', params={'server_id': server_id})


def _grant(owner, server_id, account_id, perms):
    """Create a role carrying `perms` (dict) and attribute it to account_id."""
    role_id = owner.post(f'{TEST_SERVER_URL}/edit_server_role',
                         params={'server_id': server_id, 'action': 'create'}).json()['id']
    owner.post(f'{TEST_SERVER_URL}/edit_server_role',
               params={'server_id': server_id, 'action': 'edit', 'field': 'permissions',
                       'value': json.dumps(perms), 'targetId': role_id})
    owner.post(f'{TEST_SERVER_URL}/edit_server_role',
               params={'server_id': server_id, 'action': 'attribute',
                       'value': account_id, 'targetId': role_id})
    return role_id


def _general_channel(session, server_id):
    content = session.get(f'{TEST_SERVER_URL}/get_serv_content',
                          params={'server_id': server_id}).json()
    return content['channels'][0]['id']


def _send(session, place_id, content='hello'):
    r = session.post(f'{TEST_SERVER_URL}/send_message',
                     params={'conv': json.dumps({'id': place_id}), 'content': content, 'reply': ''})
    return r


def _in_server(session, server_id):
    servers = session.post(f'{TEST_SERVER_URL}/get_user_servers').json()
    return any(s['id'] == server_id for s in servers)


# --------------------------------------------------------------------------
# Phase 1 tests
# --------------------------------------------------------------------------

def test_kick_member():
    """A kick-members holder removes a member; the action is logged."""
    try:
        owner = create_test_user(f"mod_owner_k_{_ts()}")
        mod = create_test_user(f"mod_kicker_{_ts()}")
        member = create_test_user(f"mod_kicked_{_ts()}")
        if not (owner and mod and member):
            return ("Failed to create users", False)

        server_id = _make_community_server(owner)
        _join(mod, server_id)
        _join(member, server_id)
        _grant(owner, server_id, get_user_id(mod), {"kick-members": ""})

        assert _in_server(member, server_id), "member should be in server before kick"

        r = mod.post(f'{TEST_SERVER_URL}/kick_member',
                     params={'server_id': server_id, 'account_id': get_user_id(member), 'reason': 'spam'})
        assert r.status_code == 200, f"kick failed: {r.status_code} {r.text}"
        assert not _in_server(member, server_id), "member should be gone after kick"

        log = mod.get(f'{TEST_SERVER_URL}/get_moderation_log', params={'server_id': server_id}).json()
        assert any(e['action'] == 'kick' for e in log), f"kick not in log: {log}"
        return ("Kick removes member and is logged", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_ban_blocks_rejoin():
    """A banned user cannot rejoin the server."""
    try:
        owner = create_test_user(f"mod_owner_b_{_ts()}")
        member = create_test_user(f"mod_banned_{_ts()}")
        if not (owner and member):
            return ("Failed to create users", False)

        server_id = _make_community_server(owner)
        _join(member, server_id)

        # Owner has server-admin (owner bypass) -> ban-members superset applies.
        r = owner.post(f'{TEST_SERVER_URL}/ban_member',
                       params={'server_id': server_id, 'account_id': get_user_id(member), 'reason': 'rules'})
        assert r.status_code == 200, f"ban failed: {r.status_code} {r.text}"
        assert not _in_server(member, server_id), "member should be removed by ban"

        rejoin = _join(member, server_id)
        assert rejoin.status_code == 403, f"banned rejoin should be 403, got {rejoin.status_code}"

        # Unban then rejoin works again.
        owner.post(f'{TEST_SERVER_URL}/unban_member',
                   params={'server_id': server_id, 'account_id': get_user_id(member)})
        rejoin2 = _join(member, server_id)
        assert rejoin2.status_code == 200, f"rejoin after unban should succeed, got {rejoin2.status_code}"
        return ("Ban blocks rejoin; unban restores it", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_timeout_blocks_messaging():
    """A timed-out member is rejected from send_message with a timed_out code,
    and remove_timeout restores posting."""
    try:
        owner = create_test_user(f"mod_owner_t_{_ts()}")
        member = create_test_user(f"mod_timed_{_ts()}")
        if not (owner and member):
            return ("Failed to create users", False)

        server_id = _make_community_server(owner)
        _join(member, server_id)
        channel_id = _general_channel(owner, server_id)

        assert _send(member, channel_id).status_code == 200, "member should post before timeout"

        r = owner.post(f'{TEST_SERVER_URL}/timeout_member',
                       params={'server_id': server_id, 'account_id': get_user_id(member), 'minutes': 60})
        assert r.status_code == 200, f"timeout failed: {r.status_code} {r.text}"

        blocked = _send(member, channel_id)
        assert blocked.status_code == 403, f"timed-out send should be 403, got {blocked.status_code}"
        assert 'timed_out' in blocked.text, f"expected timed_out code, got {blocked.text}"

        owner.post(f'{TEST_SERVER_URL}/remove_timeout',
                   params={'server_id': server_id, 'account_id': get_user_id(member)})
        assert _send(member, channel_id).status_code == 200, "member should post after remove_timeout"
        return ("Timeout blocks messaging; removal restores it", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_timeout_clears_after_expiry():
    """Once expires_at passes, the timeout is treated as absent (lazy-deleted)."""
    try:
        owner = create_test_user(f"mod_owner_e_{_ts()}")
        member = create_test_user(f"mod_exp_{_ts()}")
        if not (owner and member):
            return ("Failed to create users", False)

        server_id = _make_community_server(owner)
        _join(member, server_id)
        channel_id = _general_channel(owner, server_id)
        member_id = get_user_id(member)

        owner.post(f'{TEST_SERVER_URL}/timeout_member',
                   params={'server_id': server_id, 'account_id': member_id, 'minutes': 60})
        assert _send(member, channel_id).status_code == 403, "should be blocked while active"

        # Fast-forward: put expires_at in the past directly in the DB.
        past = datetime.datetime.now() - datetime.timedelta(minutes=5)
        with _db_conn() as conn:
            conn.execute("UPDATE server_timeout SET expires_at = %s WHERE server = %s AND account = %s",
                         (past, server_id, member_id))

        assert _send(member, channel_id).status_code == 200, "should post once timeout expired"

        # The expired row should have been lazily deleted.
        with _db_conn() as conn:
            rows = conn.execute("SELECT * FROM server_timeout WHERE server = %s AND account = %s",
                                (server_id, member_id)).fetchall()
        assert not rows, f"expired timeout row should be lazy-deleted, found {rows}"
        return ("Timeout clears after expiry (lazy-deleted)", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_manage_messages_boundary():
    """A plain member cannot delete another's channel message; a manage-messages
    holder can. DMs stay sender-only (not exercised here)."""
    try:
        owner = create_test_user(f"mod_owner_m_{_ts()}")
        author = create_test_user(f"mod_author_{_ts()}")
        other = create_test_user(f"mod_other_{_ts()}")
        if not (owner and author and other):
            return ("Failed to create users", False)

        server_id = _make_community_server(owner)
        _join(author, server_id)
        _join(other, server_id)
        channel_id = _general_channel(owner, server_id)

        msg_id = _send(author, channel_id, 'delete me').json()['message']['id']

        # Plain member: forbidden.
        r1 = other.post(f'{TEST_SERVER_URL}/delete_message', params={'message_id': msg_id})
        assert r1.status_code == 403, f"plain member delete should be 403, got {r1.status_code}"

        # Grant manage-messages -> allowed.
        _grant(owner, server_id, get_user_id(other), {"manage-messages": ""})
        r2 = other.post(f'{TEST_SERVER_URL}/delete_message', params={'message_id': msg_id})
        assert r2.status_code == 200, f"manage-messages delete should be 200, got {r2.status_code} {r2.text}"
        return ("manage-messages permission boundary enforced", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_non_moderator_forbidden():
    """A member without any moderation right gets 403 from moderation endpoints."""
    try:
        owner = create_test_user(f"mod_owner_n_{_ts()}")
        member = create_test_user(f"mod_plain_{_ts()}")
        victim = create_test_user(f"mod_victim_{_ts()}")
        if not (owner and member and victim):
            return ("Failed to create users", False)

        server_id = _make_community_server(owner)
        _join(member, server_id)
        _join(victim, server_id)

        r = member.post(f'{TEST_SERVER_URL}/kick_member',
                        params={'server_id': server_id, 'account_id': get_user_id(victim)})
        assert r.status_code == 403, f"non-moderator kick should be 403, got {r.status_code}"
        assert _in_server(victim, server_id), "victim must remain after failed kick"
        return ("Non-moderator blocked from moderation endpoints", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def _ts():
    import time
    return int(time.time() * 1000)


# --------------------------------------------------------------------------
# Phase 2 tests (platform-level / op users)
# --------------------------------------------------------------------------

def _make_op_admin(session):
    """Turn `session`'s account into a platform op: own an op_servs server and
    hold the mycelium-admin right. Returns the op server id."""
    server_id = session.post(f'{TEST_SERVER_URL}/create_server').json()['id']
    with _db_conn() as conn:
        conn.execute("INSERT INTO op_servs (server) VALUES (%s) ON CONFLICT DO NOTHING", (server_id,))
    role_id = session.post(f'{TEST_SERVER_URL}/edit_server_role',
                           params={'server_id': server_id, 'action': 'create'}).json()['id']
    # Allowed because the server is now an op server; this path invalidates the
    # admin cache so isAdmin() reflects the change immediately.
    session.post(f'{TEST_SERVER_URL}/edit_server_role',
                 params={'server_id': server_id, 'action': 'edit', 'field': 'permissions',
                         'value': json.dumps({'mycelium-admin': ''}), 'targetId': role_id})
    session.post(f'{TEST_SERVER_URL}/edit_server_role',
                 params={'server_id': server_id, 'action': 'attribute',
                         'value': get_user_id(session), 'targetId': role_id})
    return server_id


def test_non_op_forbidden():
    """A non-op user is rejected (403) from every op-gated endpoint."""
    try:
        user = create_test_user(f"mod_nonop_{_ts()}")
        if not user:
            return ("Failed to create user", False)
        for path, params in [
            ('get_reports', {}),
            ('get_platform_action_log', {}),
            ('suspend_user', {'account_id': get_user_id(user), 'reason': 'x'}),
            ('platform_delete_message', {'message_id': 1, 'reason': 'x'}),
            ('platform_delete_server', {'server_id': 1, 'reason': 'x'}),
        ]:
            r = user.post(f'{TEST_SERVER_URL}/{path}', params=params)
            assert r.status_code == 403, f"{path} should be 403 for non-op, got {r.status_code}"
        return ("Non-op blocked from all op endpoints", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_suspend_cuts_off_access():
    """A suspended account can't make authenticated requests (account_suspended);
    unsuspend restores access."""
    try:
        admin = create_test_user(f"mod_admin_s_{_ts()}")
        target = create_test_user(f"mod_target_s_{_ts()}")
        if not (admin and target):
            return ("Failed to create users", False)
        _make_op_admin(admin)
        target_id = get_user_id(target)

        assert target.post(f'{TEST_SERVER_URL}/get_user_info').status_code == 200, "target ok before suspend"

        r = admin.post(f'{TEST_SERVER_URL}/suspend_user',
                       params={'account_id': target_id, 'reason': 'abuse'})
        assert r.status_code == 200, f"suspend failed: {r.status_code} {r.text}"

        blocked = target.post(f'{TEST_SERVER_URL}/get_user_info')
        assert blocked.status_code == 403, f"suspended request should be 403, got {blocked.status_code}"
        assert 'account_suspended' in blocked.text, f"expected account_suspended, got {blocked.text}"

        admin.post(f'{TEST_SERVER_URL}/unsuspend_user', params={'account_id': target_id})
        assert target.post(f'{TEST_SERVER_URL}/get_user_info').status_code == 200, "target ok after unsuspend"
        return ("Suspension cuts off access; unsuspend restores it", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_op_actions_logged():
    """Op actions are recorded in platform_action_log (visible to other ops)."""
    try:
        admin = create_test_user(f"mod_admin_l_{_ts()}")
        target = create_test_user(f"mod_target_l_{_ts()}")
        if not (admin and target):
            return ("Failed to create users", False)
        _make_op_admin(admin)
        target_id = get_user_id(target)

        admin.post(f'{TEST_SERVER_URL}/suspend_user',
                   params={'account_id': target_id, 'reason': 'logtest'})
        admin.post(f'{TEST_SERVER_URL}/unsuspend_user', params={'account_id': target_id})

        log = admin.get(f'{TEST_SERVER_URL}/get_platform_action_log').json()
        actions = [(e['action'], e['target_account']) for e in log]
        assert ('suspend_user', target_id) in actions, f"suspend not logged: {actions[:5]}"
        assert ('unsuspend_user', target_id) in actions, f"unsuspend not logged: {actions[:5]}"
        return ("Op actions land in platform_action_log", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_report_resolve_and_platform_delete():
    """A user reports a message; an op sees it in the queue, deletes the message
    platform-wide, and resolves the report."""
    try:
        admin = create_test_user(f"mod_admin_r_{_ts()}")
        owner = create_test_user(f"mod_owner_r_{_ts()}")
        author = create_test_user(f"mod_author_r_{_ts()}")
        reporter = create_test_user(f"mod_reporter_r_{_ts()}")
        if not (admin and owner and author and reporter):
            return ("Failed to create users", False)
        _make_op_admin(admin)

        server_id = _make_community_server(owner)
        _join(author, server_id)
        _join(reporter, server_id)
        channel_id = _general_channel(owner, server_id)
        msg_id = _send(author, channel_id, 'bad content').json()['message']['id']

        rep = reporter.post(f'{TEST_SERVER_URL}/report_content',
                            params={'target_message': msg_id, 'reason': 'spam'})
        assert rep.status_code == 200, f"report failed: {rep.status_code} {rep.text}"
        report_id = rep.json()['id']

        # Op sees it in the open queue.
        reports = admin.get(f'{TEST_SERVER_URL}/get_reports', params={'status': 'open'}).json()
        assert any(r['id'] == report_id for r in reports), "report not in open queue"

        # Op deletes the reported message platform-wide.
        d = admin.post(f'{TEST_SERVER_URL}/platform_delete_message',
                       params={'message_id': msg_id, 'reason': 'rule violation'})
        assert d.status_code == 200, f"platform delete failed: {d.status_code} {d.text}"
        with _db_conn() as conn:
            gone = conn.execute("SELECT * FROM message WHERE id = %s", (msg_id,)).fetchall()
        assert not gone, "message should be deleted"

        # Op resolves the report.
        res = admin.post(f'{TEST_SERVER_URL}/resolve_report',
                         params={'report_id': report_id, 'status': 'actioned'})
        assert res.status_code == 200, f"resolve failed: {res.status_code}"
        open_now = admin.get(f'{TEST_SERVER_URL}/get_reports', params={'status': 'open'}).json()
        assert not any(r['id'] == report_id for r in open_now), "report should no longer be open"
        return ("Report -> op resolves -> message removed", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def run():
    results = []
    # Phase 1 — server-level
    results.append(("Kick Member", test_kick_member()))
    results.append(("Ban Blocks Rejoin", test_ban_blocks_rejoin()))
    results.append(("Timeout Blocks Messaging", test_timeout_blocks_messaging()))
    results.append(("Timeout Clears After Expiry", test_timeout_clears_after_expiry()))
    results.append(("Manage-Messages Boundary", test_manage_messages_boundary()))
    results.append(("Non-Moderator Forbidden", test_non_moderator_forbidden()))
    # Phase 2 — platform-level
    results.append(("Non-Op Forbidden", test_non_op_forbidden()))
    results.append(("Suspend Cuts Off Access", test_suspend_cuts_off_access()))
    results.append(("Op Actions Logged", test_op_actions_logged()))
    results.append(("Report Resolve And Platform Delete", test_report_resolve_and_platform_delete()))
    # Flatten (name, (msg, ok)) → (label, ok): vesta's runner only checks
    # res[1] == False, so a nested tuple would always count as PASSED.
    return [(f"{name} — {msg}", ok) for name, (msg, ok) in results]
