import {initTranslations} from "./translations/translation.mjs";
import global from "/static/framework/global.mjs"
import {xhr} from "./framework/templating.mjs";
import {goTo} from "./framework/navigation.mjs";
import {setElement} from "./framework/vesta.mjs";

window.global = global
global.state.jwt = document.cookie.split("auth=")[1] !== undefined
global.state.link = window.location.pathname.split('/')[1]
await initTranslations()


if (document.getElementById("main-selector valid")){
    const onload = function (){
        const data = JSON.parse(this.responseText)
        global.state.serverName = data.name
        global.state.serverPfp = data.pfp
        goTo('main-selector valid', "invitation-snippet", undefined, true, () => {
            setElement('global.state.serverPfp', data.pfp)
        })
    }
    xhr(`/server_display?invite=${global.state.link}`,onload)

}else{
    goTo('main-selector',"expired-invitation-snippet",undefined, true)
}
