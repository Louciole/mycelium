/**
 * Helpers for the roles / permissions specs (roleSettings, channelPermissions):
 * a community server with an owner and members in separate browser contexts,
 * plus thin API calls for setup and authorization assertions.
 */
import { loginUser } from './authHelpers.mjs';
import { waitForAppReady } from './callHelpers.mjs';
import {
    createServerViaUi,
    openServerFromSidebarById,
    expectServerLoadedWithDefaultChannel,
} from './serverHelpers.mjs';
import { reloadAndWaitForApp } from './messagingHelpers.mjs';

export const enc = encodeURIComponent;

/** POST `path` from the page's session; throws unless 200 (or `expectOk: false`). */
export async function api(page, path, { expectOk = true } = {}) {
    const res = await page.evaluate(async (p) => {
        const r = await fetch(p, { method: 'POST', credentials: 'include' });
        return { status: r.status, text: await r.text() };
    }, path);
    if (expectOk && res.status !== 200) throw new Error(`POST ${path} → ${res.status}: ${res.text}`);
    return res;
}
export const status = async (page, path) => (await api(page, path, { expectOk: false })).status;
export const json = async (page, path) => JSON.parse((await api(page, path)).text);
export const userId = (page) => page.evaluate(() => Number(window.global?.user?.id));

export const setPerms = (page, serverId, roleId, perms) => api(page,
    `/edit_server_role?server_id=${serverId}&targetId=${roleId}&field=permissions&value=${enc(JSON.stringify(Object.fromEntries(perms.map(p => [p, '']))))}`);
export const giveRole = (page, serverId, roleId, accountId) => api(page,
    `/edit_server_role?server_id=${serverId}&targetId=${roleId}&action=attribute&value=${accountId}`);

export const createChannel = async (page, serverId, type = 'textual') =>
    (await json(page, `/edit_server_channel?server_id=${serverId}&action=create&channel_type=${type}`)).channel.id;
export const channelPermsPath = (chan, type = 'textual') => `/edit_channel_permissions?channelId=${chan}&channelType=${type}`;
/** One tri-state switch of a channel overwrite: target = "roleId=…" / "accountId=…", value = allow|deny|inherit. */
export const setChannelPerm = (page, chan, target, right, value, type = 'textual') =>
    api(page, `${channelPermsPath(chan, type)}&action=setPermission&${target}&permission=${right}&value=${value}`);

export async function createRole(page, serverId, { name, color, perms } = {}) {
    const role = await json(page, `/edit_server_role?server_id=${serverId}&action=create`);
    if (name) await api(page, `/edit_server_role?server_id=${serverId}&targetId=${role.id}&field=name&value=${enc(name)}`);
    if (color) await api(page, `/edit_server_role?server_id=${serverId}&targetId=${role.id}&field=color&value=${enc(color)}`);
    if (perms) await setPerms(page, serverId, role.id, perms);
    return role.id;
}

/** Owner + `n` members in their own browser contexts, all inside a fresh community server. */
export async function setupServer(browser, label, n) {
    const stamp = Date.now();
    const ctxs = [];
    const newPage = async (name) => {
        const ctx = await browser.newContext();
        ctxs.push(ctx);
        const page = await ctx.newPage();
        page.on('dialog', d => d.accept());
        await loginUser(page, `e2e_${label}_${name}_${stamp}`);
        await waitForAppReady(page);
        return page;
    };
    const owner = await newPage('owner');
    const serverId = await createServerViaUi(owner);
    await api(owner, `/edit_server_property?property=is_community&server_id=${serverId}&value=true`);
    const members = [];
    for (let i = 0; i < n; i++) {
        const page = await newPage(`m${i}`);
        await api(page, `/join_community_server?server_id=${serverId}`);
        members.push({ page, id: await userId(page) });
    }
    return { owner, ownerId: await userId(owner), serverId, members, stamp, close: () => Promise.all(ctxs.map(c => c.close())) };
}

/** Reload, open the server and wait for its default channel. */
export async function openServer(page, serverId) {
    await reloadAndWaitForApp(page);
    await openServerFromSidebarById(page, serverId);
    await expectServerLoadedWithDefaultChannel(page, serverId);
}
