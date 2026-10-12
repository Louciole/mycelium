/**
 * DatabaseView — Notion-like database block for the note editor.
 *
 * Supports table and gallery views.
 * Cell types: text, number, checkbox, date, select, relation, formula.
 * Formulas use the shared formula engine (=SUM(A1:A3) ↔ {{SUM(A1,A2,A3)}}).
 * Relations reference rows in other databases, displayed by first text column.
 */

import {xhr} from "../framework/templating.mjs";
import {
    evaluateFormula,
    colIndexToLetter,
    colLetterToIndex,
} from "./formulaEngine.mjs";

// ─── Global registry (follows global.state convention) ────────────────

if (!global.state.databaseViews) global.state.databaseViews = {}

export class DatabaseView {
    constructor(blockUuid, channelId, containerEl) {
        this.blockUuid = blockUuid
        this.channelId = channelId
        this.containerEl = containerEl

        this.database = null
        this.columns = []   // sorted, options pre-parsed
        this.rows = []
        this.cells = {}     // { rowId: { colId: value } }

        this.sortColumn = null
        this.sortDirection = 'asc'

        // Cache for relation display names: { "dbId:rowId" → "display name" }
        this._relationDisplayCache = {}

        this.load()
    }

    // ─── Data Loading ─────────────────────────────────────────────────

    load() {
        const request = xhr(
            "get_database_content?channel=" + this.channelId + "&block_uuid=" + this.blockUuid,
            () => {}, "GET", false
        )

        if (request.status !== 200) {
            this.containerEl.innerHTML = '<div class="db-error">Failed to load database</div>'
            return
        }

        const data = JSON.parse(request.responseText)
        this.database = {
            id: data.id,
            name: data.name,
            view_type: data.view_type || 'table',
            gallery_cover_column: data.gallery_cover_column,
            source: data.source || 'manual',
            metric_key: data.metric_key || null,
            metric_spec: data.metric_spec || null,
            read_only: !!data.read_only
        }

        // Parse options once, sort by position
        this.columns = (data.columns || []).map(col => ({
            ...col,
            options: typeof col.options === 'string' ? JSON.parse(col.options) : (col.options || {})
        })).sort((a, b) => a.position - b.position)

        this.rows = (data.rows || []).sort((a, b) => a.position - b.position)
        this.cells = data.cells || {}

        // Prefetch relation display names
        this._prefetchRelationDisplays()

        this.render()

        // Computed databases: data arrives separately so the note paints first.
        if (this.database.source === 'computed' && this.database.metric_spec) {
            this._loadMetricData()
        }
    }

    _loadMetricData() {
        const spec = this.database.metric_spec
        xhr(
            "run_metric_spec?spec=" + encodeURIComponent(JSON.stringify(spec)),
            (ev) => {
                if (ev.target.status !== 200) return
                this._applyMetricData(JSON.parse(ev.target.responseText))
            },
            "GET", true
        )
    }

    _applyMetricData(data) {
        this.columns = (data.columns || []).map(col => ({
            ...col,
            options: typeof col.options === 'string' ? JSON.parse(col.options) : (col.options || {})
        })).sort((a, b) => a.position - b.position)
        this.rows = (data.rows || []).sort((a, b) => a.position - b.position)
        this.cells = data.cells || {}
        this.render()
    }

    // ─── Relation Display (batched) ───────────────────────────────────

    _prefetchRelationDisplays() {
        const relationCols = this.columns.filter(c => c.type === 'relation')
        if (relationCols.length === 0) return

        for (const col of relationCols) {
            const targetDbId = col.options.database_id
            if (!targetDbId) continue

            for (const row of this.rows) {
                const val = (this.cells[String(row.id)] || {})[String(col.id)]
                if (val) this._fetchRelationDisplay(targetDbId, val)
            }
        }
    }

    _fetchRelationDisplay(targetDbId, rowId) {
        const key = targetDbId + ':' + rowId
        if (this._relationDisplayCache[key] !== undefined) return this._relationDisplayCache[key]

        const request = xhr(
            "get_relation_display?database_id=" + targetDbId + "&row_id=" + rowId,
            () => {}, "GET", false
        )
        const display = request.status === 200
            ? JSON.parse(request.responseText).display
            : 'Row ' + rowId

        this._relationDisplayCache[key] = display
        return display
    }

    // ─── Cell Reference Resolver ──────────────────────────────────────

    _resolveCellRef(cellRef, dbName) {
        const match = cellRef.match(/^([A-Z]+)(\d+)$/)
        if (!match) return cellRef

        const colIdx = colLetterToIndex(match[1])
        const rowNum = parseInt(match[2]) - 1

        if (dbName) {
            return this._crossDbResolve(dbName, colIdx, rowNum)
        }

        if (colIdx >= this.columns.length) return ''
        const rows = this._getSortedRows()
        if (rowNum >= rows.length) return ''

        return (this.cells[String(rows[rowNum].id)] || {})[String(this.columns[colIdx].id)] || ''
    }

    _crossDbResolve(dbName, colIdx, rowNum) {
        // dbName is the database's human-readable name
        // We search database blocks in the same channel to find it
        const blocks = global.notes?.[this.channelId]?.blocks || {}

        for (const uuid in blocks) {
            if (blocks[uuid].type !== 'database') continue

            const view = global.state.databaseViews[uuid]
            if (view && view.database && view.database.name === dbName) {
                if (colIdx >= view.columns.length) return ''
                const rows = view._getSortedRows()
                if (rowNum >= rows.length) return ''
                return (view.cells[String(rows[rowNum].id)] || {})[String(view.columns[colIdx].id)] || ''
            }
        }

        // Not loaded yet — try fetching
        for (const uuid in blocks) {
            if (blocks[uuid].type !== 'database') continue
            if (global.state.databaseViews[uuid]) continue // already checked

            const req = xhr("get_database_content?channel=" + this.channelId + "&block_uuid=" + uuid, () => {}, "GET", false)
            if (req.status !== 200) continue

            const data = JSON.parse(req.responseText)
            if (data.name !== dbName) continue

            const cols = (data.columns || []).sort((a, b) => a.position - b.position)
            const rows = (data.rows || []).sort((a, b) => a.position - b.position)
            if (colIdx >= cols.length || rowNum >= rows.length) return ''
            return (data.cells[String(rows[rowNum].id)] || {})[String(cols[colIdx].id)] || ''
        }

        return ''
    }

    /** Computed databases, or edit-notes denied in the notes channel (access.mjs). */
    _readOnly() {
        return !!this.database.read_only || !window.checkChannelRight(this.channelId, 'note', 'edit-notes')
    }

    // ─── Rendering ────────────────────────────────────────────────────

    render() {
        if (!this.database) return

        const viewData = {
            blockUuid: this.blockUuid,
            name: this.database.name,
            isTable: this.database.view_type === 'table',
            isGallery: this.database.view_type === 'gallery',
            isComputed: this.database.source === 'computed',
            readOnly: this._readOnly(),
            isAdmin: !!(global.user && global.user.isAdmin),
        }

        let html = fillWith('database-header', [viewData])

        if (this.database.source === 'computed' && !this.columns.length) {
            html += '<div class="db-loading">Loading…</div>'
        } else if (this.database.view_type === 'gallery') {
            html += this._renderGallery()
        } else {
            html += this._renderTable()
        }

        this.containerEl.innerHTML = html
    }

    _renderTable() {
        const rows = this._getSortedRows()

        // Build data for fillWith
        const headerCols = this.columns.map((col, idx) => ({
            id: col.id,
            name: col.name,
            type: col.type,
            letter: colIndexToLetter(idx),
            typeIcon: this._typeIcon(col.type),
            sortIcon: this.sortColumn === col.id ? (this.sortDirection === 'asc' ? ' ↑' : ' ↓') : '⇅',
            blockUuid: this.blockUuid
        }))

        const readOnly = this._readOnly()

        let html = '<div class="db-table-wrapper"><table class="db-table">'
        html += '<thead><tr>'
        html += fillWith('database-column-header', headerCols)
        if (!readOnly) {
            html += '<th class="add-col"><button onclick="global.state.databaseViews[\'' + this.blockUuid + '\'].addColumn()">+</button></th>'
        }
        html += '</tr></thead>'

        html += '<tbody>'
        rows.forEach(row => {
            html += '<tr data-row-id="' + row.id + '">'
            this.columns.forEach(col => {
                const rawValue = (this.cells[String(row.id)] || {})[String(col.id)] || ''
                html += '<td data-col-id="' + col.id + '">' + this._renderCell(row.id, col, rawValue) + '</td>'
            })
            html += '<td></td></tr>'
        })
        html += '</tbody></table></div>'

        if (!readOnly) {
            html += '<button class="db-add-row" onclick="global.state.databaseViews[\'' + this.blockUuid + '\'].addRow()">+ New row</button>'
        }
        return html
    }

    _renderGallery() {
        const rows = this._getSortedRows()
        const titleCol = this.columns.find(c => c.type === 'text')

        const cards = rows.map(row => {
            const rowCells = this.cells[String(row.id)] || {}
            const title = titleCol ? (rowCells[String(titleCol.id)] || 'Untitled') : 'Untitled'

            let coverUrl = ''
            if (this.database.gallery_cover_column) {
                coverUrl = rowCells[String(this.database.gallery_cover_column)] || ''
            }

            const fields = this.columns.slice(0, 4)
                .filter(c => c !== titleCol && (rowCells[String(c.id)] || ''))
                .map(c => ({
                    label: c.name,
                    value: this._displayValue(c, rowCells[String(c.id)] || '')
                }))

            return { id: row.id, title, coverUrl, fields, blockUuid: this.blockUuid }
        })

        let html = '<div class="db-gallery">'
        html += fillWith('database-gallery-card', cards)
        if (!this._readOnly()) {
            html += '<div class="gallery-card gallery-add" onclick="global.state.databaseViews[\'' + this.blockUuid + '\'].addRow()">+ New</div>'
        }
        html += '</div>'
        return html
    }

    // ─── Cell Rendering ───────────────────────────────────────────────

    _renderCell(rowId, col, rawValue) {
        const b = 'global.state.databaseViews[\'' + this.blockUuid + '\']'

        // Computed / read-only databases: show static values, no inputs.
        if (this._readOnly()) {
            return '<span class="cell-static">' + this._esc(this._displayValue(col, rawValue)) + '</span>'
        }

        switch (col.type) {
            case 'text':
            case 'number':
                return '<input type="' + (col.type === 'number' ? 'number' : 'text') + '" '
                    + 'value="' + this._esc(rawValue) + '" '
                    + 'onchange="' + b + '.onCellEdit(' + rowId + ',' + col.id + ',this.value)" />'

            case 'checkbox':
                return '<input type="checkbox" ' + (rawValue === 'true' ? 'checked' : '') + ' '
                    + 'onchange="' + b + '.onCellEdit(' + rowId + ',' + col.id + ',this.checked?\'true\':\'false\')" />'

            case 'date':
                return '<input type="date" value="' + this._esc(rawValue) + '" '
                    + 'onchange="' + b + '.onCellEdit(' + rowId + ',' + col.id + ',this.value)" />'

            case 'select': {
                const choices = col.options.choices || []
                let html = '<select onchange="' + b + '.onCellEdit(' + rowId + ',' + col.id + ',this.value)">'
                html += '<option value="">—</option>'
                choices.forEach(opt => {
                    html += '<option value="' + this._esc(opt) + '"' + (opt === rawValue ? ' selected' : '') + '>' + this._esc(opt) + '</option>'
                })
                return html + '</select>'
            }

            case 'relation': {
                const display = this._displayValue(col, rawValue)
                let html = '<span class="cell-relation">'
                if (rawValue) {
                    html += '<span class="relation-chip">' + this._esc(display) + '</span>'
                    html += '<button class="relation-clear" onclick="' + b + '.onCellEdit(' + rowId + ',' + col.id + ',\'\')">×</button>'
                }
                html += '<button class="relation-pick" onclick="' + b + '.openRelationPicker(' + rowId + ',' + col.id + ',event)">🔗</button>'
                return html + '</span>'
            }

            case 'formula': {
                const result = this._evalFormula(col)
                const expr = col.options.formula || ''
                return '<span class="cell-formula" title="' + this._esc(expr) + '">' + this._esc(String(result)) + '</span>'
            }

            default:
                return '<input type="text" value="' + this._esc(rawValue) + '" '
                    + 'onchange="' + b + '.onCellEdit(' + rowId + ',' + col.id + ',this.value)" />'
        }
    }

    _displayValue(col, rawValue) {
        switch (col.type) {
            case 'checkbox': return rawValue === 'true' ? '✓' : '✗'
            case 'relation': {
                const targetDbId = col.options.database_id
                if (!targetDbId || !rawValue) return rawValue || ''
                return this._fetchRelationDisplay(targetDbId, rawValue)
            }
            case 'formula': return String(this._evalFormula(col))
            default: return rawValue
        }
    }

    _evalFormula(col) {
        const formula = col.options.formula || ''
        if (!formula) return ''

        const expr = formula.startsWith('=') || formula.startsWith('{{') ? formula : '=' + formula

        try {
            return evaluateFormula(expr, (ref, dbName) => this._resolveCellRef(ref, dbName))
        } catch (e) {
            console.error("Formula error:", e)
            return '#ERROR'
        }
    }

    // ─── Column Menu ──────────────────────────────────────────────────

    openColumnMenu(colId, event) {
        event.stopPropagation()
        if (this._readOnly()) return
        document.querySelectorAll('.col-menu').forEach(el => el.remove())

        const col = this.columns.find(c => c.id === colId)
        if (!col) return

        const menu = document.createElement('div')
        menu.className = 'col-menu'
        const b = 'global.state.databaseViews[\'' + this.blockUuid + '\']'

        const types = ['text', 'number', 'checkbox', 'date', 'select', 'relation', 'formula']
        let html = '<div class="col-menu-section">Type</div>'
        types.forEach(t => {
            html += '<div class="col-menu-item' + (t === col.type ? ' active' : '') + '" '
            html += 'onclick="' + b + '.changeColumnType(' + colId + ',\'' + t + '\')">'
            html += this._typeIcon(t) + ' ' + t + '</div>'
        })

        if (col.type === 'relation') {
            html += '<div class="col-menu-section">Target Database ID</div>'
            html += '<input class="col-menu-input" placeholder="Database ID" '
            html += 'value="' + (col.options.database_id || '') + '" '
            html += 'onchange="' + b + '.setColumnOption(' + colId + ',\'database_id\',this.value)" />'
        }

        if (col.type === 'formula') {
            html += '<div class="col-menu-section">Formula</div>'
            html += '<input class="col-menu-input" placeholder="e.g. SUM(A1:A3)" '
            html += 'value="' + this._esc(col.options.formula || '') + '" '
            html += 'onchange="' + b + '.setColumnOption(' + colId + ',\'formula\',this.value)" />'
        }

        if (col.type === 'select') {
            html += '<div class="col-menu-section">Choices (comma-separated)</div>'
            html += '<input class="col-menu-input" placeholder="Option1, Option2" '
            html += 'value="' + this._esc((col.options.choices || []).join(', ')) + '" '
            html += 'onchange="' + b + '.setSelectChoices(' + colId + ',this.value)" />'
        }

        html += '<div class="col-menu-divider"></div>'
        html += '<div class="col-menu-item col-menu-danger" onclick="' + b + '.deleteColumn(' + colId + ')">Delete column</div>'

        menu.innerHTML = html
        const rect = event.target.getBoundingClientRect()
        menu.style.position = 'fixed'
        menu.style.left = rect.left + 'px'
        menu.style.top = (rect.bottom + 4) + 'px'
        document.body.appendChild(menu)

        const close = (e) => {
            if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close) }
        }
        setTimeout(() => document.addEventListener('click', close), 0)
    }

    // ─── Relation Picker ──────────────────────────────────────────────

    openRelationPicker(rowId, colId, event) {
        event.stopPropagation()
        const col = this.columns.find(c => c.id === colId)
        if (!col) return

        const targetDbId = col.options.database_id
        if (!targetDbId) {
            alert('Configure a target database ID in the column menu first.')
            return
        }

        // Find the database view for the target
        const blocks = global.notes?.[this.channelId]?.blocks || {}
        let targetData = null

        for (const uuid in blocks) {
            if (blocks[uuid].type !== 'database') continue
            const view = global.state.databaseViews[uuid]
            if (view && String(view.database.id) === String(targetDbId)) {
                targetData = { columns: view.columns, rows: view.rows, cells: view.cells }
                break
            }
        }

        if (!targetData) {
            // Try loading each unloaded database block
            for (const uuid in blocks) {
                if (blocks[uuid].type !== 'database' || global.state.databaseViews[uuid]) continue
                const req = xhr("get_database_content?channel=" + this.channelId + "&block_uuid=" + uuid, () => {}, "GET", false)
                if (req.status !== 200) continue
                const d = JSON.parse(req.responseText)
                if (String(d.id) === String(targetDbId)) {
                    targetData = {
                        columns: (d.columns || []).sort((a, b) => a.position - b.position),
                        rows: (d.rows || []).sort((a, b) => a.position - b.position),
                        cells: d.cells || {}
                    }
                    break
                }
            }
        }

        if (!targetData) {
            alert('Target database not found in this channel.')
            return
        }

        // Build picker overlay
        document.querySelectorAll('.relation-picker-overlay').forEach(el => el.remove())
        const overlay = document.createElement('div')
        overlay.className = 'relation-picker-overlay'

        const titleCol = targetData.columns.find(c => c.type === 'text')
        const b = 'global.state.databaseViews[\'' + this.blockUuid + '\']'

        let html = '<div class="relation-picker-list">'
        targetData.rows.forEach(row => {
            const cells = targetData.cells[String(row.id)] || {}
            const title = titleCol ? (cells[String(titleCol.id)] || 'Untitled') : 'Row ' + row.id
            html += '<div class="relation-picker-item" '
            html += 'onclick="' + b + '.onCellEdit(' + rowId + ',' + colId + ',\'' + row.id + '\');'
            html += 'this.closest(\'.relation-picker-overlay\').remove()">'
            html += this._esc(title) + '</div>'
        })
        html += '</div>'
        overlay.innerHTML = html

        const rect = event.target.getBoundingClientRect()
        overlay.style.position = 'fixed'
        overlay.style.left = rect.left + 'px'
        overlay.style.top = (rect.bottom + 4) + 'px'
        document.body.appendChild(overlay)

        const close = (e) => {
            if (!overlay.contains(e.target)) { overlay.remove(); document.removeEventListener('click', close) }
        }
        setTimeout(() => document.addEventListener('click', close), 0)
    }

    // ─── Actions ──────────────────────────────────────────────────────

    onTitleChange(event) {
        this.database.name = event.target.value
        this._saveDb({id: this.database.id, name: this.database.name})
    }

    switchView(viewType) {
        this.database.view_type = viewType
        this._saveDb({id: this.database.id, view_type: viewType})
        this.render()
    }

    // ─── Live metrics (computed databases) ────────────────────────────

    // Re-pull live data (fresh-on-open; metrics keep no history).
    refresh() {
        this.load()
    }

    // Open the catalog-driven metric builder (admin-only; server enforces too).
    openMetricBuilder(event) {
        event.stopPropagation()
        if (!(global.user && global.user.isAdmin)) return

        if (!this._catalog) {
            const req = xhr("describe_datasets", () => {}, "GET", false)
            if (req.status !== 200) return
            this._catalog = JSON.parse(req.responseText)
        }

        // Seed builder state from the current spec, else the first dataset.
        const cur = this.database.metric_spec
        if (cur && cur.dataset) {
            this._builder = this._builderFromSpec(cur)
        } else {
            const first = this._catalog.datasets[0]
            this._builder = {
                dataset: first ? first.key : null,
                dimensions: new Set(), measures: new Set(), sinceDays: 0, limit: null,
            }
        }

        document.querySelectorAll('.metric-builder-overlay').forEach(el => el.remove())
        const overlay = document.createElement('div')
        overlay.className = 'metric-builder-overlay'
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
        this._builderOverlay = overlay
        document.body.appendChild(overlay)
        this._renderBuilder()
    }

    _builderFromSpec(s) {
        const since = (s.filters || []).find(f => f.field === 'since' && f.op === 'last_days')
        return {
            dataset: s.dataset,
            dimensions: new Set(s.dimensions || []),
            measures: new Set(s.measures || []),
            sinceDays: since ? since.value : 0,
            limit: s.limit || null,
        }
    }

    _renderBuilder() {
        const o = this._builderOverlay
        if (!o) return
        const b = this._builder
        const ref = "global.state.databaseViews['" + this.blockUuid + "']"
        const ds = this._catalog.datasets.find(d => d.key === b.dataset)

        let h = '<div class="metric-builder" onclick="event.stopPropagation()">'
        h += '<div class="mb-head"><h3>⚡ Live metric</h3>'
        h += '<button class="mb-close" onclick="this.closest(\'.metric-builder-overlay\').remove()">×</button></div>'

        h += '<label class="mb-label">Preset</label>'
        h += '<select class="mb-select" onchange="' + ref + '.builderLoadPreset(this.value)">'
        h += '<option value="">— custom —</option>'
        this._catalog.presets.forEach(p => {
            h += '<option value="' + p.key + '">' + this._esc(p.name) + '</option>'
        })
        h += '</select>'

        h += '<label class="mb-label">Dataset</label>'
        h += '<select class="mb-select" onchange="' + ref + '.builderSetDataset(this.value)">'
        this._catalog.datasets.forEach(d => {
            h += '<option value="' + d.key + '"' + (d.key === b.dataset ? ' selected' : '') + '>' + this._esc(d.label) + '</option>'
        })
        h += '</select>'

        if (ds && ds.provider) {
            h += '<div class="mb-note">Live server snapshot — no configuration needed.</div>'
        } else if (ds) {
            if (ds.dimensions.length) {
                h += '<label class="mb-label">Group by</label><div class="mb-chips">'
                ds.dimensions.forEach(dim => {
                    const on = b.dimensions.has(dim.key)
                    h += '<label class="mb-chip' + (on ? ' on' : '') + '">'
                    h += '<input type="checkbox"' + (on ? ' checked' : '') + ' onchange="' + ref + '.builderToggle(\'dim\',\'' + dim.key + '\')"> '
                    h += this._esc(dim.label) + '</label>'
                })
                h += '</div>'
            }

            h += '<label class="mb-label">Measure</label><div class="mb-chips">'
            ds.measures.forEach(m => {
                const on = b.measures.has(m.key)
                h += '<label class="mb-chip' + (on ? ' on' : '') + '">'
                h += '<input type="checkbox"' + (on ? ' checked' : '') + ' onchange="' + ref + '.builderToggle(\'measure\',\'' + m.key + '\')"> '
                h += this._esc(m.label) + '</label>'
            })
            h += '</div>'

            const hasSince = ds.filters.some(f => f.key === 'since' && f.ops.includes('last_days'))
            if (hasSince) {
                h += '<label class="mb-label">Date range</label>'
                h += '<select class="mb-select" onchange="' + ref + '.builderSetSince(this.value)">'
                ;[['0', 'All time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']].forEach(opt => {
                    h += '<option value="' + opt[0] + '"' + (String(b.sinceDays) === opt[0] ? ' selected' : '') + '>' + opt[1] + '</option>'
                })
                h += '</select>'
            }
        }

        h += '<div class="mb-actions">'
        h += '<button class="mb-btn" onclick="' + ref + '.builderPreview()">Preview</button>'
        h += '<button class="mb-btn primary" onclick="' + ref + '.builderApply()">Apply</button>'
        if (this.database.source === 'computed') {
            h += '<button class="mb-btn danger" onclick="' + ref + '.builderDisable()">Turn off</button>'
        }
        h += '</div>'
        h += '<div class="mb-preview" id="mb-preview-' + this.blockUuid + '"></div>'
        h += '</div>'
        o.innerHTML = h
    }

    builderSetDataset(key) {
        this._builder.dataset = key
        this._builder.dimensions = new Set()
        this._builder.measures = new Set()
        this._renderBuilder()
    }

    builderToggle(kind, key) {
        const set = kind === 'dim' ? this._builder.dimensions : this._builder.measures
        if (set.has(key)) set.delete(key); else set.add(key)
        this._renderBuilder()
    }

    builderSetSince(value) {
        this._builder.sinceDays = parseInt(value) || 0
    }

    builderLoadPreset(key) {
        if (!key) return
        const p = this._catalog.presets.find(x => x.key === key)
        if (p) { this._builder = this._builderFromSpec(p.spec); this._renderBuilder() }
    }

    _currentDataset() {
        return this._catalog.datasets.find(d => d.key === this._builder.dataset)
    }

    _specFromBuilder() {
        const b = this._builder
        const ds = this._currentDataset()
        if (ds && ds.provider) return {dataset: b.dataset}
        const spec = {dataset: b.dataset, dimensions: [...b.dimensions], measures: [...b.measures]}
        if (b.sinceDays) spec.filters = [{field: 'since', op: 'last_days', value: b.sinceDays}]
        if (b.dimensions.size) spec.order = [{by: [...b.dimensions][0], dir: 'asc'}]
        if (b.limit) spec.limit = b.limit
        return spec
    }

    builderPreview() {
        const el = document.getElementById('mb-preview-' + this.blockUuid)
        const ds = this._currentDataset()
        const spec = this._specFromBuilder()
        if (!(ds && ds.provider) && !spec.measures.length) { el.innerHTML = '<div class="mb-err">Pick at least one measure.</div>'; return }
        const req = xhr("run_metric_spec?spec=" + encodeURIComponent(JSON.stringify(spec)), () => {}, "GET", false)
        if (req.status !== 200) { el.innerHTML = '<div class="mb-err">Invalid metric.</div>'; return }
        el.innerHTML = this._previewTable(JSON.parse(req.responseText))
    }

    _previewTable(d) {
        if (!d.rows.length) return '<div class="mb-empty">No rows.</div>'
        let h = '<table class="mb-table"><thead><tr>'
        d.columns.forEach(c => h += '<th>' + this._esc(c.name) + '</th>')
        h += '</tr></thead><tbody>'
        d.rows.slice(0, 50).forEach(r => {
            h += '<tr>'
            d.columns.forEach(c => h += '<td>' + this._esc((d.cells[String(r.id)] || {})[String(c.id)] || '') + '</td>')
            h += '</tr>'
        })
        return h + '</tbody></table>'
    }

    builderApply() {
        const ds = this._currentDataset()
        const spec = this._specFromBuilder()
        if (!(ds && ds.provider) && !spec.measures.length) return
        this._saveDbSync({id: this.database.id, source: 'computed', metric_key: null, metric_spec: spec})
        if (this._builderOverlay) this._builderOverlay.remove()
        this.load()
    }

    builderDisable() {
        this._saveDbSync({id: this.database.id, source: 'manual'})
        if (this._builderOverlay) this._builderOverlay.remove()
        this.load()
    }

    addColumn() {
        const lastCol = this.columns.length > 0 ? this.columns[this.columns.length - 1] : null
        const position = lastCol ? lastCol.position + 0.1 : 0.1

        const request = xhr(
            "/save_database_column?channel=" + this.channelId
            + "&database_id=" + this.database.id
            + "&column=" + encodeURIComponent(JSON.stringify({name: "Column", type: "text", position}))
            + "&op=create",
            () => {}, "GET", false
        )
        if (request.status === 200) this.load()
    }

    deleteColumn(colId) {
        xhr("/save_database_column?channel=" + this.channelId
            + "&database_id=" + this.database.id
            + "&column=" + encodeURIComponent(JSON.stringify({id: colId}))
            + "&op=delete", () => {})
        this.columns = this.columns.filter(c => c.id !== colId)
        document.querySelectorAll('.col-menu').forEach(el => el.remove())
        this.render()
    }

    onColumnRename(colId, event) {
        const col = this.columns.find(c => c.id === colId)
        if (!col) return
        col.name = event.target.value
        this._saveCol(colId, {name: col.name})
    }

    changeColumnType(colId, newType) {
        const col = this.columns.find(c => c.id === colId)
        if (!col) return
        col.type = newType
        this._saveCol(colId, {type: newType})
        document.querySelectorAll('.col-menu').forEach(el => el.remove())
        this.render()
    }

    setColumnOption(colId, key, value) {
        const col = this.columns.find(c => c.id === colId)
        if (!col) return
        col.options[key] = value
        this._saveCol(colId, {options: col.options})
    }

    setSelectChoices(colId, choicesStr) {
        const choices = choicesStr.split(',').map(s => s.trim()).filter(Boolean)
        this.setColumnOption(colId, 'choices', choices)
    }

    addRow() {
        const lastRow = this.rows.length > 0 ? this.rows[this.rows.length - 1] : null
        const position = lastRow ? lastRow.position + 0.1 : 0.1

        const request = xhr(
            "/save_database_row?channel=" + this.channelId
            + "&database_id=" + this.database.id
            + "&row=" + encodeURIComponent(JSON.stringify({position}))
            + "&op=create",
            () => {}, "GET", false
        )
        if (request.status === 200) this.load()
    }

    deleteRow(rowId) {
        xhr("/save_database_row?channel=" + this.channelId
            + "&database_id=" + this.database.id
            + "&row=" + encodeURIComponent(JSON.stringify({id: rowId}))
            + "&op=delete", () => {})
        this.rows = this.rows.filter(r => r.id !== rowId)
        delete this.cells[String(rowId)]
        this.render()
    }

    onCellEdit(rowId, colId, value) {
        if (!this.cells[String(rowId)]) this.cells[String(rowId)] = {}
        this.cells[String(rowId)][String(colId)] = value

        xhr("/save_database_cell?channel=" + this.channelId
            + "&database_id=" + this.database.id
            + "&cell=" + encodeURIComponent(JSON.stringify({row_id: rowId, column_id: colId, value})),
            () => {})

        // Invalidate relation cache for this cell if it's a relation column
        const col = this.columns.find(c => c.id === colId)
        if (col && col.type === 'relation' && col.options.database_id) {
            delete this._relationDisplayCache[col.options.database_id + ':' + value]
        }

        // Re-render if there are formula columns (they may depend on this cell)
        if (this.columns.some(c => c.type === 'formula')) {
            this.render()
        }
    }

    toggleSort(colId) {
        if (this.sortColumn === colId) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc'
        } else {
            this.sortColumn = colId
            this.sortDirection = 'asc'
        }
        this.render()
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    _getSortedRows() {
        let rows = [...this.rows]

        if (this.sortColumn) {
            rows.sort((a, b) => {
                const aVal = (this.cells[String(a.id)] || {})[String(this.sortColumn)] || ''
                const bVal = (this.cells[String(b.id)] || {})[String(this.sortColumn)] || ''
                const aNum = parseFloat(aVal)
                const bNum = parseFloat(bVal)
                const cmp = (!isNaN(aNum) && !isNaN(bNum)) ? aNum - bNum : aVal.localeCompare(bVal)
                return this.sortDirection === 'asc' ? cmp : -cmp
            })
        }

        return rows
    }

    _saveDb(data) {
        xhr("/save_database?channel=" + this.channelId
            + "&database=" + encodeURIComponent(JSON.stringify(data))
            + "&op=edit", () => {})
    }

    // Synchronous edit — used before an immediate reload so the change is
    // committed before load() re-fetches (avoids a read-before-write race).
    _saveDbSync(data) {
        xhr("/save_database?channel=" + this.channelId
            + "&database=" + encodeURIComponent(JSON.stringify(data))
            + "&op=edit", () => {}, "GET", false)
    }

    _saveCol(colId, data) {
        xhr("/save_database_column?channel=" + this.channelId
            + "&database_id=" + this.database.id
            + "&column=" + encodeURIComponent(JSON.stringify({id: colId, ...data}))
            + "&op=edit", () => {})
    }

    _esc(str) {
        if (str === null || str === undefined) return ''
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }

    _typeIcon(type) {
        return {text:'Aa', number:'#', checkbox:'☑', date:'📅', select:'▾', relation:'🔗', formula:'ƒ'}[type] || '?'
    }
}

/**
 * Create and mount a DatabaseView for a note block.
 */
export function mountDatabase(blockUuid, channelId, containerEl) {
    const view = new DatabaseView(blockUuid, channelId, containerEl)
    global.state.databaseViews[blockUuid] = view
    return view
}

