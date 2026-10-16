-- Indexes behind every request's permission checks (membership, roles, channel
-- overwrites) and the server listing (get_serv_content). For an existing database
-- (db/schema.sql already creates new ones with them); idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_perf_indexes.sql

-- Membership: require_member / checkAccessRights (account + server), member lists (server),
-- the user's servers (account)
create index if not exists idx_accessserver_server on accessServer(server, account);
create index if not exists idx_accessserver_account on accessServer(account);

-- Loaded per server by channelContext / getRights / get_serv_content
create index if not exists idx_role_server on role(server);
create index if not exists idx_server_cat_server on server_cat(server);
create index if not exists idx_channel_permission_server on channel_permission(server);
create index if not exists idx_textual_channel_server on textual_channel(server);
create index if not exists idx_vocal_channel_server on vocal_channel(server);
create index if not exists idx_drive_channel_server on drive_channel(server);
create index if not exists idx_notes_channel_server on notes_channel(server);
create index if not exists idx_forum_channel_server on forum_channel(server);

-- Tables inheriting conversationElement don't get its primary key: lookups by id
-- (every channel check, every message's place) were sequential scans.
create index if not exists idx_conversation_id on conversation(id);
create index if not exists idx_textual_channel_id on textual_channel(id);
create index if not exists idx_forum_post_id on forum_post(id);
-- forum_channel declares PRIMARY KEY (id), but only databases created after it was added have it
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                   WHERE i.indrelid = 'forum_channel'::regclass AND i.indnatts = 1 AND a.attname = 'id') THEN
        CREATE INDEX idx_forum_channel_id ON forum_channel(id);
    END IF;
END $$;
