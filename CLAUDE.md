# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Mycelium** is a Discord-like communication platform — real-time messaging, voice/video calling, cloud storage, and collaborative documents. It runs as a web app with native mobile support via Capacitor.

- Production: https://mycelium.carbonlab.dev
- Repository: https://gitlab.com/Louciole/mycelium

## Setup

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
vesta install          # installs Vesta framework assets
# configure server.ini with DB credentials and port
# add DKIM private key to mailing/dkim.txt
python server.py       # starts server on port 8080 by default
```

**PostgreSQL auth note**: If you get peer authentication errors, switch the auth method in `pg_hba.conf` from `peer` to `md5`.

## Commands

| Task | Command |
|------|---------|
| Run server | `python server.py` |
| Run backend tests | `vesta test` |
| Run all E2E tests | `npm run test:e2e` |
| Run E2E with UI | `npm run test:e2e:ui` |
| Run single E2E spec | `npx playwright test tests/e2e/<spec>.spec.mjs` |
| Install Playwright | `npx playwright install --with-deps chromium` |

E2E tests run against `http://localhost:8808`: `tests/e2e/frontServer.mjs`, started by `tests/playwright.config.mjs` (re-exported by the root `playwright.config.mjs`), serves `/static/` from disk and proxies the rest to the app on `:9876` — nginx on `/mnt/c` (WSL) caps static files at ~200/s. `E2E_BASE_URL=http://localhost:808` goes through nginx instead.

Load tests: `python tests/perf/loadtest.py` (server endpoints, stdlib) and `npx playwright test --config tests/perf/playwright.perf.config.mjs` (parallel app boots, `WORKERS=8`).

## Architecture

### Backend — `server.py` (~3,200 lines)

The single `Mycelium` class extends `vesta.Server` (a custom Python web framework). Methods decorated with `@Server.expose` are automatically routed as REST endpoints. There are 70+ exposed endpoints covering users, servers, channels, messaging, calls, files, and documents.

WebSocket messages are handled in `handle_message()` and drive real-time features: typing indicators, presence, and WebRTC call signaling. The server maintains an in-memory `clients` list of connected WebSocket sessions.

**Supporting modules**:
- `callManager.py` — tracks active calls; automatically switches between P2P (< 4 participants) and SFU (≥ 4 participants) modes
- `driveManager.py` — file uploads with quota enforcement (15 GB/user, 5 GB/server)

### Frontend — `static/`

Vanilla JavaScript using **Vesta.js** (a custom framework in `static/framework/`). Global state lives in `window.global.state` (WebSocket connection, active conversation, call manager, etc.) and `window.user` (authenticated user profile).

Key modules:
- `crud.mjs` — all REST API calls (fetch wrappers)
- `controls.mjs` — UI event handlers
- `discover.mjs` — community server discovery
- `capacitor-bridge.mjs` — bridge to native mobile features
- `static/workspaces/` — Drive, Notes, and Spreadsheet workspace UIs

### Database — PostgreSQL

40+ tables. Key groupings:
- **Users/auth**: `mycelium_account`, `status`, `API_key`
- **Servers/channels**: `server`, `textual_channel`, `vocal_channel`, `drive_channel`, `notes_channel`, `role`, `role_attribution`, `channel_permission`
- **Messaging**: `conversation`, `message`, `message_reaction`, `offline_notifs`
- **Calls**: `call_session`
- **Storage**: `drive_folder`, `drive_file`
- **Documents**: `note_block`, `note_database`, `note_spreadsheet`, and associated column/row/cell tables
- **Social**: `invitation`, `blockship`, `boatakopin` (friend requests)
- **Mobile**: `device_token`

Full schema: `db/schema.sql`

### Mobile — `capacitor-app/`

Capacitor 8 wrapping the web app for Android/iOS. Native plugins: push notifications (FCM/APNs), local notifications, haptics, network status, status bar, splash screen. Deep links: `mycelium://invite/<token>` and `mycelium://channel/<serverId>/<channelId>`.

### CI/CD — `.gitlab-ci.yml`

- **test** stage: backend tests (`vesta test`) + Playwright E2E against a real PostgreSQL 16 instance
- **build** stage: Android APK (triggers on `maine` branch)
- **deploy** stage: Play Store via Fastlane (triggers on `release` branch)

## Key Patterns

- **WebRTC signaling**: P2P calls use direct offer/answer/ICE exchange through the WebSocket server. When a 4th participant joins, `callManager.py` triggers a mode switch to SFU and notifies all participants to renegotiate.
- **Auth**: JWT-based, inherited from Vesta framework.
- **Push notifications**: Firebase Admin SDK sends FCM/APNs tokens stored in `device_token` table when a recipient is offline (checked via `offline_notifs`).
