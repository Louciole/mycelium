import global from "./framework/global.mjs";

/**
 * Alert text for a refused save: the server's reason when it is a short plain-text
 * message ("this role is not below your highest role"), never an HTML error page.
 */
function saveErrorMessage(responseText) {
    const detail = (responseText || "").trim()
    const plain = detail && !detail.startsWith("<") && detail.length <= 200
    return _t("Impossible d'enregistrer ce changement.") + (plain ? "\n" + detail : "")
}
window.saveErrorMessage = saveErrorMessage

// Server permissions, mirror of permissions.py (keep both in sync). Labels and
// descriptions are translation keys. server-admin implies every one of them.
const rights = {
    "view-channels": {'name': 'view-channels', 'category': 'general', 'label': 'Voir les salons', 'description': "Permet de voir les salons par défaut (à l'exception des salons privés)."},
    "manage-channels": {'name': 'manage-channels', 'category': 'general', 'label': 'Gérer les salons', 'description': "Permet de créer, modifier, réorganiser ou supprimer des salons et des catégories."},
    "manage-roles": {'name': 'manage-roles', 'category': 'general', 'label': 'Gérer les rôles', 'description': "Permet de créer des rôles et de modifier, attribuer ou supprimer les rôles inférieurs à son rôle le plus élevé. Permet également de changer les permissions des salons auxquels on a accès."},
    "manage-expressions": {'name': 'manage-expressions', 'category': 'general', 'label': 'Gérer les expressions', 'description': "Permet d'ajouter et de supprimer les émojis personnalisés du serveur."},
    "manage-server": {'name': 'manage-server', 'category': 'general', 'label': 'Gérer le serveur', 'description': "Permet de modifier le nom, l'icône, la description et les réglages communautaires du serveur."},
    "send-messages": {'name': 'send-messages', 'category': 'text', 'label': 'Envoyer des messages', 'description': "Permet d'envoyer des messages dans les salons textuels, de créer des posts de forum et de déposer des fichiers dans les drives."},
    "manage-messages": {'name': 'manage-messages', 'category': 'text', 'label': 'Gérer les messages', 'description': "Permet de supprimer les messages des autres membres et d'épingler, verrouiller ou supprimer les posts de forum."},
    // Moderation rights (routes/moderation.py)
    "kick-members": {'name': 'kick-members', 'category': 'moderation', 'label': 'Expulser des membres', 'description': "Permet d'expulser des membres du serveur. Ils pourront revenir avec une invitation."},
    "ban-members": {'name': 'ban-members', 'category': 'moderation', 'label': 'Bannir des membres', 'description': "Permet de bannir et débannir des membres, et de purger leurs messages récents."},
    "timeout-members": {'name': 'timeout-members', 'category': 'moderation', 'label': 'Exclure temporairement', 'description': "Permet de réduire temporairement des membres au silence."},
    "edit-notes": {'name': 'edit-notes', 'category': 'workspaces', 'label': 'Modifier les notes', 'description': "Permet d'écrire dans les salons de notes : blocs, bases de données et tableurs."},
    "manage-files": {'name': 'manage-files', 'category': 'workspaces', 'label': 'Gérer les fichiers', 'description': "Permet de remplacer ou supprimer les fichiers et dossiers déposés par d'autres membres dans les drives."},
    "server-admin": {'name': 'server-admin', 'category': 'advanced', 'label': 'Administrateur', 'description': "Donne toutes les permissions du serveur et permet de le supprimer. C'est une permission dangereuse : accorde-la avec prudence."},
}
window.rights = rights;

// Instance-wide rights: only grantable to roles of an op server (never @everyone),
// never implied by server-admin.
const op_rights = {
    "dashboard-read": {'name': 'dashboard-read', 'category': 'mycelium', 'label': 'Lire les tableaux de bord', 'description': "Permet d'interroger les tableaux de bord de Mycelium."},
    "mycelium-admin": {'name': 'mycelium-admin', 'category': 'mycelium', 'label': 'Administrer Mycelium', 'description': "Permet d'administrer l'instance Mycelium et de créer des clés d'API administrateur."},
}
window.opr = op_rights;

// Display order of the permission categories in the role editor.
const permissionCategories = [
    {'id': 'general', 'title': 'Permissions générales du serveur'},
    {'id': 'text', 'title': 'Permissions des salons textuels'},
    {'id': 'moderation', 'title': 'Permissions de modération'},
    {'id': 'workspaces', 'title': 'Permissions des espaces de travail'},
    {'id': 'advanced', 'title': 'Permissions avancées'},
    {'id': 'mycelium', 'title': 'Permissions Mycelium'},
]
window.permissionCategories = permissionCategories;

// ── Channel permissions (mirror of permissions.CHANNEL_PERMISSIONS / channel_rights) ──

const CHANNEL_COMMON = ['view-channels', 'manage-channels', 'manage-roles']
const channelScopes = {
    textual: [...CHANNEL_COMMON, 'send-messages', 'manage-messages'],
    forum: [...CHANNEL_COMMON, 'send-messages', 'manage-messages'],
    drive: [...CHANNEL_COMMON, 'send-messages', 'manage-files'],
    note: [...CHANNEL_COMMON, 'edit-notes'],
    vocal: [...CHANNEL_COMMON],
}
// A category's overwrites may set any channel right; each channel keeps its own scope.
channelScopes.category = [...new Set(Object.values(channelScopes).flat())]
window.channelScopes = channelScopes

// What each right means inside one channel (labels/descriptions are translation keys).
const channelRightTexts = {
    'view-channels': {label: 'Voir le salon', description: "Permet aux membres de voir ce salon par défaut. Le refuser à @everyone revient à rendre le salon privé."},
    'manage-channels': {label: 'Gérer le salon', description: "Permet de renommer, déplacer et paramétrer ce salon, ou de le supprimer."},
    'manage-roles': {label: 'Gérer les permissions', description: "Permet de changer les permissions de ce salon (uniquement celles qu'on possède soi-même)."},
    'send-messages': {label: 'Envoyer des messages', description: "Permet d'écrire dans ce salon."},
    'manage-messages': {label: 'Gérer les messages', description: "Permet de supprimer les messages des autres membres dans ce salon (et d'épingler ou verrouiller les posts d'un forum)."},
    'edit-notes': {label: 'Modifier les notes', description: "Permet d'écrire dans ce salon de notes : blocs, bases de données et tableurs."},
    'manage-files': {label: 'Gérer les fichiers', description: "Permet de remplacer ou supprimer les fichiers déposés par d'autres membres dans ce drive."},
}
const channelRightOverrides = {
    forum: {'send-messages': {label: 'Envoyer des messages', description: "Permet de créer des posts et de répondre dans ce forum."}},
    drive: {'send-messages': {label: 'Déposer des fichiers', description: "Permet d'ajouter des fichiers et des dossiers dans ce drive."}},
    vocal: {'view-channels': {label: 'Voir et rejoindre le salon', description: "Permet de voir ce salon vocal et de rejoindre ses appels. Le refuser à @everyone revient à rendre le salon privé."}},
    category: {
        'view-channels': {label: 'Voir les salons', description: "Permet de voir les salons de cette catégorie (sauf si un salon le règle autrement). Le refuser à @everyone revient à rendre la catégorie privée."},
        'manage-channels': {label: 'Gérer les salons', description: "Permet de modifier cette catégorie et ses salons : les renommer, les déplacer, les paramétrer ou les supprimer."},
        'manage-roles': {label: 'Gérer les permissions', description: "Permet de changer les permissions de cette catégorie et de ses salons (uniquement celles qu'on possède soi-même)."},
        'send-messages': {label: 'Envoyer des messages', description: "Permet d'écrire dans les salons textuels et les forums de cette catégorie, et de déposer des fichiers dans ses drives."},
        'manage-messages': {label: 'Gérer les messages', description: "Permet de supprimer les messages des autres membres dans les salons de cette catégorie."},
        'edit-notes': {label: 'Modifier les notes', description: "Permet d'écrire dans les salons de notes de cette catégorie."},
        'manage-files': {label: 'Gérer les fichiers', description: "Permet de remplacer ou supprimer les fichiers des autres membres dans les drives de cette catégorie."},
    },
}
function channelRightText(right, type) {
    return channelRightOverrides[type]?.[right] || channelRightTexts[right]
}
window.channelRightText = channelRightText

const DIR_KEYS = {textual: 'channels', vocal: 'vocals', drive: 'drives', note: 'notes', forum: 'forums', category: 'cat'}

function findChannel(channelId, type, serv = global.state.currentServer) {
    return (serv?.dirs?.[DIR_KEYS[type]] || []).find(ch => Number(ch.id) === Number(channelId))
}
window.findChannel = findChannel

/** Overwrites of one channel (state rows from get_serv_content / edit_channel_permissions). */
function channelOverwrites(channelId, type, serv = global.state.currentServer) {
    return (serv?.channel_permissions || []).filter(p => Number(p.channel) === Number(channelId) && p.channel_type === type)
}
window.channelOverwrites = channelOverwrites

const keysOf = (obj) => Object.keys((typeof obj === 'string' ? JSON.parse(obj) : obj) || {})

/** [{private, rows}] of a channel: its category's overwrites, then its own (Mycelium.permissionLayers). */
function permissionLayers(channelId, type, serv = global.state.currentServer) {
    const chan = findChannel(channelId, type, serv)
    const layers = []
    const cat = type !== 'category' && chan?.category ? findChannel(chan.category, 'category', serv) : null
    if (cat) layers.push({private: cat.is_private, rows: channelOverwrites(cat.id, 'category', serv)})
    layers.push({private: chan?.is_private, rows: channelOverwrites(channelId, type, serv)})
    return layers
}
window.permissionLayers = permissionLayers

/**
 * Effective rights (Set) of a member in a channel or category — same algorithm as
 * permissions.channel_rights: server rights, then for the category layer and the
 * channel's own: @everyone overwrite (+ private = deny view), union of the member's
 * role overwrites, the member's own overwrite.
 */
function channelRightsFor(channelId, type, uid = global.user.id, serv = global.state.currentServer) {
    const scope = new Set(channelScopes[type] || CHANNEL_COMMON)
    if (!serv) return new Set()
    const server = getRights(serv, uid)
    if (serv.owner === uid || server['server-admin']) return scope
    let rights = new Set(Object.keys(server).filter(r => scope.has(r)))
    const pick = (row, col) => keysOf(row[col]).filter(r => scope.has(r))
    const minus = (set, list) => { list.forEach(r => set.delete(r)); return set }
    const plus = (set, list) => { list.forEach(r => set.add(r)); return set }
    const roleIds = (serv.members?.[uid]?.roles || []).map(Number)
    for (const layer of permissionLayers(channelId, type, serv)) {
        for (const row of layer.rows.filter(r => r.role == null && r.account == null)) {
            rights = plus(minus(rights, pick(row, 'deny')), pick(row, 'permissions'))
        }
        if (layer.private) rights.delete('view-channels')
        const roleRows = layer.rows.filter(r => r.role != null && roleIds.includes(Number(r.role)))
        rights = plus(minus(rights, roleRows.flatMap(r => pick(r, 'deny'))), roleRows.flatMap(r => pick(r, 'permissions')))
        for (const row of layer.rows.filter(r => r.account != null && Number(r.account) === Number(uid))) {
            rights = plus(minus(rights, pick(row, 'deny')), pick(row, 'permissions'))
        }
    }
    return rights.has('view-channels') ? rights : new Set()
}
window.channelRightsFor = channelRightsFor

function checkChannelRight(channelId, channelType, right) {
    if (!global.state.currentServer) return true
    right = right === 'view' ? 'view-channels' : right
    return channelRightsFor(channelId, channelType).has(right)
}
window.checkChannelRight = checkChannelRight

const ACTIVE_TYPES = {conv: 'textual', forum: 'forum', drive: 'drive', note: 'note', vocal: 'vocal'}

/**
 * Members shown in the member list: in a server channel, only those who can see it
 * (a private channel lists its members, not the whole server).
 */
function channelMemberList(serv = global.state.currentServer) {
    const members = Object.values(serv?.members || {})
    const chan = global.state.activeChan
    const type = ACTIVE_TYPES[chan?.type]
    if (!global.state.isServer || !type || !findChannel(chan.id, type, serv)) return members
    return members.filter(m => channelRightsFor(chan.id, type, Number(m.id), serv).has('view-channels'))
}
window.channelMemberList = channelMemberList

/**
 * Rights the current user holds on the current server: the @everyone defaults
 * plus every role they have. Computed fresh — roles change live.
 */
function getRights(serv = global.state.currentServer, uid = global.user.id) {
    const userRights = {}
    for (const right of Object.keys(serv?.default_permissions || {})) userRights[right] = true
    for (const roleId of serv?.members?.[uid]?.roles || []) {
        for (const right of Object.keys(serv.roles?.[roleId]?.permissions || {})) userRights[right] = true
    }
    return userRights
}
window.getRights = getRights

/** Owner, the right itself, or server-admin (which implies every server right, not the op ones). */
function checkServRights(right) {
    const serv = global.state.currentServer
    if (!serv) return false
    if (serv.owner === global.user.id) return true
    const userRights = getRights()
    return Boolean(userRights[right] || (userRights['server-admin'] && rights[right]))
}
window.checkServRights = checkServRights

// ── Role hierarchy (mirror of Mycelium.outranks): position 0 = top ──────────

function sortedRoles(serv = global.state.currentServer) {
    return Object.values(serv?.roles || {}).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id - b.id)
}
window.sortedRoles = sortedRoles

/** A member's role ids, highest first. */
function memberRoleIds(uid, serv = global.state.currentServer) {
    const roles = serv?.roles || {}
    return (serv?.members?.[uid]?.roles || [])
        .filter(id => roles[id])
        .sort((a, b) => (roles[a].position ?? 0) - (roles[b].position ?? 0) || a - b)
}
window.memberRoleIds = memberRoleIds

// The "Default" swatch of the role editor: a role with it doesn't colour names.
const DEFAULT_ROLE_COLOR = '#a8a8a8'

/** Colour of a member's highest coloured role (used for their name), or null. */
function memberColor(uid, serv = global.state.currentServer) {
    const top = memberRoleIds(uid, serv).find(id => (serv.roles[id].color || '').toLowerCase() !== DEFAULT_ROLE_COLOR)
    return top !== undefined ? serv.roles[top].color : null
}
window.memberColor = memberColor

/** True if the current user sits strictly above `position` (null = @everyone). */
function outranks(position) {
    const serv = global.state.currentServer
    if (!serv) return false
    if (serv.owner === global.user.id) return true
    const top = memberRoleIds(global.user.id)[0]
    if (top === undefined) return false
    return position === null || position === undefined || serv.roles[top].position < position
}
window.outranks = outranks

/** Can the current user edit/assign/delete this role (or @everyone)? */
function canManageRole(role) {
    return checkServRights('manage-roles') && outranks(role?.isEveryone ? null : role?.position)
}
window.canManageRole = canManageRole

// ── Gated actions: hidden when the right is missing, re-checked live (applyGates) ──

/** Attributes of an action that needs `right` in a channel (the server would refuse it otherwise). */
function channelGate(channelId, type, right) {
    const hidden = checkChannelRight(channelId, type, right) ? '' : ' hidden'
    return `data-gate-channel="${Number(channelId)}" data-gate-type="${type}" data-gate-right="${right}"${hidden}`
}
window.channelGate = channelGate

/** Same for server rights: shown when the user holds any of them. */
function servGate(...needed) {
    const hidden = needed.some(right => checkServRights(right)) ? '' : ' hidden'
    return `data-gate-serv="${needed.join(' ')}"${hidden}`
}
window.servGate = servGate

function applyGates(root = document) {
    for (const el of root.querySelectorAll('[data-gate-right]')) {
        el.hidden = !checkChannelRight(el.dataset.gateChannel, el.dataset.gateType, el.dataset.gateRight)
    }
    for (const el of root.querySelectorAll('[data-gate-serv]')) {
        el.hidden = !el.dataset.gateServ.split(' ').some(right => checkServRights(right))
    }
}
window.applyGates = applyGates

// ── Live permission changes (routes/roles.py notify_permissions_changed) ──────

let permissionsRefresh = null

/**
 * WS "server_permissions_changed": reload the open server. Debounced (a role editor
 * sends one change per click) with some jitter so a big server's members don't all
 * reload at once. Other servers are reloaded anyway when they are opened.
 */
function onServerPermissionsChanged(serverId) {
    if (!global.state.isServer || Number(global.state.currentServer?.id) !== Number(serverId)) return
    clearTimeout(permissionsRefresh)
    permissionsRefresh = setTimeout(() => refreshServerPermissions(Number(serverId)), 200 + Math.random() * 600)
}
window.onServerPermissionsChanged = onServerPermissionsChanged

/** Reload the server and re-evaluate everything that depends on the user's rights. */
function refreshServerPermissions(serverId) {
    if (!global.state.isServer || Number(global.state.currentServer?.id) !== serverId) return
    window.loadServer(serverId)   // repaints the channel list (displayed-dirs) and currentServer subscriptions
    const serv = global.state.currentServer
    const chan = global.state.activeChan
    const type = ACTIVE_TYPES[chan?.type]
    if (type && !findChannel(chan.id, type, serv)) leaveHiddenChannel(serv)
    else if (chan) document.getElementById('channel' + chan.slug)?.classList.add('selected')

    // The role editor must keep editing the reloaded objects
    const role = global.state.currentRole
    if (role) global.state.currentRole = role.isEveryone ? {...role, permissions: serv.default_permissions} : (serv.roles?.[role.id] || role)

    window.updateComposerLock?.()
    applyGates()
    if (global.state.activeChan?.type === 'note') global.state.noteEditor?.applyPermissions?.()
    if (global.state.activeChan?.type === 'drive') window.repaintDrive?.()   // New button, menus, selection bar
    const list = document.getElementById('member-list')   // plain fillWith render
    if (list) list.outerHTML = window.getTemplate('member-list')
    refreshSettingsPanels(serv)
}

/** The open channel can't be viewed anymore: open the first text channel left (or nothing). */
function leaveHiddenChannel(serv) {
    const first = window.firstTextChannel(serv)
    if (first) return window.goToChannel(first.id)
    global.state.activeChan = undefined
    global.state.activeConv = undefined
    const content = document.getElementById('content')
    if (content) content.innerHTML = ''
}

/**
 * Open settings panel (one at a time, crud.mjs closeSettingsPanels): re-check its
 * tabs, and close it when its channel is gone or the open tab isn't usable anymore.
 */
function refreshSettingsPanels(serv) {
    const panel = ['server-params', 'channels-params', 'cat-params']
        .map(id => document.getElementById(id))
        .find(el => el && el.style.display !== 'none')
    if (!panel) return
    let gone = false
    if (panel.id === 'channels-params') {
        gone = !findChannel(global.state.modaltarget?.dataset?.id, global.state.editingChannelType || 'textual', serv)
    } else if (panel.id === 'cat-params') {
        gone = !findChannel(global.state.editingCatId, 'category', serv)
    }
    const selected = panel.querySelector('.settings-list .item.selected')
    if (gone || !selected || selected.hidden) window.closeSettingsPanels()
}
