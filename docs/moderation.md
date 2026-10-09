# Moderation — spec

> **Status: not started.** This document specs two related but distinct systems:
> server-level moderation (Discord-parity: kick/ban/timeout, scoped to one server) and
> platform-level moderation (for **op users** — members of an `op_servs` server with the
> `mycelium-admin` right — acting instance-wide across every server and DM).

## Why two tiers

Mycelium already has a permission model, but it only has one bit: `server-admin`
(all-or-nothing per server, see [static/access.mjs](../static/access.mjs)) and one
platform bit: `mycelium-admin` (`isAdmin()` in [server.py](../server.py), gated on
membership in an `op_servs` server). There is currently **no** way for a regular
moderator to kick/ban/mute without being handed full `server-admin`, and **no** way
for platform ops to act on content outside servers they happen to belong to. Both
gaps are addressed here, reusing the existing primitives rather than inventing a
parallel authz system.

## Prerequisite fix (blocks everything below)

`_hasAdminRight()` in `server.py` checks `checkAccessRights(uid, server_id,
"mycelium_admin")` (underscore). The permission catalog in `static/access.mjs`
defines the key as `"mycelium-admin"` (hyphen), and that's what the role-editor UI
writes into `role.permissions`. The two never match, so no user editing their role
through the UI can actually become an op today. **Pick one spelling (hyphen, to match
every other permission key) and fix the server-side check** before wiring any op
feature to `isAdmin()`.

---

## A. Server-level moderation (Discord-parity)

### New permissions

Add to the `rights` catalog in `static/access.mjs` (server-scoped, checked via
`checkAccessRights`/`getRights`, same as today's `server-admin`):

| key | grants |
|---|---|
| `kick-members` | kick a member from the server |
| `ban-members` | ban/unban a member, optionally purge their recent messages |
| `timeout-members` | temporarily mute a member (blocks sending messages/reactions/joining voice) |
| `manage-messages` | delete/pin **other members'** messages, not just your own |

`server-admin` continues to imply all of the above (owner-bypass semantics already
exist in `checkAccessRights` — just make sure the new guard helpers check
`server-admin` as a superset, the same way `checkChannelAccess` already does for
private channels).

### New tables (`db/schema.sql`)

```sql
create table if not exists server_ban (
    id bigserial NOT NULL PRIMARY KEY,
    server integer NOT NULL references server(id) ON DELETE CASCADE,
    account integer NOT NULL,
    reason text,
    banned_by integer NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server, account)
);

-- expires_at NULL = indefinite. Reuses the `channel_mute` naming convention.
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
```

### New endpoints — `routes/moderation.py` (new file, follows the existing
`routes/*.py` + `@Server.expose` split pattern)

| endpoint | guard | behavior |
|---|---|---|
| `kick_member(server_id, account_id, reason=None)` | `require_server_perm(uid, server_id, "kick-members")` | delete `accessserver` row, WS-notify the target + server (forced leave), write `moderation_log` |
| `ban_member(server_id, account_id, reason=None, purge_days=0)` | `require_server_perm(uid, server_id, "ban-members")` | same as kick + insert `server_ban`; if `purge_days>0`, delete their messages in that server from the last N days (reuse the attachment-cleanup path from `delete_message`) |
| `unban_member(server_id, account_id)` | `require_server_perm(uid, server_id, "ban-members")` | delete `server_ban` row, log `unban` |
| `get_server_bans(server_id)` | `require_server_perm(uid, server_id, "ban-members")` | list bans for the moderation UI |
| `timeout_member(server_id, account_id, minutes, reason=None)` | `require_server_perm(uid, server_id, "timeout-members")` | upsert `server_timeout` with `expires_at = now() + minutes`, WS-notify target, log |
| `remove_timeout(server_id, account_id)` | `require_server_perm(uid, server_id, "timeout-members")` | delete `server_timeout` row, log `untimeout` |
| `get_moderation_log(server_id, limit=50, before=None)` | `require_server_perm(uid, server_id, "kick-members")` (read access = lowest mod tier) | paginated log for the server settings panel |

### Enforcement points (existing endpoints to touch)

- `join_server` / `create_invitation` flow ([routes/discovery.py](../routes/discovery.py)) — reject with 403 if `server_ban` exists for `(server_id, uid)`.
- `send_message`, `toggle_reaction`, `join_vocal_channel` ([routes/messaging.py](../routes/messaging.py), [routes/calls.py](../routes/calls.py)) — reject with a distinct error code (e.g. `{"error": "timed_out", "expires_at": ...}`) if an unexpired `server_timeout` row exists for `(server, uid)`. Expired rows should be treated as absent (lazy-delete or filter by `expires_at > now()`), matching how `channel_mute` already handles `muted_until`.
- `delete_message` ([routes/messaging.py:264](../routes/messaging.py)) — currently `sender != uid` is a hard 403. Change to: allow if sender is uid, **or** `checkAccessRights(uid, server, "manage-messages")` for channel messages (DMs stay sender-only, no such thing as DM moderation). Log to `moderation_log` when it's a moderator deleting someone else's message.

### Frontend

- Member-list context menu: Kick / Ban / Timeout entries, visibility gated by the new
  rights (mirror the existing `checkServRights('server-admin')` pattern in
  `static/templates/serverSelector.html`).
- Timeout duration picker (5m/10m/1h/1d/custom) — mirror `mute_channel`'s
  `minutes` param convention in `routes/messaging.py`.
- Server Settings → new "Moderation" tab: ban list (+ unban), moderation log feed.
- Toast/banner when the current user is timed out (disable the message composer,
  show `expires_at`).

---

## B. Platform-level moderation (op users)

Op users are members of an `op_servs` server holding the `mycelium-admin` right —
this already exists for the analytics dashboards (`describe_datasets`,
`run_metric_spec`), so platform moderation reuses the same `isAdmin(uid)` gate.
The key design constraint: **ops are not necessarily members of the servers they
need to act on**, so every op endpoint must bypass the normal `require_member`/
`checkAccessRights` membership checks (same pattern already used for the computed
dashboard branch) and must be logged, since it's an authz bypass by design.

### New tables

```sql
-- indefinite if expires_at is NULL
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
    target_message integer,   -- references message(id), nullable
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
    action varchar(32) NOT NULL, -- suspend_user | unsuspend_user | delete_server | delete_message | dismiss_report | ...
    target_account integer,
    target_server integer,
    reason text,
    metadata jsonb DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### New endpoints — `routes/moderation.py` (same file, op-gated section)

| endpoint | guard | behavior |
|---|---|---|
| `report_content(target_message=None, target_account=None, reason=...)` | any authenticated user | insert `report` row; row includes `server` derived from the message's channel if applicable |
| `get_reports(status="open", limit=50)` | `isAdmin(uid)` | queue for the op UI, newest first |
| `resolve_report(report_id, status, note=None)` | `isAdmin(uid)` | mark actioned/dismissed, stamp `resolved_by`/`resolved_at` |
| `suspend_user(account_id, reason, duration_minutes=None)` | `isAdmin(uid)` | upsert `account_suspension`; force-disconnect all active WS sessions for that user; log to `platform_action_log` |
| `unsuspend_user(account_id)` | `isAdmin(uid)` | delete `account_suspension` row, log |
| `platform_delete_message(message_id, reason)` | `isAdmin(uid)` | same cleanup path as `delete_message` but bypasses sender/permission check entirely; log |
| `platform_delete_server(server_id, reason)` | `isAdmin(uid)` | cascade-delete via existing `delete_server` logic, but bypass the owner-only check; log |
| `get_platform_action_log(limit=50, before=None)` | `isAdmin(uid)` | audit trail for other ops (accountability — ops can see what other ops did) |

### Enforcement points

- **Login / JWT issuance** (wherever `uniauth` issues the session, in `server.py`)
  — reject with 403 + `{"error": "account_suspended", "reason": ..., "expires_at": ...}`
  if an unexpired `account_suspension` row exists for the account. Check at login,
  not just at request time, so a suspended user gets a clear reason instead of a
  generic auth failure. If sessions are long-lived JWTs, also add the check to
  `getUser()`/`checkJwt()` so an already-logged-in suspended user is cut off within
  one request, not just blocked from future logins.
- Any endpoint already gated by `isAdmin()` (the computed-dashboard branch) is the
  precedent to copy for guard style — **do not** invent a second admin-check helper.

### Frontend

- "Report" action on the message context menu and the user profile card, wired to
  `report_content`.
- Op-only panel (extend whatever renders the existing `⚡` computed-dashboard
  builder, gated the same way on `global.user.isAdmin`): Reports queue, Suspend
  user, Delete server, Platform action log.
- Suspended-account screen: dedicated error page on login (not a generic "wrong
  password"), shows reason + expiry if temporary.

---

## Explicitly out of scope for v1

- IP/device bans, automod (spam/word filters), appeals workflow UI. The `report`
  table is the natural seam for automod to feed into later, but automod itself is
  a separate spec.
- DM moderation by server mods (DMs have no server context; only platform ops can
  act on DM content, via `platform_delete_message`).

## Test plan

- `vesta test` additions: ban blocks rejoin, timeout blocks `send_message` and
  clears after `expires_at`, `delete_message` allows `manage-messages` holders to
  delete others' messages but not plain members, suspended account can't obtain a
  new JWT, op actions log to `platform_action_log`, non-op calling any op endpoint
  gets 403.
- Playwright: kick/ban/timeout flow from the member list; report → op resolves →
  message gone; suspended user sees the suspension screen on login.
