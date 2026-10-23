-- Collaborative notes (routes/notes_sync.py, static/crdt/): each notes channel becomes a log
-- of CRDT operations; note_block stays as a copy for search, the MCP server and
-- get_note_content. A note's existing blocks are turned into its first operations the first
-- time it is opened (routes/notes_sync.py _lock_head). For an existing database; idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_note_crdt.sql

BEGIN;

ALTER TABLE note_block ADD COLUMN IF NOT EXISTS pos_key varchar(200) COLLATE "C";
ALTER TABLE note_block ADD COLUMN IF NOT EXISTS sub_key varchar(200) COLLATE "C";
-- Keys compare byte by byte (JS string order), not by the database's collation
ALTER TABLE note_block ALTER COLUMN pos_key TYPE varchar(200) COLLATE "C";
ALTER TABLE note_block ALTER COLUMN sub_key TYPE varchar(200) COLLATE "C";
ALTER TABLE note_block ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;
ALTER TABLE note_block ADD COLUMN IF NOT EXISTS proj_seq bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS note_head (
    channel integer NOT NULL PRIMARY KEY REFERENCES notes_channel(id) ON DELETE CASCADE,
    seq bigint NOT NULL DEFAULT 0,
    max_clock bigint NOT NULL DEFAULT 0,
    compacted_seq bigint NOT NULL DEFAULT 0
);
ALTER TABLE note_head ADD COLUMN IF NOT EXISTS compacted_seq bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS note_client (
    channel integer NOT NULL REFERENCES notes_channel(id) ON DELETE CASCADE,
    client_id bigint NOT NULL,
    account integer NOT NULL,
    max_clock bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (channel, client_id)
);

CREATE TABLE IF NOT EXISTS note_op (
    channel integer NOT NULL REFERENCES notes_channel(id) ON DELETE CASCADE,
    seq bigint NOT NULL,
    client_id bigint NOT NULL,
    clock bigint NOT NULL,
    account integer,
    obj varchar(36) NOT NULL,
    op jsonb NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel, seq),
    UNIQUE (channel, client_id, clock)
);
CREATE INDEX IF NOT EXISTS idx_note_op_obj ON note_op(channel, obj, seq);

COMMIT;
