import global from "../framework/global.mjs";
import {xhr} from "../framework/templating.mjs";
import {updateElement} from "../framework/vesta.mjs";
import {canUploadToDrive, driveName} from "./drive-files.mjs";
import {isExternalFileDrag, uploadDroppedItems} from "./drive-upload.mjs";
import {closeDriveContextMenu, driveLinkToken, isDriveSelected, refreshDriveSelectionUI, reloadDrive} from "./drive.mjs";

// Drive channels: moving items — the "Move to…" dialog and drag & drop onto
// folders and breadcrumbs (static/servers/drive.mjs).

// ── Move to… dialog ───────────────────────────────────────────────────────────

// global.driveMove: the open dialog — {items, origin, folder, path, folders,
// loading} or null; painted by its Subscribe block of server-drive-content.html.

export function openDriveMoveDialog(items) {
    if (!items?.length) return
    closeDriveContextMenu()
    global.driveMove = {items: [...items], origin: global.drive.folder, folder: global.drive.folder,
                        path: [...global.drive.path], folders: [], loading: true}
    loadDriveMoveFolder(global.drive.folder)
}
window.openDriveMoveDialog = openDriveMoveDialog

function loadDriveMoveFolder(folderId) {
    const state = global.driveMove
    if (!state) return
    state.loading = true
    paintDriveMoveDialog()
    xhr(`list_drive?drive_id=${global.drive.id}` + (folderId ? `&folder_id=${folderId}` : ''), function () {
        if (global.driveMove !== state || this.status !== 200) return
        const data = JSON.parse(this.responseText)
        Object.assign(state, {folder: data.folder_id, path: data.path, folders: data.folders, loading: false})
        paintDriveMoveDialog()
    })
}
window.loadDriveMoveFolder = loadDriveMoveFolder

function paintDriveMoveDialog() {
    updateElement('global.driveMove')
    document.getElementById('drive-move-here')?.focus()   // Enter moves, Tab reaches the folders
}

window.driveMoveDialogHtml = () => {
    const state = global.driveMove
    if (!state) return ''
    const moving = new Set(state.items.filter(i => i.type === 'folder').map(i => Number(i.id)))
    // Not into a moved folder (nor below it), and not where the items already are.
    const inside = state.path.some(p => moving.has(Number(p.id)))
    return fillWith('drive-move-dialog', [{
        title: state.items.length === 1 ? _t('Move 1 item') : _t('Move') + ` ${state.items.length} ` + _t('items'),
        crumbs: [{id: null, name: driveName()}, ...state.path],
        loading: state.loading,
        folders: state.folders.map(f => ({...f, moving: moving.has(Number(f.id))})),
        disabled: state.loading || inside || state.folder === state.origin,
    }])
}

export function closeDriveMoveDialog() {
    if (!global.driveMove) return
    global.driveMove = null
    updateElement('global.driveMove')
}
window.closeDriveMoveDialog = closeDriveMoveDialog

function confirmDriveMove() {
    if (!global.driveMove) return
    const {items, folder} = global.driveMove
    closeDriveMoveDialog()
    moveDriveItems(items, folder)
}
window.confirmDriveMove = confirmDriveMove

function moveDriveItems(items, targetFolder) {
    const onload = function() {
        const resp = JSON.parse(this.responseText)
        if (resp.errors && resp.errors.length > 0) {
            console.warn("Move errors:", resp.errors)
        }
        global.driveSelection = []
        reloadDrive()
    }

    xhr(`move_drive_items?items=${encodeURIComponent(JSON.stringify(items))}&target_folder=${targetFolder || ''}`, onload, "POST")
}
window.moveDriveItems = moveDriveItems

// ── Drag to move (and drag a file into a message: its link) ───────────────────

function onDriveItemDrag(event, type, id) {
    if (!isDriveSelected(type, id)) {
        global.driveSelection = [{ type, id }]
        refreshDriveSelectionUI()
    }

    // Dropped in a message composer or a note, the items become links.
    event.dataTransfer.setData('text/plain', global.driveSelection.map(driveLinkToken).join(' '))
    // Moving files/folders is a write, like uploads (driveManager _get_drive_write_access)
    if (!canUploadToDrive()) return
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('application/x-drive-move', JSON.stringify(global.driveSelection))

    // Set drag image hint for multi-select
    if (global.driveSelection.length > 1) {
        const badge = document.createElement('div')
        badge.className = 'drive-drag-badge'
        badge.textContent = global.driveSelection.length + ' ' + _t('items')
        document.body.appendChild(badge)
        event.dataTransfer.setDragImage(badge, 0, 0)
        setTimeout(() => badge.remove(), 0)
    }
}
window.onDriveItemDrag = onDriveItemDrag

function onDriveFolderDragOver(event) {
    const external = isExternalFileDrag(event)
    const internal = event.dataTransfer.types.includes('application/x-drive-move')
    if (!external && !internal) return

    event.preventDefault()
    event.stopPropagation()  // don't also trigger the list-level upload highlight
    event.dataTransfer.dropEffect = external ? 'copy' : 'move'

    event.currentTarget.classList.add('drive-drop-target')
}
window.onDriveFolderDragOver = onDriveFolderDragOver

function onDriveFolderDragLeave(event) {
    const folderEl = event.currentTarget
    // Only remove if actually leaving (not entering a child)
    if (!folderEl.contains(event.relatedTarget)) {
        folderEl.classList.remove('drive-drop-target')
    }
}
window.onDriveFolderDragLeave = onDriveFolderDragLeave

// A folder can't go into itself, nor into a folder of the current path above it
// (the backend validates too, this is just for UX).
function isDescendantFolder(folderId, targetFolderId) {
    if (Number(folderId) === Number(targetFolderId)) return true
    return (global.drive.path || []).some(p => Number(p.id) === Number(folderId))
}

function dropMoveItems(event, targetFolderId) {
    const raw = event.dataTransfer.getData('application/x-drive-move')
    if (!raw) return
    const items = JSON.parse(raw)
    const validItems = (items || []).filter(item =>
        !(item.type === 'folder' && targetFolderId && isDescendantFolder(item.id, targetFolderId)))
    if (validItems.length) moveDriveItems(validItems, targetFolderId)
}

async function onDriveFolderDrop(event, targetFolderId) {
    const external = isExternalFileDrag(event)
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.classList.remove('drive-drop-target')

    // OS files dropped onto a folder tile → upload into that folder.
    if (external) {
        if (!canUploadToDrive()) return
        await uploadDroppedItems(event.dataTransfer, global.drive.id, targetFolderId)
        reloadDrive()
        return
    }
    dropMoveItems(event, targetFolderId)
}
window.onDriveFolderDrop = onDriveFolderDrop

function onDriveRootDragOver(event) {
    if (!event.dataTransfer.types.includes('application/x-drive-move')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    event.currentTarget.classList.add('drive-drop-target')
}
window.onDriveRootDragOver = onDriveRootDragOver

function onDriveRootDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove('drive-drop-target')
    }
}
window.onDriveRootDragLeave = onDriveRootDragLeave

function onDriveBreadcrumbDrop(event, targetFolderId) {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.classList.remove('drive-drop-target')
    dropMoveItems(event, targetFolderId)
}
window.onDriveBreadcrumbDrop = onDriveBreadcrumbDrop
