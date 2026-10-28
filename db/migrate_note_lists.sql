-- Notes: bulleted / numbered list items have a level (note_block.indent, a field of the
-- notes CRDT, see static/crdt/doc.mjs). For an existing database; idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_note_lists.sql

ALTER TABLE note_block ADD COLUMN IF NOT EXISTS indent smallint NOT NULL DEFAULT 0;
