const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const crypto = require("node:crypto");
const { URL, URLSearchParams } = require("node:url");
const { pipeline } = require("node:stream/promises");
const {
  VERSION: MEDIA_VERSION,
  canonicalizeUrl,
  cleanName,
  normalizeCollectionName,
  extFrom,
  category,
  downloadAndHash,
  extractEmbeddedMetadata,
  mergeMetadata,
  analyzeOne,
  buildZip,
} = require("./media");

const VERSION = "4.2.0";
const PORT = Number(process.env.PORT || 8787);
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const DB_FUNCTION_URL = process.env.WMC_DB_FUNCTION_URL || "";
const DB_BACKEND_KEY = process.env.WMC_DB_BACKEND_KEY || "";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 90);
const ZIP_TTL_MS = 30 * 60 * 1000;
const INGEST_JOB_TTL_MS = 60 * 60 * 1000;
const zipDownloads = new Map();
const ingestJobs = new Map();
const accessTokenCache = new Map();

const DRIVE_TREE = {
  JPG: { name: "JPG", field: "jpg_folder_id" },
  PNG: { name: "PNG", field: "png_folder_id" },
  GIF: { name: "GIF", field: "gif_folder_id" },
  WEBP: { name: "WEBP", field: "webp_folder_id" },
  VIDEO: { name: "VIDEO", field: "video_folder_id" },
  THUMBNAILS: { name: "THUMBNAILS", field: "thumbnails_folder_id" },
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function json(res, status, body) {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function signState(payload) {
  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET || "")
    .update(raw)
    .digest("base64url");
  return `${raw}.${sig}`;
}

function verifyState(value) {
  const [raw, sig] = String(value || "").split(".");
  if (!raw || !sig) throw new Error("Estado OAuth inválido");
  const expected = crypto.createHmac("sha256", process.env.SESSION_SECRET || "")
    .update(raw)
    .digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error("Firma OAuth inválida");
  }
  const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  if (!parsed?.e || Number(parsed.e) < Date.now()) throw new Error("Estado OAuth expirado");
  return parsed;
}

function encryptSecret(value) {
  const rawKey = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || "", "base64");
  if (rawKey.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY inválida");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", rawKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function db(action, payload = {}) {
  if (!DB_FUNCTION_URL || !DB_BACKEND_KEY) throw new Error("Base de datos cloud no configurada");
  const response = await fetch(DB_FUNCTION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wmc-key": DB_BACKEND_KEY,
    },
    body: JSON.stringify({ action, payload }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `DB HTTP ${response.status}`);
  }
  return data;
}

async function requireSession(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  const result = await db("get_session", { token_hash: sha256(token) });
  if (!result?.session || !result?.user) return null;
  return { token, session: result.session, user: result.user };
}

function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && APP_BASE_URL);
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: `${APP_BASE_URL}/auth/google/callback`,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error_description || data?.error || "No se pudo intercambiar el código OAuth");
  return data;
}

async function fetchGoogleUser(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "No se pudo obtener el perfil de Google");
  return data;
}


function decryptSecret(value) {
  const [version, ivB64, tagB64, dataB64] = String(value || "").split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("Refresh token cifrado inválido");
  const rawKey = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || "", "base64");
  if (rawKey.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY inválida");
  const decipher = crypto.createDecipheriv("aes-256-gcm", rawKey, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}

async function accessTokenForUser(userId) {
  const cached = accessTokenCache.get(userId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const result = await db("get_drive_account", { user_id: userId });
  if (!result?.drive?.refresh_token_enc) throw new Error("Google Drive no está conectado para este usuario");
  const refreshToken = decryptSecret(result.drive.refresh_token_enc);
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(data?.error_description || data?.error || "No se pudo renovar el acceso a Google Drive");
  const expiresIn = Math.max(300, Number(data.expires_in || 3600));
  accessTokenCache.set(userId, { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 });
  return data.access_token;
}

async function driveJson(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Drive HTTP ${response.status}: ${text.slice(0, 1000)}`);
  return data;
}

function driveQueryEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findDriveFolder(token, parentId, name) {
  const q = `'${driveQueryEscape(parentId)}' in parents and name = '${driveQueryEscape(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType,parents)", pageSize: "100" });
  const data = await driveJson(token, `https://www.googleapis.com/drive/v3/files?${params.toString()}`);
  return (data.files || [])[0] || null;
}

async function createDriveFolder(token, parentId, name) {
  return driveJson(token, "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,parents", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
}

async function ensureChildFolder(token, parentId, name) {
  return (await findDriveFolder(token, parentId, name)) || createDriveFolder(token, parentId, name);
}

async function ensureUserDriveFolders(userId, token) {
  const cached = await db("get_user_drive_folders", { user_id: userId });
  let row = cached?.folders || { user_id: userId };
  if (!row.root_folder_id) {
    const root = await ensureChildFolder(token, "root", "Web Media Collection");
    row.root_folder_id = root.id;
  }
  for (const item of Object.values(DRIVE_TREE)) {
    if (!row[item.field]) {
      const folder = await ensureChildFolder(token, row.root_folder_id, item.name);
      row[item.field] = folder.id;
    }
  }
  const saved = await db("put_user_drive_folders", {
    user_id: userId,
    root_folder_id: row.root_folder_id,
    jpg_folder_id: row.jpg_folder_id,
    png_folder_id: row.png_folder_id,
    gif_folder_id: row.gif_folder_id,
    webp_folder_id: row.webp_folder_id,
    video_folder_id: row.video_folder_id,
    thumbnails_folder_id: row.thumbnails_folder_id,
  });
  return saved.folders;
}

async function verifyDriveConnection(userId) {
  const token = await accessTokenForUser(userId);
  const folders = await ensureUserDriveFolders(userId, token);
  const root = await driveJson(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folders.root_folder_id)}?fields=id,name,mimeType,webViewLink`);
  return { root, folders };
}

async function createDriveShortcut(token, parentId, name, targetId) {
  return driveJson(token, "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,shortcutDetails", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.shortcut",
      parents: [parentId],
      shortcutDetails: { targetId },
    }),
  });
}

async function uploadToDrive(token, tempPath, name, mime, folderId) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ name, parents: [folderId] })], { type: "application/json; charset=UTF-8" }));
  const fileBlob = await fs.openAsBlob(tempPath, { type: mime || "application/octet-stream" });
  form.append("file", fileBlob, name);
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Drive HTTP ${response.status}: ${text.slice(0, 1000)}`);
  return JSON.parse(text);
}

function compactCollectionId(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^([A-Za-z]+)-0*(\d+)$/);
  if (!match) return raw || "WMC-1";
  return `${match[1].toUpperCase()}-${Number(match[2])}`;
}

function collectionFolderLabel(collection) {
  return `${compactCollectionId(collection.public_id)} - ${collection.name}`;
}

async function ensureCollectionFolder(collection, cat, token, userFolders) {
  const existing = await db("get_collection_drive_folder", { collection_id: collection.id, category: cat });
  if (existing?.folder?.drive_folder_id) return existing.folder.drive_folder_id;
  const parentField = DRIVE_TREE[cat]?.field;
  const parentId = parentField ? userFolders[parentField] : null;
  if (!parentId) throw new Error(`No existe carpeta base para ${cat}`);
  const label = collectionFolderLabel(collection);
  const folder = await ensureChildFolder(token, parentId, label);
  await db("put_collection_drive_folder", { collection_id: collection.id, category: cat, drive_folder_id: folder.id });
  return folder.id;
}

async function resolveCollection(userId, name, categories, requestedId, token, userFolders) {
  const normalized = normalizeCollectionName(name);
  if (!normalized) throw new Error("Debes escribir un nombre para la colección antes de subir.");
  let collection = null;
  if (requestedId) {
    const got = await db("get_collection", { user_id: userId, public_id: requestedId });
    collection = got?.collection || null;
    if (!collection) throw new Error(`No existe la colección ${requestedId} para este usuario.`);
    if (collection.name !== normalized) throw new Error(`El ID ${collection.public_id} pertenece a la colección “${collection.name}”.`);
  } else {
    const created = await db("create_collection", { user_id: userId, name: normalized });
    collection = created.collection;
  }
  for (const cat of [...new Set(categories)].filter(x => DRIVE_TREE[x])) {
    await ensureCollectionFolder(collection, cat, token, userFolders);
  }
  return collection;
}

function safeDate(value) {
  if (!value) return null;
  const s = String(value).replace(/^(\d{4}):(\d{2}):(\d{2})\s/, "$1-$2-$3T");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function addSourceForAsset(userId, assetId, canonical, item) {
  const sourceMeta = item?.metadata?.source || {};
  await db("add_asset_source", {
    user_id: userId,
    asset_id: assetId,
    source_url: item.url || canonical,
    canonical_url: canonical,
    source_page: item.sourcePage || sourceMeta.pageUrl || null,
    title: sourceMeta.title || null,
    alt_text: sourceMeta.alt || null,
    context_text: sourceMeta.context || null,
  });
}

async function addMembership(collectionId, assetId) {
  await db("add_collection_asset", { collection_id: collectionId, asset_id: assetId });
}

async function shortcutDuplicate(token, collection, cat, asset, userFolders) {
  if (!asset?.drive_file_id || !DRIVE_TREE[cat]) return;
  const folderId = await ensureCollectionFolder(collection, cat, token, userFolders);
  const name = asset.filename || asset.human_id || "duplicado";
  try { await createDriveShortcut(token, folderId, name, asset.drive_file_id); }
  catch (error) { console.warn("No se pudo crear acceso directo para duplicado:", error.message); }
}

async function ingestOne(item, ctx) {
  const { userId, token, collection, userFolders } = ctx;
  const canonical = canonicalizeUrl(item.url);
  const bySource = await db("find_asset_by_source", { user_id: userId, canonical_url: canonical });
  if (bySource?.asset) {
    await addMembership(collection.id, bySource.asset.id);
    await addSourceForAsset(userId, bySource.asset.id, canonical, item);
    const oldCat = bySource.asset.media_type === "video" ? "VIDEO" : String(bySource.asset.format || "").toUpperCase();
    await shortcutDuplicate(token, collection, oldCat, bySource.asset, userFolders);
    return { status: "duplicate", reason: "url", assetId: bySource.asset.human_id, collectionId: collection.public_id };
  }

  const dl = await downloadAndHash(canonical, item.alternateUrls || [], item.sourcePage || "");
  let reserved = null;
  try {
    const ext = extFrom(dl.finalUrl || canonical, dl.mime, item.extension);
    const cat = category(ext, dl.mime, item.kind);
    if (!DRIVE_TREE[cat]) throw new Error(`Formato no soportado para Drive: ${ext}`);

    const byHash = await db("find_asset_by_sha", { user_id: userId, sha256: dl.sha256 });
    if (byHash?.asset) {
      await addSourceForAsset(userId, byHash.asset.id, canonical, item);
      await addMembership(collection.id, byHash.asset.id);
      await shortcutDuplicate(token, collection, cat, byHash.asset, userFolders);
      return { status: "duplicate", reason: "sha256", assetId: byHash.asset.human_id, collectionId: collection.public_id };
    }

    const embedded = await extractEmbeddedMetadata(dl.temp, dl.mime, ext);
    const technical = {
      sha256: dl.sha256,
      bytes: dl.bytes,
      mimeType: dl.mime,
      extension: ext,
      category: cat,
      width: embedded.summary?.width || null,
      height: embedded.summary?.height || null,
      animated: embedded.summary?.animated || false,
      frameCount: embedded.summary?.frameCount || null,
    };
    const merged = mergeMetadata(item.metadata, embedded, technical);
    const base = cleanName(item.suggestedName) || "recurso";
    const create = await db("create_asset", {
      user_id: userId,
      sha256: dl.sha256,
      media_type: item.kind === "video" || cat === "VIDEO" ? "video" : "image",
      format: ext,
      mime_type: dl.mime,
      display_name: base,
      byte_size: dl.bytes,
      width: technical.width,
      height: technical.height,
      captured_at: safeDate(embedded.summary?.dateTaken),
      camera_make: embedded.summary?.cameraMake || null,
      camera_model: embedded.summary?.cameraModel || null,
      software: embedded.summary?.software || null,
      iso: numberOrNull(embedded.summary?.iso),
      exposure_time: embedded.summary?.exposure != null ? String(embedded.summary.exposure) : null,
      aperture: numberOrNull(embedded.summary?.aperture),
      focal_length: numberOrNull(embedded.summary?.focalLength),
      latitude: numberOrNull(embedded.summary?.latitude),
      longitude: numberOrNull(embedded.summary?.longitude),
      city: embedded.summary?.city || null,
      country: embedded.summary?.country || null,
      description: embedded.summary?.description || null,
      metadata_json: merged,
    });
    reserved = create.asset;
    const filename = `${reserved.human_id} - ${base}.${ext}`;
    const folderId = await ensureCollectionFolder(collection, cat, token, userFolders);
    const drive = await uploadToDrive(token, dl.temp, filename, dl.mime, folderId);
    const updated = await db("update_asset_drive", {
      user_id: userId,
      asset_id: reserved.id,
      filename,
      drive_file_id: drive.id,
    });
    await addSourceForAsset(userId, reserved.id, canonical, item);
    await addMembership(collection.id, reserved.id);
    return {
      status: "uploaded",
      assetId: updated.asset.human_id,
      driveFileId: drive.id,
      filename,
      collectionId: collection.public_id,
    };
  } catch (error) {
    if (reserved?.id && !reserved?.drive_file_id) {
      await db("delete_asset", { user_id: userId, asset_id: reserved.id }).catch(() => {});
    }
    throw error;
  } finally {
    await fsp.unlink(dl.temp).catch(() => {});
  }
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => run());
  await Promise.all(workers);
  return results;
}


function scheduleIngestJobCleanup(jobId) {
  setTimeout(() => ingestJobs.delete(jobId), INGEST_JOB_TTL_MS).unref?.();
}

async function runIngestJob(job, candidates, ctx) {
  try {
    job.status = "running";
    job.startedAt = Date.now();
    job.updatedAt = Date.now();
    await mapConcurrent(candidates, 6, async (item, index) => {
      let result;
      try {
        result = { url: item.url, ...(await ingestOne(item, ctx)) };
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        console.error("Fallo ingest:", item.url, message);
        result = { url: item.url, status: "failed", error: message };
      }
      job.results[index] = result;
      job.processed += 1;
      if (result.status === "uploaded") job.uploaded += 1;
      else if (result.status === "duplicate") job.duplicates += 1;
      else if (result.status === "failed") job.failed += 1;
      job.updatedAt = Date.now();
      return result;
    });
    job.status = "done";
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    cors(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        service: "Web Media Collector Cloud",
        version: VERSION,
        mediaEngineVersion: MEDIA_VERSION,
        cloud: true,
        databaseConfigured: Boolean(DB_FUNCTION_URL && DB_BACKEND_KEY),
        googleOAuthConfigured: googleConfigured(),
        oauthChecks: {
          appBaseUrl: Boolean(APP_BASE_URL),
          googleClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
          googleClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
        },
        now: new Date().toISOString(),
      });
    }

    // Browser-friendly OAuth smoke test. The extension uses the device flow below.
    if (req.method === "GET" && url.pathname === "/auth/google") {
      if (!googleConfigured()) return html(res, 503, "<h1>Google OAuth no está configurado.</h1>");
      const deviceId = crypto.randomUUID();
      const deviceSecret = randomToken(24);
      const expiresAtMs = Date.now() + 10 * 60 * 1000;
      await db("create_device_auth", {
        device_id: deviceId,
        secret_hash: sha256(deviceSecret),
        expires_at: new Date(expiresAtMs).toISOString(),
      });
      const state = signState({ d: deviceId, s: deviceSecret, e: expiresAtMs });
      res.statusCode = 302;
      res.setHeader("Location", `${APP_BASE_URL}/auth/google/start?state=${encodeURIComponent(state)}`);
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/api/auth/device/start") {
      if (!googleConfigured()) {
        return json(res, 503, {
          ok: false,
          code: "GOOGLE_OAUTH_NOT_CONFIGURED",
          message: "Google OAuth web credentials are not configured yet.",
        });
      }
      const deviceId = crypto.randomUUID();
      const deviceSecret = randomToken(24);
      const expiresAtMs = Date.now() + 10 * 60 * 1000;
      await db("create_device_auth", {
        device_id: deviceId,
        secret_hash: sha256(deviceSecret),
        expires_at: new Date(expiresAtMs).toISOString(),
      });

      const state = signState({ d: deviceId, s: deviceSecret, e: expiresAtMs });
      return json(res, 200, {
        ok: true,
        device_id: deviceId,
        device_secret: deviceSecret,
        expires_in: 600,
        login_url: `${APP_BASE_URL}/auth/google/start?state=${encodeURIComponent(state)}`,
      });
    }

    if (req.method === "GET" && url.pathname === "/auth/google/start") {
      if (!googleConfigured()) return html(res, 503, "<h1>Google OAuth no está configurado.</h1>");
      const state = url.searchParams.get("state");
      const decoded = verifyState(state);
      const record = await db("get_device_auth", { device_id: decoded.d });
      if (!record?.device || record.device.secret_hash !== sha256(decoded.s)) {
        return html(res, 400, "<h1>Solicitud de autorización inválida o expirada.</h1>");
      }

      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: `${APP_BASE_URL}/auth/google/callback`,
        response_type: "code",
        scope: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/drive",
        ].join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });

      res.statusCode = 302;
      res.setHeader("Location", `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/auth/google/callback") {
      const error = url.searchParams.get("error");
      if (error) return html(res, 400, `<h1>Autorización cancelada</h1><p>${String(error)}</p>`);

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return html(res, 400, "<h1>Respuesta OAuth incompleta.</h1>");

      const decoded = verifyState(state);
      const device = await db("get_device_auth", { device_id: decoded.d });
      if (!device?.device || device.device.secret_hash !== sha256(decoded.s)) {
        return html(res, 400, "<h1>Solicitud expirada o inválida.</h1>");
      }

      const tokens = await exchangeCode(code);
      const profile = await fetchGoogleUser(tokens.access_token);

      const userResult = await db("upsert_user", {
        google_sub: profile.sub,
        email: profile.email,
        display_name: profile.name || null,
        picture_url: profile.picture || null,
      });
      const user = userResult.user;

      if (tokens.refresh_token) {
        await db("put_drive_account", {
          user_id: user.id,
          refresh_token_enc: encryptSecret(tokens.refresh_token),
          scopes: String(tokens.scope || "").split(/\s+/).filter(Boolean),
        });
      }
      accessTokenCache.delete(user.id);

      await db("complete_device_auth", { device_id: decoded.d, user_id: user.id });

      return html(res, 200, `<!doctype html><html><head><meta charset="utf-8"><title>Web Media Collector</title></head>
      <body style="font-family:system-ui;padding:40px;max-width:700px;margin:auto">
      <h1>Google Drive conectado correctamente</h1>
      <p>Ya puedes cerrar esta pestaña y volver a Web Media Collector.</p>
      </body></html>`);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/device/poll") {
      const body = await readJson(req);
      const deviceId = body.device_id;
      const deviceSecret = body.device_secret;
      if (!deviceId || !deviceSecret) return json(res, 400, { ok: false, error: "Faltan credenciales del dispositivo" });

      const record = await db("get_device_auth", { device_id: deviceId });
      if (!record?.device) return json(res, 410, { ok: false, status: "expired" });
      if (record.device.secret_hash !== sha256(deviceSecret)) return json(res, 401, { ok: false, status: "invalid" });
      if (!record.device.user_id) return json(res, 200, { ok: true, status: "pending" });

      const userResult = await db("get_user", { user_id: record.device.user_id });
      const sessionToken = randomToken(32);
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
      await db("create_session", {
        token_hash: sha256(sessionToken),
        user_id: record.device.user_id,
        expires_at: expiresAt,
      });
      await db("delete_device_auth", { device_id: deviceId });

      return json(res, 200, {
        ok: true,
        status: "authorized",
        token: sessionToken,
        expires_at: expiresAt,
        user: userResult.user,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const current = await requireSession(req);
      if (!current) return json(res, 401, { ok: false, error: "No autorizado" });
      return json(res, 200, { ok: true, user: current.user });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const current = await requireSession(req);
      if (!current) return json(res, 200, { ok: true });
      await db("delete_session", { token_hash: sha256(current.token) });
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/drive/status") {
      const current = await requireSession(req);
      if (!current) return json(res, 401, { ok: false, error: "No autorizado" });
      const drive = await db("get_drive_account", { user_id: current.user.id });
      return json(res, 200, {
        ok: true,
        connected: Boolean(drive?.drive?.refresh_token_enc),
        user: current.user,
      });
    }


    if (req.method === "GET" && url.pathname === "/api/drive/verify") {
      const current = await requireSession(req);
      if (!current) return json(res, 401, { ok: false, error: "No autorizado" });
      const result = await verifyDriveConnection(current.user.id);
      return json(res, 200, { ok: true, folder: result.root, folders: result.folders, user: current.user });
    }

    if (req.method === "POST" && url.pathname === "/api/metadata") {
      const body = await readJson(req);
      const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 1000) : [];
      if (!candidates.length) return json(res, 400, { error: "No se recibieron recursos." });
      const results = [];
      for (const item of candidates) {
        try { results.push(await analyzeOne(item)); }
        catch (error) { results.push({ url: item.url, ok: false, error: error.message }); }
      }
      const analyzed = results.filter(r => r.ok).length;
      return json(res, 200, { total: candidates.length, analyzed, failed: candidates.length - analyzed, results });
    }

    if (req.method === "POST" && url.pathname === "/api/zip") {
      const body = await readJson(req);
      const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 1000) : [];
      if (!candidates.length) return json(res, 400, { error: "No se recibieron recursos." });
      const built = await buildZip(candidates);
      const token = crypto.randomUUID();
      const filename = `Web-Media-Collector-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
      zipDownloads.set(token, { ...built, filename, createdAt: Date.now() });
      setTimeout(async () => {
        const entry = zipDownloads.get(token);
        if (!entry) return;
        zipDownloads.delete(token);
        await fsp.unlink(entry.zipPath).catch(() => {});
      }, ZIP_TTL_MS).unref?.();
      const successful = built.inventory.filter(x => !x.error).length;
      const failed = built.inventory.filter(x => x.error).length;
      return json(res, 200, {
        ok: true,
        filename,
        total: candidates.length,
        successful,
        failed,
        bytes: built.bytes,
        downloadUrl: `${APP_BASE_URL}/api/zip-download/${token}`,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/zip-download/")) {
      const token = decodeURIComponent(url.pathname.slice("/api/zip-download/".length));
      const entry = zipDownloads.get(token);
      if (!entry || !fs.existsSync(entry.zipPath)) return json(res, 404, { error: "El ZIP ya no está disponible. Vuelve a generarlo." });
      try {
        cors(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Length", String(entry.bytes));
        res.setHeader("Content-Disposition", `attachment; filename="${entry.filename}"`);
        await pipeline(fs.createReadStream(entry.zipPath), res);
      } finally {
        zipDownloads.delete(token);
        await fsp.unlink(entry.zipPath).catch(() => {});
      }
      return;
    }


    if (req.method === "POST" && url.pathname === "/api/ingest/start") {
      const current = await requireSession(req);
      if (!current) return json(res, 401, { ok: false, error: "No autorizado" });
      const body = await readJson(req);
      const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 1000) : [];
      if (!candidates.length) return json(res, 400, { error: "No se recibieron recursos." });
      const collectionName = normalizeCollectionName(body.collectionName);
      if (!collectionName) return json(res, 400, { error: "Debes escribir un nombre para la colección antes de subir." });

      const token = await accessTokenForUser(current.user.id);
      const userFolders = await ensureUserDriveFolders(current.user.id, token);
      const cats = candidates.map(item => category(extFrom(item.url, "", item.extension), "", item.kind)).filter(Boolean);
      const collection = await resolveCollection(current.user.id, collectionName, cats, body.collectionId || null, token, userFolders);

      const jobId = crypto.randomUUID();
      const job = {
        id: jobId,
        userId: current.user.id,
        status: "queued",
        total: candidates.length,
        processed: 0,
        uploaded: 0,
        duplicates: 0,
        failed: 0,
        results: new Array(candidates.length),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        error: null,
        collectionId: collection.public_id,
        collectionDisplayId: compactCollectionId(collection.public_id),
        collectionName: collection.name,
        folderLabel: collectionFolderLabel(collection),
      };
      ingestJobs.set(jobId, job);
      scheduleIngestJobCleanup(jobId);
      runIngestJob(job, candidates, { userId: current.user.id, token, collection, userFolders }).catch(error => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });

      return json(res, 202, {
        ok: true,
        jobId,
        status: job.status,
        total: job.total,
        collectionId: job.collectionId,
        collectionDisplayId: job.collectionDisplayId,
        collectionName: job.collectionName,
        folderLabel: job.folderLabel,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/ingest/status/")) {
      const current = await requireSession(req);
      if (!current) return json(res, 401, { ok: false, error: "No autorizado" });
      const jobId = decodeURIComponent(url.pathname.slice("/api/ingest/status/".length));
      const job = ingestJobs.get(jobId);
      if (!job || job.userId !== current.user.id) return json(res, 404, { ok: false, error: "Trabajo de subida no encontrado" });
      const elapsedMs = (job.finishedAt || Date.now()) - (job.startedAt || job.createdAt);
      const progress = job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
      return json(res, 200, {
        ok: true,
        jobId,
        status: job.status,
        total: job.total,
        processed: job.processed,
        uploaded: job.uploaded,
        duplicates: job.duplicates,
        failed: job.failed,
        progress,
        elapsedMs,
        error: job.error,
        collectionId: job.collectionId,
        collectionDisplayId: job.collectionDisplayId,
        collectionName: job.collectionName,
        folderLabel: job.folderLabel,
        results: job.status === "done" || job.status === "failed" ? job.results.filter(Boolean) : undefined,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/ingest") {
      const current = await requireSession(req);
      if (!current) return json(res, 401, { ok: false, error: "No autorizado" });
      const body = await readJson(req);
      const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 1000) : [];
      if (!candidates.length) return json(res, 400, { error: "No se recibieron recursos." });
      const collectionName = normalizeCollectionName(body.collectionName);
      if (!collectionName) return json(res, 400, { error: "Debes escribir un nombre para la colección antes de subir." });
      const token = await accessTokenForUser(current.user.id);
      const userFolders = await ensureUserDriveFolders(current.user.id, token);
      const cats = candidates.map(item => category(extFrom(item.url, "", item.extension), "", item.kind)).filter(Boolean);
      const collection = await resolveCollection(current.user.id, collectionName, cats, body.collectionId || null, token, userFolders);
      const results = await mapConcurrent(candidates, 6, async (item) => {
        try {
          return { url: item.url, ...(await ingestOne(item, { userId: current.user.id, token, collection, userFolders })) };
        } catch (error) {
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          console.error("Fallo ingest:", item.url, message);
          return { url: item.url, status: "failed", error: message };
        }
      });
      const uploaded = results.filter(r => r.status === "uploaded").length;
      const duplicates = results.filter(r => r.status === "duplicate").length;
      const failed = results.filter(r => r.status === "failed").length;
      return json(res, 200, {
        ok: true,
        total: candidates.length,
        processed: results.length,
        uploaded,
        duplicates,
        failed,
        results,
        collectionId: collection.public_id,
        collectionName: collection.name,
        collectionDisplayId: compactCollectionId(collection.public_id),
        folderLabel: collectionFolderLabel(collection),
      });
    }

    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: error instanceof Error ? error.message : "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Web Media Collector Cloud ${VERSION} listening on port ${PORT}`);
});
