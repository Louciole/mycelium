// ─── Slash commands in the message composer ──────────────────────────────────
// Typing "/" at the very start of a message opens the command list. Two kinds
// of commands:
//   • "text"   — expanded HERE before sending: the server only ever receives
//                the final text (/shrug → ¯\_(ツ)_/¯).
//   • "server" — the message is sent as typed ("/d 6") along with a structured
//                `command`; send_message posts it, then runs the command and
//                posts the result as a system notice (the server rolls, so
//                nobody can forge a result).

const SHRUG = '¯\\_(ツ)_/¯'
const TABLEFLIP = '(╯°□°)╯︵ ┻━┻'
const UNFLIP = '┬─┬ノ( º _ ºノ)'

// Bounds mirrored from routes/messaging.py, which re-checks them
const DICE_MAX_COUNT = 20
const DICE_MIN_FACES = 2
const DICE_MAX_FACES = 1000

// "/shrug" alone sends the emoji alone, "/shrug text" appends it to the text
const appendTo = emoji => rest => rest ? rest + ' ' + emoji : emoji
const describeAppend = emoji => () => _t("Ajoute {emoji} à ton message").replace('{emoji}', emoji)

// "20", "d20" → one d20 ; "2d6" → two d6
function parseDice(arg) {
    const m = arg.trim().match(/^(?:(\d+)?d)?(\d+)$/i)
    if (!m) return {error: _t("Format : 20, d20 ou 2d6")}
    const count = m[1] ? parseInt(m[1], 10) : 1
    const faces = parseInt(m[2], 10)
    if (count < 1 || count > DICE_MAX_COUNT) return {error: _t("Entre 1 et {max} dés").replace('{max}', DICE_MAX_COUNT)}
    if (faces < DICE_MIN_FACES || faces > DICE_MAX_FACES) {
        return {error: _t("Un dé a entre {min} et {max} faces").replace('{min}', DICE_MIN_FACES).replace('{max}', DICE_MAX_FACES)}
    }
    return {count, faces}
}

const COMMANDS = [
    {name: 'shrug',     kind: 'text', icon: 'emoji', description: describeAppend(SHRUG),     expand: appendTo(SHRUG)},
    {name: 'tableflip', kind: 'text', icon: 'emoji', description: describeAppend(TABLEFLIP), expand: appendTo(TABLEFLIP)},
    {name: 'unflip',    kind: 'text', icon: 'emoji', description: describeAppend(UNFLIP),    expand: appendTo(UNFLIP)},
    {
        name: 'd', kind: 'server', command: 'dice', icon: 'dice',
        attachedArg: true,   // "/d20" works as well as "/d 20"
        args: () => _t("faces"),
        description: () => _t("Lance des dés, ex. 20 ou 2d6"),
        parse: parseDice,
        preview: ({count, faces}) => '🎲 ' + _t("Lancer {dice}").replace('{dice}', (count > 1 ? count : '') + 'd' + faces),
        presets: ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100', '2d6'],
        defaultPreset: 'd20',
    },
]

// "/d 2d6" → {cmd, rest: " 2d6"} ; null when the text isn't a known command
function matchCommand(text) {
    const m = text.match(/^\/([a-z]+)([\s\S]*)$/i)
    if (!m) return null
    const cmd = COMMANDS.find(c => c.name === m[1].toLowerCase())
    if (!cmd) return null
    const rest = m[2]
    if (rest === '' || /^\s/.test(rest) || (cmd.attachedArg && /^\d/.test(rest))) return {cmd, rest}
    return null
}

/**
 * What sending `text` should do: null for a plain message, {text} once a text
 * command is expanded, {command} for a server command, {error} if it's invalid.
 */
export function resolveSlashCommand(text) {
    const match = matchCommand(text)
    if (!match) return null
    const {cmd, rest} = match
    if (cmd.kind === 'text') return {text: cmd.expand(rest.trim())}
    const parsed = cmd.parse(rest)
    return parsed.error ? {error: parsed.error} : {command: {name: cmd.command, ...parsed}}
}

// ─── Menu ────────────────────────────────────────────────────────────────────
// Same mechanics as the @ autocomplete (mentions.mjs): a popup inserted in the
// composer's column right before .chat-wrapper, created on demand and removed
// on close. Its content comes from the slash-command-item / slash-menu-arg templates.

let popup = null          // the popup element while the menu is open
let menu = null           // what it shows: {mode: 'name'|'arg', items, selectedIndex, pick, …}
let dismissedFor = null   // composer text when Escape was pressed: stay closed until it changes

function setComposer(textarea, value) {
    textarea.value = value
    textarea.selectionStart = textarea.selectionEnd = value.length
    window.resizeHeight?.(undefined, textarea)
    window.updateSendButton?.(textarea)
    textarea.focus()
}

function render(textarea) {
    // isConnected: the view may have been re-rendered (conv switch) since it was opened
    if (!popup?.isConnected) {
        popup = document.createElement("div")
        popup.className = "mention-autocomplete slash-autocomplete"
        const wrapper = textarea.closest(".chat-wrapper")
        if (wrapper?.parentElement) {
            wrapper.parentElement.insertBefore(popup, wrapper)
        } else {
            textarea.parentElement.appendChild(popup)
        }
    }
    popup.classList.toggle("arg-mode", menu.mode === 'arg')
    popup.innerHTML = menu.mode === 'arg'
        ? fillWith('slash-menu-arg', [menu])
        : fillWith('slash-command-item', menu.items.map(item => ({...item, selected: item.index === menu.selectedIndex})))
    popup.style.display = "flex"
}

export function closeSlashMenu() {
    popup?.remove()
    popup = null
    menu = null
}

function updateMenu(textarea, force = false) {
    const text = textarea.value
    if (force) dismissedFor = null
    if (dismissedFor !== null) {
        if (text === dismissedFor) return
        dismissedFor = null
    }
    if (!text.startsWith('/')) return closeSlashMenu()

    const match = matchCommand(text)
    if (match?.cmd.parse && match.rest !== '') return showArgMenu(textarea, match.cmd, match.rest.trim())

    // Still typing the command name
    const query = text.slice(1).toLowerCase()
    const cmds = /^[a-z]*$/.test(query) ? COMMANDS.filter(c => c.name.startsWith(query)) : []
    if (cmds.length === 0) return closeSlashMenu()
    showNameMenu(textarea, cmds, query)
}

function showNameMenu(textarea, cmds, query) {
    // Keep the highlighted command while filtering; an exact name match wins
    const exact = cmds.findIndex(c => c.name === query)
    const selectedIndex = exact >= 0 ? exact : menu?.mode === 'name' ? Math.min(menu.selectedIndex, cmds.length - 1) : 0
    menu = {
        mode: 'name', query, selectedIndex,
        items: cmds.map((c, i) => ({
            index: i, name: c.name, label: '/' + c.name, icon: c.icon,
            args: c.args?.(), description: c.description(),
        })),
        pick: item => pickCommand(textarea, item.name),
    }
    render(textarea)
}

function showArgMenu(textarea, cmd, arg) {
    const presetOf = value => cmd.presets.findIndex(p => p === value.toLowerCase() || p === 'd' + value)
    // Nothing typed yet: highlight a preset that Enter will roll
    const selectedIndex = arg !== '' ? presetOf(arg)
        : menu?.mode === 'arg' && menu.selectedIndex >= 0 ? menu.selectedIndex
        : cmd.presets.indexOf(cmd.defaultPreset)
    const parsed = cmd.parse(arg !== '' ? arg : cmd.presets[selectedIndex])
    menu = {
        mode: 'arg', arg, selectedIndex,
        command: {label: '/' + cmd.name, args: cmd.args(), description: cmd.description()},
        // a single die is written "/d 20" in the message, several "/d 2d6"
        items: cmd.presets.map((p, i) => ({index: i, label: p, value: p.replace(/^d/, '')})),
        preview: parsed.error ? '' : cmd.preview(parsed),
        error: parsed.error,
        pick: item => fillArg(textarea, cmd, item.value),
    }
    render(textarea)
}

function pickCommand(textarea, name) {
    setComposer(textarea, '/' + name + ' ')
    updateMenu(textarea)   // → argument mode for /d, closed for text commands
}

function fillArg(textarea, cmd, value) {
    setComposer(textarea, '/' + cmd.name + ' ' + value)
    updateMenu(textarea)
}

// Called by sendCurrentMessage when the command can't be sent as is
export function showSlashError(textarea) {
    updateMenu(textarea, true)
}

// ─── Composer event handlers (inline attributes of the composer templates) ───

window.slashOnInput = function(event) {
    updateMenu(event.currentTarget)
}

/**
 * Keyboard navigation in the menu. Returns true when the event was consumed
 * (the caller must not process it further).
 */
window.slashOnKeyDown = function(event) {
    if (!menu) return false
    const textarea = event.currentTarget
    const n = menu.items.length
    const step = delta => menu.selectedIndex < 0 ? (delta > 0 ? 0 : n - 1) : (menu.selectedIndex + delta + n) % n

    if (event.key === 'Escape') {
        event.preventDefault()
        dismissedFor = textarea.value
        closeSlashMenu()
        return true
    }

    if (menu.mode === 'name') {
        const item = menu.items[menu.selectedIndex]
        switch (event.key) {
            case 'ArrowDown':
            case 'ArrowUp':
                event.preventDefault()
                menu.selectedIndex = step(event.key === 'ArrowDown' ? 1 : -1)
                render(textarea)
                return true
            case 'Tab':
                event.preventDefault()
                pickCommand(textarea, item.name)
                return true
            case 'Enter':
                if (event.shiftKey) return false
                event.preventDefault()
                // A fully typed command without argument is sent right away
                if (menu.query === item.name && !COMMANDS.find(c => c.name === item.name).parse) {
                    window.sendCurrentMessage(textarea)
                } else {
                    pickCommand(textarea, item.name)
                }
                return true
        }
        return false
    }

    // Argument mode: arrows walk the presets (←/→ only when they don't move the caret
    // inside a custom value), Enter rolls what's typed or the highlighted preset
    const cmd = matchCommand(textarea.value)?.cmd
    if (!cmd) return false
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || (horizontal && (menu.arg === '' || menu.selectedIndex >= 0))) {
        event.preventDefault()
        const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight'
        fillArg(textarea, cmd, menu.items[step(forward ? 1 : -1)].value)
        return true
    }
    if (event.key === 'Tab') {
        event.preventDefault()
        if (menu.selectedIndex >= 0) fillArg(textarea, cmd, menu.items[menu.selectedIndex].value)
        return true
    }
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        if (menu.arg === '' && menu.selectedIndex >= 0) fillArg(textarea, cmd, menu.items[menu.selectedIndex].value)
        if (!menu?.error) window.sendCurrentMessage(textarea)
        return true
    }
    return false
}

window.slashOnBlur = function() {
    // Delayed so a click in the menu (mousedown) is handled first, like mentionOnBlur
    const popupAtBlur = popup
    setTimeout(() => { if (popup && popup === popupAtBlur) closeSlashMenu() }, 150)
}

// Click on a command or a dice preset
window.slashPick = function(index) {
    const item = menu?.items?.[index]
    if (item) menu.pick(item)
}
