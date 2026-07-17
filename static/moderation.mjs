// Moderation frontend: server-level actions (kick/ban/timeout) from the member
// profile card, the server-settings Moderation tab (ban list + log), message/
// profile reporting, and the op-only platform panel (reports queue, suspend,
// action log). See docs/moderation.md.
import global from "./framework/global.mjs";
import {xhr} from "./framework/templating.mjs";
import {deleteElementDict} from "./framework/vesta.mjs";

function t(s) { return (window._t ? window._t(s) : s); }

// Synchronous JSON GET (mirrors admin.mjs/getDashboard's pattern).
function apiGet(endpoint) {
    const req = xhr(endpoint, () => {}, "GET", false);
    if (req.status === 200) {
        try { return JSON.parse(req.responseText); } catch (e) { return null; }
    }
    return null;
}

function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}

// ---------------------------------------------------------------------------
// Server-level actions (member profile card)
// ---------------------------------------------------------------------------

function _target() {
    return { uid: global.state.profileInfo?.id, sid: global.state.currentServer?.id };
}

function modKick() {
    const { uid, sid } = _target();
    if (!uid || !sid) return;
    if (!confirm(t("Expulser ce membre du serveur ?"))) return;
    const reason = prompt(t("Raison (optionnel) :")) || "";
    xhr(`kick_member?server_id=${sid}&account_id=${uid}&reason=${encodeURIComponent(reason)}`,
        function () { if (this.status === 200) window.closeFM?.(); }, "POST");
}
window.modKick = modKick;

function modBan() {
    const { uid, sid } = _target();
    if (!uid || !sid) return;
    if (!confirm(t("Bannir ce membre ? Il ne pourra plus rejoindre le serveur."))) return;
    const reason = prompt(t("Raison (optionnel) :")) || "";
    const purge = prompt(t("Purger les messages des N derniers jours (0 = aucun) :"), "0") || "0";
    xhr(`ban_member?server_id=${sid}&account_id=${uid}&reason=${encodeURIComponent(reason)}&purge_days=${encodeURIComponent(purge)}`,
        function () { if (this.status === 200) window.closeFM?.(); }, "POST");
}
window.modBan = modBan;

function modTimeout() {
    const { uid, sid } = _target();
    if (!uid || !sid) return;
    const minutes = prompt(t("Durée du timeout en minutes (5, 10, 60, 1440…) :"), "10");
    if (!minutes) return;
    const reason = prompt(t("Raison (optionnel) :")) || "";
    xhr(`timeout_member?server_id=${sid}&account_id=${uid}&minutes=${encodeURIComponent(minutes)}&reason=${encodeURIComponent(reason)}`,
        function () { if (this.status === 200) window.closeFM?.(); }, "POST");
}
window.modTimeout = modTimeout;

function reportUser() {
    const { uid } = _target();
    if (!uid) return;
    const reason = prompt(t("Signaler cet utilisateur — raison :"));
    if (!reason) return;
    xhr(`report_content?target_account=${uid}&reason=${encodeURIComponent(reason)}`,
        function () { if (this.status === 200) alert(t("Signalement envoyé.")); }, "POST");
}
window.reportUser = reportUser;

function reportMessage(msgId) {
    const reason = prompt(t("Signaler ce message — raison :"));
    if (!reason) return;
    xhr(`report_content?target_message=${msgId}&reason=${encodeURIComponent(reason)}`,
        function () { if (this.status === 200) alert(t("Signalement envoyé.")); }, "POST");
}
window.reportMessage = reportMessage;

// Buttons rendered inside the member profile card, gated on the viewer's rights.
// Mirrors the checkServRights('server-admin') gating used elsewhere.
function renderModActions() {
    if (!global.state.isServer) return "";
    const targetId = global.state.profileInfo?.id;
    if (!targetId || targetId === global.user?.id) {
        // You can still report others from a DM profile card.
        return targetId && targetId !== global.user?.id
            ? `<div class="mod-actions"><div class="mod-action report" onclick="reportUser()">${t("Signaler")}</div></div>` : "";
    }
    const serv = global.state.currentServer;
    if (serv && serv.owner === targetId) return "";  // never moderate the owner

    let html = '<div class="mod-actions">';
    if (window.checkServRights?.("timeout-members"))
        html += `<div class="mod-action" onclick="modTimeout()">${t("Timeout")}</div>`;
    if (window.checkServRights?.("kick-members"))
        html += `<div class="mod-action" onclick="modKick()">${t("Expulser")}</div>`;
    if (window.checkServRights?.("ban-members"))
        html += `<div class="mod-action ban" onclick="modBan()">${t("Bannir")}</div>`;
    html += `<div class="mod-action report" onclick="reportUser()">${t("Signaler")}</div>`;
    html += '</div>';
    return html;
}
window.renderModActions = renderModActions;

// ---------------------------------------------------------------------------
// Server settings — Moderation tab (ban list + moderation log)
// ---------------------------------------------------------------------------

function openModerationSettings(event) {
    window.goTo('setting-server-content', 'server-moderation-settings',
                { 'category': 'currentSettingTab', 'event': event }, true, renderModerationSettings);
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
    if (!bans.length) { box.innerHTML = `<p class="muted">${t("Aucun bannissement.")}</p>`; return; }
    box.innerHTML = bans.map(b => `
        <div class="mod-row inline space-between">
            <div><b>${esc(b.account_name || b.account)}</b> <span class="muted">${esc(b.reason || "")}</span></div>
            <div class="mod-action" onclick="unbanMember(${b.account})">${t("Débannir")}</div>
        </div>`).join("");
}
window.renderBanList = renderBanList;

function unbanMember(accountId) {
    const sid = global.state.currentServer?.id;
    if (!sid) return;
    xhr(`unban_member?server_id=${sid}&account_id=${accountId}`,
        function () { if (this.status === 200) renderBanList(); }, "POST");
}
window.unbanMember = unbanMember;

function renderModLog() {
    const sid = global.state.currentServer?.id;
    const box = document.getElementById("mod-log-list");
    if (!box || !sid) return;
    const log = apiGet(`get_moderation_log?server_id=${sid}&limit=50`) || [];
    if (!log.length) { box.innerHTML = `<p class="muted">${t("Journal vide.")}</p>`; return; }
    box.innerHTML = log.map(e => `
        <div class="mod-row">
            <span class="mod-badge">${esc(e.action)}</span>
            <b>${esc(e.moderator_name || e.moderator)}</b>
            ${e.target_name ? "→ " + esc(e.target_name) : ""}
            <span class="muted">${esc(e.reason || "")}</span>
            <span class="muted mod-date">${esc((e.created_at || "").slice(0, 19))}</span>
        </div>`).join("");
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
    if (!reports.length) { box.innerHTML = `<p class="muted">${t("Aucun signalement ouvert.")}</p>`; return; }
    box.innerHTML = reports.map(r => `
        <div class="mod-row op-report" data-id="${r.id}">
            <div>
                <b>${esc(r.reporter_name || r.reporter)}</b> ${t("a signalé")}
                ${r.target_message ? t("un message") + " #" + r.target_message : esc(r.target_name || r.target_account || "")}
                <div class="muted">${esc(r.reason || "")}</div>
            </div>
            <div class="inline">
                ${r.target_message ? `<div class="mod-action ban" onclick="opDeleteMessage(${r.target_message}, ${r.id})">${t("Supprimer le message")}</div>` : ""}
                <div class="mod-action" onclick="resolveReport(${r.id}, 'actioned')">${t("Traité")}</div>
                <div class="mod-action" onclick="resolveReport(${r.id}, 'dismissed')">${t("Rejeter")}</div>
            </div>
        </div>`).join("");
}
window.renderReports = renderReports;

function resolveReport(reportId, status) {
    xhr(`resolve_report?report_id=${reportId}&status=${status}`,
        function () { if (this.status === 200) { renderReports(); renderPlatformLog(); } }, "POST");
}
window.resolveReport = resolveReport;

function opDeleteMessage(messageId, reportId) {
    const reason = prompt(t("Raison de la suppression :")) || "";
    xhr(`platform_delete_message?message_id=${messageId}&reason=${encodeURIComponent(reason)}`,
        function () {
            if (this.status === 200) {
                window.removeMessageLocally?.(messageId);
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
    if (!account || !reason) { alert(t("Compte et raison requis.")); return; }
    let ep = `suspend_user?account_id=${encodeURIComponent(account)}&reason=${encodeURIComponent(reason)}`;
    if (minutes) ep += `&duration_minutes=${encodeURIComponent(minutes)}`;
    xhr(ep, function () {
        if (this.status === 200) { alert(t("Utilisateur suspendu.")); renderPlatformLog(); }
        else alert(t("Échec de la suspension."));
    }, "POST");
}
window.opSuspendUser = opSuspendUser;

function opUnsuspendUser() {
    const account = document.getElementById("op-suspend-account")?.value.trim();
    if (!account) return;
    xhr(`unsuspend_user?account_id=${encodeURIComponent(account)}`,
        function () { if (this.status === 200) { alert(t("Suspension levée.")); renderPlatformLog(); } }, "POST");
}
window.opUnsuspendUser = opUnsuspendUser;

function opDeleteServer() {
    const sid = document.getElementById("op-delete-server")?.value.trim();
    if (!sid) return;
    if (!confirm(t("Supprimer définitivement ce serveur ?"))) return;
    const reason = prompt(t("Raison :")) || "";
    xhr(`platform_delete_server?server_id=${encodeURIComponent(sid)}&reason=${encodeURIComponent(reason)}`,
        function () { if (this.status === 200) { alert(t("Serveur supprimé.")); renderPlatformLog(); } }, "POST");
}
window.opDeleteServer = opDeleteServer;

function renderPlatformLog() {
    const box = document.getElementById("op-log-list");
    if (!box) return;
    const log = apiGet(`get_platform_action_log?limit=50`) || [];
    if (!log.length) { box.innerHTML = `<p class="muted">${t("Journal vide.")}</p>`; return; }
    box.innerHTML = log.map(e => `
        <div class="mod-row">
            <span class="mod-badge">${esc(e.action)}</span>
            <b>${esc(e.moderator_name || e.moderator)}</b>
            ${e.target_name ? "→ " + esc(e.target_name) : (e.target_server ? "→ srv#" + e.target_server : "")}
            <span class="muted">${esc(e.reason || "")}</span>
            <span class="muted mod-date">${esc((e.created_at || "").slice(0, 19))}</span>
        </div>`).join("");
}
window.renderPlatformLog = renderPlatformLog;

// ---------------------------------------------------------------------------
// Shared: remove a message from local state + DOM (used by WS + op delete)
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

function isTimedOut(serverId) {
    const exp = global.user?.server_timeouts?.[String(serverId)];
    if (!exp) return false;
    if (new Date(exp).getTime() <= Date.now()) { delete global.user.server_timeouts[String(serverId)]; return false; }
    return true;
}
window.isTimedOut = isTimedOut;

function updateComposerLock() {
    const sid = global.state.currentServer?.id;
    const chatInput = document.querySelector(".chat-input");
    if (!chatInput) return;
    const locked = !!(sid && isTimedOut(sid));
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
        const exp = global.user.server_timeouts[String(sid)];
        banner.style.display = "flex";
        banner.textContent = t("Vous êtes temporairement réduit·e au silence jusqu'au ") + String(exp).slice(0, 16);
    } else if (banner) {
        banner.style.display = "none";
    }
}
window.updateComposerLock = updateComposerLock;
