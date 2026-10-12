"""Global search (Ctrl+K) — name search over channels, forum posts and drive
items, plus the frecency signal the client uses to rank results.

Servers and DMs are deliberately NOT searched here: the client already holds
all of them (get_user_servers / get_user_convs), and a DM's displayed name only
exists client-side (getConvName concatenates the other members' display names).

Matching is trigram-based (pg_trgm) over f_unaccent(lower(...)) so typos and
missing accents still match; see db/migrate_search.sql for the indexes — every
predicate here must use that exact expression to stay indexed. The server only
does recall: candidates are re-scored and ordered client-side (fuzzyScore +
frecency), so all result sources rank through one code path.
"""
import json

from vesta import Server, HTTPError

MIN_QUERY_LENGTH = 2
MAX_QUERY_LENGTH = 100
PER_KIND_LIMIT = 15
# Over-fetch so the privacy post-filter can drop rows without starving results.
FETCH_LIMIT = 30
# More permissive than the 0.6 default: short queries against long filenames.
WORD_SIM_THRESHOLD = "0.25"
# Frecency: exponential decay with a 30-day half-life over a 90-day window.
FRECENCY_TAU_S = 30 * 86400 / 0.6931471805599453
FRECENCY_WINDOW = "90 days"
# Payload cap: only the strongest signals matter for ranking ~20 rows.
FRECENCY_MAX_PLACES = 500

# One branch per channel table. The kind labels are checkChannelAccess's
# channelType strings so the privacy post-filter can pass them through as-is.
_CHANNEL_BRANCH = """
(SELECT c.id, c.name, c.server, c.is_private, '{kind}' AS kind,
        word_similarity(f_unaccent(lower(%(q)s)), f_unaccent(lower(c.name))) AS sim
 FROM {table} c
 JOIN accessserver a ON a.server = c.server AND a.account = %(uid)s
 WHERE f_unaccent(lower(%(q)s)) <%% f_unaccent(lower(c.name))
    OR f_unaccent(lower(c.name)) LIKE f_unaccent(lower(%(prefix)s))
 ORDER BY sim DESC LIMIT %(lim)s)
"""

_CHANNELS_SQL = " UNION ALL ".join(
    _CHANNEL_BRANCH.format(kind=kind, table=table)
    for kind, table in [
        ("textual", "textual_channel"),
        ("vocal", "vocal_channel"),
        ("drive", "drive_channel"),
        ("note", "notes_channel"),
        ("forum", "forum_channel"),
    ]
)

_POSTS_SQL = """
SELECT p.id, p.title AS name, p.server, p.forum, f.name AS forum_name,
       f.is_private, 'post' AS kind,
       word_similarity(f_unaccent(lower(%(q)s)), f_unaccent(lower(p.title))) AS sim
FROM forum_post p
JOIN forum_channel f ON f.id = p.forum
JOIN accessserver a ON a.server = p.server AND a.account = %(uid)s
WHERE f_unaccent(lower(%(q)s)) <%% f_unaccent(lower(p.title))
   OR f_unaccent(lower(p.title)) LIKE f_unaccent(lower(%(prefix)s))
ORDER BY sim DESC LIMIT %(lim)s
"""

_FILES_SQL = """
SELECT fi.id, fi.filename AS name, d.server, fi.drive_channel, fi.parent_folder,
       d.name AS drive_name, d.is_private, 'file' AS kind,
       word_similarity(f_unaccent(lower(%(q)s)), f_unaccent(lower(fi.filename))) AS sim
FROM drive_file fi
JOIN drive_channel d ON d.id = fi.drive_channel
JOIN accessserver a ON a.server = d.server AND a.account = %(uid)s
WHERE f_unaccent(lower(%(q)s)) <%% f_unaccent(lower(fi.filename))
   OR f_unaccent(lower(fi.filename)) LIKE f_unaccent(lower(%(prefix)s))
ORDER BY sim DESC LIMIT %(lim)s
"""

_FOLDERS_SQL = """
SELECT fo.id, fo.foldername AS name, d.server, fo.drive_channel, fo.parent_folder,
       d.name AS drive_name, d.is_private, 'folder' AS kind,
       word_similarity(f_unaccent(lower(%(q)s)), f_unaccent(lower(fo.foldername))) AS sim
FROM drive_folder fo
JOIN drive_channel d ON d.id = fo.drive_channel
JOIN accessserver a ON a.server = d.server AND a.account = %(uid)s
WHERE f_unaccent(lower(%(q)s)) <%% f_unaccent(lower(fo.foldername))
   OR f_unaccent(lower(fo.foldername)) LIKE f_unaccent(lower(%(prefix)s))
ORDER BY sim DESC LIMIT %(lim)s
"""

# Ancestor chains for the folders that contain the file/folder hits, so the
# client can rebuild the drive breadcrumb stack without walking the tree over
# HTTP. depth DESC orders each chain root-first.
_PATHS_SQL = """
WITH RECURSIVE anc AS (
    SELECT id, foldername, parent_folder, id AS leaf, 0 AS depth
    FROM drive_folder WHERE id = ANY(%(ids)s)
  UNION ALL
    SELECT f.id, f.foldername, f.parent_folder, anc.leaf, anc.depth + 1
    FROM drive_folder f JOIN anc ON f.id = anc.parent_folder
)
SELECT leaf, id, foldername FROM anc ORDER BY leaf, depth DESC
"""

_FRECENCY_PLACES_SQL = """
SELECT place, SUM(EXP(- EXTRACT(EPOCH FROM (now() - timestamp)) / %(tau)s)) AS score
FROM message
WHERE sender = %(uid)s AND timestamp > now() - interval '{window}'
GROUP BY place
ORDER BY score DESC LIMIT %(max_places)s
""".format(window=FRECENCY_WINDOW)

# Roll the same activity up to servers. Textual channels and forum posts are
# the two message places that belong to a server; DMs fall out via the joins.
_FRECENCY_SERVERS_SQL = """
SELECT COALESCE(tc.server, fp.server) AS server,
       SUM(EXP(- EXTRACT(EPOCH FROM (now() - m.timestamp)) / %(tau)s)) AS score
FROM message m
LEFT JOIN textual_channel tc ON tc.id = m.place
LEFT JOIN forum_post fp ON fp.id = m.place
WHERE m.sender = %(uid)s AND m.timestamp > now() - interval '{window}'
  AND COALESCE(tc.server, fp.server) IS NOT NULL
GROUP BY 1
""".format(window=FRECENCY_WINDOW)


def _like_prefix(query):
    """Escape LIKE wildcards in the user's query and turn it into a prefix
    pattern (backslash is the default LIKE escape character)."""
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return escaped + "%"


def _visible(self, uid, channel_id, channel_type, cache):
    """Same rule as get_serv_content: checkChannelAccess "view" (private channels
    AND view overwrites on public ones). Memoised per channel for this request."""
    key = (channel_id, channel_type)
    if key not in cache:
        cache[key] = self.checkChannelAccess(uid, channel_id, channel_type, "view")
    return cache[key]


@Server.expose
def global_search(self, query):
    uid = self.getUser()

    query = (query or "").strip()
    if len(query) < MIN_QUERY_LENGTH:
        raise HTTPError(self.response, 400, "query too short")
    if len(query) > MAX_QUERY_LENGTH:
        raise HTTPError(self.response, 400, "query too long")

    params = {"q": query, "prefix": _like_prefix(query), "uid": uid, "lim": FETCH_LIMIT}

    with self.db.pool.connection() as conn:
        # One transaction so the set_config (is_local=true) covers every query
        # despite the pool's autocommit mode.
        with conn.transaction():
            conn.execute("SELECT set_config('pg_trgm.word_similarity_threshold', %s, true)",
                         (WORD_SIM_THRESHOLD,))
            channels = conn.execute(_CHANNELS_SQL, params).fetchall()
            posts = conn.execute(_POSTS_SQL, params).fetchall()
            files = conn.execute(_FILES_SQL, params).fetchall()
            folders = conn.execute(_FOLDERS_SQL, params).fetchall()

            parent_ids = {r["parent_folder"] for r in files if r["parent_folder"]}
            parent_ids |= {r["parent_folder"] for r in folders if r["parent_folder"]}
            paths = {}
            if parent_ids:
                for row in conn.execute(_PATHS_SQL, {"ids": list(parent_ids)}).fetchall():
                    paths.setdefault(row["leaf"], []).append(
                        {"id": row["id"], "name": row["foldername"]})

    seen = {}
    channels = [r for r in channels if _visible(self, uid, r["id"], r["kind"], seen)]
    # The UNION concatenates five per-table batches (each sorted); re-sort so
    # the trim below doesn't systematically favor textual channels.
    channels.sort(key=lambda r: r["sim"], reverse=True)
    posts = [r for r in posts if _visible(self, uid, r["forum"], "forum", seen)]
    files = [r for r in files if _visible(self, uid, r["drive_channel"], "drive", seen)]
    folders = [r for r in folders if _visible(self, uid, r["drive_channel"], "drive", seen)]

    for r in files + folders:
        r["path"] = paths.get(r["parent_folder"], [])

    results = {
        "channels": channels[:PER_KIND_LIMIT],
        "posts": posts[:PER_KIND_LIMIT],
        "files": files[:PER_KIND_LIMIT],
        "folders": folders[:PER_KIND_LIMIT],
    }
    for rows in results.values():
        for r in rows:
            r.pop("is_private", None)
            r["sim"] = float(r["sim"])
    return json.dumps(results, default=str)


@Server.expose
def get_frecency(self):
    """Where the caller has been active, as {place id -> decayed score} plus a
    per-server rollup. Fetched once per session; the client ranks all palette
    results (local and remote) with it."""
    uid = self.getUser()
    params = {"uid": uid, "tau": FRECENCY_TAU_S, "max_places": FRECENCY_MAX_PLACES}

    with self.db.pool.connection() as conn:
        place_rows = conn.execute(_FRECENCY_PLACES_SQL, params).fetchall()
        server_rows = conn.execute(_FRECENCY_SERVERS_SQL, params).fetchall()

    return json.dumps({
        "places": {r["place"]: float(r["score"]) for r in place_rows},
        "servers": {r["server"]: float(r["score"]) for r in server_rows},
    })
