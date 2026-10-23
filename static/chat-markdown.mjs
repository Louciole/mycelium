// Markdown of chat messages and notes: Vesta's (static/markdown, vendored) plus mentions.
// Other texts (profile descriptions…) use Vesta's own MDToHTML: no mentions there.

import {Markdown, escSource} from "./markdown/markdown.mjs"
import global from "./framework/global.mjs"
import {escapeHTML} from "./framework/templating.mjs"
import {renderChannelMention} from "./drive-links.mjs"

// "<@12>" user, "<@&3>" role, "<#5>" / "<#drive:12/f:301>" channel (drive-links.mjs),
// "<@everyone>", "<@here>". Chat text reaches the parser with "<" escaped as "&lt;".
const MENTION = /(?:<|&lt;)(@&|@|#)([^\s>]+)>/y

function mention(str, at) {
    MENTION.lastIndex = at
    const match = MENTION.exec(str)
    if (!match) return null
    const [whole, sigil, id] = match
    if (sigil === "@" && (id === "everyone" || id === "here")) return {type: `mention_${id}`, length: whole.length}
    const type = {"@": "mention_user", "@&": "mention_role", "#": "mention_channel"}[sigil]
    return {type, length: whole.length, props: {id}}
}

// An id as the argument of an onclick handler: a number when it is one JS can hold exactly,
// else a string (a too big or non-numeric id must not end up as another one)
function jsId(id) {
    const value = String(id ?? "")
    return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? value : escapeHTML(JSON.stringify(value))
}

function renderMention(token) {
    const id = token.props.id
    switch (token.type) {
        case "mention_user": {
            const user = global.users?.[id]
            return `<span class='mention mention-user' data-mention-id='${escapeHTML(id)}' onclick='mentionUserClick(${jsId(id)}, event)'>@${escapeHTML(user ? user.display : 'Unknown User')}</span>`
        }
        case "mention_role": {
            const role = global.state?.currentServer?.roles?.[id]
            return `<span class='mention mention-role' style='--role-color: ${escapeHTML(role ? role.color : '#A8A8A8')}' data-mention-id='${escapeHTML(id)}'>@${escapeHTML(role ? role.name : 'Unknown Role')}</span>`
        }
        case "mention_channel":
            return renderChannelMention(id)
                ?? `<span class='mention mention-channel' data-channel-id='${escapeHTML(id)}'>#unknown-channel</span>`
        case "mention_everyone":
            return "<span class='mention mention-everyone'>@everyone</span>"
        case "mention_here":
            return "<span class='mention mention-here'>@here</span>"
    }
}

export class ChatMarkdown extends Markdown {
    inlineRules = [...this.inlineRules, mention]

    renderToken(token, token_id, tokens, renderingSet = this.HTML_equiv) {
        if (!token.type.startsWith("mention_")) return super.renderToken(token, token_id, tokens, renderingSet)
        // Source mode (notes being edited): a mention typed as "&lt;@…>" is that text (only chat
        // text, escaped before it is parsed, writes "<" as "&lt;")
        if (renderingSet.__source && !token.src.startsWith("<")) return [escSource(token.src), token_id]
        return [renderMention(token), token_id]
    }
}

/** The HTML of a chat message body (navigation.mjs renderMessageBody). */
export function chatToHTML(text) {
    const engine = new ChatMarkdown()
    return engine.render(engine.tokenize(text))
}
