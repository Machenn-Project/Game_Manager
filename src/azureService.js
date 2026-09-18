const { BlobServiceClient } = require("@azure/storage-blob");

const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.AZURE_CONTAINER_NAME || "games";
// Accept a bare hostname as documented, but also tolerate someone pasting a full
// URL (protocol and/or trailing slash) so a misconfigured .env can't produce a
// broken "https://https://..." link.
const CDN_HOSTNAME = (process.env.CDN_HOSTNAME || "")
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/, "");

if (!CONNECTION_STRING) {
  console.warn(
    "[azureService] AZURE_STORAGE_CONNECTION_STRING is not set. Requests will fail until it is configured in .env"
  );
}

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

let _containerClient = null;

function getContainerClient() {
  if (_containerClient) return _containerClient;
  const serviceClient = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
  _containerClient = serviceClient.getContainerClient(CONTAINER_NAME);
  return _containerClient;
}

async function ensureContainer() {
  const container = getContainerClient();
  await container.createIfNotExists();
  return container;
}

function manifestPath(game) {
  return `${game}/manifest.json`;
}

function versionPrefix(game, versionId) {
  return `${game}/versions/${versionId}/`;
}

function filePath(game, versionId, filename) {
  return `${game}/versions/${versionId}/${filename}`;
}

// The "current" path is a stable mirror of whatever the current build's files are.
// Its blob paths (and therefore CDN links) never change — only the bytes behind them do,
// so a link you shared once keeps working after every future version/patch upload.
function currentPath(game, filename) {
  return `${game}/current/${filename}`;
}

// A stable, permanent manifest for launchers/auto-updaters to poll: always the
// current version's info, at a URL that never changes.
function versionJsonPath(game) {
  return `${game}/version.json`;
}

// Builds a public, shareable link for a blob. If CDN_HOSTNAME is configured,
// the link points at the CDN (stable/permanent even if storage internals change).
// Otherwise it falls back to the direct blob storage URL.
function buildPublicUrl(blobPath) {
  const container = getContainerClient();
  if (CDN_HOSTNAME) {
    return `https://${CDN_HOSTNAME}/${CONTAINER_NAME}/${blobPath}`;
  }
  return container.getBlockBlobClient(blobPath).url;
}

async function readJsonBlob(blobPath) {
  const container = getContainerClient();
  const blockBlob = container.getBlockBlobClient(blobPath);
  const exists = await blockBlob.exists();
  if (!exists) return null;
  const buffer = await blockBlob.downloadToBuffer();
  try {
    return JSON.parse(buffer.toString("utf-8"));
  } catch {
    return null;
  }
}

async function writeJsonBlob(blobPath, data) {
  const container = getContainerClient();
  const blockBlob = container.getBlockBlobClient(blobPath);
  const body = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
  await blockBlob.upload(body, body.length, {
    blobHTTPHeaders: { blobContentType: "application/json" },
    overwrite: true,
  });
}

function emptyManifest(game) {
  return { name: game, latest: null, currentVersion: null, versions: [], createdAt: new Date().toISOString() };
}

const MAX_FULL_VERSIONS = 5;

function parseSemver(id) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(id || "");
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

// Finds the highest full-build semver already uploaded, and proposes the next patch bump.
function nextFullVersionId(manifest) {
  const fulls = manifest.versions.filter((v) => v.type === "full");
  let best = null;
  for (const v of fulls) {
    const parsed = parseSemver(v.id);
    if (!parsed) continue;
    if (
      !best ||
      parsed.major > best.major ||
      (parsed.major === best.major && parsed.minor > best.minor) ||
      (parsed.major === best.major && parsed.minor === best.minor && parsed.patch > best.patch)
    ) {
      best = parsed;
    }
  }
  if (!best) return fulls.length === 0 ? "1.0.0" : `${fulls.length + 1}.0.0`;
  return `${best.major}.${best.minor}.${best.patch + 1}`;
}

// Proposes the next patch number for a given base full version (defaults to the current version).
function nextPatchVersionId(manifest, basedOn) {
  const base = basedOn || manifest.currentVersion;
  if (!base) return null;
  const count = manifest.versions.filter((v) => v.type === "patch" && v.basedOn === base).length;
  return `${base}-patch${count + 1}`;
}

function suggestNextVersion(manifest, type) {
  if (type === "patch") {
    const basedOn = manifest.currentVersion || null;
    return { versionId: nextPatchVersionId(manifest, basedOn), basedOn };
  }
  return { versionId: nextFullVersionId(manifest), basedOn: null };
}

async function deleteVersionBlobs(game, versionId) {
  const container = getContainerClient();
  for await (const blob of container.listBlobsFlat({ prefix: versionPrefix(game, versionId) })) {
    await container.getBlockBlobClient(blob.name).deleteIfExists();
  }
}

// Patches only ever apply to the current full version — once a new full build lands,
// any patches based on the previous version(s) are no longer relevant and are removed.
async function prunePatchesNotCurrent(game, manifest) {
  const stale = manifest.versions.filter((v) => v.type === "patch" && v.basedOn !== manifest.currentVersion);
  for (const v of stale) {
    await deleteVersionBlobs(game, v.id);
  }
  const staleIds = new Set(stale.map((v) => v.id));
  manifest.versions = manifest.versions.filter((v) => !staleIds.has(v.id));
}

// Keeps only the most recent MAX_FULL_VERSIONS full builds; older ones are deleted entirely.
async function pruneOldFullVersions(game, manifest) {
  const fulls = manifest.versions
    .filter((v) => v.type === "full")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (fulls.length <= MAX_FULL_VERSIONS) return;
  const toRemove = fulls.slice(0, fulls.length - MAX_FULL_VERSIONS);
  for (const v of toRemove) {
    await deleteVersionBlobs(game, v.id);
  }
  const removeIds = new Set(toRemove.map((v) => v.id));
  manifest.versions = manifest.versions.filter((v) => !removeIds.has(v.id));
}

async function getNextVersion(game, type) {
  const manifest = await getGameManifest(game);
  return suggestNextVersion(manifest, type === "patch" ? "patch" : "full");
}

// Which version's copy of each filename should currently be live: the current full
// build's files, with any patches based on that same version layered on top (later
// patches win on filename collisions).
function computeCurrentLayout(manifest) {
  const layout = new Map();
  const current = manifest.currentVersion;
  if (!current) return layout;
  const fullVersion = manifest.versions.find((v) => v.id === current && v.type === "full");
  const patches = manifest.versions
    .filter((v) => v.type === "patch" && v.basedOn === current)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (const version of [fullVersion, ...patches].filter(Boolean)) {
    for (const f of version.files || []) {
      layout.set(f.filename, { versionId: version.id, filename: f.filename, size: f.size });
    }
  }
  return layout;
}

function getCurrentFiles(game, manifest) {
  return Array.from(computeCurrentLayout(manifest).values()).map(({ filename, size }) => ({
    filename,
    size,
    url: buildPublicUrl(currentPath(game, filename)),
  }));
}

// The current version's info, as written to version.json: whichever of the current
// full build or its patches was uploaded most recently wins for description/exe name.
function buildVersionInfo(game, manifest) {
  const current = manifest.currentVersion;
  if (!current) return null;
  const fullVersion = manifest.versions.find((v) => v.id === current && v.type === "full");
  const patches = manifest.versions
    .filter((v) => v.type === "patch" && v.basedOn === current)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const latest = patches.length ? patches[patches.length - 1] : fullVersion;
  if (!latest) return null;

  const executableName = latest.executableName || (fullVersion && fullVersion.executableName) || null;
  const currentFiles = getCurrentFiles(game, manifest);
  const exeFile = executableName ? currentFiles.find((f) => f.filename === executableName) : null;
  const primary = exeFile || currentFiles[0] || null;

  return {
    version: current,
    url: primary ? primary.url : null,
    gameName: game,
    description: latest.notes || (fullVersion && fullVersion.notes) || "",
    executableName,
    timestamp: latest.createdAt,
  };
}

// Rewrites the permanent {game}/version.json blob to match the current version.
async function rebuildVersionJson(game, manifest) {
  const info = buildVersionInfo(game, manifest);
  if (!info) {
    const container = getContainerClient();
    await container.getBlockBlobClient(versionJsonPath(game)).deleteIfExists();
    return;
  }
  await writeJsonBlob(versionJsonPath(game), info);
}

// Re-copies the current build's files into the stable {game}/current/ path so every
// permanent link keeps pointing at the right bytes after any upload/delete.
async function rebuildCurrentMirror(game, manifest) {
  const container = getContainerClient();
  for await (const blob of container.listBlobsFlat({ prefix: `${game}/current/` })) {
    await container.getBlockBlobClient(blob.name).deleteIfExists();
  }
  const layout = computeCurrentLayout(manifest);
  for (const { versionId, filename } of layout.values()) {
    const srcBlob = container.getBlockBlobClient(filePath(game, versionId, filename));
    const exists = await srcBlob.exists();
    if (!exists) continue;
    const props = await srcBlob.getProperties();
    const buffer = await srcBlob.downloadToBuffer();
    const destBlob = container.getBlockBlobClient(currentPath(game, filename));
    await destBlob.upload(buffer, buffer.length, {
      blobHTTPHeaders: { blobContentType: props.contentType || "application/octet-stream" },
      overwrite: true,
    });
  }
}

async function listGames() {
  await ensureContainer();
  const container = getContainerClient();
  const games = [];
  for await (const item of container.listBlobsByHierarchy("/")) {
    if (item.kind === "prefix") {
      const game = item.name.replace(/\/$/, "");
      games.push(game);
    }
  }
  return games;
}

async function getGameManifest(game) {
  const manifest = await readJsonBlob(manifestPath(game));
  return manifest || emptyManifest(game);
}

// Returns the manifest plus a derived (never persisted) currentFiles list — the
// stable, permanent links for the current build. Use this for API responses.
function withCurrentFiles(game, manifest) {
  // Recompute every URL from the live CDN_HOSTNAME instead of trusting whatever was
  // stored at upload time, so a corrected .env (or a future hostname change) takes
  // effect immediately without needing to touch old manifest data.
  const versions = (manifest.versions || []).map((v) => ({
    ...v,
    files: (v.files || []).map((f) => ({ ...f, url: buildPublicUrl(filePath(game, v.id, f.filename)) })),
  }));
  return {
    ...manifest,
    versions,
    currentFiles: getCurrentFiles(game, manifest),
    versionJsonUrl: buildPublicUrl(versionJsonPath(game)),
  };
}

async function createGame(game) {
  await ensureContainer();
  const existing = await readJsonBlob(manifestPath(game));
  if (existing) return existing;
  const manifest = emptyManifest(game);
  await writeJsonBlob(manifestPath(game), manifest);
  return manifest;
}

async function deleteGame(game) {
  const container = getContainerClient();
  for await (const blob of container.listBlobsFlat({ prefix: `${game}/` })) {
    await container.getBlockBlobClient(blob.name).deleteIfExists();
  }
}

// Uploads one or more files as a new version (full release or patch).
// files: array of { originalname, buffer, mimetype }
async function uploadVersion(game, versionId, files, meta = {}) {
  await ensureContainer();
  const container = getContainerClient();
  const manifest = await getGameManifest(game);

  const type = meta.type === "patch" ? "patch" : "full";
  let basedOn = meta.basedOn || (type === "patch" ? manifest.currentVersion : null) || null;

  let finalVersionId = versionId || null;
  if (!finalVersionId) {
    const suggestion = suggestNextVersion(manifest, type);
    finalVersionId = suggestion.versionId;
    if (type === "patch" && !meta.basedOn) basedOn = suggestion.basedOn;
  }
  if (!finalVersionId) {
    throw new Error("Could not auto-generate a version id (no current version to patch yet); please provide one.");
  }
  if (!SAFE_NAME.test(finalVersionId)) {
    throw new Error("Version id may only contain letters, numbers, dots, dashes and underscores.");
  }

  const uploaded = [];
  for (const file of files) {
    const blobPath = filePath(game, finalVersionId, file.originalname);
    const blockBlob = container.getBlockBlobClient(blobPath);
    await blockBlob.upload(file.buffer, file.buffer.length, {
      blobHTTPHeaders: { blobContentType: file.mimetype || "application/octet-stream" },
      overwrite: true,
    });
    uploaded.push({
      filename: file.originalname,
      size: file.buffer.length,
      url: buildPublicUrl(blobPath),
    });
  }

  const existingIdx = manifest.versions.findIndex((v) => v.id === finalVersionId);
  const previousEntry = existingIdx >= 0 ? manifest.versions[existingIdx] : null;
  const versionEntry = {
    id: finalVersionId,
    label: meta.label || finalVersionId,
    type,
    basedOn: type === "patch" ? basedOn : null,
    notes: meta.notes || "",
    // Keep re-uploading files to the same version id from wiping out an
    // executable name entered on an earlier upload to that same version.
    executableName: meta.executableName || (previousEntry && previousEntry.executableName) || null,
    createdAt: new Date().toISOString(),
    files: uploaded,
  };

  if (existingIdx >= 0) {
    // merge with any previously uploaded files for this version id
    const prevFiles = manifest.versions[existingIdx].files || [];
    const merged = [...prevFiles.filter((f) => !uploaded.find((u) => u.filename === f.filename)), ...uploaded];
    versionEntry.files = merged;
    versionEntry.createdAt = manifest.versions[existingIdx].createdAt;
    manifest.versions[existingIdx] = { ...manifest.versions[existingIdx], ...versionEntry, files: merged };
  } else {
    manifest.versions.push(versionEntry);
  }

  if (type === "full") {
    manifest.currentVersion = finalVersionId;
    await prunePatchesNotCurrent(game, manifest);
    await pruneOldFullVersions(game, manifest);
  }

  manifest.latest = finalVersionId;
  await rebuildCurrentMirror(game, manifest);
  await rebuildVersionJson(game, manifest);
  await writeJsonBlob(manifestPath(game), manifest);
  return withCurrentFiles(game, manifest);
}

async function deleteVersion(game, versionId) {
  await deleteVersionBlobs(game, versionId);
  const manifest = await getGameManifest(game);
  manifest.versions = manifest.versions.filter((v) => v.id !== versionId);
  if (manifest.currentVersion === versionId) {
    const remainingFulls = manifest.versions.filter((v) => v.type === "full");
    manifest.currentVersion = remainingFulls.length ? remainingFulls[remainingFulls.length - 1].id : null;
    await prunePatchesNotCurrent(game, manifest);
  }
  if (manifest.latest === versionId) {
    manifest.latest = manifest.versions.length ? manifest.versions[manifest.versions.length - 1].id : null;
  }
  await rebuildCurrentMirror(game, manifest);
  await rebuildVersionJson(game, manifest);
  await writeJsonBlob(manifestPath(game), manifest);
  return withCurrentFiles(game, manifest);
}

async function deleteFile(game, versionId, filename) {
  const container = getContainerClient();
  await container.getBlockBlobClient(filePath(game, versionId, filename)).deleteIfExists();
  const manifest = await getGameManifest(game);
  const version = manifest.versions.find((v) => v.id === versionId);
  if (version) {
    version.files = (version.files || []).filter((f) => f.filename !== filename);
  }
  await rebuildCurrentMirror(game, manifest);
  await rebuildVersionJson(game, manifest);
  await writeJsonBlob(manifestPath(game), manifest);
  return withCurrentFiles(game, manifest);
}

module.exports = {
  ensureContainer,
  listGames,
  getGameManifest,
  createGame,
  deleteGame,
  uploadVersion,
  deleteVersion,
  deleteFile,
  getNextVersion,
  withCurrentFiles,
  buildPublicUrl,
  filePath,
};
