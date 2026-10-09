-- Channel unread + notification preferences migration.
-- Safe to run on an existing database; idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_channel_unread.sql

create table if not exists channel_unread (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL,
    channel integer NOT NULL,
    UNIQUE(account, channel)
);

-- muted_until NULL = indefinitely muted
create table if not exists channel_mute (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL,
    channel integer NOT NULL,
    muted_until TIMESTAMP,
    UNIQUE(account, channel)
);

-- level: 0=all messages, 1=mentions only (default), 2=nothing
-- suppress_everyone: opt out of @everyone/@here pings
create table if not exists notification_pref (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    level integer NOT NULL DEFAULT 1,
    suppress_everyone boolean NOT NULL DEFAULT false,
    UNIQUE(account, server)
);

-- Looked up by channel/server on every channel message (UNIQUE leads with account).
create index if not exists idx_channel_unread_channel on channel_unread(channel);
create index if not exists idx_channel_mute_channel on channel_mute(channel);
create index if not exists idx_notification_pref_server on notification_pref(server);
