/**
 * Front server for the E2E run, in place of nginx: serves /static/ straight from
 * the repo and proxies everything else to the app.
 *
 * Why: under WSL the repo lives on /mnt/c, where every file system call of nginx
 * (in WSL) costs ~2.5 ms over 9P: ~200 static files/s for all the browsers of a
 * run, while each app boot loads ~120 of them. Node reads the same files
 * natively, so the app (and Postgres) are the only shared resources left.
 *
 *   node tests/e2e/frontServer.mjs          (started by playwright.config.mjs)
 *   E2E_FRONT_PORT=8808  E2E_APP_URL=http://127.0.0.1:9876
 *
 * The websocket doesn't go through here: the client connects to the URL /config
 * gives it (ws://localhost:9888 in DEBUG).
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STATIC_ROOT = path.join(ROOT, 'static');
const PORT = Number(process.env.E2E_FRONT_PORT || 8808);
const APP = new URL(process.env.E2E_APP_URL || 'http://127.0.0.1:9876');

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'video/webm',
    '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
    '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json',
};

// Keep-alive to the app: no TCP handshake (through the WSL relay) per request.
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

async function serveStatic(req, res, pathname) {
    const file = path.join(ROOT, pathname);
    let info = null;
    if (file.startsWith(STATIC_ROOT + path.sep)) {
        info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
    }
    // Same caching headers as nginx: ETag + Last-Modified, no Cache-Control. The offline
    // boot depends on it: templates are fetched by synchronous XHR, which the service
    // worker can't intercept, so offline they come from the browser's heuristic cache.
    const etag = `"${Math.floor(info.mtimeMs / 1000).toString(16)}-${info.size.toString(16)}"`;
    const lastModified = new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString();
    const since = Date.parse(req.headers['if-modified-since'] || '');
    if (req.headers['if-none-match'] === etag
        || (!req.headers['if-none-match'] && since >= Math.floor(info.mtimeMs / 1000) * 1000)) {
        res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified });
        res.end();
        return;
    }
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': info.size,
        'Last-Modified': lastModified,
        ETag: etag,
    });
    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    // pipeline, not pipe: a read error (file replaced since the stat) must not crash
    // the server, and a closed tab must close the file.
    pipeline(createReadStream(file), res, () => {});
}

function proxy(req, res) {
    const upstream = http.request({
        host: APP.hostname, port: APP.port, method: req.method, path: req.url,
        headers: req.headers, agent,
    }, (appRes) => {
        res.writeHead(appRes.statusCode, appRes.rawHeaders);
        pipeline(appRes, res, () => {});
    });
    // A tab closed mid-request: abort the upstream one too, or its unread response
    // keeps one of the agent's sockets for good (and once all 64 are taken, every
    // request waits).
    res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
    });
    upstream.on('error', (e) => {
        if (res.destroyed) return;   // the abort above
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`front server: the app at ${APP.origin} is unreachable (${e.code || e.message})`);
    });
    req.pipe(upstream);
}

const server = http.createServer((req, res) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
        res.writeHead(400);
        res.end();
        return;
    }
    if (pathname.startsWith('/static/') && (req.method === 'GET' || req.method === 'HEAD')) {
        serveStatic(req, res, pathname).catch((e) => {
            if (!res.headersSent) res.writeHead(500);
            res.end(String(e));
        });
    } else {
        proxy(req, res);
    }
});
server.keepAliveTimeout = 30000;
server.listen(PORT, () => console.log(`E2E front server on http://localhost:${PORT} -> ${APP.origin}`));
