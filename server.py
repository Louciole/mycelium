import fastpysgi
from vesta import Server, HTTPError, HTTPRedirect
import json
import os
import datetime

# Firebase imports for FCM push notifications
import firebase_admin
from firebase_admin import credentials, messaging

# websockets imports
import websockets

from callManager import CallManager
from driveManager import DriveManager
from forumManager import ForumMixin
from message_helpers import _lookupMessagePlace
from constants import PATH, USER_STORAGE_QUOTA, SERVER_STORAGE_QUOTA
import permissions
import ws_handlers

fastpysgi.server.max_content_length = 100 * 1024 * 1024  # 100 MB


class Mycelium(ForumMixin, Server):
    features = {"websockets": True, "errors": {404: "/static/404.html"}}
    clients = []
    _admin_cache = None  # Cache for admin user IDs
    _admin_cache_time = None  # Last cache update time

    def __init__(self, *args, **kwargs):
        super().__init__(path=PATH, configFile="/server.ini", noStart=True)
        self.callManager = CallManager(self.db)
        self.drive = DriveManager(self)
        self._refreshAdminCache()  # Initialize admin cache

        if not self.config.getboolean("server", "DEBUG"):
            cred_path = os.path.join(PATH, "serviceAccountKey.json")
            if os.path.exists(cred_path):
                try:
                    cred = credentials.Certificate(cred_path)
                    firebase_admin.initialize_app(cred)
                    print("Firebase Admin SDK initialized successfully")
                except Exception as e:
                    print(f"Failed to initialize Firebase Admin SDK: {e}")
            else:
                print(f"Warning: {cred_path} not found. Push notifications will not work.")
        else:
            print("Running in DEBUG mode: Firebase Admin SDK initialization skipped.")

        self.start()

    def sendPushNotification(self, uid, data):
        """
        Send a generic push notification to a user's registered devices.
        uid: target user ID
        data: dict with 'title', 'body', and optional 'data' dict
        """
        # Do not send notifications in DEBUG mode
        if self.config.getboolean("server", "DEBUG"):
            return

        # Get user's tokens
        tokens_records = self.db.getFilters("device_token", ["account", "=", uid])
        if not tokens_records:
            return

        tokens = [t["token"] for t in tokens_records]

        try:
            title = data.get("title", "Mycelium")
            body = data.get("body", "New activity")

            # DATA-ONLY message on Android: no top-level `notification` block, so
            # FCM delivers to MyceliumMessagingService.onMessageReceived() in ALL
            # app states (foreground/background/killed). The native service builds
            # the notification and attaches the inline "Reply" action — which is
            # impossible with an OS-rendered notification payload. title/body are
            # carried in `data` for the service to render.
            data_payload = {k: str(v) for k, v in data.get("data", {}).items()}
            data_payload["title"] = title
            data_payload["body"] = body

            # iOS: show a visible alert. For DMs, attach the "MESSAGE_ACTION"
            # category so the OS renders the inline reply field — that category
            # is registered client-side via LocalNotifications.registerActionTypes
            # and applies to remote push too. The reply text comes back through
            # the Capacitor plugin's pushNotificationActionPerformed (inputValue).
            aps = messaging.Aps(
                alert=messaging.ApsAlert(title=title, body=body),
                sound="default",
                badge=1,
                category="MESSAGE_ACTION" if data_payload.get("type") == "message" else None,
            )

            # Diagnostic: confirms the deployed server is the data-only version.
            print(f"[push] uid={uid} type={data_payload.get('type')} "
                  f"tokens={len(tokens)} mode=data-only")

            # Construct MulticastMessage
            message = messaging.MulticastMessage(
                data=data_payload,
                android=messaging.AndroidConfig(priority="high"),
                apns=messaging.APNSConfig(
                    payload=messaging.APNSPayload(aps=aps),
                ),
                tokens=tokens,
            )

            response = messaging.send_each_for_multicast(message)

            if response.failure_count > 0:
                print(f"Failed to send {response.failure_count} push notifications")
                for idx, resp in enumerate(response.responses):
                    if not resp.success:
                        # Check error code and delete if 'registration-token-not-registered'
                        err_code = resp.exception.code
                        if err_code == 'messaging/registration-token-not-registered':
                             self.db.deleteSomething("device_token", tokens[idx], "token")
        except Exception as e:
            print(f"Error sending push notifications: {e}")

    @Server.expose
    def index(self):
        return self.file(PATH + "/static/home/home.html")

    @Server.expose
    def privacy(self):
        return self.file(PATH + "/static/home/privacy.html")

    @Server.expose
    def TOS(self):
        return self.file(PATH + "/static/home/tos.html")

    @Server.expose
    def legal(self):
        return self.file(PATH + "/static/home/legal.html")

    @Server.expose
    def sw(self):
        # Service worker served at root so its scope covers '/channels' (the app
        # entry), not just '/static'. no-cache so version bumps propagate fast.
        content = self.file(PATH + "/static/sw.js", responseFile=False)
        self.response.type = "application/javascript"
        self.response.headers = [
            ('Content-Type', 'application/javascript'),
            ('Service-Worker-Allowed', '/'),
            ('Cache-Control', 'no-cache'),
        ]
        return content


    @Server.expose
    def channels(self, uid="me"):
        info = Server.checkJwt(self)  # base check: a suspended account gets its screen, not a 403
        if self.activeSuspension(info["username"]):
            raise HTTPRedirect(self.response, "/static/suspended.html")
        self.response.headers.append(('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=()'))
        return self.file(PATH + "/static/main.html")

    @Server.expose
    def default(self, target, **kwargs):
        target = target.strip('/')
        res = self.db.getSomething("invitation",target,"link")
        if res and res != []:
            if res["expiration"] < datetime.datetime.now():
                return self.file(PATH + "/static/expired_invitation.html")
            else:
                return self.file(PATH + "/static/invitation.html")
        else:
            raise HTTPError(self.response,404,"Not Found")

    def onLogin(self, uid):
        if not self.db.getSomething("mycelium_account", uid):
            self.db.insertDict("mycelium_account", {"id": uid, "username": '#' + str(uid)})
        if not self.db.getSomething("status", uid):
            self.db.insertDict("status", {"id": uid})

    def getUserConnection(self, id):
        return self.db.getSomething("active_client", id, "userid")

    def newConv(self, name, members, private=True):
        account_id = self.getUser()
        conv_id = self.db.insertDict('conversation', {'name': name, 'private':private}, getId=True)
        self.db.insertDict('accessconversation', {'account': account_id, 'conversation': conv_id})
        for i in range(0, len(members)):  # this could be batched !
            self.db.insertDict('accessconversation', {'account': members[i], 'conversation': conv_id})
        return conv_id

    def clean(self):
        for client, ws in self.pool.items():
            self.db.deleteSomething("active_client",client)
            self.db.deleteSomething("subscription",client,selector="client")

    # --------------------------------WEBSOCKETS--------------------------------

    async def handle_message(self, websocket):
        try:
            await self._handle_messages(websocket)
        finally:
            await self._cleanup_connection(websocket)

    async def _cleanup_connection(self, websocket):
        if websocket in self.clients:
            self.clients.remove(websocket)

        for connection_id in [cid for cid, entry in list(self.waiting_clients.items())
                              if entry["connection"] == websocket]:
            self.waiting_clients.pop(connection_id, None)

        for client_id in [cid for cid, ws in list(self.pool.items()) if ws == websocket]:
            client = self.db.getSomething("active_client", client_id)
            self.pool.pop(client_id, None)
            self.db.deleteSomething("active_client", client_id)
            self.db.deleteSomething("subscription", client_id, selector="client")
            if client:
                await self._cleanup_user_calls(client["userid"])
                await self.sendStatusUpdatesAsync(client["userid"])

    async def _cleanup_user_calls(self, user_id):
        """A WS dropped without an explicit hang-up — remove the user from any
        active call so the session is properly ended instead of lingering as a
        zombie (active=true forever). Mirrors the notifications of call_leave."""
        import ws_handlers as _wsh
        for call_id in self.callManager.get_active_call_ids_for_user(user_id):
            result = self.callManager.leave_call(call_id, user_id)
            if not result:
                continue
            call = result["call"]

            if call.vocal_channel_id:
                # Vocal channel call — notify remaining participants + server members
                if not result.get("ended"):
                    for participant_id in call.participants:
                        await self.sendNotificationAsync(participant_id, {
                            "type": "call_participant_left",
                            "content": {
                                "call": call.to_dict(),
                                "user_id": user_id,
                                "mode_changed": False
                            }
                        })
                await _wsh._broadcast_vocal_leave(self, call, user_id)
                continue

            if result.get("ended"):
                members = self.db.getAll("accessconversation", call.conversation_id, "conversation")
                for member in members:
                    await self.sendNotificationAsync(member["account"], {
                        "type": "call_ended",
                        "content": {"call_id": call_id, "conversation_id": call.conversation_id}
                    })
            else:
                for participant_id in call.participants:
                    await self.sendNotificationAsync(participant_id, {
                        "type": "call_participant_left",
                        "content": {
                            "call": call.to_dict(),
                            "user_id": user_id,
                            "mode_changed": result.get("mode_changed", False)
                        }
                    })

    async def _handle_messages(self, websocket):
        self.clients.append(websocket)
        self.calls = {}

        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                except (json.JSONDecodeError, TypeError):
                    print("WS ignoring malformed message:", message)
                    continue
                print("WS message received :", message)
                handler = ws_handlers.HANDLERS.get(data.get("type"))
                if handler:
                    await handler(self, websocket, data)
                else:
                    print("unknown message received", message)
        except (websockets.exceptions.ConnectionClosedOK,
                websockets.exceptions.ConnectionClosedError) as e:
            # Client dropped without a proper close handshake (network loss,
            # app backgrounded/killed, tab closed). This is expected — the
            # `finally` in handle_message() runs _cleanup_connection().
            print(f"WS connection closed: {e.__class__.__name__}")

    # -----------------------------------API-------------------------------------


    @Server.expose
    def test(self):
        if not self.config.getboolean("server", "DEBUG"):
            raise HTTPError(self.response, 404)
        return self.file(PATH + "/.idea/test.html")


    @Server.expose
    def get_debug_otp(self, email):
        """
        Endpoint pour récupérer l'OTP en mode DEBUG uniquement
        Utilisé pour les tests automatisés
        """
        if not self.config.getboolean("server", "DEBUG"):
            raise HTTPError(self.response, 403, "This endpoint is only available in DEBUG mode")

        # Récupérer l'OTP depuis la base de données verif_code
        account = self.uniauth.getUserCredentials(email)
        if not account:
            raise HTTPError(self.response, 404, "User not found")

        verif_code = self.uniauth.getSomething("verif_code", account["id"])
        if not verif_code:
            raise HTTPError(self.response, 404, "No verification code found for this user")

        # Vérifier que le code n'est pas expiré
        if verif_code["expiration"] < datetime.datetime.now():
            raise HTTPError(self.response, 410, "Verification code has expired")

        return json.dumps({
            "code": verif_code["code"],
            "expiration": verif_code["expiration"]
        }, default=str)


    def uploadDrive(self, user_id, drive_id, file, parent_folder=None):
        return self.drive.upload(user_id, drive_id, file, parent_folder)

    def isAdmin(self, uid):
        # Use cached admin list for performance (instead of DB query every time)
        if self._admin_cache is None or self._shouldRefreshAdminCache():
            self._refreshAdminCache()

        return uid in self._admin_cache

    def _refreshAdminCache(self):
        """Refresh the admin cache from database"""
        import datetime

        # Get all users with admin rights in op servers
        with self.db.pool.connection() as conn:
            users_op_servs = conn.execute(
                "SELECT DISTINCT accessServer.account FROM op_servs, accessServer WHERE op_servs.server = accessServer.server",
                ()
            ).fetchall()

        admin_ids = set()

        for user_op_serv in users_op_servs:
            uid = user_op_serv["account"]
            # Check if user has mycelium_admin right
            if self._hasAdminRight(uid):
                admin_ids.add(uid)

        self._admin_cache = admin_ids
        self._admin_cache_time = datetime.datetime.now()

    def _hasAdminRight(self, uid):
        """Check if user has mycelium_admin right (helper for cache refresh)"""
        with self.db.pool.connection() as conn:
            users_op_servs = conn.execute(
                "SELECT * FROM op_servs, accessServer WHERE op_servs.server = accessServer.server AND accessServer.account = %s",
                (uid,)
            ).fetchall()

        for user_op_serv in users_op_servs:
            server_id = user_op_serv["server"]
            # "mycelium-admin" is the key the role editor writes (static/access.mjs);
            # the legacy underscore spelling is still honoured for existing roles.
            if (self.checkAccessRights(uid, server_id, "mycelium-admin")
                    or self.checkAccessRights(uid, server_id, "mycelium_admin")):
                return True

        return False

    def _shouldRefreshAdminCache(self):
        """Check if admin cache should be refreshed (every 5 minutes)"""
        import datetime

        if self._admin_cache_time is None:
            return True

        # Refresh cache every 5 minutes
        age = datetime.datetime.now() - self._admin_cache_time
        return age.total_seconds() > 300  # 5 minutes

    def invalidateAdminCache(self):
        """Invalidate admin cache (call this when admin rights change)"""
        self._admin_cache = None
        self._admin_cache_time = None

    # --------------------------------STORAGE QUOTA--------------------------------

    def _estimateBase64Size(self, data):
        """Estimate the actual file size from base64-encoded data."""
        if "," in data:
            data = data.split(",")[1]
        return int(len(data) * 3 / 4)

    def _adjustStorage(self, server_id, delta):
        """Add delta bytes (negative to decrement) to the right target for a server."""
        if delta == 0:
            return
        personal = self.db.getFilters("personal_server", ["server", "=", server_id])
        if personal:
            with self.db.pool.connection() as conn:
                conn.execute(
                    "UPDATE mycelium_account SET storage_usage = GREATEST(0, storage_usage + %s) WHERE id = %s",
                    (delta, personal[0]["owner"])
                )
        else:
            with self.db.pool.connection() as conn:
                conn.execute(
                    "UPDATE server SET storage_usage = GREATEST(0, storage_usage + %s) WHERE id = %s",
                    (delta, server_id)
                )

    def _adjustUserStorage(self, uid, delta):
        """Add delta bytes (negative to decrement) directly to a user's storage_usage."""
        if delta == 0:
            return
        with self.db.pool.connection() as conn:
            conn.execute(
                "UPDATE mycelium_account SET storage_usage = GREATEST(0, storage_usage + %s) WHERE id = %s",
                (delta, uid)
            )

    def _checkQuota(self, server_id, size):
        """Raise HTTPError 413 if adding size bytes would exceed the server's quota."""
        personal = self.db.getFilters("personal_server", ["server", "=", server_id])
        if personal:
            target = self.db.getSomething("mycelium_account", personal[0]["owner"])
            quota, target_type = USER_STORAGE_QUOTA, "user"
        else:
            target = self.db.getSomething("server", server_id)
            quota, target_type = SERVER_STORAGE_QUOTA, "server"
        usage = target.get("storage_usage", 0) if target else 0
        if usage + size > quota:
            raise HTTPError(self.response, 413, json.dumps({
                "error": "storage_quota_exceeded",
                "current_usage": usage,
                "quota": quota,
                "target_type": target_type
            }))

    def _checkUserQuota(self, uid, size):
        """Raise HTTPError 413 if adding size bytes would exceed the user's personal quota."""
        user = self.db.getSomething("mycelium_account", uid)
        usage = user.get("storage_usage", 0) if user else 0
        if usage + size > USER_STORAGE_QUOTA:
            raise HTTPError(self.response, 413, json.dumps({
                "error": "storage_quota_exceeded",
                "current_usage": usage,
                "quota": USER_STORAGE_QUOTA,
                "target_type": "user"
            }))

    def _isFilepathOrphaned(self, filepath, exclude_message_id=None, exclude_drive_file_id=None):
        """
        Return True if no other message attachment or drive_file still references this filepath.
        Pass the IDs being deleted so they are excluded from the check.
        Shared by message deletion (routes/messaging) and DriveManager.delete_file.
        """
        # Check drive_file table
        with self.db.pool.connection() as conn:
            if exclude_drive_file_id:
                drive_refs = conn.execute(
                    "SELECT id FROM drive_file WHERE filepath = %s AND id != %s",
                    (filepath, exclude_drive_file_id)
                ).fetchall()
            else:
                drive_refs = conn.execute(
                    "SELECT id FROM drive_file WHERE filepath = %s",
                    (filepath,)
                ).fetchall()
        if drive_refs:
            return False

        # Check message.attachments JSON column for any remaining reference
        with self.db.pool.connection() as conn:
            if exclude_message_id:
                msg_refs = conn.execute(
                    "SELECT id FROM message WHERE attachments::text LIKE %s AND id != %s",
                    (f'%{filepath}%', exclude_message_id)
                ).fetchall()
            else:
                msg_refs = conn.execute(
                    "SELECT id FROM message WHERE attachments::text LIKE %s",
                    (f'%{filepath}%',)
                ).fetchall()
        return not msg_refs


    def onWSAuth(self,uid):
        self.sendStatusUpdates(uid)


    def require_member(self, uid, server_id):
        """Require that uid is a member of server_id. Returns the accessserver row."""
        access = self.db.getFilters("accessserver", ["account", "=", uid, "and", "server", "=", server_id])
        if not access:
            raise HTTPError(self.response, 403, "forbidden")
        return access[0]

    def require_server_perm(self, uid, server_id, action):
        """Require that uid has the `action` permission on server_id (owner always passes)."""
        if not self.checkAccessRights(uid, server_id, action):
            raise HTTPError(self.response, 403, "forbidden")

    def require_channel_access(self, uid, channel_id, channel_type, action="view"):
        """Require that uid can perform `action` on a channel. Returns the channel row.

        Raises 400 for an unknown channel type, 404 if the channel doesn't exist,
        403 if the user lacks access (membership for public channels, role
        permissions for private ones)."""
        table = self._getChannelTable(channel_type)
        if not table:
            raise HTTPError(self.response, 400, "invalid channel type")
        chan = self.db.getSomething(table, channel_id)
        if not chan:
            raise HTTPError(self.response, 404, "channel not found")
        if not self.checkChannelAccess(uid, channel_id, channel_type, action):
            raise HTTPError(self.response, 403, "forbidden")
        return chan

    # --------------------------------MODERATION--------------------------------
    # Enforcement + logging helpers shared by routes/moderation.py and the
    # endpoints moderation touches (joins, send_message, reactions, vocal, delete).

    def hasServerPerm(self, uid, server_id, perm):
        """True if uid holds `perm` on server_id. server-admin (and the owner)
        imply every moderation right — see checkAccessRights."""
        return self.checkAccessRights(uid, server_id, perm)

    def require_mod_perm(self, uid, server_id, perm):
        """403 unless uid holds the moderation right `perm` (or server-admin) on server_id."""
        if not self.hasServerPerm(uid, server_id, perm):
            raise HTTPError(self.response, 403, "forbidden")

    def isBannedFromServer(self, uid, server_id):
        return bool(self.db.getFilters("server_ban", ["server", "=", server_id, "and", "account", "=", uid]))

    def activeServerTimeout(self, uid, server_id):
        """The unexpired server_timeout row for (server, uid), or None. Expired rows
        are lazily deleted (same treatment as channel_mute.muted_until)."""
        rows = self.db.getFilters("server_timeout", ["server", "=", server_id, "and", "account", "=", uid])
        if not rows:
            return None
        row = rows[0]
        if row["expires_at"] is not None and row["expires_at"] <= datetime.datetime.now():
            self.db.deleteSomething("server_timeout", row["id"])
            return None
        return row

    def enforceNotTimedOut(self, uid, server_id):
        row = self.activeServerTimeout(uid, server_id)
        if row:
            raise HTTPError(self.response, 403, json.dumps({
                "error": "timed_out",
                "server_id": server_id,
                "expires_at": str(row["expires_at"]) if row["expires_at"] else None,
            }))

    def logModeration(self, server_id, moderator, action, target_account=None, reason=None, metadata=None):
        self.db.insertDict("moderation_log", {
            "server": server_id, "moderator": moderator, "target_account": target_account,
            "action": action, "reason": reason or None, "metadata": json.dumps(metadata or {}),
        })

    def logPlatform(self, moderator, action, target_account=None, target_server=None, reason=None, metadata=None):
        self.db.insertDict("platform_action_log", {
            "moderator": moderator, "action": action, "target_account": target_account,
            "target_server": target_server, "reason": reason or None, "metadata": json.dumps(metadata or {}),
        })

    def activeSuspension(self, uid):
        """The unexpired account_suspension row for uid, or None (expired rows lazily deleted)."""
        rows = self.db.getFilters("account_suspension", ["account", "=", uid])
        if not rows:
            return None
        row = rows[0]
        if row["expires_at"] is not None and row["expires_at"] <= datetime.datetime.now():
            self.db.deleteSomething("account_suspension", row["id"])
            return None
        return row

    def checkJwt(self, verif=False):
        """Vesta's JWT check + the platform suspension gate: a suspended account is
        cut off on its next request, not only at its next login. (my_suspension
        calls the base Server.checkJwt to read its own status.)"""
        info = super().checkJwt(verif)
        row = self.activeSuspension(info["username"])
        if row:
            raise HTTPError(self.response, 403, json.dumps({
                "error": "account_suspended",
                "reason": row["reason"],
                "expires_at": str(row["expires_at"]) if row["expires_at"] else None,
            }))
        return info

    def forceDisconnectUser(self, uid, notif):
        """Tell the user's live clients why, then drop them from the WS pool so they
        stop receiving notifications and fail checkWSAuth. The sockets are left to
        close on their own (they live on the WS thread's event loop); re-auth is
        refused by the suspension gate."""
        self.sendNotification(uid, notif)
        for client in self.db.getAll("active_client", uid, "userid") or []:
            self.pool.pop(client["id"], None)
            self.db.deleteSomething("active_client", client["id"])
            self.db.deleteSomething("subscription", client["id"], selector="client")

    def deleteMessageWithCleanup(self, message):
        """Delete a message row, removing its now-orphaned attachment files and
        refunding their size to the server/user quota. Callers handle authz + WS."""
        attachments = message.get("attachments")
        if isinstance(attachments, str):
            try:
                attachments = json.loads(attachments)
            except ValueError:
                attachments = []
        total_size = 0
        for attach in attachments or []:
            rel_path = attach.get("filepath", "") if isinstance(attach, dict) else ""
            if not rel_path:
                continue
            full_path = self.path + "/static/attachments/" + rel_path
            if os.path.exists(full_path) and self._isFilepathOrphaned(rel_path, exclude_message_id=message["id"]):
                total_size += os.path.getsize(full_path)
                try:
                    os.remove(full_path)
                except Exception as e:
                    print(f"Error deleting attachment {full_path}: {e}")

        if total_size > 0:
            # Refund whoever send_message charged: the server for a channel/forum post
            channel, _ = _lookupMessagePlace(self, message["place"])
            if channel:
                self._adjustStorage(channel["server"], -total_size)
            else:
                self._adjustUserStorage(message["sender"], -total_size)

        self.db.deleteSomething("message", message["id"])

    # noinspection PyPackageRequirements
    def checkAccessRights(self, uid, server, action):
        if not self.db.getFilters("accessserver", ["account", "=", uid, "and", "server", "=", server]):
            return False

        serverInfos = self.db.getSomething("server", server)
        if serverInfos["owner"] == uid:
            return True

        # server-admin implies every server permission (never the op ones)
        return permissions.implies(self.getRights(server, uid), action)

    def getMemberRoles(self, serverId, uid):
        """Role rows held by uid on serverId, highest first (lowest position)."""
        serverRoles = {role["id"]: role for role in self.db.getAll("role", serverId, "server")}
        attributions = self.db.getFilters("role_attribution", ["account", "=", uid, "and", "server", "=", serverId])
        # .get: an attribution can outlive its role on a DB without the FK (db/migrate_roles.sql)
        roles = [serverRoles[a["role"]] for a in attributions if a["role"] in serverRoles]
        return sorted(roles, key=lambda r: (r["position"], r["id"]))

    def getRights(self, serverId, uid):
        """Rights granted to uid on serverId: its roles' + the @everyone defaults."""
        server = self.db.getSomething("server", serverId)
        userRights = {right: right for right in (server or {}).get("default_permissions") or {}}
        for role in self.getMemberRoles(serverId, uid):
            for right in role["permissions"] or {}:
                userRights[right] = right
        return userRights

    def memberTopPosition(self, serverId, uid):
        """Position of uid's highest role (0 = top), or None if they hold none."""
        roles = self.getMemberRoles(serverId, uid)
        return roles[0]["position"] if roles else None

    def outranks(self, serverId, uid, position):
        """True if uid sits strictly above a role at `position` (None = @everyone,
        the very bottom). The owner outranks everything."""
        server = self.db.getSomething("server", serverId)
        if server and server["owner"] == uid:
            return True
        mine = self.memberTopPosition(serverId, uid)
        if mine is None:
            return False
        return position is None or mine < position

    def _getChannelTable(self, channelType):
        """Map channel type string to table name."""
        tables = {
            "textual": "textual_channel",
            "conv": "textual_channel",
            "vocal": "vocal_channel",
            "drive": "drive_channel",
            "note": "notes_channel",
            "forum": "forum_channel",
            "category": "server_cat",
        }
        return tables.get(channelType)

    def channelContext(self, uid, serverId):
        """What it takes to evaluate uid's rights in any channel of serverId, loaded
        once (a listing reuses it for every channel). None if uid isn't a member."""
        server = self.db.getSomething("server", serverId)
        if not server or not self.db.getFilters("accessserver", ["account", "=", uid, "and", "server", "=", serverId]):
            return None
        roles = self.getMemberRoles(serverId, uid)
        rights = set(server.get("default_permissions") or {})
        for role in roles:
            rights |= set(role["permissions"] or {})
        overwrites = {}
        for row in self.db.getAll("channel_permission", serverId, "server") or []:
            overwrites.setdefault((row["channel"], row["channel_type"]), []).append(row)
        categories = {c["id"]: c for c in self.db.getAll("server_cat", serverId, "server") or []}
        return {"uid": uid, "is_owner": server["owner"] == uid, "rights": rights,
                "role_ids": {r["id"] for r in roles}, "overwrites": overwrites, "categories": categories}

    @staticmethod
    def permissionLayers(chan, channelType, overwrites, categories):
        """[(is_private, overwrites)] of a channel: its category's, then its own.
        `overwrites` maps (id, type) -> rows, `categories` id -> server_cat row."""
        layers = []
        cat = categories.get(chan.get("category")) if channelType != "category" else None
        if cat:
            layers.append((cat.get("is_private"), overwrites.get((cat["id"], "category"), [])))
        layers.append((chan.get("is_private"), overwrites.get((chan["id"], channelType), [])))
        return layers

    def channelRights(self, ctx, chan, channelType):
        """Effective rights (set) of ctx's member in a channel (or category) row —
        permissions.channel_rights over the category layer then the channel's."""
        channelType = "textual" if channelType == "conv" else channelType
        layers = self.permissionLayers(chan, channelType, ctx["overwrites"], ctx["categories"])
        return permissions.channel_rights(
            channelType, ctx["rights"], ctx["is_owner"], layers, ctx["role_ids"], ctx["uid"])

    def channelMembersRights(self, chan, channelType):
        """{account: effective rights} for every member of chan's server, batched
        (one query per table) — for fan-out (message/typing broadcasts, mentions)."""
        serverId = chan["server"]
        server = self.db.getSomething("server", serverId)
        roles = {r["id"]: r for r in self.db.getAll("role", serverId, "server") or []}
        held = {}
        for a in self.db.getAll("role_attribution", serverId, "server") or []:
            if a["role"] in roles:
                held.setdefault(a["account"], set()).add(a["role"])
        channelType = "textual" if channelType == "conv" else channelType
        overwrites = {}
        for row in self.db.getAll("channel_permission", serverId, "server") or []:
            overwrites.setdefault((row["channel"], row["channel_type"]), []).append(row)
        categories = {c["id"]: c for c in self.db.getAll("server_cat", serverId, "server") or []}
        layers = self.permissionLayers(chan, channelType, overwrites, categories)
        base = set(server.get("default_permissions") or {})
        result = {}
        for member in self.db.getAll("accessserver", serverId, "server") or []:
            account = member["account"]
            role_ids = held.get(account, set())
            rights = set(base)
            for rid in role_ids:
                rights |= set(roles[rid]["permissions"] or {})
            result[account] = permissions.channel_rights(
                channelType, rights, server["owner"] == account, layers, role_ids, account)
        return result

    def checkChannelAccess(self, uid, channelId, channelType, action="view", ctx=None):
        """True if uid holds `action` in the channel: server rights (roles + @everyone)
        adjusted by the channel's overwrites, private channels denying view to @everyone.
        Owner and server-admin pass. Pass `ctx` (channelContext) when checking many channels."""
        table = self._getChannelTable(channelType)
        if not table:
            return False
        chan = self.db.getSomething(table, channelId)
        if not chan:
            return False
        ctx = ctx or self.channelContext(uid, chan["server"])
        if not ctx:
            return False
        action = permissions.CHANNEL_ALIASES.get(action, action)
        return action in self.channelRights(ctx, chan, channelType)

    def _getChannelType(self, channelId):
        """Detect channel type from its ID by checking all channel tables."""
        for ctype, table in [("textual", "textual_channel"), ("drive", "drive_channel"), ("vocal", "vocal_channel"), ("note", "notes_channel"), ("forum", "forum_channel")]:
            chan = self.db.getSomething(table, channelId)
            if chan:
                return ctype, chan
        return None, None


    def _get_sheet_col_widths(self, spreadsheet_id):
        rows = self.db.getFilters("note_spreadsheet_col", ["spreadsheet_id", "=", spreadsheet_id]) or []
        return {str(r["col_idx"]): int(r["width_px"]) for r in rows}


    def _sheet_ref(self, col_idx, row_num):
        col = int(col_idx)
        letters = ""
        while col >= 0:
            letters = chr(65 + (col % 26)) + letters
            col = (col // 26) - 1
        return f"{letters}{int(row_num)}"


    # Clients to notify when `uid`'s status changes: clients subscribed to uid,
    # plus uid's own clients (which get the detailed status).
    STATUS_RECIPIENTS_QUERY = (
        "select ac.id, ac.userid, ac.server, ac.idle from active_client ac"
        " join subscription s on ac.id = s.client where s.account = %s"
        " union"
        " select id, userid, server, idle from active_client where userid = %s;"
    )

    def sendStatusUpdates(self, uid):
        query = self.STATUS_RECIPIENTS_QUERY
        with self.db.pool.connection() as conn:
            r = conn.execute(query, (uid, uid)).fetchall()
        for client in r:
            status = {"id":uid}
            if client["userid"] == uid:
                self.getUsersStatus([status],detailed=True)
            else :
                self.getUsersStatus([status])

            if status["status"].get("mode"):
                status["status"]["mode"] = int(status["status"]["mode"])

            self.sendNotification(client["userid"], {"type": "update_status" ,"content": status})

    async def sendStatusUpdatesAsync(self, uid):
        query = self.STATUS_RECIPIENTS_QUERY
        with self.db.pool.connection() as conn:
            r = conn.execute(query, (uid, uid)).fetchall()
        for client in r:
            status = {"id":uid}
            if client["userid"] == uid:
                self.getUsersStatus([status],detailed=True)
            else :
                self.getUsersStatus([status])

            await self.sendNotificationAsync(client["userid"], {"type": "update_status" ,"content": status})

    def getUsersStatus(self, users,detailed=False):
        #these requests could be batched
        for user in users:
            params = self.db.getSomething('status', user['id'])

            if not params:
                self.db.insertDict("status", {"id": user['id']})
                params = {"mode": 0}

            if params.get('mode') is not None:
                params['mode'] = int(params['mode'])
            if params.get('expiration') is not None:
                params['expiration'] = str(params['expiration'])

            clients = self.db.getAll('active_client', user['id'], "userid")
            if not len(clients):
                if not detailed:
                    user['status'] = {'icon': 'spymode', 'text': "Offline"}
                    continue

            if params['mode'] == 0:
                idle = True
                for client in clients:
                    if not client['idle']:
                        idle = False
                if idle:
                    if detailed:
                        if not params['text']:
                            params['text'] = "Online"
                        user['status'] = {'icon': 'green', 'text': params['text'], 'emoji': params['emoji'], 'expiration': params['expiration'], 'mode': params['mode']}
                    else:
                        if not params['text']:
                            params['text'] = "Idle"
                        user['status'] = {'icon': 'orange', 'text': params['text'], 'emoji': params['emoji']}
                else:
                    if not params['text']:
                        params['text'] = "Online"
                    if detailed:
                        user['status'] = {'icon': 'green', 'text': params['text'], 'emoji': params['emoji'], 'expiration': params['expiration'], 'mode': params['mode']}
                    else:
                        user['status'] = {'icon': 'green', 'text': params['text'], 'emoji': params['emoji']}
            elif params['mode'] == 3:
                if detailed:
                    if not params['text']:
                        params['text'] = "Offline"
                    user['status'] = {'icon': 'spymode', 'text': params['text'], 'expiration': params['expiration'], 'mode': params['mode']}
                else:
                    user['status'] = {'icon': 'spymode', 'text': "Offline"}
            elif params['mode'] == 2:
                if not params['text']:
                    params['text'] = 'Do not Disturb'
                if detailed:
                    user['status'] = {'icon': 'RED', 'text': params['text'], 'emoji': params['emoji'], 'expiration': params['expiration'], 'mode': params['mode']}
                else:
                    user['status'] = {'icon': 'RED', 'text': params['text'], 'emoji': params['emoji']}
            elif params['mode'] == 1:
                if not params['text']:
                    params['text'] = 'Idle'
                if detailed:
                    user['status'] = {'icon': 'orange', 'text': params['text'], 'emoji': params['emoji'], 'expiration': params['expiration'], 'mode': params['mode']}
                else:
                    user['status'] = {'icon': 'orange', 'text': params['text'], 'emoji': params['emoji']}

import routes.transport      # noqa: E402,F401
import routes.users          # noqa: E402,F401
import routes.servers        # noqa: E402,F401
import routes.discovery      # noqa: E402,F401
import routes.conversations  # noqa: E402,F401
import routes.messaging      # noqa: E402,F401
import routes.calls          # noqa: E402,F401
import routes.workspaces     # noqa: E402,F401
import routes.drive          # noqa: E402,F401
import routes.search         # noqa: E402,F401
import routes.moderation     # noqa: E402,F401
import routes.roles          # noqa: E402,F401

server = Mycelium(path=PATH, configFile="/server.ini")

