"""Drive file/folder endpoints and storage usage.

Endpoints take the live Mycelium instance as ``self``; shared helpers remain on
the class (see server.py).
"""
import json

from vesta import Server
from constants import USER_STORAGE_QUOTA, SERVER_STORAGE_QUOTA


@Server.expose
def upload_image(self):
    uid = self.getUser()
    user = self.db.getSomething("mycelium_account", uid)
    self.getUsersStatus([user],detailed=True)
    return json.dumps(user, default=str)


@Server.expose
def uploadDriveOnBehalf(self, API_KEY, email, filename, file):
    return self.drive.upload_on_behalf(API_KEY, email, filename, file)


@Server.expose
def upload_drive_file(self, drive_id, filename, file, parent_folder=None):
    return self.drive.upload_file(drive_id, filename, file, parent_folder)


@Server.expose
def list_drive(self, drive_id, folder_id=None):
    return self.drive.list_drive(drive_id, folder_id)


@Server.expose
def get_drive_files(self, drive_id, parent_folder=None):
    return self.drive.get_files(drive_id, parent_folder)


@Server.expose
def preview_drive_file(self, file_id, max_bytes=2000):
    return self.drive.preview_file(file_id, max_bytes)


@Server.expose
def download_drive_file(self, file_id):
    return self.drive.download_file(file_id)


@Server.expose
def save_drive_file(self, file_id, file, mode="overwrite", filename=None):
    """Save edits returned by the Photon editor (cross-origin, multipart)."""
    return self.drive.save_file(file_id, file, mode, filename)


@Server.expose
def delete_drive_file(self, file_id):
    return self.drive.delete_file(file_id)


@Server.expose
def create_drive_folder(self, drive_id, foldername, parent_folder=None):
    return self.drive.create_folder(drive_id, foldername, parent_folder)


@Server.expose
def get_drive_folders(self, drive_id, parent_folder=None):
    return self.drive.get_folders(drive_id, parent_folder)


@Server.expose
def rename_drive_item(self, item_type, item_id, name):
    return self.drive.rename_item(item_type, item_id, name)


@Server.expose
def drive_links(self, refs):
    """Names/paths of drive links shown in messages, forums and notes."""
    return self.drive.links(refs)


@Server.expose
def delete_drive_folder(self, folder_id):
    return self.drive.delete_folder(folder_id)


@Server.expose
def move_drive_file(self, file_id, target_folder=None):
    return self.drive.move_file(file_id, target_folder)


@Server.expose
def move_drive_folder(self, folder_id, target_folder=None):
    return self.drive.move_folder(folder_id, target_folder)


@Server.expose
def move_drive_items(self, items, target_folder=None):
    return self.drive.move_items(items, target_folder)


@Server.expose
def get_storage_usage(self, server_id=None):
    """Get storage usage for a user or server."""
    uid = self.getUser()
    if server_id:
        self.require_member(uid, server_id)
        personal = self.db.getFilters("personal_server", ["server", "=", server_id])
        if personal and personal != []:
            owner = self.db.getSomething("mycelium_account", personal[0]["owner"])
            return json.dumps({"storage_usage": owner.get("storage_usage", 0), "storage_quota": USER_STORAGE_QUOTA, "target_type": "user"})
        else:
            server = self.db.getSomething("server", server_id)
            return json.dumps({"storage_usage": server.get("storage_usage", 0), "storage_quota": SERVER_STORAGE_QUOTA, "target_type": "server"})
    else:
        user = self.db.getSomething("mycelium_account", uid)
        return json.dumps({"storage_usage": user.get("storage_usage", 0), "storage_quota": USER_STORAGE_QUOTA, "target_type": "user"})
