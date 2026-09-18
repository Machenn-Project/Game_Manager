require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const azure = require("./src/azureService");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

function isSafe(name) {
  return typeof name === "string" && name.length > 0 && SAFE_NAME.test(name);
}

// --- App password gate ---
// When APP_PASSWORD is set, the whole app requires it: a session token to view/use
// anything, and the same password re-entered to confirm every create/upload/delete.
// Leave APP_PASSWORD unset in .env to disable the gate entirely.
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const AUTH_REQUIRED = APP_PASSWORD.length > 0;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiresAt

function issueToken() {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isValidToken(token) {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Re-checked on every create/upload/delete, independent of the session token,
// so the password has to be re-entered to confirm each mutating action.
function checkActionPassword(req, res) {
  if (!AUTH_REQUIRED) return true;
  const provided = req.body && req.body.password;
  if (provided !== APP_PASSWORD) {
    res.status(403).json({ error: "Incorrect password." });
    return false;
  }
  return true;
}

app.get("/api/auth-status", (req, res) => {
  res.json({ required: AUTH_REQUIRED });
});

app.post("/api/login", (req, res) => {
  if (!AUTH_REQUIRED) return res.json({ ok: true, token: null });
  const { password } = req.body || {};
  if (password !== APP_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  res.json({ ok: true, token: issueToken() });
});

app.use("/api", (req, res, next) => {
  if (!AUTH_REQUIRED) return next();
  if (!isValidToken(req.get("X-App-Token"))) {
    return res.status(401).json({ error: "Please unlock the app with the password first." });
  }
  next();
});

// --- Games ---

app.get("/api/games", async (req, res) => {
  try {
    const names = await azure.listGames();
    const games = await Promise.all(
      names.map(async (name) => {
        const manifest = await azure.getGameManifest(name);
        return azure.withCurrentFiles(name, manifest);
      })
    );
    res.json({ games });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/games", async (req, res) => {
  try {
    const { name } = req.body;
    if (!isSafe(name)) {
      return res.status(400).json({ error: "Game name may only contain letters, numbers, dots, dashes and underscores." });
    }
    if (!checkActionPassword(req, res)) return;
    const manifest = await azure.createGame(name);
    res.json({ game: azure.withCurrentFiles(name, manifest) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/games/:game", async (req, res) => {
  try {
    const manifest = await azure.getGameManifest(req.params.game);
    res.json({ game: azure.withCurrentFiles(req.params.game, manifest) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/games/:game", async (req, res) => {
  try {
    if (!checkActionPassword(req, res)) return;
    await azure.deleteGame(req.params.game);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Versions (full releases and patches share the same shape) ---

app.get("/api/games/:game/next-version", async (req, res) => {
  try {
    const type = req.query.type === "patch" ? "patch" : "full";
    const suggestion = await azure.getNextVersion(req.params.game, type);
    res.json(suggestion);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/games/:game/versions", upload.array("files", 50), async (req, res) => {
  try {
    const { game } = req.params;
    const { versionId, label, type, basedOn, notes, executableName } = req.body;
    // versionId is optional — when omitted, the server auto-generates the next
    // full version (semver bump) or the next patch number for the current version.
    if (versionId && !isSafe(versionId)) {
      return res.status(400).json({ error: "Version id may only contain letters, numbers, dots, dashes and underscores." });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files were uploaded." });
    }
    if (!checkActionPassword(req, res)) return;
    const manifest = await azure.uploadVersion(game, versionId || null, req.files, {
      label,
      type: type === "patch" ? "patch" : "full",
      basedOn,
      notes,
      executableName: executableName ? executableName.trim() : "",
    });
    res.json({ game: manifest });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/games/:game/versions/:versionId", async (req, res) => {
  try {
    if (!checkActionPassword(req, res)) return;
    const manifest = await azure.deleteVersion(req.params.game, req.params.versionId);
    res.json({ game: manifest });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/games/:game/versions/:versionId/files/:filename", async (req, res) => {
  try {
    if (!checkActionPassword(req, res)) return;
    const manifest = await azure.deleteFile(req.params.game, req.params.versionId, req.params.filename);
    res.json({ game: manifest });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Game CDN Manager running at http://localhost:${PORT}`);
  if (!AUTH_REQUIRED) {
    console.warn("[auth] APP_PASSWORD is not set — the app is open to anyone who can reach it.");
  }
});
