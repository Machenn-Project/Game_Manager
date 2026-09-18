const state = {
  games: [],
  activeGame: null,
  chosenFiles: [],
  versionIdTouched: false,
  authRequired: false,
};

const el = (id) => document.getElementById(id);

const AUTH_TOKEN_KEY = "buildbay_token";
const getToken = () => sessionStorage.getItem(AUTH_TOKEN_KEY);
const setToken = (token) => {
  if (token) sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  else sessionStorage.removeItem(AUTH_TOKEN_KEY);
};

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers["X-App-Token"] = token;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    setToken(null);
    showLockScreen("Session expired. Please enter the password again.");
    throw new Error("Locked out — please unlock again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// fetch() doesn't expose upload progress, so file uploads go through XHR instead
// so the progress bar can track bytes actually sent, not just "done or not".
function apiUpload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    const token = getToken();
    if (token) xhr.setRequestHeader("X-App-Token", token);

    xhr.upload.addEventListener("progress", (e) => {
      if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });

    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON response body; data stays {}
      }
      if (xhr.status === 401) {
        setToken(null);
        showLockScreen("Session expired. Please enter the password again.");
        reject(new Error("Locked out — please unlock again."));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        reject(new Error(data.error || `Request failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(formData);
  });
}

// --- Password gate ---

function showLockScreen(message) {
  el("lock-screen").hidden = false;
  el("lock-btn").hidden = true;
  const err = el("lock-error");
  if (message) {
    err.textContent = message;
    err.hidden = false;
  } else {
    err.hidden = true;
    err.textContent = "";
  }
  el("lock-password").value = "";
  el("lock-password").focus();
}

function hideLockScreen() {
  el("lock-screen").hidden = true;
  el("lock-btn").hidden = !state.authRequired;
}

// Asks for the password again to confirm one specific action (create/upload/delete),
// independent of whether the app session is already unlocked. Resolves with the
// entered password, or null if the user cancels.
function requestPassword(title, desc) {
  return new Promise((resolve) => {
    const modal = el("password-modal");
    const form = el("password-modal-form");
    const input = el("password-modal-input");
    const cancelBtn = el("password-modal-cancel");

    el("password-modal-title").textContent = title;
    el("password-modal-desc").textContent = desc;
    input.value = "";
    modal.hidden = false;
    input.focus();

    function cleanup() {
      modal.hidden = true;
      form.removeEventListener("submit", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
    }
    function onSubmit(e) {
      e.preventDefault();
      const value = input.value;
      cleanup();
      resolve(value);
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }

    form.addEventListener("submit", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
  });
}

async function boot() {
  let status = { required: false };
  try {
    status = await (await fetch("/api/auth-status")).json();
  } catch {
    // If the check itself fails, fall back to no gate rather than locking the user out silently.
  }
  state.authRequired = !!status.required;

  if (!state.authRequired) {
    hideLockScreen();
    await loadGames().catch((err) => showToast(err.message));
    return;
  }
  if (!getToken()) {
    showLockScreen();
    return;
  }
  try {
    await loadGames();
    hideLockScreen();
  } catch {
    // api() already shows the lock screen on a 401; anything else, show it too — we can't proceed.
    showLockScreen();
  }
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
  const copyCurrentBtn = el("copy-current-link-btn");
  const copyVersionJsonBtn = el("copy-version-json-btn");
  if (!game) {
    el("game-title").textContent = "Select a game";
    el("game-sub").textContent = "Its builds, patches and CDN links live here.";
    copyCurrentBtn.hidden = true;
    copyCurrentBtn.onclick = null;
    copyVersionJsonBtn.hidden = true;
    copyVersionJsonBtn.onclick = null;
    return;
  }

  el("game-title").textContent = game.name;
  el("game-sub").textContent = `${game.versions.length} version${game.versions.length === 1 ? "" : "s"} stored`;

  const primaryFile = (game.currentFiles || [])[0];
  copyCurrentBtn.hidden = !primaryFile;
  copyCurrentBtn.onclick = primaryFile ? () => copyLink(primaryFile.url, copyCurrentBtn) : null;

  copyVersionJsonBtn.hidden = !(game.currentVersion && game.versionJsonUrl);
  copyVersionJsonBtn.onclick = game.currentVersion && game.versionJsonUrl
    ? () => copyLink(game.versionJsonUrl, copyVersionJsonBtn)
    : null;

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

async function copyLink(url, btn) {
  try {
    await navigator.clipboard.writeText(url);
    showToast("CDN link copied");
  } catch {
    showToast(url);
  }
  if (btn) {
    const original = btn.textContent;
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    clearTimeout(btn._resetT);
    btn._resetT = setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("copied");
    }, 1500);
  }
}

// --- Mutations ---

async function addGame(name) {
  let password = null;
  if (state.authRequired) {
    password = await requestPassword("Confirm: create game", `Enter the password to create "${name}".`);
    if (password === null) return false;
  }
  await api("/api/games", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  await loadGames();
  selectGame(name);
  return true;
}

async function deleteActiveGame() {
  const game = state.activeGame;
  if (!game) return;
  if (!confirm(`Delete "${game.name}" and every version/file inside it? This cannot be undone.`)) return;
  let password = null;
  if (state.authRequired) {
    password = await requestPassword("Confirm: delete game", `Enter the password to delete "${game.name}".`);
    if (password === null) return;
  }
  await api(`/api/games/${encodeURIComponent(game.name)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  state.activeGame = null;
  await loadGames();
  renderGamePanel();
}

async function deleteVersion(game, versionId) {
  if (!confirm(`Delete version "${versionId}"? This removes its files from storage and the CDN.`)) return;
  let password = null;
  if (state.authRequired) {
    password = await requestPassword("Confirm: delete version", `Enter the password to delete version "${versionId}".`);
    if (password === null) return;
  }
  await api(`/api/games/${encodeURIComponent(game)}/versions/${encodeURIComponent(versionId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  await loadGames();
}

async function deleteFile(game, versionId, filename) {
  if (!confirm(`Delete file "${filename}"?`)) return;
  let password = null;
  if (state.authRequired) {
    password = await requestPassword("Confirm: delete file", `Enter the password to delete "${filename}".`);
    if (password === null) return;
  }
  await api(
    `/api/games/${encodeURIComponent(game)}/versions/${encodeURIComponent(versionId)}/files/${encodeURIComponent(filename)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }
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
  const notes = el("version-notes").value.trim();
  const executableName = el("executable-name").value.trim();

  if (state.chosenFiles.length === 0) {
    statusEl.className = "status error";
    statusEl.textContent = "Choose at least one file to upload.";
    return;
  }

  let password = "";
  if (state.authRequired) {
    const entered = await requestPassword("Confirm: upload version", "Enter the password to upload this build.");
    if (entered === null) return;
    password = entered;
  }

  const form = new FormData();
  form.append("versionId", versionId);
  form.append("label", versionId);
  form.append("type", type);
  form.append("notes", notes);
  form.append("executableName", executableName);
  form.append("password", password);
  for (const file of state.chosenFiles) form.append("files", file);

  const btn = el("upload-btn");
  const progressBar = el("upload-progress");
  const progressFill = el("upload-progress-fill");
  btn.disabled = true;
  progressBar.hidden = false;
  progressFill.style.width = "0%";
  statusEl.textContent = "Uploading... 0%";
  try {
    await apiUpload(`/api/games/${encodeURIComponent(game.name)}/versions`, form, (pct) => {
      progressFill.style.width = `${pct}%`;
      statusEl.textContent = `Uploading... ${pct}%`;
    });
    statusEl.className = "status ok";
    statusEl.textContent = "Uploaded. CDN links are ready below.";
    state.chosenFiles = [];
    state.versionIdTouched = false;
    el("chosen-files").textContent = "";
    el("ready-tick").hidden = true;
    el("version-id").value = "";
    el("version-notes").value = "";
    await loadGames();
    await refreshVersionSuggestion();
  } catch (err) {
    statusEl.className = "status error";
    statusEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    progressBar.hidden = true;
  }
}

// --- Wiring ---

el("new-game-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = el("new-game-input");
  const name = input.value.trim();
  if (!name) return;
  try {
    const created = await addGame(name);
    if (created) input.value = "";
  } catch (err) {
    alert(err.message);
  }
});

el("delete-game-btn").addEventListener("click", deleteActiveGame);
el("upload-btn").addEventListener("click", uploadVersion);

el("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = el("lock-password").value;
  const errEl = el("lock-error");
  errEl.hidden = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Incorrect password.");
    setToken(data.token || null);
    hideLockScreen();
    await loadGames().catch((err) => showToast(err.message));
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
    el("lock-password").value = "";
    el("lock-password").focus();
  }
});

el("lock-btn").addEventListener("click", () => {
  setToken(null);
  state.activeGame = null;
  showLockScreen();
});

el("version-type").addEventListener("change", () => {
  state.versionIdTouched = false;
  refreshVersionSuggestion();
});
el("version-id").addEventListener("input", () => {
  state.versionIdTouched = el("version-id").value.trim().length > 0;
});

function setChosenFiles(files) {
  state.chosenFiles = Array.from(files);
  el("chosen-files").textContent = state.chosenFiles.map((f) => f.name).join(", ");
  el("ready-tick").hidden = state.chosenFiles.length === 0;
}

el("choose-files-btn").addEventListener("click", () => el("file-input").click());
el("file-input").addEventListener("change", (e) => setChosenFiles(e.target.files));

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
dropZone.addEventListener("drop", (e) => setChosenFiles(e.dataTransfer.files));

boot();
