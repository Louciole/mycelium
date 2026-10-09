import {Markdown} from "../markdown/markdown.mjs";
import {xhr} from "../framework/templating.mjs";
import {setElement, updateElement} from "../framework/vesta.mjs";
import {} from "./synapse.mjs";
import {normalizeIfNeeded} from "../drag.mjs";
import {
    registerFunction,
    evaluateText
} from "./formulaEngine.mjs";
import {mountDatabase} from "./database.mjs";
import {mountSpreadsheet} from "./spreadsheet.mjs";
import {mountTransportBlock} from "./transport.mjs";

class Editor {
    constructor() {
        this.blocks = global.notes[global.state.activeChan.id].blocks
        if (Object.keys(this.blocks).length === 0) {
            this.createBlock({},false)
        }
        this.draggedBlockId = null

        this.reorderDOM()
        
        // After DOM is rendered, re-mount interactive blocks (database, synapse, etc.)
        requestAnimationFrame(() => this._mountInteractiveBlocks())
    }

    _mountInteractiveBlocks() {
        for (const blockId in this.blocks) {
            const block = this.blocks[blockId]
            if (blockTypes[block.type] && blockTypes[block.type].template) {
                const blockEl = document.querySelector(`[data-block-id="${block.uuid}"] .content`)
                if (blockEl) {
                    this.convertBlock(blockEl, blockId)
                }
            }
        }
    }

    getRenderableRows() {
        const toNumber = (value, fallback = 0) => {
            const num = Number(value)
            return Number.isFinite(num) ? num : fallback
        }

        const compareBlocks = (a, b) => {
            const subA = toNumber(a.sub_position, toNumber(a.position, 0))
            const subB = toNumber(b.sub_position, toNumber(b.position, 0))
            if (subA !== subB) return subA - subB

            const posA = toNumber(a.position, 0)
            const posB = toNumber(b.position, 0)
            if (posA !== posB) return posA - posB

            return String(a.uuid).localeCompare(String(b.uuid))
        }

        const rowsById = new Map()

        for (const block of Object.values(this.blocks)) {
            const rowId = block.row_group || block.uuid
            const rowPosition = toNumber(block.position, 0)
            const colIndex = toNumber(block.column_index, 0)

            let row = rowsById.get(rowId)
            if (!row) {
                row = {id: rowId, position: rowPosition, columns: new Map()}
                rowsById.set(rowId, row)
            } else {
                row.position = Math.min(row.position, rowPosition)
            }

            const colBlocks = row.columns.get(colIndex) || []
            colBlocks.push(block)
            row.columns.set(colIndex, colBlocks)
        }

        return Array.from(rowsById.values())
            .sort((a, b) => {
                if (a.position !== b.position) return a.position - b.position
                return String(a.id).localeCompare(String(b.id))
            })
            .map((row) => ({
                id: row.id,
                position: row.position,
                columnsArray: Array.from(row.columns.entries())
                    .sort(([colA], [colB]) => colA - colB)
                    .map(([, blocks]) => blocks.sort(compareBlocks))
            }))
    }

    createBlock({type = "text", content = "", position = null, afterBlockId = null, rowGroup = null, colIndex = 0}, addDom = true) {
        // generate uuid for block id
        const newBlockId = crypto.randomUUID()
        
        let targetPosition = position
        let subPosition = 0

        // Calculate position
        if (targetPosition !== null && afterBlockId === null) {
             targetPosition = targetPosition + 0.1
        } else if (targetPosition === null) {
            // No position provided, add at the end
            const rows = this.getRenderableRows()
            if (rows.length === 0) {
                targetPosition = 0.1
            } else {
                targetPosition = rows[rows.length - 1].position + 0.1
            }
        }

        this.blocks[newBlockId] = {
            "uuid": newBlockId, 
            "type": type, 
            "content": content, 
            "position": targetPosition,
            "row_group": rowGroup || newBlockId,
            "column_index": colIndex,
            "sub_position": subPosition
        };

        if (addDom){
            this.reorderDOM()
        }

        this.checkAndNormalizePositions()

        const onload = function () {

        }
        xhr("/save_block?channel="+global.state.activeChan.id+"&block="+encodeURIComponent(JSON.stringify(this.blocks[newBlockId]))+"&op=create", onload)
    }

    moveBlock(blockId, newPosition, newRowGroup = null, newColIndex = null, newSubPosition = null) {
        const block = this.blocks[blockId]
        if (!block) return

        block.position = newPosition
        if (newRowGroup !== null) block.row_group = newRowGroup
        if (newColIndex !== null) block.column_index = newColIndex
        if (newSubPosition !== null) block.sub_position = newSubPosition
        
        this.reorderDOM()
        this.checkAndNormalizePositions()

        this.saveBlock(block.uuid)

        console.log("Block moved:", blockId, "new pos:", newPosition, "row:", newRowGroup, "col:", newColIndex)
    }

    reorderDOM() {
        updateElement('global.notes['+global.state.activeChan.id+'].blocks')

        // updateElement re-renders rows and replaces interactive block DOM.
        requestAnimationFrame(() => this._mountInteractiveBlocks())
    }

    checkAndNormalizePositions() {
        const blocks = Object.values(this.blocks)
        normalizeIfNeeded(blocks, 'position', (item) => {
            this.saveBlock(item.uuid)
        })

        const rowGroups = {}
        for (const block of blocks) {
            const rowId = block.row_group || block.uuid
            if (!rowGroups[rowId]) rowGroups[rowId] = []
            rowGroups[rowId].push(block)
        }
        for (const groupBlocks of Object.values(rowGroups)) {
            normalizeIfNeeded(groupBlocks, 'sub_position', (item) => {
                this.saveBlock(item.uuid)
            })
        }
    }

    deleteBlock(blockId) {
        const block = this.blocks[blockId]
        if (block?.type === "spreadsheet" && global.state.spreadsheetViews) {
            delete global.state.spreadsheetViews[blockId]
            if (global.state.activeSpreadsheetFormulaEditor?.blockUuid === blockId) {
                global.state.activeSpreadsheetFormulaEditor = null
            }
            if (global.state.spreadsheetSnapshots) {
                delete global.state.spreadsheetSnapshots[blockId]
            }
        }
        if (block?.type === "database" && global.state.databaseViews) {
            delete global.state.databaseViews[blockId]
        }

        delete this.blocks[blockId]
        delete global.notes[global.state.activeChan.id].blocks[blockId]
        
        this.reorderDOM()

        const onload = function () {

        }
        xhr("/save_block?channel="+global.state.activeChan.id+"&block="+ JSON.stringify({uuid:blockId})+"&op=delete", onload)

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

        if (isHorizontalDrop) {
            // Create or join a row
            const targetRowGroup = targetBlock.row_group || targetBlock.uuid
            
            // Ensure target is properly grouped
            targetBlock.row_group = targetRowGroup
            targetBlock.column_index = targetBlock.column_index || 0
            
            const newColIndex = isAfter ? targetBlock.column_index + 1 : Math.max(0, targetBlock.column_index - 0.5)
            
            this.moveBlock(this.draggedBlockId, targetBlock.position, targetRowGroup, newColIndex, 0)
            
            // Normalize column indices for this row
            const rows = this.getRenderableRows()
            const targetRow = rows.find(r => r.id === targetRowGroup)
            if(targetRow) {
               let flatCols = []
               targetRow.columnsArray.forEach(c => flatCols.push(...c))
               // sort by old column index
               flatCols.sort((a,b) => a.column_index - b.column_index)
               // reassign integer indices
               let currentGroup = -1
               let colIdx = -1
               for(let i=0; i<flatCols.length; i++) {
                   if(flatCols[i].column_index !== currentGroup) {
                       currentGroup = flatCols[i].column_index
                       colIdx++
                   }
                   flatCols[i].column_index = colIdx
                   this.saveBlock(flatCols[i].uuid)
               }
            }

        } else {
             // Vertical Drop
             const targetRowGroup = targetBlock.row_group || targetBlock.uuid
             const targetColIndex = targetBlock.column_index || 0
             
             // If dropping on a block that is the only one in its row, 
             // we probably want to create a new row above/below it.
             // If the row has multiple columns, we want to stay in this column.
             
             const rows = this.getRenderableRows()
             const targetRow = rows.find(r => r.id === targetRowGroup)
             const isMultiColumnRow = targetRow && targetRow.columnsArray.length > 1
             
             if (isMultiColumnRow) {
                 // Insert within the same column
                 let newSubPos = isAfter ? (targetBlock.sub_position || 0) + 0.5 : (targetBlock.sub_position || 0) - 0.5
                 this.moveBlock(this.draggedBlockId, targetBlock.position, targetRowGroup, targetColIndex, newSubPos)
             } else {
                 // Insert as a new full-width row
                 let newPos = isAfter ? targetBlock.position + 0.1 : targetBlock.position - 0.1
                 // Give it its own row group
                 this.moveBlock(this.draggedBlockId, newPos, this.draggedBlockId, 0, 0)
             }
        }

        this.cleanupDragState()
    }

    onInput(blockId, event) {
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
                    event.currentTarget.setAttribute("data-placeholder", blockTypes[block.type].placeholder)
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
        console.log("Input event:",this.blocks[blockId], event.currentTarget.innerText);
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

            if (persistTypeChange) {
                // Persist type transitions before mounting interactive resources.
                xhr("/save_block?channel="+global.state.activeChan.id+"&block="+encodeURIComponent(JSON.stringify(block))+"&op=edit", ()=>{}, "GET", false)
            }

            target.innerHTML = blockTypes[block.type].template(block)

            // Mount database components
            if (block.type === "database") {
                const channelId = global.state.activeChan.id
                const containerEl = target.querySelector('.note-database')
                if (containerEl) {
                    mountDatabase(block.uuid, channelId, containerEl)
                }
            } else if (block.type === "spreadsheet") {
                const channelId = global.state.activeChan.id
                const containerEl = target.querySelector('.note-spreadsheet')
                if (containerEl) {
                    mountSpreadsheet(block.uuid, channelId, containerEl)
                }
            } else if (block.type === "checklist") {
                const containerEl = target.querySelector('.note-checklist')
                if (containerEl) mountChecklist(block.uuid, containerEl)
            } else if (block.type === "transport") {
                const containerEl = target.querySelector('.note-transport')
                if (containerEl) mountTransportBlock(block.uuid, containerEl)
            }
        }
    }

    onKeyDown(blockId, event) {
        if (typeof window.mentionNoteOnKeyDown === 'function' && window.mentionNoteOnKeyDown(blockId, event)) return

        const block = this.blocks[blockId];

        const menu = global.state.slashMenu
        if (menu?.visible && menu.blockId === blockId) {
            if (event.key === 'ArrowDown') {
                event.preventDefault()
                setElement('global.state.slashMenu', {...menu, selectedIndex: (menu.selectedIndex + 1) % menu.items.length})
                return
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault()
                setElement('global.state.slashMenu', {...menu, selectedIndex: (menu.selectedIndex - 1 + menu.items.length) % menu.items.length})
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

        if (block.type === "text") {
            if (event.key === "Backspace" && block.content === "" ) {
                this.deleteBlock(blockId)
            }
            return
        }

        if(event.key === "Backspace" && block.content === ""){
            if (block.type === "spreadsheet" && global.state.spreadsheetViews) {
                delete global.state.spreadsheetViews[blockId]
                if (global.state.activeSpreadsheetFormulaEditor?.blockUuid === blockId) {
                    global.state.activeSpreadsheetFormulaEditor = null
                }
                if (global.state.spreadsheetSnapshots) {
                    delete global.state.spreadsheetSnapshots[blockId]
                }
            }
            if (block.type === "database" && global.state.databaseViews) {
                delete global.state.databaseViews[blockId]
            }

            block.content = blockTypes[block.type].initiator
            event.currentTarget.classList.remove("note-"+block.type)
            event.currentTarget.innerText = block.content

            this.putCursorToEnd(event.currentTarget)

            event.currentTarget.focus();

            block.type = "text"
            event.currentTarget.setAttribute("data-placeholder", blockTypes[block.type].placeholder)
            event.preventDefault();
        }else if(event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();

            // create a new block with the content after the cursor
            const cursorPosition = this.saveCursorPosition(event.currentTarget);
            const contentBeforeCursor = block.content.slice(0, cursorPosition);
            const contentAfterCursor = block.content.slice(cursorPosition);

            block.content = contentBeforeCursor
            event.currentTarget.innerText = block.content

            this.createBlock({
                type: "text", 
                content: contentAfterCursor, 
                afterBlockId: blockId,
                rowGroup: block.row_group,
                colIndex: block.column_index
            })
            // put cursor to end of new block
            // Find the correct DOM element instead of assuming it's the last one created globally
            setTimeout(() => {
                 const newBlockElement = document.querySelector(`[data-block-id="${Object.keys(this.blocks)[Object.keys(this.blocks).length - 1]}"] .content`)
                 if(newBlockElement) {
                     this.putCursorToEnd(newBlockElement)
                     newBlockElement.focus();
                 }
            }, 0)

        }
    }

    onBlur(blockId, event) {
        if (typeof window.mentionNoteOnBlur === 'function') window.mentionNoteOnBlur()
        this._hideSlashMenu()
        // switching from editor preview to rendered view
        const block = this.blocks[blockId];
        // Spellcheck only while editing — turn it off in the rendered view.
        event.currentTarget.spellcheck = false
        event.currentTarget.innerHTML = MDToRender(block.content)
        this.saveBlock(blockId)
    }

    onFocus(blockId, event) {
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

    _slashMenuItems() {
        return [
            { type: "text",        label: "Text",        description: "Plain paragraph" },
            { type: "heading1",    label: "Heading 1",   description: "Large section heading" },
            { type: "heading2",    label: "Heading 2",   description: "Medium section heading" },
            { type: "heading3",    label: "Heading 3",   description: "Small section heading" },
            { type: "small",       label: "Small Text",  description: "Smaller font size" },
            { type: "showcase",    label: "Showcase",    description: "Display a metric value", keywords: ["metric"] },
            { type: "checklist",   label: "Checklist",   description: "To-do list with checkboxes", keywords: ["todo", "to-do"] },
            { type: "transport",   label: "Transport",   description: "Next arrivals for a stop" },
            { type: "synapse",     label: "Synapse",     description: "External component" },
            { type: "database",    label: "Database",    description: "Inline database table", keywords: ["table", "db"] },
            { type: "spreadsheet", label: "Spreadsheet", description: "Inline spreadsheet", keywords: ["sheet"] },
        ]
    }

    _showSlashMenu(blockId, anchorEl, query) {
        const all = this._slashMenuItems()
        const q = query.toLowerCase()
        const filtered = query === ""
            ? all
            : all.filter(item =>
                item.label.toLowerCase().startsWith(q)
                || (item.keywords || []).some(k => k.startsWith(q)))

        if (filtered.length === 0) { this._hideSlashMenu(); return }

        const prev = global.state.slashMenu
        const selectedIndex = prev?.visible ? Math.min(prev.selectedIndex, filtered.length - 1) : 0
        const rect = anchorEl.getBoundingClientRect()

        setElement('global.state.slashMenu', {
            visible: true,
            blockId,
            query,
            selectedIndex,
            items: filtered.map((item, i) => ({...item, index: i})),
            top: rect.bottom + 4,
            left: rect.left,
        })
    }

    _showHeadingMenu(blockId, anchorEl, hashes) {
        const items = this._slashMenuItems().filter(item =>
            item.type === "heading1" || item.type === "heading2" || item.type === "heading3")

        const rect = anchorEl.getBoundingClientRect()
        // Preselect the level matching how many '#' were typed (# → H1, ## → H2…)
        const selectedIndex = Math.min(hashes.length, items.length) - 1

        setElement('global.state.slashMenu', {
            visible: true,
            blockId,
            query: hashes,
            selectedIndex,
            items: items.map((item, i) => ({...item, index: i})),
            top: rect.bottom + 4,
            left: rect.left,
        })
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
            el.setAttribute("data-placeholder", blockTypes["text"].placeholder)
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
        el.setAttribute("data-placeholder", blockTypes[type].placeholder)
        el.innerText = ""
        el.focus()
        this.putCursorToEnd(el)
        this.saveBlock(blockId)
    }

    saveBlock(blockId){
        const block = this.blocks[blockId];

        const onSaved = function () {

        }

        xhr("/save_block?channel="+global.state.activeChan.id+"&block="+encodeURIComponent(JSON.stringify(block))+"&op=edit", onSaved)
    }

}
window.NoteEditor = Editor;

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
        const checked = line.startsWith('[x]')
        const text = line.replace(/^\[.\] ?/, '')

        const li = document.createElement('li')
        li.className = 'checklist-item' + (checked ? ' checked' : '')

        const checkbox = document.createElement('div')
        checkbox.className = 'checklist-checkbox' + (checked ? ' checked' : '')
        checkbox.onclick = () => {
            const isNowChecked = !checkbox.classList.contains('checked')
            const currentLines = block.content.split('\n').filter(l => l !== '')
            if (i >= currentLines.length) return
            const itemText = currentLines[i].replace(/^\[.\] ?/, '')
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
        span.onblur = () => {
            const currentLines = block.content.split('\n').filter(l => l !== '')
            if (i >= currentLines.length) return
            const isChecked = currentLines[i].startsWith('[x]')
            currentLines[i] = (isChecked ? '[x] ' : '[ ] ') + span.innerText.trim()
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
                    const isChecked = currentLines[i].startsWith('[x]')
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
    addBtn.textContent = '+ Add item'
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
    "text": {placeholder: "Press '/' for commands"},
    "heading1": {placeholder: "Heading 1", initiator: "#"},
    "heading2": {placeholder: "Heading 2", initiator: "##"},
    "heading3": {placeholder: "Heading 3", initiator: "###"},
    "small": {placeholder: "small text", initiator: "-#"},
    "showcase": {placeholder: "insert metric", initiator: "/showcase"},
    "checklist": {template: () => '<div class="note-checklist"></div>', initiator: "/todo"},
    "transport": {template: (block)=>{return fillWith("transport-root", [block])}, initiator: "/transport", placeholder: "transport"},
    "synapse": {template: (block)=>{return getTemplate("synapse-root")}, initiator: "/synapse"},
    "database": {template: (block)=>{return fillWith("database-root", [block])}, initiator: "/database", placeholder: "database"},
    "spreadsheet": {template: (block)=>{return fillWith("spreadsheet-root", [block])}, initiator: "/sheet", placeholder: "spreadsheet"},
}

const initiators = [
    {"type":"heading1", "initiator":"#"},
    {"type":"heading2", "initiator":"##"},
    {"type":"heading3", "initiator":"###"},
    {"type":"small", "initiator":"-#"},
    {"type":"showcase", "initiator":"/showcase"},
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
        console.log("Parsing initiator for content:'"+ this.content+"'")
        for(let i = 0; i < this.content.length; i+=1) {

            const char = this.content[i]
            let newPossibleInitiators = []
            for (let j = 0; j < this.possibleInitiators.length; j += 1) {
                const initiator = this.possibleInitiators[j]
                if (char === initiator.initiator[i]) {
                    newPossibleInitiators.push(initiator)
                }
            }

            console.log("char", char, "possible initiators", newPossibleInitiators)
            if (newPossibleInitiators.length === 0) {
                // if no initiator check exact match with latests possible initiators
                if (this.possibleInitiators.length > 0 && i === this.possibleInitiators[0].initiator.length) {
                    return {initiator: this.possibleInitiators[0], content: this.stripContent(this.content.slice(i))}
                }
                return {initiator: null, content: ""}
            }else if (newPossibleInitiators.length === 1){
                // Check if any of the possible initiators is fully matched
                    const initiator = newPossibleInitiators[0]
                    if (this.content.startsWith(initiator.initiator)) {
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

const preview_equiv = {
    "#":"${'#'.repeat(props.level)}${content}",
    "text":"${content}",
    "start li":"-${content}\n",
    "*":"<span class='preview-will-be-hidden'>*</span><i class='i'>${content}</i><span class='preview-will-be-hidden'>*</span>",
    "**":"<span class='preview-will-be-hidden'>**</span><b>${content}</b><span class='preview-will-be-hidden'>**</span>",
    ">":"<span class='answer'>${content}</span>",
    "'''":"<div class='code-wrapper'><code>${content}</code><div class='circle grey' onclick='copyCode(event)'></div></div>",
    "~~":"<span class='preview-will-be-hidden'>~~</span><span class='crossed'>${content}</span><span class='preview-will-be-hidden'>~~</span>",
    "||":"<span class='preview-will-be-hidden'>||</span><span class='spoiler' onclick='showSpoiler(event)'>${content}</span><span class='preview-will-be-hidden'>||</span>",
    "link":"<a href='${props.link}' target='_blank'>${content}</a>",
    "color":"<span class='color' style='color: ${props.color}'>${content}</span>",
    "-#":"-# <span class='small'>${content}</span>",
    "mention_user":"${content}",
    "mention_role":"${content}",
    "mention_channel":"${content}",
    "mention_everyone":"<span class='mention mention-everyone'>@everyone</span>",
    "mention_here":"<span class='mention mention-here'>@here</span>",
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

function MDToPreview(text){
    const engine = new Markdown()
    const tokens = engine.tokenize(text)
    console.log("text",text,"tokens",tokens)
    return engine.render(tokens, preview_equiv)
}

const render_equiv = {
    "#":"${props.level*'#'}${content}",
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
    "mention_user":"${content}",
    "mention_role":"${content}",
    "mention_channel":"${content}",
    "mention_everyone":"<span class='mention mention-everyone'>@everyone</span>",
    "mention_here":"<span class='mention mention-here'>@here</span>",
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

function MDToRender(text){


    //rendering MD
    const engine = new Markdown()
    const tokens = engine.tokenize(text)
    console.log("text",text,"tokens",tokens)
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