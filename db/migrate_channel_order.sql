-- Sidebar order (routes/servers.py, static/drag.mjs): every channel and category used to be
-- created at place 0.1, so most servers are full of ties, which a drag can't split (the
-- midpoint of two equal places is the same place). Renumber every list 1, 2, 3… keeping the
-- order shown today. For an existing database; idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_channel_order.sql
-- Lists: the top level of a server (categories + channels without category) and each category.

BEGIN;

-- A channel pointing to a category that doesn't exist (anymore) is shown at the top level,
-- but the sidebar template renders it as a broken category: make it a top-level channel.
UPDATE textual_channel t SET category = NULL WHERE category IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM server_cat c WHERE c.id = t.category AND c.server = t.server);
UPDATE vocal_channel t SET category = NULL WHERE category IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM server_cat c WHERE c.id = t.category AND c.server = t.server);
UPDATE drive_channel t SET category = NULL WHERE category IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM server_cat c WHERE c.id = t.category AND c.server = t.server);
UPDATE notes_channel t SET category = NULL WHERE category IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM server_cat c WHERE c.id = t.category AND c.server = t.server);
UPDATE forum_channel t SET category = NULL WHERE category IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM server_cat c WHERE c.id = t.category AND c.server = t.server);

-- New position of every item, with ties ordered the way crud.mjs orderServDirs shows them:
--   in a category: place, then type (textual, vocal, drive, note, forum), then id;
--   at the top level: place, channels before categories (firstGreater uses >=), among
--   channels the last inserted first (type and id descending), categories by id.
CREATE TEMP TABLE sidebar_rank ON COMMIT DROP AS
SELECT tbl, id, place,
       row_number() OVER (
           PARTITION BY server, container
           ORDER BY place,
                    kind,
                    CASE WHEN container IS NULL AND kind = 0 THEN -type_rank ELSE type_rank END,
                    CASE WHEN container IS NULL AND kind = 0 THEN -id ELSE id END
       ) AS rn
FROM (
    SELECT 'server_cat' AS tbl, id, server, NULL::bigint AS container, place, 1 AS kind, 0 AS type_rank FROM server_cat
    UNION ALL SELECT 'textual_channel', id, server, category, place, 0, 0 FROM textual_channel
    UNION ALL SELECT 'vocal_channel', id, server, category, place, 0, 1 FROM vocal_channel
    UNION ALL SELECT 'drive_channel', id, server, category, place, 0, 2 FROM drive_channel
    UNION ALL SELECT 'notes_channel', id, server, category, place, 0, 3 FROM notes_channel
    UNION ALL SELECT 'forum_channel', id, server, category, place, 0, 4 FROM forum_channel
) items;

UPDATE server_cat t SET place = r.rn FROM sidebar_rank r
    WHERE r.tbl = 'server_cat' AND r.id = t.id AND t.place <> r.rn;
UPDATE textual_channel t SET place = r.rn FROM sidebar_rank r
    WHERE r.tbl = 'textual_channel' AND r.id = t.id AND t.place <> r.rn;
UPDATE vocal_channel t SET place = r.rn FROM sidebar_rank r
    WHERE r.tbl = 'vocal_channel' AND r.id = t.id AND t.place <> r.rn;
UPDATE drive_channel t SET place = r.rn FROM sidebar_rank r
    WHERE r.tbl = 'drive_channel' AND r.id = t.id AND t.place <> r.rn;
UPDATE notes_channel t SET place = r.rn FROM sidebar_rank r
    WHERE r.tbl = 'notes_channel' AND r.id = t.id AND t.place <> r.rn;
UPDATE forum_channel t SET place = r.rn FROM sidebar_rank r
    WHERE r.tbl = 'forum_channel' AND r.id = t.id AND t.place <> r.rn;
COMMIT;
