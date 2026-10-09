create table if not exists mycelium_account(
    id int NOT NULL PRIMARY KEY,
    display varchar(24) DEFAULT 'Mycelium User',
    username varchar(24) NOT NULL,
    inscription TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    pronouns varchar(24),
    description varchar(250),
    faction varchar(24),
    pfp text,
    banner text,
    current_room integer,
    storage_usage bigint DEFAULT 0
);

create table if not exists status(
   id int NOT NULL PRIMARY KEY,
   mode numeric not null default 0,
   emoji varchar,
   text varchar(40),
   expiration timestamp
);

create table if not exists server (
    id bigserial NOT NULL PRIMARY KEY,
    name varchar(44) NOT NULL,
    owner integer NOT NULL,
    pfp text,
    is_community boolean DEFAULT false,
    tags jsonb DEFAULT '[]',
    languages jsonb DEFAULT '[]',
    is_featured boolean DEFAULT false,
    description text,
    member_count integer DEFAULT 0,
    storage_usage bigint DEFAULT 0
);

create table if not exists accessServer (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE
);

-- Trigger function to update server member_count
CREATE OR REPLACE FUNCTION update_server_member_count()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        UPDATE server SET member_count = member_count + 1 WHERE id = NEW.server;
    ELSIF (TG_OP = 'DELETE') THEN
        UPDATE server SET member_count = member_count - 1 WHERE id = OLD.server;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on accessServer for member_count
DROP TRIGGER IF EXISTS update_member_count_trigger ON accessServer;
CREATE TRIGGER update_member_count_trigger
AFTER INSERT OR DELETE ON accessServer
FOR EACH ROW
EXECUTE FUNCTION update_server_member_count();

create table if not exists server_cat (
    id bigserial NOT NULL PRIMARY KEY,
    name varchar(44) NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    place float NOT NULL DEFAULT 0.1
);

create table if not exists conversationElement (
    id bigserial NOT NULL PRIMARY KEY
);

create table if not exists conversation (
    name varchar(255) NOT NULL,
    private bool default true,
    last_activity timestamp DEFAULT CURRENT_TIMESTAMP,
    pfp varchar(255)
) inherits (conversationElement);

create table if not exists textual_channel (
    name varchar(255) NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    category integer,
    place float NOT NULL DEFAULT 0.1,
    is_private boolean DEFAULT false
) inherits (conversationElement);

create table if not exists forum_channel (
    name varchar(255) NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    category integer,
    place float NOT NULL DEFAULT 0.1,
    is_private boolean DEFAULT false,
    available_tags jsonb DEFAULT '[]',
    default_layout varchar(10) DEFAULT 'list',
    default_sort varchar(12) DEFAULT 'activity',
    guidelines text,
    PRIMARY KEY (id)
) inherits (conversationElement);

create table if not exists forum_post (
    forum integer NOT NULL REFERENCES forum_channel(id) ON DELETE CASCADE,
    server integer NOT NULL,
    author integer NOT NULL,
    title varchar(255) NOT NULL,
    tags jsonb DEFAULT '[]',
    pinned boolean DEFAULT false,
    locked boolean DEFAULT false,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    last_activity timestamp DEFAULT CURRENT_TIMESTAMP
) inherits (conversationElement);

create index if not exists idx_forum_post_forum on forum_post(forum);

create table if not exists accessConversation (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL,
    conversation integer NOT NULL
);

create table if not exists message (
    id bigserial NOT NULL PRIMARY KEY,
    sender integer NOT NULL,
    place integer NOT NULL,
    body TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reply integer REFERENCES message(id),
    edited bool default false,
    attachments json
);

create table if not exists message_reaction (
    id bigserial NOT NULL PRIMARY KEY,
    message integer NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    account integer NOT NULL,
    emoji varchar(255) NOT NULL,
    UNIQUE(message, account, emoji)
);

create index if not exists idx_message_reaction_message on message_reaction(message);

create table if not exists blockship (
    id bigserial NOT NULL PRIMARY KEY,
    blocker integer not null,
    blocked integer not null
);

create table if not exists boatakopin (
    id bigserial NOT NULL PRIMARY KEY,
    kopinPrincipal integer not null,
    kopinSecondaire integer not null,
    accepted bool,
    conv integer
);

create table if not exists active_client (
    id bigserial NOT NULL PRIMARY KEY,
    userid integer not null,
    server integer not null,
    idle bool default false
);

create table if not exists subscription (
    client INTEGER NOT NULL,
    account INTEGER NOT NULL,
    PRIMARY KEY (client, account)
);

create table if not exists invitation (
    id bigserial NOT NULL PRIMARY KEY,
    server integer not null references server(id) ON DELETE CASCADE,
    link varchar(8) NOT NULL,
    expiration TIMESTAMP
);

create table if not exists role (
    id bigserial NOT NULL PRIMARY KEY,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    name varchar(24) NOT NULL,
    color varchar(7) DEFAULT '#A8A8A8',
    permissions jsonb DEFAULT '{}'
);


create table if not exists role_attribution (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL,
    role integer NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE
);

create table if not exists offline_notifs (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL,
    conversation integer NOT NULL,
    number integer NOT NULL DEFAULT 1
);

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
-- suppress_everyone: opt out of @everyone and @here pings for this server
create table if not exists notification_pref (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    level integer NOT NULL DEFAULT 1,
    suppress_everyone boolean NOT NULL DEFAULT false,
    UNIQUE(account, server)
);

-- These tables are looked up by channel/server on every channel message; the
-- UNIQUE(account, ...) constraints lead with account so they don't cover it.
create index if not exists idx_channel_unread_channel on channel_unread(channel);
create index if not exists idx_channel_mute_channel on channel_mute(channel);
create index if not exists idx_notification_pref_server on notification_pref(server);

create table if not exists op_servs (
    id bigserial NOT NULL PRIMARY KEY,
    server integer NOT NULL references server(id) ON DELETE CASCADE
);

create table if not exists drive_channel (
    id bigserial NOT NULL PRIMARY KEY,
    name varchar(255) NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    category integer,
    place float NOT NULL DEFAULT 0.1,
    is_private boolean DEFAULT false
);

create table if not exists vocal_channel (
    id bigserial NOT NULL PRIMARY KEY,
    name varchar(255) NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    category integer,
    place float NOT NULL DEFAULT 0.1,
    is_private boolean DEFAULT false
);

create table if not exists notes_channel (
    id bigserial NOT NULL PRIMARY KEY,
    name varchar(255) NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    category integer,
    place float NOT NULL DEFAULT 0.1,
    is_private boolean DEFAULT false
);

create table if not exists note_block (
    id bigserial NOT NULL PRIMARY KEY,
    channel integer NOT NULL,
    parent_block integer REFERENCES note_block(id),
    type varchar(50) NOT NULL,
    position float NOT NULL DEFAULT 0.1,
    content text default '',
    uuid varchar(36) NOT NULL UNIQUE,
    row_group varchar(36),
    column_index integer DEFAULT 0,
    sub_position float DEFAULT 0.1
);

create table if not exists note_database (
    id bigserial NOT NULL PRIMARY KEY,
    block_uuid varchar(36) NOT NULL REFERENCES note_block(uuid) ON DELETE CASCADE,
    channel integer NOT NULL,
    name varchar(255) NOT NULL DEFAULT 'Untitled Database',
    view_type varchar(10) NOT NULL DEFAULT 'table',
    gallery_cover_column integer,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

create table if not exists note_database_column (
    id bigserial NOT NULL PRIMARY KEY,
    database_id integer NOT NULL REFERENCES note_database(id) ON DELETE CASCADE,
    name varchar(255) NOT NULL DEFAULT 'Column',
    type varchar(20) NOT NULL DEFAULT 'text',
    position float NOT NULL DEFAULT 0.1,
    options jsonb DEFAULT '{}'
);

create table if not exists note_database_row (
    id bigserial NOT NULL PRIMARY KEY,
    database_id integer NOT NULL REFERENCES note_database(id) ON DELETE CASCADE,
    position float NOT NULL DEFAULT 0.1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

create table if not exists note_database_cell (
    id bigserial NOT NULL PRIMARY KEY,
    row_id integer NOT NULL REFERENCES note_database_row(id) ON DELETE CASCADE,
    column_id integer NOT NULL REFERENCES note_database_column(id) ON DELETE CASCADE,
    value text DEFAULT '',
    UNIQUE(row_id, column_id)
);

create index if not exists idx_note_database_block on note_database(block_uuid);
create index if not exists idx_note_database_column_db on note_database_column(database_id);
create index if not exists idx_note_database_row_db on note_database_row(database_id);
create index if not exists idx_note_database_cell_row on note_database_cell(row_id);
create index if not exists idx_note_database_cell_col on note_database_cell(column_id);

create table if not exists note_spreadsheet (
    id bigserial NOT NULL PRIMARY KEY,
    block_uuid varchar(36) NOT NULL REFERENCES note_block(uuid) ON DELETE CASCADE,
    channel integer NOT NULL,
    rows integer NOT NULL DEFAULT 3,
    cols integer NOT NULL DEFAULT 2,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

create table if not exists note_spreadsheet_cell (
    id bigserial NOT NULL PRIMARY KEY,
    spreadsheet_id integer NOT NULL REFERENCES note_spreadsheet(id) ON DELETE CASCADE,
    row_idx integer NOT NULL CHECK (row_idx >= 1),
    col_idx integer NOT NULL CHECK (col_idx >= 0),
    value text DEFAULT '',
    text_color varchar(9),
    bg_color varchar(9),
    align varchar(6),
    decimals smallint,
    UNIQUE(spreadsheet_id, row_idx, col_idx)
);

create table if not exists note_spreadsheet_col (
    id bigserial NOT NULL PRIMARY KEY,
    spreadsheet_id integer NOT NULL REFERENCES note_spreadsheet(id) ON DELETE CASCADE,
    col_idx integer NOT NULL CHECK (col_idx >= 0),
    width_px integer NOT NULL DEFAULT 120 CHECK (width_px >= 40 AND width_px <= 1200),
    UNIQUE(spreadsheet_id, col_idx)
);

create index if not exists idx_note_spreadsheet_block on note_spreadsheet(block_uuid);
create index if not exists idx_note_spreadsheet_cell_sheet on note_spreadsheet_cell(spreadsheet_id);
create index if not exists idx_note_spreadsheet_cell_sheet_row on note_spreadsheet_cell(spreadsheet_id, row_idx);
create index if not exists idx_note_spreadsheet_cell_sheet_col on note_spreadsheet_cell(spreadsheet_id, col_idx);
create index if not exists idx_note_spreadsheet_col_sheet on note_spreadsheet_col(spreadsheet_id);

-- Per-cell formatting (color, alignment, decimals). Added after initial ship.
ALTER TABLE note_spreadsheet_cell ADD COLUMN IF NOT EXISTS text_color varchar(9);
ALTER TABLE note_spreadsheet_cell ADD COLUMN IF NOT EXISTS bg_color varchar(9);
ALTER TABLE note_spreadsheet_cell ADD COLUMN IF NOT EXISTS align varchar(6);
ALTER TABLE note_spreadsheet_cell ADD COLUMN IF NOT EXISTS decimals smallint;

create table if not exists API_key (
    id bigserial NOT NULL PRIMARY KEY,
    key varchar(64) UNIQUE NOT NULL,
    owner integer NOT NULL,
    name varchar(255) DEFAULT ''
);

create table if not exists personal_server(
    id bigserial NOT NULL PRIMARY KEY,
    owner integer NOT NULL,
    server integer NOT NULL references server(id) ON DELETE CASCADE
);

create table if not exists drive_folder (
    id bigserial NOT NULL PRIMARY KEY,
    drive_channel integer NOT NULL,
    foldername varchar(255) NOT NULL,
    parent_folder integer,
    creator integer NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_folder) REFERENCES drive_folder(id) ON DELETE CASCADE
);

create table if not exists drive_file (
    id bigserial NOT NULL PRIMARY KEY,
    drive_channel integer NOT NULL,
    filename varchar(255) NOT NULL,
    filepath text NOT NULL,
    size bigint,
    uploader integer NOT NULL,
    parent_folder integer,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_folder) REFERENCES drive_folder(id) ON DELETE CASCADE
);

create table if not exists call_session (
    id bigserial NOT NULL PRIMARY KEY,
    conversation_id integer NOT NULL,
    participants jsonb NOT NULL DEFAULT '[]',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    call_type varchar(10) NOT NULL DEFAULT 'audio',
    mode varchar(10) NOT NULL DEFAULT 'p2p',
    active boolean NOT NULL DEFAULT true
);

create index if not exists idx_call_session_conversation on call_session(conversation_id);
create index if not exists idx_call_session_active on call_session(active);

create table if not exists channel_permission (
    id bigserial NOT NULL PRIMARY KEY,
    channel integer NOT NULL,
    channel_type varchar(20) NOT NULL,
    role integer NOT NULL references role(id) ON DELETE CASCADE,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    permissions jsonb DEFAULT '{}'
);

create index if not exists idx_channel_permission_channel on channel_permission(channel, channel_type);
create index if not exists idx_channel_permission_role on channel_permission(role);

create table if not exists device_token (
    id bigserial NOT NULL PRIMARY KEY,
    account integer NOT NULL references mycelium_account(id) ON DELETE CASCADE,
    token text NOT NULL,
    platform varchar(10) NOT NULL DEFAULT 'fcm', -- 'ios', 'android', 'fcm'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (account, token)
);

create index if not exists idx_device_token_account on device_token(account);

create table if not exists poll (
    id bigserial NOT NULL PRIMARY KEY,
    message integer NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    question text NOT NULL,
    multiple_choice boolean DEFAULT false,
    allow_user_options boolean DEFAULT false
);

create index if not exists idx_poll_message on poll(message);

create table if not exists poll_option (
    id bigserial NOT NULL PRIMARY KEY,
    poll integer NOT NULL REFERENCES poll(id) ON DELETE CASCADE,
    text text NOT NULL,
    creator integer NOT NULL
);

create index if not exists idx_poll_option_poll on poll_option(poll);

create table if not exists poll_vote (
    id bigserial NOT NULL PRIMARY KEY,
    poll integer NOT NULL REFERENCES poll(id) ON DELETE CASCADE,
    option integer NOT NULL REFERENCES poll_option(id) ON DELETE CASCADE,
    voter integer NOT NULL,
    UNIQUE(poll, option, voter)
);

create index if not exists idx_poll_vote_poll on poll_vote(poll);
create index if not exists idx_poll_vote_option on poll_vote(option);

create table if not exists server_emoji (
    id bigserial NOT NULL PRIMARY KEY,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    name varchar(64) NOT NULL,
    file text NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
create index if not exists idx_server_emoji_server on server_emoji(server);

-- Extend note_spreadsheet to support conversation-attached blocks
ALTER TABLE note_spreadsheet ADD COLUMN IF NOT EXISTS conv_id integer;
ALTER TABLE note_spreadsheet ADD COLUMN IF NOT EXISTS message_id integer REFERENCES message(id) ON DELETE CASCADE;
ALTER TABLE note_spreadsheet ALTER COLUMN channel DROP NOT NULL;
ALTER TABLE note_spreadsheet ALTER COLUMN block_uuid DROP NOT NULL;
ALTER TABLE note_spreadsheet DROP CONSTRAINT IF EXISTS note_spreadsheet_block_uuid_fkey;

create index if not exists idx_note_spreadsheet_conv    on note_spreadsheet(conv_id);
create index if not exists idx_note_spreadsheet_message on note_spreadsheet(message_id);

-- Computed (live-metric) databases: rows are generated from a whitelisted
-- server-side aggregate query at read time, never stored. No history.
-- metric_key references a named preset; metric_spec holds a declarative
-- MetricSpec compiled by metrics.py. See metrics.py for the semantic layer.
ALTER TABLE note_database ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'manual';
ALTER TABLE note_database ADD COLUMN IF NOT EXISTS metric_key varchar(64);
ALTER TABLE note_database ADD COLUMN IF NOT EXISTS metric_spec jsonb;

-- Analytics views: the safe surface metrics can query. They join/derive what
-- dashboards need and expose ONLY non-PII columns (ids, timestamps, counts) —
-- never email, message bodies, hashes, tokens, avatars, etc. The metrics
-- catalog (metrics.py) declares dimensions/measures over these views only.
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

create index if not exists idx_message_place_timestamp on message(place, timestamp desc);

-- Vocal channels: call_session can be tied to a vocal channel instead of a conversation
ALTER TABLE call_session ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE call_session ADD COLUMN IF NOT EXISTS vocal_channel_id integer;
create index if not exists idx_call_session_vocal_channel on call_session(vocal_channel_id) where vocal_channel_id is not null;
-- At most one active call per vocal channel (guards the simultaneous-first-join race)
create unique index if not exists idx_call_session_active_vocal on call_session(vocal_channel_id) where active and vocal_channel_id is not null;

CREATE OR REPLACE FUNCTION bump_conversation_activity() RETURNS trigger AS $$
BEGIN
    UPDATE conversation
    SET last_activity = GREATEST(last_activity, NEW.timestamp)
    WHERE id = NEW.place;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bump_conversation_activity ON message;
CREATE TRIGGER trg_bump_conversation_activity
    AFTER INSERT ON message
    FOR EACH ROW EXECUTE FUNCTION bump_conversation_activity();

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is only STABLE (its dictionary is resolved per search_path), so
-- Postgres refuses it inside index expressions. Pinning the dictionary makes
-- the result deterministic, hence the IMMUTABLE wrapper indexes are built on.
CREATE OR REPLACE FUNCTION f_unaccent(text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT public.unaccent('public.unaccent', $1) $$;


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

-- Moderation (docs/moderation.md, routes/moderation.py). Mirrored in db/migrate_moderation.sql.
-- Server-level: bans, timeouts (expires_at NULL = indefinite) and the per-server log.
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
    action varchar(24) NOT NULL, -- kick | ban | unban | timeout | untimeout | purge | manage_messages_delete
    reason text,
    metadata jsonb DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
create index if not exists idx_moderation_log_server on moderation_log(server);

-- Platform-level (op users): suspensions (expires_at NULL = indefinite), reports, op audit log.
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
    target_message integer,   -- message(id), nullable
    target_account integer,   -- nullable; user-level report if no message
    server integer,           -- nullable (DM reports have no server)
    reason text NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'open', -- open | actioned | dismissed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_by integer,
    resolved_at TIMESTAMP
);
create index if not exists idx_report_status on report(status);

create table if not exists platform_action_log (
    id bigserial NOT NULL PRIMARY KEY,
    moderator integer NOT NULL,
    action varchar(32) NOT NULL, -- suspend_user | unsuspend_user | delete_server | delete_message | resolve_report | dismiss_report
    target_account integer,
    target_server integer,
    reason text,
    metadata jsonb DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

