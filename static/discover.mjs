import global from "./framework/global.mjs";
import {xhr, escapeHTML} from "./framework/templating.mjs";
import {setElement} from "./framework/vesta.mjs";
import {goTo} from "./framework/navigation.mjs";
import {loadServers} from "./crud.mjs";

// Discover is a regular page of the app layout: the compass in the server rail
// selects it, the secondary column (#sec-selector) shows `discover-nav` and the
// content area shows `discover-servers`, like a server and its channels.

if (!global.discover) {
    setElement('global.discover', {
        view: 'home',                                   // 'home' | 'featured'
        search: { text: '', languages: [], tags: [] },
        servers: { featured: [], regular: [] },
        languages: []                                   // every language used by a community server
    });
}

const SEARCH_DEBOUNCE_MS = 200;
let searchTimer = null;
let requestSeq = 0;

function selectRailItem(item) {
    if (!item || global.state.currentTab === item) return;
    global.state.currentTab?.classList.remove('selected');
    item.classList.add('selected');
    global.state.currentTab = item;
}

function goToDiscover(event, fromRoute = false) {
    global.state.isServer = false;
    global.state.activeConv = undefined;
    selectRailItem(event?.currentTarget || document.getElementById('discover-servers'));
    global.discover.availableTags = undefined;   // refetched by the autocomplete on next use

    const render = () => {
        goTo('sec-selector', 'discover-nav', undefined, false, () => {
            goTo('content', 'discover-servers', undefined, false, () => {
                const input = document.getElementById('discover-search-smart');
                if (input) input.value = global.discover.search.text;
                renderDiscover();
                loadDiscoverServers();
            });
        });
        if (global.state.isMobile) window.mobileDisplayContent?.();
    };
    // #sec-selector lives inside column-perso, which may not be painted yet.
    if (document.getElementById('sec-selector')) render();
    else goTo('sec-column', 'column-perso', undefined, false, render);

    if (!fromRoute && location.hash !== '#discover') history.pushState(null, '', '/channels#discover');
}
window.goToDiscover = goToDiscover;

function setDiscoverView(view) {
    global.discover.view = view;
    renderDiscover();
    if (global.state.isMobile) window.mobileDisplayContent?.();
}
window.setDiscoverView = setDiscoverView;

// ---------- rendering ----------

function languageName(code) {
    try {
        const name = new Intl.DisplayNames([global.settings?.lang || 'fr'], { type: 'language' }).of(code);
        if (name && name !== code) return name.charAt(0).toUpperCase() + name.slice(1);
    } catch (e) {}
    return code.toUpperCase();
}

function parseList(value) {
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value || '[]') || []; } catch (e) { return []; }
}

function renderDiscover() {
    renderNav();
    renderActiveFilters();
    renderServers();
}

function renderNav() {
    const view = global.discover.view;
    document.getElementById('discover-view-home')?.classList.toggle('selected', view === 'home');
    document.getElementById('discover-view-featured')?.classList.toggle('selected', view === 'featured');

    const title = document.getElementById('discover-view-title');
    if (title) title.textContent = view === 'featured' ? _t('Mis en avant') : _t('Accueil');

    // Language picker: the app's .dropdown component (same as Settings > Language).
    const list = document.getElementById('discover-languages');
    const text = document.getElementById('discover-lang-text');
    if (!list || !text) return;
    const active = global.discover.search.languages;
    const codes = [...new Set([...global.discover.languages, ...active])].sort();
    const option = (code, label) =>
        `<li class="${(code ? active.length === 1 && active[0] === code : active.length === 0) ? 'selected' : ''}" data-lang="${escapeHTML(code)}" onclick="pickDiscoverLanguage(this.dataset.lang)">${label}</li>`;
    list.innerHTML = option('', _t('Toutes les langues')) +
        codes.map(code => option(code, `${flag(code)} ${escapeHTML(languageName(code))}`)).join('');
    text.textContent = active.length === 0 ? _t('Toutes les langues')
        : active.length === 1 ? `${flag(active[0])} ${languageName(active[0])}`
        : _t('Plusieurs langues');
}

function flag(code) {
    return window.getFlagEmoji ? getFlagEmoji(code) : '';
}

function renderActiveFilters() {
    const container = document.getElementById('discover-active-filters');
    if (!container) return;
    const { languages, tags } = global.discover.search;
    const chip = (kind, value, label) => `<span class="discover-chip" data-kind="${kind}" data-value="${escapeHTML(value)}">
            ${label}
            <button type="button" aria-label="${_t('Retirer le filtre')}" onclick="removeDiscoverFilter(this.parentElement.dataset.kind, this.parentElement.dataset.value)">×</button>
        </span>`;
    container.innerHTML =
        languages.map(l => chip('lang', l, `${window.getFlagEmoji ? getFlagEmoji(l) : ''} ${escapeHTML(l.toUpperCase())}`)).join('') +
        tags.map(t => chip('tag', t, `# ${escapeHTML(t)}`)).join('');
}

function renderServers() {
    const container = document.getElementById('discover-content');
    if (!container) return;

    const { featured = [], regular = [] } = global.discover.servers || {};
    const section = (title, servers) => servers.length === 0 ? '' :
        `<div class="discover-section">
            <h2>${title}</h2>
            <div class="servers-grid">${fillWith('discover-server-card', servers)}</div>
        </div>`;

    let html;
    if (global.discover.view === 'featured') {
        html = section(_t('MIS EN AVANT'), featured);
    } else {
        html = section(_t('MIS EN AVANT'), featured) + section(_t('SERVEURS POPULAIRES'), regular);
    }

    if (!html) {
        const filtered = global.discover.search.text || global.discover.search.languages.length || global.discover.search.tags.length;
        html = `<div class="discover-empty">
            <img class="icon" src="/static/icons/material/compass.svg" alt="">
            <h3>${filtered ? _t('Aucun serveur ne correspond') : _t('Aucun serveur à découvrir pour le moment')}</h3>
            <p>${filtered ? _t('Essaie une autre recherche ou retire un filtre.') : _t('Les serveurs communautaires apparaîtront ici.')}</p>
        </div>`;
    }
    container.innerHTML = html;
}

// Card helpers, used by templates/discover-server-card.html.
const BANNER_COLORS = ['var(--accent)', 'var(--accent2)', 'var(--accent3)', 'var(--green)', 'var(--purple)', 'var(--text2bis)'];
window.discoverBannerStyle = (server) => server.pfp
    ? `background-image:url('/static/attachments/${encodeURIComponent(server.pfp)}')`
    : `background:${BANNER_COLORS[Number(server.id) % BANNER_COLORS.length]}`;
window.discoverMemberCount = (n) => `${n || 0} ${(n || 0) <= 1 ? _t('membre') : _t('membres')}`;
window.discoverParseList = parseList;

// ---------- search ----------

const TOKEN = /(?:^|\s)(lang|tag):([^\s,]+(?:,[^\s,]+)*)(?=\s|$)/gi;

// Moves `lang:xx` / `tag:yy` tokens out of the free text into filter chips.
// While typing, only tokens already followed by a space are extracted, so the
// user can finish typing them; on Enter everything is extracted.
function extractTokens(text, all) {
    const search = global.discover.search;
    let changed = false;
    const rest = text.replace(TOKEN, (match, kind, values, offset, full) => {
        const end = offset + match.length;
        if (!all && end === full.length) return match;
        for (const v of values.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
            const list = kind.toLowerCase() === 'lang' ? search.languages : search.tags;
            if (!list.includes(v)) list.push(v);
        }
        changed = true;
        return ' ';
    });
    return { rest: changed ? rest.replace(/\s+/g, ' ').trimStart() : text, changed };
}

function applyChipChanges() {
    renderActiveFilters();
    renderNav();
}

function handleSmartSearch(event) {
    const input = event.target;
    const { rest, changed } = extractTokens(input.value, false);
    if (changed) {
        input.value = rest;
        applyChipChanges();
    }
    // A `tag:`/`lang:` token still being typed is not free text to search for.
    global.discover.search.text = input.value.replace(/(^|\s)(tag|lang):\S*/gi, ' ').trim();
    scheduleLoad();
    updateDiscoverAutocomplete();
}
window.handleSmartSearch = handleSmartSearch;

function handleDiscoverSearchKey(event) {
    const input = event.target;
    if (acItems.length) {
        switch (event.key) {
            case 'ArrowDown':
            case 'ArrowUp':
                event.preventDefault();
                acIndex = (acIndex + (event.key === 'ArrowDown' ? 1 : -1) + acItems.length) % acItems.length;
                renderAutocomplete();
                return;
            case 'Tab':
            case 'Enter':
                event.preventDefault();
                selectDiscoverSuggestion(acIndex);
                return;
            case 'Escape':
                event.preventDefault();
                closeDiscoverAutocomplete();
                return;
        }
    }
    if (event.key === 'Enter') {
        const { rest, changed } = extractTokens(input.value, true);
        if (changed) {
            input.value = rest;
            global.discover.search.text = rest.trim();
            applyChipChanges();
        }
        loadDiscoverServers();
    } else if (event.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) {
        const { languages, tags } = global.discover.search;
        if (tags.length) removeDiscoverFilter('tag', tags[tags.length - 1]);
        else if (languages.length) removeDiscoverFilter('lang', languages[languages.length - 1]);
    }
}
window.handleDiscoverSearchKey = handleDiscoverSearchKey;

function removeDiscoverFilter(kind, value) {
    const list = kind === 'lang' ? global.discover.search.languages : global.discover.search.tags;
    const index = list.indexOf(value);
    if (index > -1) list.splice(index, 1);
    applyChipChanges();
    loadDiscoverServers();
}
window.removeDiscoverFilter = removeDiscoverFilter;

// From the language dropdown: one language, or '' for all of them.
function pickDiscoverLanguage(code) {
    global.discover.search.languages = code ? [code] : [];
    const dropdown = document.getElementById('discover-lang-dropdown');
    dropdown?.classList.remove('show');
    if (global.state.activeDropdown === dropdown) global.state.activeDropdown = undefined;
    applyChipChanges();
    loadDiscoverServers();
}
window.pickDiscoverLanguage = pickDiscoverLanguage;

function addDiscoverTag(tag) {
    const tags = global.discover.search.tags;
    if (!tags.includes(tag)) tags.push(tag);
    applyChipChanges();
    loadDiscoverServers();
}
window.addDiscoverTag = addDiscoverTag;

// ---------- autocomplete ----------
// Same popup as the composer's @ menu (.mention-autocomplete / .mention-ac-*):
// arrows to move, Tab/Enter to pick, Escape to close, closes on blur.

const AC_MAX_ITEMS = 8;
let acItems = [];
let acIndex = 0;
let acWord = null;   // { start, end } of the word being completed in the input

function loadAvailableTags() {
    xhr('get_available_tags', function () {
        if (this.status !== 200) return;
        try { global.discover.availableTags = JSON.parse(this.responseText); } catch (e) { return; }
        updateDiscoverAutocomplete();
    });
}

function buildSuggestions(word) {
    const search = global.discover.search;
    const prefixed = /^(tag|lang):(.*)$/i.exec(word);
    if (!prefixed) {
        // A bare word: offer the filter syntaxes it could be the start of.
        const lower = word.toLowerCase();
        return [
            { kind: 'hint', insert: 'tag:', label: 'tag:', sub: _t('Filtrer par tag') },
            { kind: 'hint', insert: 'lang:', label: 'lang:', sub: _t('Filtrer par langue') },
        ].filter(h => h.insert.startsWith(lower) && h.insert !== lower);
    }
    const kind = prefixed[1].toLowerCase();
    const query = prefixed[2].toLowerCase();
    if (kind === 'tag') {
        const starts = t => t.toLowerCase().startsWith(query);
        return (global.discover.availableTags || [])
            .filter(t => !search.tags.includes(t) && t.toLowerCase().includes(query))
            .sort((a, b) => starts(a) === starts(b) ? a.localeCompare(b) : starts(a) ? -1 : 1)
            .map(t => ({ kind: 'tag', insert: `tag:${t} `, label: `# ${t}` }));
    }
    return global.discover.languages
        .filter(code => !search.languages.includes(code)
            && (code.startsWith(query) || languageName(code).toLowerCase().includes(query)))
        .map(code => ({ kind: 'lang', insert: `lang:${code} `, label: `${flag(code)} ${languageName(code)}`, sub: code }));
}

function updateDiscoverAutocomplete() {
    const input = document.getElementById('discover-search-smart');
    if (!input || document.activeElement !== input) return closeDiscoverAutocomplete();
    if (!global.discover.availableTags) {
        global.discover.availableTags = [];
        loadAvailableTags();
    }
    const caret = input.selectionStart;
    const word = /\S*$/.exec(input.value.slice(0, caret))[0];
    acWord = { start: caret - word.length, end: caret };
    acItems = buildSuggestions(word).slice(0, AC_MAX_ITEMS);
    acIndex = 0;
    renderAutocomplete();
}
window.updateDiscoverAutocomplete = updateDiscoverAutocomplete;

function renderAutocomplete() {
    const popup = document.getElementById('discover-autocomplete');
    if (!popup) return;
    if (acItems.length === 0) {
        popup.style.display = 'none';
        popup.innerHTML = '';
        return;
    }
    popup.innerHTML = acItems.map((item, i) => `<div class="mention-ac-item ${i === acIndex ? 'selected' : ''}" data-kind="${item.kind}" onmousedown="event.preventDefault(); selectDiscoverSuggestion(${i})">
            <div class="mention-ac-info">
                <span class="mention-ac-name">${escapeHTML(item.label)}</span>
                ${item.sub ? `<span class="mention-ac-sub">${escapeHTML(item.sub)}</span>` : ''}
            </div>
        </div>`).join('');
    popup.style.display = 'flex';
}

function selectDiscoverSuggestion(index) {
    const item = acItems[index];
    const input = document.getElementById('discover-search-smart');
    if (!item || !input || !acWord) return;
    input.value = input.value.slice(0, acWord.start) + item.insert + input.value.slice(acWord.end);
    const caret = acWord.start + item.insert.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    // A completed `tag:x ` / `lang:x ` token turns into a chip right away.
    handleSmartSearch({ target: input });
}
window.selectDiscoverSuggestion = selectDiscoverSuggestion;

function closeDiscoverAutocomplete() {
    acItems = [];
    acWord = null;
    renderAutocomplete();
}

function closeDiscoverAutocompleteSoon() {
    setTimeout(() => {
        if (document.activeElement !== document.getElementById('discover-search-smart')) closeDiscoverAutocomplete();
    }, 150);
}
window.closeDiscoverAutocompleteSoon = closeDiscoverAutocompleteSoon;

function scheduleLoad() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadDiscoverServers, SEARCH_DEBOUNCE_MS);
}

function loadDiscoverServers() {
    clearTimeout(searchTimer);
    const search = global.discover.search;
    const params = [];
    if (search.text) params.push(`search=${encodeURIComponent(search.text)}`);
    if (search.languages.length > 0) params.push(`languages=${encodeURIComponent(JSON.stringify(search.languages))}`);
    if (search.tags.length > 0) params.push(`tags=${encodeURIComponent(JSON.stringify(search.tags))}`);

    // Responses can come back out of order while typing: only keep the latest.
    const seq = ++requestSeq;
    xhr('get_discoverable_servers' + (params.length ? '?' + params.join('&') : ''), function () {
        if (seq !== requestSeq || this.status !== 200) return;
        let data;
        try { data = JSON.parse(this.responseText); } catch (e) { return; }
        setElement('global.discover.servers', data);
        global.discover.languages = data.languages || [];
        renderNav();
        renderServers();
    });
}
window.loadDiscoverServers = loadDiscoverServers;

// ---------- actions ----------

function findDiscoverServer(serverId) {
    const { featured = [], regular = [] } = global.discover.servers || {};
    return [...featured, ...regular].find(s => Number(s.id) === Number(serverId));
}

function joinDiscoverServer(serverId, button) {
    if (button) button.disabled = true;
    xhr(`join_community_server?server_id=${serverId}`, function () {
        if (this.status !== 200) {
            if (button) button.disabled = false;
            alert(_t('Impossible de rejoindre ce serveur. Réessaie plus tard.'));
            return;
        }
        const server = findDiscoverServer(serverId);
        if (server) {
            server.is_joined = true;
            server.member_count = (server.member_count || 0) + 1;
        }
        renderServers();
        loadServers();
    }, 'POST');
}
window.joinDiscoverServer = joinDiscoverServer;

// Opens a joined server exactly as a click on its rail icon would.
function openDiscoverServer(serverId) {
    document.getElementById('server-item-' + serverId)?.click();
}
window.openDiscoverServer = openDiscoverServer;

function toggleServerFeatured(serverId, featured) {
    xhr(`set_server_featured?server_id=${serverId}&featured=${featured}`, function () {
        if (this.status !== 200) {
            alert(_t('Impossible de modifier la mise en avant de ce serveur.'));
            return;
        }
        loadDiscoverServers();
    }, 'POST');
}
window.toggleServerFeatured = toggleServerFeatured;

export { goToDiscover, joinDiscoverServer };
