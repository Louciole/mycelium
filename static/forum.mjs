import global from "./framework/global.mjs"
import {setElement} from "./framework/vesta.mjs"
import {goTo} from "./framework/navigation.mjs"
import {escapeHTML as esc} from "./framework/templating.mjs"
import {createForumPost, editForumPost, editForumTags, editForumSettings, fetchForum, pendingAttachments} from "./crud.mjs"
import {getForumViewPrefs, saveForumViewPrefs} from "./forumPrefs.mjs"

const SORT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 4l-4 4h3v9h2V8h3L7 4zm10 16l4-4h-3V7h-2v9h-3l4 4z"/></svg>'
const SORT_LABELS = {activity: "Recent activity", newest: "Creation date", oldest: "Oldest first"}
const LAYOUT_LABELS = {list: "List", gallery: "Gallery"}

function rerender(forumId){
    setElement("global.forums["+forumId+"]", global.forums[forumId])
}

/* ---- Forum page: toolbar (sort & view + tag filters + guidelines) ---- */

function tagChip(tag, extraClass="", attrs=""){
    return '<span class="forum-tag-chip'+extraClass+'" style="--tag-color:'+esc(tag.color||'#5865F2')+'" '+attrs+'>'+esc(tag.name)+'</span>'
}

function menuOption(label, selected, onclick){
    return '<div class="forum-menu-option'+(selected?' selected':'')+'" onclick="closeFM();'+onclick+'">'+
        '<span>'+_t(label)+'</span><span class="forum-radio"></span></div>'
}

export function renderForumToolbar(forumId){
    const forum = global.forums?.[forumId]
    if (!forum) return ""

    const sort = forum.sort || "activity"
    const layout = forum.layout || "list"
    const sortMenu =
        '<div class="forum-sort-wrapper">'+
            '<div class="forum-pill" onclick="toggleFM(\'forum-sort-menu\')">'+SORT_ICON+'<span>'+_t("Sort & view")+'</span>'+
                '<img class="icon forum-chevron" src="/static/icons/material/down.svg"/></div>'+
            '<div id="forum-sort-menu" class="flying-menu forum-sort-menu">'+
                '<div class="forum-menu-label">'+_t("Sort by")+'</div>'+
                Object.keys(SORT_LABELS).map(k => menuOption(SORT_LABELS[k], sort===k, "setForumSort("+forumId+",'"+k+"')")).join("")+
                '<div class="forum-menu-sep"></div>'+
                '<div class="forum-menu-label">'+_t("View as")+'</div>'+
                Object.keys(LAYOUT_LABELS).map(k => menuOption(LAYOUT_LABELS[k], layout===k, "setForumLayout("+forumId+",'"+k+"')")).join("")+
            '</div>'+
        '</div>'

    const tags = forum.available_tags || []
    const tagFilters = tags.length
        ? '<div class="forum-tag-filters">'+tags.map(t =>
            tagChip(t, String(forum.tagFilter)===String(t.id) ? ' clickable selected' : ' clickable',
                'onclick="toggleForumTagFilter('+forumId+','+esc(JSON.stringify(t.id))+')"')
          ).join("")+'</div>'
        : ""

    const guidelines = forum.guidelines
        ? '<details class="forum-guidelines"'+(forum.guidelinesClosed ? '' : ' open')+' ontoggle="global.forums['+forumId+'].guidelinesClosed=!this.open"><summary>'+_t("Post guidelines")+'</summary><div>'+esc(forum.guidelines)+'</div></details>'
        : ""

    return guidelines + '<div class="forum-toolbar">'+sortMenu+tagFilters+'</div>'
}
window.renderForumToolbar = renderForumToolbar

/* ---- Forum page: post list ---- */

export function renderForumPosts(forumId){
    const forum = global.forums?.[forumId]
    if (!forum) return ""
    const posts = getForumPosts(forumId)
    if (!posts.length){
        if (!(forum.posts || []).length){
            return '<div class="forum-empty">'+
                '<img class="icon" src="/static/icons/material/message.svg"/>'+
                '<h2>'+_t("No posts yet")+'</h2>'+
                '<p>'+_t("Start the conversation: create the first post of this forum.")+'</p>'+
                '<div class="btn blue" onclick="openCreatePostModal('+forumId+')">'+_t("New post")+'</div>'+
            '</div>'
        }
        return '<div class="forum-empty"><p>'+_t("No post matches your search.")+'</p></div>'
    }
    const layout = forum.layout === "gallery" ? "gallery" : "list"
    return '<div class="forum-'+layout+'">'+fillWith('forum-post-card', posts.map(p => ({...p, forumId, layout})))+'</div>'
}
window.renderForumPosts = renderForumPosts

/** Read-only tag chips of a post, from the parent forum's tag definitions. */
export function renderPostTags(forumId, tagIds){
    const forum = global.forums?.[forumId]
    if (!forum || !tagIds || !tagIds.length) return ""
    return tagIds.map(id => {
        const t = (forum.available_tags || []).find(tt => String(tt.id) === String(id))
        return t ? tagChip(t, " small") : ""
    }).join("")
}
window.renderPostTags = renderPostTags

/** Inline style giving a member's name the color of their first role (same rule as messageGroup). */
export function forumAuthorStyle(uid){
    const serv = global.state.currentServer
    const roleId = serv?.members?.[uid]?.roles?.[0]
    const color = roleId != null ? serv.roles?.[roleId]?.color : null
    return color ? 'style="color:'+esc(color)+'"' : ""
}
window.forumAuthorStyle = forumAuthorStyle

/** "14:21" today, "16 novembre 2022" otherwise. */
export function forumDate(ts){
    if (!ts) return ""
    const d = new Date(ts)
    if (isNaN(d)) return ""
    const lang = global.settings?.lang
    if (d.toDateString() === new Date().toDateString()){
        return d.toLocaleTimeString(lang, {hour: "2-digit", minute: "2-digit"})
    }
    return d.toLocaleDateString(lang, {day: "numeric", month: "long", year: "numeric"})
}
window.forumDate = forumDate

/** Posts of a forum, filtered by tag and search text, sorted by the current sort mode. */
export function getForumPosts(forumId){
    const forum = global.forums?.[forumId]
    if (!forum) return []
    let posts = [...(forum.posts || [])]

    if (forum.tagFilter != null){
        posts = posts.filter(p => (p.tags || []).map(String).includes(String(forum.tagFilter)))
    }
    const q = (forum.search || "").trim().toLowerCase()
    if (q){
        posts = posts.filter(p => (p.title || "").toLowerCase().includes(q) || (p.snippet || "").toLowerCase().includes(q))
    }

    const sort = forum.sort || "activity"
    posts.sort((a, b) => {
        // Pinned posts always float to the top
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
        if (sort === "newest") return new Date(b.created_at) - new Date(a.created_at)
        if (sort === "oldest") return new Date(a.created_at) - new Date(b.created_at)
        return new Date(b.last_activity) - new Date(a.last_activity) // activity (default)
    })
    return posts
}
window.getForumPosts = getForumPosts

export function getForumTag(forumId, tagId){
    const forum = global.forums?.[forumId]
    return (forum?.available_tags || []).find(t => String(t.id) === String(tagId))
}
window.getForumTag = getForumTag

export function setForumLayout(forumId, layout){
    if (!global.forums?.[forumId]) return
    global.forums[forumId].layout = layout
    saveForumViewPrefs(forumId, {...getForumViewPrefs(forumId), layout})
    rerender(forumId)
}
window.setForumLayout = setForumLayout

export function setForumSort(forumId, sort){
    if (!global.forums?.[forumId]) return
    global.forums[forumId].sort = sort
    saveForumViewPrefs(forumId, {...getForumViewPrefs(forumId), sort})
    rerender(forumId)
}
window.setForumSort = setForumSort

export function toggleForumTagFilter(forumId, tagId){
    if (!global.forums?.[forumId]) return
    const current = global.forums[forumId].tagFilter
    global.forums[forumId].tagFilter = (String(current) === String(tagId)) ? null : tagId
    rerender(forumId)
}
window.toggleForumTagFilter = toggleForumTagFilter

/** The search box doubles as the title field of a new post (Enter opens the composer). */
export function setForumSearch(forumId, value){
    if (!global.forums?.[forumId]) return
    global.forums[forumId].search = value
    rerender(forumId)
}
window.setForumSearch = setForumSearch

export function forumSearchKeyDown(event, forumId){
    if (event.key === "Enter"){
        event.preventDefault()
        openCreatePostModal(forumId, event.target.value)
    }
}
window.forumSearchKeyDown = forumSearchKeyDown

/* ---- New post composer (inline, replaces the search bar while open) ----
   Attachments reuse the chat pipeline: #imageBox + global.state.currentMessageAttachments. */

function composer(){ return document.getElementById("forum-composer") }

function resetComposerAttachments(){
    global.state.currentMessageAttachments = []
    global.state.attachmentsBox = undefined
    const box = document.getElementById("imageBox")
    if (box){
        box.style.display = "none"
        box.querySelector(".attachments-container").innerHTML = ""
    }
}

export function openCreatePostModal(forumId, title=""){
    const el = composer()
    if (!el) return
    const forum = global.forums?.[forumId]
    el.dataset.forumId = forumId
    el.querySelector("[data-post-title]").value = (title || "").trim()
    const content = el.querySelector("[data-post-content]")
    content.value = ""
    content.style.height = ""
    resetComposerAttachments()

    const tags = forum?.available_tags || []
    el.querySelector("[data-tag-section]").style.display = tags.length ? "" : "none"
    el.querySelector("[data-tag-label]").textContent = _t("Tags") + (forum?.require_tag ? " (" + _t("required") + ")" : "")
    el.querySelector("[data-tag-options-container]").innerHTML = tags.map(t =>
        tagChip(t, " clickable", 'data-tag-option="'+esc(t.id)+'" onclick="toggleNewPostTag(this)"')
    ).join("")

    document.querySelector(".forum-search-bar").style.display = "none"
    el.style.display = ""
    el.querySelector(title ? "[data-post-content]" : "[data-post-title]").focus()
    updateCreatePostButton()
}
window.openCreatePostModal = openCreatePostModal

export function closeCreatePostModal(){
    const el = composer()
    if (!el) return
    el.style.display = "none"
    resetComposerAttachments()
    const search = document.querySelector(".forum-search-bar")
    if (search) search.style.display = ""
}
window.closeCreatePostModal = closeCreatePostModal

/** Post needs a title, and a tag when the forum requires one. */
export function updateCreatePostButton(){
    const el = composer()
    if (!el) return
    const forum = global.forums?.[el.dataset.forumId]
    el.querySelector("[data-post-error]").textContent = ""
    const hasTitle = !!el.querySelector("[data-post-title]").value.trim()
    const needsTag = forum?.require_tag && (forum.available_tags || []).length
        && !el.querySelector("[data-tag-option].selected")
    el.querySelector("[data-post-submit]").classList.toggle("disabled", !hasTitle || !!needsTag)
}
window.updateCreatePostButton = updateCreatePostButton

export function createPostKeyDown(event){
    if (event.key === "Escape") closeCreatePostModal()
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submitForumPost()
}
window.createPostKeyDown = createPostKeyDown

export function dropForumComposerFiles(event){
    event.preventDefault()
    for (const file of event.dataTransfer?.files || []) displayMessageAttachment(file)
}
window.dropForumComposerFiles = dropForumComposerFiles

export function toggleNewPostTag(el){
    el.classList.toggle("selected")
    updateCreatePostButton()
}
window.toggleNewPostTag = toggleNewPostTag

export function submitForumPost(){
    const el = composer()
    if (!el || el.querySelector("[data-post-submit]").classList.contains("disabled")) return
    const forumId = parseInt(el.dataset.forumId)
    const title = el.querySelector("[data-post-title]").value.trim()
    const content = el.querySelector("[data-post-content]").value.trim()
    if (!title) return
    const tags = [...el.querySelectorAll("[data-tag-option].selected")].map(t => t.dataset.tagOption)
    // Same shape as chat messages (see sendMessage)
    const attachments = pendingAttachments().map(a => ({
        dataUrl: a.dataUrl,
        filename: a.name,
        mimeType: a.type,
    }))

    try {
        const post = createForumPost(forumId, title, content, tags, attachments)
        closeCreatePostModal()
        if (global.forums?.[forumId]) global.forums[forumId].search = ""
        if (post) window.goToForumPost(post.id)
    } catch(e) {
        console.error("Failed to create post:", e)
        el.querySelector("[data-post-error]").textContent = /tag required/.test(e.message)
            ? _t("Pick a tag before posting.")
            : _t("Could not create the post.")
    }
}
window.submitForumPost = submitForumPost

/* ---- Post moderation (from the open post view) ---- */

export function togglePinPost(postId){
    const post = global.convs?.[postId]
    if (!post) return
    const res = editForumPost(postId, post.pinned ? "unpin" : "pin")
    post.pinned = res.pinned
    _syncPostInList(post)
    rerenderPost()
}
window.togglePinPost = togglePinPost

export function toggleLockPost(postId){
    const post = global.convs?.[postId]
    if (!post) return
    const res = editForumPost(postId, post.locked ? "unlock" : "lock")
    post.locked = res.locked
    _syncPostInList(post)
    rerenderPost()
}
window.toggleLockPost = toggleLockPost

export function deleteForumPost(postId){
    if (!confirm(_t("Delete this post and all its replies?"))) return
    const post = global.convs?.[postId]
    const forumId = post?.forum
    editForumPost(postId, "delete")
    if (forumId != null && global.forums?.[forumId]){
        global.forums[forumId].posts = global.forums[forumId].posts.filter(p => p.id != postId)
        window.goToForumChannel(forumId)
    }
}
window.deleteForumPost = deleteForumPost

/** Header badges/actions and the composer are static template content: re-render the open post. */
function rerenderPost(){
    goTo('content', 'server-forum-post', undefined, false)
}

function _syncPostInList(post){
    const forum = global.forums?.[post.forum]
    const listed = forum?.posts.find(p => p.id == post.id)
    if (listed){
        listed.pinned = post.pinned
        listed.locked = post.locked
    }
}

/* ---- Forum settings (the forum part of the channel settings' "Overview") ---- */

const TAG_COLORS = ["#5865F2", "#3BA55C", "#FAA61A", "#ED4245", "#EB459E", "#9B59B6", "#1ABC9C", "#E67E22", "#95A5A6", "#607D8B"]

function settingsForumId(){ return parseInt(global.state.modaltarget?.dataset?.id) }

/** Opens the channel settings of a forum (its Overview holds the forum settings). */
export function openForumSettings(forumId){
    const target = document.getElementById("channel-forum-"+forumId)
    if (!target) return
    global.state.modaltarget = target
    openChannelSettings()
}
window.openForumSettings = openForumSettings

/** Saved guidelines of the forum whose settings are open (default value of the unsaved-changes form). */
export function forumGuidelinesDefault(){
    const id = settingsForumId()
    const forum = global.forums?.[id] || fetchForum(id)
    return forum?.guidelines || ""
}
window.forumGuidelinesDefault = forumGuidelinesDefault

export function updateGuidelinesCounter(){
    const input = document.getElementById("forum-guidelines-input")
    const counter = document.querySelector(".forum-guidelines-counter")
    if (input && counter) counter.textContent = 4096 - input.value.length
}
window.updateGuidelinesCounter = updateGuidelinesCounter

function radioRow(label, checked, onclick){
    return '<div class="forum-settings-radio'+(checked ? ' selected' : '')+'" onclick="'+onclick+'">'+
        '<span class="forum-radio"></span><span>'+_t(label)+'</span></div>'
}

export function renderForumSettings(forumId){
    const forum = global.forums?.[forumId] || fetchForum(forumId)
    if (!forum) return ""
    const tags = forum.available_tags || []
    const sort = forum.default_sort || "activity"
    const layout = forum.default_layout || "list"

    return (
        '<hr>'+
        '<h2>'+_t("Tags")+'</h2>'+
        '<p class="forum-settings-hint">'+_t("Help members organize their posts into sub-categories by creating tags.")+'</p>'+
        (tags.length ? '<div class="forum-settings-tags">'+tags.map(t =>
            tagChip(t, " clickable", 'title="'+_t("Edit tag")+'" onclick="openForumTagEditor('+forumId+','+esc(JSON.stringify(t.id))+')"')
        ).join("")+'</div>' : '')+
        '<div class="btn blue forum-create-tag-btn" onclick="openForumTagEditor('+forumId+')">'+_t("Create a tag")+'</div>'+
        '<label class="forum-settings-check">'+
            '<input type="checkbox" id="forum-require-tag"'+(forum.require_tag ? ' checked' : '')+' onchange="setForumDefault('+forumId+',\'require_tag\',this.checked)"/>'+
            '<span class="checkbox"></span><span>'+_t("Require a tag when people post")+'</span>'+
        '</label>'+
        '<hr>'+
        '<h2>'+_t("Default layout")+'</h2>'+
        '<p class="forum-settings-hint">'+_t("How posts are displayed until members pick their own view.")+'</p>'+
        '<div class="forum-settings-radios">'+
            Object.keys(LAYOUT_LABELS).map(k => radioRow(LAYOUT_LABELS[k], layout === k, "setForumDefault("+forumId+",'default_layout','"+k+"')")).join("")+
        '</div>'+
        '<h2>'+_t("Default sort order")+'</h2>'+
        '<div class="forum-settings-radios">'+
            Object.keys(SORT_LABELS).map(k => radioRow(SORT_LABELS[k], sort === k, "setForumDefault("+forumId+",'default_sort','"+k+"')")).join("")+
        '</div>'+
        renderTagEditor(forumId)
    )
}
window.renderForumSettings = renderForumSettings

/* Tag editor dialog (create / edit / delete). Its state lives on the forum so a re-render keeps it open. */

function renderTagEditor(forumId){
    const ed = global.forums[forumId].tagEditor
    if (!ed) return ""
    const editing = ed.tagId != null
    const close = 'closeForumTagEditor('+forumId+')'
    return '<section class="menu-wrapper forum-tag-editor" style="display:flex" onclick="event.target===event.currentTarget && '+close+'" onkeydown="if(event.key===\'Escape\')'+close+'">'+
        '<div class="menu">'+
            '<div class="forum-dialog-close" title="'+_t("Close")+'" onclick="'+close+'"><img class="icon" src="/static/icons/material/close.svg"/></div>'+
            '<h2>'+_t(editing ? "Edit tag" : "Create a tag")+'</h2>'+
            '<div class="forum-tag-editor-preview">'+tagChip({name: ed.name || _t("Tag name"), color: ed.color})+'</div>'+
            '<label class="forum-create-label">'+_t("Tag name")+
                '<input type="text" id="forum-tag-name" class="dark" maxlength="20" value="'+esc(ed.name)+'" placeholder="'+_t("Tag name")+'" oninput="forumTagEditorInput('+forumId+',this.value)" onkeydown="if(event.key===\'Enter\')saveForumTag('+forumId+')"/>'+
            '</label>'+
            '<div class="forum-create-label">'+_t("Color")+
                '<div class="forum-tag-colors">'+
                    TAG_COLORS.map(c => '<div class="forum-tag-color'+(c.toLowerCase() === String(ed.color).toLowerCase() ? ' selected' : '')+'" style="background:'+c+'" onclick="forumTagEditorColor('+forumId+',\''+c+'\')"></div>').join("")+
                    '<input type="color" class="forum-tag-color custom" value="'+esc(ed.color)+'" title="'+_t("Custom color")+'" onchange="forumTagEditorColor('+forumId+',this.value)"/>'+
                '</div>'+
            '</div>'+
            '<div class="forum-dialog-actions">'+
                (editing ? '<div class="underlhover forum-dialog-delete" onclick="removeForumTag('+forumId+','+esc(JSON.stringify(ed.tagId))+')">'+_t("Delete")+'</div>' : '')+
                '<div class="underlhover" onclick="'+close+'">'+_t("Cancel")+'</div>'+
                '<div class="btn blue'+((ed.name || "").trim() ? '' : ' disabled')+'" id="forum-tag-save" onclick="saveForumTag('+forumId+')">'+_t(editing ? "Save" : "Create")+'</div>'+
            '</div>'+
        '</div>'+
    '</section>'
}

export function openForumTagEditor(forumId, tagId=null){
    const tag = tagId != null ? getForumTag(forumId, tagId) : null
    global.forums[forumId].tagEditor = {tagId, name: tag?.name || "", color: tag?.color || TAG_COLORS[0]}
    rerender(forumId)
    document.getElementById("forum-tag-name")?.focus()
}
window.openForumTagEditor = openForumTagEditor

export function closeForumTagEditor(forumId){
    delete global.forums[forumId].tagEditor
    rerender(forumId)
}
window.closeForumTagEditor = closeForumTagEditor

/** Live preview without a re-render (which would steal the input's focus). */
export function forumTagEditorInput(forumId, value){
    global.forums[forumId].tagEditor.name = value
    const chip = document.querySelector(".forum-tag-editor-preview .forum-tag-chip")
    if (chip) chip.textContent = value || _t("Tag name")
    document.getElementById("forum-tag-save")?.classList.toggle("disabled", !value.trim())
}
window.forumTagEditorInput = forumTagEditorInput

export function forumTagEditorColor(forumId, color){
    global.forums[forumId].tagEditor.color = color
    rerender(forumId)
}
window.forumTagEditorColor = forumTagEditorColor

export function saveForumTag(forumId){
    const ed = global.forums[forumId].tagEditor
    const name = (ed?.name || "").trim()
    if (!name) return
    if (ed.tagId != null) editForumTags(forumId, "edit", {name, color: ed.color}, ed.tagId)
    else editForumTags(forumId, "add", {name, color: ed.color})
    closeForumTagEditor(forumId)
}
window.saveForumTag = saveForumTag

export function removeForumTag(forumId, tagId){
    if (!confirm(_t("Delete this tag? It will be removed from the posts that use it."))) return
    editForumTags(forumId, "remove", null, tagId)
    const forum = global.forums[forumId]
    if (String(forum.tagFilter) === String(tagId)) forum.tagFilter = null
    delete forum.tagEditor
    rerender(forumId)
}
window.removeForumTag = removeForumTag

/** Called by Save('editChannel') for the guidelines field of the unsaved-changes form. */
export function saveForumGuidelines(forumId, value){
    editForumSettings(forumId, "guidelines", value)
    global.forums[forumId].guidelines = value
    rerender(forumId)
}
window.saveForumGuidelines = saveForumGuidelines

/** Admin settings saved right away: default sort/layout (until members pick their own) and require_tag. */
export function setForumDefault(forumId, field, value){
    editForumSettings(forumId, field, value)
    const forum = global.forums[forumId]
    forum[field] = value
    const prefs = getForumViewPrefs(forumId)
    if (field === "default_sort" && !prefs.sort) forum.sort = value
    if (field === "default_layout" && !prefs.layout) forum.layout = value
    rerender(forumId)
}
window.setForumDefault = setForumDefault
