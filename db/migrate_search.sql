-- Global search (Ctrl+K) migration: trigram indexes + frecency support.
-- Safe to run on an existing database; idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_search.sql
-- Needs postgresql-contrib (pg_trgm, unaccent); CREATE EXTENSION requires
-- database-owner privileges the first time it runs.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is only STABLE (its dictionary is resolved per search_path), so
-- Postgres refuses it inside index expressions. Pinning the dictionary makes
-- the result deterministic, hence the IMMUTABLE wrapper indexes are built on.
CREATE OR REPLACE FUNCTION f_unaccent(text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

-- Name-matching indexes for global_search (routes/search.py). Every query
-- normalizes through f_unaccent(lower(...)) — predicates must use the exact
-- same expression or the index is skipped.
create index if not exists idx_textual_channel_name_trgm
    on textual_channel using gin (f_unaccent(lower(name)) gin_trgm_ops);
create index if not exists idx_vocal_channel_name_trgm
    on vocal_channel using gin (f_unaccent(lower(name)) gin_trgm_ops);
create index if not exists idx_drive_channel_name_trgm
    on drive_channel using gin (f_unaccent(lower(name)) gin_trgm_ops);
create index if not exists idx_notes_channel_name_trgm
    on notes_channel using gin (f_unaccent(lower(name)) gin_trgm_ops);
create index if not exists idx_forum_channel_name_trgm
    on forum_channel using gin (f_unaccent(lower(name)) gin_trgm_ops);
create index if not exists idx_forum_post_title_trgm
    on forum_post using gin (f_unaccent(lower(title)) gin_trgm_ops);
create index if not exists idx_drive_file_name_trgm
    on drive_file using gin (f_unaccent(lower(filename)) gin_trgm_ops);
create index if not exists idx_drive_folder_name_trgm
    on drive_folder using gin (f_unaccent(lower(foldername)) gin_trgm_ops);

-- get_frecency aggregates the caller's own recent messages by place.
create index if not exists idx_message_sender_time on message (sender, timestamp);
