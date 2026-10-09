import {xhr} from "./framework/templating.mjs";
import global from "./framework/global.mjs";

const rights = {
    "server-admin": {'name': 'server-admin' ,'category': 'advanced', 'description': 'Administrate the server, delete it, do everything'},
    // Moderation rights (routes/moderation.py). server-admin implies all of them.
    "kick-members": {'name': 'kick-members', 'category': 'moderation', 'description': 'Expulser des membres du serveur'},
    "ban-members": {'name': 'ban-members', 'category': 'moderation', 'description': 'Bannir et débannir des membres, purger leurs messages récents'},
    "timeout-members": {'name': 'timeout-members', 'category': 'moderation', 'description': 'Réduire temporairement des membres au silence'},
    "manage-messages": {'name': 'manage-messages', 'category': 'moderation', 'description': 'Supprimer les messages des autres membres'},
}
window.rights = rights;

const op_rights = {
    "dashboard-read": {'name': 'dashboard-read', 'category': 'dashboard', 'description': 'Query the dashboards'},
    "mycelium-admin": {'name': 'mycelium-admin' ,'category': 'mycelium', 'description': 'Administrate Mycelium, create admin API-keys'},
}
window.opr = op_rights;

const channel_rights = {
    "view": {'name': 'view', 'description': 'Voir le salon'},
    "send-messages": {'name': 'send-messages', 'description': 'Envoyer des messages dans le salon'},
}
window.channel_rights = channel_rights;

const allRights = {...rights, ...op_rights}

function checkChannelRight(channelId, channelType, right) {
    const serv = global.state.currentServer
    if (!serv) return true

    // Find the channel object
    let channel = null
    const typeMap = { textual: 'channels', vocal: 'vocals', drive: 'drives', note: 'notes' }
    const dirKey = typeMap[channelType]
    if (dirKey && serv.dirs && serv.dirs[dirKey]) {
        channel = serv.dirs[dirKey].find(ch => ch.id === channelId)
    }

    if (!channel || !channel.is_private) return true

    // Server owner always has access
    if (serv.owner === global.user.id) return true

    // Server-admin role holders have access
    const userRights = getRights()
    if (userRights['server-admin']) return true

    // Check channel_permissions
    const userRoles = serv.members[global.user.id]?.roles || []
    const chanPerms = serv.channel_permissions || []
    for (const roleId of userRoles) {
        const perm = chanPerms.find(p => p.channel === channelId && p.channel_type === channelType && p.role === roleId)
        if (perm) {
            const perms = typeof perm.permissions === 'string' ? JSON.parse(perm.permissions) : perm.permissions
            if (right in perms) return true
        }
    }
    return false
}
window.checkChannelRight = checkChannelRight

function toggleChannelPrivacy() {
    const channelId = global.state.modaltarget.dataset.id
    const channelType = global.state.editingChannelType || 'textual'

    const onload = function() {
        const resp = JSON.parse(this.responseText)
        const isPrivate = resp.is_private

        // Update channel data in dirs
        const typeMap = { textual: 'channels', vocal: 'vocals', drive: 'drives', note: 'notes' }
        const dirKey = typeMap[channelType]
        if (dirKey && global.state.currentServer.dirs[dirKey]) {
            const ch = global.state.currentServer.dirs[dirKey].find(c => c.id === parseInt(channelId))
            if (ch) ch.is_private = isPrivate
        }

        // Show/hide role selector
        const roleSelector = document.getElementById('channel-role-selector')
        if (roleSelector) roleSelector.style.display = isPrivate ? '' : 'none'
    }

    xhr(`edit_channel_permissions?channelId=${channelId}&channelType=${channelType}&action=togglePrivacy`, onload)
}
window.toggleChannelPrivacy = toggleChannelPrivacy

function openRoleSelectionModal() {
    const channelId = global.state.modaltarget.dataset.id
    const channelType = global.state.editingChannelType || 'textual'
    const roles = global.state.currentServer.roles

    // Build role selection popup
    let html = '<div class="role-selection-popup">'
    for (const roleId in roles) {
        const role = roles[roleId]
        // Skip roles already added
        const chanPerms = global.state.currentServer.channel_permissions || []
        const alreadyAdded = chanPerms.find(p => p.channel === parseInt(channelId) && p.channel_type === channelType && p.role === parseInt(roleId))
        if (alreadyAdded) continue

        html += `<div class="inline item" onclick="addChannelRole(${channelId}, '${channelType}', ${roleId})">
            <div class="circle" style="background-color: ${role.color}"></div>
            <div>${role.name}</div>
        </div>`
    }
    if (html === '<div class="role-selection-popup">') {
        html += `<p style="padding: 0.5rem">${_t("Tous les rôles sont déjà ajoutés")}</p>`
    }
    html += '</div>'

    const container = document.getElementById('role-selection-container')
    if (container) {
        container.innerHTML = html
        container.style.display = ''
    }
}
window.openRoleSelectionModal = openRoleSelectionModal

function addChannelRole(channelId, channelType, roleId) {
    const onload = function() {
        const perm = JSON.parse(this.responseText)
        if (!global.state.currentServer.channel_permissions) {
            global.state.currentServer.channel_permissions = []
        }
        // Avoid duplicates
        const existing = global.state.currentServer.channel_permissions.find(p => p.channel === perm.channel && p.channel_type === perm.channel_type && p.role === perm.role)
        if (!existing) {
            global.state.currentServer.channel_permissions.push(perm)
        }
        // Refresh the permissions UI
        refreshChannelPermissionsUI(channelId, channelType)
    }
    xhr(`edit_channel_permissions?channelId=${channelId}&channelType=${channelType}&action=addRole&roleId=${roleId}`, onload)
}
window.addChannelRole = addChannelRole

function removeChannelRole(channelId, channelType, roleId) {
    const onload = function() {
        if (global.state.currentServer.channel_permissions) {
            global.state.currentServer.channel_permissions = global.state.currentServer.channel_permissions.filter(
                p => !(p.channel === parseInt(channelId) && p.channel_type === channelType && p.role === parseInt(roleId))
            )
        }
        refreshChannelPermissionsUI(channelId, channelType)
    }
    xhr(`edit_channel_permissions?channelId=${channelId}&channelType=${channelType}&action=removeRole&roleId=${roleId}`, onload)
}
window.removeChannelRole = removeChannelRole

function editChannelRolePerm(event, channelId, channelType, roleId, permission) {
    event.preventDefault()
    const checked = event.currentTarget.checked
    const onload = function() {
        // Update local state
        if (global.state.currentServer.channel_permissions) {
            const perm = global.state.currentServer.channel_permissions.find(
                p => p.channel === parseInt(channelId) && p.channel_type === channelType && p.role === parseInt(roleId)
            )
            if (perm) {
                let perms = typeof perm.permissions === 'string' ? JSON.parse(perm.permissions) : perm.permissions
                if (checked) {
                    perms[permission] = ''
                } else {
                    delete perms[permission]
                }
                perm.permissions = perms
            }
        }
    }
    xhr(`edit_channel_permissions?channelId=${channelId}&channelType=${channelType}&action=editPermission&roleId=${roleId}&permission=${permission}&value=${checked}`, onload)
}
window.editChannelRolePerm = editChannelRolePerm

function refreshChannelPermissionsUI(channelId, channelType) {
    const chanPerms = (global.state.currentServer.channel_permissions || []).filter(
        p => p.channel === parseInt(channelId) && p.channel_type === channelType
    )

    // Refresh allowed roles list
    const rolesList = document.getElementById('allowed-roles-list')
    if (rolesList) {
        let html = ''
        for (const perm of chanPerms) {
            const role = global.state.currentServer.roles[perm.role]
            if (!role) continue
            html += `<div class="allowed-role-item inline space-between">
                <div class="inline">
                    <div class="circle" style="background-color: ${role.color}"></div>
                    <span>${role.name}</span>
                </div>
                <div class="icon-wrapper" onclick="removeChannelRole(${channelId}, '${channelType}', ${perm.role})">
                    <img class="icon" src="/static/icons/material/closeFilled.svg"/>
                </div>
            </div>`
        }
        rolesList.innerHTML = html
    }

    // Hide role selection popup
    const container = document.getElementById('role-selection-container')
    if (container) container.style.display = 'none'

    // Refresh advanced permissions section
    const advancedSection = document.getElementById('advanced-channel-permissions')
    if (advancedSection) {
        let html = ''
        for (const perm of chanPerms) {
            const role = global.state.currentServer.roles[perm.role]
            if (!role) continue
            const perms = typeof perm.permissions === 'string' ? JSON.parse(perm.permissions) : perm.permissions
            html += `<div class="channel-role-permissions">
                <h3 style="color: ${role.color}">${role.name}</h3>`
            for (const rightKey in channel_rights) {
                const right = channel_rights[rightKey]
                const isChecked = rightKey in perms
                html += `<div class="permission">
                    <div class="inline space-between">
                        <p>${right.description}</p>
                        <label class="switch">
                            <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="editChannelRolePerm(event, ${channelId}, '${channelType}', ${perm.role}, '${rightKey}')">
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>`
            }
            html += '</div>'
        }
        if (html === '') {
            html = `<p class="muted">${_t("Ajoutez des rôles pour configurer les permissions avancées")}</p>`
        }
        advancedSection.innerHTML = html
    }
}
window.refreshChannelPermissionsUI = refreshChannelPermissionsUI

function getRights() {
    if (global.state.currentServer.userRights){
        return global.state.currentServer.userRights;
    }

    const userRoles = global.state.currentServer.members[global.user.id].roles;
    const serverRoles = global.state.currentServer.roles;
    const userRights = {};
    for (const role of userRoles) {
        if (serverRoles[role]) {
            if (Object.keys(serverRoles[role].permissions).length === 0) {
                continue;
            }
            for (const right of Object.keys(serverRoles[role].permissions)) {
                if (rights[right]) {
                    userRights[right] = rights[right];
                }
            }
        }
    }
    global.state.currentServer.userRights = userRights;
    return userRights;
}

function checkServRights(right) {
    if (global.state.currentServer.owner === global.user.id) {
        return true;
    }

    const userRights = getRights();
    if(userRights[right]) {
        return true;
    }else{
        return false;
    }
}
window.checkServRights = checkServRights

function editRolePerm(event, right){
    event.preventDefault();

    const onload = function() {
    }

    if (event.currentTarget.checked) {
        global.state.currentRole.permissions[right] = '';
    } else {
        delete global.state.currentRole.permissions[right];
    }
    const newValue = JSON.stringify(global.state.currentRole.permissions);
    xhr(`/edit_server_role?server_id=${global.state.currentServer.id}&value=${newValue}&targetId=${global.state.currentRole.id}&field=permissions`,onload)
}
window.editRolePerm = editRolePerm
