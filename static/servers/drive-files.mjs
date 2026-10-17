import global from "../framework/global.mjs";
import {lookFor} from "../crud.mjs";

// Drive channels: what a file is (kind, preview type, badge), who may change it,
// and the formatters shared by the drive modules (static/servers/drive.mjs).

// ── Items, kinds, rights ──────────────────────────────────────────────────────

export function findDriveItem(type, id) {
    const list = type === 'folder' ? global.drive?.folders : global.drive?.files
    return (list || []).find(item => Number(item.id) === Number(id))
}

export const driveItemName = (item) => item.filename ?? item.foldername
export const driveItemDate = (item) => item.uploaded_at ?? item.created_at
export const driveItemAuthor = (item) => item.uploader_name ?? item.creator_name
window.driveItemName = driveItemName
window.driveItemDate = driveItemDate
window.driveItemAuthor = driveItemAuthor

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']
const TEXT_EXTENSIONS = [
    'txt', 'md', 'csv', 'json', 'js', 'mjs', 'ts', 'py', 'html', 'htm',
    'css', 'xml', 'log', 'yml', 'yaml', 'ini', 'toml', 'sh', 'bat',
    'c', 'cpp', 'h', 'java', 'rs', 'go', 'rb', 'php', 'sql', 'r',
    'swift', 'kt', 'lua', 'pl', 'conf', 'cfg', 'env', 'gitignore',
    'dockerfile', 'makefile'
]
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov']
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus']
const SHEET_EXTENSIONS = ['xls', 'xlsx', 'ods', 'csv', 'tsv']
const DOC_EXTENSIONS = ['doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'odp', 'epub']
const ARCHIVE_EXTENSIONS = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']

export function getFileExtension(filename) {
    if (!filename) return ''
    const parts = filename.split('.')
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

export function getFilePreviewType(filename) {
    const ext = getFileExtension(filename)
    if (IMAGE_EXTENSIONS.includes(ext)) return 'image'
    if (TEXT_EXTENSIONS.includes(ext)) return 'text'
    if (VIDEO_EXTENSIONS.includes(ext)) return 'video'
    if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
    if (ext === 'pdf') return 'pdf'
    return 'generic'
}
window.getFilePreviewType = getFilePreviewType

// The Type filter and the coloured badge of a file.
export const DRIVE_KINDS = {
    image:   {label: 'Images', badge: 'I'},
    video:   {label: 'Videos', badge: '▶'},
    audio:   {label: 'Audio', badge: '♪'},
    pdf:     {label: 'PDF', badge: 'P'},
    sheet:   {label: 'Spreadsheets', badge: 'S'},
    doc:     {label: 'Documents', badge: 'D'},
    archive: {label: 'Archives', badge: 'Z'},
    other:   {label: 'Other files', badge: '?'},
}

export function driveFileKind(filename) {
    const ext = getFileExtension(filename)
    if (IMAGE_EXTENSIONS.includes(ext) || ext === 'psd' || ext === 'pto') return 'image'
    if (VIDEO_EXTENSIONS.includes(ext) && ext !== 'ogg') return 'video'
    if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
    if (ext === 'pdf') return 'pdf'
    if (SHEET_EXTENSIONS.includes(ext)) return 'sheet'
    if (DOC_EXTENSIONS.includes(ext) || TEXT_EXTENSIONS.includes(ext)) return 'doc'
    if (ARCHIVE_EXTENSIONS.includes(ext)) return 'archive'
    return 'other'
}
window.driveFileKind = driveFileKind

export function driveKindBadge(filename, big = false) {
    const kind = driveFileKind(filename)
    return `<span class="drive-kind${big ? ' big' : ''} kind-${kind}" aria-hidden="true">${DRIVE_KINDS[kind].badge}</span>`
}
window.driveKindBadge = driveKindBadge

/** Uploads (files, folders, drops), new folders and moves need send-messages in the drive. */
export function canUploadToDrive() {
    return window.checkChannelRight(global.state.activeChan.id, 'drive', 'send-messages')
}

/** Rename/delete: the item's author or manage-files (driveManager._can_manage). */
export function canManageDriveItem(type, item) {
    if (!item) return false
    const author = type === 'folder' ? item.creator : item.uploader
    return Number(author) === Number(global.user?.id)
        || window.checkChannelRight(global.state.activeChan.id, 'drive', 'manage-files')
}


export function driveName() {
    return lookFor(global.drive?.id, global.state.currentServer?.dirs?.drives || [])?.name || _t('Drive')
}

export function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}
window.formatFileSize = formatFileSize

export function formatDate(dateString) {
    if (!dateString) return '—'
    const date = new Date(dateString)
    const days = Math.floor((Date.now() - date) / (1000 * 60 * 60 * 24))

    if (days === 0) return _t('Today')
    if (days === 1) return _t('Yesterday')
    return date.toLocaleDateString()
}
window.formatDate = formatDate
