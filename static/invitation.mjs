import {initTranslations} from "./translations/translation.mjs";
import global from "/static/framework/global.mjs"
import {xhr} from "./framework/templating.mjs";
import {goTo} from "./framework/navigation.mjs";
import {setElement} from "./framework/vesta.mjs";
import {channelRoute} from "./routes.mjs";

window.global = global
global.state.jwt = document.cookie.split("auth=")[1] !== undefined
global.state.link = window.location.pathname.split('/')[1]
await initTranslations()


if (document.getElementById("main-selector valid")){
    const onload = function (){
        const data = JSON.parse(this.responseText)
        global.state.serverName = data.name
        global.state.serverPfp = data.pfp
        global.state.inviteChannel = data.channel
        goTo('main-selector valid', "invitation-snippet", undefined, true, () => {
            setElement('global.state.serverPfp', data.pfp)
        })
    }
    xhr(`/server_display?invite=${global.state.link}`,onload)

}else{
    goTo('main-selector',"expired-invitation-snippet",undefined, true)
}

/** Joins (a member just follows the link), then opens the server, or the invitation's channel. */
function joinInvitation(){
    xhr(`/join_server?invite_code=${encodeURIComponent(global.state.link)}`, function (){
        // Expired since the page loaded, or banned from the server: the same page as a dead link
        if (this.status === 403 || this.status === 404) {
            goTo('main-selector valid', "expired-invitation-snippet", undefined, true)
            return
        }
        if (this.status !== 200) return
        const {server, channel, channel_type} = JSON.parse(this.responseText)
        window.location.href = '/channels#' + (channel ? channelRoute(server, channel_type, channel) : server)
    }, "POST")
}
window.joinInvitation = joinInvitation
