# Build Bay — Azure-backed game version & CDN manager

A small self-hosted web app for managing multiple games' build files in **Azure Blob Storage**, with:

- Upload new full builds or patches per game
- Delete a whole game, a single version, or a single file
- Version history per game (full builds vs patches are tagged separately)
- One-click **Copy CDN link** for every uploaded file, so the link stays stable and shareable

## 1. Azure setup (one-time)

1. Create a **Storage Account** in the Azure Portal (Standard, LRS is fine to start).
2. In the Storage Account, go to **Access keys** and copy the **Connection string**.
3. (Recommended for "permanent, workable" CDN links) Create an **Azure CDN profile / endpoint** (or Azure Front Door) pointed at that storage account's blob service as the origin. Note the CDN endpoint hostname, e.g. `mygame-cdn.azureedge.net`, or attach your own custom domain to it.
   - Without a CDN, the app still works — it just links directly to the blob storage URL instead of a CDN URL.
4. Decide a container name (default in this app is `games`) — it's created automatically on first run if it doesn't exist.

## 2. Configure the app

```bash
cd game-cdn-manager
cp .env.example .env
```

Edit `.env`:

```
AZURE_STORAGE_CONNECTION_STRING="<paste from Azure Portal>"
AZURE_CONTAINER_NAME="games"
CDN_HOSTNAME="mygame-cdn.azureedge.net"   # optional, leave blank to skip CDN
PORT=3000
```

## 3. Install & run

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## 4. How storage is organized

Every file you upload lands in Blob Storage under a predictable path, so nothing here is a black box:

```
{container}/
  {gameName}/
    manifest.json                 <- version history, notes, current/latest pointers
    current/
      game.zip                    <- stable mirror of the current build; same path forever
    versions/
      {versionId}/
        game.zip
        patch-notes.txt
        ...
```

- **Full build**: version id and label are auto-suggested (semver bump, e.g. `1.4.0` → `1.4.1`) but you can override them. Uploading a full build becomes the new "current version".
- **Patch**: version id auto-suggests as `{currentVersion}-patchN`. Patches only ever exist for the current version — uploading a new full build discards patches tied to the previous version.
- Only the last 5 full builds are kept; older ones (and their files) are deleted automatically once a 6th is uploaded.
- **Permanent CDN links**: every file also gets mirrored to `{gameName}/current/{filename}` — a path that never changes. Re-uploading a version/patch overwrites that file in place, so a link you shared once keeps working and always serves the current build. The per-version links under `versions/{versionId}/` still exist as an archive/history but do change per version.
- Deleting a version removes every file under that `versions/{versionId}/` path and updates the manifest (and the current mirror, if that version fed it); deleting a game removes everything under `{gameName}/`, including the mirror.

## 5. CDN links

Each file row has a **Copy CDN link** button. The link is built as:

- `https://{CDN_HOSTNAME}/{container}/{gameName}/versions/{versionId}/{filename}` when `CDN_HOSTNAME` is set, or
- the direct Azure Blob Storage URL otherwise.

Because the path is derived only from game name, version id, and filename (not from any temporary token), the same link keeps working for as long as the file exists — that's what makes it "permanent." If you ever need private/expiring links instead (e.g. for unreleased builds), the natural next step is to switch these to **SAS-signed URLs** in `src/azureService.js::buildPublicUrl`.

## 6. Notes on going to production

- This app has no authentication of its own — put it behind your existing login system, a VPN, or add basic auth in `server.js` before exposing it publicly, since anyone who can reach it can upload/delete builds.
- File size limit is currently set to 5 GB per file in `server.js` (multer `limits.fileSize`) — raise or lower as needed.
- For very large game builds, consider zipping before upload, and enabling **Azure CDN compression** on your endpoint for faster downloads.
