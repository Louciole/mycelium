"""Community discovery, invitations, dashboards and server email.

Endpoints take the live Mycelium instance as ``self``; shared helpers remain on
the class (see server.py).
"""
import json
import random
import datetime
import requests

from vesta import Server, HTTPError
from constants import B62


@Server.expose
def get_discoverable_servers(self, search=None, tags=None, languages=None):
    """
    Get list of community servers for discovery page.

    Args:
        search: Optional search term for server name/description
        tags: Optional JSON array of tags to filter by
        languages: Optional JSON array of language codes to filter by

    Returns:
        JSON object with 'featured' and 'regular' server lists
    """
    uid = self.getUser()

    # Constants
    MAX_SEARCH_LENGTH = 100
    MAX_TAGS_FILTER = 10

    # Validate search
    if search:
        if len(search) > MAX_SEARCH_LENGTH:
            raise HTTPError(self.response, 400, "Search query too long")
        search = search.strip()

    # Validate and parse languages
    languages_list = []
    if languages:
        try:
            languages_list = json.loads(languages) if isinstance(languages, str) else languages
            if not isinstance(languages_list, list):
                raise HTTPError(self.response, 400, "Languages must be an array")
        except json.JSONDecodeError:
            raise HTTPError(self.response, 400, "Invalid JSON format for languages")

    tags_list = []
    if tags:
        try:
            tags_list = json.loads(tags) if isinstance(tags, str) else tags
            if not isinstance(tags_list, list):
                raise HTTPError(self.response, 400, "Tags must be an array")
            if len(tags_list) > MAX_TAGS_FILTER:
                raise HTTPError(self.response, 400, f"Too many tags (max {MAX_TAGS_FILTER})")
            # Sanitize tags
            tags_list = [tag.strip().lower() for tag in tags_list if tag.strip()]
        except json.JSONDecodeError:
            raise HTTPError(self.response, 400, "Invalid JSON format for tags")

    # Base query for community servers
    filters = ["is_community", "=", True]

    # Get all community servers first
    all_servers = self.db.getFilters("server", filters)

    # Every language used by a community server, for the discover page's language
    # picker: computed before filtering and limits so no language goes missing.
    available_languages = set()
    for server in all_servers:
        server_languages = server.get('languages') or []
        if isinstance(server_languages, str):
            server_languages = json.loads(server_languages)
        available_languages.update(server_languages)

    # Filter by search term in Python (safer than complex SQL with parentheses)
    if search:
        search_lower = search.lower()
        filtered_servers = []
        for server in all_servers:
            name = (server.get('name') or '').lower()
            description = (server.get('description') or '').lower()
            if search_lower in name or search_lower in description:
                filtered_servers.append(server)
        all_servers = filtered_servers

    # Filter by languages if provided
    if languages_list:
        filtered_servers = []
        for server in all_servers:
            server_languages = server.get('languages', [])
            if isinstance(server_languages, str):
                server_languages = json.loads(server_languages)
            if any(lang in server_languages for lang in languages_list):
                filtered_servers.append(server)
        all_servers = filtered_servers

    # Filter by tags if provided
    if tags_list:
        filtered_servers = []
        for server in all_servers:
            server_tags = server.get('tags', [])
            if isinstance(server_tags, str):
                server_tags = json.loads(server_tags)
            # Tags keep the owner's casing ("Gaming") but filters are lowercased
            server_tags = {t.lower() for t in server_tags if isinstance(t, str)}
            if any(tag in server_tags for tag in tags_list):
                filtered_servers.append(server)
        all_servers = filtered_servers

    # Separate featured and regular servers
    featured = [s for s in all_servers if s.get('is_featured', False)]
    regular = [s for s in all_servers if not s.get('is_featured', False)]

    # Sort featured by member count
    featured.sort(key=lambda x: x.get('member_count', 0), reverse=True)

    # Sort regular by member count
    regular.sort(key=lambda x: x.get('member_count', 0), reverse=True)

    # Mark servers user is already in
    user_server_ids = [s['id'] for s in self.db.getSomethingProxied("server", "accessserver", "account", uid)]

    for server in featured + regular:
        server['is_joined'] = server['id'] in user_server_ids

    # Limits
    MAX_FEATURED_SERVERS = 10
    MAX_REGULAR_SERVERS = 50

    return json.dumps({
        'featured': featured[:MAX_FEATURED_SERVERS],
        'regular': regular[:MAX_REGULAR_SERVERS],
        'languages': sorted(available_languages)
    }, default=str)


@Server.expose
def join_community_server(self, server_id):
    """
    Join a community server.

    Args:
        server_id: ID of the server to join

    Returns:
        Success message
    """
    uid = self.getUser()

    # Check if server exists and is a community server
    server = self.db.getSomething("server", server_id)
    if not server:
        raise HTTPError(self.response, 404, "Server not found")

    if not server.get('is_community', False):
        raise HTTPError(self.response, 403, "This server is not a community server")

    # Check if already a member
    existing = self.db.getFilters("accessserver", [
        "account", "=", uid,
        "and",
        "server", "=", server_id
    ])

    if existing:
        raise HTTPError(self.response, 400, "Already a member of this server")

    if self.isBannedFromServer(uid, server_id):
        raise HTTPError(self.response, 403, "banned from this server")

    # Add user to server
    self.db.insertDict('accessserver', {'account': uid, 'server': server_id})

    return json.dumps({"success": True, "server_id": server_id})


@Server.expose
def get_available_tags(self):
    """
    Get list of all available tags from community servers.

    Returns:
        JSON array of unique tags
    """
    # Get all community servers
    servers = self.db.getFilters("server", ["is_community", "=", True])

    # Collect all unique tags
    all_tags = set()
    for server in servers:
        tags = server.get('tags', [])
        if isinstance(tags, str):
            tags = json.loads(tags)
        all_tags.update(tags)

    return json.dumps(sorted(list(all_tags)))


def _invited_channel(self, invitation):
    """The channel an invitation leads to, or None (an invitation to the server)."""
    if not invitation.get("channel"):
        return None
    return self.db.getSomething(self._getChannelTable(invitation["channel_type"]), invitation["channel"])


@Server.expose
def server_display(self, invite):
    invitation = self.db.getSomething("invitation", invite, "link")
    if not invitation:
        raise HTTPError(self.response, 404, "Not Found")
    details = self.db.getSomething("server", invitation["server"])
    channel = _invited_channel(self, invitation)
    return json.dumps({"name": details["name"], "pfp": details.get("pfp"), "channel": channel["name"] if channel else None})


@Server.expose
def create_invitation(self, server_id, channel_id=None, channel_type=None, pref=None):
    """A 7-day invitation link to the server, or to one of its channels the inviter
    can see (the invitee's client then opens it). An unexpired one is reused."""
    uid = self.getUser()
    self.require_member(uid, server_id)
    target = {"server": int(server_id), "channel": None, "type": None}
    if channel_id:
        channel = self.require_channel_access(uid, channel_id, channel_type, "view")
        if channel["server"] != target["server"]:
            raise HTTPError(self.response, 400, "channel of another server")
        target.update(channel=channel["id"], type=channel_type)
    with self.db.pool.connection() as conn:
        res = conn.execute("SELECT link FROM invitation WHERE server = %(server)s AND expiration > now() "
                           "AND channel IS NOT DISTINCT FROM %(channel)s AND channel_type IS NOT DISTINCT FROM %(type)s "
                           "LIMIT 1", target).fetchone()
    if res:
        return res["link"]

    link = pref or ''.join(random.sample(B62, 8))
    while self.db.getSomething("invitation", link, "link"):
        link = (pref + ''.join(random.sample(B62, 3))) if pref else ''.join(random.sample(B62, 8))
    self.db.insertDict("invitation", {"link": link, "server": target["server"], "channel": target["channel"],
                                      "channel_type": target["type"],
                                      "expiration": datetime.datetime.now() + datetime.timedelta(days=7)})
    return link


@Server.expose
def join_server(self, invite_code):
    """Joins the invitation's server (a member just follows it) and says where it leads:
    {server, channel, channel_type} — the client routes there."""
    uid = self.getUser()
    res = self.db.getSomething("invitation", invite_code, "link")
    if not res:
        raise HTTPError(self.response, 404, "Not Found")
    if res["expiration"] < datetime.datetime.now():
        raise HTTPError(self.response, 403, "forbidden")
    if self.isBannedFromServer(uid, res["server"]):
        raise HTTPError(self.response, 403, "banned from this server")
    if not self.db.getFilters("accessserver", ["account", "=", uid, "and", "server", "=", res["server"]]):
        self.db.insertDict("accessserver", {"account": uid, "server": res["server"]})
    return json.dumps({"server": res["server"], "channel": res.get("channel"), "channel_type": res.get("channel_type")})


@Server.expose
def get_dashboard(self, server_id, service_id):
    uid = self.getUser()
    op = self.db.getSomething("op_servs", server_id, "server")
    if not op:
        raise HTTPError(self.response, 403, "forbidden")

    self.require_server_perm(uid, server_id, "dashboard-read")

    #if mycelium get from self
    if service_id == "mycelium":
        with self.db.pool.connection() as conn:
            board = {"users": conn.execute("SELECT COUNT(*) FROM mycelium_account", ()).fetchone()}
        return json.dumps(board, default=str)
    #if uniauth get from uniauth
    elif service_id == "uniauth":
        with self.uniauth.pool.connection() as conn:
            board = {"users": conn.execute("SELECT COUNT(*) FROM account", ()).fetchone()}
        return json.dumps(board, default=str)
    #else get from unibridge
    else:
        data = self.uniauth.getAll("unibridge", service_id, "source")
        if not data:
            raise HTTPError(self.response, 404, "Not Found")
        board = {}
        for i in range(0, len(data)):
            related = data[i].get("related_table")
            if related:
                board[data[i]["name"]] = self.uniauth.getUnibridgeNotifs(related)
            else:
                board[data[i]["name"]] = data[i]["value"]
        return json.dumps(board, default=str)


@Server.expose
def refresh_dashboard(self, service):
    uid = self.getUser()

    services = {"synapse": {"local": "http://locahost:9876/unibridgeRefresh",
                            "prod": "https://synapse.carbonlab.dev/unibridgeRefresh"}
                }

    if service not in services:
        raise HTTPError(self.response, 404, "Not Found")

    if self.config.get("server", "debug") == "false":
        endpoint = services[service]["prod"]
    else:
        endpoint = services[service]["local"]

    try:
        response = requests.post(endpoint, timeout=10)
        if response.status_code == 200:
            return json.dumps({"status": "ok", "data": response.json()})
        else:
            return json.dumps({"status": "error", "code": response.status_code, "message": response.text})
    except requests.RequestException as e:
        return json.dumps({"status": "error", "message": str(e)})


@Server.expose
def send_email(self, server_id, to, subject, body):
    uid = self.getUser()
    op = self.db.getSomething("op_servs", server_id, "server")
    if not op:
        raise HTTPError(self.response, 403, "forbidden")

    self.require_server_perm(uid, server_id, "dashboard-read")
