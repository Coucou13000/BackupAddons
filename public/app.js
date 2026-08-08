// --------------------------------------------------------------
// Espace privé : une clé aléatoire, générée une seule fois par visiteur,
// qui isole totalement ses blocs de ceux de n'importe qui d'autre.
// --------------------------------------------------------------
const STORAGE_KEY = "nuvioWorkspaceKey";

function generateKey() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID().replace(/-/g, "");
  // repli si randomUUID indisponible (très vieux navigateur)
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function ensureWorkspaceKey() {
  const url = new URL(window.location.href);
  let key = url.searchParams.get("key");

  if (key) {
    localStorage.setItem(STORAGE_KEY, key);
  } else {
    key = localStorage.getItem(STORAGE_KEY);
    if (!key) {
      key = generateKey();
      localStorage.setItem(STORAGE_KEY, key);
    }
    url.searchParams.set("key", key);
    window.history.replaceState({}, "", url);
  }
  return key;
}

const WORKSPACE_KEY = ensureWorkspaceKey();

const blocksEl = document.getElementById("blocks");
const blockTpl = document.getElementById("block-template");
const rowTpl = document.getElementById("manifest-row-template");
const saveStatus = document.getElementById("save-status");
const privateLinkValue = document.getElementById("private-link-value");
const copyPrivateLinkBtn = document.getElementById("copy-private-link");

privateLinkValue.textContent = window.location.href;
copyPrivateLinkBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(window.location.href);
  const original = copyPrivateLinkBtn.textContent;
  copyPrivateLinkBtn.textContent = "Copié";
  setTimeout(() => (copyPrivateLinkBtn.textContent = original), 1200);
});

function pad(n) { return String(n).padStart(2, "0"); }

function renumber(blockEl) {
  const list = blockEl.querySelector("[data-manifest-list]");
  const rows = [...list.children];
  rows.forEach((row, i) => {
    row.querySelector("[data-order]").textContent = pad(i + 1);
    row.querySelector("[data-move-up]").disabled = i === 0;
    row.querySelector("[data-move-down]").disabled = i === rows.length - 1;
  });
}

function renumberBlocks() {
  [...blocksEl.children].forEach((blockEl, i) => {
    blockEl.querySelector("[data-index]").textContent = `BLOC — ${pad(i + 1)}`;
  });
}

function addManifestRow(blockEl, url = "") {
  const node = rowTpl.content.cloneNode(true);
  const input = node.querySelector("[data-manifest-url]");
  input.value = url;

  const list = blockEl.querySelector("[data-manifest-list]");
  list.appendChild(node);
  const row = list.lastElementChild;

  row.querySelector("[data-remove-manifest]").addEventListener("click", () => {
    row.remove();
    renumber(blockEl);
  });
  row.querySelector("[data-move-up]").addEventListener("click", () => {
    const prev = row.previousElementSibling;
    if (prev) list.insertBefore(row, prev);
    renumber(blockEl);
  });
  row.querySelector("[data-move-down]").addEventListener("click", () => {
    const next = row.nextElementSibling;
    if (next) list.insertBefore(next, row);
    renumber(blockEl);
  });

  renumber(blockEl);
  return row;
}

const AUTO_CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const autoCheckIntervals = new Map(); // blockEl -> interval id

function addBlock(data = { id: "", name: "", manifests: [""] }) {
  const node = blockTpl.content.cloneNode(true);
  const blockEl = node.querySelector("[data-block]");
  blockEl.dataset.id = data.id || "";

  blockEl.querySelector("[data-name]").value = data.name || "";

  blockEl.querySelector("[data-remove-block]").addEventListener("click", () => {
    const intervalId = autoCheckIntervals.get(blockEl);
    if (intervalId) clearInterval(intervalId);
    autoCheckIntervals.delete(blockEl);
    blockEl.remove();
    renumberBlocks();
  });

  blockEl.querySelector("[data-add-manifest]").addEventListener("click", () => {
    addManifestRow(blockEl);
  });

  blockEl.querySelector("[data-toggle-bulk]").addEventListener("click", () => {
    const bulk = blockEl.querySelector("[data-bulk-add]");
    bulk.hidden = !bulk.hidden;
    if (!bulk.hidden) blockEl.querySelector("[data-bulk-textarea]").focus();
  });

  blockEl.querySelector("[data-bulk-submit]").addEventListener("click", () => {
    const textarea = blockEl.querySelector("[data-bulk-textarea]");
    const urls = textarea.value
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    urls.forEach((u) => addManifestRow(blockEl, u));
    textarea.value = "";
    blockEl.querySelector("[data-bulk-add]").hidden = true;
  });

  blockEl.querySelector("[data-copy]").addEventListener("click", () => {
    const val = blockEl.querySelector("[data-install-value]").textContent;
    navigator.clipboard.writeText(val);
    const btn = blockEl.querySelector("[data-copy]");
    const original = btn.textContent;
    btn.textContent = "Copié";
    setTimeout(() => (btn.textContent = original), 1200);
  });

  blocksEl.appendChild(node);
  const mounted = blocksEl.lastElementChild;

  const manifests = data.manifests && data.manifests.length ? data.manifests : [""];
  manifests.forEach((m) => addManifestRow(mounted, m));

  if (data.id) {
    const installEl = mounted.querySelector("[data-install-url]");
    installEl.hidden = false;
    mounted.querySelector("[data-install-value]").textContent =
      `${window.location.origin}/addon/${WORKSPACE_KEY}/${data.id}/manifest.json`;

    mounted.querySelector("[data-check-status]").addEventListener("click", () => checkStatus(mounted, data.id));
    checkStatus(mounted, data.id); // vérification automatique à l'affichage

    // Revérification périodique en arrière-plan, tant que l'onglet est visible
    const intervalId = setInterval(() => {
      if (!document.hidden) checkStatus(mounted, data.id);
    }, AUTO_CHECK_INTERVAL_MS);
    autoCheckIntervals.set(mounted, intervalId);
  }

  renumberBlocks();
  return mounted;
}

// --------------------------------------------------------------
// Statut en direct : ping chaque manifest du bloc, affiche un point par
// manifest (actif / en secours / hors service) et un badge résumé.
// --------------------------------------------------------------
async function checkStatus(blockEl, blockId) {
  const badge = blockEl.querySelector("[data-block-status]");
  const btn = blockEl.querySelector("[data-check-status]");
  const rows = [...blockEl.querySelectorAll("[data-manifest-row]")];

  badge.hidden = false;
  badge.dataset.state = "checking";
  badge.textContent = "Vérification…";
  btn.disabled = true;
  rows.forEach((row) => {
    row.querySelector("[data-status-dot]").dataset.state = "checking";
    row.querySelector("[data-status-label]").textContent = "";
  });

  try {
    const res = await fetch(`/api/blocks/${blockId}/status?key=${WORKSPACE_KEY}`);
    if (!res.ok) throw new Error("échec");
    const data = await res.json();

    data.manifests.forEach((m, i) => {
      const row = rows[i];
      if (!row) return;
      const dot = row.querySelector("[data-status-dot]");
      const label = row.querySelector("[data-status-label]");
      if (!m.ok) {
        dot.dataset.state = "down";
        dot.title = `Hors service (${m.error || "erreur"})`;
        label.dataset.state = "down";
        label.textContent = "hors service";
      } else if (i === data.activeIndex) {
        dot.dataset.state = "up";
        dot.title = `Actif — ${m.ms}ms`;
        label.dataset.state = "up-active";
        label.textContent = "actif";
      } else {
        dot.dataset.state = "up";
        dot.title = `Disponible en secours — ${m.ms}ms`;
        label.dataset.state = "up-standby";
        label.textContent = "en secours";
      }
    });

    if (data.upCount === data.total) {
      badge.dataset.state = "all-up";
      badge.textContent = data.total > 1 ? `${data.upCount}/${data.total} actifs` : "actif";
    } else if (data.upCount === 0) {
      badge.dataset.state = "all-down";
      badge.textContent = "tous hors service";
    } else {
      badge.dataset.state = "partial-up";
      badge.textContent = `${data.upCount}/${data.total} actif${data.upCount > 1 ? "s" : ""}`;
    }
  } catch {
    badge.dataset.state = "all-down";
    badge.textContent = "vérification impossible";
    rows.forEach((row) => {
      row.querySelector("[data-status-dot]").dataset.state = "down";
    });
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("add-block").addEventListener("click", () => addBlock());

function collectBlocks() {
  return [...blocksEl.children].map((blockEl) => {
    const name = blockEl.querySelector("[data-name]").value.trim();
    const manifests = [...blockEl.querySelectorAll("[data-manifest-url]")]
      .map((i) => i.value.trim())
      .filter(Boolean);
    return { id: blockEl.dataset.id || "", name, manifests };
  }).filter((b) => b.name || b.manifests.length);
}

async function saveAll() {
  const blocks = collectBlocks();
  saveStatus.textContent = "Enregistrement…";
  try {
    const res = await fetch("/api/blocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: WORKSPACE_KEY, blocks }),
    });
    if (!res.ok) throw new Error("Échec de l'enregistrement");
    const data = await res.json();
    saveStatus.textContent = "Enregistré ✓";
    await load(data.blocks); // recharge pour afficher les URLs d'installation à jour
  } catch (err) {
    saveStatus.textContent = "Erreur — réessaie";
  }
  setTimeout(() => (saveStatus.textContent = ""), 2500);
}

document.getElementById("save-all").addEventListener("click", saveAll);

async function load(preloaded) {
  autoCheckIntervals.forEach((intervalId) => clearInterval(intervalId));
  autoCheckIntervals.clear();
  blocksEl.innerHTML = "";
  const blocks = preloaded || (await (await fetch(`/api/blocks?key=${WORKSPACE_KEY}`)).json());
  if (!blocks.length) {
    addBlock();
  } else {
    blocks.forEach((b) => addBlock(b));
  }
}

// Revérifie immédiatement au retour sur l'onglet, plutôt que d'attendre le
// prochain tick de l'intervalle (peut être minutes plus tard).
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    [...blocksEl.children].forEach((blockEl) => {
      if (blockEl.dataset.id) checkStatus(blockEl, blockEl.dataset.id);
    });
  }
});

load();

// --------------------------------------------------------------
// Export / Import de la config — sauvegarde ou restauration en JSON
// --------------------------------------------------------------
document.getElementById("export-config").addEventListener("click", () => {
  const blocks = collectBlocks();
  const blob = new Blob([JSON.stringify({ blocks }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nuvio-failover-blocs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

const importFileInput = document.getElementById("import-file");
document.getElementById("import-trigger").addEventListener("click", () => importFileInput.click());

importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : Array.isArray(parsed) ? parsed : null;
    if (!blocks) throw new Error("format inattendu");

    // Ajoute les blocs importés à la suite de ceux déjà affichés (sans
    // écraser), sous forme de nouveaux blocs — évite de perdre des
    // modifications non enregistrées. Il faut cliquer "Enregistrer" ensuite.
    blocks.forEach((b) => addBlock({ id: "", name: b.name || "", manifests: b.manifests || [] }));

    saveStatus.textContent = `${blocks.length} bloc(s) importé(s) — clique Enregistrer pour valider`;
    setTimeout(() => (saveStatus.textContent = ""), 4000);
  } catch (err) {
    saveStatus.textContent = "Fichier invalide — vérifie qu'il vient bien d'un export de cet outil";
    setTimeout(() => (saveStatus.textContent = ""), 4000);
  } finally {
    importFileInput.value = "";
  }
});
