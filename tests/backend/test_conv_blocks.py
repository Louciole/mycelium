"""Interactive conversation blocks — routes/conv_blocks.py.

The server only stores blocks: JSON settings and items it doesn't read, created
through send_message(conv_block=…) and edited through the *_conv_block*
endpoints (what a tricount or a checklist means lives in static/conv-blocks.mjs).
Covers what it does keep: storage and merging, versions and `if_version`
conflicts, authors, limits, sheet cells, access (outsiders, DM vs channel), and
that messages come back enriched with their blocks.

Runs against the real dev server, like test_search.py:
TEST_SERVER_URL=http://localhost:9876 python -c "import tests.backend.test_conv_blocks as t; [print(ok, l) for l, ok in t.run()]"
"""

import json

from tests.backend.test_search import (
    TEST_SERVER_URL,
    create_test_user,
    _ts,
    _make_community_server,
    _join,
    _create_channel,
)


def _uid(session):
    return session.post(f'{TEST_SERVER_URL}/get_user_info').json()['id']


def _insert(session, conv, spec):
    return session.post(f'{TEST_SERVER_URL}/send_message',
                        params={'conv': json.dumps(conv), 'content': '', 'reply': ''},
                        json={'conv_block': spec})


def _call(session, endpoint, **body):
    return session.post(f'{TEST_SERVER_URL}/{endpoint}', json=body)


def _conflict(r):
    return r.status_code == 409 and r.text.endswith("Version conflict")


def test_block_storage_in_dm():
    """A block in a DM: settings and items stored as sent, merged on edit, every
    change versioned and stamped with its editor; `if_version` refuses stale edits;
    outsiders can't read or write; history comes back with every block."""
    try:
        a = create_test_user(f"cblk_dm_a_{_ts()}")
        b = create_test_user(f"cblk_dm_b_{_ts()}")
        outsider = create_test_user(f"cblk_dm_o_{_ts()}")
        if not (a and b and outsider):
            return ("Failed to create users", False)
        ua, ub = _uid(a), _uid(b)

        settings = {'title': '', 'currency': '€', 'participants': [{'id': 'pa', 'name': 'A', 'account': ua}]}
        r = _insert(a, {'dest': ub}, {'type': 'tricount', 'template': 'default', 'settings': settings})
        assert r.status_code == 200, f"insert failed: {r.status_code} {r.text}"
        msg = r.json()['message']
        assert msg.get('timestamp'), "the new message must carry its timestamp"
        block = msg['convBlock']
        assert block['settings'] == settings and block['items'] == [] and block['version'] == 0, block
        uuid, conv_id = block['uuid'], msg['place']

        # Items: stored as sent, author and last editor stamped by the server
        r = _call(a, 'add_conv_block_item', block_uuid=uuid, data={'label': 'Pizza', 'amount': 3050})
        assert r.status_code == 200, f"add failed: {r.status_code} {r.text}"
        state = r.json()
        item = state['items'][0]
        assert item['data'] == {'label': 'Pizza', 'amount': 3050}, item
        assert item['author'] == ua and item['updatedBy'] == ua and item['version'] == 0, item
        assert state['version'] == 1, state

        # Edits merge their keys; the editor and the versions follow
        r = _call(b, 'edit_conv_block_item', block_uuid=uuid, item_id=item['id'],
                  data={'amount': 3100, 'note': None}, if_version=0)
        assert r.status_code == 200, f"edit failed: {r.status_code} {r.text}"
        item = r.json()['items'][0]
        assert item['data'] == {'label': 'Pizza', 'amount': 3100, 'note': None}, item
        assert item['updatedBy'] == ub and item['author'] == ua and item['version'] == 1, item

        # A change made against an older version is refused
        assert _conflict(_call(a, 'edit_conv_block_item', block_uuid=uuid, item_id=item['id'],
                               data={'amount': 1}, if_version=0)), "stale item edit should conflict"
        assert _conflict(_call(a, 'delete_conv_block_item', block_uuid=uuid, item_id=item['id'], if_version=0))
        assert _conflict(_call(a, 'edit_conv_block', block_uuid=uuid, settings={'title': 'x'}, if_version=0))
        assert _conflict(_call(a, 'add_conv_block_item', block_uuid=uuid, data={}, if_version=0))
        # An item edit can depend on the block too (the participants an expense names)
        assert _conflict(_call(a, 'edit_conv_block_item', block_uuid=uuid, item_id=item['id'],
                               data={'amount': 1}, if_version=1, if_block_version=1)), "stale block should conflict"

        r = _call(a, 'edit_conv_block', block_uuid=uuid, settings={'title': 'Lyon'}, if_version=2)
        assert r.status_code == 200, f"settings edit failed: {r.status_code} {r.text}"
        s = r.json()
        assert s['settings'] == {**settings, 'title': 'Lyon'} and s['version'] == 3, s

        # Malformed input
        for bad in ('not json', '[1, 2]', 42):
            r = _call(a, 'edit_conv_block', block_uuid=uuid, settings=bad)
            assert r.status_code == 400, f"settings {bad!r} should be 400, got {r.status_code}"
        assert _call(a, 'edit_conv_block', block_uuid=uuid, settings={}, if_version='x').status_code == 400
        assert _call(a, 'add_conv_block_item', block_uuid=uuid, data={'text': 'x' * 5000}).status_code == 413
        assert _call(a, 'edit_conv_block', block_uuid=uuid, settings={'big': 'x' * 17000}).status_code == 413
        assert _call(a, 'edit_conv_block_item', block_uuid=uuid, item_id='x', data={}).status_code == 400
        assert _call(a, 'edit_conv_block_item', block_uuid=uuid, item_id=999999999, data={}).status_code == 404

        # Outsiders: no read, no write
        assert outsider.post(f'{TEST_SERVER_URL}/get_conv_block', params={'block_uuid': uuid}).status_code == 403
        assert _call(outsider, 'add_conv_block_item', block_uuid=uuid, data={}).status_code == 403
        assert _call(outsider, 'edit_conv_block', block_uuid=uuid, settings={'title': 'x'}).status_code == 403

        # Delete
        r = _call(b, 'delete_conv_block_item', block_uuid=uuid, item_id=item['id'])
        assert r.json()['items'] == [], r.text
        assert _call(b, 'delete_conv_block_item', block_uuid=uuid, item_id=item['id']).status_code == 404

        # History: every block of the page enriched (one batch), the sheets too
        uuids = {uuid}
        for spec in ({'type': 'checklist', 'template': 'potluck', 'settings': {'mode': 'claim'}},
                     {'type': 'checklist'}):
            r = _insert(a, {'id': conv_id}, spec)
            assert r.status_code == 200, f"insert failed: {r.status_code} {r.text}"
            uuids.add(r.json()['message']['convBlock']['uuid'])
        sheet = _insert(b, {'id': conv_id}, {'type': 'spreadsheet'}).json()['message']['convSpreadsheet']
        history = b.post(f'{TEST_SERVER_URL}/get_conv_content', params={'conv_id': conv_id}).json()['messages']
        got = {m['convBlock']['uuid'] for m in history if m.get('convBlock')}
        assert got == uuids, f"every block of the page should be enriched: {got} vs {uuids}"
        assert any(m.get('convSpreadsheet', {}).get('uuid') == sheet['uuid'] for m in history), "sheet not enriched"
        enriched = next(m['convBlock'] for m in history if m.get('convBlock', {}).get('uuid') == uuid)
        assert enriched['settings']['title'] == 'Lyon', enriched
        return ("Blocks in a DM: storage, merge, versions, conflicts, limits, access, history", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_blocks_in_channel():
    """In a server channel: any member edits, outsiders can't; block types and
    templates are names, anything else is refused."""
    try:
        owner = create_test_user(f"cblk_chan_own_{_ts()}")
        member = create_test_user(f"cblk_chan_mem_{_ts()}")
        outsider = create_test_user(f"cblk_chan_out_{_ts()}")
        if not (owner and member and outsider):
            return ("Failed to create users", False)
        server_id = _make_community_server(owner)
        _join(member, server_id)
        chan = _create_channel(owner, server_id, 'textual')

        for bad in ({'type': ''}, {'type': 'Weather!'}, {'type': 'checklist', 'template': '../x'},
                    {'type': 'checklist', 'settings': [1]}, {'type': 'x' * 30}):
            assert _insert(owner, {'id': chan}, bad).status_code == 400, f"{bad} should be 400"
        assert _insert(outsider, {'id': chan}, {'type': 'checklist'}).status_code == 403, "outsider insert"

        r = _insert(owner, {'id': chan}, {'type': 'checklist', 'template': 'potluck', 'settings': {'mode': 'claim'}})
        assert r.status_code == 200, f"insert failed: {r.status_code} {r.text}"
        block = r.json()['message']['convBlock']
        assert (block['type'], block['template'], block['settings']) == ('checklist', 'potluck', {'mode': 'claim'})
        uuid = block['uuid']

        r = _call(member, 'add_conv_block_item', block_uuid=uuid, data={'text': 'Chips', 'done': False})
        item = r.json()['items'][0]
        assert item['author'] == _uid(member), item
        # Two people taking on the same item: the second one, on the old version, conflicts
        r = _call(member, 'edit_conv_block_item', block_uuid=uuid, item_id=item['id'],
                  data={'claimed_by': _uid(member)}, if_version=item['version'])
        assert r.status_code == 200, r.text
        r = _call(owner, 'edit_conv_block_item', block_uuid=uuid, item_id=item['id'],
                  data={'claimed_by': _uid(owner)}, if_version=item['version'])
        assert _conflict(r), f"the second claim should conflict, got {r.status_code} {r.text}"

        assert _call(outsider, 'delete_conv_block_item', block_uuid=uuid, item_id=item['id']).status_code == 403
        r = _call(owner, 'delete_conv_block_item', block_uuid=uuid, item_id=item['id'])
        assert r.status_code == 200 and r.json()['items'] == [], r.text
        return ("Blocks in a channel: members edit, outsiders can't, names checked", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_sheet_blocks():
    """A sheet block is created with the cells its template gives (values, header
    colors); sizes, positions and colors are checked."""
    try:
        owner = create_test_user(f"cblk_sht_{_ts()}")
        if not owner:
            return ("Failed to create user", False)
        server_id = _make_community_server(owner)
        chan = _create_channel(owner, server_id, 'textual')

        cells = [{'col': 0, 'row': 1, 'value': 'Manche', 'bg': '#ffffff14'},
                 {'col': 1, 'row': 1, 'value': '', 'bg': '#ffffff14'},
                 {'col': 1, 'row': 8, 'value': '=SUM(B2:B7)'}]
        r = _insert(owner, {'id': chan}, {'type': 'spreadsheet', 'template': 'scores', 'rows': 8, 'cols': 5, 'cells': cells})
        assert r.status_code == 200, f"insert failed: {r.status_code} {r.text}"
        msg = r.json()['message']
        sheet = msg['convSpreadsheet']
        assert (sheet['rows'], sheet['cols']) == (8, 5), sheet
        assert sheet['cells'] == {'A1': 'Manche', 'B8': '=SUM(B2:B7)'}, sheet['cells']
        assert json.loads(msg['attachments'])[0] == {'type': 'conv_spreadsheet', 'uuid': sheet['uuid'], 'template': 'scores'}
        content = owner.post(f'{TEST_SERVER_URL}/get_spreadsheet_content',
                             params={'block_uuid': sheet['uuid'], 'conv_id': chan}).json()
        assert content['cell_formats']['A1']['bg'] and content['cell_formats']['B1']['bg'], "header row not shaded"

        empty = _insert(owner, {'id': chan}, {'type': 'spreadsheet'}).json()['message']['convSpreadsheet']
        assert (empty['rows'], empty['cols'], empty['cells']) == (5, 3, {}), empty

        for bad in ({'rows': 0}, {'cols': 27}, {'rows': True}, {'cells': 'x'},
                    {'cells': [{'col': 3, 'row': 1, 'value': 'x'}]},                     # outside the 3 columns
                    {'cells': [{'col': 0, 'row': 0, 'value': 'x'}]},                     # rows count from 1
                    {'cells': [{'col': 0, 'row': 1, 'value': 'x'}, {'col': 0, 'row': 1, 'value': 'y'}]},
                    {'cells': [{'col': 0, 'row': 1, 'value': 'x', 'bg': 'red;}'}]},
                    {'cells': [{'col': 0, 'row': 1, 'value': 'x' * 1001}]}):
            r = _insert(owner, {'id': chan}, {'type': 'spreadsheet', **bad})
            assert r.status_code == 400, f"{bad} should be 400, got {r.status_code}"
        return ("Sheet blocks: template cells, colors, checks", True)
    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def run():
    results = []
    for name, fn in [
        ("Conv Block DM", test_block_storage_in_dm),
        ("Conv Block Channel", test_blocks_in_channel),
        ("Conv Block Sheets", test_sheet_blocks),
    ]:
        msg, ok = fn()
        results.append((f"{name} — {msg}", ok))
    return results
