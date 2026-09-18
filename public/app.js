const state = {
  games: [],
  activeGame: null,
  chosenFiles: [],
  versionIdTouched: false,
};

const el = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showToast(msg) {
  const toast = el("toast");
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (toast.hidden = true), 2200);
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// --- Load & render game list ---

async function loadGames() {
  const { games } = await api("/api/games");
  state.games = games.sort((a, b) => a.name.localeCompare(b.name));
  renderGameList();
  if (state.activeGame) {
    const fresh = state.games.find((g) => g.name === state.activeGame.name);
    if (fresh) {
      state.activeGame = fresh;
      renderGamePanel();
    }
  }
}

function renderGameList() {
  const list = el("game-list");
  list.innerHTML = "";
  for (const game of state.games) {
    const item = document.createElement("div");
    item.className = "game-item" + (state.activeGame?.name === game.name ? " active" : "");
    item.innerHTML = `<span>${game.name}</span><span class="count">${game.versions.length}</span>`;
    item.addEventListener("click", () => selectGame(game.name));
    list.appendChild(item);
  }
}

function selectGame(name) {
  state.activeGame = state.games.find((g) => g.name === name) || null;
  state.versionIdTouched = false;
  renderGameList();
  renderGamePanel();
  refreshVersionSuggestion();
}

// --- Auto version/patch numbering ---

async function refreshVersionSuggestion() {
  const game = state.activeGame;
  const hint = el("version-hint");
  if (!game) {
    hint.textContent = "";
    return;
  }
  const type = el("version-type").value;
  try {
    const suggestion = await api(`/api/games/${encodeURIComponent(game.name)}/next-version?type=${type}`);
    if (!state.versionIdTouched) {
      el("version-id").value = suggestion.versionId || "";
    }
    if (type === "patch" && !el("based-on").value.trim()) {
      el("based-on").value = suggestion.basedOn || "";
    }
    if (suggestion.versionId) {
      hint.textContent =
        type === "patch"
          ? `Next suggested patch: ${suggestion.versionId}${suggestion.basedOn ? ` (based on ${suggestion.basedOn})` : ""}`
          : `Next suggested version: ${suggestion.versionId}`;
    } else {
      hint.textContent = "No current full version yet — upload a full build first, or set a version id manually.";
    }
  } catch (err) {
    hint.textContent = "";
  }
}

// --- Game panel ---

function renderGamePanel() {
  const game = state.activeGame;
  el("empty-state").hidden = !!game;
  el("game-panel").hidden = !game;
  el("delete-game-btn").hidden = !game;
  if (!game) {
    el("game-title").textContent = "Select a game";
    el("game-sub").textContent = "Its builds, patches and CDN links live here.";
    return;
  }

  el("game-title").textContent = game.name;
  el("game-sub").textContent = `${game.versions.length} version${game.versions.length === 1 ? "" : "s"} stored`;

  renderCurrentFiles(game);

  const latestBadge = el("latest-badge");
  if (game.currentVersion || game.latest) {
    latestBadge.hidden = false;
    latestBadge.textContent = `current: ${game.currentVersion || game.latest}`;
  } else {
    latestBadge.hidden = true;
  }

  const list = el("version-list");
  list.innerHTML = "";
  const versions = [...game.versions].reverse();
  if (versions.length === 0) {
    list.innerHTML = `<p class="muted">No versions uploaded yet — upload your first build above.</p>`;
    return;
  }

  for (const v of versions) {
    const li = document.createElement("li");
    li.className = "version-item" + (v.type === "patch" ? " patch" : "");

    const filesHtml = (v.files || [])
      .map(
        (f) => `
        <div class="file-row" data-file="${f.filename}">
          <span class="file-name" title="${f.filename}">${f.filename}</span>
          <span class="file-size">${fmtSize(f.size)}</span>
          <button class="icon-btn copy-btn" data-url="${f.url}">Copy CDN link</button>
          <button class="icon-btn danger delete-file-btn">Delete</button>
        </div>`
      )
      .join("");

    li.innerHTML = `
      <div class="version-card">
        <div class="version-card-head">
          <span class="version-id">${v.label || v.id}</span>
          <span class="tag ${v.type}">${v.type}</span>
          ${v.basedOn ? `<span class="muted">based on ${v.basedOn}</span>` : ""}
          <span class="version-date">${fmtDate(v.createdAt)}</span>
        </div>
        ${v.notes ? `<p class="version-notes">${v.notes}</p>` : ""}
        ${filesHtml || `<p class="muted">No files.</p>`}
        <div class="version-actions">
          <button class="icon-btn danger delete-version-btn">Delete version</button>
        </div>
      </div>`;

    li.querySelector(".delete-version-btn").addEventListener("click", () => deleteVersion(game.name, v.id));
    li.querySelectorAll(".copy-btn").forEach((btn) =>
      btn.addEventListener("click", () => copyLink(btn.dataset.url))
    );
    li.querySelectorAll(".delete-file-btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        const filename = btn.closest(".file-row").dataset.file;
        deleteFile(game.name, v.id, filename);
      })
    );

    list.appendChild(li);
  }
}

function renderCurrentFiles(game) {
  const list = el("current-files-list");
  const files = game.currentFiles || [];
  if (files.length === 0) {
    list.innerHTML = `<p class="muted">No current build yet — upload a full version to get permanent links.</p>`;
    return;
  }
  list.innerHTML = files
    .map(
      (f) => `
      <div class="file-row" data-file="${f.filename}">
        <span class="file-name" title="${f.filename}">${f.filename}</span>
        <span class="file-size">${fmtSize(f.size)}</span>
        <button class="icon-btn copy-btn" data-url="${f.url}">Copy CDN link</button>
      </div>`
    )
    .join("");
  list.querySelectorAll(".copy-btn").forEach((btn) => btn.addEventListener("click", () => copyLink(btn.dataset.url)));
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    showToast("CDN link copied");
  } catch {
    showToast(url);
  }
}

// --- Mutations ---

async function addGame(name) {
  await api("/api/games", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await loadGames();
  selectGame(name);
}

async function deleteActiveGame() {
  const game = state.activeGame;
  if (!game) return;
  if (!confirm(`Delete "${game.name}" and every version/file inside it? This cannot be undone.`)) return;
  await api(`/api/games/${encodeURIComponent(game.name)}`, { method: "DELETE" });
  state.activeGame = null;
  await loadGames();
  renderGamePanel();
}

async function deleteVersion(game, versionId) {
  if (!confirm(`Delete version "${versionId}"? This removes its files from storage and the CDN.`)) return;
  await api(`/api/games/${encodeURIComponent(game)}/versions/${encodeURIComponent(versionId)}`, { method: "DELETE" });
  await loadGames();
}

async function deleteFile(game, versionId, filename) {
  if (!confirm(`Delete file "${filename}"?`)) return;
  await api(
    `/api/games/${encodeURIComponent(game)}/versions/${encodeURIComponent(versionId)}/files/${encodeURIComponent(filename)}`,
    { method: "DELETE" }
  );
  await loadGames();
}

async function uploadVersion() {
  const game = state.activeGame;
  const statusEl = el("upload-status");
  statusEl.className = "status";
  statusEl.textContent = "";

  if (!game) return;
  const versionId = el("version-id").value.trim();
  const type = el("version-type").value;
  const basedOn = el("based-on").value.trim();
  const notes = el("version-notes").value.trim();

  if (state.chosenFiles.length === 0) {
    statusEl.className = "status error";
    statusEl.textContent = "Choose at least one file to upload.";
    return;
  }

  const form = new FormData();
  form.append("versionId", versionId);
  form.append("label", versionId);
  form.append("type", type);
  form.append("basedOn", basedOn);
  form.append("notes", notes);
  for (const file of state.chosenFiles) form.append("files", file);

  const btn = el("upload-btn");
  btn.disabled = true;
  statusEl.textContent = "Uploading...";
  try {
    await api(`/api/games/${encodeURIComponent(game.name)}/versions`, { method: "POST", body: form });
    statusEl.className = "status ok";
    statusEl.textContent = "Uploaded. CDN links are ready below.";
    state.chosenFiles = [];
    state.versionIdTouched = false;
    el("chosen-files").textContent = "";
    el("version-id").value = "";
    el("based-on").value = "";
    el("version-notes").value = "";
    await loadGames();
    await refreshVersionSuggestion();
  } catch (err) {
    statusEl.className = "status error";
    statusEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// --- Wiring ---

el("new-game-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = el("new-game-input");
  const name = input.value.trim();
  if (!name) return;
  try {
    await addGame(name);
    input.value = "";
  } catch (err) {
    alert(err.message);
  }
});

el("delete-game-btn").addEventListener("click", deleteActiveGame);
el("upload-btn").addEventListener("click", uploadVersion);

el("version-type").addEventListener("change", () => {
  state.versionIdTouched = false;
  el("based-on").value = "";
  refreshVersionSuggestion();
});
el("version-id").addEventListener("input", () => {
  state.versionIdTouched = el("version-id").value.trim().length > 0;
});

el("choose-files-btn").addEventListener("click", () => el("file-input").click());
el("file-input").addEventListener("change", (e) => {
  state.chosenFiles = Array.from(e.target.files);
  el("chosen-files").textContent = state.chosenFiles.map((f) => f.name).join(", ");
});

const dropZone = el("drop-zone");
["dragover", "dragenter"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
  })
);
dropZone.addEventListener("drop", (e) => {
  state.chosenFiles = Array.from(e.dataTransfer.files);
  el("chosen-files").textContent = state.chosenFiles.map((f) => f.name).join(", ");
});

loadGames().catch((err) => showToast(err.message));
