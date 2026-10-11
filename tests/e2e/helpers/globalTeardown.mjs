import { existsSync, readFileSync, rmSync } from 'node:fs';
import { SERVER_URL, TEST_PASSWORD } from './authHelpers.mjs';
import { CREATED_SERVERS_FILE } from './cleanupHelpers.mjs';

/** Logs a test account in and returns its session as a Cookie header (null on failure). */
async function login(email) {
    const res = await fetch(`${SERVER_URL}/login?email=${encodeURIComponent(email)}&password=${encodeURIComponent(TEST_PASSWORD)}`, { method: 'POST' });
    if (!res.ok || (await res.text()).trim() !== 'ok') return null;
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** Deletes the servers recorded by cleanupHelpers.recordCreatedServer during the run. */
export default async function globalTeardown() {
    if (process.env.E2E_KEEP_DATA || !existsSync(CREATED_SERVERS_FILE)) return;

    const byOwner = new Map();
    for (const line of readFileSync(CREATED_SERVERS_FILE, 'utf8').split('\n').filter(Boolean)) {
        const { email, serverId } = JSON.parse(line);
        if (!byOwner.has(email)) byOwner.set(email, new Set());
        byOwner.get(email).add(serverId);
    }

    let deleted = 0, skipped = 0;
    try {
        for (const [email, ids] of byOwner) {
            const cookie = await login(email);
            for (const id of ids) {
                if (!cookie) { skipped++; continue; }
                // delete_server answers with a redirect to /channels when it worked;
                // 403 = already deleted by the test, or no longer the owner's to delete.
                const res = await fetch(`${SERVER_URL}/delete_server?server_id=${id}`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
                if (res.status >= 200 && res.status < 400) deleted++;
                else skipped++;
            }
        }
    } catch (e) {
        // Server unreachable: keep the file, the next run's teardown retries.
        console.warn(`🧹 E2E cleanup skipped (${e.message}); kept ${CREATED_SERVERS_FILE}`);
        return;
    }
    rmSync(CREATED_SERVERS_FILE);
    console.log(`🧹 E2E cleanup: ${deleted} test server(s) deleted, ${skipped} already gone or not deletable`);
}
