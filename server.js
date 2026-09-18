require("dotenv").config();
const path = require("path");
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
    const { versionId, label, type, basedOn, notes } = req.body;
    // versionId is optional — when omitted, the server auto-generates the next
    // full version (semver bump) or the next patch number for the current version.
    if (versionId && !isSafe(versionId)) {
      return res.status(400).json({ error: "Version id may only contain letters, numbers, dots, dashes and underscores." });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files were uploaded." });
    }
    const manifest = await azure.uploadVersion(game, versionId || null, req.files, {
      label,
      type: type === "patch" ? "patch" : "full",
      basedOn,
      notes,
    });
    res.json({ game: manifest });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/games/:game/versions/:versionId", async (req, res) => {
  try {
    const manifest = await azure.deleteVersion(req.params.game, req.params.versionId);
    res.json({ game: manifest });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/games/:game/versions/:versionId/files/:filename", async (req, res) => {
  try {
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
});
