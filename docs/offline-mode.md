# Offline mode — implementation

> **Status: implemented.** New files: `static/sw.js`, `static/framework/persistence.mjs`,
> `static/framework/connectivity.mjs`. Edited: `static/main.html`, `static/main.mjs`,
> `static/crud.mjs`, `static/framework/{websockets,vesta,templating}.mjs`, `static/style.css`,
> `server.py`. **No `capacitor.config` change and no `API_BASE`** — see the native note below.

Goal: the app stays **navigable offline** (read-only), starts offline, and pulls its own
assets (JS + templates + CSS) from the server on first run, refreshing only when a new
version ships — no app-store release required.

## Architecture: two owners, cleanly separated

| Concern | Owner | Strategy |
|---------|-------|----------|
| App shell, JS, templates, CSS (the *code*) | **Service Worker** | precache the shell; runtime-cache templates/modules on first fetch; versioned |
| `global` data — user, servers, convs, messages, users, notes, forums (the *state*) | **IndexedDB snapshot** | snapshot the live `global` data subtrees; rehydrate on offline boot; cleared on logout |

These never overlap: the SW knows nothing about app data, the snapshot knows nothing about
assets. That separation is what keeps the design evolutive — each side can change
independently, and the data side is the natural seam for a future offline outbox.

Why a snapshot and **not** an HTTP cache of the `/get_*` API:
- a snapshot captures **WebSocket-delivered messages** (which live in `global` but in no HTTP
  response) — required to honour "everything loaded in global stays available";
- it is **bounded** — one record, overwritten — versus an unbounded per-URL API cache that
  leaks and gets evicted;
- it is **cleared on logout** with a single `deleteDatabase`, so private messages don't
  persist on the device;
- it removes any need to change server endpoints (no `get_user_info` method change).

Non-goal for v1: **offline writes** (sending messages, uploads, calls). Those stay
network-only; the UI shows an offline banner and disables/greys them. An outbox can be added
later beside the snapshot without revisiting this design.

---

## New files (3)

### 1. `static/sw.js` — assets only (root-scoped)

Precache only the **shell** (what the base UI needs to boot). Everything else —
the 115 templates and lazily-imported modules — is cached on first fetch while online.
This keeps the precache list tiny and self-maintaining: a new template needs no manifest
entry, it just gets cached the first time it's loaded.

```js
const VERSION = 'v1';              // bump on deploy (ideally a build-time content hash)
const SHELL = `shell-${VERSION}`;

// Minimal: only what the app needs to render its first frame offline.
const SHELL_ASSETS = [
  '/channels',                     // the navigation entry (returns main.html)
  '/config', '/capacitor.js',
  '/static/main.html', '/static/style.css', '/static/workspaces/spreadsheet.css',
  // core modules imported eagerly by main.mjs, + templates loaded unconditionally at boot
  // (profile-info, create-poll, create-block, create-forum-post, poll-voters)
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => !k.endsWith(VERSION)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;          // never touch POST/PUT (writes pass through)
  const url = new URL(e.request.url);

  // Offline navigation → serve the cached shell
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/channels')));
    return;
  }

  // Assets: cache-first, and runtime-fill so any asset loaded once stays available offline.
  if (url.pathname.startsWith('/static/') || url.pathname === '/config' || url.pathname === '/capacitor.js') {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(SHELL).then(c => c.put(e.request, copy));
      return res;
    })));
  }
  // Everything else (the /get_* API) is left to the network — its data lives in the snapshot.
});
```

Scope: this worker must control `/channels`, not just `/static/`. Serve it from **root**
(`/sw.js`) with header `Service-Worker-Allowed: /` (see §server). A worker at
`/static/sw.js` cannot intercept the `/channels` navigation and the app would not start
offline.

Versioning = the Clash-of-Clans patch loop: changing `VERSION` changes the bytes of `sw.js`,
the browser/WebView re-installs the worker and drops old caches. Ideally `VERSION` is a
content hash written at deploy so it bumps itself and clients always converge to one version.

### 2. `static/framework/persistence.mjs` — the `global` snapshot

```js
import global from "./global.mjs";

const DB = 'mycelium', STORE = 'global', KEY = 'snapshot';
// Only serialisable DATA subtrees. NEVER global.state (holds websocket, DOM refs, callManager).
const KEYS = ['user', 'users', 'servers', 'convs', 'privateConvs', 'notes', 'forums'];

function open() { /* indexedDB.open(DB, 1), createObjectStore(STORE) on upgrade */ }

export async function saveSnapshot() {
  const data = {}; for (const k of KEYS) data[k] = global[k];
  const db = await open();
  db.transaction(STORE, 'readwrite').objectStore(STORE).put(structuredClone(data), KEY);
}

export async function loadSnapshot() {
  const db = await open();
  return new Promise(res => {
    const r = db.transaction(STORE).objectStore(STORE).get(KEY);
    r.onsuccess = () => res(r.result || null);
  });
}

export async function clearSnapshot() { (await open()).deleteObjectStore?.(STORE); /* or deleteDatabase */ }
```

- **When to save:** on `visibilitychange → hidden` and `pagehide` (covers mobile
  backgrounding and tab close) — one or two listeners, no per-mutation hooks, naturally
  bounded.
- **`structuredClone` caveat:** `convs[*].messageGroups` hold references into
  `convs[*].messages`; cloning duplicates them. Harmless for read-only offline. If exact
  identity is ever needed, persist without `messageGroups` and rebuild groups on rehydrate.

### 3. `static/framework/connectivity.mjs` — online/offline state

```js
import global from "./global.mjs";

function apply() { document.body.classList.toggle('offline', global.state.offline); }

export function initConnectivity() {
  global.state.offline = !navigator.onLine; apply();
  window.addEventListener('online',  () => { global.state.offline = false; apply(); });
  window.addEventListener('offline', () => { global.state.offline = true;  apply(); });
}
```

Drives the offline banner / disabled send buttons. No `location.reload()` on reconnect —
`initWebSockets` already auto-reconnects on close and the WS flow resyncs; at most, refetch
the active conversation.

---

## Edits to existing files (small + contained)

### `static/main.html` — register the SW (skip in DEBUG)

```html
<script>
  // Don't register on localhost/DEBUG — SW caching wrecks the dev edit-reload loop.
  if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(reg => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            // new version cached → show a "Reload to update" toast
          }
        });
      });
    });
  }
</script>
```

### `static/main.mjs` — boot must survive with no WebSocket  *(the one critical app change)*

Today the app only becomes usable when the WS handshake calls `postWS()` →
`hideLoadingScreen()`. Offline the WS never connects, so the loading screen hangs forever.
Split `postWS()` into a WS-dependent part and a UI-ready part, and branch the boot.

```js
// UI is ready to show — safe without a websocket.
export function markReady() {
  if (global.state._ready) return;
  global.state._ready = true;
  hideLoadingScreen(); hideSplash();
  const h = location.hash.slice(1);
  if (h) setTimeout(() => handleHashRoute(h), 300);
  window.addEventListener('popstate', () => handleHashRoute(location.hash.slice(1)));
}

export function postWS() {                 // only when the WS actually connects
  const userList = JSON.stringify(Object.keys(global.users).map(c => parseInt(c)));
  xhr("subscribe?client_id="+global.state.clientID+"&cat=user&items="+userList, undefined);
  global.state.callManager = new CallManager();
  registerPushNotifications();
  markReady();                             // also covers the normal online path
}
```

Then branch the top-level boot:

```js
import { initConnectivity } from "./framework/connectivity.mjs";
import { loadSnapshot, saveSnapshot } from "./framework/persistence.mjs";

initConnectivity();
addEventListener('visibilitychange', () => { if (document.hidden) saveSnapshot(); });
addEventListener('pagehide', saveSnapshot);

initNavigation();
await initTranslations();

const snap = global.state.offline ? await loadSnapshot() : null;
if (snap) {
  // OFFLINE BOOT: rehydrate global from the snapshot, skip the network bootstrap.
  Object.assign(global, snap);
  global.users[global.user.id] = global.user;
  // render servers / convs from the rehydrated state, then:
  markReady();
  initWebSockets();                        // harmless: retries until the network returns
} else {
  // ONLINE BOOT: unchanged.
  loadUser();                              // → loadConvs + initWebSockets + initActivity
  loadServers();
  xhr("get_blocked", onBlockedLoaded);
  xhr("get_friends", onFriendsLoaded);
  xhr("get_friend_invitations", onInvitationsLoaded);
}

loadEmojis(); initDrag();
setTimeout(markReady, 2500);               // safety net: never hang on the loading screen
```

### `static/crud.mjs` — guard the lazy loaders offline (≈5 spots)

The per-channel loaders (`loadConv`, `loadChan`, `loadNote`, `loadForum`, `loadForumPost`)
fire a synchronous XHR for fresh content. Offline that throws. Guard each: if offline and the
data is already present from the snapshot, skip the fetch and go straight to the existing
navigation/render.

```js
export function loadConv(key){
  if (global.state.offline && global.convs[key]?.messageGroups) return;  // already hydrated
  // …unchanged…
}
```

No method changes, no other `load*` edits. `loadUser`/`loadConvs`/`loadServers` are simply
not called on the offline branch.

### `static/framework/vesta.mjs` — clear the snapshot on logout

In `logout()` (and `goodbye()`), `await clearSnapshot()` before redirecting, so private
messages don't survive on the device.

### `static/style.css` — offline affordance

A `body.offline` rule: a thin banner + dimmed/disabled message-composer and call buttons.
Pure CSS driven by the class `connectivity.mjs` toggles. No logic.

### `server.py` — serve the worker at root scope

```python
@Server.expose
def sw(self):
    self.response.headers = [('Content-Type', 'application/javascript'),
                             ('Service-Worker-Allowed', '/')]
    return self.file(PATH + "/static/sw.js", responseFile=False)
```

Optional later: a deploy step that walks `static/**` and writes a content-hash `VERSION`
into `sw.js`, so versioning is automatic. With runtime-caching of templates/modules, a full
precache manifest is **not** required.

---

## Native (Capacitor) — kept as one codebase, no divergence

`capacitor.config.json` keeps `server.url: https://mycelium.carbonlab.dev/channels`, so the
native shell loads from the **same origin** as the server. This was a deliberate choice over
bundling a local shell:

- **One way of working.** Web and native run the identical code path — same origin, same
  relative URLs, same Service Worker. No `API_BASE`, no per-platform request rewriting, no
  risk of server-hosted `/static/attachments` breaking under a `capacitor://localhost` origin.
- Offline on native then rests entirely on the WebView serving the SW-cached shell when the
  device is offline. This is solid on Android's Chromium WebView. On **iOS WKWebView** SW
  support is present but historically finicky with remote-loaded apps — this is the one place
  to verify on-device; if it proves unreliable, the documented fallback is a bundled local
  shell + `API_BASE`, which we intentionally did **not** build to avoid the divergence.
- **WebSockets** already use an absolute URL from `/config` — unaffected.

---

## What changes, at a glance

| File | Change | Size |
|------|--------|------|
| `static/sw.js` | **new** — asset cache (shell precache + runtime fill) | ~45 lines |
| `static/framework/persistence.mjs` | **new** — IndexedDB `global` snapshot | ~40 lines |
| `static/framework/connectivity.mjs` | **new** — online/offline state | ~12 lines |
| `static/main.html` | register SW (DEBUG-gated) | ~12 lines |
| `static/main.mjs` | `postWS`/`markReady` split, offline boot branch, snapshot hooks | ~30 lines |
| `static/crud.mjs` | offline guards in 5 lazy loaders | ~5 lines |
| `static/framework/vesta.mjs` | clear snapshot on logout | ~2 lines |
| `static/style.css` | `body.offline` banner / disabled states | ~20 lines |
| `server.py` | root-scoped `/sw` route; (optional) build-time `VERSION` | ~10 lines |
| `capacitor.config.json` + request wrappers | native local shell + `API_BASE` | native only |

`templating.mjs`, the 115 templates, and the 43 synchronous-XHR sites stay **untouched** —
the SW serves them transparently, including the synchronous template XHRs.

## Operational caveats to bank now

- Cache-first on the shell means **deploys take effect after the SW updates + a reload**, not
  on next load. Pair `VERSION` bumps with a "reload to update" toast, and watch for version
  skew (old cached JS hitting new API) — keep `VERSION` discipline tight.
- **SW registration is disabled in DEBUG/localhost** so it doesn't break the dev loop.

## Effort

- **Web/PWA offline (read-only):** ~5–7 days. Low risk; isolated to the SW, the snapshot, and
  the boot branch.
- **Native offline (`API_BASE` + config + device testing):** +4–6 days. Higher fiddliness
  (origin change, iOS/Android WebView SW quirks).

## Suggested order

1. `sw.js` (shell precache, root-scoped) + register in `main.html` → app shell loads offline.
2. `postWS`/`markReady` split + safety net → app reveals offline.
3. `persistence.mjs` + offline boot branch + `load*` guards → cached state renders offline.
4. `connectivity.mjs` + banner + disable writes + clear-on-logout → clean, safe UX.
5. Native: `capacitor.config` + `API_BASE` → offline start on device.
6. Build-time `VERSION` hashing → self-updating patch loop.

## Verification

- DevTools → Application → Service Workers; throttle to **Offline**, reload `/channels`;
  confirm the shell + snapshotted servers/convs/messages render and routing works.
- Confirm POST actions fail gracefully (banner, no crash) offline.
- Log out, then inspect IndexedDB + Cache Storage → snapshot is gone; private data not retained.
- Bump `VERSION`, redeploy → clients re-install the SW and converge (no stale assets).
- Android + iOS: airplane-mode cold start after one online launch.
- Playwright E2E: `tests/e2e/offline.spec.mjs` — registers the SW, builds state (server +
  message), snapshots, then `context.setOffline(true)` + reload and asserts the app boots,
  shows the offline banner, and rehydrates the server + message from the snapshot. A second
  case asserts logout/`clearSnapshot` wipes the IndexedDB database. Run:
  `npx playwright test tests/e2e/offline.spec.mjs` against a server on `:808`.
