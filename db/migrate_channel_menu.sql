-- Channel & category right-click menus: per channel/category notification settings
-- (mute + level) replace channel_mute, and invitations can target a channel.
-- Idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_channel_menu.sql

create table if not exists notification_override (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL,
    target integer NOT NULL,
    is_category boolean NOT NULL DEFAULT false,
    muted boolean NOT NULL DEFAULT false,
    muted_until TIMESTAMP,
    level integer,
    UNIQUE(account, target, is_category)
);
create index if not exists idx_notification_override_target on notification_override(target, is_category);

DO $$
BEGIN
    IF to_regclass('channel_mute') IS NOT NULL THEN
        INSERT INTO notification_override (account, target, muted, muted_until)
        SELECT account, channel, true, muted_until FROM channel_mute
        ON CONFLICT DO NOTHING;
        DROP TABLE channel_mute;
    END IF;
END $$;

alter table invitation add column if not exists channel integer;
alter table invitation add column if not exists channel_type varchar(10);
