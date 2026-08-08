import express from "express";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const TIMEOUT_MS = 6000;
const PORT = process.env.PORT || 7000;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------------------
// Stockage de la config (blocs d'addons) dans config.json
// --------------------------------------------------------------
async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { blocks: [] };
  }
}

async function writeConfig(cfg) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

function slugify(str) {
  return (str || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40) || "bloc";
}

function uniqueId(base, existingIds) {
  let id = base;
  let n = 2;
  while (existingIds.includes(id)) {
    id = `${base}-${n}`;
    n++;
  }
  return id;
}

// --------------------------------------------------------------
// API admin — utilisée par la page web
// --------------------------------------------------------------
app.get("/api/blocks", async (req, res) => {
  const cfg = await readConfig();
  res.json(cfg.blocks);
});

app.post("/api/blocks", async (req, res) => {
  const incoming = Array.isArray(req.body?.blocks) ? req.body.blocks : null;
  if (!incoming) return res.status(400).json({ error: "Format invalide" });

  const existingIds = [];
  const blocks = incoming.map((b) => {
    const name = (b.name || "").trim() || "Bloc sans nom";
    const manifests = (b.manifests || [])
      .map((m) => (m || "").trim())
      .filter(Boolean);
    let id = b.id && typeof b.id === "string" ? b.id : slugify(name);
    id = uniqueId(slugify(id), existingIds);
    existingIds.push(id);
    return { id, name, manifests };
  });

  await writeConfig({ blocks });
  res.json({ ok: true, blocks });
});

// --------------------------------------------------------------
// Proxy de secours — une route par bloc : /addon/:blockId/...
// --------------------------------------------------------------
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function tryBackend(base, path) {
  const url = `${base.replace(/\/+$/, "")}/${path}`;
  const res = await withTimeout(
    fetch(url, { headers: { "User-Agent": "NuvioFailoverAddon/2.0" } }),
    TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("réponse non-JSON");
  }
}

// mémorise, par bloc, le dernier manifest qui a répondu correctement
const lastGoodByBlock = new Map();

app.get(/^\/addon\/([^/]+)\/(.*)$/, async (req, res) => {
  const blockId = req.params[0];
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const subPath = req.params[1] + query;

  const cfg = await readConfig();
  const block = cfg.blocks.find((b) => b.id === blockId);

  res.set("Access-Control-Allow-Origin", "*");

  if (!block || block.manifests.length === 0) {
    return res.status(404).json({ err: "Bloc introuvable ou vide" });
  }

  const bases = block.manifests.map((m) => m.replace(/\/manifest\.json\/?$/, ""));
  const lastGood = lastGoodByBlock.get(blockId) || 0;
  const order = [lastGood, ...bases.map((_, i) => i).filter((i) => i !== lastGood)];

  let lastError = null;
  for (const i of order) {
    try {
      const json = await tryBackend(bases[i], subPath);
      lastGoodByBlock.set(blockId, i);
      console.log(`✅ [${blockId}/${subPath}] servi par manifest #${i + 1}`);
      return res.json(json);
    } catch (err) {
      lastError = err;
      console.warn(`⚠️  [${blockId}/${subPath}] échec manifest #${i + 1} : ${err.message}`);
    }
  }

  console.error(`❌ [${blockId}/${subPath}] tous les manifests du bloc ont échoué`);
  res.status(502).json({ err: "Tous les manifests de ce bloc sont indisponibles", detail: lastError?.message });
});

app.listen(PORT, () => {
  console.log(`🚀 Nuvio Failover Addon (v2, multi-blocs) démarré sur le port ${PORT}`);
  console.log(`Interface d'administration : http://localhost:${PORT}/`);
});
