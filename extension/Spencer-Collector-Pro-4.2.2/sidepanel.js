let media = [];
let selectedKeys = new Set();
let scanning = false;
let analyzing = false;
let downloading = false;
let uploadingDrive = false;
let analysisReady = false;
let driveVerified = false;
let currentCollectionId = null;
let currentCollectionName = "";
let selectionTimer = null;
let driveUploadTicker = null;
let driveUploadStartedAt = 0;

const STORAGE_KEY = "wmcSelectionSession";
const AUTH_STORAGE_KEY = "wmcCloudSession";
const API = "https://wmc-api-production.up.railway.app";
const EXPECTED_SERVER_VERSION = "4.2.0";
const $ = id => document.getElementById(id);

function log(text) {
  console.log(`[Web Media Collector] ${text}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCloudSession() {
  const result = await chrome.storage.local.get(AUTH_STORAGE_KEY);
  const session = result[AUTH_STORAGE_KEY];
  if (!session?.token) return null;
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    await chrome.storage.local.remove(AUTH_STORAGE_KEY);
    return null;
  }
  return session;
}

async function saveCloudSession(data) {
  const session = {
    token: data.token,
    expiresAt: data.expires_at || null,
    user: data.user || null
  };
  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: session });
  return session;
}

async function clearCloudSession() {
  await chrome.storage.local.remove(AUTH_STORAGE_KEY);
}

async function authFetch(path, options = {}) {
  const session = await getCloudSession();
  if (!session?.token) throw new Error("AUTH_REQUIRED");
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${session.token}`);
  return fetch(`${API}${path}`, { ...options, headers });
}

async function pollDriveAuthorization(startData) {
  const deadline = Date.now() + Math.max(60, Number(startData.expires_in || 600)) * 1000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const response = await fetch(`${API}/api/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: startData.device_id,
        device_secret: startData.device_secret
      })
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.status === "authorized" && data.token) return saveCloudSession(data);
    if (response.ok && data.status === "pending") continue;
    if (response.status === 410 || data.status === "expired") throw new Error("AUTH_EXPIRED");
    if (!response.ok) throw new Error(data.error || `AUTH_HTTP:${response.status}`);
  }
  throw new Error("AUTH_TIMEOUT");
}

async function startDriveAuthorization() {
  const response = await fetch(`${API}/api/auth/device/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.login_url) throw new Error(data.message || data.error || `AUTH_START_HTTP:${response.status}`);
  await chrome.tabs.create({ url: data.login_url });
  return pollDriveAuthorization(data);
}

async function verifyDriveWithSession() {
  const response = await authFetch("/api/drive/verify", { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    await clearCloudSession();
    throw new Error("AUTH_REQUIRED");
  }
  if (!response.ok || !data.ok) throw new Error(data.error || `DRIVE_HTTP:${response.status}`);
  return data;
}

async function ensureDriveAuthorization() {
  try {
    if (await getCloudSession()) return await verifyDriveWithSession();
  } catch (error) {
    if (String(error?.message || error) !== "AUTH_REQUIRED") throw error;
  }
  await startDriveAuthorization();
  return verifyDriveWithSession();
}

function progress(bar, text, current, total, start, eta) {
  const percent = total ? Math.round((current / total) * 100) : 0;
  $(bar).style.width = percent + "%";
  $(text).textContent = `${current} / ${total} · ${percent}%`;
  if (current > 0 && current < total) {
    const elapsed = (Date.now() - start) / 1000;
    const remaining = Math.max(0, Math.round((elapsed / current) * (total - current)));
    $(eta).textContent = `Tiempo restante estimado: ${remaining}s`;
  } else {
    $(eta).textContent = "";
  }
}

function cleanName(text) {
  if (!text) return "";
  return String(text)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/[^\p{L}\p{N}\s._()-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 110);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function compactCollectionId(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([A-Za-z]+)-0*(\d+)$/);
  if (!match) return raw || "WMC-1";
  return `${match[1].toUpperCase()}-${Number(match[2])}`;
}

function formatCollectionFolderName(id, name) {
  const shortId = compactCollectionId(id || "WMC-1");
  return name ? `${shortId} - ${name}` : shortId;
}

function startDriveProgressTracker(totalItems) {
  stopDriveProgressTracker();
  driveUploadStartedAt = Date.now();
  const estimatedTotalMs = Math.max(45000, Math.min(8 * 60 * 1000, totalItems * 2200));
  driveUploadTicker = setInterval(() => {
    const elapsed = Date.now() - driveUploadStartedAt;
    const ratio = Math.min(1, elapsed / estimatedTotalMs);
    const eased = 1 - Math.pow(1 - ratio, 1.8);
    const percent = Math.min(92, Math.max(8, Math.round(8 + eased * 84)));
    const remaining = Math.max(0, estimatedTotalMs - elapsed);
    $("driveBar").style.width = `${percent}%`;
    $("driveProgress").textContent = `Subiendo a Google Drive... ${percent}%`;
    $("driveEta").textContent = `Tiempo transcurrido: ${formatDuration(elapsed)} · Restante estimado: ${formatDuration(remaining)} · ${totalItems} recurso(s)`;
  }, 500);
}

async function waitForIngestJob(jobId, totalItems) {
  const startedAt = Date.now();
  let lastProcessed = 0;
  let lastAt = startedAt;

  while (true) {
    await sleep(1000);
    const response = await authFetch(`/api/ingest/status/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    const processed = Number(data.processed || 0);
    const total = Number(data.total || totalItems || 0);
    const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    const elapsed = Number(data.elapsedMs || (Date.now() - startedAt));

    const now = Date.now();
    const deltaProcessed = processed - lastProcessed;
    const deltaMs = now - lastAt;
    let remainingText = "calculando...";
    if (deltaProcessed > 0 && deltaMs > 0 && processed < total) {
      const ratePerMs = deltaProcessed / deltaMs;
      const remainingMs = (total - processed) / ratePerMs;
      remainingText = formatDuration(remainingMs);
    } else if (processed >= total) {
      remainingText = "00:00";
    }

    $("driveBar").style.width = `${percent}%`;
    $("driveProgress").textContent = `Subiendo a Google Drive... ${processed}/${total} · ${percent}%`;
    $("driveEta").textContent = `Tiempo transcurrido: ${formatDuration(elapsed)} · Restante estimado: ${remainingText} · Nuevos: ${data.uploaded || 0} · Duplicados: ${data.duplicates || 0} · Fallos: ${data.failed || 0}`;

    lastProcessed = processed;
    lastAt = now;

    if (data.status === "done") return data;
    if (data.status === "failed") throw new Error(data.error || "La subida falló en el servidor.");
  }
}

function stopDriveProgressTracker() {
  if (driveUploadTicker) {
    clearInterval(driveUploadTicker);
    driveUploadTicker = null;
  }
}

function normalizeCollectionName(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim().replace(/[\\/]/g, "-");
  if (!raw) return "";
  const chars = [...raw];
  chars[0] = chars[0].toLocaleUpperCase("es");
  return chars.join("").slice(0, 90);
}

function extension(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const match = path.match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "other";
  } catch {
    return "other";
  }
}

function isVideoExtension(ext) {
  return ["mp4", "m4v", "mov", "webm", "avi", "mkv"].includes(ext);
}

function category(item) {
  if (item.kind === "video" || isVideoExtension(item.extension)) return "VIDEO";
  if (item.extension === "jpg" || item.extension === "jpeg") return "JPG";
  if (item.extension === "png") return "PNG";
  if (item.extension === "gif") return "GIF";
  if (item.extension === "webp") return "WEBP";
  return "OTROS";
}

function resourceKey(item) {
  return item.key || `${item.kind}|${item.url}`;
}

function getSelectedMedia() {
  return media.filter(item => selectedKeys.has(resourceKey(item)));
}

function updateStats() {
  const counters = { JPG: 0, PNG: 0, GIF: 0, WEBP: 0, VIDEO: 0, OTROS: 0 };
  media.forEach(item => counters[category(item)]++);
  $("total").textContent = media.length;
  $("jpg").textContent = counters.JPG;
  $("png").textContent = counters.PNG;
  $("gif").textContent = counters.GIF;
  $("webp").textContent = counters.WEBP;
  $("video").textContent = counters.VIDEO;
  $("other").textContent = counters.OTROS;
  $("stats").classList.remove("hidden");
}

function invalidateAnalysis(message = "La selección cambió. Vuelve a analizar.") {
  analysisReady = false;
  $("metaBar").style.width = "0%";
  $("metaProgress").textContent = media.length ? message : "Esperando paso 2";
  $("metaEta").textContent = "";
  $("metaSummary").classList.add("hidden");
  $("download").disabled = true;
  updateDriveUploadState();
}

function updateSelectionUi({ invalidate = false, syncInput = true } = {}) {
  const selected = getSelectedMedia();
  $("foundCount").textContent = media.length;
  $("selectedCount").textContent = selected.length;
  $("selectionLimit").max = Math.max(0, media.length);
  if (syncInput) $("selectionLimit").value = selected.length;

  const hasMedia = media.length > 0;
  $("selectionLimit").disabled = !hasMedia;
  $("openSelector").disabled = !hasMedia;
  $("metadata").disabled = selected.length === 0 || analyzing;
  $("selectionStatus").innerHTML = selected.length
    ? `<span class="success">✓ ${selected.length} de ${media.length} recursos pasarán al análisis, ZIP y Google Drive.</span>`
    : `<span class="warning">No hay recursos seleccionados.</span>`;

  if (invalidate) invalidateAnalysis();
  updateDriveUploadState();
}

async function saveSelectionSession() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      media,
      selectedKeys: [...selectedKeys],
      selectedCount: selectedKeys.size,
      updatedAt: Date.now()
    }
  });
}

async function applySelectedCount(requested) {
  if (!media.length) return;
  const target = Math.max(0, Math.min(media.length, Math.floor(Number(requested) || 0)));
  const currentOrdered = media.filter(item => selectedKeys.has(resourceKey(item)));
  const next = new Set();

  if (target <= currentOrdered.length) {
    currentOrdered.slice(0, target).forEach(item => next.add(resourceKey(item)));
  } else {
    currentOrdered.forEach(item => next.add(resourceKey(item)));
    for (const item of media) {
      if (next.size >= target) break;
      next.add(resourceKey(item));
    }
  }

  selectedKeys = next;
  await saveSelectionSession();
  updateSelectionUi({ invalidate: true, syncInput: true });
}

$("selectionLimit").addEventListener("input", () => {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => applySelectedCount($("selectionLimit").value), 180);
});

$("selectionLimit").addEventListener("change", () => {
  clearTimeout(selectionTimer);
  applySelectedCount($("selectionLimit").value);
});

$("openSelector").addEventListener("click", async () => {
  if (!media.length) return;
  await saveSelectionSession();
  await chrome.tabs.create({ url: chrome.runtime.getURL("selector.html") });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]?.newValue) return;
  const session = changes[STORAGE_KEY].newValue;
  if (!Array.isArray(session.selectedKeys)) return;
  const next = new Set(session.selectedKeys);
  const changed = next.size !== selectedKeys.size || [...next].some(key => !selectedKeys.has(key));
  selectedKeys = next;
  if (changed) updateSelectionUi({ invalidate: true, syncInput: true });
});

async function syncSelectionFromStorage() {
  if (!media.length) return;
  const session = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!Array.isArray(session?.selectedKeys)) return;
  const next = new Set(session.selectedKeys);
  const changed = next.size !== selectedKeys.size || [...next].some(key => !selectedKeys.has(key));
  selectedKeys = next;
  if (changed) updateSelectionUi({ invalidate: true, syncInput: true });
  else updateSelectionUi({ syncInput: true });
}

window.addEventListener("focus", syncSelectionFromStorage);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncSelectionFromStorage();
});

async function getServerHealth() {
  const response = await fetch(`${API}/api/health`, { cache: "no-store" });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(`SERVER_HTTP:${response.status}`);
  return data;
}

async function requireCompatibleServer() {
  const data = await getServerHealth();
  if (!data.cloud || data.version !== EXPECTED_SERVER_VERSION) {
    throw new Error(`VERSION_MISMATCH:${data.version || "desconocida"}`);
  }
  return data;
}

function explainServerError(error) {
  const message = String(error?.message || error || "");
  if (message.startsWith("VERSION_MISMATCH:")) {
    const version = message.split(":").slice(1).join(":");
    return `El servicio cloud está en versión ${version}. Esta extensión necesita ${EXPECTED_SERVER_VERSION}.`;
  }
  if (message === "AUTH_REQUIRED") return "Conecta tu Google Drive para autorizar esta instalación.";
  if (message === "AUTH_EXPIRED" || message === "AUTH_TIMEOUT") return "La autorización de Google expiró. Pulsa verificar conexión e inténtalo de nuevo.";
  if (message.startsWith("SERVER_HTTP:")) return `El servicio cloud respondió con error ${message.split(":")[1]}.`;
  return "No se pudo contactar Web Media Collector Cloud. Comprueba tu conexión a Internet e inténtalo de nuevo.";
}

async function updateServerStatus() {
  const el = $("serverStatus");
  try {
    const data = await getServerHealth();
    if (data.cloud && data.version === EXPECTED_SERVER_VERSION) {
      el.className = "server-status ok";
      el.textContent = `✓ Web Media Collector Cloud ${data.version} conectado`;
    } else {
      el.className = "server-status warn";
      el.textContent = `⚠ Servicio cloud ${data.version || "desconocido"}. Esta extensión necesita ${EXPECTED_SERVER_VERSION}.`;
    }
  } catch {
    el.className = "server-status warn";
    el.textContent = "⚠ Web Media Collector Cloud no está disponible en este momento.";
  }
}

async function reset() {
  media = [];
  selectedKeys = new Set();
  scanning = false;
  analyzing = false;
  downloading = false;
  uploadingDrive = false;
  analysisReady = false;
  driveVerified = false;
  currentCollectionId = null;
  currentCollectionName = "";
  stopDriveProgressTracker();
  driveUploadStartedAt = 0;

  ["scanBar", "metaBar", "downloadBar"].forEach(id => $(id).style.width = "0%");
  $("scanProgress").textContent = "Esperando";
  $("scanEta").textContent = "";
  $("metaProgress").textContent = "Esperando paso 2";
  $("metaEta").textContent = "";
  $("downloadProgress").textContent = "Esperando paso 3";
  $("downloadEta").textContent = "";
  $("stats").classList.add("hidden");
  $("metaSummary").classList.add("hidden");

  $("metadata").disabled = true;
  $("download").disabled = true;
  $("scan").disabled = false;
  await chrome.storage.local.remove(STORAGE_KEY);
  updateSelectionUi();
  updateServerStatus();
  log("Nueva búsqueda preparada.");
}

$("refresh").addEventListener("click", reset);

/* =========================================================
   PASO 1 - EXTRAER IMÁGENES + CONTENIDO EN MOVIMIENTO
========================================================= */

$("scan").addEventListener("click", async () => {
  if (scanning) return;

  scanning = true;

  $("scan").disabled = true;
  $("metadata").disabled = true;
  $("download").disabled = true;

  media = [];
  selectedKeys = new Set();
  analysisReady = false;
  currentCollectionId = null;

  $("scanBar").style.width = "0%";

  $("scanProgress").textContent =
    "Buscando imágenes y contenido en movimiento...";

  $("scanEta").textContent = "";

  log("Escaneo iniciado.");

  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    let tab = tabs.find(candidate => /^https?:/i.test(candidate.url || ""));

    if (!tab) {
      const activeTabs = await chrome.tabs.query({ active: true });
      tab = activeTabs.find(candidate => /^https?:/i.test(candidate.url || ""));
    }

    if (!tab?.id) {
      throw new Error("No se encontró una página web activa para escanear.");
    }

    const injection = await chrome.scripting.executeScript({
        target: { tabId: tab.id },

        func: () => {
          const results = [];
          const seen = new Map();

          function getContext(element) {
            let pinUrl = "";
            let contextText = "";
            let current = element;

            for (let depth = 0; depth < 7 && current; depth++) {
              const link = current.matches?.('a[href*="/pin/"]')
                ? current
                : current.querySelector?.('a[href*="/pin/"]');

              if (link && !pinUrl) {
                try { pinUrl = new URL(link.getAttribute("href"), location.href).href; } catch {}
              }

              if (!contextText) {
                const candidate = (current.innerText || "").replace(/\s+/g, " ").trim();
                if (candidate.length >= 3 && candidate.length <= 500) contextText = candidate;
              }
              current = current.parentElement;
            }

            return {
              alt: element?.getAttribute?.("alt") || "",
              title: element?.getAttribute?.("title") || "",
              aria: element?.getAttribute?.("aria-label") || "",
              context: contextText,
              pinUrl
            };
          }

          function looksLikeVideo(value) {
            if (!value) return false;
            return (
              /\.(mp4|m4v|mov|webm)(?:$|\?|#)/i.test(value) ||
              /\/videos?\//i.test(value) ||
              /video[_/-]/i.test(value)
            );
          }

          function looksLikeGif(value) {
            if (!value) return false;
            return /\.gif(?:$|\?|#)/i.test(value);
          }

          function logicalKey(url, kind) {
            const keyUrl = new URL(url.href);
            keyUrl.hash = "";
            if (kind === "image" && keyUrl.hostname === "i.pinimg.com") {
              keyUrl.pathname = keyUrl.pathname.replace(
                /^\/(?:1200x|736x|564x|474x|236x)\//i,
                "/__pinterest_size__/"
              );
              keyUrl.search = "";
            }
            return `${kind}|${keyUrl.href}`;
          }

          function pinterestOriginalCandidate(url) {
            try {
              const candidate = new URL(url.href);
              const next = candidate.pathname.replace(
                /^\/(?:1200x|736x|564x|474x|236x)\//i,
                "/originals/"
              );
              if (next === candidate.pathname) return "";
              candidate.pathname = next;
              return candidate.href;
            } catch {
              return "";
            }
          }

          function previewFor(kind, element, url) {
            if (kind !== "video") return url.href;
            const poster = element?.poster || element?.getAttribute?.("poster") || "";
            if (poster) {
              try { return new URL(poster, location.href).href; } catch {}
            }
            if (element?.tagName === "IMG") return element.currentSrc || element.src || url.href;
            return url.href;
          }

          function add(raw, kind, element, detectedBy) {
            if (!raw) return;

            try {
              const url = new URL(raw, location.href);
              if (url.protocol !== "http:" && url.protocol !== "https:") return;

              if (
                url.hostname === "i.pinimg.com" &&
                /(?:30x30|60x60|75x75)/i.test(url.pathname)
              ) return;

              const key = logicalKey(url, kind);
              const originalCandidate = kind === "image" && url.hostname === "i.pinimg.com"
                ? pinterestOriginalCandidate(url)
                : "";
              const previewUrl = previewFor(kind, element, url);
              const posterUrl = kind === "video" && previewUrl !== url.href ? previewUrl : "";

              if (seen.has(key)) {
                const existing = seen.get(key);
                existing.alternateUrls ||= [];
                for (const candidate of [url.href, originalCandidate]) {
                  if (candidate && candidate !== existing.url && !existing.alternateUrls.includes(candidate)) {
                    existing.alternateUrls.push(candidate);
                  }
                }
                if (!existing.previewUrl && previewUrl) existing.previewUrl = previewUrl;
                if (!existing.posterUrl && posterUrl) existing.posterUrl = posterUrl;
                const ctx = getContext(element);
                for (const field of ["alt","title","aria","context","pinUrl"]) {
                  if (!existing[field] && ctx[field]) existing[field] = ctx[field];
                }
                return;
              }

              const entry = {
                url: url.href,
                alternateUrls: originalCandidate && originalCandidate !== url.href ? [originalCandidate] : [],
                previewUrl,
                posterUrl,
                kind,
                detectedBy,
                pageUrl: location.href,
                domWidth: element?.naturalWidth || element?.videoWidth || element?.width || null,
                domHeight: element?.naturalHeight || element?.videoHeight || element?.height || null,
                ...getContext(element)
              };
              seen.set(key, entry);
              results.push(entry);
            } catch {}
          }

          /* -------------------------
             IMÁGENES
          ------------------------- */

          document
            .querySelectorAll("img")
            .forEach(img => {
              add(
                img.currentSrc,
                "image",
                img,
                "IMG_CURRENT"
              );

              add(
                img.src,
                "image",
                img,
                "IMG_SRC"
              );

              if (img.srcset) {
                img.srcset
                  .split(",")
                  .forEach(entry => {
                    add(
                      entry.trim().split(/\s+/)[0],
                      "image",
                      img,
                      "IMG_SRCSET"
                    );
                  });
              }

              /*
                Algunos componentes almacenan
                contenido animado en atributos.
              */

              [
                "data-src",
                "data-original",
                "data-video-src",
                "data-video-url",
                "data-media-url"
              ].forEach(attribute => {
                const value =
                  img.getAttribute(attribute);

                if (looksLikeVideo(value)) {
                  add(
                    value,
                    "video",
                    img,
                    `IMG_${attribute}`
                  );
                }

                if (looksLikeGif(value)) {
                  add(
                    value,
                    "image",
                    img,
                    `IMG_${attribute}`
                  );
                }
              });
            });


          /* -------------------------
             VIDEO HTML5
          ------------------------- */

          document
            .querySelectorAll("video")
            .forEach(video => {
              add(
                video.currentSrc,
                "video",
                video,
                "VIDEO_CURRENT"
              );

              add(
                video.src,
                "video",
                video,
                "VIDEO_SRC"
              );

              const poster =
                video.getAttribute("poster");

              if (poster) {
                add(
                  poster,
                  "image",
                  video,
                  "VIDEO_POSTER"
                );
              }

              video
                .querySelectorAll("source")
                .forEach(source => {
                  add(
                    source.src,
                    "video",
                    video,
                    "VIDEO_SOURCE"
                  );

                  if (source.srcset) {
                    source.srcset
                      .split(",")
                      .forEach(entry => {
                        add(
                          entry
                            .trim()
                            .split(/\s+/)[0],

                          "video",
                          video,
                          "VIDEO_SOURCESET"
                        );
                      });
                  }
                });
            });


          /* -------------------------
             SOURCE / PICTURE
          ------------------------- */

          document
            .querySelectorAll("source")
            .forEach(source => {
              const type =
                (
                  source.getAttribute("type") ||
                  ""
                ).toLowerCase();

              const src =
                source.src ||
                source.getAttribute("src") ||
                "";

              const video =
                type.startsWith("video/") ||
                looksLikeVideo(src);

              if (src) {
                add(
                  src,
                  video ? "video" : "image",
                  source,
                  "SOURCE"
                );
              }

              if (source.srcset) {
                source.srcset
                  .split(",")
                  .forEach(entry => {
                    const candidate =
                      entry
                        .trim()
                        .split(/\s+/)[0];

                    add(
                      candidate,
                      looksLikeVideo(candidate)
                        ? "video"
                        : "image",
                      source,
                      "SOURCE_SRCSET"
                    );
                  });
              }
            });


          /* -------------------------
             ATRIBUTOS DEL DOM
          ------------------------- */

          const attributes = [
            "src",
            "href",
            "content",
            "data-src",
            "data-original",
            "data-video-src",
            "data-video-url",
            "data-media-url",
            "data-pin-media"
          ];

          document
            .querySelectorAll("*")
            .forEach(element => {
              attributes.forEach(attribute => {
                const value =
                  element.getAttribute?.(attribute);

                if (!value) return;

                if (looksLikeVideo(value)) {
                  add(
                    value,
                    "video",
                    element,
                    `ATTRIBUTE_${attribute}`
                  );
                } else if (looksLikeGif(value)) {
                  add(
                    value,
                    "image",
                    element,
                    `ATTRIBUTE_${attribute}`
                  );
                }
              });
            });


          /* -------------------------
             META TAGS
          ------------------------- */

          document
            .querySelectorAll(
              'meta[property], meta[name]'
            )
            .forEach(meta => {
              const property =
                (
                  meta.getAttribute("property") ||
                  meta.getAttribute("name") ||
                  ""
                ).toLowerCase();

              const content =
                meta.getAttribute("content");

              if (!content) return;

              if (
                property.includes("video") ||
                looksLikeVideo(content)
              ) {
                add(
                  content,
                  "video",
                  meta,
                  `META_${property}`
                );
              }
            });


          /* -------------------------
             RECURSOS YA CARGADOS

             Aquí intentamos encontrar videos
             solicitados por Pinterest aunque
             no permanezcan como <video>.
          ------------------------- */

          performance
            .getEntriesByType("resource")
            .forEach(entry => {
              const resourceUrl =
                entry.name || "";

              if (looksLikeVideo(resourceUrl)) {
                add(
                  resourceUrl,
                  "video",
                  document.body,
                  "NETWORK_RESOURCE"
                );
              } else if (
                looksLikeGif(resourceUrl)
              ) {
                add(
                  resourceUrl,
                  "image",
                  document.body,
                  "NETWORK_GIF"
                );
              }
            });


          /*
            También revisamos HTML serializado
            buscando URLs MP4/M4V/WebM que estén
            embebidas en datos de la página.
          */

          try {
            const html =
              document.documentElement.innerHTML;

            const matches =
              html.match(
                /https?:[^"'\\\s<>]+?\.(?:mp4|m4v|webm)(?:\?[^"'\\\s<>]*)?/gi
              ) || [];

            matches.forEach(raw => {
              const decoded =
                raw
                  .replace(/&amp;/g, "&")
                  .replace(/\\u002F/gi, "/")
                  .replace(/\\\//g, "/");

              add(
                decoded,
                "video",
                document.body,
                "HTML_EMBEDDED"
              );
            });
          } catch {}


          return results;
        }
      });

    const result = injection?.[0]?.result;
    const incoming = Array.isArray(result) ? result : [];
    const start = Date.now();

    for (
      let index = 0;
      index < incoming.length;
      index++
    ) {
      const item = incoming[index];

      item.extension =
        extension(item.url);

      if (
        isVideoExtension(item.extension)
      ) {
        item.kind = "video";
      }

      item.key = resourceKey(item);
      media.push(item);

      progress(
        "scanBar",
        "scanProgress",
        index + 1,
        incoming.length,
        start,
        "scanEta"
      );

      if (index % 15 === 0) {
        await sleep(10);
      }
    }

    updateStats();

    $("scanBar").style.width = "100%";

    const videos =
      media.filter(
        item => category(item) === "VIDEO"
      ).length;

    const gifs =
      media.filter(
        item => category(item) === "GIF"
      ).length;

    $("scanProgress").innerHTML =
      `<span class="success">✓ ${media.length} recursos únicos · ${videos} video/movimiento · ${gifs} GIF</span>`;

    selectedKeys = new Set(media.map(resourceKey));
    $("selectionLimit").value = media.length;
    await saveSelectionSession();
    updateSelectionUi();

    $("metadata").disabled = media.length === 0;
    openAccordion("selectionCard");

    log(
      `Escaneo terminado. Total: ${media.length}. ` +
      `Video/movimiento: ${videos}. GIF: ${gifs}.`
    );
  } catch (error) {
    console.error(error);

    const message = String(error?.message || error || "Error desconocido");
    $("scanProgress").textContent = "Error durante el escaneo.";
    $("scanEta").textContent = message;
    log("ERROR de escaneo: " + message);
  } finally {
    scanning = false;
    $("scan").disabled = false;
  }
});




/* =========================================================
   PASO 3 - INFORMACIÓN / NOMBRES + METADATOS PROFUNDOS
========================================================= */

function preliminaryCandidate(item, index) {
  const choices = [
    { source: "TITLE", value: item.title },
    { source: "ALT", value: item.alt },
    { source: "ARIA", value: item.aria },
    { source: "CONTEXTO", value: item.context }
  ];
  const selected = choices.find(c => c.value && c.value.trim().length >= 3);
  let fallback = "";
  try { fallback = new URL(item.url).pathname.split("/").pop().replace(/\.[^.]+$/, ""); } catch {}
  const value = selected?.value || fallback || `recurso-${String(index + 1).padStart(2, "0")}`;
  return { suggestedName: cleanName(value), nameSource: selected?.source || "IDENTIFICADOR" };
}

function chooseBestName(item, index) {
  const summary = item.embeddedMetadata?.summary || {};
  const camera = [summary.cameraMake, summary.cameraModel].filter(Boolean).join(" ").trim();
  const candidates = [
    { source: "METADATA_TITLE", value: summary.title },
    { source: "TITLE", value: item.title },
    { source: "CITY", value: summary.city },
    { source: "COUNTRY", value: summary.country },
    { source: "CAMERA", value: camera },
    { source: "DATE_TAKEN", value: summary.dateTaken },
    { source: "METADATA_DESCRIPTION", value: summary.description },
    { source: "ALT", value: item.alt },
    { source: "ARIA", value: item.aria },
    { source: "CONTEXTO", value: item.context }
  ];

  const selected = candidates.find(c => c.value && String(c.value).trim().length >= 2);
  if (selected) return { suggestedName: cleanName(String(selected.value)), nameSource: selected.source };

  let original = "";
  try { original = new URL(item.url).pathname.split("/").pop().replace(/\.[^.]+$/, ""); } catch {}
  return {
    suggestedName: cleanName(original) || `recurso-${String(index + 1).padStart(2, "0")}`,
    nameSource: "IDENTIFICADOR"
  };
}

function buildMetadata(item) {
  const embedded = item.embeddedMetadata || {};
  const summary = embedded.summary || {};
  const technical = item.technical || {};
  return {
    mediaType: item.kind,
    format: technical.extension || item.extension,
    identification: {
      suggestedName: item.suggestedName,
      source: item.nameSource
    },
    source: {
      directUrl: item.url,
      pinUrl: item.pinUrl || null,
      pageUrl: item.sourcePage || item.pageUrl || null,
      detectedBy: item.detectedBy || null,
      title: item.title || null,
      alt: item.alt || null,
      aria: item.aria || null,
      context: item.context || null
    },
    technical: {
      mimeType: technical.mimeType || null,
      bytes: technical.bytes || null,
      sha256: technical.sha256 || null,
      width: summary.width || null,
      height: summary.height || null,
      animated: summary.animated || false,
      frameCount: summary.frameCount || null
    },
    exif: {
      dateTaken: summary.dateTaken || null,
      cameraMake: summary.cameraMake || null,
      cameraModel: summary.cameraModel || null,
      lensMake: summary.lensMake || null,
      lensModel: summary.lensModel || null,
      software: summary.software || null,
      iso: summary.iso ?? null,
      aperture: summary.aperture ?? null,
      exposure: summary.exposure ?? null,
      focalLength: summary.focalLength ?? null,
      focalLength35mm: summary.focalLength35mm ?? null,
      orientation: summary.orientation ?? null,
      copyright: summary.copyright || null
    },
    location: {
      latitude: summary.latitude ?? null,
      longitude: summary.longitude ?? null,
      city: summary.city || null,
      country: summary.country || null,
      locationName: summary.locationName || null
    },
    descriptive: {
      title: summary.title || null,
      description: summary.description || null,
      creator: summary.creator || null,
      keywords: summary.keywords || []
    },
    embedded: embedded.parsed || {},
    embeddedParser: embedded.parser || "none"
  };
}

function apiCandidate(item) {
  return {
    url: item.url,
    alternateUrls: Array.isArray(item.alternateUrls) ? item.alternateUrls : [],
    previewUrl: item.previewUrl || "",
    posterUrl: item.posterUrl || "",
    pinUrl: item.pinUrl || "",
    kind: item.kind,
    extension: item.extension,
    suggestedName: item.suggestedName || "",
    metadata: item.metadata || {},
    sourcePage: item.sourcePage || item.pageUrl || ""
  };
}

$("metadata").addEventListener("click", async () => {
  const selected = getSelectedMedia();
  if (analyzing || !selected.length) return;

  analyzing = true;
  analysisReady = false;
  $("metadata").disabled = true;
  $("download").disabled = true;
  $("metaBar").style.width = "3%";
  $("metaProgress").textContent = `Preparando ${selected.length} recursos...`;
  $("metaEta").textContent = "Leyendo archivo + EXIF/XMP/IPTC cuando estén disponibles";

  selected.forEach((item, index) => Object.assign(item, preliminaryCandidate(item, index)));

  try {
    await requireCompatibleServer();

    $("metaBar").style.width = "10%";
    $("metaProgress").textContent = `Extrayendo metadatos de ${selected.length} recursos...`;

    const response = await fetch(`${API}/api/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidates: selected.map(apiCandidate) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    let descriptive = 0;
    let generic = 0;
    let deep = 0;
    let withGps = 0;
    let withCamera = 0;

    for (let index = 0; index < selected.length; index++) {
      const item = selected[index];
      const result = data.results?.[index];

      if (result?.ok) {
        item.technical = result.technical || {};
        item.embeddedMetadata = result.embedded || {};
        deep++;
      } else {
        item.technical = item.technical || {};
        item.embeddedMetadata = item.embeddedMetadata || { parser: "none", parsed: {}, summary: {} };
      }

      Object.assign(item, chooseBestName(item, index));
      item.metadata = buildMetadata(item);
      if (item.nameSource === "IDENTIFICADOR") generic++; else descriptive++;
      if (item.metadata.location.latitude != null && item.metadata.location.longitude != null) withGps++;
      if (item.metadata.exif.cameraMake || item.metadata.exif.cameraModel) withCamera++;

      progress("metaBar", "metaProgress", index + 1, selected.length, Date.now() - Math.max(1, index + 1) * 50, "metaEta");
      if (index % 20 === 0) await sleep(5);
    }

    $("metaBar").style.width = "100%";
    $("metaProgress").innerHTML = '<span class="success">✓ Información y metadatos analizados</span>';
    $("metaSummary").innerHTML =
      `<strong>${selected.length} recursos seleccionados</strong><br>` +
      `Metadatos de archivo leídos: ${deep}<br>` +
      `Con nombre descriptivo: ${descriptive}<br>` +
      `Con identificador genérico: ${generic}<br>` +
      `Con cámara detectada: ${withCamera}<br>` +
      `Con coordenadas GPS embebidas: ${withGps}<br>` +
      `Fallos de lectura profunda: ${data.failed || 0}`;
    $("metaSummary").classList.remove("hidden");

    analysisReady = true;
    $("download").disabled = false;
    $("metadata").disabled = false;
    await saveSelectionSession();
    updateDriveUploadState();
    log(`Análisis terminado para ${selected.length} recursos. Metadatos profundos: ${deep}.`);
  } catch (error) {
    $("metaBar").style.width = "0%";
    $("metaProgress").innerHTML = `<span class="warning">No se pudo iniciar/completar el análisis.</span>`;
    $("metaEta").textContent = explainServerError(error);
    updateServerStatus();
    log(`ERROR metadatos: ${error.message}`);
  } finally {
    analyzing = false;
    updateSelectionUi();
  }
});


/* =========================================================
   PASO 4 - DESCARGA EN UN SOLO ZIP
========================================================= */

$("download").addEventListener("click", async () => {
  const selected = getSelectedMedia();
  if (downloading || !selected.length || !analysisReady) return;

  downloading = true;
  $("download").disabled = true;
  $("downloadBar").style.width = "8%";
  $("downloadProgress").textContent = `Preparando ZIP con ${selected.length} recursos...`;
  $("downloadEta").textContent = "El servidor local descargará los archivos y construirá un único ZIP.";

  try {
    await requireCompatibleServer();
    const response = await fetch(`${API}/api/zip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidates: selected.map(apiCandidate) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    $("downloadBar").style.width = "92%";
    $("downloadProgress").textContent = "ZIP creado. Iniciando una sola descarga...";

    await chrome.tabs.create({ url: data.downloadUrl });

    $("downloadBar").style.width = "100%";
    $("downloadProgress").innerHTML = `<span class="success">✓ ZIP preparado: ${data.successful} archivos · ${data.failed} fallos</span>`;
    $("downloadEta").textContent = "Incluye inventario.json con URLs, SHA-256 y metadatos recopilados.";
    log(`ZIP generado para ${selected.length} recursos. Correctos: ${data.successful}; fallos: ${data.failed}.`);
  } catch (error) {
    $("downloadBar").style.width = "0%";
    $("downloadProgress").innerHTML = '<span class="warning">No se pudo generar el ZIP.</span>';
    $("downloadEta").textContent = explainServerError(error);
    updateServerStatus();
    log(`ERROR ZIP: ${error.message}`);
  } finally {
    downloading = false;
    $("download").disabled = !analysisReady;
  }
});


function updateDriveUploadState() {}

updateSelectionUi();
updateServerStatus();

function openAccordion(id) {
  const target = document.getElementById(id);
  if (!target) return;
  document.querySelectorAll("details.accordion").forEach(card => {
    card.open = card === target;
  });
  target.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.querySelectorAll("details.accordion").forEach(card => {
  card.addEventListener("toggle", () => {
    if (!card.open) return;
    document.querySelectorAll("details.accordion").forEach(other => {
      if (other !== card) other.open = false;
    });
  });
});
