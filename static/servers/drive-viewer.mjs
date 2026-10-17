import global from "../framework/global.mjs";
import {updateElement} from "../framework/vesta.mjs";
import {driveName, findDriveItem, getFileExtension, getFilePreviewType} from "./drive-files.mjs";
import {driveRoute, reloadDrive, visibleDriveItems} from "./drive.mjs";

// Drive channels: the full-screen viewer (previous/next, Esc) and the hand-off
// to the Photon editor (static/servers/drive.mjs).

// ── Viewer ────────────────────────────────────────────────────────────────────

// Files handed off to the external Photon editor.
// Override in dev/staging via window.PHOTON_ORIGIN before this module loads.
const PHOTON_ORIGIN = window.PHOTON_ORIGIN || 'https://photo.carbonlab.dev'
const PHOTON_EDITOR_URL = `${PHOTON_ORIGIN}/edit`
// Native Photon project formats — these open straight in Photon on double-click.
const PHOTON_PROJECT_EXTENSIONS = ['pto', 'psd']
// Raster images Photon can open as a layer (svg/ico left out — vector/icon).
const PHOTON_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif']

export function isPhotonEditable(filename) {
    const ext = getFileExtension(filename)
    return PHOTON_PROJECT_EXTENSIONS.includes(ext) || PHOTON_IMAGE_EXTENSIONS.includes(ext)
}
window.isPhotonEditable = isPhotonEditable

// Open a drive file in the Photon editor (new tab), passing a download URL +
// file_id so Photon can fetch it and later save the edits back.
export function editInPhoton(file_id, filename) {
    const src = encodeURIComponent(`${location.origin}/download_drive_file?file_id=${file_id}`)
    const name = encodeURIComponent(filename)
    window.open(`${PHOTON_EDITOR_URL}?open=${src}&file_id=${file_id}&name=${name}`, '_blank')
}
window.editInPhoton = editInPhoton

// Double-click: native project files (.pto/.psd) open straight in Photon;
// everything else in the viewer.
export function openDriveFile(file_id) {
    const filename = findDriveFile(file_id)?.filename || ''
    if (PHOTON_PROJECT_EXTENSIONS.includes(getFileExtension(filename))) {
        editInPhoton(file_id, filename)
        return
    }
    openDriveViewer(file_id)
}
window.openDriveFile = openDriveFile

function findDriveFile(file_id) {
    return findDriveItem('file', file_id)
}

// global.driveViewer: id of the file shown (null = closed), painted by its
// Subscribe block of server-drive-content.html — it goes away with the drive view.

export function openDriveViewer(fileId) {
    if (!findDriveFile(fileId)) return
    global.driveViewer = Number(fileId)
    window.replaceRoute?.(global.drive.server + '/' + global.drive.id + '/file/' + fileId)
    updateElement('global.driveViewer')
}
window.openDriveViewer = openDriveViewer

export function closeDriveViewer() {
    if (global.driveViewer == null) return
    global.driveViewer = null
    updateElement('global.driveViewer')
    if (global.drive && global.state.activeChan?.type === 'drive') window.replaceRoute?.(driveRoute(global.drive.folder))
}
window.closeDriveViewer = closeDriveViewer

function stepDriveViewer(step) {
    const files = visibleDriveItems().files
    const index = files.findIndex(f => Number(f.id) === global.driveViewer)
    if (index === -1 || !files.length) return
    openDriveViewer(files[(index + step + files.length) % files.length].id)
}
window.stepDriveViewer = stepDriveViewer

window.driveViewerHtml = () => {
    const file = global.driveViewer == null ? null : findDriveFile(global.driveViewer)
    if (!file) return ''
    const files = visibleDriveItems().files
    return fillWith('drive-viewer', [{
        file, count: files.length,
        index: files.findIndex(f => Number(f.id) === global.driveViewer),
        preview: getFilePreviewType(file.filename),
        photon: isPhotonEditable(file.filename),
        path: [driveName(), ...global.drive.path.map(p => p.name)].join(' › '),
    }])
}

window.findDriveFileName = (id) => findDriveFile(id)?.filename || ''

if (!window._myceliumDriveViewerKeys) {
    window._myceliumDriveViewerKeys = true
    document.addEventListener('keydown', (event) => {
        if (global.driveViewer == null || global.state.activeChan?.type !== 'drive') return
        if (event.key === 'Escape') closeDriveViewer()
        else if (event.key === 'ArrowLeft') stepDriveViewer(-1)
        else if (event.key === 'ArrowRight') stepDriveViewer(1)
        else return
        event.preventDefault()
    })
}

// Photon posts back here after saving an edited file to the drive — refresh the
// current listing so the new/updated file shows immediately.
if (!window._myceliumDriveSaveListener) {
    window._myceliumDriveSaveListener = true
    window.addEventListener('message', (event) => {
        if (event.origin !== PHOTON_ORIGIN) return
        if (event.data?.type !== 'mycelium-drive-file-saved') return
        if (!global.state.activeChan || global.state.activeChan.type !== 'drive') return
        reloadDrive()
    })
}
