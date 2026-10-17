import global from "./framework/global.mjs"
import {xhr} from "./framework/templating.mjs";
import {handleMessageGroup} from "./crud.mjs";
import {addElement} from "./framework/vesta.mjs";

// ── Poll Creation ──────────────────────────────────────────────────────────────

/**
 * State for poll creation form
 */
global.state.pollOptions = []

/**
 * Called on input in the "add an option" field.
 * As soon as the user types anything, move the text into the option list
 * and place the caret in the newly created option so they can keep typing.
 */
function addPollCreationOption(event) {
    const input = event.currentTarget
    const text = input.value
    if (!text) return

    global.state.pollOptions.push(text)
    input.value = ''
    renderPollCreationOptions()

    // Focus the newly created option input and place caret at end
    const container = document.getElementById('poll-options-list')
    const inputs = container.querySelectorAll('input')
    if (inputs.length > 0) {
        const newInput = inputs[inputs.length - 1]
        newInput.focus()
        newInput.setSelectionRange(newInput.value.length, newInput.value.length)
    }
}
window.addPollCreationOption = addPollCreationOption

function renderPollCreationOptions() {
    const container = document.getElementById('poll-options-list')
    if (!container) return
    let html = ''
    for (let i = 0; i < global.state.pollOptions.length; i++) {
        html += `<div class="poll-creation-option">
            <input type="text" value="${global.state.pollOptions[i].replace(/"/g, '&quot;')}"
                oninput="updatePollCreationOption(${i}, this.value)"
                onblur="removePollOptionIfEmpty(${i})"
                onkeydown="if(event.key==='Enter'){event.preventDefault();document.querySelector('#create-poll .poll-add-option-trigger').focus()}"
                placeholder="${_t('Option')} ${i + 1}"/>
        </div>`
    }
    container.innerHTML = html
}
window.renderPollCreationOptions = renderPollCreationOptions

function updatePollCreationOption(index, value) {
    global.state.pollOptions[index] = value
}
window.updatePollCreationOption = updatePollCreationOption

function removePollOptionIfEmpty(index) {
    if (global.state.pollOptions[index] !== undefined && global.state.pollOptions[index].trim() === '') {
        global.state.pollOptions.splice(index, 1)
        renderPollCreationOptions()
    }
}
window.removePollOptionIfEmpty = removePollOptionIfEmpty

function createPoll() {
    const questionInput = document.getElementById('poll-question')
    const question = questionInput?.value?.trim()
    const options = global.state.pollOptions.filter(o => o.trim() !== '')

    if (!question) {
        questionInput.focus()
        return
    }

    if (options.length < 1) {
        return
    }

    const multipleChoice = document.getElementById('poll-multiple-choice')?.checked || false
    const allowUserOptions = document.getElementById('poll-allow-user-options')?.checked || false

    const pollData = {
        question: question,
        options: options,
        multipleChoice: multipleChoice,
        allowUserOptions: allowUserOptions
    }

    const onload = function () {
        const response = JSON.parse(this.responseText)
        const msg = response.message
        handleMessageGroup(msg)
        addElement('global.convs['.concat(global.state.activeConv, '].messages'), msg)

        // Close menu and reset state
        closeMenu('#create-poll')
        global.state.pollOptions = []
        questionInput.value = ''
        document.getElementById('poll-multiple-choice').checked = false
        document.getElementById('poll-allow-user-options').checked = false
        document.getElementById('poll-options-list').innerHTML = ''
    }

    xhr("send_message?conv=" + encodeURI(JSON.stringify({id: global.state.activeConv})) + "&content=",
        onload, "POST", true, {poll: pollData})
}
window.createPoll = createPoll

// ── Poll Voting ────────────────────────────────────────────────────────────────

function votePoll(pollId, messageId) {
    const container = document.querySelector(`#message-${messageId} .poll-message`)
    if (!container) return

    const checkboxes = container.querySelectorAll('.poll-option input[type="checkbox"]:checked')
    const selectedIds = Array.from(checkboxes).map(cb => parseInt(cb.dataset.optionId))

    if (selectedIds.length === 0) {
        uiAlert(_t('Select at least one option'))
        return
    }

    // Find which conv this message belongs to
    let convId = null
    for (const cid in global.convs) {
        if (global.convs[cid]?.messages?.[messageId]) { convId = cid; break }
    }

    const onload = function () {
        const result = JSON.parse(this.responseText)
        if (convId) {
            const msg = global.convs[convId]?.messages?.[messageId]
            if (msg && msg.poll) {
                msg.poll.votes = result.votes
            }
        }
        // Directly update the vote count in the DOM (poll template is static HTML)
        const voteCountEl = container.querySelector('.poll-vote-count')
        if (voteCountEl) {
            const allVoters = new Set()
            for (const optId in result.votes) {
                for (const v of result.votes[optId]) allVoters.add(v)
            }
            voteCountEl.textContent = `${allVoters.size} ${_t('votes')}`
        }
    }

    xhr("vote_poll?poll_id=" + pollId + "&option_ids=" + encodeURIComponent(JSON.stringify(selectedIds)), onload)
}
window.votePoll = votePoll

// ── Poll Add Option ────────────────────────────────────────────────────────────

function addUserPollOption(pollId, messageId, event) {
    if (event && event.key !== 'Enter') return
    const input = event ? event.currentTarget : document.querySelector(`#message-${messageId} .poll-add-option-input`)
    const text = input?.value?.trim()
    if (!text) return

    let convId = null
    for (const cid in global.convs) {
        if (global.convs[cid]?.messages?.[messageId]) { convId = cid; break }
    }

    const onload = function () {
        const newOption = JSON.parse(this.responseText)

        // Update global state
        if (convId) {
            const msg = global.convs[convId]?.messages?.[messageId]
            if (msg && msg.poll) {
                msg.poll.options.push(newOption)
            }
        }

        // Directly inject the new option into the DOM — the poll template is static HTML,
        // setElement reactivity doesn't apply to it.
        const optionList = document.querySelector(`#message-${messageId} .poll-option-list`)
        if (optionList) {
            const isMultiple = convId && global.convs[convId]?.messages?.[messageId]?.poll?.multiple_choice
            const div = document.createElement('div')
            div.className = 'inline poll-option'
            div.setAttribute('onclick',
                `const cb=this.querySelector('input');cb.checked=!cb.checked;${isMultiple ? '' : `uncheckOtherPollOptions(cb,${messageId});`}this.classList.toggle('selected',cb.checked)`)
            div.innerHTML = `<input type="checkbox" data-option-id="${newOption.id}" onclick="event.stopPropagation()"/><span></span>`
            div.querySelector('span').textContent = newOption.text
            optionList.appendChild(div)
        }

        input.value = ''
    }

    xhr("add_poll_option?poll_id=" + pollId + "&text=" + encodeURIComponent(text), onload)
}
window.addUserPollOption = addUserPollOption

// ── Poll Results ───────────────────────────────────────────────────────────────

function showPollResults(pollId, messageId) {
    const container = document.querySelector(`#message-${messageId} .poll-message`)
    if (!container) return

    const resultsDiv = container.querySelector('.poll-results')
    if (resultsDiv && resultsDiv.style.display !== 'none') {
        resultsDiv.style.display = 'none'
        container.querySelector('.poll-option-list').style.display = ''
        container.querySelector('.poll-footer').style.display = ''
        return
    }

    const onload = function () {
        const data = JSON.parse(this.responseText)
        const totalVoters = data.totalVoters || 0
        let html = '<div class="poll-results">'
        html += `<h4>${_t('Results')} (${totalVoters} ${totalVoters === 1 ? _t('vote') : _t('votes')})</h4>`

        for (const opt of data.options) {
            const voters = data.votes[String(opt.id)] || []
            const count = voters.length
            const pct = totalVoters > 0 ? Math.round((count / totalVoters) * 100) : 0

            html += `<div class="poll-result-row">
                <div class="poll-result-label">
                    <span>${opt.text}</span>
                    <span>${count} (${pct}%)</span>
                </div>
                <div class="poll-result-bar-bg">
                    <div class="poll-result-bar" style="width:${pct}%"></div>
                </div>
            </div>`
        }
        html += `<div class="btn" onclick="showPollResults(${pollId},${messageId})">${_t('Back to vote')}</div>`
        html += '</div>'

        // Hide options, show results
        container.querySelector('.poll-option-list').style.display = 'none'
        container.querySelector('.poll-footer').style.display = 'none'
        const existing = container.querySelector('.poll-results')
        if (existing) existing.remove()
        container.insertAdjacentHTML('beforeend', html)
    }

    xhr("get_poll_results?poll_id=" + pollId, onload)
}
window.showPollResults = showPollResults

// ── Poll Voters modal ──────────────────────────────────────────────────────────

function openPollVoters(pollId) {
    const onload = function () {
        const data = JSON.parse(this.responseText)
        global.state.pollVotersData = data
        global.state.pollVotersSelectedOption = data.options.length > 0 ? data.options[0].id : null
        openMenu('poll-voters')
        // Render after menu is open
        setTimeout(() => renderPollVotersContent(), 100)
    }
    xhr("get_poll_results?poll_id=" + pollId, onload)
}
window.openPollVoters = openPollVoters

function selectPollVotersOption(optionId) {
    global.state.pollVotersSelectedOption = optionId
    renderPollVotersContent()
}
window.selectPollVotersOption = selectPollVotersOption

function renderPollVotersContent() {
    const data = global.state.pollVotersData
    if (!data) return

    const tabsContainer = document.getElementById('poll-voters-tabs')
    const listContainer = document.getElementById('poll-voters-list')
    if (!tabsContainer || !listContainer) return

    const totalVoters = data.totalVoters || 0

    // Render title
    const titleEl = document.getElementById('poll-voters-question')
    if (titleEl) titleEl.textContent = data.poll.question

    const countEl = document.getElementById('poll-voters-count')
    if (countEl) countEl.textContent = `${totalVoters} ${totalVoters === 1 ? _t('vote') : _t('votes')}`

    // Render option tabs
    let tabsHtml = ''
    for (const opt of data.options) {
        const voters = data.votes[String(opt.id)] || []
        const selected = opt.id === global.state.pollVotersSelectedOption ? 'selected' : ''
        tabsHtml += `<div class="poll-voter-tab ${selected}" onclick="selectPollVotersOption(${opt.id})">${opt.text} (${voters.length})</div>`
    }
    tabsContainer.innerHTML = tabsHtml

    // Render voter list for selected option
    const selectedVoters = data.votes[String(global.state.pollVotersSelectedOption)] || []
    let listHtml = ''
    for (const voterId of selectedVoters) {
        const user = global.users[voterId]
        const name = user ? user.display : `#${voterId}`
        const pfp = user?.pfp ? `background-image:url(/static/attachments/${user.pfp})` : ''
        listHtml += `<div class="poll-voter-item inline">
            <div class="pfp red small" style="${pfp}"></div>
            <span>${name}</span>
        </div>`
    }
    if (selectedVoters.length === 0) {
        listHtml = `<p class="poll-no-votes">${_t('No votes yet')}</p>`
    }
    listContainer.innerHTML = listHtml
}
window.renderPollVotersContent = renderPollVotersContent

// ── Upload file from + menu ────────────────────────────────────────────────────

function triggerFileUpload() {
    const input = document.getElementById('chat-file-upload')
    if (input) input.click()
}
window.triggerFileUpload = triggerFileUpload

function handleChatFileUpload(event) {
    const files = event.target.files
    for (let i = 0; i < files.length; i++) {
        displayMessageAttachment(files[i])
    }
    // Reset input so same file can be selected again
    event.target.value = ''
    // Close the flying menu
    if (global.state.activeFM) {
        global.state.activeFM.classList.remove("visible")
        global.state.activeFM = undefined
    }
}
window.handleChatFileUpload = handleChatFileUpload

// ── Poll checker for templates ─────────────────────────────────────────────────

function isPollMessage(element) {
    if (element.poll) return true
    let attachments = element.attachments
    if (typeof attachments === 'string') {
        try { attachments = JSON.parse(attachments) } catch (e) { return false }
    }
    if (!Array.isArray(attachments)) return false
    return attachments.some(a => a && a.type === 'poll')
}
window.isPollMessage = isPollMessage

function getPollTotalVoters(poll) {
    if (!poll || !poll.votes) return 0
    const allVoters = new Set()
    for (const optId in poll.votes) {
        for (const v of poll.votes[optId]) {
            allVoters.add(v)
        }
    }
    return allVoters.size
}
window.getPollTotalVoters = getPollTotalVoters

function hasUserVotedOption(poll, optionId) {
    if (!poll || !poll.votes) return false
    const voters = poll.votes[String(optionId)]
    return voters && voters.includes(global.user.id)
}
window.hasUserVotedOption = hasUserVotedOption

function uncheckOtherPollOptions(checkbox, messageId) {
    const container = document.querySelector(`#message-${messageId} .poll-option-list`)
    if (!container) return
    for (const cb of container.querySelectorAll('input[type="checkbox"]')) {
        if (cb !== checkbox) {
            cb.checked = false
            cb.closest('.poll-option')?.classList.remove('selected')
        }
    }
}
window.uncheckOtherPollOptions = uncheckOtherPollOptions


