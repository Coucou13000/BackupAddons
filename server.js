import express from "express";
import fetch from "node-fetch";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const TIMEOUT_MS = 6000;
const PORT = process.env.PORT || 7000;

const app = express();

// --------------------------------------------------------------
// Logs — tout ce qui passe ici apparaît dans l'onglet "Logs" de Render
// --------------------------------------------------------------
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

// Filet de sécurité explicite pour "/" : si express.static ne trouve pas
// index.html (dossier public/ absent du déploiement, mauvais Root Directory
// sur Render, etc.), on log clairement la cause au lieu de laisser Express
// renvoyer un "Cannot GET /" muet.
app.get("/", (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fsSync.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  console.error(`❌ index.html introuvable à ${indexPath}`);
  console.error(`   Contenu de ${PUBLIC_DIR} :`, fsSync.existsSync(PUBLIC_DIR) ? fsSync.readdirSync(PUBLIC_DIR) : "dossier public/ absent");
  res
    .status(500)
    .type("text/plain")
    .send(
      "Le dossier public/ (page d'admin) est introuvable sur ce déploiement.\n" +
      "Vérifie sur Render que le dossier 'public' est bien commité sur GitHub et que\n" +
      "le 'Root Directory' du service pointe sur le dossier qui contient server.js."
    );
});

// Endpoint de santé simple, utile pour vérifier que le service répond
app.get("/healthz", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// --------------------------------------------------------------
// Stockage de la config : un espace ("workspace") isolé par clé privée.
// Structure : { workspaces: { "<clé>": { blocks: [...] } } }
//
// Deux backends possibles, choisis automatiquement :
// - Upstash Redis (gratuit, persiste vraiment) si UPSTASH_REDIS_REST_URL et
//   UPSTASH_REDIS_REST_TOKEN sont définis en variables d'environnement.
// - Sinon, fichier local config.json (fonctionne en local, et sur Render
//   uniquement si un disque persistant payant est attaché — sur le tier
//   gratuit de Render, ce fichier repart à zéro à chaque réveil du service).
// --------------------------------------------------------------
const KEY_RE = /^[a-zA-Z0-9_-]{8,80}$/;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
const UPSTASH_STORE_KEY = "nuvio-failover-config";

function isValidKey(key) {
  return typeof key === "string" && KEY_RE.test(key);
}

async function upstashRequest(pathSegments, body) {
  const url = `${UPSTASH_URL.replace(/\/+$/, "")}/${pathSegments.map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    method: body !== undefined ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      ...(body !== undefined ? { "Content-Type": "text/plain" } : {}),
    },
    body,
  });
  if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
  return res.json();
}

async function readConfig() {
  if (USE_UPSTASH) {
    try {
      const data = await upstashRequest(["get", UPSTASH_STORE_KEY]);
      if (!data.result) return { workspaces: {} };
      const parsed = JSON.parse(data.result);
      return parsed.workspaces ? parsed : { workspaces: {} };
    } catch (err) {
      console.error("❌ Lecture Upstash impossible :", err.message);
      return { workspaces: {} };
    }
  }

  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.workspaces) return { workspaces: {} };
    return parsed;
  } catch {
    return { workspaces: {} };
  }
}

async function writeConfig(cfg) {
  const json = JSON.stringify(cfg, null, 2);
  if (USE_UPSTASH) {
    await upstashRequest(["set", UPSTASH_STORE_KEY], json);
    return;
  }
  await fs.writeFile(CONFIG_PATH, json, "utf-8");
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
// API admin — utilisée par la page web, toujours scopée à ?key=
// --------------------------------------------------------------
app.get("/api/blocks", async (req, res) => {
  const key = req.query.key;
  if (!isValidKey(key)) return res.status(400).json({ error: "Clé d'espace manquante ou invalide" });
  const cfg = await readConfig();
  res.json(cfg.workspaces[key]?.blocks || []);
});

app.post("/api/blocks", async (req, res) => {
  const key = req.body?.key;
  if (!isValidKey(key)) return res.status(400).json({ error: "Clé d'espace manquante ou invalide" });

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

  const cfg = await readConfig();
  cfg.workspaces[key] = { blocks };
  await writeConfig(cfg);
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

// Un host peut répondre HTTP 200 avec un JSON qui n'est pas un manifest
// Stremio valide (mauvaise config, page d'erreur en JSON, etc.). On vérifie
// la structure minimale attendue avant de considérer le manifest utilisable.
function validateManifest(json) {
  if (!json || typeof json !== "object") return "réponse vide ou non-objet";
  if (!json.id || typeof json.id !== "string") return "champ 'id' manquant";
  if (!json.name || typeof json.name !== "string") return "champ 'name' manquant";
  if (!Array.isArray(json.resources)) return "champ 'resources' manquant ou invalide";
  if (!Array.isArray(json.types) && !Array.isArray(json.catalogs)) return "champ 'types' ou 'catalogs' manquant";
  return null; // valide
}

async function tryManifestBackend(base) {
  const json = await tryBackend(base, "manifest.json");
  const issue = validateManifest(json);
  if (issue) throw new Error(`manifest invalide (${issue})`);
  return json;
}

// mémorise, par (espace, bloc), le dernier manifest qui a répondu correctement
const lastGoodByBlock = new Map();

// --------------------------------------------------------------
// Statut en direct des manifests d'un bloc — pinge chaque host et indique
// lequel est actif, en secours, ou hors service.
// --------------------------------------------------------------
const STATUS_TIMEOUT_MS = 4000;

app.get("/api/blocks/:blockId/status", async (req, res) => {
  const key = req.query.key;
  const { blockId } = req.params;
  if (!isValidKey(key)) return res.status(400).json({ error: "Clé d'espace manquante ou invalide" });

  const cfg = await readConfig();
  const block = cfg.workspaces[key]?.blocks?.find((b) => b.id === blockId);
  if (!block) return res.status(404).json({ error: "Bloc introuvable" });

  const results = await Promise.all(
    block.manifests.map(async (m) => {
      const base = m.replace(/\/manifest\.json\/?$/, "");
      const started = Date.now();
      try {
        await tryManifestBackend(base);
        return { url: m, ok: true, ms: Date.now() - started };
      } catch (err) {
        return { url: m, ok: false, ms: Date.now() - started, error: err.message };
      }
    })
  );

  const mapKey = `${key}:${blockId}`;
  const cachedPreferred = lastGoodByBlock.get(mapKey) ?? 0;
  // "Actif" = celui que le proxy utiliserait réellement là maintenant : le
  // dernier host mémorisé s'il répond encore, sinon le premier qui répond.
  let activeIndex = results[cachedPreferred]?.ok ? cachedPreferred : results.findIndex((r) => r.ok);

  res.json({
    manifests: results,
    activeIndex,
    upCount: results.filter((r) => r.ok).length,
    total: results.length,
  });
});

// Route : /addon/<clé privée>/<blockId>/... — la clé isole totalement les
// blocs d'un visiteur de ceux des autres, même en cas de même nom de bloc.
app.get(/^\/addon\/([^/]+)\/([^/]+)\/(.*)$/, async (req, res) => {
  const key = req.params[0];
  const blockId = req.params[1];
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const subPath = req.params[2] + query;
  const mapKey = `${key}:${blockId}`;

  res.set("Access-Control-Allow-Origin", "*");

  if (!isValidKey(key)) {
    return res.status(400).json({ err: "Clé d'espace invalide" });
  }

  const cfg = await readConfig();
  const block = cfg.workspaces[key]?.blocks?.find((b) => b.id === blockId);

  if (!block || block.manifests.length === 0) {
    return res.status(404).json({ err: "Bloc introuvable ou vide" });
  }

  const bases = block.manifests.map((m) => m.replace(/\/manifest\.json\/?$/, ""));
  const lastGood = lastGoodByBlock.get(mapKey) || 0;
  const order = [lastGood, ...bases.map((_, i) => i).filter((i) => i !== lastGood)];

  let lastError = null;
  for (const i of order) {
    const isManifestRequest = subPath.split("?")[0] === "manifest.json";
    try {
      // Sur manifest.json, on valide aussi la structure : un host qui répond
      // 200 avec un JSON cassé ou incomplet est traité comme en panne, et on
      // passe au manifest suivant du bloc.
      const json = isManifestRequest ? await tryManifestBackend(bases[i]) : await tryBackend(bases[i], subPath);
      lastGoodByBlock.set(mapKey, i);
      console.log(`✅ [${blockId}/${subPath}] servi par manifest #${i + 1}`);

      // Sur le manifest uniquement, on fige le nom affiché à "BackupAddons —
      // <nom du bloc>" au lieu du nom que renvoie le backend qui a répondu.
      // Ça évite que le nom change dans Nuvio selon lequel des manifests de
      // secours a répondu, et montre clairement que c'est un bloc de secours
      // plutôt qu'une seule instance nue. Rien d'autre n'est modifié (id,
      // resources, catalogs...), donc le fonctionnement du bloc est inchangé.
      if (isManifestRequest && json && typeof json === "object") {
        json.name = `BackupAddons — ${block.name}`;
      }

      return res.json(json);
    } catch (err) {
      lastError = err;
      console.warn(`⚠️  [${blockId}/${subPath}] échec manifest #${i + 1} : ${err.message}`);
    }
  }

  console.error(`❌ [${blockId}/${subPath}] tous les manifests du bloc ont échoué`);
  res.status(502).json({ err: "Tous les manifests de ce bloc sont indisponibles", detail: lastError?.message });
});

// 404 explicite pour toute route non gérée (au lieu du message muet par défaut
// d'Express), pour repérer facilement dans les logs Render un mauvais chemin
// collé dans Nuvio ou un bloc mal orthographié.
app.use((req, res) => {
  console.warn(`⚠️  404 : ${req.method} ${req.originalUrl} ne correspond à aucune route`);
  res.status(404).type("text/plain").send(`Cannot ${req.method} ${req.originalUrl}`);
});

// Filet de sécurité pour toute erreur non attrapée, loguée avec sa stack
// complète plutôt que de faire planter le process silencieusement.
app.use((err, req, res, next) => {
  console.error(`❌ Erreur non gérée sur ${req.method} ${req.originalUrl} :`, err);
  res.status(500).json({ err: "Erreur interne du serveur" });
});

app.listen(PORT, () => {
  console.log(`🚀 Nuvio Failover Addon (v2, multi-blocs) démarré sur le port ${PORT}`);
  console.log(`__dirname          : ${__dirname}`);
  console.log(`Dossier public/    : ${fsSync.existsSync(PUBLIC_DIR) ? "trouvé ✓" : "INTROUVABLE ✗"}`);
  if (fsSync.existsSync(PUBLIC_DIR)) {
    console.log(`Contenu public/    : ${fsSync.readdirSync(PUBLIC_DIR).join(", ")}`);
  }
  if (USE_UPSTASH) {
    console.log(`Stockage config    : Upstash Redis (persistant) ✓`);
  } else {
    console.log(`Stockage config    : fichier local config.json`);
    console.log(`                     ⚠️  sur le tier gratuit de Render, ce fichier repart à`);
    console.log(`                     zéro à chaque réveil du service. Voir README.md pour`);
    console.log(`                     activer Upstash (gratuit, persistant) ou un disque payant.`);
  }
  console.log(`Interface d'admin  : http://localhost:${PORT}/`);
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection :", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException :", err);
});
