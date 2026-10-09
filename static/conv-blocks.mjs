import global from "./framework/global.mjs"
import {xhr} from "./framework/templating.mjs"
import {handleMessageGroup} from "./crud.mjs"
import {addElement} from "./framework/vesta.mjs"
import {mountSpreadsheet} from "./workspaces/spreadsheet.mjs"

// ── Category picker ────────────────────────────────────────────────────────
function selectBlockCategory(catName) {
    const modal = document.getElementById('create-block')
    if (!modal) return
    modal.querySelectorAll('.block-cat-item').forEach(el =>
        el.classList.toggle('selected', el.dataset.cat === catName))
    modal.querySelectorAll('.block-option-group').forEach(el =>
        el.style.display = el.dataset.for === catName ? '' : 'none')
}
window.selectBlockCategory = selectBlockCategory

// ── Insert block ───────────────────────────────────────────────────────────
function insertConvBlock(blockType, template = 'empty') {
    closeFM()
    closeMenu('#create-block')
    const convId = global.state.activeConv
    const onload = function () {
        const response = JSON.parse(this.responseText)
        const msg = response.message
        if (typeof msg.attachments === 'string') {
            try { msg.attachments = JSON.parse(msg.attachments) } catch(e) { msg.attachments = [] }
        }
        handleMessageGroup(msg)
        addElement('global.convs[' + convId + '].messages', msg)
    }
    xhr("send_message?conv=" + encodeURI(JSON.stringify({id: convId})) + "&content=",
        onload, "POST", true, {conv_block: {type: blockType, template}})
}
window.insertConvBlock = insertConvBlock

// ── Mount all unmounted conv spreadsheets in a container ──────────────────
function mountAllConvSpreadsheets(containerEl) {
    if (!containerEl) return
    const targets = containerEl.querySelectorAll(
        '.conv-spreadsheet-container[data-block-id]:not([data-mounted])')
    for (const el of targets) {
        const uuid   = el.dataset.blockId
        const convId = el.dataset.convId
        el.dataset.mounted = '1'
        mountSpreadsheet(uuid, null, el, convId)
    }
}
window.mountAllConvSpreadsheets = mountAllConvSpreadsheets

// ── Check helper for message.html ─────────────────────────────────────────
function isConvSpreadsheetMessage(element) {
    if (element.convSpreadsheet) return true
    let atts = element.attachments
    if (typeof atts === 'string') { try { atts = JSON.parse(atts) } catch(e) { return false } }
    return Array.isArray(atts) && atts.some(a => a?.type === 'conv_spreadsheet')
}
window.isConvSpreadsheetMessage = isConvSpreadsheetMessage

// ── Get block uuid from message ───────────────────────────────────────────
function getConvSpreadsheetUuid(element) {
    if (element.convSpreadsheet?.uuid) return element.convSpreadsheet.uuid
    let atts = element.attachments
    if (typeof atts === 'string') { try { atts = JSON.parse(atts) } catch(e) { return '' } }
    return (Array.isArray(atts) && atts.find(a => a?.type === 'conv_spreadsheet')?.uuid) || ''
}
window.getConvSpreadsheetUuid = getConvSpreadsheetUuid
