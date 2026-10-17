/**
 * In-app replacements for the browser's alert() / confirm() / prompt().
 *
 *   await uiAlert(message, {title, okLabel})                                   → undefined
 *   await uiConfirm(message, {title, confirmLabel, cancelLabel, danger})        → true | false
 *   await uiPrompt(message, {title, value, placeholder, confirmLabel, cancelLabel,
 *                            type, maxLength, required})                        → string | null
 *
 * All three are also on window (inline handlers, modules that can't import this one).
 * Messages are plain text (newlines are kept), never HTML.
 *
 * Only one dialog is shown at a time: calls made while one is open are queued and
 * shown in order once it closes. Enter confirms, Escape (or a click on the backdrop)
 * cancels, Tab stays inside the dialog, and the focus goes back where it was once
 * the queue is empty. While a dialog is open, keydowns don't reach the page's own
 * shortcuts (Ctrl+K, the drive's Delete/Enter…).
 *
 * Selectors (tests): #ui-dialog (role=dialog|alertdialog, data-kind=alert|confirm|prompt),
 * .ui-dialog-message, .ui-dialog-input, .ui-dialog-confirm, .ui-dialog-cancel.
 */

const queue = []
let current = null          // {kind, message, opts, resolve}
let backdrop = null         // .ui-dialog-backdrop, kept while the queue isn't empty
let restoreFocus = null     // element focused before the first dialog of the queue

function t(key){
    return window._t ? window._t(key) : key
}

function enqueue(kind, message, opts){
    return new Promise(resolve => {
        queue.push({kind, message: message == null ? "" : String(message), opts: opts || {}, resolve})
        if (!current) showNext()
    })
}

export function uiAlert(message, opts){ return enqueue("alert", message, opts) }
export function uiConfirm(message, opts){ return enqueue("confirm", message, opts) }
export function uiPrompt(message, opts){ return enqueue("prompt", message, opts) }
window.uiAlert = uiAlert
window.uiConfirm = uiConfirm
window.uiPrompt = uiPrompt

function el(tag, className, text){
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
}

function showNext(){
    current = queue.shift() || null
    if (!current){
        backdrop?.remove()
        backdrop = null
        document.removeEventListener("keydown", onKeydown, true)
        if (restoreFocus?.isConnected) restoreFocus.focus({preventScroll: true})
        restoreFocus = null
        return
    }
    if (!backdrop){
        restoreFocus = document.activeElement
        backdrop = el("div", "ui-dialog-backdrop")
        // mousedown + click on the backdrop itself: a text selection dragged out of the input doesn't cancel
        let downOnBackdrop = false
        backdrop.addEventListener("mousedown", e => { downOnBackdrop = e.target === backdrop })
        backdrop.addEventListener("click", e => { if (e.target === backdrop && downOnBackdrop) close(false) })
        document.body.appendChild(backdrop)
        document.addEventListener("keydown", onKeydown, true)
    }
    backdrop.replaceChildren(render(current))
    focusInitial()
}

function render({kind, message, opts}){
    const dialog = el("div", "ui-dialog" + (opts.danger ? " danger" : ""))
    dialog.id = "ui-dialog"
    dialog.dataset.kind = kind
    dialog.setAttribute("role", kind === "prompt" ? "dialog" : "alertdialog")
    dialog.setAttribute("aria-modal", "true")

    if (opts.title){
        const title = el("h2", "ui-dialog-title", opts.title)
        title.id = "ui-dialog-title"
        dialog.appendChild(title)
    }
    const msg = el("p", "ui-dialog-message", message)
    msg.id = "ui-dialog-message"
    dialog.appendChild(msg)
    dialog.setAttribute("aria-labelledby", opts.title ? "ui-dialog-title" : "ui-dialog-message")
    if (opts.title) dialog.setAttribute("aria-describedby", "ui-dialog-message")

    const confirmBtn = el("button", "ui-dialog-confirm",
        opts.confirmLabel || opts.okLabel || (kind === "confirm" ? t("Confirm") : t("OK")))
    confirmBtn.type = "button"
    confirmBtn.addEventListener("click", () => close(true))

    if (kind === "prompt"){
        const input = el("input", "ui-dialog-input")
        input.type = opts.type || "text"
        input.value = opts.value == null ? "" : String(opts.value)
        if (opts.placeholder) input.placeholder = opts.placeholder
        if (opts.maxLength) input.maxLength = opts.maxLength
        input.setAttribute("aria-labelledby", "ui-dialog-message")
        input.autocomplete = "off"
        if (opts.required){
            const sync = () => { confirmBtn.disabled = !input.value.trim() }
            input.addEventListener("input", sync)
            sync()
        }
        dialog.appendChild(input)
    }

    const actions = el("div", "ui-dialog-actions")
    if (kind !== "alert"){
        const cancelBtn = el("button", "ui-dialog-cancel", opts.cancelLabel || t("Cancel"))
        cancelBtn.type = "button"
        cancelBtn.addEventListener("click", () => close(false))
        actions.appendChild(cancelBtn)
    }
    actions.appendChild(confirmBtn)
    dialog.appendChild(actions)
    return dialog
}

function focusInitial(){
    const target = backdrop.querySelector(".ui-dialog-input") || backdrop.querySelector(".ui-dialog-confirm")
    target.focus({preventScroll: true})
    if (target.select) target.select()
}

function close(confirmed){
    if (!current) return
    const {kind, resolve} = current
    if (confirmed && backdrop.querySelector(".ui-dialog-confirm").disabled) return
    if (kind === "alert") resolve(undefined)
    else if (kind === "confirm") resolve(confirmed)
    else resolve(confirmed ? backdrop.querySelector(".ui-dialog-input").value : null)
    showNext()
}

function onKeydown(event){
    if (!current) return
    // The dialog is modal: the page's own shortcuts must not run behind it
    event.stopPropagation()
    if (event.isComposing) return
    if (event.key === "Escape"){
        event.preventDefault()
        close(false)
    } else if (event.key === "Enter" && !event.shiftKey){
        event.preventDefault()
        close(!event.target.classList?.contains("ui-dialog-cancel"))
    } else if (event.key === "Tab"){
        const focusables = [...backdrop.querySelectorAll("input, button:not([disabled])")]
        const i = focusables.indexOf(document.activeElement)
        const next = event.shiftKey ? (i <= 0 ? focusables.length - 1 : i - 1) : (i + 1) % focusables.length
        event.preventDefault()
        focusables[next]?.focus()
    }
}
