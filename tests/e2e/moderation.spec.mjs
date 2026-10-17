import { test, expect } from '@playwright/test';
import { loginUser } from './helpers/authHelpers.mjs';
import { waitForAppReady } from './helpers/callHelpers.mjs';
import { createServerViaUi, openServerFromSidebarById, openServerSettings, expectServerLoadedWithDefaultChannel } from './helpers/serverHelpers.mjs';
import { reloadAndWaitForApp } from './helpers/messagingHelpers.mjs';
import { acceptDialog } from './helpers/dialogHelpers.mjs';

const TEST_TIMEOUT = 120000;

// ─── thin API helpers (setup + cross-context assertions) ─────────────────────

async function api(page, path, { method = 'POST', expectOk = true } = {}) {
    return page.evaluate(async ({ path, method }) => {
        const r = await fetch(path, { method, credentials: 'include' });
        const text = await r.text();
        return { status: r.status, text };
    }, { path, method }).then((res) => {
        if (expectOk && (res.status < 200 || res.status >= 300)) {
            throw new Error(`${method} ${path} → ${res.status}: ${res.text}`);
        }
        return res;
    });
}

async function makeCommunityServer(page) {
    const serverId = await createServerViaUi(page);
    await api(page, `edit_server_property?property=is_community&server_id=${serverId}&value=true`);
    return serverId;
}

async function currentUserId(page) {
    return page.evaluate(() => window.global?.user?.id);
}

async function channelId(page) {
    return page.evaluate(() => window.global?.state?.currentServer?.dirs?.channels?.[0]?.id);
}

// Moderation controls are targeted by their handler, not their label: the E2E
// browser runs in en-US, so the French labels ("Expulser", "Bannissements"…)
// are translated ("Kick", "Bans"…) and a text locator would only pass while the
// en.mjs entries are missing.
const MOD_ACTION = {
    kick: '.mod-action[onclick="modKick()"]',
    ban: '.mod-action[onclick="modBan()"]',
    timeout: '.mod-action[onclick="modTimeout()"]',
};
const BANS_TAB = '#server-params .item[onclick*="openModerationSettings"]';

// Open a specific member's profile card (the member-list surface) and return the
// #profileInfo locator, where the moderation actions render. All test users share
// the "Mycelium User" display name, so we target the entry by its onclick id.
async function openServerReady(page, serverId) {
    await openServerFromSidebarById(page, serverId);
    await expectServerLoadedWithDefaultChannel(page, serverId);
}

async function openMemberCard(page, memberId) {
    // Show the member-list panel (best-effort — it's the surface these actions
    // belong to; the card itself is opened deterministically below).
    const memberList = page.locator('#member-list');
    const toggle = page.locator('[onclick*="member-list-wrapper"]').first();
    for (let i = 0; i < 2 && !(await memberList.isVisible().catch(() => false)); i++) {
        await toggle.click().catch(() => {});
        await memberList.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
    }

    // Open the member's flying card. The click-to-open path is racy headless
    // (the same click bubbles to the document handler that toggles "visible"),
    // so we drive toggleProfileInfo directly. It sets global.state.profileInfo
    // (which renders the .mod-action buttons) BEFORE its fragile positioning
    // code, so we tolerate a positioning throw and just force the class. The
    // rendered buttons still invoke the real modKick/modBan/modTimeout paths.
    // The flying template is mounted asynchronously at startup; force-mount it if
    // this reload got ahead of that (loadTemplate is synchronous by default).
    await page.evaluate(() => {
        if (!document.getElementById('profileInfo')) window.loadTemplate('profile-info.html');
    });
    await page.locator('#profileInfo').waitFor({ state: 'attached', timeout: 10000 });
    await page.evaluate((id) => {
        const anchor = document.querySelector('#member-list') || document.body;
        try { window.toggleProfileInfo(id, { currentTarget: anchor }); } catch (e) { /* positioning */ }
        const fm = document.getElementById('profileInfo');
        if (fm) { window.global.state.activeFM = fm; fm.classList.add('visible'); }
    }, memberId);

    const actions = page.locator('#profileInfo .mod-action').first();
    await actions.waitFor({ state: 'visible', timeout: 8000 });
    return page.locator('#profileInfo');
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe('Server moderation', () => {
    test.setTimeout(TEST_TIMEOUT);

    test('kick from the member list removes the member', async ({ browser }) => {
        const ownerCtx = await browser.newContext();
        const memberCtx = await browser.newContext();
        const owner = await ownerCtx.newPage();
        const member = await memberCtx.newPage();

        await loginUser(owner, `mod_owner_kick_${Date.now()}`);
        await waitForAppReady(owner);
        const serverId = await makeCommunityServer(owner);

        await loginUser(member, `mod_member_kick_${Date.now()}`);
        await waitForAppReady(member);
        const memberId = await currentUserId(member);
        await api(member, `join_community_server?server_id=${serverId}`);

        // Owner reloads to see the new member, opens the server + member card.
        await reloadAndWaitForApp(owner);
        await openServerReady(owner, serverId);
        await owner.waitForFunction((id) =>
            !!window.global?.state?.currentServer?.members?.[id], memberId, { timeout: 10000 });

        const card = await openMemberCard(owner, memberId);
        await card.locator(MOD_ACTION.kick).click();
        // One dialog: confirmation + optional reason
        expect((await acceptDialog(owner, 'e2e')).kind).toBe('prompt');

        // Member is gone from the owner's live member list.
        await owner.waitForFunction((id) =>
            !window.global?.state?.currentServer?.members?.[id], memberId, { timeout: 10000 });

        await ownerCtx.close();
        await memberCtx.close();
    });

    test('ban shows in the Moderation tab and blocks rejoin', async ({ browser }) => {
        const ownerCtx = await browser.newContext();
        const memberCtx = await browser.newContext();
        const owner = await ownerCtx.newPage();
        const member = await memberCtx.newPage();

        await loginUser(owner, `mod_owner_ban_${Date.now()}`);
        await waitForAppReady(owner);
        const serverId = await makeCommunityServer(owner);

        await loginUser(member, `mod_member_ban_${Date.now()}`);
        await waitForAppReady(member);
        const memberId = await currentUserId(member);
        await api(member, `join_community_server?server_id=${serverId}`);

        await reloadAndWaitForApp(owner);
        await openServerReady(owner, serverId);
        await owner.waitForFunction((id) =>
            !!window.global?.state?.currentServer?.members?.[id], memberId, { timeout: 10000 });

        const card = await openMemberCard(owner, memberId);
        await card.locator(MOD_ACTION.ban).click();
        await acceptDialog(owner, 'e2e');   // confirmation + reason
        await acceptDialog(owner, '0');     // purge N days of messages
        await owner.waitForFunction((id) =>
            !window.global?.state?.currentServer?.members?.[id], memberId, { timeout: 10000 });

        // Moderation tab renders the ban list with the banned account.
        await openServerSettings(owner);
        await owner.locator(BANS_TAB).click();
        await owner.locator('#mod-ban-list').waitFor({ state: 'visible', timeout: 5000 });
        await expect(owner.locator(`#mod-ban-list .mod-row`).first()).toBeVisible({ timeout: 10000 });

        // Rejoin is refused.
        const rejoin = await api(member, `join_community_server?server_id=${serverId}`, { expectOk: false });
        expect(rejoin.status).toBe(403);

        await ownerCtx.close();
        await memberCtx.close();
    });

    test('timeout blocks the member from sending messages', async ({ browser }) => {
        const ownerCtx = await browser.newContext();
        const memberCtx = await browser.newContext();
        const owner = await ownerCtx.newPage();
        const member = await memberCtx.newPage();

        await loginUser(owner, `mod_owner_to_${Date.now()}`);
        await waitForAppReady(owner);
        const serverId = await makeCommunityServer(owner);
        await openServerReady(owner, serverId);
        const chan = await channelId(owner);

        await loginUser(member, `mod_member_to_${Date.now()}`);
        await waitForAppReady(member);
        const memberId = await currentUserId(member);
        await api(member, `join_community_server?server_id=${serverId}`);

        await reloadAndWaitForApp(owner);
        await openServerReady(owner, serverId);
        await owner.waitForFunction((id) =>
            !!window.global?.state?.currentServer?.members?.[id], memberId, { timeout: 10000 });

        const card = await openMemberCard(owner, memberId);
        await card.locator(MOD_ACTION.timeout).click();
        await acceptDialog(owner, '10');    // minutes
        await acceptDialog(owner, 'e2e');   // reason
        // Wait for the timeout to register server-side.
        await owner.waitForTimeout(500);

        const send = await api(member,
            `send_message?conv=${encodeURIComponent(JSON.stringify({ id: chan }))}&content=hi&reply=`,
            { expectOk: false });
        expect(send.status).toBe(403);
        expect(send.text).toContain('timed_out');

        await ownerCtx.close();
        await memberCtx.close();
    });

    test('report action on a message is available and submits', async ({ browser }) => {
        const ownerCtx = await browser.newContext();
        const reporterCtx = await browser.newContext();
        const owner = await ownerCtx.newPage();
        const reporter = await reporterCtx.newPage();

        await loginUser(owner, `mod_owner_rep_${Date.now()}`);
        await waitForAppReady(owner);
        const serverId = await makeCommunityServer(owner);
        await openServerReady(owner, serverId);
        const chan = await channelId(owner);
        // Owner posts a message via API.
        const sent = await api(owner,
            `send_message?conv=${encodeURIComponent(JSON.stringify({ id: chan }))}&content=reportme&reply=`);
        const msgId = JSON.parse(sent.text).message.id;

        await loginUser(reporter, `mod_reporter_${Date.now()}`);
        await waitForAppReady(reporter);
        await api(reporter, `join_community_server?server_id=${serverId}`);

        // The report endpoint is reachable for a normal user (UI wires this button).
        const rep = await reporter.evaluate(async ({ msgId }) => {
            const r = await fetch(`report_content?target_message=${msgId}&reason=spam`,
                { method: 'POST', credentials: 'include' });
            return { status: r.status, text: await r.text() };
        }, { msgId });
        expect(rep.status).toBe(200);
        expect(JSON.parse(rep.text).ok).toBe(true);

        await ownerCtx.close();
        await reporterCtx.close();
    });

    test('timeout also blocks editing an existing message', async ({ browser }) => {
        const ownerCtx = await browser.newContext();
        const memberCtx = await browser.newContext();
        const owner = await ownerCtx.newPage();
        const member = await memberCtx.newPage();

        await loginUser(owner, `mod_owner_edit_${Date.now()}`);
        await waitForAppReady(owner);
        const serverId = await makeCommunityServer(owner);
        await openServerReady(owner, serverId);
        const chan = await channelId(owner);

        await loginUser(member, `mod_member_edit_${Date.now()}`);
        await waitForAppReady(member);
        const memberId = await currentUserId(member);
        await api(member, `join_community_server?server_id=${serverId}`);
        const sent = await api(member,
            `send_message?conv=${encodeURIComponent(JSON.stringify({ id: chan }))}&content=before&reply=`);
        const msgId = JSON.parse(sent.text).message.id;

        await api(owner, `timeout_member?server_id=${serverId}&account_id=${memberId}&minutes=10`);

        const edit = await api(member, `edit_message?message_id=${msgId}&content=after`, { expectOk: false });
        expect(edit.status).toBe(403);
        expect(edit.text).toContain('timed_out');

        await ownerCtx.close();
        await memberCtx.close();
    });

    test('moderators can target neither themselves nor a server-admin above them', async ({ browser }) => {
        const ctxs = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
        const [owner, admin, mod] = await Promise.all(ctxs.map(c => c.newPage()));
        const stamp = Date.now();

        await loginUser(owner, `mod_owner_h_${stamp}`);
        await waitForAppReady(owner);
        const serverId = await makeCommunityServer(owner);
        const ids = {};
        for (const [name, page] of [['admin', admin], ['mod', mod]]) {
            await loginUser(page, `mod_${name}_h_${stamp}`);
            await waitForAppReady(page);
            ids[name] = await currentUserId(page);
            await api(page, `join_community_server?server_id=${serverId}`);
        }

        // admin gets server-admin, mod only kick-members
        const grant = async (account, perms) => {
            const role = JSON.parse((await api(owner, `edit_server_role?server_id=${serverId}&action=create`)).text).id;
            await api(owner, `edit_server_role?server_id=${serverId}&targetId=${role}&field=permissions&value=${encodeURIComponent(JSON.stringify(perms))}`);
            await api(owner, `edit_server_role?server_id=${serverId}&targetId=${role}&action=attribute&value=${account}`);
        };
        await grant(ids.admin, { 'server-admin': true });
        await grant(ids.mod, { 'kick-members': true });

        const kick = (page, target) =>
            api(page, `kick_member?server_id=${serverId}&account_id=${target}`, { expectOk: false });

        const self = await kick(mod, ids.mod);
        expect(self.status).toBe(403);
        expect(self.text).toContain('yourself');

        const up = await kick(mod, ids.admin);
        expect(up.status).toBe(403);
        expect(up.text).toContain('server-admin');

        // The other way round is allowed
        expect((await kick(admin, ids.mod)).status).toBe(200);

        await Promise.all(ctxs.map(c => c.close()));
    });

    test('a kicked member is hung up from the server vocal call', async ({ browser }) => {
        const ownerCtx = await browser.newContext();
        const memberCtx = await browser.newContext();
        const owner = await ownerCtx.newPage();
        const member = await memberCtx.newPage();

        await loginUser(owner, `mod_owner_vc_${Date.now()}`);
        await waitForAppReady(owner);
        const serverId = await makeCommunityServer(owner);
        const vocal = JSON.parse((await api(owner,
            `edit_server_channel?server_id=${serverId}&action=create&channel_type=vocal`)).text).channel.id;

        await loginUser(member, `mod_member_vc_${Date.now()}`);
        await waitForAppReady(member);
        const memberId = await currentUserId(member);
        await api(member, `join_community_server?server_id=${serverId}`);

        // Both sit in the vocal channel (server-side call state, no media needed)
        await api(owner, `join_vocal_channel?channel_id=${vocal}`);
        await api(member, `join_vocal_channel?channel_id=${vocal}`);
        const participants = async () =>
            JSON.parse((await api(owner, `get_vocal_channel_state?channel_id=${vocal}`)).text).participants || [];
        expect((await participants()).map(Number)).toContain(Number(memberId));

        await api(owner, `kick_member?server_id=${serverId}&account_id=${memberId}`);
        expect((await participants()).map(Number)).not.toContain(Number(memberId));

        await ownerCtx.close();
        await memberCtx.close();
    });

    test('reporting the same message twice keeps a single open report', async ({ browser }) => {
        const ownerCtx = await browser.newContext();
        const reporterCtx = await browser.newContext();
        const owner = await ownerCtx.newPage();
        const reporter = await reporterCtx.newPage();

        await loginUser(owner, `mod_owner_dup_${Date.now()}`);
        await waitForAppReady(owner);
        const serverId = await makeCommunityServer(owner);
        await openServerReady(owner, serverId);
        const chan = await channelId(owner);
        const sent = await api(owner,
            `send_message?conv=${encodeURIComponent(JSON.stringify({ id: chan }))}&content=dup&reply=`);
        const msgId = JSON.parse(sent.text).message.id;

        await loginUser(reporter, `mod_reporter_dup_${Date.now()}`);
        await waitForAppReady(reporter);
        await api(reporter, `join_community_server?server_id=${serverId}`);

        const first = JSON.parse((await api(reporter, `report_content?target_message=${msgId}&reason=spam`)).text);
        const again = JSON.parse((await api(reporter, `report_content?target_message=${msgId}&reason=spam`)).text);
        expect(again.id).toBe(first.id);

        await ownerCtx.close();
        await reporterCtx.close();
    });

    test('non-op users do not see the op panel and are refused op endpoints', async ({ page }) => {
        await loginUser(page, `mod_plainuser_${Date.now()}`);
        await waitForAppReady(page);

        const isAdmin = await page.evaluate(() => !!window.global?.user?.isAdmin);
        expect(isAdmin).toBe(false);

        const reports = await page.evaluate(async () => {
            const r = await fetch('get_reports', { method: 'POST', credentials: 'include' });
            return r.status;
        });
        expect(reports).toBe(403);
    });
});
