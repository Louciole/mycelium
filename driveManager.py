import json
import mimetypes
import os

from vesta import HTTPError
from constants import PHOTON_ORIGIN


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

        if parent_folder and parent_folder != "null":
            parent_folder = int(parent_folder)
            parent = self.srv.db.getSomething("drive_folder", parent_folder)
            if not parent or parent["drive_channel"] != int(drive_id):
                raise HTTPError(self.srv.response, 404, "Parent folder not found or doesn't belong to this drive")
        else:
            parent_folder = None

        file_id = self.upload(uid, drive_id, (filename, file), parent_folder)
        return json.dumps({"file_id": file_id, "filename": filename})

    def get_files(self, drive_id, parent_folder=None):
        uid = self.srv.getUser()
        self._get_drive_access(drive_id, uid)

        if parent_folder and parent_folder != "null":
            files = self.srv.db.getAll("drive_file", int(parent_folder), "parent_folder")
        else:
            files = self.srv.db.getFilters("drive_file", [
                "drive_channel", "=", drive_id, "and", "parent_folder", "is", None
            ])

        files = files or []

        for f in files:
            uploader = self.srv.db.getSomething("mycelium_account", f["uploader"])
            if uploader:
                f["uploader_name"] = uploader["display"]
                f["uploader_username"] = uploader["username"]

        return json.dumps(files, default=str)

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

        self._add_cors_headers()
        self.srv.response.headers.append(('Content-Type', mime_type))
        self.srv.response.headers.append(('Content-Disposition', f'attachment; filename="{file_info["filename"]}"'))
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
            return json.dumps({"file_id": new_id, "filename": new_name, "mode": "new"})

        # ── Overwrite in place — uploader or admin only ───────────────────────
        server_info = self.srv.db.getSomething("server", drive["server"])
        if file_info["uploader"] != uid and (not server_info or server_info["owner"] != uid):
            if not self.srv.checkChannelAccess(uid, drive["id"], "drive", "manage-files"):
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
            try:
                disk = self.srv.path + "/static/attachments/" + old_filepath
                if os.path.exists(disk):
                    os.remove(disk)
            except Exception as e:
                print(f"Error deleting old file {old_filepath}: {e}")

        self.srv._adjustStorage(drive["server"], new_size - old_size)
        return json.dumps({"file_id": file_id, "filename": new_name, "mode": "overwrite"})

    def delete_file(self, file_id):
        uid = self.srv.getUser()

        file_info = self.srv.db.getSomething("drive_file", file_id)
        if not file_info:
            raise HTTPError(self.srv.response, 404, "File not found")

        drive = self._get_drive_access(file_info["drive_channel"], uid)

        server_info = self.srv.db.getSomething("server", drive["server"])
        if file_info["uploader"] != uid and server_info["owner"] != uid:
            if not self.srv.checkChannelAccess(uid, drive["id"], "drive", "manage-files"):
                raise HTTPError(self.srv.response, 403, "Only uploader or server admins can delete files")

        filepath = self.srv.path + "/static/attachments/" + file_info["filepath"]
        if self.srv._isFilepathOrphaned(file_info["filepath"], exclude_drive_file_id=file_id):
            try:
                if os.path.exists(filepath):
                    os.remove(filepath)
            except Exception as e:
                print(f"Error deleting file {filepath}: {e}")

        self.srv.db.deleteSomething("drive_file", file_id)
        self.srv._adjustStorage(drive["server"], -file_info.get("size", 0))
        return json.dumps({"status": "ok", "message": "File deleted successfully"})

    def create_folder(self, drive_id, foldername, parent_folder=None):
        uid = self.srv.getUser()
        self._get_drive_write_access(drive_id, uid)

        if parent_folder and parent_folder != "null":
            parent_folder = int(parent_folder)
            parent = self.srv.db.getSomething("drive_folder", parent_folder)
            if not parent or parent["drive_channel"] != int(drive_id):
                raise HTTPError(self.srv.response, 404, "Parent folder not found or doesn't belong to this drive")
        else:
            parent_folder = None

        folder_id = self.srv.db.insertDict("drive_folder", {
            "drive_channel": drive_id,
            "foldername": foldername,
            "parent_folder": parent_folder,
            "creator": uid
        }, getId=True)

        return json.dumps({"folder_id": folder_id, "foldername": foldername})

    def get_folders(self, drive_id, parent_folder=None):
        uid = self.srv.getUser()
        self._get_drive_access(drive_id, uid)

        if parent_folder and parent_folder != "null":
            folders = self.srv.db.getAll("drive_folder", int(parent_folder), "parent_folder")
        else:
            folders = self.srv.db.getFilters("drive_folder", [
                "drive_channel", "=", drive_id, "and", "parent_folder", "is", None
            ])

        for folder in (folders or []):
            creator = self.srv.db.getSomething("mycelium_account", folder["creator"])
            if creator:
                folder["creator_name"] = creator["display"]
                folder["creator_username"] = creator["username"]

        return json.dumps(folders or [], default=str)

    def delete_folder(self, folder_id):
        uid = self.srv.getUser()

        folder_info = self.srv.db.getSomething("drive_folder", folder_id)
        if not folder_info:
            raise HTTPError(self.srv.response, 404, "Folder not found")

        drive = self._get_drive_access(folder_info["drive_channel"], uid)

        server_info = self.srv.db.getSomething("server", drive["server"])
        if folder_info["creator"] != uid and server_info["owner"] != uid:
            if not self.srv.checkChannelAccess(uid, drive["id"], "drive", "manage-files"):
                raise HTTPError(self.srv.response, 403, "Only creator or server admins can delete folders")

        total_size = 0

        def collect(fid):
            nonlocal total_size
            for f in (self.srv.db.getAll("drive_file", fid, "parent_folder") or []):
                total_size += f.get("size", 0)
                fpath = self.srv.path + "/static/attachments/" + f["filepath"]
                try:
                    if os.path.exists(fpath):
                        os.remove(fpath)
                except Exception as e:
                    print(f"Error deleting file {fpath}: {e}")
            for sf in (self.srv.db.getAll("drive_folder", fid, "parent_folder") or []):
                collect(sf["id"])

        collect(folder_id)
        self.srv.db.deleteSomething("drive_folder", folder_id)
        if total_size > 0:
            self.srv._adjustStorage(drive["server"], -total_size)

        return json.dumps({"status": "ok", "message": "Folder deleted successfully"})

    def move_file(self, file_id, target_folder=None):
        uid = self.srv.getUser()

        file_info = self.srv.db.getSomething("drive_file", file_id)
        if not file_info:
            raise HTTPError(self.srv.response, 404, "File not found")

        self._get_drive_write_access(file_info["drive_channel"], uid)

        if target_folder and target_folder != "null":
            target_folder = int(target_folder)
            target = self.srv.db.getSomething("drive_folder", target_folder)
            if not target or target["drive_channel"] != int(file_info["drive_channel"]):
                raise HTTPError(self.srv.response, 400, "Target folder not found or doesn't belong to this drive")
        else:
            target_folder = None

        self.srv.db.edit("drive_file", file_id, "parent_folder", target_folder)
        return json.dumps({"status": "ok"})

    def move_folder(self, folder_id, target_folder=None):
        uid = self.srv.getUser()

        folder_info = self.srv.db.getSomething("drive_folder", folder_id)
        if not folder_info:
            raise HTTPError(self.srv.response, 404, "Folder not found")

        self._get_drive_write_access(folder_info["drive_channel"], uid)

        if target_folder and target_folder != "null":
            target_folder = int(target_folder)
            target = self.srv.db.getSomething("drive_folder", target_folder)
            if not target or target["drive_channel"] != int(folder_info["drive_channel"]):
                raise HTTPError(self.srv.response, 400, "Target folder not found or doesn't belong to this drive")

            if int(folder_id) == target_folder:
                raise HTTPError(self.srv.response, 400, "Cannot move a folder into itself")

            current = target_folder
            while current is not None:
                parent = self.srv.db.getSomething("drive_folder", current)
                if not parent:
                    break
                if parent["parent_folder"] is not None and int(parent["parent_folder"]) == int(folder_id):
                    raise HTTPError(self.srv.response, 400, "Cannot move a folder into one of its descendants")
                current = parent["parent_folder"]
        else:
            target_folder = None

        self.srv.db.edit("drive_folder", folder_id, "parent_folder", target_folder)
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

        for item in items:
            item_type = item.get("type")
            item_id = item.get("id")
            if not item_type or not item_id:
                errors.append(f"Invalid item: {item}")
                continue

            try:
                if item_type == "file":
                    file_info = self.srv.db.getSomething("drive_file", item_id)
                    if not file_info:
                        errors.append(f"File {item_id} not found")
                        continue
                    # Not via HTTPError: vesta's HTTPError sends the response when built
                    if not self.srv.checkChannelAccess(uid, file_info["drive_channel"], "drive", "send-messages"):
                        errors.append(f"No access to file {item_id}")
                        continue

                    if resolved_target is not None and target_info["drive_channel"] != int(file_info["drive_channel"]):
                        errors.append(f"Target folder invalid for file {item_id}")
                        continue

                    self.srv.db.edit("drive_file", item_id, "parent_folder", resolved_target)
                    moved_files += 1

                elif item_type == "folder":
                    folder_info = self.srv.db.getSomething("drive_folder", item_id)
                    if not folder_info:
                        errors.append(f"Folder {item_id} not found")
                        continue
                    # Not via HTTPError: vesta's HTTPError sends the response when built
                    if not self.srv.checkChannelAccess(uid, folder_info["drive_channel"], "drive", "send-messages"):
                        errors.append(f"No access to folder {item_id}")
                        continue

                    if resolved_target is not None:
                        if target_info["drive_channel"] != int(folder_info["drive_channel"]):
                            errors.append(f"Target folder invalid for folder {item_id}")
                            continue
                        if int(item_id) == resolved_target:
                            errors.append(f"Cannot move folder {item_id} into itself")
                            continue

                        current = resolved_target
                        is_descendant = False
                        while current is not None:
                            p = self.srv.db.getSomething("drive_folder", current)
                            if not p:
                                break
                            if p["parent_folder"] is not None and int(p["parent_folder"]) == int(item_id):
                                is_descendant = True
                                break
                            current = p["parent_folder"]
                        if is_descendant:
                            errors.append(f"Cannot move folder {item_id} into its descendant")
                            continue

                    self.srv.db.edit("drive_folder", item_id, "parent_folder", resolved_target)
                    moved_folders += 1

            except Exception as e:
                errors.append(f"Error moving {item_type} {item_id}: {str(e)}")

        return json.dumps({
            "status": "ok",
            "moved_files": moved_files,
            "moved_folders": moved_folders,
            "errors": errors
        })
