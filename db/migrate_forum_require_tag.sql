-- Forum channels: admins can require at least one tag on new posts.
-- Safe to run on an existing database; idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_forum_require_tag.sql

ALTER TABLE forum_channel ADD COLUMN IF NOT EXISTS require_tag boolean DEFAULT false;
