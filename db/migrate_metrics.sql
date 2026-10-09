-- Live-metric (computed databases) migration.
-- Safe to run on an existing database; idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_metrics.sql

ALTER TABLE note_database ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'manual';
ALTER TABLE note_database ADD COLUMN IF NOT EXISTS metric_key varchar(64);
ALTER TABLE note_database ADD COLUMN IF NOT EXISTS metric_spec jsonb;

-- Analytics views: the safe surface metrics may query — non-PII columns only.
create or replace view analytics_users as
    select id, inscription, faction
    from mycelium_account;

create or replace view analytics_messages as
    select m.id, m.timestamp, m.sender, tc.server
    from message m
    left join textual_channel tc on tc.id = m.place;

create or replace view analytics_servers as
    select id, name, member_count, storage_usage
    from server;

create or replace view analytics_calls as
    select id, started_at, ended_at, call_type, mode, active
    from call_session;

create or replace view analytics_overview as
    select
        (select count(*) from mycelium_account)          as users,
        (select count(*) from server)                    as servers,
        (select count(*) from message)                   as messages,
        (select count(*) from call_session where active) as active_calls;
