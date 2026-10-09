-- Moderation migration (docs/moderation.md, routes/moderation.py): server bans,
-- timeouts and log; platform suspensions, reports and op audit log.
-- Safe to run on an existing database; idempotent. Mirrors the end of db/schema.sql.
--   psql -h <host> -U <user> -d <db> -f db/migrate_moderation.sql
-- MUST be applied before deploying: send_message, join_*_server and every
-- authenticated request (suspension gate) read these tables.

create table if not exists server_ban (
    id bigserial NOT NULL PRIMARY KEY,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    account integer NOT NULL,
    reason text,
    banned_by integer NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server, account)
);

create table if not exists server_timeout (
    id bigserial NOT NULL PRIMARY KEY,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    account integer NOT NULL,
    reason text,
    moderator integer NOT NULL,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server, account)
);

create table if not exists moderation_log (
    id bigserial NOT NULL PRIMARY KEY,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    moderator integer NOT NULL,
    target_account integer,
    action varchar(24) NOT NULL,
    reason text,
    metadata jsonb DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
create index if not exists idx_moderation_log_server on moderation_log(server);

create table if not exists account_suspension (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL UNIQUE,
    reason text NOT NULL,
    suspended_by integer NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
);

create table if not exists report (
    id bigserial NOT NULL PRIMARY KEY,
    reporter integer NOT NULL,
    target_message integer,
    target_account integer,
    server integer,
    reason text NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_by integer,
    resolved_at TIMESTAMP
);
create index if not exists idx_report_status on report(status);

create table if not exists platform_action_log (
    id bigserial NOT NULL PRIMARY KEY,
    moderator integer NOT NULL,
    action varchar(32) NOT NULL,
    target_account integer,
    target_server integer,
    reason text,
    metadata jsonb DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
