import global from "../framework/global.mjs";
import {goTo} from "../framework/navigation.mjs";
import {updateElement} from "../framework/vesta.mjs";
import {xhr} from "../framework/templating.mjs";
import {lookFor} from "../crud.mjs";
import {channelRoute} from "../routes.mjs";
import {DRIVE_KINDS, canManageDriveItem, canUploadToDrive, driveFileKind, driveItemAuthor, driveItemDate, driveItemName, driveName, findDriveItem, getFileExtension, getFilePreviewType} from "./drive-files.mjs";
import {closeDriveViewer, editInPhoton, isPhotonEditable, openDriveFile, openDriveViewer} from "./drive-viewer.mjs";
import {closeDriveMoveDialog, openDriveMoveDialog} from "./drive-move.mjs";
import {downloadDriveFile, uploadDriveFile, uploadDriveFolder} from "./drive-upload.mjs";

// Drive channels — this module: state, navigation, painting, menus, selection
// and actions. Alongside: drive-files.mjs (file kinds, rights, formatters),
// drive-viewer.mjs (viewer, Photon), drive-move.mjs ("Move to…", drag & drop
// moves), drive-upload.mjs (uploads, downloads). Links: static/drive-links.mjs.

// ── State ─────────────────────────────────────────────────────────────────────
// global.drive: the open drive, one folder at a time —
//   {id, server, folder (null = root), path: [{id, name}], folders, files, loading}
// global.driveSelection: [{type: 'file'|'folder', id}]
// global.driveFilters: Type / People / Modified chips, reset when a drive opens.
// global.drivePrefs: grid/list, sort and details panel, kept per browser.
// The view is painted by the Subscribe('global.drive.*') blocks of
// server-drive-content.html: paintDrive() repaints them all, paintDrive('toolbar')
// one of them.

const PREFS_KEY = 'drive_prefs'
const DEFAULT_PREFS = {view: 'grid', sort: 'name', dir: 1, details: false}

function loadPrefs() {
    try {
        return {...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')}
    } catch (e) {
        return {...DEFAULT_PREFS}
    }
}

function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(global.drivePrefs)) } catch (e) {}
}

global.drivePrefs = loadPrefs()
global.driveFilters = {type: '', person: '', modified: ''}
global.driveSelection = []
let selectionAnchor = null   // last clicked item, for Shift+click ranges
let loadSeq = 0              // only the latest list_drive response is applied

function paintDrive(part) {
    if (global.state.activeChan?.type !== 'drive') return
    updateElement(part ? 'global.drive.' + part : 'global.drive')
    applyDriveSelectionClasses()
}

window.repaintDrive = () => paintDrive()

export function driveRoute(folderId) {
    const drive = global.drive
    return folderId ? channelRoute(drive.server, 'drive', drive.id, 'folder', folderId) : channelRoute(drive.server, 'drive', drive.id)
}

// ── Opening a drive / a folder ────────────────────────────────────────────────

/**
 * Opens a drive channel, at its root or at `target.folder`, or opens
 * `target.file` (its folder + the viewer) — what /channels#<server>/drive/<drive>/folder/<id>
 * and .../file/<id> links resolve to (navigation.mjs handleHashRoute).
 */
function goToDriveChannel(id, target = {}) {
    id = Number(id)
    let targetElt
    if(global.state.activeChan){
        targetElt = document.getElementById("channel".concat(global.state.activeChan.slug))
        targetElt?.classList.remove("selected")
    }

    global.state.activeChan = {id:id, slug:"-drive-"+id, type:"drive"}
    saveLastChannel(id, 'drive')

    if (!global.convs) global.convs = {}
    const drive = lookFor(id, global.state.currentServer.dirs.drives)
    global.convs[id] = {id: id, name: drive ? drive.name : "Salon de stockage", type: "drive"}

    if (global.state.isMobile) {
        mobileDisplayContent()
    }

    targetElt = document.getElementById("channel".concat(global.state.activeChan.slug))
    targetElt?.classList.add("selected")

    global.drive = {id, server: global.state.currentServer.id, folder: null, path: [], folders: [], files: [], loading: true}
    global.driveSelection = []
    global.driveFilters = {type: '', person: '', modified: ''}
    selectionAnchor = null
    // Overlays of a drive left earlier: painted (empty) with the new view
    global.driveViewer = global.driveMove = global.driveMenu = null

    goTo('content','server-drive-content',undefined,false)

    if (target.file) {
        window.pushRoute?.(driveRoute(null))   // the viewer then replaces it with the file's URL
        openDriveFileById(Number(target.file))
    } else {
        loadDriveFolder(target.folder ? Number(target.folder) : null, {route: 'push'})
    }
}
window.goToDriveChannel = goToDriveChannel

/**
 * Loads one folder of the open drive (null = root) and repaints. `opts.route`
 * ('push' | 'replace') updates the URL; `opts.then` runs once it's painted.
 */
function loadDriveFolder(folderId = null, opts = {}) {
    const drive = global.drive
    if (!drive) return
    const seq = ++loadSeq
    drive.requested = folderId   // a reload (live update) must not undo a navigation in flight
    if (opts.route === 'push') window.pushRoute?.(driveRoute(folderId))
    if (opts.route === 'replace') window.replaceRoute?.(driveRoute(folderId))

    const url = `list_drive?drive_id=${drive.id}` + (folderId ? `&folder_id=${folderId}` : '')
    xhr(url, function () {
        if (seq !== loadSeq || global.drive !== drive) return
        if (this.status !== 200) {
            // The folder was deleted (or moved out of reach): fall back to the root.
            if (folderId && this.status === 404) loadDriveFolder(null, {route: 'replace'})
            return
        }
        const data = JSON.parse(this.responseText)
        if (drive.folder !== data.folder_id) {
            global.driveSelection = []
            selectionAnchor = null
        }
        Object.assign(drive, {folder: data.folder_id, folderCreator: data.folder_creator, path: data.path,
                              folders: data.folders, files: data.files, loading: false})
        global.driveSelection = global.driveSelection.filter(s => findDriveItem(s.type, s.id))
        if (global.driveViewer != null && !findDriveItem('file', global.driveViewer)) closeDriveViewer()
        paintDrive()
        opts.then?.()
    })
}

export function reloadDrive() {
    if (global.drive) loadDriveFolder(global.drive.requested)
}
window.reloadDrive = reloadDrive

function openDriveFolder(folderId) {
    loadDriveFolder(folderId ? Number(folderId) : null, {route: 'push'})
}
window.openDriveFolder = openDriveFolder

// A file link: open the file's folder, then the file in the viewer.
function openDriveFileById(fileId) {
    const drive = global.drive
    const ref = `drive:${drive.id}/f:${fileId}`
    xhr(`drive_links?refs=${encodeURIComponent(JSON.stringify([ref]))}`, function () {
        if (global.drive !== drive) return
        const info = this.status === 200 ? JSON.parse(this.responseText)[ref] : null
        if (!info?.ok) {
            loadDriveFolder(null, {route: 'replace'})
            return
        }
        loadDriveFolder(info.folder || null, {then: () => openDriveViewer(fileId)})
    })
}

// Live updates (driveManager.notify_changed → static/ws/onMessage.mjs).
let changedTimer = null
function onDriveChanged(content) {
    const driveId = Number(content?.drive_id)
    window.forgetDriveLinks?.(driveId)
    if (global.state.activeChan?.type !== 'drive' || global.drive?.id !== driveId) return
    clearTimeout(changedTimer)
    changedTimer = setTimeout(reloadDrive, 250)
}
window.onDriveChanged = onDriveChanged

// ── What's shown: filters + sort ──────────────────────────────────────────────

const MODIFIED_FILTERS = {
    today: {label: 'Today', days: 1},
    week:  {label: 'Last 7 days', days: 7},
    month: {label: 'Last 30 days', days: 30},
    year:  {label: 'This year', days: 365},
}
const SORTS = {name: 'Name', modified: 'Modified', size: 'Size'}

export function visibleDriveItems() {
    const drive = global.drive
    if (!drive) return {folders: [], files: []}
    const {type, person, modified} = global.driveFilters
    const since = modified ? Date.now() - MODIFIED_FILTERS[modified].days * 86400000 : null

    const keep = (item, isFolder) => {
        if (type === 'folder' && !isFolder) return false
        if (type && type !== 'folder' && (isFolder || driveFileKind(item.filename) !== type)) return false
        if (person && driveItemAuthor(item) !== person) return false
        if (since && new Date(driveItemDate(item)).getTime() < since) return false
        return true
    }
    const {sort, dir} = global.drivePrefs
    const byName = (a, b) => driveItemName(a).localeCompare(driveItemName(b), undefined, {numeric: true, sensitivity: 'base'})
    const compare = (a, b) => {
        let diff = 0
        if (sort === 'modified') diff = new Date(driveItemDate(a)) - new Date(driveItemDate(b))
        if (sort === 'size') diff = (a.size || 0) - (b.size || 0)
        return (diff || byName(a, b)) * dir
    }
    return {
        folders: drive.folders.filter(f => keep(f, true)).sort(compare),
        files: drive.files.filter(f => keep(f, false)).sort(compare),
    }
}

// Display order (folders first), for Shift+click ranges, arrows and the viewer.
function orderedDriveItems() {
    const {folders, files} = visibleDriveItems()
    return [...folders.map(f => ({type: 'folder', id: f.id})), ...files.map(f => ({type: 'file', id: f.id}))]
}

// ── Painting (Subscribe blocks of server-drive-content.html) ──────────────────
// Each block renders a static/templates/drive-*.html template from a small
// view model; fillWith caches the templates.

const render = (template, model) => fillWith(template, [model])

function driveCrumbsHtml() {
    const drive = global.drive
    if (!drive) return ''
    let crumbs = [{id: null, name: driveName()}, ...drive.path]
    window._driveHiddenCrumbs = []
    if (crumbs.length > 4) {
        window._driveHiddenCrumbs = crumbs.slice(1, -2)
        crumbs = [crumbs[0], {more: true}, ...crumbs.slice(-2)]
    }
    crumbs[crumbs.length - 1] = {...crumbs[crumbs.length - 1], current: true}
    return fillWith('drive-crumb', crumbs)
}
window.driveCrumbsHtml = driveCrumbsHtml

window.driveViewButtonsHtml = () => render('drive-view-buttons', global.drivePrefs)

function driveToolbarHtml() {
    const sel = global.driveSelection
    if (sel.length) {
        return render('drive-selection-bar', {
            count: sel.length,
            hasFiles: sel.some(s => s.type === 'file'),
            canMove: canUploadToDrive(),
            canDelete: sel.every(s => canManageDriveItem(s.type, findDriveItem(s.type, s.id))),
        })
    }
    const {type, person, modified} = global.driveFilters
    return render('drive-toolbar', {
        canUpload: canUploadToDrive(),
        chips: [
            {name: 'type', label: _t('Type'), value: type === 'folder' ? _t('Folders') : type ? _t(DRIVE_KINDS[type].label) : ''},
            {name: 'person', label: _t('People'), value: person},
            {name: 'modified', label: _t('Modified'), value: modified ? _t(MODIFIED_FILTERS[modified].label) : ''},
        ],
    })
}
window.driveToolbarHtml = driveToolbarHtml

function driveBodyHtml() {
    const drive = global.drive
    if (!drive || drive.loading) return render('drive-empty', {message: _t('Loading…')})
    const {folders, files} = visibleDriveItems()
    if (!folders.length && !files.length) {
        const filtered = Object.values(global.driveFilters).some(Boolean)
        return render('drive-empty', {
            icon: true,
            message: filtered ? _t('No item matches these filters') : _t('This folder is empty'),
            hint: !filtered && canUploadToDrive() ? _t('Drop files here or use the New button') : '',
        })
    }

    const {view, sort, dir} = global.drivePrefs
    const arrow = render('drive-sort-arrow', {dir})
    if (view === 'list') {
        return render('drive-list', {
            arrow,
            columns: [{key: 'name', label: 'Name'}, {label: 'Owner'}, {key: 'modified', label: 'Modified'}, {key: 'size', label: 'Size'}, {}]
                .map(col => ({...col, sorted: col.key === sort})),
            rows: [...folders.map(f => ({...f, _type: 'folder'})), ...files.map(f => ({...f, _type: 'file'}))],
        })
    }
    return render('drive-grid', {arrow, sortLabel: SORTS[sort], folders, files})
}
window.driveBodyHtml = driveBodyHtml

// [{id, name, first}] from the root of the drive down `path`, for drive-path-link.
function drivePathLinks(path) {
    return [{id: null, name: driveName()}, ...path].map((c, i) => ({...c, first: i === 0}))
}

function driveDetailsHtml() {
    if (!global.drivePrefs.details || !global.drive) return ''
    const drive = global.drive
    const sel = global.driveSelection
    if (sel.length > 1) return render('drive-details', {multi: true, title: `${sel.length} ${_t('selected')}`})

    const item = sel.length ? findDriveItem(sel[0].type, sel[0].id) : null
    if (!item) {
        return render('drive-details', {
            title: drive.path.length ? drive.path[drive.path.length - 1].name : driveName(),
            folders: drive.folders.length,
            files: drive.files.length,
            location: drivePathLinks(drive.path.slice(0, -1)),
        })
    }
    const type = sel[0].type
    return render('drive-details-item', {
        type, item,
        image: type === 'file' && getFilePreviewType(item.filename) === 'image',
        extension: type === 'file' ? getFileExtension(item.filename).toUpperCase() : '',
        location: drivePathLinks(drive.path),
    })
}
window.driveDetailsHtml = driveDetailsHtml

window.getDriveFilePreviewHtml = (file) => render('drive-file-preview', {
    ...file, preview: getFilePreviewType(file.filename), extension: getFileExtension(file.filename).toUpperCase(),
})

// Text previews (grid tiles and the viewer): global.drivePreviews[id] =
// {filepath, text} (text null while loading), painted by the Subscribe blocks
// of drive-file-preview.html and drive-viewer.html. Blobs are content-addressed:
// a replaced file has a new filepath, so its preview is fetched again.
global.drivePreviews = {}

export function drivePreviewTextHtml(id, className) {
    const file = findDriveItem('file', id)
    let entry = global.drivePreviews[id]
    if (file && entry?.filepath !== file.filepath) {
        const fetched = entry = global.drivePreviews[id] = {filepath: file.filepath, text: null}
        fetch(`/preview_drive_file?file_id=${id}&max_bytes=5000`)
            .then(resp => resp.ok ? resp.text() : '')
            .catch(() => '')
            .then(text => {
                if (global.drivePreviews[id] !== fetched) return
                fetched.text = text
                updateElement(`global.drivePreviews[${id}]`)
            })
    }
    const body = entry?.text == null ? '<span class="drive-preview-loading">…</span>' : escapeHTML(entry.text)
    return `<pre class="${className}">${body}</pre>`
}
window.drivePreviewTextHtml = drivePreviewTextHtml

// ── View preferences ──────────────────────────────────────────────────────────

function setDriveView(view) {
    global.drivePrefs.view = view
    savePrefs()
    paintDrive()
}
window.setDriveView = setDriveView

function toggleDriveDetails() {
    global.drivePrefs.details = !global.drivePrefs.details
    savePrefs()
    paintDrive('viewbtns')
    paintDrive('details')
}
window.toggleDriveDetails = toggleDriveDetails

function showDriveDetails(type, id) {
    global.driveSelection = [{type, id}]
    global.drivePrefs.details = true
    savePrefs()
    paintDrive()
}

function sortDriveBy(key) {
    const prefs = global.drivePrefs
    if (prefs.sort === key) prefs.dir = -prefs.dir
    else Object.assign(prefs, {sort: key, dir: key === 'name' ? 1 : -1})
    savePrefs()
    paintDrive('body')
}
window.sortDriveBy = sortDriveBy

function toggleDriveSortDir() {
    global.drivePrefs.dir = -global.drivePrefs.dir
    savePrefs()
    paintDrive('body')
}
window.toggleDriveSortDir = toggleDriveSortDir

function openDriveSortMenu(event) {
    openDriveMenu(event, Object.entries(SORTS).map(([key, label]) => ({
        label: _t(label), checked: global.drivePrefs.sort === key,
        action: () => { if (global.drivePrefs.sort !== key) sortDriveBy(key) },
    })))
}
window.openDriveSortMenu = openDriveSortMenu

function setDriveFilter(name, value) {
    global.driveFilters[name] = value
    global.driveSelection = []
    paintDrive()
}
window.setDriveFilter = setDriveFilter

function openDriveFilterMenu(event, name) {
    const current = global.driveFilters[name]
    let options = []
    if (name === 'type') {
        options = [['folder', _t('Folders')], ...Object.entries(DRIVE_KINDS).map(([kind, k]) => [kind, _t(k.label)])]
    } else if (name === 'person') {
        const people = new Set([...global.drive.folders, ...global.drive.files].map(driveItemAuthor).filter(Boolean))
        options = [...people].sort().map(p => [p, p])
    } else {
        options = Object.entries(MODIFIED_FILTERS).map(([key, f]) => [key, _t(f.label)])
    }
    // The chip shows the value: a person's name is its own value, the others map to labels.
    openDriveMenu(event, options.map(([value, label]) => ({
        label, checked: current === value, action: () => setDriveFilter(name, current === value ? '' : value),
    })))
}
window.openDriveFilterMenu = openDriveFilterMenu

// ── Menus ─────────────────────────────────────────────────────────────────────

// global.driveMenu: the open menu — {items, x, y, anchor} or null; painted
// by its Subscribe block of server-drive-content.html (drive-menu.html).

export function closeDriveContextMenu() {
    if (!global.driveMenu) return
    global.driveMenu = null
    updateElement('global.driveMenu')
}
window.closeDriveContextMenu = closeDriveContextMenu

window.driveMenuHtml = () => global.driveMenu ? render('drive-menu', global.driveMenu) : ''

/**
 * A menu at the pointer (right-click) or under the clicked button.
 * items: [{label, icon?, danger?, checked?, action}]
 */
function openDriveMenu(event, items) {
    event.preventDefault()
    event.stopPropagation()
    // A second click on the button that opened the menu closes it.
    const anchorEl = event.type === 'contextmenu' ? null : event.currentTarget
    const reopen = anchorEl && global.driveMenu?.anchor === anchorEl
    closeDriveContextMenu()
    if (reopen || !items.length) return

    const anchor = anchorEl?.getBoundingClientRect?.()
    const menu = global.driveMenu = {items, anchor: anchorEl,
        x: anchor ? anchor.left : event.clientX, y: anchor ? anchor.bottom + 4 : event.clientY}
    updateElement('global.driveMenu')

    // Keep it inside the viewport: its size is only known once painted.
    const rect = document.querySelector('.drive-context-menu')?.getBoundingClientRect()
    if (!rect) return
    const x = rect.right > window.innerWidth ? Math.max(8, window.innerWidth - rect.width - 8) : menu.x
    const y = rect.bottom > window.innerHeight ? Math.max(8, window.innerHeight - rect.height - 8) : menu.y
    if (x !== menu.x || y !== menu.y) {
        Object.assign(menu, {x, y})
        updateElement('global.driveMenu')
    }
}

function runDriveMenuItem(event, index) {
    event.preventDefault()
    event.stopPropagation()
    const item = global.driveMenu?.items[index]
    closeDriveContextMenu()
    item?.action()
}
window.runDriveMenuItem = runDriveMenuItem
window.openDriveMenu = openDriveMenu

function driveItemActions(type, id) {
    const item = findDriveItem(type, id)
    if (!item) return []
    const manage = canManageDriveItem(type, item)
    const items = [{label: _t('Open'), icon: type === 'folder' ? 'folder' : 'file', action: () => openDriveItem(type, id)}]
    if (type === 'file') {
        items.push({label: _t('Download'), icon: 'download', action: () => downloadDriveFile(id)})
        if (isPhotonEditable(item.filename)) {
            items.push({label: _t('Edit in Photon'), icon: 'edit', action: () => editInPhoton(id, item.filename)})
        }
    }
    if (manage) items.push({label: _t('Rename'), icon: 'edit', action: () => renameDriveItem(type, id)})
    if (canUploadToDrive()) items.push({label: _t('Move to…'), icon: 'move', action: () => openDriveMoveDialog([{type, id}])})
    items.push({label: _t('Copy link'), icon: 'link', action: () => copyDriveLinks([{type, id}])})
    items.push({label: _t('Details'), icon: 'info', action: () => showDriveDetails(type, id)})
    if (manage) items.push({label: _t('Delete'), icon: 'trash', danger: true, action: () => deleteDriveItems([{type, id}])})
    return items
}

// Right-click or ⋮ on an item: it becomes the selection unless already part of it.
function openDriveItemMenu(event, type, id) {
    // On mobile a long press selects (onDriveTouchStart): no menu on contextmenu,
    // and the ⋮ menu doesn't start a selection.
    if (global.state.isMobile && event.type === 'contextmenu') { event.preventDefault(); return }
    if (!global.state.isMobile && !isDriveSelected(type, id)) {
        global.driveSelection = [{type, id}]
        selectionAnchor = {type, id}
        refreshDriveSelectionUI()
    }
    openDriveMenu(event, driveItemActions(type, id))
}
window.openDriveItemMenu = openDriveItemMenu
// Older templates (mobile bundle) call this name.
window.openDriveContextMenu = openDriveItemMenu

function driveNewItems() {
    return [
        {label: _t('New folder'), icon: 'folder', action: createNewDriveFolder},
        {label: _t('Upload files'), icon: 'file', action: uploadDriveFile},
        {label: _t('Upload a folder'), icon: 'groupadd', action: uploadDriveFolder},
    ]
}

function openDriveNewMenu(event) {
    openDriveMenu(event, driveNewItems())
}
window.openDriveNewMenu = openDriveNewMenu

// ▾ on the current folder (last breadcrumb).
function openDriveFolderMenu(event) {
    const drive = global.drive
    const items = canUploadToDrive() ? driveNewItems() : []
    const current = drive.folder ? findCurrentFolderRow() : null
    if (drive.folder) {
        items.push({label: _t('Copy link'), icon: 'link', action: () => copyDriveLinks([{type: 'folder', id: drive.folder}])})
        if (current && canManageDriveItem('folder', current)) {
            items.push({label: _t('Rename'), icon: 'edit', action: () => renameDriveItem('folder', drive.folder, current.foldername)})
        }
    } else {
        items.push({label: _t('Copy link'), icon: 'link', action: () => copyDriveLinks([{type: 'drive', id: drive.id}])})
    }
    openDriveMenu(event, items)
}
window.openDriveFolderMenu = openDriveFolderMenu

// The current folder's own row isn't in the listing; rename needs its creator.
function findCurrentFolderRow() {
    const drive = global.drive
    return {id: drive.folder, foldername: drive.path[drive.path.length - 1]?.name, creator: drive.folderCreator}
}

function openDriveHiddenCrumbs(event) {
    openDriveMenu(event, (window._driveHiddenCrumbs || []).map(c => ({
        label: c.name, icon: 'folder', action: () => openDriveFolder(c.id),
    })))
}
window.openDriveHiddenCrumbs = openDriveHiddenCrumbs

// ── Selection ─────────────────────────────────────────────────────────────────

export function isDriveSelected(type, id) {
    return global.driveSelection.some(s => s.type === type && Number(s.id) === Number(id))
}

function applyDriveSelectionClasses() {
    document.querySelectorAll('.drive-item.drive-selected').forEach(el => el.classList.remove('drive-selected'))
    for (const s of global.driveSelection) {
        document.querySelectorAll(`.drive-${s.type}-item[data-${s.type}-id="${s.id}"]`)
            .forEach(el => el.classList.add('drive-selected'))
    }
}

export function refreshDriveSelectionUI() {
    applyDriveSelectionClasses()
    paintDrive('toolbar')
    paintDrive('details')
}

function toggleDriveItem(type, id) {
    global.driveSelection = isDriveSelected(type, id)
        ? global.driveSelection.filter(s => !(s.type === type && Number(s.id) === Number(id)))
        : [...global.driveSelection, {type, id}]
    selectionAnchor = {type, id}
    refreshDriveSelectionUI()
}

/**
 * Click: select; Ctrl/Cmd: toggle; Shift: range. On touch screens a tap opens,
 * a long press starts a selection, then taps add/remove items.
 */
function onDriveItemClick(event, type, id) {
    event.stopPropagation()
    if (longPressed) { longPressed = false; return }   // the click ending a long press
    if (global.state.isMobile) {
        if (global.driveSelection.length) toggleDriveItem(type, id)
        else openDriveItem(type, id)
        return
    }
    const entry = {type, id}
    if (event.shiftKey && selectionAnchor) {
        const order = orderedDriveItems()
        const key = (s) => order.findIndex(o => o.type === s.type && Number(o.id) === Number(s.id))
        const [from, to] = [key(selectionAnchor), key(entry)].sort((a, b) => a - b)
        if (from >= 0) {
            global.driveSelection = order.slice(from, to + 1)
            refreshDriveSelectionUI()
            return
        }
    }
    if (event.ctrlKey || event.metaKey) return toggleDriveItem(type, id)
    global.driveSelection = [entry]
    selectionAnchor = entry
    refreshDriveSelectionUI()
}
window.onDriveItemClick = onDriveItemClick

let pressTimer = null
let longPressed = false

// Long press (touch) on an item: select it (#drive-files-list ontouchstart).
function onDriveTouchStart(event) {
    clearTimeout(pressTimer)
    longPressed = false
    const el = event.target.closest('.drive-item')
    if (!el || event.target.closest('.drive-more')) return
    const type = el.classList.contains('drive-folder-item') ? 'folder' : 'file'
    const id = Number(el.dataset[type + 'Id'])
    pressTimer = setTimeout(() => {
        longPressed = true
        navigator.vibrate?.(30)
        toggleDriveItem(type, id)
    }, 500)
}
window.onDriveTouchStart = onDriveTouchStart

function onDriveTouchEnd() {
    clearTimeout(pressTimer)
}
window.onDriveTouchEnd = onDriveTouchEnd

function clearDriveSelection() {
    global.driveSelection = []
    selectionAnchor = null
    refreshDriveSelectionUI()
}
window.clearDriveSelection = clearDriveSelection

// ── Actions ───────────────────────────────────────────────────────────────────

function openDriveItem(type, id) {
    if (type === 'folder') openDriveFolder(id)
    else openDriveFile(id)
}
window.openDriveItem = openDriveItem

async function createNewDriveFolder() {
    const drive = global.drive
    const foldername = await uiPrompt(_t("Enter folder name:"), {title: _t('New folder'), confirmLabel: _t('Create'), required: true, maxLength: 255})
    if (!foldername || global.drive !== drive) return

    const url = `create_drive_folder?drive_id=${drive.id}&foldername=${encodeURIComponent(foldername)}`
        + (drive.folder ? `&parent_folder=${drive.folder}` : '')
    xhr(url, function () {
        if (this.status >= 400) uiAlert(_t('Invalid name'))
        reloadDrive()
    }, "POST")
}
window.createNewDriveFolder = createNewDriveFolder

async function renameDriveItem(type, id, currentName) {
    currentName = currentName ?? driveItemName(findDriveItem(type, id) || {}) ?? ''
    const name = await uiPrompt(_t('New name:'), {title: _t('Rename'), value: currentName, confirmLabel: _t('Rename'), required: true, maxLength: 255})
    if (!name || name === currentName) return
    xhr(`rename_drive_item?item_type=${type}&item_id=${id}&name=${encodeURIComponent(name)}`, function () {
        if (this.status >= 400) uiAlert(_t('Invalid name'))
        reloadDrive()
    }, "POST")
}
window.renameDriveItem = renameDriveItem

async function deleteDriveItems(items) {
    items = [...items]
    if (!items.length) return
    const question = items.length === 1
        ? (items[0].type === 'folder' ? _t('Are you sure you want to delete this folder and all its contents?') : _t('Are you sure you want to delete this file?'))
        : _t('Delete the selected items?') + ` (${items.length})`
    if (!(await uiConfirm(question, {danger: true, confirmLabel: _t('Delete')}))) return

    let left = items.length
    for (const item of items) {
        const url = item.type === 'folder' ? `delete_drive_folder?folder_id=${item.id}` : `delete_drive_file?file_id=${item.id}`
        xhr(url, () => { if (--left === 0) { global.driveSelection = []; reloadDrive() } }, "POST")
    }
}
window.deleteDriveItems = deleteDriveItems

// Kept for older templates (mobile bundle).
window.deleteDriveFile = (id) => deleteDriveItems([{type: 'file', id}])
window.deleteDriveFolder = (id) => deleteDriveItems([{type: 'folder', id}])

function downloadDriveSelection() {
    for (const s of global.driveSelection) {
        if (s.type === 'file') downloadDriveFile(s.id)
    }
}
window.downloadDriveSelection = downloadDriveSelection

// A drive link is a channel mention (static/drive-links.mjs): "<#drive:12>",
// "<#drive:12/d:folder>" or "<#drive:12/f:file>". Pasted in a message, a forum post or
// a note, it renders as a clickable chip.
export function driveLinkToken(item) {
    const drive = global.drive.id
    if (item.type === 'drive') return `<#drive:${drive}>`
    return `<#drive:${drive}/${item.type === 'folder' ? 'd' : 'f'}:${item.id}>`
}
window.driveLinkToken = driveLinkToken

function copyDriveLinks(items) {
    const text = items.map(driveLinkToken).join(' ')
    const done = () => driveToast(items.length > 1 ? _t('Links copied') : _t('Link copied'))
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopyText(text, done))
    } else {
        fallbackCopyText(text, done)
    }
}
window.copyDriveLinks = copyDriveLinks

function fallbackCopyText(text, done) {
    const area = document.createElement('textarea')
    area.value = text
    document.body.appendChild(area)
    area.select()
    try { document.execCommand('copy'); done() } catch (e) {}
    area.remove()
}

function driveToast(message) {
    document.querySelector('.drive-toast')?.remove()
    const toast = document.createElement('div')
    toast.className = 'drive-toast'
    toast.setAttribute('role', 'status')
    toast.textContent = message
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 2000)
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

if (!window._myceliumDriveKeys) {
    window._myceliumDriveKeys = true
    // A click (or right-click) outside the open menu closes it.
    const closeOutside = (event) => {
        if (global.driveMenu && !event.target.closest?.('.drive-context-menu')) closeDriveContextMenu()
    }
    document.addEventListener('click', closeOutside)
    document.addEventListener('contextmenu', closeOutside)
    document.addEventListener('keydown', (event) => {
        if (global.state?.activeChan?.type !== 'drive') return

        if (global.driveViewer != null) return   // drive-viewer.mjs has its own keys
        if (global.driveMove || global.driveMenu) {
            if (event.key === 'Escape') { closeDriveMoveDialog(); closeDriveContextMenu() }
            return
        }
        if (event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return

        const sel = global.driveSelection
        const single = sel.length === 1 ? sel[0] : null
        if (event.key === 'Escape' && sel.length) clearDriveSelection()
        else if (event.key === 'Enter' && single) openDriveItem(single.type, single.id)
        else if (event.key === 'Delete' && sel.length) {
            if (sel.every(s => canManageDriveItem(s.type, findDriveItem(s.type, s.id)))) deleteDriveItems(sel)
        }
        else if (event.key === 'F2' && single && canManageDriveItem(single.type, findDriveItem(single.type, single.id))) renameDriveItem(single.type, single.id)
        else if (event.key === 'Backspace' && global.drive.folder) openDriveFolder(global.drive.path[global.drive.path.length - 2]?.id ?? null)
        else if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
            global.driveSelection = orderedDriveItems()
            refreshDriveSelectionUI()
        }
        else if ((event.ctrlKey || event.metaKey) && event.key === 'c' && sel.length) copyDriveLinks(sel)
        else return
        event.preventDefault()
    })
}
