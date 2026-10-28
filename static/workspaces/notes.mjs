import {ChatMarkdown} from "../chat-markdown.mjs";
import {xhr} from "../framework/templating.mjs";
import {setElement, updateElement} from "../framework/vesta.mjs";
import {goTo} from "../framework/navigation.mjs";
import {} from "./synapse.mjs";
import {getNoteSync, onNotesSocketReady, noteSyncFor} from "./noteSync.mjs";
import {NotePresence, pointAt} from "./notePresence.mjs";
import {keyBetween, MAX_KEY_LENGTH} from "../crdt/keys.mjs"
import {MAX_INDENT} from "../crdt/doc.mjs";
import {
    registerFunction,
    evaluateText
} from "./formulaEngine.mjs";
import {mountDatabase} from "./database.mjs";
import {mountSpreadsheet, onSheetChange} from "./spreadsheet.mjs";
import {mountTransportBlock} from "./transport.mjs";
import {orderServDirs} from "../crud.mjs";
import {uploadSingleDriveFile, postFileAsDataUrl} from "../servers/drive-upload.mjs";
import {fileLinkIds} from "../drive-links.mjs";

// Plain-text kinds: a block of one of these can be turned into another (block menu)
const TEXT_KINDS = ["text", "heading1", "heading2", "heading3", "small", "bullet", "numbered"]
// List items: one block per item, its level in `indent` (Tab / Shift+Tab). The bullets and
// the numbers are drawn by CSS (style.css, counters over the whole page)
const LIST_KINDS = ["bullet", "numbered"]
const isList = (block) => LIST_KINDS.includes(block?.type)

// Image blocks: their text is where the image is stored with the note (upload_note_image,
// routes/workspaces.py: the same types). Anything else in it shows nothing, an image of another
// note too: the server deletes a note's images that its own blocks no longer show
const NOTE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]
const NOTE_IMAGE_PATH = /^note_(\d+)\/[0-9a-f]{64}\.(png|jpg|gif|webp|avif)$/
window.noteImagePath = (text) => {
    const match = NOTE_IMAGE_PATH.exec(text || "")
    return match && Number(match[1]) === global.state.noteEditor?.channelId ? text : null
}

// Block fields that place it in the page: a change to one of them lays the rows out again
const LAYOUT_FIELDS = ["position", "row_group", "column_index", "sub_position"]

// A position key past its limit (thousands of inserts in one gap): the keys are given again
const tooLong = (key) => typeof key === "string" && key.length > MAX_KEY_LENGTH

/**
 * The first block of an empty note: the same uuid for everyone (from the channel id), so two
 * people opening a new note at once make one block, not two.
 */
const firstBlockId = (channel) => "00000000-0000-4000-8000-" + Number(channel).toString(16).padStart(12, "0")

/**
 * The note on screen. Its blocks (`this.blocks`, plain objects the templates render) are
 * the CRDT's state (noteSync.mjs): every edit goes through saveBlock / deleteBlock, which
 * turn the change into operations; operations from others (and undo/redo) come back
 * through _onSyncChange, which updates `this.blocks` and only the DOM that changed.
 */
class Editor {
    constructor(sync) {
        global.state.noteEditor?.destroy?.()   // the previous note's editor
        this.sync = sync
        this.channelId = sync.channel
        this.blocks = global.notes[this.channelId].blocks
        global.state.noteSaveFailed = sync.failed
        this._offChange = sync.onChange((changed, info) => this._onSyncChange(changed, info))
        this._offBefore = sync.onBeforeRemote(() => this._captureCaret())
        if (Object.keys(this.blocks).length === 0 && !this.readOnly) {
            this.createBlock({uuid: firstBlockId(this.channelId)}, false)
        }
        this.draggedBlockId = null
        global.state.noteBlockMenu = null   // a menu left open in the previous note

        // Going anywhere else (a channel, the DMs, another server…) replaces #content: the
        // note's room is left then. Only once its page was shown, not while it is swapped in.
        this._shown = false
        this._contentObserver = new MutationObserver(() => this._checkOnScreen())
        const content = document.getElementById('content')
        if (content) this._contentObserver.observe(content, {childList: true})

        this.reorderDOM()

        // After DOM is rendered, re-mount interactive blocks (database, synapse, etc.)
        requestAnimationFrame(() => {
            if (this._destroyed) return   // left before its first frame
            this._mountInteractiveBlocks()
            this.presence = new NotePresence(this)
        })
    }

    /** Another note opens: stop following this one. */
    destroy() {
        this._destroyed = true
        clearTimeout(this._timeoutEnd)
        this._contentObserver?.disconnect()
        this._offChange?.()
        this._offBefore?.()
        this.presence?.destroy()
        this.sync.leave()
        global.state.noteFilePicker = null   // its page is gone (its Subscribe with it)
    }

    /** Its page left the screen: this tab no longer follows the note (nor shows in it to others). */
    _checkOnScreen() {
        if (document.getElementById('note-editor')) {
            this._shown = true
        } else if (this._shown) {
            this.destroy()
            if (global.state.noteEditor === this) global.state.noteEditor = null
        }
    }

    _mountInteractiveBlocks() {
        for (const blockId in this.blocks) this._mountBlock(blockId)
        this.applyPermissions(false)
    }

    /** Mount a checklist, database, spreadsheet… into its freshly rendered block. */
    _mountBlock(blockId) {
        const block = this.blocks[blockId]
        if (!blockTypes[block?.type]?.template) return
        const blockEl = document.querySelector(`[data-block-id="${block.uuid}"] .content`)
        if (blockEl) this.convertBlock(blockEl, blockId)
    }

    /** The note can't be changed (edit-notes denied, timed out: access.mjs): the server refuses every write. */
    get readOnly() {
        return !window.canEditNotes(this.channelId)
    }

    /**
     * Show the note read-only (no block controls, nothing editable) or editable again.
     * Run after each render and when the user's rights change live (access.mjs);
     * `rerenderViews` repaints mounted databases/spreadsheets for their own read-only mode.
     */
    applyPermissions(rerenderViews = true) {
        const editor = document.getElementById('note-editor')
        if (!editor) return
        const readOnly = this.readOnly
        editor.classList.toggle('read-only', readOnly)
        this.presence?.refresh()   // who may write changed too: the header shows only them
        // A timeout ends by itself: the note is editable again then
        clearTimeout(this._timeoutEnd)
        const server = global.state.currentServer?.id
        const until = server && window.isTimedOut?.(server)
            ? new Date(global.user.server_timeouts[String(server)]).getTime() - Date.now() : 0
        if (until > 0) this._timeoutEnd = setTimeout(() => this.applyPermissions(), Math.min(until + 500, 2 ** 31 - 1))
        for (const el of editor.querySelectorAll('.block > .content')) {
            const block = this.blocks[el.parentElement.dataset.blockId]
            if (!block) continue
            if (!blockTypes[block.type]?.template) el.contentEditable = readOnly ? 'false' : 'true'
            // Checklists, transport, synapse… have no read-only mode of their own. A file stays
            // open to readers (its image, its link to the drive); note-file-root.html hides the picking
            else if (!['database', 'spreadsheet', 'file'].includes(block.type)) el.inert = readOnly
            // An empty file / image block shows its "add" button to editors only: drawn again
            if (rerenderViews && this._isEmptyMedia(block)) this._mountBlock(block.uuid)
        }
        if (!rerenderViews) return
        const channelId = this.channelId
        for (const view of Object.values(global.state.databaseViews || {})) {
            if (Number(view.channelId) === channelId) view.render()
        }
        for (const view of Object.values(global.state.spreadsheetViews || {})) {
            if (Number(view.channelId) !== channelId || view.convId || !view._viewEl) continue
            if (readOnly) view.cancelEdit()
            view._viewEl.innerHTML = view.render()
        }
    }

    getRenderableRows() {
        // Positions are fractional keys (static/crdt/keys.mjs): plain string order
        const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
        const compareBlocks = (a, b) =>
            cmp(a.sub_position ?? "", b.sub_position ?? "") || cmp(a.position ?? "", b.position ?? "")
            || String(a.uuid).localeCompare(String(b.uuid))

        const rowsById = new Map()

        for (const block of Object.values(this.blocks)) {
            const rowId = block.row_group || block.uuid
            const rowPosition = block.position ?? ""
            const colIndex = Number(block.column_index) || 0

            let row = rowsById.get(rowId)
            if (!row) {
                row = {id: rowId, position: rowPosition, columns: new Map()}
                rowsById.set(rowId, row)
            } else if (rowPosition < row.position) {
                row.position = rowPosition
            }

            const colBlocks = row.columns.get(colIndex) || []
            colBlocks.push(block)
            row.columns.set(colIndex, colBlocks)
        }

        return Array.from(rowsById.values())
            .sort((a, b) => cmp(a.position, b.position) || String(a.id).localeCompare(String(b.id)))
            .map((row) => ({
                id: row.id,
                position: row.position,
                columnsArray: Array.from(row.columns.entries())
                    .sort(([colA], [colB]) => colA - colB)
                    .map(([, blocks]) => blocks.sort(compareBlocks))
            }))
    }

    createBlock({type = "text", content = "", afterBlockId = null, uuid = null, indent = 0}, addDom = true) {
        if (this.readOnly) return null
        const newBlockId = uuid || crypto.randomUUID()
        let slot
        if (afterBlockId !== null && this.blocks[afterBlockId]) {
            slot = this._slotAfter(afterBlockId)
        } else {
            // At the end
            const rows = this.getRenderableRows()
            slot = {position: keyBetween(rows[rows.length - 1]?.position || null, null), rowGroup: null, colIndex: 0, subPosition: keyBetween(null, null)}
        }

        this.blocks[newBlockId] = {
            "uuid": newBlockId,
            "type": type,
            "content": content,
            "position": slot.position,
            "row_group": slot.rowGroup || newBlockId,
            "column_index": slot.colIndex,
            "sub_position": slot.subPosition,
            "indent": isList({type}) ? indent : 0
        };

        if (addDom){
            this.reorderDOM()
        }
        this.saveBlock(newBlockId)
        return newBlockId
    }

    /**
     * Where a block inserted right below `blockId` goes. A block alone in its row gets a
     * new full-width row before the next one; a block stacked in a column (several blocks
     * in a row group) gets the next sub_position in that same column.
     */
    _slotAfter(blockId) {
        const block = this.blocks[blockId]
        const rows = this.getRenderableRows()
        const rowId = block.row_group || block.uuid
        const rowIndex = rows.findIndex(r => r.id === rowId)
        const row = rows[rowIndex]
        const column = row?.columnsArray.find(col => col.includes(block)) || [block]

        if (row && (row.columnsArray.length > 1 || column.length > 1)) {
            // Equal sub_positions order by position, then uuid: give the column distinct keys first
            if (new Set(column.map(b => b.sub_position)).size !== column.length) {
                let key = null
                for (const b of column) {
                    key = keyBetween(key, null)
                    b.sub_position = key
                    this.saveBlock(b.uuid)
                }
            }
            const next = column[column.indexOf(block) + 1]
            return {position: block.position, rowGroup: rowId, colIndex: block.column_index || 0,
                    subPosition: keyBetween(block.sub_position || null, next?.sub_position || null)}
        }

        const next = rows[rowIndex + 1]
        return {position: keyBetween(row?.position || block.position || null, next?.position || null),
                rowGroup: null, colIndex: 0, subPosition: keyBetween(null, null)}
    }

    /**
     * Caret at the end of a block's text. Re-renders are synchronous, so focus right away
     * (keys typed just after Enter must land in the new block); else once the DOM holds it.
     */
    focusBlock(blockId) {
        const focus = () => {
            const el = document.querySelector(`[data-block-id="${blockId}"] .content.editable-block`)
            if (!el || el.isContentEditable === false) return false
            el.focus()
            this.putCursorToEnd(el)
            return true
        }
        if (!focus()) setTimeout(focus, 0)
    }

    /** Gutter "+": an empty text block right below, ready to type in. */
    addBlockAfter(blockId) {
        const newId = this.createBlock({afterBlockId: blockId})
        if (newId) this.focusBlock(newId)
    }

    /** A click on the empty space under the note: back to the last empty line, or a new one. */
    focusEnd() {
        if (this.readOnly) return
        const rows = this.getRenderableRows()
        const lastRow = rows[rows.length - 1]
        const lastCol = lastRow?.columnsArray[lastRow.columnsArray.length - 1]
        const last = lastCol?.[lastCol.length - 1]
        if (last && last.type === "text" && !last.content && lastRow.columnsArray.length === 1) {
            this.focusBlock(last.uuid)
            return
        }
        const newId = this.createBlock({})
        if (newId) this.focusBlock(newId)
    }

    /** The translated placeholder of an empty block of this type ("" for interactive blocks). */
    placeholderFor(type) {
        const key = blockTypes[type]?.placeholder
        return key ? _t(key) : ""
    }

    // ── Page title (the channel's name) ──────────────────────────────────────

    onTitleKeyDown(event) {
        if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault()
            if (event.key === "Escape") event.currentTarget.innerText = global.notes[global.state.activeChan.id]?.name ?? ""
            event.currentTarget.blur()
            if (event.key === "Enter") {
                const first = this.getRenderableRows()[0]?.columnsArray[0]?.[0]
                if (first) this.focusBlock(first.uuid)
            }
        }
    }

    onTitleBlur(event) {
        const id = Number(global.state.activeChan.id)
        const note = global.notes[id]
        const name = event.currentTarget.innerText.replace(/\s+/g, " ").trim().slice(0, 255)
        if (!note || !name) {
            event.currentTarget.innerText = note?.name ?? ""
            return
        }
        if (name === note.name) return
        event.currentTarget.innerText = name

        // Same as renaming it in the channel settings (main.mjs Save)
        const serv = global.state.currentServer
        const chan = serv?.dirs?.notes?.find(c => Number(c.id) === id)
        if (chan) {
            chan.name = name
            orderServDirs(serv)
        }
        setElement("global.notes[" + id + "].name", name)
        xhr("edit_server_channel?server_id=" + serv.id + "&value=" + encodeURIComponent(name) + "&field=name&targetId=" + id + "&channel_type=note", undefined, "POST")
    }

    // ── Block menu (click on the ⋮⋮ handle) ──────────────────────────────────

    openBlockMenu(blockId, event) {
        event.stopPropagation()
        this.sync.undo.stopCapturing()   // what the menu does is an undo step of its own
        const block = this.blocks[blockId]
        if (!block || this.readOnly) return
        // A second click on the same handle closes it
        if (global.state.noteBlockMenu?.blockId === blockId) {
            this.closeBlockMenu()
            return
        }

        const textual = TEXT_KINDS.includes(block.type)
        const items = this._slashMenuItems()
        const anchor = event.currentTarget.getBoundingClientRect()
        const menu = {
            blockId,
            x: anchor.left,
            y: anchor.bottom + 4,
            turnInto: textual ? TEXT_KINDS.map(type => {
                const item = items.find(i => i.type === type)
                return {type, glyph: item.glyph, label: item.label, checked: block.type === type}
            }) : [],
            // Databases, spreadsheets… keep their content in their own tables
            canDuplicate: textual || ["checklist", "showcase", "file", "image"].includes(block.type),
            canReplaceFile: block.type === "file",
            canReplaceImage: block.type === "image",
        }
        setElement("global.state.noteBlockMenu", menu)

        // Keep it inside the viewport: its size is only known once painted (drive.mjs does the same)
        const rect = document.querySelector(".note-block-menu")?.getBoundingClientRect()
        if (!rect) return
        const y = rect.bottom > window.innerHeight ? Math.max(8, anchor.top - rect.height - 4) : menu.y
        if (y !== menu.y) setElement("global.state.noteBlockMenu", {...menu, y})
    }

    closeBlockMenu() {
        if (!global.state.noteBlockMenu) return
        setElement("global.state.noteBlockMenu", null)
    }

    turnBlockInto(blockId, type) {
        this.closeBlockMenu()
        const block = this.blocks[blockId]
        if (!block || block.type === type || !TEXT_KINDS.includes(type)) return
        block.type = type
        if (!isList(block)) block.indent = 0   // only list items have levels
        this.saveBlock(blockId)
        this.reorderDOM()
        this.focusBlock(blockId)
    }

    duplicateBlock(blockId) {
        this.closeBlockMenu()
        const block = this.blocks[blockId]
        if (!block) return
        const newId = this.createBlock({type: block.type, content: block.content, afterBlockId: blockId, indent: block.indent})
        if (newId && TEXT_KINDS.includes(block.type)) this.focusBlock(newId)
    }

    // ── File blocks: a Drive file shown in the page (note-file-root.html) ─────

    /**
     * The dialog that picks a file block's file (note-file-picker.html): this server's drives,
     * their folders and files, and an upload into the folder shown.
     * global.state.noteFilePicker = {blockId, drive, folder, path, folders, files, loading, uploading}.
     */
    openFilePicker(blockId) {
        if (this.readOnly || this.blocks[blockId]?.type !== "file") return
        this.closeBlockMenu()
        global.state.noteFilePicker = {blockId, drive: null, folder: null, path: [], folders: [], files: [],
                                       loading: false, uploading: false}
        const drives = global.state.currentServer?.dirs?.drives || []
        if (drives.length === 1) this.browseFilePicker(drives[0].id, null)   // straight into the only one
        else this._paintFilePicker()
    }

    /** Show a folder of a drive in the dialog (`driveId` null: the list of drives). */
    browseFilePicker(driveId, folderId) {
        const state = global.state.noteFilePicker
        if (!state) return
        const request = state.request = {}   // only the last folder asked for is shown
        if (driveId === null) {
            Object.assign(state, {drive: null, folder: null, path: [], loading: false})
            return this._paintFilePicker()
        }
        Object.assign(state, {drive: driveId, loading: true})
        this._paintFilePicker()
        const editor = this
        xhr(`list_drive?drive_id=${driveId}` + (folderId ? `&folder_id=${folderId}` : ''), function () {
            if (global.state.noteFilePicker !== state || state.request !== request) return
            const data = this.status === 200 ? JSON.parse(this.responseText) : {folders: [], files: [], path: []}
            Object.assign(state, {folder: data.folder_id ?? null, path: data.path || [], folders: data.folders || [],
                                  files: data.files || [], loading: false})
            editor._paintFilePicker()
        })
    }

    /** What note-file-picker.html shows. */
    filePickerView() {
        const state = global.state.noteFilePicker
        const drives = global.state.currentServer?.dirs?.drives || []
        const crumbs = [{drive: null, id: null, name: _t("Drives")}]
        if (state.drive !== null) {
            const drive = drives.find(d => Number(d.id) === Number(state.drive))
            crumbs.push({drive: state.drive, id: null, name: drive?.name ?? _t("Drive")},
                        ...state.path.map(p => ({drive: state.drive, id: p.id, name: p.name})))
        }
        return {
            crumbs, loading: state.loading, drive: state.drive, folders: state.folders, files: state.files,
            drives: state.drive === null ? drives : null,
            // Adding a file to a drive is a write there, like any upload (driveManager._require_drive_write)
            canUpload: state.drive !== null && !state.loading && window.checkChannelRight(state.drive, "drive", "send-messages"),
            uploading: state.uploading,
        }
    }

    _paintFilePicker() {
        updateElement("global.state.noteFilePicker")
    }

    closeFilePicker() {
        if (!global.state.noteFilePicker) return
        setElement("global.state.noteFilePicker", null)
    }

    /** The file of the block the dialog was opened for: its text becomes the file's link. */
    chooseFile(driveId, fileId) {
        const block = this.blocks[global.state.noteFilePicker?.blockId]
        this.closeFilePicker()
        if (!block || block.type !== "file" || this.readOnly) return
        block.content = `<#drive:${Number(driveId)}/f:${Number(fileId)}>`
        this.sync.undo.stopCapturing()   // an undo step of its own
        this.saveBlock(block.uuid)
        this.sync.undo.stopCapturing()
        this._mountBlock(block.uuid)
    }

    /** "Upload here": the file goes into the folder shown, then into the block. */
    async uploadFile(event) {
        const state = global.state.noteFilePicker
        const file = event.target.files?.[0]
        if (!state || !file || state.drive === null) return
        const driveId = state.drive
        state.uploading = true
        this._paintFilePicker()
        try {
            const {file_id} = await uploadSingleDriveFile(file, driveId, state.folder)
            if (!file_id) throw new Error("no file id in the answer")
            if (global.state.noteFilePicker === state) this.chooseFile(driveId, file_id)
        } catch (e) {
            console.warn("Upload failed for", file.name, e)
            if (e.message !== "quota") window.uiAlert?.(_t("Le fichier n'a pas pu être envoyé."))
            if (global.state.noteFilePicker === state) {
                state.uploading = false
                this._paintFilePicker()
            }
        }
    }

    // ── Image blocks: images stored with the note (note-image-root.html) ──────

    /** An image of this tab on its way to the server: its block says so. */
    isUploading(blockId) {
        return Boolean(this._uploads?.has(blockId))
    }

    /** A file block without its file, an image block without its image (none on its way). */
    _isEmptyMedia(block) {
        return (block.type === "file" && !fileLinkIds(block.content))
            || (block.type === "image" && !noteImagePath(block.content) && !this.isUploading(block.uuid))
    }

    /** "/image", the empty block's button, "Replace the image": the image comes from a file. */
    pickImage(blockId) {
        if (this.readOnly || this.blocks[blockId]?.type !== "image") return
        this._imageBlock = blockId
        const input = document.getElementById("note-image-input")
        if (!input) return
        input.value = ""
        input.click()
    }

    onImagePicked(event) {
        const file = event.target.files?.[0]
        const blockId = this._imageBlock
        this._imageBlock = null
        if (!file || this.blocks[blockId]?.type !== "image") return
        if (!NOTE_IMAGE_TYPES.includes(file.type)) return window.uiAlert?.(_t("L'image n'a pas pu être envoyée."))
        this._uploadImage(blockId, file)
    }

    /**
     * An image pasted into a block becomes an image block. Text comes first: Word or a
     * spreadsheet put a picture of what was copied next to its text, and that is pasted as text.
     */
    onPaste(blockId, event) {
        const data = event.clipboardData
        if (this.readOnly || !data || data.getData("text/plain")) return
        // Tables and checklists: pasted into their cell / item, as they handle it
        if (["database", "spreadsheet", "checklist"].includes(this.blocks[blockId]?.type)) return
        const images = [...data.files].filter(file => NOTE_IMAGE_TYPES.includes(file.type))
        if (!images.length) return
        event.preventDefault()
        this.insertImages(blockId, images)
    }

    /**
     * Images pasted or dropped on a block: one image block each, below it (the block itself
     * when it is an empty paragraph or an empty image block), uploaded with the note. One undo step.
     */
    insertImages(blockId, files) {
        const block = this.blocks[blockId]
        if (this.readOnly || !block) return
        this._hideSlashMenu()
        const emptyImage = block.type === "image" && !noteImagePath(block.content) && !this.isUploading(blockId)
        if (emptyImage) {
            this._uploadImage(blockId, files[0])
            files = files.slice(1)
            if (!files.length) return
        }
        this.sync.undo.stopCapturing()
        const ids = this.sync.undo.transact(() => {
            const ids = []
            let after = blockId
            for (const [i, file] of files.entries()) {
                if (i === 0 && block.type === "text" && !block.content) {
                    block.type = "image"
                    this.saveBlock(blockId)
                    ids.push(blockId)
                } else {
                    ids.push(this.createBlock({type: "image", afterBlockId: after}, false))
                }
                after = ids[ids.length - 1]
            }
            return ids
        })
        this.sync.undo.stopCapturing()
        this.reorderDOM()
        ids.forEach((id, i) => id && this._uploadImage(id, files[i]))
    }

    /** Send an image, then make it the block's: its text becomes the stored image's path. */
    async _uploadImage(blockId, file) {
        (this._uploads ??= new Set()).add(blockId)
        this._mountBlock(blockId)   // "Uploading…"
        let path = null
        try {
            path = noteImagePath((await postFileAsDataUrl("upload_note_image?channel=" + this.channelId, file)).path)
            if (!path) throw new Error("no image path in the answer")
        } catch (e) {
            console.warn("Image upload failed for", file.name, e)
            // A full storage has its own message (handleQuotaError)
            if (e.message !== "quota") window.uiAlert?.(_t("L'image n'a pas pu être envoyée."))
        }
        this._uploads.delete(blockId)
        const block = this.blocks[blockId]
        if (path && block?.type === "image" && !this.readOnly) {
            block.content = path
            this.sync.undo.stopCapturing()   // an undo step of its own
            this.saveBlock(blockId)
            this.sync.undo.stopCapturing()
        }
        this._mountBlock(blockId)
    }

    moveBlock(blockId, newPosition, newRowGroup = null, newColIndex = null, newSubPosition = null) {
        const block = this.blocks[blockId]
        if (!block) return

        block.position = newPosition
        if (newRowGroup !== null) block.row_group = newRowGroup
        if (newColIndex !== null) block.column_index = newColIndex
        if (newSubPosition !== null) block.sub_position = newSubPosition

        this.reorderDOM()
        this.saveBlock(block.uuid)
    }

    reorderDOM() {
        updateElement('global.notes['+this.channelId+'].blocks')

        // updateElement re-renders rows and replaces interactive block DOM.
        requestAnimationFrame(() => this._mountInteractiveBlocks())
    }

    _forgetViews(blockId) {
        if (global.state.spreadsheetViews?.[blockId]) {
            delete global.state.spreadsheetViews[blockId]
            if (global.state.activeSpreadsheetFormulaEditor?.blockUuid === blockId) {
                global.state.activeSpreadsheetFormulaEditor = null
            }
            if (global.state.spreadsheetSnapshots) {
                delete global.state.spreadsheetSnapshots[blockId]
            }
        }
        if (global.state.databaseViews?.[blockId]) {
            delete global.state.databaseViews[blockId]
        }
    }

    deleteBlock(blockId) {
        if (this.readOnly) return
        this._forgetViews(blockId)
        delete this.blocks[blockId]
        this.reorderDOM()
        this.sync.deleteBlock(blockId)
    }

    // Drag and drop handlers
    onDragStart(blockId, event) {
        this.draggedBlockId = blockId
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", blockId)

        // Add dragging class
        const blockElement = event.currentTarget.closest('.block')
        blockElement.classList.add('dragging')
    }

    onDragEnd(blockId, event) {
        this.draggedBlockId = null
        this.cleanupDragState()
    }

    cleanupDragState() {
        // Remove all drag classes and drop indicators
        document.querySelectorAll('.block').forEach(block => {
            block.classList.remove('dragging')
        })
        document.querySelectorAll('.drop-indicator').forEach(el => el.remove())
    }

    onDragOver(blockId, event) {
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"

        if (this.draggedBlockId === null || this.draggedBlockId === blockId) return

        // Remove all existing drop indicators
        document.querySelectorAll('.drop-indicator').forEach(el => el.remove())

        const blockElement = event.currentTarget.closest('.block')
        const rect = blockElement.getBoundingClientRect()
        
        // Calculate relative mouse position (0.0 to 1.0)
        const relX = (event.clientX - rect.left) / rect.width
        const relY = (event.clientY - rect.top) / rect.height
        
        // Determine drop zone (left, right, top, bottom)
        const margin = 0.15 // 15% edge margin for side drops
        
        let dropType = 'horizontal'
        let isAfter = relY > 0.5
        
        if (relX < margin) {
            dropType = 'vertical'
            isAfter = false // Left
        } else if (relX > 1 - margin) {
            dropType = 'vertical'
            isAfter = true // Right
        }

        // Create and position the drop indicator
        const indicator = document.createElement('div')
        indicator.className = 'drop-indicator ' + dropType

        if (dropType === 'horizontal') {
            if (isAfter) {
                if (blockElement.nextSibling) {
                    blockElement.parentNode.insertBefore(indicator, blockElement.nextSibling)
                } else {
                    blockElement.parentNode.appendChild(indicator)
                }
            } else {
                blockElement.parentNode.insertBefore(indicator, blockElement)
            }
        } else {
            // Horizontal drop (side by side)
            indicator.style.left = isAfter ? 'auto' : '0'
            indicator.style.right = isAfter ? '0' : 'auto'
            blockElement.appendChild(indicator)
        }
    }

    onDrop(blockId, event) {
        event.preventDefault()

        // Images dropped from the computer: image blocks below this one. Not one dragged from this
        // page (an image of the note, of a message…): the browser gives it as a file too
        const images = [...(event.dataTransfer?.files || [])].filter(file => NOTE_IMAGE_TYPES.includes(file.type))
        if (this.draggedBlockId === null && images.length && !window._dragFromPage) return this.insertImages(blockId, images)

        if (this.draggedBlockId === null || this.draggedBlockId === blockId) return

        const draggedBlock = this.blocks[this.draggedBlockId]
        const targetBlock = this.blocks[blockId]

        if (!draggedBlock || !targetBlock) return

        const blockElement = event.currentTarget.closest('.block')
        const rect = blockElement.getBoundingClientRect()

        const relX = (event.clientX - rect.left) / rect.width
        const relY = (event.clientY - rect.top) / rect.height

        const margin = 0.15

        let isHorizontalDrop = false
        let isAfter = relY > 0.5

        if (relX < margin) {
            isHorizontalDrop = true
            isAfter = false
        } else if (relX > 1 - margin) {
            isHorizontalDrop = true
            isAfter = true
        }

        const rows = this.getRenderableRows()
        const targetRowGroup = targetBlock.row_group || targetBlock.uuid
        const targetRow = rows.find(r => r.id === targetRowGroup)

        // One drop is one undo step
        this.sync.undo.transact(() => {
            if (isHorizontalDrop) {
                // Create or join a row: next to the target, then columns numbered 0, 1, 2…
                const targetCol = targetBlock.column_index || 0
                draggedBlock.position = targetBlock.position
                draggedBlock.row_group = targetRowGroup
                draggedBlock.column_index = isAfter ? targetCol + 0.5 : targetCol - 0.5
                draggedBlock.sub_position = keyBetween(null, null)
                targetBlock.row_group = targetRowGroup

                const members = Object.values(this.blocks).filter(b => (b.row_group || b.uuid) === targetRowGroup)
                const columns = [...new Set(members.map(b => b.column_index || 0))].sort((a, b) => a - b)
                for (const b of members) b.column_index = columns.indexOf(b.column_index || 0)
                for (const b of members) this.saveBlock(b.uuid)
            } else if (targetRow && targetRow.columnsArray.length > 1) {
                // Within the target's column, above or below it
                const column = targetRow.columnsArray.find(col => col.includes(targetBlock)) || [targetBlock]
                const others = column.filter(b => b !== draggedBlock)
                const i = others.indexOf(targetBlock)
                const before = isAfter ? targetBlock : others[i - 1]
                const after = isAfter ? others[i + 1] : targetBlock
                this.moveBlock(this.draggedBlockId, targetBlock.position, targetRowGroup, targetBlock.column_index || 0,
                    keyBetween(before?.sub_position || null, after?.sub_position || null))
            } else {
                // A full-width row of its own, above or below the target's row
                const i = rows.indexOf(targetRow)
                const before = isAfter ? targetRow : rows[i - 1]
                const after = isAfter ? rows[i + 1] : targetRow
                this.moveBlock(this.draggedBlockId, keyBetween(before?.position || null, after?.position || null),
                    this.draggedBlockId, 0, keyBetween(null, null))
            }
        })
        this.reorderDOM()
        this.cleanupDragState()
    }

    onInput(blockId, event) {
        // An input method is composing a character: wait for it (compositionend)
        if (event.isComposing) return
        const block = this.blocks[blockId];
        // Must run before MDToPreview re-renders the DOM (needs current selection)
        if (typeof window.mentionNoteOnInput === 'function') window.mentionNoteOnInput(blockId, event)

        if (block.type === "text") {
            const text = event.currentTarget.innerText
            if (text.startsWith('/')) {
                this._showSlashMenu(blockId, event.currentTarget, text.slice(1))
            } else if (/^#{1,6}$/.test(text)) {
                // A run of only '#' → offer the heading levels (block selector).
                this._showHeadingMenu(blockId, event.currentTarget, text)
            } else {
                this._hideSlashMenu()
            }

            const parser = new InitiatorParser(text)
            const parsedInitiator = parser.parse()
            // A list starts when its marker's space is typed, there (like Notion): a markdown
            // list already in a paragraph ("- a\n- b", older notes) stays as it is when edited
            if (isList({type: parsedInitiator.initiator?.type}) && !(event.data === " "
                && this.saveCursorPosition(event.currentTarget) === parsedInitiator.initiator.initiator.length)) {
                parsedInitiator.initiator = null
            }
            if (parsedInitiator.initiator) {
                // The block is converted: the "/" menu shown above no longer applies
                this._hideSlashMenu()
                block.type = parsedInitiator.initiator.type
                block.content = parsedInitiator.content
                if (blockTypes[block.type].template) {
                    this.convertBlock(event.currentTarget, blockId, "interactiveElement", true)
                    return // block is now interactive, don't touch its DOM further
                }
                if (blockTypes[block.type].placeholder) {
                    event.currentTarget.setAttribute("data-placeholder", this.placeholderFor(block.type))
                }
                event.currentTarget.classList.add("note-"+block.type)
                event.currentTarget.innerText = block.content
                this.putCursorToEnd(event.currentTarget)
            }else{
                const cursorPosition = this.saveCursorPosition(event.currentTarget);
                block.content = blockToRawContent(event.currentTarget)
                event.currentTarget.innerHTML = MDToPreview(block.content)
                this.restoreCursorPosition(event.currentTarget, cursorPosition);
            }
        }else{
            const cursorPosition = this.saveCursorPosition(event.currentTarget);
            block.content = blockToRawContent(event.currentTarget)
            event.currentTarget.innerHTML = MDToPreview(block.content)
            this.restoreCursorPosition(event.currentTarget, cursorPosition);
        }

        if (block.content === "\n" || block.content.trim() === "") {
            block.content = ""
            event.currentTarget.innerText = ""
        }
        // Every keystroke is sent (noteSync batches them): others see it as it is typed
        this.saveBlock(blockId)
        this.presence?.refresh()
    }

    convertBlock(target, blockId, newType = "interactiveElement", persistTypeChange = false) {
        const block = this.blocks[blockId]
        if(newType === "interactiveElement"){
            target.oninput = null
            target.onkeydown = null
            target.onblur = null
            target.onfocus = null
            target.removeAttribute("oninput")
            target.removeAttribute("onkeydown")
            target.removeAttribute("onblur")
            target.removeAttribute("onfocus")
            target.removeAttribute("data-placeholder")
            target.contentEditable = "false"
            target.setAttribute("contenteditable", "false")

            target.innerHTML = blockTypes[block.type].template(block)
            const mount = () => {
                if (block.type === "database") {
                    const containerEl = target.querySelector('.note-database')
                    if (containerEl) mountDatabase(block.uuid, this.channelId, containerEl)
                } else if (block.type === "spreadsheet") {
                    const containerEl = target.querySelector('.note-spreadsheet')
                    if (containerEl) mountSpreadsheet(block.uuid, this.channelId, containerEl)
                } else if (block.type === "checklist") {
                    const containerEl = target.querySelector('.note-checklist')
                    if (containerEl) mountChecklist(block.uuid, containerEl)
                } else if (block.type === "transport") {
                    const containerEl = target.querySelector('.note-transport')
                    if (containerEl) mountTransportBlock(block.uuid, containerEl)
                }
            }

            if (persistTypeChange) {
                this.saveBlock(blockId)
                // A file block just made (the "/" menu, "/file"): pick its file right away
                if (block.type === "file" && !fileLinkIds(block.content)) this.openFilePicker(blockId)
                // A database / spreadsheet loads its own tables: the server creates them before
                // the block mounts (and before others receive the type change)
                if (block.type === "database" || block.type === "spreadsheet") {
                    xhr("note_ensure_block?channel=" + this.channelId + "&uuid=" + block.uuid + "&type=" + block.type,
                        () => { if (target.isConnected) mount() }, "POST", true)
                    return
                }
            }
            mount()
        }
    }

    onKeyDown(blockId, event) {
        if (typeof window.mentionNoteOnKeyDown === 'function' && window.mentionNoteOnKeyDown(blockId, event)) return
        if (this.handleUndoKeys(event)) return

        const block = this.blocks[blockId];

        const menu = global.state.slashMenu
        if (menu?.visible && menu.blockId === blockId) {
            if (event.key === 'ArrowDown') {
                event.preventDefault()
                this._setSlashSelection((menu.selectedIndex + 1) % menu.items.length)
                return
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault()
                this._setSlashSelection((menu.selectedIndex - 1 + menu.items.length) % menu.items.length)
                return
            }
            if (event.key === 'Enter') {
                event.preventDefault()
                const item = menu.items[menu.selectedIndex]
                if (item) this._selectSlashItem(item.type)
                return
            }
            if (event.key === 'Escape') {
                this._hideSlashMenu()
                return
            }
        }

        if (isList(block) && this._onListKeyDown(block, event)) return
        if (this._toWholeBlock(block, event)) return

        if (block.type === "text") {
            // The note keeps at least one block; the caret goes back to the line above
            if (event.key === "Backspace" && block.content === "" && Object.keys(this.blocks).length > 1) {
                event.preventDefault()
                const previous = this._previousTextBlockId(blockId)
                this.sync.undo.stopCapturing()
                this.deleteBlock(blockId)
                if (previous) this.focusBlock(previous)
            }
            return
        }

        // An empty heading, small text…: back to a paragraph
        if(event.key === "Backspace" && block.content === ""){
            block.content = blockTypes[block.type].initiator
            event.currentTarget.classList.remove("note-"+block.type)
            event.currentTarget.innerText = block.content

            this.putCursorToEnd(event.currentTarget)

            event.currentTarget.focus();

            block.type = "text"
            event.currentTarget.setAttribute("data-placeholder", this.placeholderFor(block.type))
            event.preventDefault();
            this.saveBlock(blockId)
        }else if(event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();

            // create a new block with the content after the cursor
            const cursorPosition = this.saveCursorPosition(event.currentTarget);
            const contentBeforeCursor = block.content.slice(0, cursorPosition);
            const contentAfterCursor = block.content.slice(cursorPosition);

            // The end of the line moves to a new block: one undo step
            const newId = this.sync.undo.transact(() => {
                block.content = contentBeforeCursor
                event.currentTarget.innerText = block.content
                this.saveBlock(blockId)
                // The next item of a list, at the same level; after anything else, a paragraph
                return this.createBlock({type: isList(block) ? block.type : "text", content: contentAfterCursor,
                                         afterBlockId: blockId, indent: block.indent})
            })
            if (newId) this.focusBlock(newId)
        }
    }

    /**
     * Keys of a list item: Tab / Shift+Tab change its level; Enter on an empty item goes one
     * level up, or out of the list at the first level; Backspace at its start makes it a
     * paragraph. True if handled.
     */
    _onListKeyDown(block, event) {
        const el = event.currentTarget
        if (event.key === "Tab") {
            event.preventDefault()
            this.indentBlock(block.uuid, event.shiftKey ? -1 : 1)
            return true
        }
        if (event.key === "Enter" && !event.shiftKey && block.content === "") {
            event.preventDefault()
            if ((block.indent || 0) > 0) this.indentBlock(block.uuid, -1)
            else this._leaveList(block, el)
            return true
        }
        if (event.key === "Backspace" && window.getSelection().isCollapsed && this.saveCursorPosition(el) === 0) {
            event.preventDefault()
            this._leaveList(block, el)
            return true
        }
        return false
    }

    /** A list item becomes a paragraph, its text and caret kept. An undo step of its own. */
    _leaveList(block, el) {
        const caret = this.saveCursorPosition(el)
        this.sync.undo.stopCapturing()
        block.type = "text"
        block.indent = 0
        el.classList.remove(...LIST_KINDS.map(type => "note-" + type))
        el.setAttribute("data-placeholder", this.placeholderFor("text"))
        this._paintIndent(block.uuid)
        this.saveBlock(block.uuid)
        this.sync.undo.stopCapturing()
        this.restoreCursorPosition(el, caret)
    }

    /**
     * One level deeper (Tab) or up (Shift+Tab), with the items under it (the deeper ones
     * right after it) moving along. Deeper only below an item of its level or the one above,
     * like a sub-list: at most one level more than the item before it.
     */
    indentBlock(blockId, delta) {
        const block = this.blocks[blockId]
        if (!isList(block) || this.readOnly) return
        const order = this.getRenderableRows().flatMap(row => row.columnsArray.flat())
        const at = order.indexOf(block)
        const previous = order[at - 1]
        const level = block.indent || 0
        const max = isList(previous) ? Math.min((previous.indent || 0) + 1, MAX_INDENT) : 0
        const shift = Math.max(0, Math.min(level + delta, max)) - level
        if (!shift) return
        const moving = [block]
        for (const next of order.slice(at + 1)) {
            if (!isList(next) || (next.indent || 0) <= level) break
            moving.push(next)
        }
        this.sync.undo.stopCapturing()
        this.sync.undo.transact(() => {
            for (const b of moving) {
                b.indent = Math.max(0, Math.min((b.indent || 0) + shift, MAX_INDENT))
                this.saveBlock(b.uuid)
                this._paintIndent(b.uuid)
            }
        })
        this.sync.undo.stopCapturing()
        this.presence?.refresh()
    }

    /** A block's level on its DOM (style.css indents it and numbers the lists from it). */
    _paintIndent(blockId) {
        const el = document.querySelector(`#note-editor .block[data-block-id="${blockId}"]`)
        if (el) el.dataset.indent = String(this.blocks[blockId]?.indent || 0)
    }

    // ── Whole blocks (images, files, tables…): selected, then deleted or left with the keys ──

    /** A block taken as a whole, without a caret (its template draws it: image, file, database…). */
    _isWhole(block) {
        return Boolean(block && blockTypes[block.type]?.template)
    }

    /** The block before (step -1) or after (+1) this one in reading order, or null. */
    _neighbourBlockId(blockId, step) {
        const ids = [...document.querySelectorAll('#note-editor .block[data-block-id]')].map(el => el.dataset.blockId)
        const at = ids.indexOf(blockId)
        return at < 0 ? null : ids[at + step] ?? null
    }

    /**
     * Select a whole block: it takes the keyboard focus, Backspace / Delete deletes it, Enter
     * adds a line below it (or opens a file block's file), the arrows go to its neighbours.
     */
    selectBlock(blockId) {
        if (this.readOnly || !this.blocks[blockId]) return
        const el = document.querySelector(`#note-editor .block[data-block-id="${blockId}"]`)
        if (!el) return
        this._hideSlashMenu()
        this.clearBlockSelection()
        this.selectedBlockId = blockId
        el.classList.add("selected")
        el.tabIndex = -1
        window.getSelection()?.removeAllRanges()
        el.focus({preventScroll: true})
        el.scrollIntoView({block: "nearest"})
    }

    clearBlockSelection() {
        const blockId = this.selectedBlockId
        if (!blockId) return
        this.selectedBlockId = null
        const el = document.querySelector(`#note-editor .block[data-block-id="${blockId}"]`)
        el?.classList.remove("selected")
        el?.removeAttribute("tabindex")
    }

    /** The caret goes to this block (its end, or its start), or it is selected if it is a whole one. */
    _enterBlock(blockId, atStart = false) {
        if (this._isWhole(this.blocks[blockId])) return this.selectBlock(blockId)
        this.clearBlockSelection()
        this.focusBlock(blockId)
        const el = document.querySelector(`#note-editor .block[data-block-id="${blockId}"] > .content.editable-block`)
        if (atStart && el && document.activeElement === el) this.restoreCursorPosition(el, 0)
    }

    /** Keys on a selected block (its own: not those typed in a cell, an item… inside it). */
    onBlockKeyDown(blockId, event) {
        if (event.target !== event.currentTarget || this.selectedBlockId !== blockId) return
        if (event.ctrlKey || event.metaKey || event.altKey) return   // Ctrl+Z: the document's listener
        const block = this.blocks[blockId]
        if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault()
            this.deleteSelectedBlock()
        } else if (event.key === "Enter") {
            event.preventDefault()
            if (block?.type === "file" && fileLinkIds(block.content)) return this.openFileBlock(blockId)
            this.clearBlockSelection()
            const newId = this.createBlock({afterBlockId: blockId})
            if (newId) this.focusBlock(newId)
        } else if (event.key === "Escape") {
            this.clearBlockSelection()
            event.currentTarget.blur()
        } else if (["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(event.key)) {
            event.preventDefault()
            const back = event.key === "ArrowUp" || event.key === "ArrowLeft"
            const next = this._neighbourBlockId(blockId, back ? -1 : 1)
            if (next) this._enterBlock(next, !back)
        }
    }

    /** Focus left the selected block (a click elsewhere or inside it, Tab…): no longer selected. */
    onBlockBlur(blockId, event) {
        if (this._quietFocus || event.target !== event.currentTarget) return   // moved by a live re-render
        if (this.selectedBlockId === blockId) this.clearBlockSelection()
    }

    /** Delete the selected block, an undo step of its own: the caret goes to the block above (or below). */
    deleteSelectedBlock() {
        const blockId = this.selectedBlockId
        if (!blockId || this.readOnly) return
        const above = this._neighbourBlockId(blockId, -1)
        const below = this._neighbourBlockId(blockId, 1)
        this.clearBlockSelection()
        this.sync.undo.stopCapturing()
        this.deleteBlock(blockId)
        this.sync.undo.stopCapturing()
        if (!Object.keys(this.blocks).length) {   // the note keeps at least one block
            const newId = this.createBlock({})
            if (newId) this.focusBlock(newId)
            return
        }
        const next = above ?? below
        if (next) this._enterBlock(next, !above)
    }

    /**
     * Keys that leave a text block for the whole block next to it, selected: Backspace at its
     * start (an empty paragraph goes), Delete at its end, the arrows on its first / last line.
     * True if handled.
     */
    _toWholeBlock(block, event) {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false
        const back = ["Backspace", "ArrowUp", "ArrowLeft"].includes(event.key)
        if (!back && !["Delete", "ArrowDown", "ArrowRight"].includes(event.key)) return false
        // An empty heading, small text…: Backspace makes it a paragraph first
        if (event.key === "Backspace" && block.type !== "text" && block.content === "") return false
        const neighbour = this._neighbourBlockId(block.uuid, back ? -1 : 1)
        if (!this._isWhole(this.blocks[neighbour])) return false
        const el = event.currentTarget
        const selection = window.getSelection()
        if (!selection.rangeCount || !selection.isCollapsed || !el.contains(selection.anchorNode)) return false
        const vertical = event.key === "ArrowUp" || event.key === "ArrowDown"
        if (vertical ? !this._caretOnEdgeLine(el, selection, back) : !this._caretAtEdge(el, selection, back)) return false
        event.preventDefault()
        if (event.key === "Backspace" && block.type === "text" && block.content === "") {
            this.sync.undo.stopCapturing()
            this.deleteBlock(block.uuid)
        }
        this.selectBlock(neighbour)
        return true
    }

    /** No text between the caret and the start (back) or the end of the block. */
    _caretAtEdge(el, selection, back) {
        const range = selection.getRangeAt(0)
        const rest = document.createRange()
        rest.selectNodeContents(el)
        if (back) rest.setEnd(range.startContainer, range.startOffset)
        else rest.setStart(range.endContainer, range.endOffset)
        return rest.toString().replace(/\n$/, "") === ""
    }

    /** The caret is on the block's first (back) or last line. */
    _caretOnEdgeLine(el, selection, back) {
        if (this._caretAtEdge(el, selection, back)) return true
        const range = selection.getRangeAt(0).cloneRange()
        range.collapse(true)
        const caret = range.getClientRects()[0]
        if (!caret) return true   // nothing laid out (an empty line)
        const box = el.getBoundingClientRect()
        return back ? caret.top - box.top < caret.height : box.bottom - caret.bottom < caret.height
    }

    /**
     * A click in an image or a file block (capture: before the image / the card opens the file)
     * selects the block. Their own controls (video, audio, the "add" buttons) still work;
     * readers open the file as before.
     */
    onMediaClick(event) {
        const media = event.target.closest?.('#note-editor [data-media-block]')
        if (!media || this.readOnly || event.target.closest('video, audio, button, input')) return
        event.preventDefault()
        event.stopPropagation()   // nor does it reach closeOutside: done here
        if (global.state.noteBlockMenu) this.closeBlockMenu()
        this.selectBlock(media.dataset.mediaBlock)
    }

    /** Double click on a file block, or Enter on it selected: its file, in its drive. */
    openFileBlock(blockId) {
        const ids = fileLinkIds(this.blocks[blockId]?.content)
        if (ids && !this.readOnly) window.openChannelMention(null, `drive:${ids[0]}/f:${ids[1]}`)
    }

    /** The closest text-like block above `blockId` in reading order, to move the caret to. */
    _previousTextBlockId(blockId) {
        const ids = [...document.querySelectorAll('#note-editor .block')].map(el => el.dataset.blockId)
        for (let i = ids.indexOf(blockId) - 1; i >= 0; i--) {
            if (TEXT_KINDS.includes(this.blocks[ids[i]]?.type)) return ids[i]
        }
        return null
    }

    onBlur(blockId, event) {
        if (this._quietFocus) return   // moved by a live re-render (_relayout): still being edited
        this.sync.undo.stopCapturing()
        if (typeof window.mentionNoteOnBlur === 'function') window.mentionNoteOnBlur()
        this._hideSlashMenu()
        // switching from editor preview to rendered view
        const block = this.blocks[blockId];
        if (!block) return   // deleted (Backspace on an empty block)
        // Spellcheck only while editing — turn it off in the rendered view.
        event.currentTarget.spellcheck = false
        event.currentTarget.innerHTML = MDToRender(block.content)
        this.saveBlock(blockId)
    }

    onFocus(blockId, event) {
        if (this._quietFocus) return   // focus given back by _relayout: the preview is already there
        this.sync.undo.stopCapturing()   // typing in another block: another undo step
        // switching from rendered view to editor preview
        const block = this.blocks[blockId];
        event.currentTarget.spellcheck = true
        event.currentTarget.innerHTML = MDToPreview(block.content)
    }

    putCursorToEnd(element) {
        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    saveCursorPosition(element) {
        const selection = window.getSelection();
        if (selection.rangeCount === 0) return null;

        const range = selection.getRangeAt(0);
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(element);
        preCaretRange.setEnd(range.endContainer, range.endOffset);
        const caretOffset = preCaretRange.toString().length;

        return caretOffset;
    }

    restoreCursorPosition(element, caretOffset) {
        if (caretOffset === null) return;

        const selection = window.getSelection();
        const range = document.createRange();
        range.setStart(element, 0);
        range.collapse(true);

        let currentOffset = 0;
        const nodeIterator = document.createNodeIterator(
            element,
            NodeFilter.SHOW_TEXT,
            null
        );

        let currentNode;
        while ((currentNode = nodeIterator.nextNode())) {
            const nodeLength = currentNode.textContent.length;
            if (currentOffset + nodeLength >= caretOffset) {
                range.setStart(currentNode, caretOffset - currentOffset);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                return;
            }
            currentOffset += nodeLength;
        }

        // If we couldn't find the exact position, put cursor at end
        this.putCursorToEnd(element);
    }

    /**
     * Blocks offered by the "/" menu. label/description/group are translation keys;
     * keywords (English names included) also match the typed query. glyph or icon
     * fills the tile; shortcut is the initiator that converts a block without the menu.
     */
    _slashMenuItems() {
        const basic = "Blocs de base", advanced = "Blocs avancés"
        return [
            { type: "text",        group: basic,    glyph: "Aa", label: "Texte",           description: "Un simple paragraphe", keywords: ["text", "paragraph"] },
            { type: "heading1",    group: basic,    glyph: "H1", label: "Titre 1",         description: "Grand titre de section", keywords: ["heading", "h1"], shortcut: "#" },
            { type: "heading2",    group: basic,    glyph: "H2", label: "Titre 2",         description: "Titre de section moyen", keywords: ["heading", "h2"], shortcut: "##" },
            { type: "heading3",    group: basic,    glyph: "H3", label: "Titre 3",         description: "Petit titre de section", keywords: ["heading", "h3"], shortcut: "###" },
            { type: "small",       group: basic,    glyph: "<small>Aa</small>", label: "Petit texte", description: "Texte discret, en plus petit", keywords: ["small"], shortcut: "-#" },
            { type: "bullet",      group: basic,    glyph: "•",  label: "Liste à puces",   description: "Une liste simple", keywords: ["bullet", "list", "ul"], shortcut: "-" },
            { type: "numbered",    group: basic,    glyph: "1.", label: "Liste numérotée", description: "Une liste ordonnée", keywords: ["numbered", "ordered", "list", "ol"], shortcut: "1." },
            { type: "checklist",   group: basic,    icon: "check",     label: "Liste de tâches", description: "Des tâches à cocher", keywords: ["checklist", "todo", "to-do"], shortcut: "/todo" },
            { type: "image",       group: basic,    icon: "image",     label: "Image",            description: "Importer ou coller une image", keywords: ["image", "picture", "photo", "upload", "paste"], shortcut: "/image" },
            { type: "file",        group: basic,    icon: "file",      label: "Fichier du Drive", description: "Un fichier ou une image d'un Drive, affiché dans la page", keywords: ["file", "drive", "image", "video", "pdf"], shortcut: "/file" },
            { type: "database",    group: advanced, icon: "list",      label: "Base de données", description: "Tableau ou galerie de fiches", keywords: ["database", "table", "db"], shortcut: "/database" },
            { type: "spreadsheet", group: advanced, icon: "grid",      label: "Tableur",         description: "Feuille de calcul avec formules", keywords: ["spreadsheet", "sheet"], shortcut: "/sheet" },
            { type: "showcase",    group: advanced, icon: "dashboard", label: "Indicateur",      description: "Mettre en avant une valeur ou une métrique", keywords: ["showcase", "metric"], shortcut: "/showcase" },
            { type: "transport",   group: advanced, icon: "latest",    label: "Transports",      description: "Prochains passages à un arrêt", keywords: ["transport"], shortcut: "/transport" },
            { type: "synapse",     group: advanced, icon: "puzzle",    label: "Synapse",         description: "Composant externe", keywords: ["synapse"], shortcut: "/synapse" },
        ]
    }

    /** Menu items with their index, and a group title before the first of each group. */
    _withIndexes(items, groups = true) {
        return items.map((item, i) => ({...item, index: i, groupStart: groups && item.group !== items[i - 1]?.group}))
    }

    /** Under the line, or above it when it would overflow the bottom of the window. */
    _menuPlacement(anchorEl) {
        const rect = anchorEl.getBoundingClientRect()
        const menuHeight = 360   // .slash-menu max-height + margin
        const above = rect.bottom + menuHeight > window.innerHeight && rect.top > menuHeight
        return {top: above ? rect.top - 4 : rect.bottom + 4, left: rect.left, above}
    }

    _showSlashMenu(blockId, anchorEl, query) {
        const all = this._slashMenuItems()
        const fold = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
        const q = fold(query)
        const filtered = query === ""
            ? all
            : all.filter(item =>
                fold(_t(item.label)).split(/\s+/).some(word => word.startsWith(q))
                || fold(_t(item.label)).startsWith(q)
                || (item.keywords || []).some(k => k.startsWith(q)))

        if (filtered.length === 0) { this._hideSlashMenu(); return }

        const prev = global.state.slashMenu
        const selectedIndex = prev?.visible ? Math.min(prev.selectedIndex, filtered.length - 1) : 0

        setElement('global.state.slashMenu', {
            visible: true,
            blockId,
            query,
            selectedIndex,
            // Group titles only on the full list: a filtered list is short
            items: this._withIndexes(filtered, query === ""),
            ...this._menuPlacement(anchorEl),
        })
    }

    _showHeadingMenu(blockId, anchorEl, hashes) {
        const items = this._slashMenuItems().filter(item =>
            item.type === "heading1" || item.type === "heading2" || item.type === "heading3")

        // Preselect the level matching how many '#' were typed (# → H1, ## → H2…)
        const selectedIndex = Math.min(hashes.length, items.length) - 1

        setElement('global.state.slashMenu', {
            visible: true,
            blockId,
            query: hashes,
            selectedIndex,
            items: this._withIndexes(items, false),
            ...this._menuPlacement(anchorEl),
        })
    }

    /**
     * Move the highlight without repainting the menu: a repaint would reset its
     * scroll and jump away from the item under the pointer.
     */
    _setSlashSelection(index, scroll = true) {
        const menu = global.state.slashMenu
        if (!menu?.visible || index === menu.selectedIndex) return
        menu.selectedIndex = index
        document.querySelectorAll('.slash-menu-item').forEach((el, i) => el.classList.toggle('selected', i === index))
        if (scroll) document.querySelectorAll('.slash-menu-item')[index]?.scrollIntoView({block: 'nearest'})
    }

    _hoverSlashItem(index) {
        this._setSlashSelection(index, false)
    }

    _hideSlashMenu() {
        setElement('global.state.slashMenu', { visible: false, items: [] })
    }

    _selectSlashItem(type) {
        const blockId = global.state.slashMenu?.blockId
        const block = this.blocks[blockId]
        const el = document.querySelector(`[data-block-id="${blockId}"] .content`)
        if (!block || !el) return

        this._hideSlashMenu()

        if (type === "text") {
            block.content = ""
            block.type = "text"
            el.innerHTML = ""
            el.setAttribute("data-placeholder", this.placeholderFor("text"))
            el.focus()
            return
        }

        if (blockTypes[type].template) {
            block.type = type
            block.content = ""
            el.innerText = ""
            this.convertBlock(el, blockId, "interactiveElement", true)
            return
        }

        block.type = type
        block.content = ""
        el.classList.forEach(c => { if (c.startsWith('note-')) el.classList.remove(c) })
        el.classList.add("note-" + type)
        el.setAttribute("data-placeholder", this.placeholderFor(type))
        el.innerText = ""
        el.focus()
        this.putCursorToEnd(el)
        this.saveBlock(blockId)
    }

    // ── Saving: edits become CRDT operations (noteSync.mjs) ───────────────────

    /** Send what changed in a block (fields, text). Called after every edit; cheap when nothing did. */
    saveBlock(blockId){
        if (this.readOnly) return
        const block = this.blocks[blockId]
        if (!block) return
        if (tooLong(block.position) || tooLong(block.sub_position)) return this._respaceKeys()
        this.sync.commitBlock(block)
    }

    /**
     * Fresh, short position keys for every row (and every column's blocks), in the order
     * they are shown: a key outgrew its limit. One write per block, rare.
     */
    _respaceKeys() {
        let rowKey = null
        for (const row of this.getRenderableRows()) {
            rowKey = keyBetween(rowKey, null)
            for (const column of row.columnsArray) {
                let subKey = null
                for (const block of column) {
                    subKey = keyBetween(subKey, null)
                    block.position = rowKey
                    block.sub_position = subKey
                }
            }
        }
        for (const block of Object.values(this.blocks)) this.sync.commitBlock(block)
        this.reorderDOM()
    }

    /** A click on the "Not saved" badge: try again now. */
    retrySaves() {
        this.sync.pushSoon(0)
    }

    /** The "Not saved" badge of the note page (templates/note-save-status.html). */
    _renderSaveStatus() {
        const failed = this.sync.failed
        if (global.state.noteEditor === this && Boolean(global.state.noteSaveFailed) !== failed) {
            setElement("global.state.noteSaveFailed", failed)
        }
    }

    // ── Undo / redo (this tab's own changes, crdt/undo.mjs) ───────────────────

    /** Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y (Cmd on a Mac). True if handled. */
    handleUndoKeys(event) {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return false
        const key = event.key.toLowerCase()
        if (key !== "z" && key !== "y") return false
        event.preventDefault()
        this.undoRedo(key === "y" || event.shiftKey)
        return true
    }

    undoRedo(redo = false) {
        if (this.readOnly) return
        this._hideSlashMenu()
        const result = this.sync.undoStep(redo)
        if (!result) return
        this._applyChanges(result.changed, null)
        const focus = result.focus
        const el = focus && document.querySelector(`#note-editor .block[data-block-id="${focus.o}"] > .content.editable-block`)
        if (el && el.isContentEditable) {
            if (document.activeElement !== el) el.focus()
            this.restoreCursorPosition(el, focus.index)
        }
        this.presence?.refresh()
    }

    // ── Changes from others (and from undo) ──────────────────────────────────

    /** Before remote operations apply: where the caret is, as CRDT anchors that follow the text. */
    _captureCaret() {
        const el = document.activeElement
        const blockEl = el?.closest?.('#note-editor .block')
        const o = blockEl?.dataset.blockId
        if (!o || !this.blocks[o] || !el.classList.contains('editable-block')) return (this._caret = null)
        const selection = window.getSelection()
        const text = this.sync.doc.textOf(o)
        // Both ends of the selection (anchor: where it started, focus: where the caret is)
        const offset = (node, at) => {
            const range = document.createRange()
            range.selectNodeContents(el)
            range.setEnd(node, at)
            return range.toString().length
        }
        const inside = selection.rangeCount && el.contains(selection.anchorNode) && el.contains(selection.focusNode)
        const focus = inside ? offset(selection.focusNode, selection.focusOffset) : (this.saveCursorPosition(el) ?? 0)
        const anchor = inside ? offset(selection.anchorNode, selection.anchorOffset) : focus
        this._caret = {o, anchor: text.anchorAt(anchor), focus: text.anchorAt(focus), composing: this._composing}
    }

    _onSyncChange(changed, info) {
        if (info.status) return this._renderSaveStatus()
        if (info.reset) {
            for (const o of Object.keys(this.blocks)) delete this.blocks[o]
            Object.assign(this.blocks, this.sync.blocks())
            this.reorderDOM()
            this._renderSaveStatus()
            return
        }
        if (!changed.size) return
        const onScreen = global.state.noteEditor === this && global.state.activeChan?.type === 'note'
            && Number(global.state.activeChan.id) === this.channelId
        this._applyChanges(changed, onScreen ? this._caret : null, onScreen)
        this._caret = null
        this.presence?.refresh()
    }

    /**
     * Bring `this.blocks` (and the DOM, if on screen) up to date with the CRDT for these
     * blocks. A block that moved keeps its DOM (and caret); one whose type changed is drawn
     * again; one whose text changed is redrawn in place, the caret put back after the
     * character it followed.
     */
    _applyChanges(changed, caret, render = true) {
        const relayout = new Set()
        let structural = false
        for (const o of changed) {
            const fresh = this.sync.block(o)
            const local = this.blocks[o]
            if (!fresh) {
                if (local) {
                    this._forgetViews(o)
                    delete this.blocks[o]
                    structural = true
                    if (global.state.noteBlockMenu?.blockId === o) this.closeBlockMenu()
                    if (this.selectedBlockId === o) this.selectedBlockId = null
                }
                continue
            }
            if (!local) {
                this.blocks[o] = fresh
                relayout.add(o)
                structural = true
                continue
            }
            const typeChanged = local.type !== fresh.type
            const moved = LAYOUT_FIELDS.some(f => (local[f] ?? null) !== (fresh[f] ?? null))
            const edited = local.content !== fresh.content
            const reindented = (local.indent || 0) !== (fresh.indent || 0)
            // In place: checklists, transport… keep a reference to the block
            Object.assign(local, fresh)
            if (!render) continue
            if (reindented) this._paintIndent(o)
            if (typeChanged) relayout.add(o)
            if (typeChanged || moved) structural = true
            else if (edited) this._redrawBlock(o, caret)
        }
        if (render && structural) this._relayout(relayout)
    }

    /** New content, same place: only this block's DOM changes. */
    _redrawBlock(blockId, caret = null) {
        const block = this.blocks[blockId]
        const el = document.querySelector(`#note-editor .block[data-block-id="${blockId}"] > .content`)
        if (!el) return this._relayout(new Set([blockId]))
        if (block.type === "checklist") {
            const list = el.querySelector('.note-checklist')
            if (list) remountChecklistKeepingCaret(blockId, list)
        } else if (blockTypes[block.type]?.template) {
            // Transport, synapse…: their settings live in the content
            if (!['database', 'spreadsheet'].includes(block.type)) this._mountBlock(blockId)
        } else if (document.activeElement === el) {
            if (caret?.composing) return   // an input method is composing here: compositionend redraws
            el.innerHTML = MDToPreview(block.content)
            if (caret?.o === blockId) {
                // The preview keeps every character: text indexes are DOM offsets
                const text = this.sync.doc.textOf(blockId)
                const anchor = pointAt(el, text.indexOf(caret.anchor))
                const focus = pointAt(el, text.indexOf(caret.focus))
                window.getSelection().setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
            }
        } else {
            el.innerHTML = MDToRender(block.content)
        }
    }

    /**
     * Lay the rows out again after a block was added, moved or removed. The other blocks
     * keep their DOM (mounted views, what is being typed); the focused one gets its focus
     * and selection back once moved into the new layout. `changed`: blocks drawn anew.
     */
    _relayout(changed) {
        const host = document.getElementById('note-editor')?.firstElementChild   // the Subscribe of the rows
        if (!host) return
        const kept = new Map()
        for (const el of host.querySelectorAll('.block[data-block-id]')) {
            const id = el.dataset.blockId
            if (!changed.has(id) && this.blocks[id]) kept.set(id, el)
        }
        const fresh = document.createElement('div')
        fresh.innerHTML = fillWith('note-row', this.getRenderableRows())
        const toMount = []
        const focus = this._saveFocus()
        this._quietFocus = true
        try {
            for (const el of [...fresh.querySelectorAll('.block[data-block-id]')]) {
                const old = kept.get(el.dataset.blockId)
                if (old) el.replaceWith(old)
                else toMount.push(el.dataset.blockId)
            }
            host.replaceChildren(...fresh.childNodes)
            this._restoreFocus(focus)
        } finally {
            this._quietFocus = false
        }
        for (const id of toMount) this._mountBlock(id)
        this.applyPermissions(false)
    }

    _saveFocus() {
        const el = document.activeElement
        if (!el || !document.getElementById('note-editor')?.contains(el)) return null
        const selection = window.getSelection()
        const range = selection.rangeCount ? selection.getRangeAt(0) : null
        return {
            el,
            input: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? [el.selectionStart, el.selectionEnd] : null,
            // The nodes themselves move with the block: their offsets stay valid
            range: range && el.contains(range.startContainer)
                ? [range.startContainer, range.startOffset, range.endContainer, range.endOffset] : null,
        }
    }

    _restoreFocus(focus) {
        if (!focus || !focus.el.isConnected) return
        if (document.activeElement !== focus.el) focus.el.focus({preventScroll: true})
        try {
            if (focus.input && focus.input[0] !== null) focus.el.setSelectionRange(...focus.input)
            else if (focus.range) {
                const range = document.createRange()
                range.setStart(focus.range[0], focus.range[1])
                range.setEnd(focus.range[2], focus.range[3])
                const selection = window.getSelection()
                selection.removeAllRanges()
                selection.addRange(range)
            }
        } catch (e) {
            // the selection pointed at nodes that changed meanwhile: the caret stays where focus() put it
        }
    }

    renderedLength(raw) {
        return renderedLength(raw)
    }

    // ── Input methods (accents, Asian scripts…) ───────────────────────────────

    /** The block's text as composing starts: what the composed text is an edit of. */
    onCompositionStart(blockId) {
        this._composing = true
        this._composeBase = this.blocks[blockId] ? {o: blockId, ...this.sync.doc.textOf(blockId).snapshot()} : null
    }

    /**
     * The composed text is in: commit it like any input. If others changed the block meanwhile
     * (its DOM was left alone while composing), the edit goes onto their version and the block
     * is redrawn: committing the DOM as it is would undo what they typed.
     */
    onCompositionEnd(blockId, event) {
        this._composing = false
        const base = this._composeBase
        this._composeBase = null
        const block = this.blocks[blockId]
        if (block && !this.readOnly && base?.o === blockId && base.text !== this.sync.doc.text(blockId)) {
            const el = event.currentTarget
            const caret = this.sync.commitRebased(blockId, base, blockToRawContent(el))
            block.content = this.sync.doc.text(blockId)
            el.innerHTML = MDToPreview(block.content)
            this.restoreCursorPosition(el, caret)
            this.presence?.refresh()
            return
        }
        this.onInput(blockId, event)
    }
}

/**
 * Open a notes channel: its local copy (IndexedDB, then the server), then the editor.
 * A note opened again in this tab reuses its copy and only catches up.
 */
export async function openNote(channel) {
    channel = Number(channel)
    let sync
    try {
        sync = await getNoteSync(channel)
    } catch (e) {
        console.error("[notes] could not load note", channel, e)
        if (global.state.activeChan?.type === 'note' && Number(global.state.activeChan.id) === channel) {
            uiAlert(e.status === 403 || e.status === 404 ? _t("Tu n'as pas accès à cette note.")
                : e.offline ? _t("Cette note n'a jamais été ouverte sur cet appareil : elle n'est pas disponible hors-ligne.")
                : _t("Impossible d'ouvrir cette note : vérifie ta connexion."))
        }
        return
    }
    // The user went elsewhere while it loaded
    if (global.state.activeChan?.type !== 'note' || Number(global.state.activeChan.id) !== channel) return
    global.notes[channel] = {id: channel, name: sync.name, blocks: sync.blocks()}
    global.state.noteEditor = new Editor(sync)
    goTo('content', 'server-note-content', undefined, false)
    sync.join()
}
window.openNote = openNote

// WebSocket messages of the notes (static/ws/onMessage.mjs)
window.onNoteOps = ({channel, ops, after}) => noteSyncFor(channel)?.onServerOps(ops, after)
window.onNotePresence = (message) => global.state.noteEditor?.presence?.onMessage(message)
window.onNoteSheet = onSheetChange
window.onNoteError = ({channel}) => {
    // No access anymore: the note leaves this tab and this device
    noteSyncFor(channel)?.forget()
    const editor = global.state.noteEditor
    if (editor?.channelId !== Number(channel)) return
    editor.destroy()
    global.state.noteEditor = null
    delete global.notes[channel]
    if (global.state.activeChan?.type === 'note' && Number(global.state.activeChan.id) === Number(channel)) {
        uiAlert(_t("Tu n'as plus accès à cette note."))
        goTo('content', 'friends', undefined, true, () => goTo('friends-block', 'main-friend'))
    }
}
window.onNotesSocketReady = onNotesSocketReady

window.NoteEditor = Editor;

if (!window._myceliumNoteMenuKeys) {
    window._myceliumNoteMenuKeys = true
    // A click outside the block menu, or Escape, closes it (drive.mjs does the same for its menu)
    const closeOutside = (event) => {
        if (global.state.noteBlockMenu && !event.target.closest?.('.note-block-menu')) global.state.noteEditor?.closeBlockMenu()
    }
    document.addEventListener('click', closeOutside)
    document.addEventListener('contextmenu', closeOutside)
    // A drag started in the page (not from another app): its files are not new ones (onDrop)
    document.addEventListener('dragstart', () => { window._dragFromPage = true }, true)
    document.addEventListener('dragend', () => { window._dragFromPage = false }, true)
    // After the drop's handlers (bubbling): a source removed meanwhile gets no dragend
    document.addEventListener('drop', () => { window._dragFromPage = false })
    // A click in an image / file block selects it (capture: before the file opens)
    document.addEventListener('click', (event) => global.state.noteEditor?.onMediaClick(event), true)
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && global.state.noteBlockMenu) global.state.noteEditor?.closeBlockMenu()
        if (event.key === 'Escape' && global.state.noteFilePicker) global.state.noteEditor?.closeFilePicker()
        // Ctrl+Z with the caret outside a block (after deleting one, a menu action…)
        const editor = global.state.noteEditor
        if (editor && global.state.activeChan?.type === 'note' && !event.defaultPrevented
            && !event.target.closest?.('input, textarea, select, [contenteditable="true"]')
            && (event.target === document.body || event.target.closest?.('#content'))) {
            editor.handleUndoKeys(event)
        }
    })
    // Undo from the browser's menus or a phone keyboard: ours, not the browser's
    document.addEventListener('beforeinput', (event) => {
        const editor = global.state.noteEditor
        if (!editor || !event.target.closest?.('#note-editor')) return
        if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
            event.preventDefault()
            editor.undoRedo(event.inputType === 'historyRedo')
        }
    })
}

// A checklist is the text "[ ] item\n[x] done": its lines merge like any text. Two people
// ticking the same box at once can leave "[xx]": any "x" in the brackets means ticked.
const CHECK_MARK = /^\[[^\]\n]*\] ?/
const isCheckedLine = (line) => /^\[[^\]\n]*x[^\]\n]*\]/i.test(line)

/** Re-mount a checklist changed by someone else, the caret staying in the same item. */
function remountChecklistKeepingCaret(blockUuid, containerEl) {
    const items = [...containerEl.querySelectorAll('.checklist-item-text')]
    const focused = items.indexOf(document.activeElement)
    let offset = 0
    if (focused >= 0) {
        const selection = window.getSelection()
        if (selection.rangeCount) {
            const range = selection.getRangeAt(0).cloneRange()
            range.selectNodeContents(items[focused])
            range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset)
            offset = range.toString().length
        }
    }
    mountChecklist(blockUuid, containerEl)
    if (focused < 0) return
    const item = containerEl.querySelectorAll('.checklist-item-text')[focused]
    if (!item) return
    item.focus()
    global.state.noteEditor?.restoreCursorPosition(item, Math.min(offset, item.innerText.length))
}

function mountChecklist(blockUuid, containerEl) {
    const editor = global.state.noteEditor
    const block = editor?.blocks[blockUuid]
    if (!block || !containerEl) return

    if (!block.content || block.content.trim() === '') block.content = '[ ] '
    const lines = block.content.split('\n').filter(l => l !== '')

    containerEl.innerHTML = ''

    const ul = document.createElement('ul')
    ul.className = 'checklist-list'

    lines.forEach((line, i) => {
        const checked = isCheckedLine(line)
        const text = line.replace(CHECK_MARK, '')

        const li = document.createElement('li')
        li.className = 'checklist-item' + (checked ? ' checked' : '')

        const checkbox = document.createElement('div')
        checkbox.className = 'checklist-checkbox' + (checked ? ' checked' : '')
        checkbox.onclick = () => {
            const isNowChecked = !checkbox.classList.contains('checked')
            const currentLines = block.content.split('\n').filter(l => l !== '')
            if (i >= currentLines.length) return
            const itemText = currentLines[i].replace(CHECK_MARK, '')
            currentLines[i] = (isNowChecked ? '[x] ' : '[ ] ') + itemText
            block.content = currentLines.join('\n')
            checkbox.classList.toggle('checked', isNowChecked)
            li.classList.toggle('checked', isNowChecked)
            editor.saveBlock(blockUuid)
        }

        const span = document.createElement('span')
        span.contentEditable = 'true'
        span.className = 'checklist-item-text'
        span.innerText = text
        // Every keystroke is an edit of the block's text, sent like a text block's
        span.oninput = () => {
            const currentLines = block.content.split('\n').filter(l => l !== '')
            if (i >= currentLines.length) return
            const isChecked = isCheckedLine(currentLines[i])
            // One line per item: a pasted line break would split it in two
            currentLines[i] = (isChecked ? '[x] ' : '[ ] ') + span.innerText.replace(/\n/g, ' ').trim()
            block.content = currentLines.join('\n')
            editor.saveBlock(blockUuid)
        }
        span.onkeydown = (event) => {
            if (event.key === 'Enter') {
                event.preventDefault()
                const currentLines = block.content.split('\n').filter(l => l !== '')
                // Persist the text just typed into this item before inserting a new
                // one, otherwise the re-mount below reverts it to its stale content.
                if (i < currentLines.length) {
                    const isChecked = isCheckedLine(currentLines[i])
                    currentLines[i] = (isChecked ? '[x] ' : '[ ] ') + span.innerText.trim()
                }
                currentLines.splice(i + 1, 0, '[ ] ')
                block.content = currentLines.join('\n')
                mountChecklist(blockUuid, containerEl)
                const items = containerEl.querySelectorAll('.checklist-item-text')
                if (items[i + 1]) items[i + 1].focus()
                editor.saveBlock(blockUuid)
            } else if (event.key === 'Backspace' && span.innerText.trim() === '') {
                event.preventDefault()
                const currentLines = block.content.split('\n').filter(l => l !== '')
                if (currentLines.length <= 1) return
                currentLines.splice(i, 1)
                block.content = currentLines.join('\n')
                mountChecklist(blockUuid, containerEl)
                const items = containerEl.querySelectorAll('.checklist-item-text')
                const focusIndex = Math.max(0, i - 1)
                if (items[focusIndex]) items[focusIndex].focus()
                editor.saveBlock(blockUuid)
            }
        }

        li.appendChild(checkbox)
        li.appendChild(span)
        ul.appendChild(li)
    })

    const addBtn = document.createElement('button')
    addBtn.className = 'checklist-add-btn'
    addBtn.textContent = '+ ' + _t('Ajouter un élément')
    addBtn.onclick = () => {
        const currentLines = block.content.split('\n').filter(l => l !== '')
        currentLines.push('[ ] ')
        block.content = currentLines.join('\n')
        mountChecklist(blockUuid, containerEl)
        const items = containerEl.querySelectorAll('.checklist-item-text')
        if (items.length > 0) items[items.length - 1].focus()
        editor.saveBlock(blockUuid)
    }

    containerEl.appendChild(ul)
    containerEl.appendChild(addBtn)
}

const blockTypes = {
    // placeholder: translation key (Editor.placeholderFor)
    "text": {placeholder: "Écris, ou tape « / » pour les commandes…"},
    "heading1": {placeholder: "Titre 1", initiator: "#"},
    "heading2": {placeholder: "Titre 2", initiator: "##"},
    "heading3": {placeholder: "Titre 3", initiator: "###"},
    "small": {placeholder: "Petit texte", initiator: "-#"},
    "bullet": {placeholder: "Liste", initiator: "- "},
    "numbered": {placeholder: "Liste", initiator: "1. "},
    "showcase": {placeholder: "Valeur ou formule", initiator: "/showcase"},
    // Its text is a drive link ("<#drive:12/f:301>"), shown through drive_links: who can't see
    // that drive gets "inaccessible item", never the file (static/drive-links.mjs)
    "file": {template: (block) => fillWith("note-file-root", [block]), initiator: "/file"},
    // An image stored with the note: whoever can read the note sees it
    "image": {template: (block) => fillWith("note-image-root", [block]), initiator: "/image"},
    "checklist": {template: () => '<div class="note-checklist"></div>', initiator: "/todo"},
    "transport": {template: (block)=>{return fillWith("transport-root", [block])}, initiator: "/transport"},
    "synapse": {template: (block)=>{return getTemplate("synapse-root")}, initiator: "/synapse"},
    "database": {template: (block)=>{return fillWith("database-root", [block])}, initiator: "/database"},
    "spreadsheet": {template: (block)=>{return fillWith("spreadsheet-root", [block])}, initiator: "/sheet"},
}

const initiators = [
    {"type":"heading1", "initiator":"#"},
    {"type":"heading2", "initiator":"##"},
    {"type":"heading3", "initiator":"###"},
    {"type":"small", "initiator":"-#"},
    {"type":"bullet", "initiator":"- "},
    {"type":"bullet", "initiator":"* "},
    {"type":"numbered", "initiator":"1. "},
    {"type":"showcase", "initiator":"/showcase"},
    {"type":"file", "initiator":"/file"},
    {"type":"image", "initiator":"/image"},
    {"type":"checklist", "initiator":"/todo"},
    {"type":"transport", "initiator":"/transport"},
    {"type":"synapse", "initiator":"/synapse"},
    {"type":"database", "initiator":"/database"},
    {"type":"spreadsheet", "initiator":"/sheet"},
]


class InitiatorParser{
    constructor(content){
        this.content = content
        // this.content = content.trimEnd()
        this.possibleInitiators = initiators
    }

    parse(){
        // A space typed in a contenteditable may arrive as a no-break space: "- " either way
        const plain = this.content.replaceAll(' ', ' ')
        for(let i = 0; i < this.content.length; i+=1) {

            const char = plain[i]
            let newPossibleInitiators = []
            for (let j = 0; j < this.possibleInitiators.length; j += 1) {
                const initiator = this.possibleInitiators[j]
                if (char === initiator.initiator[i]) {
                    newPossibleInitiators.push(initiator)
                }
            }

            if (newPossibleInitiators.length === 0) {
                // if no initiator check exact match with latests possible initiators
                if (this.possibleInitiators.length > 0 && i === this.possibleInitiators[0].initiator.length) {
                    return {initiator: this.possibleInitiators[0], content: this.stripContent(this.content.slice(i))}
                }
                return {initiator: null, content: ""}
            }else if (newPossibleInitiators.length === 1){
                // Check if any of the possible initiators is fully matched
                    const initiator = newPossibleInitiators[0]
                    if (plain.startsWith(initiator.initiator)) {
                        return {initiator: newPossibleInitiators[0], content: this.stripContent(this.content.slice(initiator.initiator.length))}
                    }
            }
            this.possibleInitiators = newPossibleInitiators
        }

        return {initiator: null, content: ""}
    }

    stripContent(content){
        if (content.startsWith(' ') || content.startsWith(' ')) {
            content = content.slice(1)
        }
        if (content.endsWith(' ') || content.endsWith(' ')) {
            content = content.slice(0, -1)
        }
        return content
    }
}

// Reconstruct raw markdown from a rendered block's DOM, converting mention
// spans back to their token form (e.g. <span data-channel-id="3"> → <#3>).
function blockToRawContent(el) {
    let result = ''
    for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList.contains('mention-channel')) {
                result += `<#${node.dataset.channelId}>`
            } else if (node.classList.contains('mention-user')) {
                result += `<@${node.dataset.mentionId}>`
            } else if (node.classList.contains('mention-role')) {
                result += `<@&${node.dataset.mentionId}>`
            } else if (node.classList.contains('mention-everyone')) {
                result += '<@everyone>'
            } else if (node.classList.contains('mention-here')) {
                result += '<@here>'
            } else if (node.tagName === 'BR') {
                result += '\n'
            } else {
                result += blockToRawContent(node)
            }
        }
    }
    return result
}

/**
 * The editing preview of a block: its markdown source, syntax dimmed and formatting applied
 * (the parser's source mode). The editor reads the text back from this DOM on every
 * keystroke (blockToRawContent), so it keeps every character: blockToRawContent of the
 * preview is the text (Vesta tests/markdown, and notesPage.spec.mjs here).
 */
function MDToPreview(text){
    return new ChatMarkdown().renderSource(text)
}

/**
 * A block's text as markdown input for display. The parser takes "<" escaped, like chat
 * messages (crud.mjs): a "<" typed in a note is text, never HTML. Mentions ("<#3>") still
 * parse ("&lt;#3>" is how the parser reads them).
 */
const forDisplay = (text) => String(text ?? "").replaceAll("<", "&lt;")

const render_equiv = {
    "#":"<b>${content}</b>",
    "text":"${content}",
    "start li":"<li>${content}</li>",
    "*":"<i>${content}</i>",
    "**":"<b>${content}</b>",
    ">":"<div class='answer'>${content}</div>",
    "'''":"<div class='code-wrapper'><code>${content}</code><div class='circle grey' onclick='copyCode(event)'></div></div>",
    "~~":"<span class='crossed'>${content}</span>",
    "||":"<span class='spoiler' onclick='showSpoiler(event)'>${content}</span>",
    "link":"<a href='${props.link}' target='_blank'>${content}</a>",
    "color":"<span class='color' style='color: ${props.color}'>${content}</span>",
    "-#":"<span class='small'>${content}</span>",
    "endline":"\n",
    "newline":"${content}",
    "|":"${content}|",
    ")":")",
    "'":"${content}${\"'\".repeat(props?.level ?? 1)}",
    "(":"(",
    "/>":"/>",
    "]":"]",
    "/":"${content}/"
}

/**
 * How many characters a block's markdown shows once rendered (syntax hidden, mentions as
 * names): live cursors place a caret given in the source (notePresence.mjs). Formulas
 * are not evaluated here.
 */
function renderedLength(raw) {
    const engine = new ChatMarkdown()
    const template = document.createElement('template')   // inert: nothing in it loads or runs
    template.innerHTML = engine.render(engine.tokenize(forDisplay(raw)), render_equiv)
    return template.content.textContent.length
}

function MDToRender(text){
    //rendering MD
    const engine = new ChatMarkdown()
    const tokens = engine.tokenize(forDisplay(text))
    const rendered = engine.render(tokens, render_equiv)

    //evaluating functions
    return evaluateText(rendered)
}
window.MDToRender = MDToRender
window.MDToPreview = MDToPreview
window.blockToRawContent = blockToRawContent

function func_dashboard(dashboardName){
    const onload = function(){
    }

    const request = xhr("get_dashboard?server_id="+global.state.currentServer.id+"&service_id="+dashboardName, onload, "GET", false)

    if (request.status !== 200) {
        return "ERROR loading dashboard: "+request.status
    }

    const json = JSON.parse(request.responseText)
    return json.users.count
}

function func_progress(data, goal, type="linear"){
    if (type === "linear") {
        return fillWith("block-progress-line", [{data: data, goal: goal}])
    }else if (type === "circular") {
        return fillWith("block-progress-circle", [{data: data, goal: goal}])
    }

    return "Unknown progress type '"+type+"'"
}

// Register app-specific functions into the shared formula engine
registerFunction('DASHBOARD', func_dashboard)
registerFunction('PROGRESS', func_progress)