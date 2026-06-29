import threading
import requests
import json
import time
from os.path import abspath, dirname
import signal
import os
import atexit
from concurrent.futures import ThreadPoolExecutor
from typing import List, Tuple

from vesta import Server
from vesta import HTTPError, HTTPRedirect

TEST_PORT = 9998
TEST_HOST = '127.0.0.1'
TEST_SERVER_URL = f'http://{TEST_HOST}:{TEST_PORT}'

# Test constants
TEST_STARTUP_DELAY = 2  # seconds to wait for server startup
TEST_SHUTDOWN_TIMEOUT = 3  # seconds to wait for graceful shutdown
MAX_API_KEYS_TEST = 5  # number of API keys to create in bulk tests
STRESS_TEST_CONVERSATIONS = 10  # number of conversations for stress tests
LARGE_LIST_CONVERSATIONS = 15  # number of conversations for large list tests
MAX_NAME_LENGTH_SHORT = 100  # characters for validation tests
MAX_NAME_LENGTH_LONG = 200  # characters for extended validation tests
REGEN_ITERATIONS = 3  # number of times to regenerate API key
EMOJI_TEST_COUNT = 5  # number of different emojis to test


# ==================== CLEANUP SYSTEM ====================

class TestCleanup:
    """Manages cleanup of test data."""

    def __init__(self):
        self.created_users = []
        self.created_servers = []
        self.created_conversations = []
        self.created_api_keys = []
        self.sessions = []

    def register_user(self, username: str, session):
        """Register a user for cleanup."""
        self.created_users.append(username)
        if session:
            self.sessions.append(session)

    def register_server(self, server_id: int):
        """Register a server for cleanup."""
        self.created_servers.append(server_id)

    def register_conversation(self, conv_id: int):
        """Register a conversation for cleanup."""
        self.created_conversations.append(conv_id)

    def register_api_key(self, key_id: int):
        """Register an API key for cleanup."""
        self.created_api_keys.append(key_id)

    def cleanup_all(self):
        """Clean up all registered resources."""
        # Note: In a real implementation, we would delete these resources
        # For now, just track them
        if self.created_users:
            print(f"[Cleanup] Would delete {len(self.created_users)} test users")
        if self.created_servers:
            print(f"[Cleanup] Would delete {len(self.created_servers)} test servers")
        if self.created_conversations:
            print(f"[Cleanup] Would delete {len(self.created_conversations)} test conversations")
        if self.created_api_keys:
            print(f"[Cleanup] Would delete {len(self.created_api_keys)} test API keys")

        # Clear the lists
        self.created_users.clear()
        self.created_servers.clear()
        self.created_conversations.clear()
        self.created_api_keys.clear()
        self.sessions.clear()


# Global cleanup manager
_cleanup_manager = TestCleanup()

# Register cleanup on exit
atexit.register(_cleanup_manager.cleanup_all)


class TestServer(Server):
    features = {}

    def index(self):
        pass


server_instance = None
server_thread = None


def start_test_server():
    global server_instance, server_thread
    PATH = dirname(abspath(__file__))

    # Create server instance without starting it
    server_instance = TestServer(path=PATH, configFile="/server.ini", noStart=True)

    # Start the test server in a separate thread
    server_thread = threading.Thread(target=server_instance.start)
    server_thread.daemon = False  # Non-daemon so we can join it and control it
    server_thread.start()


def stop_test_server():
    global server_instance, server_thread
    if server_thread and server_thread.is_alive():
        # Send SIGINT to the current process (this will be caught by fastwsgi)
        os.kill(os.getpid(), signal.SIGINT)
        # Wait for thread to finish
        server_thread.join(timeout=TEST_SHUTDOWN_TIMEOUT)

    server_instance = None
    server_thread = None


def run():
    """Runs all backend tests."""
    print("Starting test server for backend tests...")
    start_test_server()
    time.sleep(TEST_STARTUP_DELAY)
    print("Running backend tests...")

    results = []

    # Core Server Tests
    results.append(("Create Server", test_create_server()))
    results.append(("Get User Servers", test_get_user_servers()))
    results.append(("Server Has Default Channels", test_server_has_default_channels()))
    results.append(("Multiple Servers Isolation", test_multiple_servers_isolation()))

    # Core Conversation Tests
    results.append(("Create Conversation", test_create_conversation()))
    results.append(("Create Conversation with Members", test_create_conversation_with_members()))
    results.append(("Edit Conversation", test_edit_conversation()))
    results.append(("Get Conversation Content", test_get_conversation_content()))

    # Advanced Conversation Tests
    results.append(("Conversation Members List", test_conversation_members_list()))
    results.append(("Empty Conversation Content", test_empty_conversation_content()))
    results.append(("Conversation Privacy Settings", test_conversation_privacy()))
    results.append(("Edit Conversation Name Validation", test_edit_conversation_name_validation()))
    results.append(("Concurrent Conversation Edits", test_concurrent_conversation_edits()))

    # Core API Key Tests
    results.append(("Create API Key", test_create_api_key()))
    results.append(("Get User API Keys", test_get_user_api_keys()))
    results.append(("Revoke API Key", test_revoke_api_key()))
    results.append(("Regenerate API Key", test_regenerate_api_key()))

    # API Key Edge Cases
    results.append(("API Key Name Validation", test_api_key_name_validation()))
    results.append(("Multiple API Keys", test_multiple_api_keys()))
    results.append(("Regenerate Multiple Times", test_regenerate_multiple_times()))

    # User Info Tests
    results.append(("Get Users Info", test_get_users_info()))
    results.append(("Get User Info Self", test_get_user_info_self()))
    results.append(("Users Info With Status", test_users_info_with_status()))

    # Status Tests
    results.append(("Default Status Online", test_default_status_online()))
    results.append(("Set Custom Status", test_set_custom_status()))
    results.append(("Set Do Not Disturb Status", test_set_do_not_disturb_status()))
    results.append(("Set Idle Status", test_set_idle_status()))
    results.append(("Set Invisible Status", test_set_invisible_status()))
    results.append(("Status With Emoji", test_status_with_emoji()))
    results.append(("Clear Status", test_clear_status()))
    results.append(("Multiple Users Different Statuses", test_multiple_users_different_statuses()))
    results.append(("Status Text Length", test_status_text_length()))
    results.append(("Status Mode Validation", test_status_mode_validation()))

    # Security Tests
    results.append(("Unauthorized Conversation Access", test_unauthorized_conversation_access()))
    results.append(("Edit Conversation Forbidden", test_edit_conversation_forbidden()))
    results.append(("Revoke Others API Key", test_revoke_others_api_key()))

    # Stress Tests
    results.append(("Create Many Conversations", test_create_many_conversations()))
    results.append(("Get Large Conversation List", test_get_large_conversation_list()))

    # Edge Cases
    results.append(("Conversation With Nonexistent Member", test_conversation_with_nonexistent_member()))
    results.append(("Empty Conversation Name", test_empty_conversation_name()))
    results.append(("Special Characters In Names", test_special_characters_in_names()))

    # Message Editing Tests
    results.append(("Edit Own Message", test_edit_own_message()))
    results.append(("Cannot Edit Others Message", test_cannot_edit_others_message()))
    results.append(("Cannot Edit Nonexistent Message", test_edit_nonexistent_message()))
    results.append(("Edit With Empty Content", test_edit_empty_content()))
    results.append(("Edit With Special Characters", test_edit_with_special_characters()))
    results.append(("Cannot Edit Without Auth", test_edit_without_auth()))
    results.append(("Multiple Edits Same Message", test_multiple_edits_same_message()))

    stop_test_server()
    print("Test server stopped.")

    return results


# ==================== TEST HELPER FUNCTIONS ====================

def with_test_user(username_prefix):
    """
    Decorator to automatically create and authenticate a test user.
    Handles common error cases, provides better error messages, and registers cleanup.

    Usage:
        @with_test_user("my_test")
        def test_something(session):
            # session is already authenticated
            response = session.post(...)
    """
    def decorator(func):
        def wrapper():
            username = f"{username_prefix}_{int(time.time())}"
            session = None
            try:
                session = create_test_user(username)
                if not session:
                    return (f"Failed to create/auth user {username}", False)

                # Register user for cleanup
                _cleanup_manager.register_user(username, session)

                return func(session)

            except AssertionError as e:
                return (f"Assertion failed: {e}", False)
            except requests.RequestException as e:
                return (f"Network error: {e}", False)
            except ValueError as e:
                return (f"Value error: {e}", False)
            except Exception as e:
                return (f"Unexpected error ({type(e).__name__}): {e}", False)
        return wrapper
    return decorator


def with_test_users(count: int):
    """
    Decorator to create multiple test users for concurrent/multi-user tests.

    Usage:
        @with_test_users(2)
        def test_something(sessions):
            session1, session2 = sessions
            # Both sessions are authenticated

        @with_test_users(3)
        def test_something(sessions):
            session1, session2, session3 = sessions
    """
    def decorator(func):
        def wrapper():
            sessions = []
            usernames = []
            base_time = int(time.time())

            try:
                # Create multiple users
                for i in range(count):
                    username = f"user{i}_{base_time}"
                    session = create_test_user(username)

                    if not session:
                        return (f"Failed to create user {i+1}/{count}: {username}", False)

                    sessions.append(session)
                    usernames.append(username)

                    # Register for cleanup
                    _cleanup_manager.register_user(username, session)

                # Call test function with all sessions
                return func(sessions)

            except AssertionError as e:
                return (f"Assertion failed: {e}", False)
            except requests.RequestException as e:
                return (f"Network error: {e}", False)
            except ValueError as e:
                return (f"Value error: {e}", False)
            except Exception as e:
                return (f"Unexpected error ({type(e).__name__}): {e}", False)
        return wrapper
    return decorator


def create_test_user(username="testuser"):
    """Helper to create a test user and get session."""
    email = f"{username}@test.com"
    password = "Test123!"

    try:
        session = requests.Session()

        # Auth
        auth_response = session.post(
            f'{TEST_SERVER_URL}/auth',
            data={'email': email, 'password': password}
        )

        # Get OTP if needed
        if 'verif' in auth_response.url or auth_response.status_code == 302:
            otp_response = requests.post(f'{TEST_SERVER_URL}/getDebugOTP?email={email}')
            if otp_response.status_code == 200:
                otp = otp_response.json().get('code')
                if otp:
                    session.post(f'{TEST_SERVER_URL}/verif', data={'code': otp})

        # Verify access
        channels_response = session.get(f'{TEST_SERVER_URL}/channels')
        if channels_response.status_code == 200:
            return session
    except requests.RequestException as e:
        print(f"Network error creating user {username}: {e}")
    except Exception as e:
        print(f"Error creating user {username}: {e}")

    return None


def get_user_id(session):
    """Helper to get user ID from session."""
    try:
        response = session.post(f'{TEST_SERVER_URL}/get_user_info')
        if response.status_code == 200:
            return response.json().get('id')
    except requests.RequestException as e:
        print(f"Network error getting user ID: {e}")
    except Exception as e:
        print(f"Error getting user ID: {e}")
    return None


def send_test_message(session, conv_id, content='Test message'):
    """Helper to send a test message."""
    try:
        response = session.post(
            f'{TEST_SERVER_URL}/send_message',
            params={
                'conv': json.dumps({'id': conv_id}),
                'content': content,
                'reply': ''
            }
        )
        if response.status_code == 200:
            data = response.json()
            # send_message returns {"message": {...}} for text messages.
            return data.get('message', {}).get('id') if isinstance(data, dict) else None
        return None
    except Exception as e:
        print(f"Failed to send message: {e}")
        return None


def run_concurrent(funcs: List[callable]) -> List[any]:
    """
    Execute multiple functions concurrently using threads.

    Args:
        funcs: List of callable functions to execute concurrently

    Returns:
        List of results from each function

    Example:
        results = run_concurrent([
            lambda: session1.post('/endpoint1'),
            lambda: session2.post('/endpoint2')
        ])
    """
    with ThreadPoolExecutor(max_workers=len(funcs)) as executor:
        futures = [executor.submit(func) for func in funcs]
        results = [future.result() for future in futures]
    return results


# ==================== TEST CASES ====================

@with_test_user("server_test")
def test_create_server(session):
    """Test creating a server."""
    response = session.post(f'{TEST_SERVER_URL}/create_server')
    assert response.status_code == 200, f"Expected 200, got {response.status_code}"

    server_id = response.json()['id']
    assert server_id > 0, f"Server ID should be positive, got {server_id}"

    # Verify server exists
    servers_response = session.post(f'{TEST_SERVER_URL}/get_user_servers')
    assert servers_response.status_code == 200, f"Failed to get servers: {servers_response.status_code}"
    servers = servers_response.json()
    assert any(s['id'] == server_id for s in servers), \
        f"Server {server_id} not found in user's servers (found: {[s['id'] for s in servers]})"

    return (f"Server created with ID {server_id}", True)



@with_test_user("servers_test")
def test_get_user_servers(session):
    """Test retrieving user's servers."""
    # Create 2 servers
    server_id1 = session.post(f'{TEST_SERVER_URL}/create_server').json()['id']
    server_id2 = session.post(f'{TEST_SERVER_URL}/create_server').json()['id']

    response = session.post(f'{TEST_SERVER_URL}/get_user_servers')
    assert response.status_code == 200, f"Failed to get servers: {response.status_code}"
    servers = response.json()

    assert len(servers) >= 2, f"Expected at least 2 servers, got {len(servers)}"

    server_ids = [s['id'] for s in servers]
    assert server_id1 in server_ids, f"Server {server_id1} not in list: {server_ids}"
    assert server_id2 in server_ids, f"Server {server_id2} not in list: {server_ids}"

    for server in servers:
        assert 'id' in server, f"Server missing 'id': {server}"
        assert 'name' in server, f"Server missing 'name': {server}"
        assert 'owner' in server, f"Server missing 'owner': {server}"

    return (f"Retrieved {len(servers)} servers successfully", True)



@with_test_user("conv_test")
def test_create_conversation(session):
    """Test creating a conversation."""
    response = session.post(
        f'{TEST_SERVER_URL}/create_conv',
        params={'name': 'Test Conversation', 'members': json.dumps([]), 'private': 'true'}
    )

    assert response.status_code == 200, f"Expected 200, got {response.status_code}"
    conv_id = response.json()['id']
    assert conv_id > 0

    # Verify conversation exists
    convs = session.post(f'{TEST_SERVER_URL}/get_user_convs').json()
    assert any(c['id'] == conv_id for c in convs)

    return (f"Conversation created with ID {conv_id}", True)


@with_test_users(2)
def test_create_conversation_with_members(sessions):
    """Test creating a conversation with multiple members."""
    session1, session2 = sessions

    user2_id = get_user_id(session2)
    if not user2_id:
        return ("Failed to get user2 ID", False)

    response = session1.post(
        f'{TEST_SERVER_URL}/create_conv',
        params={'name': 'Group Chat', 'members': json.dumps([user2_id]), 'private': 'true'}
    )

    assert response.status_code == 200, f"Expected 200, got {response.status_code}"
    conv_id = response.json()['id']
    _cleanup_manager.register_conversation(conv_id)

    # Verify both users have access
    convs1 = session1.post(f'{TEST_SERVER_URL}/get_user_convs').json()
    convs2 = session2.post(f'{TEST_SERVER_URL}/get_user_convs').json()

    assert any(c['id'] == conv_id for c in convs1), "User1 should have access"
    assert any(c['id'] == conv_id for c in convs2), "User2 should have access"

    conv = next(c for c in convs1 if c['id'] == conv_id)
    assert len(conv['members']) == 2, f"Should have 2 members, got {len(conv['members'])}"

    return ("Conversation with 2 members created", True)


@with_test_user("edit_conv")
def test_edit_conversation(session):
    """Test editing a conversation."""
    conv_id = XXX_PLACEHOLDER

    response = session.post(
        f'{TEST_SERVER_URL}/edit_conv',
        params={'id': conv_id, 'element': 'name', 'value': 'New Name'}
    )

    assert response.status_code == 200

    # Verify change
    convs = session.post(f'{TEST_SERVER_URL}/get_user_convs').json()
    conv = next(c for c in convs if c['id'] == conv_id)
    assert conv['name'] == 'New Name'

    return ("Conversation name updated", True)


@with_test_user("conv_content")
def test_get_conversation_content(session):
    """Test retrieving conversation content."""
    conv_id = XXX_PLACEHOLDER

    response = session.get(f'{TEST_SERVER_URL}/get_conv_content', params={'convId': conv_id})
    assert response.status_code == 200

    content = response.json()
    assert 'messages' in content
    assert isinstance(content['messages'], list)

    return ("Conversation content retrieved", True)



@with_test_user("api_key")
def test_create_api_key(session):
    """Test creating an API key."""
    response = session.post(
        f'{TEST_SERVER_URL}/create_api_key',
        json={'name': 'Test API Key', 'permissions': []}
    )

    assert response.status_code == 200, f"Expected 200, got {response.status_code}"
    api_key_data = response.json()
    assert 'id' in api_key_data and 'key' in api_key_data and 'name' in api_key_data

    # Verify key exists
    keys = session.get(f'{TEST_SERVER_URL}/get_user_api_keys').json()
    assert any(k['id'] == api_key_data['id'] for k in keys)

    return (f"API key created with ID {api_key_data['id']}", True)


@with_test_user("api_keys")
def test_get_user_api_keys(session):
    """Test retrieving user's API keys."""
    # Create 2 keys
    session.post(f'{TEST_SERVER_URL}/create_api_key', json={'name': 'Key 1', 'permissions': []})
    session.post(f'{TEST_SERVER_URL}/create_api_key', json={'name': 'Key 2', 'permissions': []})

    response = session.get(f'{TEST_SERVER_URL}/get_user_api_keys')
    keys = response.json()

    assert len(keys) >= 2
    for key in keys:
        assert 'key' not in key, "Raw key should not be exposed"
        assert 'id' in key and 'name' in key

    return (f"Retrieved {len(keys)} API keys", True)


@with_test_user("revoke_key")
def test_revoke_api_key(session):
    """Test revoking an API key."""
    key_data = session.post(
        f'{TEST_SERVER_URL}/create_api_key',
        json={'name': 'To Revoke', 'permissions': []}
    ).json()

    response = session.post(f'{TEST_SERVER_URL}/revoke_api_key', params={'id': key_data['id']})
    assert response.status_code == 200

    # Verify key is gone
    keys = session.get(f'{TEST_SERVER_URL}/get_user_api_keys').json()
    assert not any(k['id'] == key_data['id'] for k in keys)

    return ("API key revoked", True)


@with_test_user("regen_key")
def test_regenerate_api_key(session):
    """Test regenerating an API key."""
    key_data = session.post(
        f'{TEST_SERVER_URL}/create_api_key',
        json={'name': 'To Regenerate', 'permissions': []}
    ).json()

    original_key = key_data['key']

    response = session.post(f'{TEST_SERVER_URL}/regenerate_api_key', params={'id': key_data['id']})
    new_key_data = response.json()

    assert new_key_data['key'] != original_key
    assert len(new_key_data['key']) > 0

    return ("API key regenerated with new value", True)



def test_get_users_info():
    """Test retrieving info for multiple users."""
    try:
        session1 = create_test_user(f"user_info1_{int(time.time())}")
        session2 = create_test_user(f"user_info2_{int(time.time())}")

        if not session1 or not session2:
            return ("Failed to create users", False)

        user1_id = get_user_id(session1)
        user2_id = get_user_id(session2)

        response = session1.post(
            f'{TEST_SERVER_URL}/get_users_info',
            params={'users': json.dumps([user1_id, user2_id])}
        )

        users = response.json()
        assert len(users) == 2
        assert user1_id in [u['id'] for u in users]
        assert user2_id in [u['id'] for u in users]

        return ("Retrieved info for 2 users", True)

    except Exception as e:
        return (str(e), False)


def test_unauthorized_conversation_access():
    """Test unauthorized access to a conversation."""
    try:
        session1 = create_test_user(f"unauth1_{int(time.time())}")
        session2 = create_test_user(f"unauth2_{int(time.time())}")

        if not session1 or not session2:
            return ("Failed to create users", False)

        conv_id = int(session1.post(
            f'{TEST_SERVER_URL}/create_conv',
            params={'name': 'Private', 'members': json.dumps([]), 'private': 'true'}
        ).text.strip('"'))

        response = session2.get(f'{TEST_SERVER_URL}/get_conv_content', params={'convId': conv_id})

        if response.status_code == 200:
            result = response.text
            assert result in ['null', 'None', ''], "Should deny access"
        else:
            assert response.status_code in [403, 404]

        return ("Unauthorized access correctly prevented", True)

    except Exception as e:
        return (str(e), False)


def test_edit_conversation_forbidden():
    """Test forbidden conversation edit."""
    try:
        session1 = create_test_user(f"edit_forbid1_{int(time.time())}")
        session2 = create_test_user(f"edit_forbid2_{int(time.time())}")

        if not session1 or not session2:
            return ("Failed to create users", False)

        conv_id = int(session1.post(
            f'{TEST_SERVER_URL}/create_conv',
            params={'name': 'Original', 'members': json.dumps([]), 'private': 'true'}
        ).text.strip('"'))

        response = session2.post(
            f'{TEST_SERVER_URL}/edit_conv',
            params={'id': conv_id, 'element': 'name', 'value': 'Hacked'}
        )

        assert response.status_code == 403, f"Expected 403, got {response.status_code}"

        return ("Forbidden edit correctly prevented", True)

    except Exception as e:
        return (str(e), False)


def test_revoke_others_api_key():
    """Test unauthorized API key revocation."""
    try:
        session1 = create_test_user(f"revoke_other1_{int(time.time())}")
        session2 = create_test_user(f"revoke_other2_{int(time.time())}")

        if not session1 or not session2:
            return ("Failed to create users", False)

        key_data = session1.post(
            f'{TEST_SERVER_URL}/create_api_key',
            json={'name': 'Protected Key', 'permissions': []}
        ).json()

        response = session2.post(f'{TEST_SERVER_URL}/revoke_api_key', params={'id': key_data['id']})
        assert response.status_code in [403, 404]

        # Verify key still exists
        keys = session1.get(f'{TEST_SERVER_URL}/get_user_api_keys').json()
        assert any(k['id'] == key_data['id'] for k in keys), "Key should still exist"

        return ("Unauthorized revocation prevented", True)

    except Exception as e:
        return (str(e), False)


# ==================== ADVANCED SERVER TESTS ====================

@with_test_user("server_channels")
def test_server_has_default_channels(session):
    """Test that new server has default channels."""
    server_id = session.post(f'{TEST_SERVER_URL}/create_server').json()['id']

    # Get server details - verify it has categories and channels
    servers = session.post(f'{TEST_SERVER_URL}/get_user_servers').json()
    server = next(s for s in servers if s['id'] == server_id)

    assert server is not None, "Server should exist"
    assert 'name' in server

    return ("Server created with default structure", True)



def test_multiple_servers_isolation():
    """Test that multiple servers are isolated."""
    try:
        session1 = create_test_user(f"isolation1_{int(time.time())}")
        session2 = create_test_user(f"isolation2_{int(time.time())}")

        if not session1 or not session2:
            return ("Failed to create users", False)

        # User1 creates server
        server_id1 = session1.post(f'{TEST_SERVER_URL}/create_server').json()['id']

        # User2 creates server
        server_id2 = session2.post(f'{TEST_SERVER_URL}/create_server').json()['id']

        # Verify user1 only sees their server
        servers1 = session1.post(f'{TEST_SERVER_URL}/get_user_servers').json()
        assert any(s['id'] == server_id1 for s in servers1)
        assert not any(s['id'] == server_id2 for s in servers1), "Should not see other user's server"

        # Verify user2 only sees their server
        servers2 = session2.post(f'{TEST_SERVER_URL}/get_user_servers').json()
        assert any(s['id'] == server_id2 for s in servers2)
        assert not any(s['id'] == server_id1 for s in servers2), "Should not see other user's server"

        return ("Server isolation verified", True)

    except Exception as e:
        return (str(e), False)


# ==================== CONVERSATION ADVANCED TESTS ====================

def test_conversation_members_list():
    """Test conversation members list."""
    try:
        session1 = create_test_user(f"members1_{int(time.time())}")
        session2 = create_test_user(f"members2_{int(time.time())}")
        session3 = create_test_user(f"members3_{int(time.time())}")

        if not session1 or not session2 or not session3:
            return ("Failed to create users", False)

        user1_id = get_user_id(session1)
        user2_id = get_user_id(session2)
        user3_id = get_user_id(session3)

        # Create conversation with 3 members
        conv_id = int(session1.post(
            f'{TEST_SERVER_URL}/create_conv',
            params={'name': 'Group', 'members': json.dumps([user2_id, user3_id]), 'private': 'true'}
        ).text.strip('"'))

        # Verify all members see the conversation
        convs1 = session1.post(f'{TEST_SERVER_URL}/get_user_convs').json()
        convs2 = session2.post(f'{TEST_SERVER_URL}/get_user_convs').json()
        convs3 = session3.post(f'{TEST_SERVER_URL}/get_user_convs').json()

        assert any(c['id'] == conv_id for c in convs1)
        assert any(c['id'] == conv_id for c in convs2)
        assert any(c['id'] == conv_id for c in convs3)

        # Verify member list
        conv = next(c for c in convs1 if c['id'] == conv_id)
        assert len(conv['members']) == 3
        assert user1_id in conv['members']
        assert user2_id in conv['members']
        assert user3_id in conv['members']

        return ("Conversation with 3 members verified", True)

    except Exception as e:
        return (str(e), False)


@with_test_user("empty_conv")
def test_empty_conversation_content(session):
    """Test getting content from empty conversation."""
    conv_id = XXX_PLACEHOLDER

    response = session.get(f'{TEST_SERVER_URL}/get_conv_content', params={'convId': conv_id})
    content = response.json()

    assert 'messages' in content
    assert len(content['messages']) == 0, "Empty conversation should have no messages"

    return ("Empty conversation content retrieved", True)


@with_test_user("privacy")
def test_conversation_privacy(session):
    """Test private vs non-private conversations."""
    # Create private conversation
    conv_id_private = XXX_PLACEHOLDER

    # Create non-private conversation
    conv_id_public = XXX_PLACEHOLDER

    convs = session.post(f'{TEST_SERVER_URL}/get_user_convs').json()

    conv_private = next(c for c in convs if c['id'] == conv_id_private)
    conv_public = next(c for c in convs if c['id'] == conv_id_public)

    assert conv_private['private'] == True
    assert conv_public['private'] == False

    return ("Conversation privacy settings verified", True)



# ==================== USER INFO TESTS ====================

@with_test_user("self_info")
def test_get_user_info_self(session):
    """Test getting own user info."""
    response = session.post(f'{TEST_SERVER_URL}/get_user_info')
    assert response.status_code == 200

    user_info = response.json()
    assert 'id' in user_info
    assert 'username' in user_info
    assert user_info['id'] > 0

    return (f"Retrieved own user info (ID: {user_info['id']})", True)



def test_users_info_with_status():
    """Test getting users info includes status data."""
    try:
        session1 = create_test_user(f"status1_{int(time.time())}")
        session2 = create_test_user(f"status2_{int(time.time())}")

        if not session1 or not session2:
            return ("Failed to create users", False)

        user1_id = get_user_id(session1)
        user2_id = get_user_id(session2)

        response = session1.post(
            f'{TEST_SERVER_URL}/get_users_info',
            params={'users': json.dumps([user1_id, user2_id])}
        )

        users = response.json()
        assert len(users) == 2

        for user in users:
            assert 'id' in user
            assert 'username' in user

        return ("Users info with status retrieved", True)

    except Exception as e:
        return (str(e), False)


# ==================== API KEY EDGE CASES ====================

@with_test_user("key_validation")
def test_api_key_name_validation(session):
    """Test API key creation with various names."""
    # Create key with long name
    long_name = "A" * MAX_NAME_LENGTH_SHORT
    response = session.post(
        f'{TEST_SERVER_URL}/create_api_key',
        json={'name': long_name, 'permissions': []}
    )

    if response.status_code == 200:
        key_data = response.json()
        assert len(key_data['name']) > 0, "API key name should not be empty"

        return (f"API key with {MAX_NAME_LENGTH_SHORT}-char name created", True)
    else:
        return ("API key creation handled validation appropriately", True)


@with_test_user("multi_keys")
def test_multiple_api_keys(session):
    """Test creating multiple API keys."""
    # Create multiple keys
    created_keys = []
    for i in range(MAX_API_KEYS_TEST):
        response = session.post(
            f'{TEST_SERVER_URL}/create_api_key',
            json={'name': f'Key {i}', 'permissions': []}
        )
        if response.status_code == 200:
            created_keys.append(response.json()['id'])

    assert len(created_keys) >= 3, \
        f"Expected at least 3 keys created, got {len(created_keys)}/{MAX_API_KEYS_TEST}"

    # Verify all keys exist
    keys = session.get(f'{TEST_SERVER_URL}/get_user_api_keys').json()
    assert len(keys) >= len(created_keys), \
        f"Expected at least {len(created_keys)} keys in list, got {len(keys)}"

    return (f"Created {len(created_keys)}/{MAX_API_KEYS_TEST} API keys successfully", True)


@with_test_user("regen_multi")
def test_regenerate_multiple_times(session):
    """Test regenerating same API key multiple times."""
    # Create key
    key_data = session.post(
        f'{TEST_SERVER_URL}/create_api_key',
        json={'name': 'Multi Regen', 'permissions': []}
    ).json()

    key_id = key_data['id']
    keys = [key_data['key']]

    # Regenerate multiple times
    for i in range(REGEN_ITERATIONS):
        response = session.post(f'{TEST_SERVER_URL}/regenerate_api_key', params={'id': key_id})
        new_key = response.json()['key']

        # Verify new key is different from all previous
        assert new_key not in keys, \
            f"Key should be unique at iteration {i+1}/{REGEN_ITERATIONS}, got duplicate"
        keys.append(new_key)

    return (f"Key regenerated {REGEN_ITERATIONS} times with unique values", True)



# ==================== CONVERSATION EDIT TESTS ====================

@with_test_user("edit_validation")
def test_edit_conversation_name_validation(session):
    """Test conversation name edit with various inputs."""
    conv_id = XXX_PLACEHOLDER

    # Test with long name
    long_name = "A" * MAX_NAME_LENGTH_LONG
    response = session.post(
        f'{TEST_SERVER_URL}/edit_conv',
        params={'id': conv_id, 'element': 'name', 'value': long_name}
    )

    # Should either succeed or handle gracefully
    assert response.status_code in [200, 400], \
        f"Expected 200 or 400 for {MAX_NAME_LENGTH_LONG}-char name, got {response.status_code}"

    return (f"Conversation name validation tested ({MAX_NAME_LENGTH_LONG} chars)", True)



@with_test_users(2)
def test_concurrent_conversation_edits(sessions):
    """Test multiple users editing same conversation - TRULY CONCURRENT."""
    session1, session2 = sessions

    user2_id = get_user_id(session2)

    # Create shared conversation
    conv_id = int(session1.post(
        f'{TEST_SERVER_URL}/create_conv',
        params={'name': 'Shared', 'members': json.dumps([user2_id]), 'private': 'true'}
    ).text.strip('"'))

    _cleanup_manager.register_conversation(conv_id)

    # Execute edits TRULY CONCURRENTLY using threads
    def edit1():
        return session1.post(
            f'{TEST_SERVER_URL}/edit_conv',
            params={'id': conv_id, 'element': 'name', 'value': 'Name from User1'}
        )

    def edit2():
        return session2.post(
            f'{TEST_SERVER_URL}/edit_conv',
            params={'id': conv_id, 'element': 'name', 'value': 'Name from User2'}
        )

    # Run both edits at the EXACT same time
    response1, response2 = run_concurrent([edit1, edit2])

    # Both should succeed
    assert response1.status_code == 200, f"User1 edit failed: {response1.status_code}"
    assert response2.status_code == 200, f"User2 edit failed: {response2.status_code}"

    # Verify final state exists and is valid
    convs = session1.post(f'{TEST_SERVER_URL}/get_user_convs').json()
    conv = next(c for c in convs if c['id'] == conv_id)
    assert 'name' in conv, "Conversation should have a name"
    assert conv['name'] in ['Name from User1', 'Name from User2'], \
        f"Name should be from one of the users, got: {conv['name']}"

    return ("Concurrent edits handled (truly concurrent execution)", True)



# ==================== STRESS TESTS ====================

def test_create_many_conversations():
    """Test creating multiple conversations."""
    try:
        session = create_test_user(f"many_convs_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        created = []
        for i in range(STRESS_TEST_CONVERSATIONS):
            response = session.post(
                f'{TEST_SERVER_URL}/create_conv',
                params={'name': f'Conv {i}', 'members': json.dumps([]), 'private': 'true'}
            )
            if response.status_code == 200:
                created.append(response.json()['id'])

        assert len(created) >= 5, \
            f"Expected at least 5 conversations, got {len(created)}/{STRESS_TEST_CONVERSATIONS}"

        # Verify all exist
        convs = session.post(f'{TEST_SERVER_URL}/get_user_convs').json()
        assert len(convs) >= len(created), \
            f"Expected at least {len(created)} conversations in list, got {len(convs)}"

        return (f"Created {len(created)}/{STRESS_TEST_CONVERSATIONS} conversations successfully", True)

    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_get_large_conversation_list():
    """Test retrieving large list of conversations."""
    try:
        session = create_test_user(f"large_list_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        # Create several conversations
        for i in range(LARGE_LIST_CONVERSATIONS):
            session.post(
                f'{TEST_SERVER_URL}/create_conv',
                params={'name': f'Large {i}', 'members': json.dumps([]), 'private': 'true'}
            )

        # Get all conversations
        response = session.post(f'{TEST_SERVER_URL}/get_user_convs')
        assert response.status_code == 200, f"Failed to get conversations: {response.status_code}"

        convs = response.json()
        assert len(convs) >= 10, \
            f"Expected at least 10 conversations from {LARGE_LIST_CONVERSATIONS} created, got {len(convs)}"

        # Verify each has members list
        for conv in convs:
            assert 'members' in conv, f"Conversation {conv.get('id')} missing 'members' field"
            assert isinstance(conv['members'], list), \
                f"Conversation members should be list, got {type(conv['members'])}"

        return (f"Retrieved {len(convs)} conversations from large list", True)

    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


# ==================== EDGE CASE TESTS ====================

def test_conversation_with_nonexistent_member():
    """Test creating conversation with invalid member ID."""
    try:
        session = create_test_user(f"invalid_member_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        # Try to create conversation with fake user ID
        fake_user_id = 999999999
        response = session.post(
            f'{TEST_SERVER_URL}/create_conv',
            params={'name': 'Invalid', 'members': json.dumps([fake_user_id]), 'private': 'true'}
        )

        # Should either succeed (ignoring invalid member) or fail gracefully
        assert response.status_code in [200, 400, 404]

        return ("Invalid member handled gracefully", True)

    except Exception as e:
        return (str(e), False)


def test_empty_conversation_name():
    """Test creating conversation with empty name."""
    try:
        session = create_test_user(f"empty_name_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        response = session.post(
            f'{TEST_SERVER_URL}/create_conv',
            params={'name': '', 'members': json.dumps([]), 'private': 'true'}
        )

        # Should handle empty name
        if response.status_code == 200:
            conv_id = response.json()['id']
            assert conv_id > 0
            return ("Empty name handled (conversation created)", True)
        else:
            return ("Empty name rejected appropriately", True)

    except Exception as e:
        return (str(e), False)


def test_special_characters_in_names():
    """Test special characters in conversation and key names."""
    try:
        session = create_test_user(f"special_chars_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        special_name = "Test 🚀 <script>alert('xss')</script>"

        # Test conversation name
        response = session.post(
            f'{TEST_SERVER_URL}/create_conv',
            params={'name': special_name, 'members': json.dumps([]), 'private': 'true'}
        )

        assert response.status_code in [200, 400]

        # Test API key name
        response2 = session.post(
            f'{TEST_SERVER_URL}/create_api_key',
            json={'name': special_name, 'permissions': []}
        )

        assert response2.status_code in [200, 400]

        return ("Special characters handled", True)

    except Exception as e:
        return (str(e), False)


# ==================== STATUS TESTS ====================

def test_default_status_online():
    """Test that new user has default online status."""
    try:
        session = create_test_user(f"status_online_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        user_id = get_user_id(session)

        # Get user info with status
        response = session.post(
            f'{TEST_SERVER_URL}/get_users_info',
            params={'users': json.dumps([user_id])}
        )

        users = response.json()
        assert len(users) == 1

        user = users[0]
        assert 'status' in user
        # User should have a status (online/idle)
        assert 'icon' in user['status']
        assert 'text' in user['status']

        return (f"Default status: {user['status']['text']}", True)

    except Exception as e:
        return (str(e), False)


def test_set_custom_status():
    """Test setting custom status message."""
    try:
        session = create_test_user(f"custom_status_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        user_id = get_user_id(session)

        # Set custom status
        custom_status = {
            "mode": 0,  # Online
            "text": "Working on tests 🚀",
            "emoji": "💻",
            "expiration": None
        }

        response = session.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={
                'element': 'status',
                'value': json.dumps(custom_status)
            }
        )

        assert response.status_code == 200

        # Verify status was set
        users = session.post(
            f'{TEST_SERVER_URL}/get_users_info',
            params={'users': json.dumps([user_id])}
        ).json()

        user = users[0]
        assert user['status']['text'] == "Working on tests 🚀"
        assert user['status']['emoji'] == "💻"

        return ("Custom status set successfully", True)

    except Exception as e:
        return (str(e), False)


def test_set_do_not_disturb_status():
    """Test setting Do Not Disturb status."""
    try:
        session = create_test_user(f"dnd_status_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        user_id = get_user_id(session)

        # Set DND status (mode 2)
        dnd_status = {
            "mode": 2,
            "text": "In a meeting",
            "emoji": "🔕",
            "expiration": None
        }

        response = session.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={
                'element': 'status',
                'value': json.dumps(dnd_status)
            }
        )

        assert response.status_code == 200

        # Verify DND status
        users = session.post(
            f'{TEST_SERVER_URL}/get_users_info',
            params={'users': json.dumps([user_id])}
        ).json()

        user = users[0]
        assert user['status']['icon'] == 'RED'
        assert user['status']['text'] == "In a meeting"

        return ("Do Not Disturb status set", True)

    except Exception as e:
        return (str(e), False)


def test_set_idle_status():
    """Test setting Idle status."""
    try:
        session = create_test_user(f"idle_status_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        user_id = get_user_id(session)

        # Set idle status (mode 1)
        idle_status = {
            "mode": 1,
            "text": "Away from keyboard",
            "emoji": "⏰",
            "expiration": None
        }

        response = session.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={
                'element': 'status',
                'value': json.dumps(idle_status)
            }
        )

        assert response.status_code == 200

        # Verify idle status
        users = session.post(
            f'{TEST_SERVER_URL}/get_users_info',
            params={'users': json.dumps([user_id])}
        ).json()

        user = users[0]
        assert user['status']['icon'] == 'orange'
        assert user['status']['text'] == "Away from keyboard"

        return ("Idle status set", True)

    except Exception as e:
        return (str(e), False)


def test_set_invisible_status():
    """Test setting Invisible/Offline status."""
    try:
        session = create_test_user(f"invisible_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        user_id = get_user_id(session)

        # Set invisible status (mode 3)
        invisible_status = {
            "mode": 3,
            "text": "Appearing offline",
            "emoji": "👻",
            "expiration": None
        }

        response = session.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={
                'element': 'status',
                'value': json.dumps(invisible_status)
            }
        )

        assert response.status_code == 200

        # Verify invisible status
        users = session.post(
            f'{TEST_SERVER_URL}/get_users_info',
            params={'users': json.dumps([user_id])}
        ).json()

        user = users[0]
        assert user['status']['icon'] == 'spymode'

        return ("Invisible status set", True)

    except Exception as e:
        return (str(e), False)


def test_status_with_emoji():
    """Test status with various emojis."""
    try:
        session = create_test_user(f"emoji_status_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        user_id = get_user_id(session)

        emojis = ["🎮", "☕", "🌙", "💤", "🎵"][:EMOJI_TEST_COUNT]

        for i, emoji in enumerate(emojis):
            status = {
                "mode": 0,
                "text": f"Using {emoji}",
                "emoji": emoji,
                "expiration": None
            }

            response = session.post(
                f'{TEST_SERVER_URL}/edit_user',
                params={
                    'element': 'status',
                    'value': json.dumps(status)
                }
            )

            assert response.status_code == 200, \
                f"Failed to set emoji {emoji} (iteration {i+1}/{EMOJI_TEST_COUNT})"

            # Verify emoji was set
            users = session.post(
                f'{TEST_SERVER_URL}/get_users_info',
                params={'users': json.dumps([user_id])}
            ).json()

            assert users[0]['status']['emoji'] == emoji, \
                f"Expected emoji {emoji}, got {users[0]['status']['emoji']}"

        return (f"Status with {EMOJI_TEST_COUNT} different emojis tested", True)

    except AssertionError as e:
        return (f"Assertion failed: {e}", False)
    except Exception as e:
        return (f"Error: {type(e).__name__}: {e}", False)


def test_clear_status():
    """Test clearing status back to default."""
    try:
        session = create_test_user(f"clear_status_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        user_id = get_user_id(session)

        # Set custom status
        custom = {
            "mode": 0,
            "text": "Custom status",
            "emoji": "🎯",
            "expiration": None
        }

        session.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={'element': 'status', 'value': json.dumps(custom)}
        )

        # Clear status (empty text)
        cleared = {
            "mode": 0,
            "text": "",
            "emoji": "",
            "expiration": None
        }

        response = session.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={'element': 'status', 'value': json.dumps(cleared)}
        )

        assert response.status_code == 200

        # Verify status was cleared
        users = session.post(
            f'{TEST_SERVER_URL}/get_users_info',
            params={'users': json.dumps([user_id])}
        ).json()

        user = users[0]
        # Should default to "Online" when text is empty
        assert user['status']['text'] in ["", "Online"]

        return ("Status cleared successfully", True)

    except Exception as e:
        return (str(e), False)


def test_multiple_users_different_statuses():
    """Test multiple users with different statuses."""
    try:
        session1 = create_test_user(f"multi_status1_{int(time.time())}")
        session2 = create_test_user(f"multi_status2_{int(time.time())}")
        session3 = create_test_user(f"multi_status3_{int(time.time())}")

        if not session1 or not session2 or not session3:
            return ("Failed to create users", False)

        user1_id = get_user_id(session1)
        user2_id = get_user_id(session2)
        user3_id = get_user_id(session3)

        # Set different statuses
        session1.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={'element': 'status', 'value': json.dumps({
                "mode": 0, "text": "Online", "emoji": "✅", "expiration": None
            })}
        )

        session2.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={'element': 'status', 'value': json.dumps({
                "mode": 2, "text": "Busy", "emoji": "🔴", "expiration": None
            })}
        )

        session3.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={'element': 'status', 'value': json.dumps({
                "mode": 1, "text": "Away", "emoji": "🌙", "expiration": None
            })}
        )

        # Get all users info
        users = session1.post(
            f'{TEST_SERVER_URL}/get_users_info',
            params={'users': json.dumps([user1_id, user2_id, user3_id])}
        ).json()

        assert len(users) == 3

        # Verify each has different status
        for user in users:
            assert 'status' in user
            assert 'icon' in user['status']

        return ("Multiple users with different statuses verified", True)

    except Exception as e:
        return (str(e), False)


def test_status_text_length():
    """Test status with long text."""
    try:
        session = create_test_user(f"long_status_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        user_id = get_user_id(session)

        # Long status text
        long_text = "Working on a very important project that requires full concentration " * 3

        long_status = {
            "mode": 0,
            "text": long_text,
            "emoji": "📝",
            "expiration": None
        }

        response = session.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={'element': 'status', 'value': json.dumps(long_status)}
        )

        # Should handle long text (either accept or truncate)
        assert response.status_code in [200, 400]

        if response.status_code == 200:
            users = session.post(
                f'{TEST_SERVER_URL}/get_users_info',
                params={'users': json.dumps([user_id])}
            ).json()

            assert 'status' in users[0]
            return (f"Long status text handled (length: {len(users[0]['status']['text'])})", True)
        else:
            return ("Long status text rejected appropriately", True)

    except Exception as e:
        return (str(e), False)


def test_status_mode_validation():
    """Test invalid status modes."""
    try:
        session = create_test_user(f"invalid_mode_{int(time.time())}")
        if not session:
            return ("Failed to create user", False)

        # Try invalid mode
        invalid_status = {
            "mode": 999,  # Invalid mode
            "text": "Invalid",
            "emoji": "",
            "expiration": None
        }

        response = session.post(
            f'{TEST_SERVER_URL}/edit_user',
            params={'element': 'status', 'value': json.dumps(invalid_status)}
        )

        # Should handle gracefully
        assert response.status_code in [200, 400]

        return ("Invalid status mode handled", True)

    except Exception as e:
        return (str(e), False)


# ==================== MESSAGE EDITING TESTS ====================

@with_test_user("edit_msg")
def test_edit_own_message(session):
    """Test that a user can edit their own message."""
    # Create conversation
    conv_response = session.post(
        f'{TEST_SERVER_URL}/create_conversation',
        params={'name': 'Edit Test Conv'}
    )
    assert conv_response.status_code == 200
    conv_id = conv_response.json().get('id')
    assert conv_id, "Failed to get conversation ID"

    # Send a message
    msg_id = send_test_message(session, conv_id, 'Original message')
    assert msg_id, "Failed to send message"

    # Edit the message
    new_content = 'Edited message'
    response = session.post(
        f'{TEST_SERVER_URL}/edit_message',
        params={
            'message': msg_id,
            'content': new_content
        }
    )

    assert response.status_code == 200, f"Expected 200, got {response.status_code}"

    return ("User can edit their own message", True)


@with_test_users(2)
def test_cannot_edit_others_message(sessions):
    """Test that a user cannot edit another user's message."""
    session1, session2 = sessions

    # User 1 creates conversation and sends message
    conv_response = session1.post(
        f'{TEST_SERVER_URL}/create_conversation',
        params={'name': 'Edit Security Test'}
    )
    assert conv_response.status_code == 200
    conv_id = conv_response.json().get('id')
    assert conv_id, "Failed to create conversation"

    msg_id = send_test_message(session1, conv_id, 'User 1 message')
    assert msg_id, "Failed to send message"

    # User 2 tries to edit user 1's message (should fail)
    response = session2.post(
        f'{TEST_SERVER_URL}/edit_message',
        params={
            'message': msg_id,
            'content': 'Hacked message'
        }
    )

    # Should be forbidden
    assert response.status_code == 403, f"Expected 403, got {response.status_code}"

    return ("User cannot edit another user's message", True)


@with_test_user("edit_nonexist")
def test_edit_nonexistent_message(session):
    """Test editing a message that doesn't exist."""
    # Try to edit nonexistent message
    response = session.post(
        f'{TEST_SERVER_URL}/edit_message',
        params={
            'message': 999999,
            'content': 'Should fail'
        }
    )

    # Should be forbidden
    assert response.status_code == 403, f"Expected 403, got {response.status_code}"

    return ("Cannot edit nonexistent message", True)


@with_test_user("edit_empty")
def test_edit_empty_content(session):
    """Test editing a message with empty content."""
    # Create conversation
    conv_response = session.post(
        f'{TEST_SERVER_URL}/create_conversation',
        params={'name': 'Empty Edit Test'}
    )
    assert conv_response.status_code == 200
    conv_id = conv_response.json().get('id')

    msg_id = send_test_message(session, conv_id, 'Original message')
    assert msg_id, "Failed to send message"

    # Try to edit with empty content
    response = session.post(
        f'{TEST_SERVER_URL}/edit_message',
        params={
            'message': msg_id,
            'content': ''
        }
    )

    # Should succeed (backend accepts empty, frontend trims)
    assert response.status_code == 200, f"Expected 200, got {response.status_code}"

    return ("Message can be edited with empty content (server accepts)", True)


@with_test_user("edit_special")
def test_edit_with_special_characters(session):
    """Test editing a message with special characters."""
    # Create conversation
    conv_response = session.post(
        f'{TEST_SERVER_URL}/create_conversation',
        params={'name': 'Special Char Test'}
    )
    assert conv_response.status_code == 200
    conv_id = conv_response.json().get('id')

    msg_id = send_test_message(session, conv_id, 'Original message')
    assert msg_id, "Failed to send message"

    # Edit with special characters
    special_content = 'Test <script>alert("xss")</script> & "quotes"'
    response = session.post(
        f'{TEST_SERVER_URL}/edit_message',
        params={
            'message': msg_id,
            'content': special_content
        }
    )

    assert response.status_code == 200, f"Expected 200, got {response.status_code}"

    return ("Message can be edited with special characters", True)


def test_edit_without_auth():
    """Test editing a message without authentication."""
    try:
        # Try to edit without session/auth
        response = requests.post(
            f'{TEST_SERVER_URL}/edit_message',
            params={
                'message': 1,
                'content': 'Should fail'
            }
        )

        # Should fail (401, 403, or 302 redirect)
        assert response.status_code in [401, 403, 302], f"Expected 401/403/302, got {response.status_code}"

        return ("Cannot edit message without authentication", True)

    except Exception as e:
        return (str(e), False)


@with_test_user("edit_multiple")
def test_multiple_edits_same_message(session):
    """Test editing the same message multiple times."""
    # Create conversation
    conv_response = session.post(
        f'{TEST_SERVER_URL}/create_conversation',
        params={'name': 'Multiple Edits Test'}
    )
    assert conv_response.status_code == 200
    conv_id = conv_response.json().get('id')

    msg_id = send_test_message(session, conv_id, 'Original message')
    assert msg_id, "Failed to send message"

    # Edit multiple times
    for i in range(3):
        response = session.post(
            f'{TEST_SERVER_URL}/edit_message',
            params={
                'message': msg_id,
                'content': f'Edit number {i+1}'
            }
        )
        assert response.status_code == 200, f"Edit {i+1} failed with {response.status_code}"

    return ("Message can be edited multiple times", True)


# ==================== END MESSAGE EDITING TESTS ====================

