import global from "./framework/global.mjs"
import {lookFor} from "./crud.mjs";
import {xhr} from "./framework/templating.mjs";
import {setElement} from "./framework/vesta.mjs";


function updateMessageInGlobal(messageId, newContent) {
    const conv = global.convs[global.state.activeConv];
    if (!conv || !conv.messages) return;

    const message = conv.messages[messageId];
    if (message) {
        setElement(`global.convs[${global.state.activeConv}].messages[${messageId}].body`, newContent);
        setElement(`global.convs[${global.state.activeConv}].messages[${messageId}].edited`, true);
    }
}

function deafen(){
    const callManager = global.state.callManager;
    if (callManager) callManager.toggleDeafen();
}
window.deafen = deafen

function mute(){
    const callManager = global.state.callManager;
    if (callManager) callManager.toggleMute();
}
window.mute = mute

function toggleVideo(){
    const callManager = global.state.callManager;
    if (callManager) {
        callManager.toggleVideo();
    }
}
window.toggleVideo = toggleVideo

function silent_typing(){
    event.currentTarget.lastElementChild.classList.toggle("visible")
    if(!global.settings.silent_typing){
        global.settings.silent_typing = false
    }
    window.localStorage.setItem("silent_typing", (!global.settings.silent_typing).toString())
    global.settings.silent_typing = !global.settings.silent_typing
}
window.silent_typing = silent_typing

function reply(msg_id){
    document.getElementById("replyBox").style.display = "flex"
    global.convs[global.state.activeConv].reply = msg_id
    const msg = global.convs[global.state.activeConv].messages?.[msg_id]
    if (msg) {
        document.getElementById("replyName").innerText = global.users[msg.sender].display
    }
    document.querySelector(".chat-input textarea").focus()
}
window.reply = reply

function editMsg(msg_id){
    // get the message element
    const msgBox = document.querySelector('#message-'+msg_id.toString())
    const msgContent = msgBox.querySelector('.content')
    const msg = global.convs[global.state.activeConv].messages?.[msg_id]
    if (!msg) return;

    // hide the message
    console.log(msg)
    msgContent.style.display = 'none'
    // display the input

    const editElt = msgBox.querySelector('.edit')
    let textarea
    if (editElt){
        editElt.style.display = "block"
        textarea = editElt.querySelector('textarea')

    }else{
        const div = document.createElement('div')

        div.style.width = 'calc(100% - 1rem);'
        div.style.height = 'fit-content'
        div.classList.add('edit')
        const editValue = msg.poll ? msg.poll.question : msg.body
        div.innerHTML = `<textarea onkeydown="onEdition(event,${msg_id})" rows="5" maxlength="5000" oninput="resizeHeight(event)" onblur="saveCursorPosition(event)">${editValue}</textarea>
<div class="helper">échap pour <div class=action onclick="cancelEdition(${msg_id})">annuler</div> • entrée pour <div class="action" onclick="saveEdition(${msg_id})">enregistrer</div></div>`


        msgBox.appendChild(div)
        // focus the new input
        textarea = div.querySelector('textarea')

    }
    const length = textarea.value.length;
    textarea.focus();
    textarea.setSelectionRange(length, length);


}
window.editMsg = editMsg

function delMsg(msg_id){
    if (confirm('Voulez-vous vraiment supprimer ce message ?')) {

        const onload = function() { // request successful
            // Other members get a message_deleted WS notif; the deleter doesn't.
            if (this.status === 200) window.removeMessageLocally?.(msg_id)
        };
        xhr("delete_message?message_id="+msg_id, onload)
    }
}
window.delMsg = delMsg

function onEdition(event,id){
    if(event.key === "Enter" && !event.shiftKey){
        const target = event.currentTarget

        saveEdition(id)
        event.preventDefault()
    }else if(event.key === "Escape"){
        cancelEdition(id)
    }
}
window.onEdition = onEdition

function saveEdition(id){
    const msgBox = document.querySelector('#message-'+id.toString())
    const editor = msgBox.querySelector('.edit')
    const textarea = editor.querySelector('textarea')
    const trimmedContent = textarea.value.trim()

    // Si le contenu est vide, annuler l'édition au lieu d'envoyer
    if (trimmedContent === ''){
        cancelEdition(id)
        return
    }

    const onEdited = function (){
        console.log("Message edited successfully")

        updateMessageInGlobal(id, trimmedContent)
        cancelEdition(id)
    }

    xhr("edit_message?message_id=".concat(id,"&content=",encodeURIComponent(trimmedContent)), onEdited)
}
window.saveEdition = saveEdition

function cancelEdition(id){
    const msgBox = document.querySelector('#message-'+id.toString())

    const target = msgBox.querySelector('.edit')
    target.style.display = "none"

    const msgContent = msgBox.querySelector('.content')
    msgContent.style.display = "block"
}
window.cancelEdition = cancelEdition

function cancelReply(){
    global.convs[global.state.activeConv].reply = null
    document.getElementById("replyBox").style.display = "none"
}
window.cancelReply = cancelReply
