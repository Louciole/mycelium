// ─── System notifications in conversations ───────────────────────────────────
// "Lou a lancé un d20 et a obtenu 17." — one-line notices rendered by
// templates/system-message.html instead of a regular chat bubble.
//
// They are regular `message` rows whose attachments carry
// {type: "system", kind, icon, params} (see post_system_message server-side).
// The sentence is built HERE from kind + params so it follows the viewer's
// language; `body` only holds a language-neutral fallback (push, search).
//
// To add a new kind (call ended, member added, rename…): add an entry to
// SYSTEM_KINDS and post it with post_system_message(…, kind, params, …).

// Replace {name} placeholders with escaped params; keys listed in `bold` are emphasised
function fillParams(template, params, bold = []) {
    return template.replace(/\{(\w+)\}/g, (match, key) => {
        if (!(key in params)) return match
        const value = escapeHTML(params[key])
        return bold.includes(key) ? `<b>${value}</b>` : value
    })
}

const SYSTEM_KINDS = {
    dice: {
        icon: 'dice',
        // "Lou lance 1d6 et obtient : 2" / "… 2d6 et obtient : 9 (4 + 5)"
        text: p => p.count > 1
            ? fillParams(_t("lance {count}d{faces} et obtient : {total} ({rolls})"),
                {...p, rolls: (p.rolls || []).join(' + ')}, ['total'])
            : fillParams(_t("lance {count}d{faces} et obtient : {total}"), p, ['total']),
    },
}

function getSystemInfo(element) {
    let atts = element?.attachments
    if (typeof atts === 'string') { try { atts = JSON.parse(atts) } catch(e) { return null } }
    return (Array.isArray(atts) && atts.find(a => a?.type === 'system')) || null
}

export function isSystemMessage(element) {
    return getSystemInfo(element) !== null
}
window.isSystemMessage = isSystemMessage

function renderSystemText(element) {
    const info = getSystemInfo(element)
    const kind = SYSTEM_KINDS[info?.kind]
    // Unknown kind (older client than the server): fall back to the plain body
    return kind ? kind.text(info.params || {}) : escapeHTML(element.body)
}
window.renderSystemText = renderSystemText

function getSystemIcon(element) {
    const info = getSystemInfo(element)
    const icon = info?.icon || SYSTEM_KINDS[info?.kind]?.icon || 'message'
    // only ever a bare icon name: it ends up in a URL
    return /^[\w-]+$/.test(icon) ? icon : 'message'
}
window.getSystemIcon = getSystemIcon
