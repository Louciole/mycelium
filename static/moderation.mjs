// Moderation frontend: server-level actions (kick/ban/timeout) from the member
// profile card, the server-settings Moderation tab (ban list + log), message/
// profile reporting, the op-only platform panel (reports queue, suspend, action
// log) and the live effects of moderation WS notifications. See docs/moderation.md.
import global from "./framework/global.mjs";
import {xhr} from "./framework/templating.mjs";
import {deleteElementDict} from "./framework/vesta.mjs";

// Synchronous JSON GET (mirrors admin.mjs/getDashboard's pattern).
function apiGet(endpoint) {
    const req = xhr(endpoint, () => {}, "GET", false);
    if (req.status === 200) {
        try { return JSON.parse(req.responseText); } catch (e) { return null; }
    }
    return null;
}

// HTTPError bodies are plain text ("403 FORBIDDEN {json}"): pull the JSON part.
function parseErrorBody(req) {
    const text = req?.responseText || "";
    const start = text.indexOf("{");
    if (start < 0) return null;
    try { return JSON.parse(text.slice(start)); } catch (e) { return null; }
}

// server-admin (and the owner, via checkServRights) imply every moderation right,
// same as hasServerPerm() on the backend.
function canModerate(right) {
    if (!global.state.isServer || !global.state.currentServer) return false;
    return !!(window.checkServRights?.(right) || window.checkServRights?.("server-admin"));
}
window.canModerate = canModerate;

const ACTION_LABELS = {
    "kick": "Expulsion",
    "ban": "Bannissement",
    "unban": "Débannissement",
    "timeout": "Timeout",
    "untimeout": "Fin du timeout",
    "purge": "Purge",
    "manage_messages_delete": "Message supprimé",
    "delete_message": "Message supprimé",
    "suspend_user": "Suspension",
    "unsuspend_user": "Suspension levée",
    "delete_server": "Serveur supprimé",
    "resolve_report": "Signalement traité",
    "dismiss_report": "Signalement rejeté",
};
function modActionLabel(action) {
    return ACTION_LABELS[action] ? _t(ACTION_LABELS[action]) : String(action ?? "");
}
window.modActionLabel = modActionLabel;

// ---------------------------------------------------------------------------
// Server-level actions (member profile card)
// ---------------------------------------------------------------------------

function _target() {
    return { uid: global.state.profileInfo?.id, sid: global.state.currentServer?.id };
}

function modKick() {
    const { uid, sid } = _target();
    if (!uid || !sid) return;
    if (!confirm(_t("Expulser ce membre du serveur ?"))) return;
    const reason = prompt(_t("Raison (optionnel) :")) || "";
    xhr(`kick_member?server_id=${sid}&account_id=${uid}&reason=${encodeURIComponent(reason)}`,
        function () { if (this.status === 200) { removeServerMember(sid, uid); window.closeFM?.(); } }, "POST");
}
window.modKick = modKick;

function modBan() {
    const { uid, sid } = _target();
    if (!uid || !sid) return;
    if (!confirm(_t("Bannir ce membre ? Il ne pourra plus rejoindre le serveur."))) return;
    const reason = prompt(_t("Raison (optionnel) :")) || "";
    const purge = Math.max(0, parseInt(prompt(_t("Purger les messages des N derniers jours (0 = aucun) :"), "0"), 10) || 0);
    xhr(`ban_member?server_id=${sid}&account_id=${uid}&reason=${encodeURIComponent(reason)}&purge_days=${purge}`,
        function () { if (this.status === 200) { removeServerMember(sid, uid); window.closeFM?.(); } }, "POST");
}
window.modBan = modBan;

function modTimeout() {
    const { uid, sid } = _target();
    if (!uid || !sid) return;
    const minutes = parseInt(prompt(_t("Durée du timeout en minutes (5, 10, 60, 1440…) :"), "10"), 10);
    if (!(minutes > 0)) return;
    const reason = prompt(_t("Raison (optionnel) :")) || "";
    xhr(`timeout_member?server_id=${sid}&account_id=${uid}&minutes=${minutes}&reason=${encodeURIComponent(reason)}`,
        function () { if (this.status === 200) window.closeFM?.(); }, "POST");
}
window.modTimeout = modTimeout;

function reportUser() {
    const { uid } = _target();
    if (!uid) return;
    const reason = prompt(_t("Signaler cet utilisateur — raison :"));
    if (!reason) return;
    xhr(`report_content?target_account=${uid}&reason=${encodeURIComponent(reason)}`,
        function () { if (this.status === 200) alert(_t("Signalement envoyé.")); }, "POST");
}
window.reportUser = reportUser;

function reportMessage(msgId) {
    const reason = prompt(_t("Signaler ce message — raison :"));
    if (!reason) return;
    xhr(`report_content?target_message=${msgId}&reason=${encodeURIComponent(reason)}`,
        function () { if (this.status === 200) alert(_t("Signalement envoyé.")); }, "POST");
}
window.reportMessage = reportMessage;

// Buttons rendered inside the member profile card (profile-info.html). Anyone
// but yourself can be reported; moderation needs the matching right, a target
// that is still a member, and never applies to the owner.
function renderModActions() {
    const targetId = global.state.profileInfo?.id;
    if (!targetId || targetId === global.user?.id) return "";
    const serv = global.state.isServer ? global.state.currentServer : null;
    const moderatable = !!(serv?.members?.[targetId] && serv.owner !== targetId);
    return fillWith("mod-actions", [{
        canTimeout: moderatable && canModerate("timeout-members"),
        canKick: moderatable && canModerate("kick-members"),
        canBan: moderatable && canModerate("ban-members"),
    }]);
}
window.renderModActions = renderModActions;

// Message actions (message.html): deleting someone else's message needs
// manage-messages, and only applies to textual channels and forum posts (DMs
// stay sender-only). A forum post's messages have place = the post id; the
// loaded post (global.convs[post]) knows its forum.
function canManageMessage(message) {
    if (!canModerate("manage-messages")) return false;
    const dirs = global.state.currentServer.dirs;
    if (dirs?.channels?.some(c => c.id === message.place)) return true;
    const forum = global.convs?.[message.place]?.forum;
    return forum !== undefined && !!dirs?.forums?.some(c => c.id === forum);
}
window.canManageMessage = canManageMessage;

// ---------------------------------------------------------------------------
// Server settings — Moderation tab (ban list + moderation log)
// ---------------------------------------------------------------------------

function openModerationSettings(event) {
    // No event when opened programmatically (openServerParams): no tab highlight to move
    const selected = event ? { 'category': 'currentSettingTab', 'event': event } : undefined;
    window.goTo('setting-server-content', 'server-moderation-settings', selected, true, renderModerationSettings);
}
window.openModerationSettings = openModerationSettings;

function renderModerationSettings() {
    renderBanList();
    renderModLog();
}
window.renderModerationSettings = renderModerationSettings;

function renderBanList() {
    const sid = global.state.currentServer?.id;
    const box = document.getElementById("mod-ban-list");
    if (!box || !sid) return;
    const bans = apiGet(`get_server_bans?server_id=${sid}`) || [];
    box.innerHTML = bans.length ? fillWith("mod-ban-row", bans) : `<p class="muted">${_t("Aucun bannissement.")}</p>`;
}
window.renderBanList = renderBanList;

function unbanMember(accountId) {
    const sid = global.state.currentServer?.id;
    if (!sid) return;
    xhr(`unban_member?server_id=${sid}&account_id=${accountId}`,
        function () { if (this.status === 200) renderModerationSettings(); }, "POST");
}
window.unbanMember = unbanMember;

function renderModLog() {
    const sid = global.state.currentServer?.id;
    const box = document.getElementById("mod-log-list");
    if (!box || !sid) return;
    const log = apiGet(`get_moderation_log?server_id=${sid}&limit=50`) || [];
    box.innerHTML = log.length ? fillWith("mod-log-row", log) : `<p class="muted">${_t("Journal vide.")}</p>`;
}
window.renderModLog = renderModLog;

// ---------------------------------------------------------------------------
// Op-only platform panel (reports queue, suspend, platform action log)
// ---------------------------------------------------------------------------

function openOpPanel(event) {
    if (!global.user?.isAdmin) return;
    window.goTo('setting-content', 'op-moderation', { 'category': 'currentSettingTab', 'event': event }, true, renderOpPanel);
}
window.openOpPanel = openOpPanel;

function renderOpPanel() {
    renderReports();
    renderPlatformLog();
}
window.renderOpPanel = renderOpPanel;

function renderReports() {
    const box = document.getElementById("op-reports-list");
    if (!box) return;
    const reports = apiGet(`get_reports?status=open&limit=50`) || [];
    box.innerHTML = reports.length ? fillWith("op-report-row", reports) : `<p class="muted">${_t("Aucun signalement ouvert.")}</p>`;
}
window.renderReports = renderReports;

function resolveReport(reportId, status) {
    xhr(`resolve_report?report_id=${reportId}&status=${status}`,
        function () { if (this.status === 200) { renderReports(); renderPlatformLog(); } }, "POST");
}
window.resolveReport = resolveReport;

function opDeleteMessage(messageId, reportId) {
    const reason = prompt(_t("Raison de la suppression :")) || "";
    xhr(`platform_delete_message?message_id=${messageId}&reason=${encodeURIComponent(reason)}`,
        function () {
            if (this.status === 200) {
                removeMessageLocally(messageId);
                if (reportId) resolveReport(reportId, 'actioned');
                else { renderReports(); renderPlatformLog(); }
            }
        }, "POST");
}
window.opDeleteMessage = opDeleteMessage;

function opSuspendUser() {
    const account = document.getElementById("op-suspend-account")?.value.trim();
    const reason = document.getElementById("op-suspend-reason")?.value.trim();
    const minutes = document.getElementById("op-suspend-minutes")?.value.trim();
    if (!account || !reason) { alert(_t("Compte et raison requis.")); return; }
    let ep = `suspend_user?account_id=${encodeURIComponent(account)}&reason=${encodeURIComponent(reason)}`;
    if (minutes) ep += `&duration_minutes=${encodeURIComponent(minutes)}`;
    xhr(ep, function () {
        if (this.status === 200) { alert(_t("Utilisateur suspendu.")); renderPlatformLog(); }
        else alert(_t("Échec de la suspension."));
    }, "POST");
}
window.opSuspendUser = opSuspendUser;

function opUnsuspendUser() {
    const account = document.getElementById("op-suspend-account")?.value.trim();
    if (!account) return;
    xhr(`unsuspend_user?account_id=${encodeURIComponent(account)}`,
        function () { if (this.status === 200) { alert(_t("Suspension levée.")); renderPlatformLog(); } }, "POST");
}
window.opUnsuspendUser = opUnsuspendUser;

function opDeleteServer() {
    const sid = document.getElementById("op-delete-server")?.value.trim();
    if (!sid) return;
    if (!confirm(_t("Supprimer définitivement ce serveur ?"))) return;
    const reason = prompt(_t("Raison :")) || "";
    xhr(`platform_delete_server?server_id=${encodeURIComponent(sid)}&reason=${encodeURIComponent(reason)}`,
        function () { if (this.status === 200) { alert(_t("Serveur supprimé.")); renderPlatformLog(); } }, "POST");
}
window.opDeleteServer = opDeleteServer;

function renderPlatformLog() {
    const box = document.getElementById("op-log-list");
    if (!box) return;
    const log = apiGet(`get_platform_action_log?limit=50`) || [];
    box.innerHTML = log.length ? fillWith("mod-log-row", log) : `<p class="muted">${_t("Journal vide.")}</p>`;
}
window.renderPlatformLog = renderPlatformLog;

// ---------------------------------------------------------------------------
// Live effects (moderator's own actions + WS notifications, see ws/onMessage.mjs)
// ---------------------------------------------------------------------------

function removeMessageLocally(msgId) {
    for (const cid in (global.convs || {})) {
        if (global.convs[cid]?.messages?.[msgId] !== undefined) {
            try { deleteElementDict(`global.convs[${cid}].messages`, msgId); } catch (e) {}
            break;
        }
    }
    document.getElementById("message-" + msgId)?.closest(".group")?.remove();
}
window.removeMessageLocally = removeMessageLocally;

// A member left the server (kick/ban): drop them from the member list.
function removeServerMember(serverId, accountId) {
    const current = global.state.currentServer;
    const isCurrent = current?.id === Number(serverId);
    // currentServer is usually the same object as global.servers[id]: delete
    // through it first so its subscriptions repaint.
    if (isCurrent && current.members?.[accountId]) deleteElementDict("global.state.currentServer.members", accountId);
    const serv = global.servers?.[serverId];
    if (serv?.members?.[accountId]) delete serv.members[accountId];
    if (!isCurrent) return;
    // The member list is a plain fillWith render: repaint it if it's on screen.
    const list = document.getElementById("member-list");
    if (list) list.outerHTML = getTemplate("member-list");
}
window.removeServerMember = removeServerMember;

// The current user was kicked/banned: forget the server, leave it if open.
function onRemovedFromServer(content) {
    const sid = Number(content.server_id);
    if (global.servers?.[sid]) deleteElementDict("global.servers", sid);
    if (global.state.currentServer?.id === sid) {
        global.state.isServer = false;
        window.goTo('sec-column', "column-perso", undefined, true, () => { window.goTo('sec-selector', "privateMessage") });
    }
    const msg = content.kind === "ban" ? _t("Vous avez été banni·e d'un serveur.") : _t("Vous avez été expulsé·e d'un serveur.");
    alert(content.reason ? msg + "\n" + _t("Raison :") + " " + content.reason : msg);
}
window.onRemovedFromServer = onRemovedFromServer;

function onAccountSuspended() {
    window.location.href = "/static/suspended.html";
}
window.onAccountSuspended = onAccountSuspended;

// ---------------------------------------------------------------------------
// Timed-out banner + composer lock for the current user
// ---------------------------------------------------------------------------

function applyTimeoutState(serverId, expiresAt) {
    if (!global.user.server_timeouts) global.user.server_timeouts = {};
    if (expiresAt) global.user.server_timeouts[String(serverId)] = expiresAt;
    else delete global.user.server_timeouts[String(serverId)];
    updateComposerLock();
}
window.applyTimeoutState = applyTimeoutState;

// send_message refused with {"error": "timed_out"} (e.g. the WS notif was missed):
// lock the composer. Returns true when it was a timeout error.
function handleTimeoutError(req) {
    if (req?.status !== 403) return false;
    const err = parseErrorBody(req);
    if (err?.error !== "timed_out") return false;
    applyTimeoutState(err.server_id, err.expires_at);
    return true;
}
window.handleTimeoutError = handleTimeoutError;

function isTimedOut(serverId) {
    const exp = global.user?.server_timeouts?.[String(serverId)];
    if (!exp) return false;
    if (new Date(exp).getTime() <= Date.now()) { delete global.user.server_timeouts[String(serverId)]; return false; }
    return true;
}
window.isTimedOut = isTimedOut;

/** [id, type] of the server channel the composer writes to (a text channel, or the forum of the open post). */
function composerChannel() {
    const chan = global.state.isServer ? global.state.activeChan : null;
    if (chan?.type === "conv") return [chan.id, "textual"];
    if (chan?.type === "forum") return [chan.id, "forum"];
    return null;
}

function updateComposerLock() {
    const sid = global.state.isServer ? global.state.currentServer?.id : null;
    const chatInput = document.querySelector(".chat-input");
    if (!chatInput) return;
    const timedOut = !!(sid && isTimedOut(sid));
    // Read-only channel: send-messages denied by the channel permissions (access.mjs)
    const place = composerChannel();
    const readOnly = !timedOut && !!place && !window.checkChannelRight?.(place[0], place[1], "send-messages");
    const locked = timedOut || readOnly;
    const ta = chatInput.querySelector("textarea");
    if (ta) ta.disabled = locked;
    chatInput.classList.toggle("locked", locked);

    let banner = document.getElementById("timeout-banner");
    if (locked) {
        if (!banner) {
            banner = document.createElement("div");
            banner.id = "timeout-banner";
            banner.className = "timeout-banner";
            chatInput.parentElement?.insertBefore(banner, chatInput);
        }
        banner.style.display = "flex";
        banner.textContent = readOnly
            ? _t("Tu n'as pas la permission d'envoyer des messages dans ce salon.")
            : _t("Vous êtes temporairement réduit·e au silence jusqu'au ") + String(global.user.server_timeouts[String(sid)]).slice(0, 16);
    } else if (banner) {
        banner.style.display = "none";
    }
}
window.updateComposerLock = updateComposerLock;
