const STORAGE_KEY = "wmcSelectionSession";
const grid = document.getElementById("grid");
const search = document.getElementById("search");
const selectedCount = document.getElementById("selectedCount");
const totalCount = document.getElementById("totalCount");
const visibleCount = document.getElementById("visibleCount");
const filtersEl = document.getElementById("filters");

let media = [];
let selected = new Set();
let activeType = "TODOS";
let duplicateKeys = new Set();
let deduping = false;

function category(item) {
  const ext = String(item.extension || "").toLowerCase();
  if (item.kind === "video" || ["mp4","m4v","mov","webm","avi","mkv"].includes(ext)) return "VIDEO";
  if (["jpg","jpeg"].includes(ext)) return "JPG";
  if (ext === "png") return "PNG";
  if (ext === "gif") return "GIF";
  if (ext === "webp") return "WEBP";
  return "OTROS";
}

function key(item) {
  return item.key || `${item.kind}|${item.url}`;
}

function text(item) {
  return [item.title,item.alt,item.aria,item.context,item.url,item.pinUrl,category(item)]
    .filter(Boolean).join(" ").toLowerCase();
}

function visibleItems() {
  const q = search.value.trim().toLowerCase();
  return media.filter(item =>
    (activeType === "TODOS" || category(item) === activeType) &&
    (!q || text(item).includes(q))
  );
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function pinterestImageFallbacks(value) {
  try {
    const u = new URL(value);
    if (u.hostname !== "i.pinimg.com") return [];
    const match = u.pathname.match(/^\/(originals|1200x|736x|564x|474x|236x)\/(.+)$/i);
    if (!match) return [];
    const rest = match[2];
    const order = [match[1], "736x", "564x", "474x", "236x", "originals"];
    return unique(order.map(size => {
      const v = new URL(u.href);
      v.pathname = `/${size}/${rest}`;
      return v.href;
    }));
  } catch {
    return [];
  }
}

function imageCandidates(item) {
  const values = [item.previewUrl, item.posterUrl, item.url, ...(item.alternateUrls || [])];
  const expanded = [];
  for (const value of unique(values)) {
    expanded.push(value, ...pinterestImageFallbacks(value));
  }
  return unique(expanded);
}

function videoCandidates(item) {
  return unique([item.url, ...(item.alternateUrls || [])]);
}

function makeFallback(label) {
  const fallback = document.createElement("div");
  fallback.className = "previewFallback";
  fallback.textContent = label;
  return fallback;
}

function mountImage(card, item, candidates = imageCandidates(item), index = 0) {
  if (index >= candidates.length) {
    card.appendChild(makeFallback("Vista previa no disponible\nEl recurso seguirá en la selección si está marcado."));
    return;
  }
  const img = document.createElement("img");
  img.className = "thumb";
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = item.alt || item.title || "Recurso";
  img.addEventListener("error", () => {
    img.remove();
    mountImage(card, item, candidates, index + 1);
  }, { once: true });
  img.src = candidates[index];
  card.appendChild(img);
}

function mountVideo(card, item) {
  const wrap = document.createElement("div");
  wrap.className = "videoWrap";
  const posters = unique([item.posterUrl].filter(Boolean));

  if (posters.length) {
    mountImage(wrap, { ...item, previewUrl: posters[0], alternateUrls: posters.slice(1) }, imageCandidates({ ...item, previewUrl: posters[0], alternateUrls: posters.slice(1) }));
  } else {
    const candidates = videoCandidates(item);
    const video = document.createElement("video");
    video.className = "thumb";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "metadata";
    let index = 0;
    const tryNext = () => {
      if (index >= candidates.length) {
        video.remove();
        wrap.appendChild(makeFallback("Video detectado\nVista previa no disponible"));
        return;
      }
      video.src = candidates[index++];
      video.load();
    };
    video.addEventListener("error", tryNext);
    video.addEventListener("mouseenter", () => video.play().catch(() => {}));
    video.addEventListener("mouseleave", () => { try { video.pause(); } catch {} });
    wrap.appendChild(video);
    tryNext();
  }

  const badge = document.createElement("div");
  badge.className = "videoBadge";
  badge.textContent = "VIDEO";
  wrap.appendChild(badge);
  card.appendChild(wrap);
}


function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

function qualityScore(info) {
  const pixels = (info.width || 0) * (info.height || 0);
  const url = String(info.item.url || "");
  const bonus = /\/originals\//i.test(url) ? 1e12 : /\/1200x\//i.test(url) ? 5e11 : /\/736x\//i.test(url) ? 2e11 : 0;
  return pixels + bonus;
}

async function fingerprintImage(item) {
  const canonical = (() => {
    try {
      const u = new URL(item.url || item.previewUrl || "");
      u.hash = "";
      return u.href;
    } catch {
      return String(item.url || item.previewUrl || "");
    }
  })();
  if (!canonical) return null;
  let h1 = 2166136261 >>> 0;
  let h2 = 2246822519 >>> 0;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= c; h2 = Math.imul(h2, 3266489917) >>> 0;
  }
  const hash = (h1.toString(2).padStart(32,"0") + h2.toString(2).padStart(32,"0"));
  return { item, hash, width: 0, height: 0 };
}

async function fingerprintVideoPoster(item) {
  if (!item.posterUrl) return null;
  return fingerprintImage({ ...item, previewUrl: item.posterUrl, url: item.posterUrl, alternateUrls: [] });
}

async function runDedupe() {
  if (deduping) return;
  deduping = true;
  duplicateKeys = new Set();
  const button = document.getElementById("dedupe");
  const status = document.getElementById("dedupeStatus");
  button.disabled = true;
  const candidates = media.filter(item => selected.has(key(item)));
  status.textContent = `Analizando huellas visuales: 0 de ${candidates.length}…`;

  const infos = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++;
      const item = candidates[index];
      const info = category(item) === "VIDEO" ? await fingerprintVideoPoster(item) : await fingerprintImage(item);
      if (info) infos.push(info);
      status.textContent = `Analizando huellas visuales: ${Math.min(cursor, candidates.length)} de ${candidates.length}…`;
    }
  });
  await Promise.all(workers);

  const groups = [];
  for (const info of infos) {
    const ratio = info.height ? info.width / info.height : 0;
    let group = groups.find(g => {
      const gr = g.best.height ? g.best.width / g.best.height : 0;
      return Math.abs(ratio - gr) <= 0.035 && hamming(info.hash, g.best.hash) <= 5;
    });
    if (!group) {
      groups.push({ best: info, members: [info] });
      continue;
    }
    group.members.push(info);
    if (qualityScore(info) > qualityScore(group.best)) group.best = info;
  }

  let removed = 0;
  for (const group of groups) {
    if (group.members.length < 2) continue;
    const keep = key(group.best.item);
    for (const info of group.members) {
      const k = key(info.item);
      if (k !== keep && selected.has(k)) {
        selected.delete(k);
        duplicateKeys.add(k);
        removed++;
      }
    }
  }
  await save();
  updateCounts();
  render();
  status.textContent = removed
    ? `✓ ${removed} duplicados visuales descartados. Se conservaron las copias de mayor resolución disponibles.`
    : `✓ No se encontraron duplicados visuales seguros entre ${infos.length} recursos comparables.`;
  button.disabled = false;
  deduping = false;
}

async function save() {
  const current = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  current.media = media;
  current.selectedKeys = [...selected];
  current.selectedCount = selected.size;
  current.updatedAt = Date.now();
  await chrome.storage.local.set({ [STORAGE_KEY]: current });
}

function updateCounts() {
  selectedCount.textContent = selected.size;
  totalCount.textContent = media.length;
  visibleCount.textContent = visibleItems().length;
}

function renderFilters() {
  const types = ["TODOS","JPG","PNG","GIF","WEBP","VIDEO","OTROS"];
  filtersEl.innerHTML = "";
  for (const type of types) {
    const b = document.createElement("button");
    b.className = `chip${activeType === type ? " active" : ""}`;
    b.textContent = type;
    b.addEventListener("click", () => {
      activeType = type;
      renderFilters();
      render();
    });
    filtersEl.appendChild(b);
  }
}

function render() {
  const visible = visibleItems();
  updateCounts();
  grid.innerHTML = "";

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No hay recursos para mostrar con este filtro.";
    grid.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of visible) {
    const k = key(item);
    const card = document.createElement("div");
    card.className = `card${selected.has(k) ? " selected" : ""}${duplicateKeys.has(k) ? " duplicate" : ""}`;
    card.dataset.key = k;

    const check = document.createElement("div");
    check.className = "check";
    check.textContent = selected.has(k) ? "✓" : "";
    card.appendChild(check);

    if (category(item) === "VIDEO") mountVideo(card, item);
    else mountImage(card, item);

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.title || item.alt || item.context || (() => {
      try { return new URL(item.url).pathname.split("/").pop(); } catch { return "Recurso"; }
    })() || "Recurso";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${category(item)} · ${item.extension || "?"}`;
    info.append(name, meta);
    card.appendChild(info);

    card.addEventListener("click", async () => {
      if (selected.has(k)) selected.delete(k); else selected.add(k);
      card.classList.toggle("selected", selected.has(k));
      check.textContent = selected.has(k) ? "✓" : "";
      updateCounts();
      await save();
    });

    frag.appendChild(card);
  }
  grid.appendChild(frag);
}


async function setVisibleSelection(mode) {
  const visible = visibleItems();
  for (const item of visible) {
    const k = key(item);
    if (mode === "select") selected.add(k);
    else selected.delete(k);
  }
  await save();
  render();
}

async function deselectEverything() {
  selected.clear();
  await save();
  render();
}

search.addEventListener("input", render);
document.getElementById("selectVisible").addEventListener("click", () => setVisibleSelection("select"));
document.getElementById("deselectVisible").addEventListener("click", () => setVisibleSelection("deselect"));
document.getElementById("deselectAll").addEventListener("click", deselectEverything);
document.getElementById("dedupe").addEventListener("click", runDedupe);
document.getElementById("applyClose").addEventListener("click", async () => {
  await save();
  const session = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
  try {
    if (Number.isInteger(session.sourceTabId)) {
      await chrome.tabs.update(session.sourceTabId, { active: true });
    }
  } catch {}
  try {
    const current = await chrome.tabs.getCurrent();
    if (current?.id) {
      await chrome.tabs.remove(current.id);
      return;
    }
  } catch {}
  window.close();
});

(async () => {
  const session = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!session?.media?.length) {
    grid.innerHTML = '<div class="empty">No hay una extracción activa. Vuelve al panel y ejecuta “Extraer contenido”.</div>';
    return;
  }
  media = session.media;
  selected = new Set(Array.isArray(session.selectedKeys) ? session.selectedKeys : media.map(key));
  renderFilters();
  render();
})();
