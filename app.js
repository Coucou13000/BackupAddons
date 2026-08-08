const blocksEl = document.getElementById("blocks");
const blockTpl = document.getElementById("block-template");
const rowTpl = document.getElementById("manifest-row-template");
const saveStatus = document.getElementById("save-status");

function pad(n) { return String(n).padStart(2, "0"); }

function renumber(blockEl) {
  const list = blockEl.querySelector("[data-manifest-list]");
  [...list.children].forEach((row, i) => {
    row.querySelector("[data-order]").textContent = pad(i + 1);
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
  node.querySelector("[data-remove-manifest]").addEventListener("click", () => {
    row.remove();
    renumber(blockEl);
  });
  const list = blockEl.querySelector("[data-manifest-list]");
  list.appendChild(node);
  const row = list.lastElementChild;
  row.querySelector("[data-remove-manifest]").addEventListener("click", () => {
    row.remove();
    renumber(blockEl);
  });
  renumber(blockEl);
  return row;
}

function addBlock(data = { id: "", name: "", manifests: [""] }) {
  const node = blockTpl.content.cloneNode(true);
  const blockEl = node.querySelector("[data-block]");
  blockEl.dataset.id = data.id || "";

  blockEl.querySelector("[data-name]").value = data.name || "";

  blockEl.querySelector("[data-remove-block]").addEventListener("click", () => {
    blockEl.remove();
    renumberBlocks();
  });

  blockEl.querySelector("[data-add-manifest]").addEventListener("click", () => {
    addManifestRow(blockEl);
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
      `${window.location.origin}/addon/${data.id}/manifest.json`;
  }

  renumberBlocks();
  return mounted;
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
      body: JSON.stringify({ blocks }),
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
  blocksEl.innerHTML = "";
  const blocks = preloaded || (await (await fetch("/api/blocks")).json());
  if (!blocks.length) {
    addBlock();
  } else {
    blocks.forEach((b) => addBlock(b));
  }
}

load();
