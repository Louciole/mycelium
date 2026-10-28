import global from "../framework/global.mjs";
import {xhr} from "../framework/templating.mjs";
import {canUploadToDrive, findDriveItem} from "./drive-files.mjs";
import {reloadDrive} from "./drive.mjs";

// Drive channels: uploads (files, folders, OS drops) and downloads
// (static/servers/drive.mjs).

// ── Uploads ───────────────────────────────────────────────────────────────────

export function uploadDriveFile() {
    document.getElementById('drive-file-input')?.click()
}
window.uploadDriveFile = uploadDriveFile

export function uploadDriveFolder() {
    document.getElementById('drive-folder-input')?.click()
}
window.uploadDriveFolder = uploadDriveFolder

/**
 * POST a file as a data URI in a JSON body ({file: "data:…"}). Resolves with the answer's
 * JSON ({} without one); rejects with Error("quota") when the storage is full (after its own
 * message, handleQuotaError), else with an Error. Drive uploads, the notes' images
 * (static/workspaces/notes.mjs upload_note_image).
 */
export function postFileAsDataUrl(url, file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = function(e) {
            const onload = function() {
                if (this.status === 413) {
                    handleQuotaError(this)
                    reject(new Error("quota"))
                    return
                }
                if (this.status >= 400) {
                    reject(new Error("upload failed: " + this.status))
                    return
                }
                try {
                    resolve(JSON.parse(this.responseText))
                } catch (e) {
                    resolve({})
                }
            }
            // Send file content in the body, not in the URL
            const request = xhr(url, onload, "POST", true, {"file": e.target.result})
            request.onerror = () => reject(new Error("network error"))
        }
        reader.onerror = () => reject(reader.error || new Error("read error"))
        reader.readAsDataURL(file)
    })
}

// Upload a single File object into the given folder (null = root of the drive).
// Resolves with {file_id, filename}, rejects with Error("quota") when the quota is
// exceeded. Also used by the notes' file blocks (static/workspaces/notes.mjs).
export function uploadSingleDriveFile(file, drive_id, parent_folder) {
    const url = parent_folder
        ? `upload_drive_file?drive_id=${drive_id}&filename=${encodeURIComponent(file.name)}&parent_folder=${parent_folder}`
        : `upload_drive_file?drive_id=${drive_id}&filename=${encodeURIComponent(file.name)}`
    return postFileAsDataUrl(url, file)
}

// Create a folder remotely and resolve with its new id.
function createDriveFolderRemote(drive_id, foldername, parent_folder) {
    return new Promise((resolve, reject) => {
        const onload = function() {
            if (this.status >= 400) {
                reject(new Error("folder creation failed: " + this.status))
                return
            }
            try {
                resolve(JSON.parse(this.responseText).folder_id)
            } catch (e) {
                reject(e)
            }
        }
        const url = parent_folder
            ? `create_drive_folder?drive_id=${drive_id}&foldername=${encodeURIComponent(foldername)}&parent_folder=${parent_folder}`
            : `create_drive_folder?drive_id=${drive_id}&foldername=${encodeURIComponent(foldername)}`
        const request = xhr(url, onload, "POST", true)
        request.onerror = () => reject(new Error("network error"))
    })
}

async function handleDriveFileSelect(event) {
    const files = Array.from(event.target.files || [])
    if (!files.length) return

    const drive_id = global.drive.id
    const parent_folder = global.drive.folder

    for (const file of files) {
        try {
            await uploadSingleDriveFile(file, drive_id, parent_folder)
        } catch (e) {
            console.warn("Upload failed for", file.name, e)
            if (e.message === "quota") break
        }
    }

    reloadDrive()
    event.target.value = ''
}
window.handleDriveFileSelect = handleDriveFileSelect

async function handleDriveFolderSelect(event) {
    const files = Array.from(event.target.files || [])
    if (!files.length) return

    const fileList = files.map(file => {
        const relPath = file.webkitRelativePath || file.name
        const slashIdx = relPath.lastIndexOf('/')
        return {file, dirPath: slashIdx === -1 ? '' : relPath.slice(0, slashIdx)}
    })
    await uploadDriveFileList(fileList, global.drive.id, global.drive.folder)

    reloadDrive()
    event.target.value = ''
}
window.handleDriveFolderSelect = handleDriveFolderSelect

// ── Drop files/folders from the OS onto the drive to upload ───────────────────

// Recursively walk a dropped FileSystemEntry into a flat list of
// {file, dirPath} (dirPath = "" at root, "sub/deep" for nested folders).
function walkDriveEntry(entry, dirPath, out) {
    return new Promise((resolve) => {
        if (entry.isFile) {
            entry.file(
                (file) => { out.push({ file, dirPath }); resolve() },
                () => resolve()
            )
        } else if (entry.isDirectory) {
            const subPath = dirPath ? `${dirPath}/${entry.name}` : entry.name
            const reader = entry.createReader()
            // readEntries returns results in batches — keep reading until empty.
            const readBatch = () => {
                reader.readEntries(async (results) => {
                    if (!results.length) { resolve(); return }
                    for (const child of results) await walkDriveEntry(child, subPath, out)
                    readBatch()
                }, () => resolve())
            }
            readBatch()
        } else {
            resolve()
        }
    })
}

// Upload a flat {file, dirPath} list into targetFolder, creating any missing
// folders first. Does NOT refresh the view — the caller decides what to reload.
async function uploadDriveFileList(fileList, drive_id, targetFolder) {
    const folderMap = { '': targetFolder }

    async function ensureFolder(dirPath) {
        if (dirPath in folderMap) return folderMap[dirPath]
        const slashIdx = dirPath.lastIndexOf('/')
        const parentPath = slashIdx === -1 ? '' : dirPath.slice(0, slashIdx)
        const name = slashIdx === -1 ? dirPath : dirPath.slice(slashIdx + 1)
        const parentId = await ensureFolder(parentPath)
        const folderId = await createDriveFolderRemote(drive_id, name, parentId)
        folderMap[dirPath] = folderId
        return folderId
    }

    for (const { file, dirPath } of fileList) {
        try {
            const folderId = await ensureFolder(dirPath)
            await uploadSingleDriveFile(file, drive_id, folderId)
        } catch (e) {
            console.warn("Upload failed for", file.name, e)
            if (e.message === "quota") break
        }
    }
}

// Upload everything in a drop's dataTransfer into targetFolder (folders walked
// recursively via the entries API; flat fallback otherwise). No view refresh.
export async function uploadDroppedItems(dataTransfer, drive_id, targetFolder) {
    const items = dataTransfer.items
    const entries = []
    if (items && items.length && items[0].webkitGetAsEntry) {
        for (const item of items) {
            const entry = item.webkitGetAsEntry?.()
            if (entry) entries.push(entry)
        }
    }

    if (entries.length) {
        const fileList = []
        for (const entry of entries) await walkDriveEntry(entry, '', fileList)
        await uploadDriveFileList(fileList, drive_id, targetFolder)
        return
    }

    // Fallback (no entries API): flat files only.
    for (const file of Array.from(dataTransfer.files || [])) {
        try {
            await uploadSingleDriveFile(file, drive_id, targetFolder)
        } catch (e) {
            if (e.message === "quota") break
        }
    }
}
window.uploadDroppedItems = uploadDroppedItems

// True when the drag carries OS files (an upload) rather than an internal move.
export function isExternalFileDrag(event) {
    const types = event.dataTransfer.types
    if (!types) return false
    return types.includes('Files') && !types.includes('application/x-drive-move')
}
window.isExternalFileDrag = isExternalFileDrag

function onDriveUploadDragOver(event) {
    if (!isExternalFileDrag(event) || !canUploadToDrive()) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    event.currentTarget.classList.add('drive-upload-dragover')
}
window.onDriveUploadDragOver = onDriveUploadDragOver

function onDriveUploadDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove('drive-upload-dragover')
    }
}
window.onDriveUploadDragLeave = onDriveUploadDragLeave

// Drop on the empty drive area → upload into the folder currently being viewed.
async function handleDriveExternalDrop(event) {
    if (!isExternalFileDrag(event)) return  // internal moves are handled elsewhere
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.classList.remove('drive-upload-dragover')
    if (!canUploadToDrive()) return

    await uploadDroppedItems(event.dataTransfer, global.drive.id, global.drive.folder)
    reloadDrive()
}
window.handleDriveExternalDrop = handleDriveExternalDrop

export function downloadDriveFile(file_id, filename) {
    // filename is optional — resolve from loaded state so callers don't have to
    // pass it through inline HTML (avoids breakage on names with quotes).
    if (!filename) filename = findDriveItem('file', file_id)?.filename || 'download'
    const url = `/download_drive_file?file_id=${file_id}`
    // Capacitor WebView silently ignores the `download` attribute; use blob fetch instead.
    if (window.Capacitor?.isNativePlatform?.()) {
        nativeBlobDownload(url, filename)
        return
    }
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
}
window.downloadDriveFile = downloadDriveFile
