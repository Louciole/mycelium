// Server settings › Roles: role list (search, counts, drag to reorder, … menu),
// role editor (Display / Permissions / Members tabs, sidebar) and @everyone defaults.
// Rights + hierarchy helpers live in access.mjs; endpoints in routes/roles.py.
import global from "/static/framework/global.mjs";
import {xhr} from "/static/framework/templating.mjs";
import {setElement, updateElement, deleteElementDict} from "/static/framework/vesta.mjs";

const EVERYONE = "everyone"
const ROLE_COLOR_RE = /^#[0-9a-fA-F]{6}$/

let listQuery = ""
let draggedRoleId = null

const serv = () => global.state.currentServer
const sid = () => global.state.currentServer.id

/** The @everyone pseudo-role: shares its permissions object with the server. */
function everyoneRole() {
    if (!serv().default_permissions) serv().default_permissions = {}
    return {id: EVERYONE, name: "@everyone", color: "#a8a8a8", isEveryone: true, permissions: serv().default_permissions}
}

function api(path, onOk, onError) {
    xhr(path, function () {
        let body = null
        try { body = JSON.parse(this.responseText) } catch (e) {}
        if (this.status === 200) onOk?.(body)
        else if (onError) onError(this.status, this.responseText)
        else alert(saveErrorMessage(this.responseText))
    }, "POST")
}

function roleListQuery() { return listQuery }
window.roleListQuery = roleListQuery

function roleMemberCount(roleId) {
    return roleMembers(roleId).length
}
window.roleMemberCount = roleMemberCount

function roleMembers(roleId) {
    const members = serv()?.members || {}
    return Object.keys(members).map(Number).filter(uid => (members[uid].roles || []).map(Number).includes(Number(roleId)))
}

const isEditorOpen = () => Boolean(document.getElementById("role-editor-sidebar"))
const isListOpen = () => Boolean(document.getElementById("role-list-rows"))

// ── Role list ────────────────────────────────────────────────────────────────

function openRolesSettings(event) {
    listQuery = ""
    const selected = event ? {'category': 'currentSettingTab', 'event': event} : undefined
    window.goTo('setting-server-content', 'server-roles-settings', selected, true, renderRoleList)
}
window.openRolesSettings = openRolesSettings

function renderRoleList() {
    const rows = document.getElementById("role-list-rows")
    if (!rows) return
    const all = sortedRoles()
    const q = listQuery.trim().toLowerCase()
    const shown = q ? all.filter(r => r.name.toLowerCase().includes(q)) : all
    document.getElementById("role-count").textContent = `${_t("RÔLES")} – ${all.length}`
    rows.innerHTML = shown.length
        ? fillWith("role-element", shown)
        : `<p class="muted roles-empty">${q ? _t("Aucun rôle ne correspond à ta recherche.") : _t("Aucun rôle pour l'instant.")}</p>`
}
window.renderRoleList = renderRoleList

function searchRoles(event) {
    listQuery = event.currentTarget.value
    renderRoleList()
}
window.searchRoles = searchRoles

function createRole() {
    api(`edit_server_role?server_id=${sid()}&action=create`, role => {
        role.permissions = role.permissions || {}
        serv().roles[role.id] = role
        updateElement("global.state.currentServer.roles")
        openRoleEditor(role.id)
    })
}
window.createRole = createRole

function deleteRole(roleId) {
    const role = serv().roles[roleId]
    if (!role) return
    if (!confirm(_t("Supprimer le rôle « {name} » ? Ses membres le perdront. Cette action est irréversible.").replace("{name}", role.name))) return
    api(`edit_server_role?server_id=${sid()}&action=delete&targetId=${role.id}`, () => {
        for (const member of Object.values(serv().members || {})) {
            member.roles = (member.roles || []).filter(id => Number(id) !== Number(role.id))
        }
        serv().channel_permissions = (serv().channel_permissions || []).filter(p => Number(p.role) !== Number(role.id))
        deleteElementDict("global.state.currentServer.roles", role.id)
        refreshMemberDisplays()
        if (isEditorOpen()) {
            if (String(global.state.currentRole?.id) === String(role.id)) openRolesSettings()
            else renderRoleEditor()
        } else {
            renderRoleList()
        }
    })
}
window.deleteRole = deleteRole

/**
 * Opens the … menu of a role under its button (toggleModale drops it at the click
 * point, over the next rows). "Delete" only shows for roles you can manage.
 */
function openRoleMenu(event, roleId) {
    const menu = document.getElementById("role-actions-modale")
    const role = serv().roles[roleId]
    if (!menu || !role) return
    const anchor = event.currentTarget
    anchor.dataset.id = role.id
    menu.querySelector(".crit").style.display = canManageRole(role) ? "" : "none"
    window.toggleModale("role-actions-modale", event)
    if (global.state.activeFM !== menu) return
    const rect = anchor.getBoundingClientRect()
    const below = rect.bottom + 6 + menu.offsetHeight <= window.innerHeight
    menu.style.top = (below ? rect.bottom + 6 : rect.top - 6 - menu.offsetHeight) + "px"
    menu.style.left = Math.max(8, rect.right - menu.offsetWidth) + "px"
}
window.openRoleMenu = openRoleMenu

function copyRoleId(roleId) {
    // Clipboard can be refused (permissions, insecure context): show the id instead
    const fallback = () => prompt(_t("Identifiant du rôle"), String(roleId))
    if (!navigator.clipboard) return fallback()
    navigator.clipboard.writeText(String(roleId)).catch(fallback)
}
window.copyRoleId = copyRoleId

// ── Drag to reorder (list rows and editor sidebar) ──────────────────────────

function onRoleDragStart(event) {
    draggedRoleId = Number(event.currentTarget.dataset.id)
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", String(draggedRoleId))
}
window.onRoleDragStart = onRoleDragStart

function dropAfter(event) {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY > rect.top + rect.height / 2
}

function onRoleDragOver(event) {
    if (draggedRoleId === null) return
    event.preventDefault()
    const after = dropAfter(event)
    event.currentTarget.classList.toggle("drop-after", after)
    event.currentTarget.classList.toggle("drop-before", !after)
}
window.onRoleDragOver = onRoleDragOver

function onRoleDragLeave(event) {
    event.currentTarget.classList.remove("drop-after", "drop-before")
}
window.onRoleDragLeave = onRoleDragLeave

function onRoleDrop(event) {
    event.preventDefault()
    const target = event.currentTarget
    target.classList.remove("drop-after", "drop-before")
    const dragged = draggedRoleId
    draggedRoleId = null
    const targetId = Number(target.dataset.id)
    if (dragged === null || dragged === targetId) return
    const order = sortedRoles().map(r => r.id).filter(id => id !== dragged)
    order.splice(order.indexOf(targetId) + (dropAfter(event) ? 1 : 0), 0, dragged)
    reorderRoles(order)
}
window.onRoleDrop = onRoleDrop

/** Persist a new hierarchy (role ids, top first). */
function reorderRoles(order) {
    const before = sortedRoles()
    // Roles at or above ours can't move (the server would refuse it anyway)
    if (before.some((role, i) => !outranks(role.position) && order[i] !== role.id)) {
        renderRolesViews()
        return
    }
    api(`reorder_server_roles?server_id=${sid()}&order=${encodeURIComponent(JSON.stringify(order))}`, () => {
        order.forEach((id, position) => { serv().roles[id].position = position })
        updateElement("global.state.currentServer.roles")
        refreshMemberDisplays()
        renderRolesViews()
    }, () => renderRolesViews())
}
window.reorderRoles = reorderRoles

function renderRolesViews() {
    if (isListOpen()) renderRoleList()
    if (isEditorOpen()) renderRoleEditor()
}

// ── Role editor ──────────────────────────────────────────────────────────────

function openRoleEditor(roleId, tab = "display") {
    const role = String(roleId) === EVERYONE ? everyoneRole() : serv().roles[roleId]
    if (!role) return
    global.state.currentRole = role
    global.state.roleTab = role.isEveryone ? "permissions" : (tab || "display")
    delete global.state.currentForm
    window.goTo('setting-server-content', 'server-role-settings', undefined, true, renderRoleEditor)
}
window.openRoleEditor = openRoleEditor

function renderRoleEditor() {
    const role = global.state.currentRole
    if (!role || !document.getElementById("role-editor-sidebar")) return

    document.getElementById("role-editor-sidebar").innerHTML =
        fillWith("role-sidebar-item", [...sortedRoles(), everyoneRole()])
    document.getElementById("role-editor-title").textContent = `${_t("MODIFIER LE RÔLE")} — ${role.name}`

    const more = document.getElementById("role-editor-more")
    more.dataset.id = role.id
    more.style.visibility = role.isEveryone ? "hidden" : ""
    document.getElementById("role-locked-hint").style.display = canManageRole(role) ? "none" : ""

    const tabs = role.isEveryone
        ? [["permissions", _t("Permissions")]]
        : [["display", _t("Affichage")], ["permissions", _t("Permissions")],
           ["members", `${_t("Gérer les membres")} (${roleMemberCount(role.id)})`]]
    document.getElementById("role-tabs").innerHTML = tabs.map(([id, label]) =>
        `<h2 data-tab="${id}" class="${global.state.roleTab === id ? 'selected' : ''}" onclick="switchRoleTab('${id}')">${escapeHTML(label)}</h2>`
    ).join("")

    renderRoleTab()
}
window.renderRoleEditor = renderRoleEditor

function switchRoleTab(tab) {
    global.state.roleTab = tab
    for (const h of document.querySelectorAll("#role-tabs h2")) h.classList.toggle("selected", h.dataset.tab === tab)
    renderRoleTab()
}
window.switchRoleTab = switchRoleTab

function renderRoleTab() {
    const box = document.getElementById("roleEditContent")
    if (!box) return
    const tab = global.state.roleTab
    box.innerHTML = getTemplate(`server-role-settings-${tab === "permissions" ? "rights" : tab}`)
    if (tab === "display") markSelectedColor()
    if (tab === "permissions") renderRolePermissions()
    if (tab === "members") renderRoleMembers()
}

// ── Display tab ──────────────────────────────────────────────────────────────

function markSelectedColor() {
    const color = (global.state.currentRole.color || "").toLowerCase()
    let matched = false
    for (const item of document.querySelectorAll("#role-color-picker .item[data-color]")) {
        const on = item.dataset.color === color
        item.classList.toggle("selected", on)
        matched = matched || on
    }
    const custom = document.querySelector("#role-color-picker .item.custom")
    if (custom) {
        custom.classList.toggle("selected", !matched)
        custom.style.setProperty("--color", color)
    }
    const preview = document.querySelector("#role-preview .role-preview-name")
    if (preview) preview.style.color = color
}

function setRoleColor(color) {
    const role = global.state.currentRole
    if (!ROLE_COLOR_RE.test(color) || role.isEveryone || !canManageRole(role)) return
    api(`edit_server_role?server_id=${sid()}&field=color&value=${encodeURIComponent(color)}&targetId=${role.id}`, resp => {
        setElement(`global.state.currentServer.roles[${role.id}].color`, resp.color)
        setElement("global.state.currentRole.color", resp.color)
        markSelectedColor()
        renderRoleEditorSidebar()
        refreshMemberDisplays()
    })
}
window.setRoleColor = setRoleColor

function renderRoleEditorSidebar() {
    const box = document.getElementById("role-editor-sidebar")
    if (box) box.innerHTML = fillWith("role-sidebar-item", [...sortedRoles(), everyoneRole()])
}

/** Called by Save('editRole') (main.mjs) with the typed name. */
function saveRoleName(name) {
    const role = global.state.currentRole
    api(`edit_server_role?server_id=${sid()}&value=${encodeURIComponent(name)}&field=name&targetId=${role.id}`, resp => {
        setElement(`global.state.currentServer.roles[${role.id}].name`, resp.name)
        setElement("global.state.currentRole.name", resp.name)
        document.getElementById("role-editor-title").textContent = `${_t("MODIFIER LE RÔLE")} — ${resp.name}`
        renderRoleEditorSidebar()
    }, () => {
        alert(_t("Le nom d'un rôle doit faire entre 1 et 24 caractères."))
        const input = document.getElementById("roleName")
        if (input) input.value = role.name
    })
}
window.saveRoleName = saveRoleName

// ── Permissions tab ──────────────────────────────────────────────────────────

/** Can the current user toggle this right on the role being edited? */
function rightEditable(right) {
    return canManageRole(global.state.currentRole) && checkServRights(right)
}
window.rightEditable = rightEditable

/** Mycelium (op) rights: only on an op server, and never for @everyone (routes/roles.py). */
function grantableCatalog() {
    return serv().op && !global.state.currentRole?.isEveryone ? {...window.rights, ...window.opr} : window.rights
}

function renderRolePermissions() {
    const box = document.getElementById("role-perm-list")
    if (!box) return
    const q = (document.getElementById("perm-search")?.value || "").trim().toLowerCase()
    const catalog = grantableCatalog()
    let html = ""
    for (const category of permissionCategories) {
        const list = Object.values(catalog).filter(r => r.category === category.id && (!q
            || _t(r.label).toLowerCase().includes(q) || _t(r.description).toLowerCase().includes(q) || r.name.includes(q)))
        if (!list.length) continue
        html += `<h2 class="perm-category">${_t(category.title)}</h2>` + fillWith("server-right", list)
    }
    box.innerHTML = html || `<p class="muted">${_t("Aucune permission ne correspond à ta recherche.")}</p>`
}
window.renderRolePermissions = renderRolePermissions

function savePermissions(perms, onFail) {
    const role = global.state.currentRole
    api(`edit_server_role?server_id=${sid()}&targetId=${role.id}&field=permissions&value=${encodeURIComponent(JSON.stringify(perms))}`, resp => {
        if (role.isEveryone) {
            serv().default_permissions = resp.permissions
            global.state.currentRole = everyoneRole()
        } else {
            serv().roles[role.id].permissions = resp.permissions
            global.state.currentRole = serv().roles[role.id]
        }
        updateElement("global.state.currentServer.roles")
        renderRolePermissions()
    }, (status, text) => {
        onFail?.()
        alert(saveErrorMessage(text))
    })
}

function editRolePerm(event, right) {
    const input = event.currentTarget
    const perms = {...(global.state.currentRole.permissions || {})}
    if (input.checked) perms[right] = ""
    else delete perms[right]
    savePermissions(perms, () => { input.checked = !input.checked })
}
window.editRolePerm = editRolePerm

function clearRolePerms() {
    if (!Object.keys(global.state.currentRole.permissions || {}).length) return
    if (!confirm(_t("Retirer toutes les permissions de ce rôle ?"))) return
    savePermissions({})
}
window.clearRolePerms = clearRolePerms

// ── Members tab ──────────────────────────────────────────────────────────────

function matchesMember(uid, q) {
    if (!q) return true
    const user = global.users?.[uid] || {}
    return (user.display || "").toLowerCase().includes(q) || (user.username || "").toLowerCase().includes(q)
}

function renderRoleMembers() {
    const box = document.getElementById("role-member-list")
    if (!box) return
    const q = (document.getElementById("role-member-search")?.value || "").trim().toLowerCase()
    const all = roleMembers(global.state.currentRole.id)
    const shown = all.filter(uid => matchesMember(uid, q))
    box.innerHTML = shown.length
        ? fillWith("role-member-row", shown)
        : `<p class="muted">${all.length ? _t("Aucun membre ne correspond à ta recherche.") : _t("Aucun membre n'a ce rôle. Ajoute-en avec le bouton ci-dessus.")}</p>`
}
window.renderRoleMembers = renderRoleMembers

function toggleRoleMemberPicker() {
    const picker = document.getElementById("role-member-picker")
    if (!picker) return
    const open = picker.style.display === "none"
    picker.style.display = open ? "flex" : "none"
    if (open) {
        document.getElementById("role-picker-search").value = ""
        renderRoleMemberPicker()
        document.getElementById("role-picker-search").focus()
    }
}
window.toggleRoleMemberPicker = toggleRoleMemberPicker

function renderRoleMemberPicker() {
    const box = document.getElementById("role-picker-list")
    if (!box) return
    // Keep ticked boxes across searches
    const ticked = new Set([...box.querySelectorAll("input:checked")].map(i => Number(i.value)))
    const q = (document.getElementById("role-picker-search")?.value || "").trim().toLowerCase()
    const has = new Set(roleMembers(global.state.currentRole.id))
    const candidates = Object.keys(serv().members || {}).map(Number).filter(uid => !has.has(uid) && matchesMember(uid, q))
    box.innerHTML = candidates.length
        ? fillWith("role-member-pick", candidates)
        : `<p class="muted">${_t("Aucun membre à ajouter.")}</p>`
    for (const input of box.querySelectorAll("input")) input.checked = ticked.has(Number(input.value))
}
window.renderRoleMemberPicker = renderRoleMemberPicker

function addSelectedRoleMembers() {
    const role = global.state.currentRole
    const ids = [...document.querySelectorAll("#role-picker-list input:checked")].map(i => Number(i.value))
    if (!ids.length) return
    api(`add_role_members?server_id=${sid()}&role_id=${role.id}&members=${encodeURIComponent(JSON.stringify(ids))}`, resp => {
        for (const uid of resp.added) applyMemberRole(uid, role.id, true)
        toggleRoleMemberPicker()
    })
}
window.addSelectedRoleMembers = addSelectedRoleMembers

function removeRoleMember(uid) {
    const role = global.state.currentRole
    api(`edit_server_role?server_id=${sid()}&action=unattribute&value=${uid}&targetId=${role.id}`, () => {
        applyMemberRole(uid, role.id, false)
    })
}
window.removeRoleMember = removeRoleMember

/**
 * Reflect a role (un)attribution in the state and every view showing it:
 * profile card, role list counts, editor tabs, names coloured by role.
 */
function applyMemberRole(uid, roleId, has) {
    const member = serv().members?.[uid]
    if (!member) return
    const others = (member.roles || []).filter(id => Number(id) !== Number(roleId))
    setElement(`global.state.currentServer.members[${uid}].roles`, has ? [...others, Number(roleId)] : others)
    if (Number(global.state.profileInfo?.id) === Number(uid)) updateElement("global.state.profileInfo")
    refreshMemberDisplays()
    if (isListOpen()) renderRoleList()
    if (isEditorOpen() && String(global.state.currentRole?.id) === String(roleId)) {
        const tab = document.querySelector('#role-tabs h2[data-tab="members"]')
        if (tab) tab.textContent = `${_t("Gérer les membres")} (${roleMemberCount(roleId)})`
        if (global.state.roleTab === "members") renderRoleMembers()
    }
}
window.applyMemberRole = applyMemberRole

/** Names are coloured by the highest role: repaint the open member list. */
function refreshMemberDisplays() {
    const list = document.getElementById("member-list")
    if (list && serv()) {
        list.querySelectorAll(".name[data-uid]").forEach(el => {
            const color = memberColor(Number(el.dataset.uid))
            if (color) el.style.setProperty("--text2", color)
            else el.style.removeProperty("--text2")
        })
    }
}
window.refreshMemberDisplays = refreshMemberDisplays
