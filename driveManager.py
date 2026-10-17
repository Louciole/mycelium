import json
import mimetypes
import os
import re
from urllib.parse import quote

from vesta import HTTPError
from constants import PHOTON_ORIGIN


MAX_NAME_LENGTH = 255         # drive_file.filename / drive_folder.foldername are varchar(255)
MAX_LINKS = 50                # drive_links: refs resolved per call

# "<#drive:12>" mentions a drive (its ids may collide with other channel
# types', hence the prefix); it can point inside it: "drive:12/d:45" (folder)
# or "drive:12/f:301" (file). See static/drive-links.mjs.
LINK_RE = re.compile(r"^drive:(\d+)(?:/([df]):(\d+))?$")

# Ancestor chain of a folder, root first (the folder itself last).
_PATH_SQL = """
WITH RECURSIVE anc AS (
    SELECT id, foldername, parent_folder, 0 AS depth FROM drive_folder WHERE id = %(id)s
  UNION ALL
    SELECT f.id, f.foldername, f.parent_folder, anc.depth + 1
    FROM drive_folder f JOIN anc ON f.id = anc.parent_folder
)
SELECT id, foldername AS name FROM anc ORDER BY depth DESC
"""

# One folder's content, with the author's names (one query per kind, not per row).
_FOLDERS_SQL = """
SELECT fo.*, a.display AS creator_name, a.username AS creator_username
FROM drive_folder fo LEFT JOIN mycelium_account a ON a.id = fo.creator
WHERE fo.drive_channel = %(drive)s AND fo.parent_folder IS NOT DISTINCT FROM %(parent)s::integer
ORDER BY lower(fo.foldername)
"""
_FILES_SQL = """
SELECT fi.*, a.display AS uploader_name, a.username AS uploader_username
FROM drive_file fi LEFT JOIN mycelium_account a ON a.id = fi.uploader
WHERE fi.drive_channel = %(drive)s AND fi.parent_folder IS NOT DISTINCT FROM %(parent)s::integer
ORDER BY lower(fi.filename)
"""

# Members of a server with at least one connected client (websocket open).
_ONLINE_MEMBERS_SQL = """
SELECT DISTINCT ac.userid FROM active_client ac
JOIN accessserver a ON a.account = ac.userid
WHERE a.server = %(server)s
"""


class DriveManager:
    """
    Handles all drive-channel logic.

    Instantiated with the server as `srv` so it can access
    srv.db, srv.response, srv.getUser(), srv.saveFile(), etc.
    """

    def __init__(self, srv):
        self.srv = srv


    def _photon_origin(self):
        """Allowed origin for cross-origin Photon requests (config override)."""
        try:
            return self.srv.config.get("integrations", "PHOTON_ORIGIN")
        except Exception:
            return PHOTON_ORIGIN

    def _add_cors_headers(self):
        """Allow the Photon editor (separate origin) to read credentialed
        responses. A specific origin + Allow-Credentials is required; "*" is
        illegal once cookies are involved."""
        self.srv.response.headers.append(
            ('Access-Control-Allow-Origin', self._photon_origin()))
        self.srv.response.headers.append(
            ('Access-Control-Allow-Credentials', 'true'))
        self.srv.response.headers.append(('Vary', 'Origin'))

    def _get_drive_access(self, drive_id, uid):
        """Return the drive row, or raise 404/403 (view-channels in this drive:
        private drives and view overwrites — membership alone isn't enough)."""
        return self.srv.require_channel_access(uid, drive_id, "drive", "view")

    def _resolve_folder(self, drive_id, folder_id, status=404):
        """``folder_id`` as an int (None = root of the drive), or raise when the
        folder doesn't exist or lives in another drive — access is checked on the
        drive, so a folder from elsewhere must never be accepted."""
        if folder_id in (None, "", "null"):
            return None
        try:
            folder_id = int(folder_id)
        except (TypeError, ValueError):
            raise HTTPError(self.srv.response, 400, "invalid folder")
        folder = self.srv.db.getSomething("drive_folder", folder_id)
        if not folder or int(folder["drive_channel"]) != int(drive_id):
            raise HTTPError(self.srv.response, status, "Folder not found in this drive")
        return folder_id

    def _clean_name(self, name):
        """A file/folder name: trimmed, 1..255 chars, no "/" (the separator of
        drive paths in links and in the # autocomplete)."""
        name = (name or "").strip()
        if not name or len(name) > MAX_NAME_LENGTH or "/" in name:
            raise HTTPError(self.srv.response, 400, "invalid name")
        return name

    def _path(self, folder_id):
        """[{id, name}] from the root of the drive down to ``folder_id`` (included)."""
        if folder_id is None:
            return []
        with self.srv.db.pool.connection() as conn:
            return [dict(r) for r in conn.execute(_PATH_SQL, {"id": folder_id}).fetchall()]

    def _listing(self, drive_id, parent_folder):
        params = {"drive": int(drive_id), "parent": parent_folder}
        with self.srv.db.pool.connection() as conn:
            folders = [dict(r) for r in conn.execute(_FOLDERS_SQL, params).fetchall()]
            files = [dict(r) for r in conn.execute(_FILES_SQL, params).fetchall()]
        return folders, files

    def _can_manage(self, drive, owner_uid, uid):
        """Replace/rename/delete someone's item: its author, the server owner, or
        manage-files in this drive."""
        if owner_uid == uid:
            return True
        server_info = self.srv.db.getSomething("server", drive["server"])
        if server_info and server_info["owner"] == uid:
            return True
        return self.srv.checkChannelAccess(uid, drive["id"], "drive", "manage-files")

    def notify_changed(self, drive_id):
        """Live updates for the connected members who can see the drive: an open
        drive reloads, drive links shown elsewhere are resolved again
        (static/servers/drive.mjs onDriveChanged). The author included — their
        other tabs must follow too. Offline members are skipped before any
        rights are computed."""
        drive = self.srv.db.getSomething("drive_channel", drive_id)
        if not drive:
            return
        with self.srv.db.pool.connection() as conn:
            online = {r["userid"] for r in conn.execute(_ONLINE_MEMBERS_SQL, {"server": drive["server"]}).fetchall()}
        if not online:
            return
        notif = {"type": "drive_changed", "content": {"drive_id": int(drive_id), "server_id": drive["server"]}}
        for account, rights in self.srv.channelMembersRights(drive, "drive").items():
            if account in online and "view-channels" in rights:
                self.srv.sendNotification(account, notif)

    def upload(self, user_id, drive_id, file, parent_folder=None):
        """Save a file to disk and create a drive_file record. Returns the new file id."""
        filename, content = file

        # Add dataURI prefix if not present
        if not content.startswith("data:"):
            mime_type, _ = mimetypes.guess_type(filename)
            if not mime_type:
                mime_type = "application/octet-stream"
            content = f"data:{mime_type};base64,{content}"

        parts = filename.rsplit('.')
        name = parts[0]
        ext = parts[1] if len(parts) > 1 else ''

        # Approximate file size from base64 length
        content_data = content.split(",")[1] if "," in content else content
        file_size = int(len(content_data) * 3 / 4)

        # Check storage quota before saving to disk
        drive = self.srv.db.getSomething("drive_channel", drive_id)
        if drive:
            self.srv._checkQuota(drive["server"], file_size)

        filepath = self.srv.saveFile(content, name=name, ext=ext, category=f"drive_{drive_id}")

        file_id = self.srv.db.insertDict("drive_file", {
            "drive_channel": drive_id,
            "filename": filename,
            "filepath": filepath,
            "size": file_size,
            "uploader": user_id,
            "parent_folder": parent_folder
        }, getId=True)

        if drive:
            self.srv._adjustStorage(drive["server"], file_size)

        return file_id

    def upload_on_behalf(self, API_KEY, email, filename, file):
        key = self.srv.db.getSomething("api_key", API_KEY, "key")
        if not key:
            raise HTTPError(self.srv.response, 403, "forbidden")

        key_user = self.srv.db.getSomething("mycelium_account", key["owner"])
        if not key_user or not self.srv.isAdmin(key_user["id"]):
            raise HTTPError(self.srv.response, 403, "forbidden")

        user = self.srv.uniauth.getUserCredentials(email)
        if not user:
            user = self.srv.uniauth.getSomething("additional_mail", email, "email")
            if not user:
                raise HTTPError(self.srv.response, 403, "forbidden")
            uid = user["account"]
        else:
            uid = user["id"]

        print("Uploading file on behalf of user", uid, filename)
        personal_server = self.srv.db.getSomething("personal_server", uid, "owner")
        if not personal_server:
            raise HTTPError(self.srv.response, 403, "no personal server found")

        first_drive = self.srv.db.getFilters(
            "drive_channel",
            ["server", "=", personal_server["server"], "order by place asc limit 1"]
        )
        if not first_drive:
            raise HTTPError(self.srv.response, 403, "no drive channel found")

        self.upload(uid, first_drive[0]["id"], (filename, file))
        self.notify_changed(first_drive[0]["id"])

    def _require_drive_write(self, drive, drive_id, uid):
        """Raise 403 unless ``uid`` may add/replace files in this drive."""
        if not self.srv.checkChannelAccess(uid, drive_id, "drive", "send-messages"):
            raise HTTPError(self.srv.response, 403, "No permission for this drive channel")

    def _get_drive_write_access(self, drive_id, uid):
        """Drive row for a write (new folder, moves): view + send-messages, like uploads."""
        drive = self._get_drive_access(drive_id, uid)
        self._require_drive_write(drive, drive_id, uid)
        return drive

    def upload_file(self, drive_id, filename, file, parent_folder=None):
        uid = self.srv.getUser()
        drive = self._get_drive_access(drive_id, uid)

        self._require_drive_write(drive, drive_id, uid)
        parent_folder = self._resolve_folder(drive_id, parent_folder)

        file_id = self.upload(uid, drive_id, (filename, file), parent_folder)
        self.notify_changed(drive_id)
        return json.dumps({"file_id": file_id, "filename": filename})

    def list_drive(self, drive_id, folder_id=None):
        """One folder of a drive (None = root): its subfolders, its files and the
        path from the root, so the client can open any folder from a link."""
        uid = self.srv.getUser()
        drive = self._get_drive_access(drive_id, uid)
        folder_id = self._resolve_folder(drive_id, folder_id)
        folders, files = self._listing(drive_id, folder_id)
        folder = self.srv.db.getSomething("drive_folder", folder_id) if folder_id else None
        return json.dumps({
            "drive_id": int(drive_id),
            "server_id": drive["server"],
            "folder_id": folder_id,
            "folder_creator": folder["creator"] if folder else None,
            "path": self._path(folder_id),
            "folders": folders,
            "files": files,
        }, default=str)

    def get_files(self, drive_id, parent_folder=None):
        """Kept for older clients (the mobile bundle); list_drive replaces it."""
        uid = self.srv.getUser()
        self._get_drive_access(drive_id, uid)
        parent_folder = self._resolve_folder(drive_id, parent_folder)
        return json.dumps(self._listing(drive_id, parent_folder)[1], default=str)

    def get_folders(self, drive_id, parent_folder=None):
        """Kept for older clients (the mobile bundle); list_drive replaces it."""
        uid = self.srv.getUser()
        self._get_drive_access(drive_id, uid)
        parent_folder = self._resolve_folder(drive_id, parent_folder)
        return json.dumps(self._listing(drive_id, parent_folder)[0], default=str)

    def preview_file(self, file_id, max_bytes=2000):
        uid = self.srv.getUser()

        file_info = self.srv.db.getSomething("drive_file", file_id)
        if not file_info:
            raise HTTPError(self.srv.response, 404, "File not found")

        self._get_drive_access(file_info["drive_channel"], uid)

        filepath = self.srv.path + "/static/attachments/" + file_info["filepath"]
        if not os.path.exists(filepath):
            raise HTTPError(self.srv.response, 404, "File not found on disk")

        max_bytes = min(int(max_bytes), 5000)
        try:
            with open(filepath, 'r', encoding='utf-8', errors='replace') as fh:
                content = fh.read(max_bytes)
        except Exception:
            raise HTTPError(self.srv.response, 400, "Cannot read file as text")

        self.srv.response.headers.append(('Content-Type', 'text/plain; charset=utf-8'))
        return content

    def download_file(self, file_id):
        uid = self.srv.getUser()

        file_info = self.srv.db.getSomething("drive_file", file_id)
        if not file_info:
            raise HTTPError(self.srv.response, 404, "File not found")

        self._get_drive_access(file_info["drive_channel"], uid)

        filepath = self.srv.path + "/static/attachments/" + file_info["filepath"]
        if not os.path.exists(filepath):
            raise HTTPError(self.srv.response, 404, "File not found on disk")

        mime_type, _ = mimetypes.guess_type(file_info["filename"])
        if not mime_type:
            mime_type = "application/octet-stream"

        with open(filepath, 'rb') as fh:
            file_content = fh.read()

        # ASCII fallback + RFC 5987 UTF-8 name: quotes, newlines or accents in a
        # filename must not break (or inject into) the header.
        fallback = re.sub(r'[^A-Za-z0-9._ -]', '_', file_info["filename"]) or "download"
        disposition = f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(file_info['filename'], safe='')}"

        self._add_cors_headers()
        self.srv.response.headers.append(('Content-Type', mime_type))
        self.srv.response.headers.append(('Content-Disposition', disposition))
        self.srv.response.headers.append(('Content-Length', str(len(file_content))))
        return file_content

    def _files_in_folder(self, drive_id, parent_folder):
        """List drive_file rows directly under ``parent_folder`` (None = root)."""
        if parent_folder:
            return self.srv.db.getAll("drive_file", parent_folder, "parent_folder") or []
        return self.srv.db.getFilters("drive_file", [
            "drive_channel", "=", drive_id, "and", "parent_folder", "is", None
        ]) or []

    def _unique_filename(self, drive_id, parent_folder, filename):
        """Return ``filename`` made unique within its folder by appending
        " (n)" before the extension, so "save as new" never silently shadows an
        existing same-named file."""
        names = {f["filename"] for f in self._files_in_folder(drive_id, parent_folder)}
        if filename not in names:
            return filename
        dot = filename.rfind('.')
        base = filename if dot == -1 else filename[:dot]
        ext = '' if dot == -1 else filename[dot:]
        n = 1
        while f"{base} ({n}){ext}" in names:
            n += 1
        return f"{base} ({n}){ext}"

    def save_file(self, file_id, file, mode="overwrite", filename=None):
        """Save edits coming back from the Photon editor.

        ``file`` is a base64 (data-URI or raw) string, matching ``upload``'s
        contract. ``mode``:
          - ``"overwrite"`` → replace the existing file in place (same id).
                              Restricted to the uploader or a server admin, to
                              match ``delete_file``'s authority over a file.
          - ``"new"``       → create a sibling in the same folder (non-destructive,
                              e.g. opened logo.psd, saved as logo.pto). ``filename``
                              is required and supplies the new name/extension.
        The originating drive/folder is derived from ``file_id`` so the caller can
        never target an arbitrary drive. The blob is stored content-addressed
        (sha256), so distinct files never collide on disk.
        """
        uid = self.srv.getUser()

        file_info = self.srv.db.getSomething("drive_file", file_id)
        if not file_info:
            raise HTTPError(self.srv.response, 404, "File not found")

        drive_id = file_info["drive_channel"]
        drive = self._get_drive_access(drive_id, uid)
        self._require_drive_write(drive, drive_id, uid)

        self._add_cors_headers()

        if mode not in ("overwrite", "new"):
            raise HTTPError(self.srv.response, 400, "Invalid save mode")

        new_name = filename or file_info["filename"]

        # Normalise to a data-URI and approximate the decoded size.
        content = file
        if not content.startswith("data:"):
            mime_type, _ = mimetypes.guess_type(new_name)
            content = f"data:{mime_type or 'application/octet-stream'};base64,{content}"
        content_data = content.split(",")[1] if "," in content else content
        new_size = int(len(content_data) * 3 / 4)

        ext = new_name.rsplit('.', 1)[1] if '.' in new_name else ''

        if mode == "new":
            new_name = self._unique_filename(drive_id, file_info.get("parent_folder"), new_name)
            self.srv._checkQuota(drive["server"], new_size)
            # name="" → content-addressed path (no collision with the original).
            filepath = self.srv.saveFile(content, ext=ext, category=f"drive_{drive_id}")
            new_id = self.srv.db.insertDict("drive_file", {
                "drive_channel": drive_id,
                "filename": new_name,
                "filepath": filepath,
                "size": new_size,
                "uploader": uid,
                "parent_folder": file_info.get("parent_folder"),
            }, getId=True)
            self.srv._adjustStorage(drive["server"], new_size)
            self.notify_changed(drive_id)
            return json.dumps({"file_id": new_id, "filename": new_name, "mode": "new"})

        # ── Overwrite in place — uploader or admin only ───────────────────────
        if not self._can_manage(drive, file_info["uploader"], uid):
            raise HTTPError(self.srv.response, 403,
                            "Only the uploader or a server admin can overwrite this file")

        old_size = file_info.get("size", 0)
        # Only the *delta* counts against the quota for an in-place replace.
        self.srv._checkQuota(drive["server"], new_size - old_size)

        new_filepath = self.srv.saveFile(content, ext=ext, category=f"drive_{drive_id}")

        old_filepath = file_info["filepath"]
        self.srv.db.edit("drive_file", file_id, "filepath", new_filepath)
        self.srv.db.edit("drive_file", file_id, "size", new_size)
        if new_name != file_info["filename"]:
            self.srv.db.edit("drive_file", file_id, "filename", new_name)

        # Drop the previous blob if nothing else references it (content-addressed
        # saveFile means the path changed unless the bytes were identical).
        if old_filepath != new_filepath and self.srv._isFilepathOrphaned(old_filepath, exclude_drive_file_id=file_id):
            self._remove_blob(old_filepath)

        self.srv._adjustStorage(drive["server"], new_size - old_size)
        self.notify_changed(drive_id)
        return json.dumps({"file_id": file_id, "filename": new_name, "mode": "overwrite"})

    def _remove_blob(self, filepath):
        disk = self.srv.path + "/static/attachments/" + filepath
        try:
            if os.path.exists(disk):
                os.remove(disk)
        except Exception as e:
            print(f"Error deleting file {disk}: {e}")

    def delete_file(self, file_id):
        uid = self.srv.getUser()

        file_info = self.srv.db.getSomething("drive_file", file_id)
        if not file_info:
            raise HTTPError(self.srv.response, 404, "File not found")

        drive = self._get_drive_access(file_info["drive_channel"], uid)
        if not self._can_manage(drive, file_info["uploader"], uid):
            raise HTTPError(self.srv.response, 403, "Only uploader or server admins can delete files")

        if self.srv._isFilepathOrphaned(file_info["filepath"], exclude_drive_file_id=file_id):
            self._remove_blob(file_info["filepath"])

        self.srv.db.deleteSomething("drive_file", file_id)
        self.srv._adjustStorage(drive["server"], -file_info.get("size", 0))
        self.notify_changed(drive["id"])
        return json.dumps({"status": "ok", "message": "File deleted successfully"})

    def create_folder(self, drive_id, foldername, parent_folder=None):
        uid = self.srv.getUser()
        self._get_drive_write_access(drive_id, uid)
        foldername = self._clean_name(foldername)
        parent_folder = self._resolve_folder(drive_id, parent_folder)

        folder_id = self.srv.db.insertDict("drive_folder", {
            "drive_channel": drive_id,
            "foldername": foldername,
            "parent_folder": parent_folder,
            "creator": uid
        }, getId=True)

        self.notify_changed(drive_id)
        return json.dumps({"folder_id": folder_id, "foldername": foldername})

    def rename_item(self, item_type, item_id, name):
        """Rename a file or folder: same authority as deleting it."""
        uid = self.srv.getUser()
        name = self._clean_name(name)
        if item_type == "file":
            table, column, author = "drive_file", "filename", "uploader"
        elif item_type == "folder":
            table, column, author = "drive_folder", "foldername", "creator"
        else:
            raise HTTPError(self.srv.response, 400, "invalid type")

        item = self.srv.db.getSomething(table, item_id)
        if not item:
            raise HTTPError(self.srv.response, 404, "Not found")
        drive = self._get_drive_access(item["drive_channel"], uid)
        if not self._can_manage(drive, item[author], uid):
            raise HTTPError(self.srv.response, 403, "Only the author or a server admin can rename this")

        self.srv.db.edit(table, item["id"], column, name)
        self.notify_changed(drive["id"])
        return json.dumps({"status": "ok", "name": name})

    def delete_folder(self, folder_id):
        uid = self.srv.getUser()

        folder_info = self.srv.db.getSomething("drive_folder", folder_id)
        if not folder_info:
            raise HTTPError(self.srv.response, 404, "Folder not found")

        drive = self._get_drive_access(folder_info["drive_channel"], uid)
        if not self._can_manage(drive, folder_info["creator"], uid):
            raise HTTPError(self.srv.response, 403, "Only creator or server admins can delete folders")

        total_size = 0
        filepaths = set()

        def collect(fid):
            nonlocal total_size
            for f in (self.srv.db.getAll("drive_file", fid, "parent_folder") or []):
                total_size += f.get("size", 0) or 0
                filepaths.add(f["filepath"])
            for sf in (self.srv.db.getAll("drive_folder", fid, "parent_folder") or []):
                collect(sf["id"])

        collect(folder_id)
        # Rows first (the cascade drops the whole subtree), then the blobs nothing
        # references anymore: blobs are content-addressed, so another file (or a
        # message attachment) may share one.
        self.srv.db.deleteSomething("drive_folder", folder_id)
        for filepath in filepaths:
            if self.srv._isFilepathOrphaned(filepath):
                self._remove_blob(filepath)
        if total_size > 0:
            self.srv._adjustStorage(drive["server"], -total_size)

        self.notify_changed(drive["id"])
        return json.dumps({"status": "ok", "message": "Folder deleted successfully"})

    def _is_inside(self, folder_id, target_folder):
        """True if ``target_folder`` is ``folder_id`` or one of its descendants."""
        current = target_folder
        while current is not None:
            if int(current) == int(folder_id):
                return True
            parent = self.srv.db.getSomething("drive_folder", current)
            current = parent["parent_folder"] if parent else None
        return False

    def move_file(self, file_id, target_folder=None):
        uid = self.srv.getUser()

        file_info = self.srv.db.getSomething("drive_file", file_id)
        if not file_info:
            raise HTTPError(self.srv.response, 404, "File not found")

        self._get_drive_write_access(file_info["drive_channel"], uid)
        target_folder = self._resolve_folder(file_info["drive_channel"], target_folder, status=400)

        self.srv.db.edit("drive_file", file_id, "parent_folder", target_folder)
        self.notify_changed(file_info["drive_channel"])
        return json.dumps({"status": "ok"})

    def move_folder(self, folder_id, target_folder=None):
        uid = self.srv.getUser()

        folder_info = self.srv.db.getSomething("drive_folder", folder_id)
        if not folder_info:
            raise HTTPError(self.srv.response, 404, "Folder not found")

        self._get_drive_write_access(folder_info["drive_channel"], uid)
        target_folder = self._resolve_folder(folder_info["drive_channel"], target_folder, status=400)
        if target_folder is not None and self._is_inside(folder_id, target_folder):
            raise HTTPError(self.srv.response, 400, "Cannot move a folder into itself or one of its descendants")

        self.srv.db.edit("drive_folder", folder_id, "parent_folder", target_folder)
        self.notify_changed(folder_info["drive_channel"])
        return json.dumps({"status": "ok"})

    def move_items(self, items, target_folder=None):
        uid = self.srv.getUser()
        items = json.loads(items) if isinstance(items, str) else items

        if not items or not isinstance(items, list):
            raise HTTPError(self.srv.response, 400, "Invalid items list")

        resolved_target = None
        target_info = None
        if target_folder and target_folder != "null":
            resolved_target = int(target_folder)
            target_info = self.srv.db.getSomething("drive_folder", resolved_target)
            if not target_info:
                raise HTTPError(self.srv.response, 400, "Target folder not found")

        moved_files = 0
        moved_folders = 0
        errors = []
        touched = set()

        for item in items:
            item_type = item.get("type")
            item_id = item.get("id")
            if not item_type or not item_id:
                errors.append(f"Invalid item: {item}")
                continue

            try:
                table = {"file": "drive_file", "folder": "drive_folder"}.get(item_type)
                if not table:
                    errors.append(f"Invalid item: {item}")
                    continue
                info = self.srv.db.getSomething(table, item_id)
                if not info:
                    errors.append(f"{item_type} {item_id} not found")
                    continue
                drive_id = int(info["drive_channel"])
                # Not via HTTPError: vesta's HTTPError sends the response when built
                if not self.srv.checkChannelAccess(uid, drive_id, "drive", "send-messages"):
                    errors.append(f"No access to {item_type} {item_id}")
                    continue
                if resolved_target is not None and int(target_info["drive_channel"]) != drive_id:
                    errors.append(f"Target folder invalid for {item_type} {item_id}")
                    continue
                if item_type == "folder" and resolved_target is not None and self._is_inside(item_id, resolved_target):
                    errors.append(f"Cannot move folder {item_id} into itself or its descendant")
                    continue

                self.srv.db.edit(table, item_id, "parent_folder", resolved_target)
                touched.add(drive_id)
                if item_type == "file":
                    moved_files += 1
                else:
                    moved_folders += 1

            except Exception as e:
                errors.append(f"Error moving {item_type} {item_id}: {str(e)}")

        for drive_id in touched:
            self.notify_changed(drive_id)

        return json.dumps({
            "status": "ok",
            "moved_files": moved_files,
            "moved_folders": moved_folders,
            "errors": errors
        })

    def links(self, refs):
        """Resolve drive links ("drive:12", "drive:12/d:45", "drive:12/f:301") for display:
        {ref: {ok, kind, server, drive, drive_name, id, name, path, ...}}.
        A ref the caller can't see (private drive, deleted item, unknown) is
        {"ok": False} — never its name."""
        uid = self.srv.getUser()
        refs = json.loads(refs) if isinstance(refs, str) else refs
        if not isinstance(refs, list) or len(refs) > MAX_LINKS:
            raise HTTPError(self.srv.response, 400, "invalid refs")

        visible = {}

        def drive_for(drive_id):
            if drive_id not in visible:
                drive = self.srv.db.getSomething("drive_channel", drive_id)
                ok = drive and self.srv.checkChannelAccess(uid, drive_id, "drive", "view")
                visible[drive_id] = drive if ok else None
            return visible[drive_id]

        result = {}
        for ref in refs:
            match = LINK_RE.match(str(ref))
            if not match:
                continue
            drive = drive_for(int(match.group(1)))
            if not drive:
                result[ref] = {"ok": False}
                continue
            info = {"ok": True, "kind": "drive", "server": drive["server"],
                    "drive": drive["id"], "drive_name": drive["name"], "name": drive["name"]}
            kind, item_id = match.group(2), match.group(3)
            if kind:
                table = "drive_folder" if kind == "d" else "drive_file"
                item = self.srv.db.getSomething(table, int(item_id))
                if not item or int(item["drive_channel"]) != int(drive["id"]):
                    result[ref] = {"ok": False}
                    continue
                info["id"] = item["id"]
                if kind == "d":
                    info.update(kind="folder", name=item["foldername"], path=self._path(item["parent_folder"]))
                else:
                    info.update(kind="file", name=item["filename"], size=item["size"],
                                filepath=item["filepath"], folder=item["parent_folder"],
                                path=self._path(item["parent_folder"]))
            result[ref] = info
        return json.dumps(result, default=str)
