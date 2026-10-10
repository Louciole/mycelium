/* Per-user forum view preferences (sort & layout), kept in this browser.
   The forum's default_sort/default_layout are set by admins in the channel settings;
   what a member picks in "Sort & view" only applies to them.
   Own module so crud.mjs (fetchForum) and forum.mjs can both use it without importing each other. */

function viewPrefKey(forumId){ return "forum_view_" + forumId }

export function getForumViewPrefs(forumId){
    try {
        return JSON.parse(localStorage.getItem(viewPrefKey(forumId))) || {}
    } catch(e) { return {} }
}

export function saveForumViewPrefs(forumId, prefs){
    try { localStorage.setItem(viewPrefKey(forumId), JSON.stringify(prefs)) } catch(e) {}
}
