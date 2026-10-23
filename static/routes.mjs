// Hash routes of the app (/channels#…), parsed by navigation.mjs handleHashRoute.
// A channel's is "<server>/<type>/<id>[/…]": ids are per channel type, the type says
// which one. Also imported by the invitation page.

/** Route of a channel, or of something in it: ("folder", 3), ("file", 9), ("post", 7), ("chat"). */
export function channelRoute(serverId, type, id, ...rest) {
    return [serverId, type, id, ...rest].join('/')
}
window.channelRoute = channelRoute

/** Absolute link to a channel ("Copy link"). */
export function channelLink(serverId, type, id) {
    return `${location.origin}/channels#${channelRoute(serverId, type, id)}`
}
window.channelLink = channelLink
