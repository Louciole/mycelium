// Mycelium service worker — owns ASSET caching only (never app data).
//
// Strategy:
//   • shell assets (the minimum needed to render the first frame) are precached
//     on install;
//   • every other GET under /static (templates, lazily-imported modules, icons,
//     fonts, sounds) is cached on first fetch — "what has been loaded stays
//     available offline";
//   • navigations fall back to the cached shell when the network is gone.
//
// App DATA (servers, convs, messages, …) is NOT cached here — it lives in the
// IndexedDB snapshot owned by framework/persistence.mjs. The /get_* API is left
// entirely to the network.
//
// Versioning: bump VERSION on every deploy (ideally a build-time content hash).
// Changing these bytes makes the browser/WebView re-install the worker and drop
// older caches — that is the self-updating "patch" loop.

const VERSION = 'v2';
const SHELL = `mycelium-shell-${VERSION}`;

// Minimal: only what the app needs to boot. Everything else is runtime-cached.
const SHELL_ASSETS = [
    '/channels',                 // navigation entry (server returns main.html)
    '/config',
    // '/capacitor.js' is intentionally omitted: it 404s on web (only injected by
    // the native shell). Runtime caching picks it up where it actually exists.
    '/static/main.html',
    '/static/style.css',
    '/static/workspaces/spreadsheet.css',
    // templates loaded unconditionally during boot (see main.mjs):
    '/static/templates/profile-info.html',
    '/static/templates/create-poll.html',
    '/static/templates/create-block.html',
    '/static/templates/create-forum-post.html',
    '/static/templates/poll-voters.html',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL)
            // addAll is atomic; allSettled-style add() keeps install resilient if
            // one optional shell URL 404s after a refactor.
            .then((cache) => Promise.all(SHELL_ASSETS.map((u) =>
                cache.add(u).catch((e) => console.warn('[sw] precache skipped', u, e))
            )))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;            // writes (POST/PUT/…) pass through

    const url = new URL(req.url);

    // Offline navigation → serve the cached app shell.
    if (req.mode === 'navigate') {
        event.respondWith(fetch(req).catch(() => caches.match('/channels')));
        return;
    }

    // Static assets → cache-first with runtime fill. Same-origin only.
    const isAsset = url.origin === self.location.origin &&
        (url.pathname.startsWith('/static/') ||
            url.pathname === '/config' ||
            url.pathname === '/capacitor.js');

    if (isAsset) {
event.respondWith(
            caches.open(SHELL).then((cache) =>
                cache.match(req).then((hit) => {
                    const network = fetch(req).then((res) => {
                        if (res && res.ok) cache.put(req, res.clone());
                        return res;
                    }).catch(() => hit);
                    if (hit) event.waitUntil(network);  // keep SW alive for bg refresh
                    return hit || network;
                })
            )
        );
    }
    // Anything else (the /get_* data API, cross-origin) → straight to network.
});
