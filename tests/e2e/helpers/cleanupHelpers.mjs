/**
 * Test-data cleanup.
 *
 * Every server an E2E test creates is recorded here (id + the creator's test
 * account) and deleted by globalTeardown.mjs at the end of the run, so test
 * servers don't pile up in the dev DB — and in Discover, which only lists 50.
 * The owner is logged back in with the shared test password at teardown: the
 * session cookies of the test itself may be revoked by then (disconnectViaUi).
 *
 * Set E2E_KEEP_DATA=1 to keep the servers (e.g. to inspect a failure).
 */
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { accountOf } from './authHelpers.mjs';

export const CREATED_SERVERS_FILE = fileURLToPath(new URL('../../.e2e-created-servers.jsonl', import.meta.url));

/** Records a server created through `page` (whose account owns it) for deletion at teardown. */
export function recordCreatedServer(page, serverId) {
    const email = accountOf(page);
    if (!email || !serverId) return;
    appendFileSync(CREATED_SERVERS_FILE, JSON.stringify({ email, serverId: Number(serverId) }) + '\n');
}
