"""Tests for drive channels — driveManager.py / routes/drive.py.

Covers: list_drive (content + ancestor path), folders from another drive
rejected (private-drive leak), rename (authority, invalid names), drive links
resolution (names never leak to members who can't see the drive) and the
download header with unusual filenames.
"""

import base64
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
    """Vesta sets the JWT/refresh cookies with the Secure flag; python-requests
    drops them over plain http unless the flag is stripped."""
    for cookie in session.cookies:
        cookie.secure = False


def create_test_user(username):
    """Register + verify a user (POST /login → OTP via /get_debug_otp → /signup)."""
    email = f"{username}@test.com"
    try:
        session = requests.Session()
        r = session.post(f'{TEST_SERVER_URL}/login', params={'email': email, 'password': 'Test123!'})
        _desecure(session)
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


def _make_community_server(owner):
    server_id = owner.post(f'{TEST_SERVER_URL}/create_server').json()['id']
    owner.post(f'{TEST_SERVER_URL}/edit_server_property',
               params={'property': 'is_community', 'server_id': server_id, 'value': 'true'})
    return server_id


def _join(session, server_id):
    return session.post(f'{TEST_SERVER_URL}/join_community_server', params={'server_id': server_id})


def _create_channel(owner, server_id, channel_type):
    r = owner.post(f'{TEST_SERVER_URL}/edit_server_channel',
                   params={'server_id': server_id, 'action': 'create', 'channel_type': channel_type})
    assert r.status_code == 200, f"create channel failed: {r.status_code} {r.text}"
    return r.json()['channel']['id']


def _make_private(owner, drive):
    r = owner.post(f'{TEST_SERVER_URL}/edit_channel_permissions',
                   params={'channelId': drive, 'channelType': 'drive', 'action': 'togglePrivacy'})
    assert r.status_code == 200 and r.json().get('is_private') is True, f"togglePrivacy failed: {r.text}"


def _folder(session, drive, name, parent=None):
    params = {'drive_id': drive, 'foldername': name}
    if parent:
        params['parent_folder'] = parent
    r = session.post(f'{TEST_SERVER_URL}/create_drive_folder', params=params)
    assert r.status_code == 200, f"create folder failed: {r.status_code} {r.text}"
    return r.json()['folder_id']


def _upload(session, drive, filename, text, parent=None):
    params = {'drive_id': drive, 'filename': filename}
    if parent:
        params['parent_folder'] = parent
    data = 'data:text/plain;base64,' + base64.b64encode(text.encode()).decode()
    r = session.post(f'{TEST_SERVER_URL}/upload_drive_file', params=params, json={'file': data})
    assert r.status_code == 200, f"upload failed: {r.status_code} {r.text}"
    return r.json()['file_id']


def _list(session, drive, folder=None):
    params = {'drive_id': drive}
    if folder:
        params['folder_id'] = folder
    return session.get(f'{TEST_SERVER_URL}/list_drive', params=params)


def _wrap(fn):
    def run_one():
        try:
            return fn()
        except AssertionError as e:
            return (f"Assertion failed: {e}", False)
        except Exception as e:
            return (f"Error: {type(e).__name__}: {e}", False)
    return run_one


# --------------------------------------------------------------------------
# tests
# --------------------------------------------------------------------------

def test_list_drive_with_path():
    """list_drive returns one folder's content and the path from the root."""
    owner = create_test_user(f"drv_own_a_{_ts()}")
    if not owner:
        return ("Failed to create user", False)
    server_id = _make_community_server(owner)
    drive = _create_channel(owner, server_id, 'drive')
    root = _folder(owner, drive, "racine")
    leaf = _folder(owner, drive, "feuille", root)
    file_id = _upload(owner, drive, "notes.txt", "hello", leaf)

    r = _list(owner, drive)
    assert r.status_code == 200, f"list root failed: {r.text}"
    body = r.json()
    assert body['path'] == [] and body['folder_id'] is None, f"bad root listing: {body}"
    assert [f['id'] for f in body['folders']] == [root], f"bad root folders: {body}"

    body = _list(owner, drive, leaf).json()
    assert [p['id'] for p in body['path']] == [root, leaf], f"bad path: {body['path']}"
    assert [f['id'] for f in body['files']] == [file_id], f"bad files: {body['files']}"
    assert body['files'][0]['uploader_name'], "uploader name missing"
    return ("Listing + path OK", True)


def test_foreign_folder_rejected():
    """A folder of a private drive can't be listed through another, visible drive."""
    owner = create_test_user(f"drv_own_b_{_ts()}")
    member = create_test_user(f"drv_mem_b_{_ts()}")
    if not (owner and member):
        return ("Failed to create users", False)
    server_id = _make_community_server(owner)
    _join(member, server_id)
    public = _create_channel(owner, server_id, 'drive')
    private = _create_channel(owner, server_id, 'drive')
    _make_private(owner, private)
    secret = _folder(owner, private, "secret")
    _upload(owner, private, "secret.txt", "classified", secret)

    assert _list(member, private).status_code == 403, "private drive must be refused"
    for endpoint, param in (('list_drive', 'folder_id'), ('get_drive_files', 'parent_folder'),
                            ('get_drive_folders', 'parent_folder')):
        r = member.get(f'{TEST_SERVER_URL}/{endpoint}', params={'drive_id': public, param: secret})
        assert r.status_code == 404, f"{endpoint} leaked a foreign folder: {r.status_code} {r.text}"
    return ("Foreign folders rejected", True)


def test_rename():
    """Authors rename their items; other members can't; names are validated."""
    owner = create_test_user(f"drv_own_c_{_ts()}")
    member = create_test_user(f"drv_mem_c_{_ts()}")
    if not (owner and member):
        return ("Failed to create users", False)
    server_id = _make_community_server(owner)
    _join(member, server_id)
    drive = _create_channel(owner, server_id, 'drive')
    folder = _folder(owner, drive, "avant")
    file_id = _upload(owner, drive, "a.txt", "a")

    def rename(session, item_type, item_id, name):
        return session.post(f'{TEST_SERVER_URL}/rename_drive_item',
                            params={'item_type': item_type, 'item_id': item_id, 'name': name})

    assert rename(owner, 'folder', folder, 'après').status_code == 200
    assert rename(owner, 'file', file_id, 'b.txt').status_code == 200
    body = _list(owner, drive).json()
    assert body['folders'][0]['foldername'] == 'après', f"folder not renamed: {body}"
    assert body['files'][0]['filename'] == 'b.txt', f"file not renamed: {body}"

    assert rename(member, 'file', file_id, 'pirate.txt').status_code == 403, "member renamed owner's file"
    assert rename(owner, 'file', file_id, 'a/b.txt').status_code == 400, "'/' must be refused"
    assert rename(owner, 'file', file_id, '   ').status_code == 400, "empty name must be refused"
    return ("Rename authority + validation OK", True)


def test_links():
    """drive_links resolves names and paths, and hides what the caller can't see."""
    owner = create_test_user(f"drv_own_d_{_ts()}")
    member = create_test_user(f"drv_mem_d_{_ts()}")
    if not (owner and member):
        return ("Failed to create users", False)
    server_id = _make_community_server(owner)
    _join(member, server_id)
    drive = _create_channel(owner, server_id, 'drive')
    private = _create_channel(owner, server_id, 'drive')
    _make_private(owner, private)
    folder = _folder(owner, drive, "dossier")
    file_id = _upload(owner, drive, "rapport.txt", "contenu", folder)
    hidden = _upload(owner, private, "cache.txt", "secret")

    # An unprefixed id is a textual channel or a forum, never a drive
    refs = [f"drive:{drive}", f"drive:{drive}/d:{folder}", f"drive:{drive}/f:{file_id}",
            f"drive:{private}/f:{hidden}", f"drive:{drive}/f:{hidden}", f"{drive}", "garbage"]
    r = member.get(f'{TEST_SERVER_URL}/drive_links', params={'refs': json.dumps(refs)})
    assert r.status_code == 200, f"drive_links failed: {r.text}"
    links = r.json()
    assert links[f"drive:{drive}"]['kind'] == 'drive', links
    assert links[f"drive:{drive}/d:{folder}"]['name'] == 'dossier', links
    file_link = links[f"drive:{drive}/f:{file_id}"]
    assert file_link['name'] == 'rapport.txt' and file_link['server'] == server_id, links
    assert [p['id'] for p in file_link['path']] == [folder], links
    assert links[f"drive:{private}/f:{hidden}"] == {'ok': False}, "private file leaked"
    assert links[f"drive:{drive}/f:{hidden}"] == {'ok': False}, "file of another drive accepted"
    assert f"{drive}" not in links and 'garbage' not in links, links
    return ("Links resolved and filtered", True)


def test_download_header():
    """Quotes/accents in a filename don't break the Content-Disposition header."""
    owner = create_test_user(f"drv_own_e_{_ts()}")
    if not owner:
        return ("Failed to create user", False)
    server_id = _make_community_server(owner)
    drive = _create_channel(owner, server_id, 'drive')
    file_id = _upload(owner, drive, 'ré"sumé.txt', "x")
    r = owner.get(f'{TEST_SERVER_URL}/download_drive_file', params={'file_id': file_id})
    assert r.status_code == 200, f"download failed: {r.status_code}"
    disposition = r.headers.get('Content-Disposition', '')
    assert "filename*=UTF-8''r%C3%A9%22sum%C3%A9.txt" in disposition, disposition
    assert disposition.count('"') == 2, f"unescaped quote: {disposition}"
    return ("Download header escaped", True)


def run():
    results = []
    for name, fn in [
        ("Drive Listing + Path", test_list_drive_with_path),
        ("Drive Foreign Folder", test_foreign_folder_rejected),
        ("Drive Rename", test_rename),
        ("Drive Links", test_links),
        ("Drive Download Header", test_download_header),
    ]:
        msg, ok = _wrap(fn)()
        results.append((f"{name} — {msg}", ok))
    return results
