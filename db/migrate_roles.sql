-- Roles overhaul (routes/roles.py, static/roles.mjs, permissions.py): role hierarchy,
-- @everyone default permissions, split of the legacy "edit" right, FK cleanup.
-- For an existing database (db/schema.sql already creates new ones with these
-- columns); idempotent.
--   psql -h <host> -U <user> -d <db> -f db/migrate_roles.sql
-- MUST be applied before deploying: every permission check reads role.position,
-- server.default_permissions and channel_permission.deny; the "edit" right no longer exists.

-- Hierarchy: 0 = top of the list (highest role). New roles are appended at the bottom.
ALTER TABLE role ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
-- Backfill only servers whose positions are not distinct yet (keeps manual reorders on re-run).
UPDATE role r SET position = sub.rn
FROM (SELECT id, row_number() OVER (PARTITION BY server ORDER BY id) - 1 AS rn FROM role) sub
WHERE r.id = sub.id
  AND r.server IN (SELECT server FROM role GROUP BY server HAVING count(DISTINCT position) < count(*));

-- @everyone: permissions every member of the server gets, on top of their roles.
ALTER TABLE server ADD COLUMN IF NOT EXISTS default_permissions jsonb DEFAULT '{}';

-- Deleting a role used to leave its attributions behind, which crashed getRights
-- (KeyError) for every member who had it. Drop orphans/duplicates, then let the DB cascade.
DELETE FROM role_attribution ra WHERE NOT EXISTS (SELECT 1 FROM role r WHERE r.id = ra.role);
DELETE FROM role_attribution a USING role_attribution b
WHERE a.account = b.account AND a.role = b.role AND a.id > b.id;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'role_attribution_role_fkey') THEN
        ALTER TABLE role_attribution ADD CONSTRAINT role_attribution_role_fkey
            FOREIGN KEY (role) REFERENCES role(id) ON DELETE CASCADE;
    END IF;
END $$;
create unique index if not exists idx_role_attribution_unique on role_attribution(account, role);
create index if not exists idx_role_attribution_server on role_attribution(server, account);

-- The catch-all "edit" right is split into explicit ones (permissions.py).
UPDATE role SET permissions = (permissions - 'edit')
    || '{"manage-server": "", "manage-channels": "", "manage-expressions": "", "edit-notes": "", "manage-files": ""}'::jsonb
WHERE permissions ? 'edit';

-- Channel permission overwrites (routes/roles.py edit_channel_permissions): per member
-- (account) as well as per role, with a deny list; role NULL + account NULL = @everyone.
ALTER TABLE channel_permission ADD COLUMN IF NOT EXISTS deny jsonb DEFAULT '{}';
ALTER TABLE channel_permission ADD COLUMN IF NOT EXISTS account integer;
ALTER TABLE channel_permission ALTER COLUMN role DROP NOT NULL;
DELETE FROM channel_permission a USING channel_permission b
WHERE a.channel = b.channel AND a.channel_type = b.channel_type
  AND coalesce(a.role, 0) = coalesce(b.role, 0) AND coalesce(a.account, 0) = coalesce(b.account, 0)
  AND a.id > b.id;
create unique index if not exists idx_channel_permission_target
    on channel_permission(channel, channel_type, coalesce(role, 0), coalesce(account, 0));

-- Seeing channels and writing in them become @everyone base rights that a channel can deny.
ALTER TABLE server ALTER COLUMN default_permissions SET DEFAULT '{"view-channels": "", "send-messages": ""}';

-- One-time steps (an owner may later remove these defaults: never re-apply them).
create table if not exists schema_migration (
    name text NOT NULL PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migration WHERE name = 'base_channel_permissions') THEN
        UPDATE server SET default_permissions = coalesce(default_permissions, '{}')
            || '{"view-channels": "", "send-messages": ""}';
        -- Old allow-lists used "view"; a role without "send-messages" was read-only.
        UPDATE channel_permission
           SET permissions = (permissions - 'view') || '{"view-channels": ""}',
               deny = CASE WHEN permissions ? 'send-messages' THEN coalesce(deny, '{}')
                           ELSE coalesce(deny, '{}') || '{"send-messages": ""}' END
         WHERE permissions ? 'view';
        INSERT INTO schema_migration(name) VALUES ('base_channel_permissions');
    END IF;
END $$;

-- Category permissions: a category has the same overwrites as a channel (channel_type
-- "category") and can be private; its channels inherit them (permissions.channel_rights).
ALTER TABLE server_cat ADD COLUMN IF NOT EXISTS is_private boolean DEFAULT false;
