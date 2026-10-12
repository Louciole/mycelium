// Channel settings › Permissions: private switch + "who has access", and the
// advanced overwrites (allow / inherit / deny per right, for @everyone, a role or a
// member). Rights algorithm mirrored in access.mjs (channelRightsFor); endpoints in
// routes/roles.py (edit_channel_permissions). Hierarchy rules as in the role editor.
import global from "/static/framework/global.mjs";
import {xhr} from "/static/framework/templating.mjs";

const EVERYONE = "everyone"
let selectedTarget = EVERYONE      // "everyone" | "role:<id>" | "member:<id>"

const serv = () => global.state.currentServer

/**
 * The channel or category whose settings are open: #channels-params sets modaltarget +
 * editingChannelType, #cat-params editingCatId (permissionsScope says which is open).
 */
function current() {
    if (global.state.permissionsScope === "category") {
        const id = Number(global.state.editingCatId)
        return {id, type: "category", chan: findChannel(id, "category")}
    }
    const id = Number(global.state.modaltarget?.dataset?.id)
    const type = global.state.editingChannelType || "textual"
    return {id, type, chan: findChannel(id, type)}
}

// Wording that differs between a channel and a category
const SCOPE_TEXTS = {
    channel: {
        title: "Permissions du salon",
        hint: "Utilise les permissions pour personnaliser qui peut faire quoi dans ce salon.",
        private: "Salon privé",
        privateHint: "En définissant un salon comme « privé », seuls les rôles et membres sélectionnés pourront le voir.",
        access: "Qui a accès à ce salon ?",
        general: "Permissions générales du salon",
    },
    category: {
        title: "Permissions de la catégorie",
        hint: "Les permissions de la catégorie s'appliquent à tous ses salons ; chaque salon peut ensuite les ajuster.",
        private: "Catégorie privée",
        privateHint: "En définissant une catégorie comme « privée », seuls les rôles et membres sélectionnés pourront voir ses salons.",
        access: "Qui a accès à cette catégorie ?",
        general: "Permissions générales de la catégorie",
    },
}

function openChannelPermissions(event) {
    selectedTarget = EVERYONE
    const selected = event ? {'category': 'currentSettingTab', 'event': event} : undefined
    window.goTo('setting-server-content', 'channel-permissions-settings', selected, true, renderChannelPermissions)
}
window.openChannelPermissions = openChannelPermissions

/** Can the current user open this tab at all? */
function canManageChannelPermissions(id, type) {
    return checkChannelRight(id, type, "manage-roles")
}
window.canManageChannelPermissions = canManageChannelPermissions

// ── Targets ──────────────────────────────────────────────────────────────────

const memberTopPosition = (uid) => {
    const top = memberRoleIds(uid)[0]
    return top === undefined ? null : serv().roles[top].position
}

function parseTarget(target) {
    if (target === EVERYONE) return {kind: EVERYONE}
    const [kind, id] = target.split(":")
    return {kind, id: Number(id)}
}

function targetParams(target) {
    const t = parseTarget(target)
    return t.kind === "member" ? `&accountId=${t.id}` : t.kind === "role" ? `&roleId=${t.id}` : `&roleId=${EVERYONE}`
}

function rowOf(target) {
    const {id, type} = current()
    const t = parseTarget(target)
    return channelOverwrites(id, type).find(r =>
        t.kind === EVERYONE ? r.role == null && r.account == null
            : t.kind === "role" ? Number(r.role) === t.id
            : r.account != null && Number(r.account) === t.id)
}

/** Can the current user edit this target's overwrite (hierarchy + manage-roles here)? */
function targetEditable(target) {
    const {id, type} = current()
    if (!canManageChannelPermissions(id, type)) return false
    const t = parseTarget(target)
    if (t.kind === EVERYONE) return true
    if (t.kind === "role") return outranks(serv().roles[t.id]?.position)
    return t.id !== serv().owner && outranks(memberTopPosition(t.id))
}

function targetLabel(target) {
    const t = parseTarget(target)
    if (t.kind === EVERYONE) return "@everyone"
    if (t.kind === "role") return serv().roles[t.id]?.name || "?"
    const user = global.users?.[t.id] || {}
    return user.display || user.username || "#" + t.id
}

function targetIcon(target) {
    const t = parseTarget(target)
    if (t.kind === "role") return `<div class="circle" style="background-color:${escapeHTML(serv().roles[t.id]?.color)}"></div>`
    if (t.kind === "member") return `<div class="pfp" style="background-image:url(/static/attachments/${escapeHTML(global.users?.[t.id]?.pfp)})"></div>`
    return `<div class="circle" style="background-color:#a8a8a8"></div>`
}

const keys = (obj) => Object.keys((typeof obj === "string" ? JSON.parse(obj) : obj) || {})
const targetOfRow = (r) => r.account != null ? `member:${r.account}` : r.role != null ? `role:${r.role}` : EVERYONE

// ── API + state ──────────────────────────────────────────────────────────────

function chanApi(params, onOk) {
    const {id, type} = current()
    xhr(`edit_channel_permissions?channelId=${id}&channelType=${type}${params}`, function () {
        let body = null
        try { body = JSON.parse(this.responseText) } catch (e) {}
        if (this.status === 200) onOk?.(body)
        else alert(saveErrorMessage(this.responseText))
        renderChannelPermissions()
    }, "POST")
}

function storeRow(row) {
    if (!row?.id) return
    const rows = serv().channel_permissions || (serv().channel_permissions = [])
    const i = rows.findIndex(r => r.id === row.id)
    if (i >= 0) rows[i] = row
    else rows.push(row)
}

function dropRow(target) {
    const row = rowOf(target)
    if (row) serv().channel_permissions = serv().channel_permissions.filter(r => r.id !== row.id)
}

function afterPermissionChange() {
    // Locks/unlocks the composer if the user's own rights changed in the open channel
    window.updateComposerLock?.()
}

function toggleChannelPrivacy(event) {
    const input = event.currentTarget
    const {chan} = current()
    chanApi("&action=togglePrivacy", resp => {
        if (chan) chan.is_private = resp.is_private
        afterPermissionChange()
    })
    input.checked = !input.checked   // repainted from the state by renderChannelPermissions
}
window.toggleChannelPrivacy = toggleChannelPrivacy

function setChannelPermission(target, right, value) {
    chanApi(`${targetParams(target)}&action=setPermission&permission=${right}&value=${value}`, row => {
        storeRow(row)
        afterPermissionChange()
    })
}
window.setChannelPermission = setChannelPermission

function removeChannelTarget(target) {
    chanApi(`${targetParams(target)}&action=remove`, () => {
        dropRow(target)
        if (selectedTarget === target) selectedTarget = EVERYONE
        afterPermissionChange()
    })
}
window.removeChannelTarget = removeChannelTarget

/** "Who has access" × : drop view-channels from the overwrite (and the overwrite if it's now empty). */
function removeChannelAccess(target) {
    const row = rowOf(target)
    const others = keys(row?.permissions).filter(r => r !== "view-channels").length + keys(row?.deny).length
    if (!others) return removeChannelTarget(target)
    setChannelPermission(target, "view-channels", "inherit")
}
window.removeChannelAccess = removeChannelAccess

function selectChannelTarget(target) {
    selectedTarget = target
    renderChannelPermissions()
}
window.selectChannelTarget = selectChannelTarget

// ── Picker (add access / add a target) ───────────────────────────────────────

let pickerMode = null

function pickerCandidates(mode, q) {
    const {id, type} = current()
    const present = new Set(channelOverwrites(id, type)
        .filter(r => mode === "target" || keys(r.permissions).includes("view-channels"))
        .map(targetOfRow))
    const match = (s) => !q || (s || "").toLowerCase().includes(q)
    const roles = sortedRoles().map(r => `role:${r.id}`)
    const members = Object.keys(serv().members || {}).map(uid => `member:${uid}`)
    return [...roles, ...members].filter(t => !present.has(t) && targetEditable(t)
        && (match(targetLabel(t)) || match(global.users?.[parseTarget(t).id]?.username)))
}

function toggleChannelPicker(mode) {
    const id = mode === "access" ? "chan-access-picker" : "chan-target-picker"
    const picker = document.getElementById(id)
    const open = picker.style.display === "none"
    document.querySelectorAll("#chan-access-picker, #chan-target-picker").forEach(p => p.style.display = "none")
    pickerMode = open ? mode : null
    if (!open) return
    picker.style.display = "flex"
    picker.innerHTML = `
        <div class="search-field">
            <img class="icon" src="/static/icons/material/search.svg">
            <input type="text" class="chan-picker-search" placeholder="${escapeHTML(_t("Rechercher des membres ou des rôles"))}" oninput="renderChannelPicker()" autocomplete="off">
        </div>
        <div class="chan-picker-list"></div>
        <div class="picker-actions">
            <div class="underlhover" onclick="toggleChannelPicker('${mode}')">${_t("Annuler")}</div>
            <div class="btn blue chan-picker-add" onclick="addFromChannelPicker()">${_t("Ajouter")}</div>
        </div>`
    renderChannelPicker()
    picker.querySelector("input").focus()
}
window.toggleChannelPicker = toggleChannelPicker

function renderChannelPicker() {
    const picker = document.getElementById(pickerMode === "access" ? "chan-access-picker" : "chan-target-picker")
    if (!picker) return
    const list = picker.querySelector(".chan-picker-list")
    const ticked = new Set([...list.querySelectorAll("input:checked")].map(i => i.value))
    const q = picker.querySelector("input").value.trim().toLowerCase()
    const items = pickerCandidates(pickerMode, q)
    list.innerHTML = items.length ? items.map(t => `
        <label class="role-member-row pick" data-target="${t}">
            <input type="checkbox" value="${t}" ${ticked.has(t) ? "checked" : ""}>
            <div class="checkbox"></div>
            ${targetIcon(t)}
            <span class="name">${escapeHTML(targetLabel(t))}</span>
            <span class="username">${parseTarget(t).kind === "role" ? _t("Rôle") : escapeHTML(global.users?.[parseTarget(t).id]?.username || "")}</span>
        </label>`).join("") : `<p class="muted">${_t("Aucun membre ni rôle à ajouter.")}</p>`
}
window.renderChannelPicker = renderChannelPicker

function addFromChannelPicker() {
    const picker = document.getElementById(pickerMode === "access" ? "chan-access-picker" : "chan-target-picker")
    const targets = [...picker.querySelectorAll(".chan-picker-list input:checked")].map(i => i.value)
    const mode = pickerMode
    pickerMode = null
    picker.style.display = "none"
    for (const target of targets) {
        const params = mode === "access"
            ? `${targetParams(target)}&action=setPermission&permission=view-channels&value=allow`
            : `${targetParams(target)}&action=add`
        chanApi(params, row => {
            storeRow(row)
            if (mode === "target") selectedTarget = target
            afterPermissionChange()
        })
    }
}
window.addFromChannelPicker = addFromChannelPicker

// ── Render ───────────────────────────────────────────────────────────────────

function renderChannelPermissions() {
    const root = document.querySelector(".chan-perms")
    if (!root) return
    const {id, type, chan} = current()
    const rows = channelOverwrites(id, type)
    const canManage = canManageChannelPermissions(id, type)
    const texts = SCOPE_TEXTS[type === "category" ? "category" : "channel"]
    for (const key of ["title", "hint", "private", "privateHint", "access"]) {
        const el = root.querySelector(`[data-text="${key}"]`)
        if (el) el.textContent = _t(texts[key])
    }
    // A channel inherits its category: say so (its own overwrites apply on top)
    const cat = type !== "category" && chan?.category ? findChannel(chan.category, "category") : null
    const inherit = document.getElementById("chan-inherit")
    inherit.style.display = cat ? "" : "none"
    if (cat) inherit.querySelector("span").textContent =
        _t("Ce salon hérite des permissions de la catégorie « {name} ». Les réglages ci-dessous s'appliquent par-dessus.").replace("{name}", cat.name)

    // Private card + who has access
    const toggle = document.getElementById("chan-private-toggle")
    toggle.checked = Boolean(chan?.is_private)
    toggle.disabled = !targetEditable(EVERYONE)
    document.getElementById("chan-access").style.display = chan?.is_private ? "" : "none"
    document.getElementById("chan-add-access-btn").style.display = canManage ? "" : "none"
    const accessRow = (target, sub, removable) => `
        <div class="chan-access-row" data-target="${target}">
            ${targetIcon(target)}
            <span class="name">${escapeHTML(targetLabel(target))}</span>
            <span class="sub">${escapeHTML(sub)}</span>
            ${removable ? `<img class="icon remove" src="/static/icons/material/closeFilled.svg" title="${escapeHTML(_t("Retirer"))}" onclick="removeChannelAccess('${target}')">` : `<span class="remove-placeholder"></span>`}
        </div>`
    const withView = rows.filter(r => keys(r.permissions).includes("view-channels"))
    const roleRows = withView.filter(r => r.role != null).map(targetOfRow)
        .sort((a, b) => (serv().roles[parseTarget(a).id]?.position ?? 0) - (serv().roles[parseTarget(b).id]?.position ?? 0))
    document.getElementById("chan-access-roles").innerHTML = roleRows.length
        ? roleRows.map(t => accessRow(t, _t("Rôle"), targetEditable(t))).join("")
        : `<p class="muted">${_t("Aucun rôle.")}</p>`
    const memberRows = withView.filter(r => r.account != null).map(targetOfRow)
    document.getElementById("chan-access-members").innerHTML =
        accessRow(`member:${serv().owner}`, _t("Propriétaire du serveur"), false)
        + memberRows.filter(t => parseTarget(t).id !== serv().owner).map(t => accessRow(t, _t("Membre"), targetEditable(t))).join("")

    // Advanced: targets
    const targets = [
        ...rows.filter(r => r.role != null && serv().roles[r.role]).map(targetOfRow)
            .sort((a, b) => serv().roles[parseTarget(a).id].position - serv().roles[parseTarget(b).id].position),
        ...rows.filter(r => r.account != null).map(targetOfRow),
        EVERYONE,
    ]
    if (!targets.includes(selectedTarget)) selectedTarget = EVERYONE
    document.getElementById("chan-add-target-btn").style.display = canManage ? "" : "none"
    document.getElementById("chan-target-list").innerHTML = targets.map(t => `
        <div class="chan-target ${t === selectedTarget ? "selected" : ""}" data-target="${t}" onclick="selectChannelTarget('${t}')">
            ${targetIcon(t)}
            <span>${escapeHTML(targetLabel(t))}</span>
            ${t !== EVERYONE && targetEditable(t) ? `<img class="icon remove" src="/static/icons/material/closeFilled.svg" title="${escapeHTML(_t("Retirer"))}" onclick="event.stopPropagation();removeChannelTarget('${t}')">` : ""}
        </div>`).join("")

    // Advanced: tri-state switches of the selected target
    const editableTarget = targetEditable(selectedTarget)
    const mine = channelRightsFor(id, type)
    const row = rowOf(selectedTarget)
    const allow = keys(row?.permissions), deny = keys(row?.deny)
    document.getElementById("chan-target-title").textContent = `${_t(texts.general)} — ${targetLabel(selectedTarget)}`
    const locked = document.getElementById("chan-target-locked")
    locked.style.display = editableTarget ? "none" : ""
    locked.textContent = canManage
        ? _t("Ce rôle ou ce membre n'est pas en dessous de ton rôle le plus élevé : tu ne peux que consulter ses permissions.")
        : _t("Tu n'as pas la permission de gérer les permissions de ce salon.")
    document.getElementById("chan-perm-list").innerHTML = (channelScopes[type] || []).map(right => {
        const state = allow.includes(right) ? "allow" : deny.includes(right) ? "deny" : "inherit"
        const editable = editableTarget && mine.has(right)
        const text = channelRightText(right, type)
        const button = (value, glyph, title) => `<button type="button" class="${value} ${state === value ? "on" : ""}" title="${escapeHTML(_t(title))}"
            ${editable ? `onclick="setChannelPermission('${selectedTarget}', '${right}', '${value}')"` : "disabled"}>${glyph}</button>`
        return `<div class="permission chan-perm ${editable ? "" : "disabled"}" data-right="${right}" data-state="${state}">
            <div class="inline space-between">
                <h3>${_t(text.label)}</h3>
                <div class="tristate">${button("deny", "✕", "Refuser")}${button("inherit", "/", "Hériter")}${button("allow", "✓", "Autoriser")}</div>
            </div>
            <p>${_t(text.description)}</p>
        </div>`
    }).join("")
}
window.renderChannelPermissions = renderChannelPermissions

// ── Entry points from the channel list ───────────────────────────────────────

const TYPE_BY_PREFIX = {conv: "textual", vocal: "vocal", drive: "drive", note: "note", forum: "forum"}

/** "textual" | "vocal" | … of a channel element of the sidebar (id "channel-<prefix>-<id>"). */
function channelTypeOf(el) {
    return TYPE_BY_PREFIX[(el?.id || "").split("-")[1]] || "textual"
}

/** Can the current user edit the channel whose settings are open (rename, move, delete)? */
function canManageChannel() {
    const {id, type} = current()
    return checkChannelRight(id, type, "manage-channels")
}
window.canManageChannel = canManageChannel

/** Same for the category whose settings are open (#cat-params). */
function canManageCategory() {
    return checkChannelRight(Number(global.state.editingCatId), "category", "manage-channels")
}
window.canManageCategory = canManageCategory

/** Right-click on a category: "Edit category" only if it has a tab you can use. */
function openCategoryMenu(event) {
    const id = Number(event.currentTarget.dataset.id)
    const item = document.getElementById("edit-cat-item")
    if (item) {
        const usable = checkChannelRight(id, "category", "manage-channels") || checkChannelRight(id, "category", "manage-roles")
        item.style.display = usable ? "" : "none"
    }
    window.toggleModale("edit-cat-modale", event)
}
window.openCategoryMenu = openCategoryMenu

/** Right-click on a channel: "Edit channel" only if it has a tab you can use. */
function openChannelMenu(event) {
    const el = event.currentTarget
    const id = Number(el.dataset.id), type = channelTypeOf(el)
    const item = document.getElementById("edit-channel-item")
    if (item) {
        const usable = checkChannelRight(id, type, "manage-channels") || checkChannelRight(id, type, "manage-roles")
        item.style.display = usable ? "" : "none"
    }
    window.toggleModale("edit-channel-modale", event)
}
window.openChannelMenu = openChannelMenu
