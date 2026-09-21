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
const METADATA_SHEET_NAME = "Web Media Collection · Navegador de Metadatos";
const METADATA_SHEET_TABS = ["Dashboard", "Navegador", "Hallazgos", "Cobertura", "Colecciones", "Diccionario", "Metadata cruda"];

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

async function sheetsJson(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Sheets HTTP ${response.status}: ${text.slice(0, 1000)}`);
  return data;
}

function sheetNameA1(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function sheetText(value) {
  if (value == null) return "";
  let out;
  if (typeof value === "string") out = value;
  else if (typeof value === "number" || typeof value === "boolean") return value;
  else {
    try { out = JSON.stringify(value); } catch { out = String(value); }
  }
  if (/^[=+\-@]/.test(out)) return "'" + out;
  return out;
}

function metadataPick(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      const joined = value.map(v => metadataPick(v)).filter(Boolean).join(", ");
      if (joined) return joined;
      continue;
    }
    if (typeof value === "object") {
      const likely = value.value ?? value.description ?? value.name ?? value.author ?? value.creator;
      if (likely != null) {
        const nested = metadataPick(likely);
        if (nested) return nested;
      }
      continue;
    }
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function validGps(lat, lon) {
  const a = Number(lat);
  const b = Number(lon);
  return Number.isFinite(a) && Number.isFinite(b) && !(a === 0 && b === 0);
}

function latestSourceMap(sources) {
  const map = new Map();
  for (const source of sources || []) {
    if (!map.has(source.asset_id)) map.set(source.asset_id, source);
  }
  return map;
}

function collectionLabelsByAsset(collections, memberships) {
  const byId = new Map((collections || []).map(c => [String(c.id), c]));
  const out = new Map();
  for (const member of memberships || []) {
    const c = byId.get(String(member.collection_id));
    if (!c) continue;
    const label = `${compactCollectionId(c.public_id)} · ${c.name}`;
    const arr = out.get(member.asset_id) || [];
    arr.push(label);
    out.set(member.asset_id, arr);
  }
  return out;
}

function assetSignals(asset, source) {
  const meta = asset.metadata_json || {};
  const embedded = meta.embedded || {};
  const parsed = embedded.parsed || {};
  const descriptive = meta.descriptive || {};
  const exif = meta.exif || {};
  const sourceMeta = meta.source || {};
  const creator = metadataPick(
    descriptive.creator,
    descriptive.author,
    exif.creator,
    exif.artist,
    parsed.Artist,
    parsed.Creator,
    parsed.Author,
    parsed.XPAuthor,
    parsed.Copyright
  );
  const country = metadataPick(asset.country, descriptive.country, parsed.Country, parsed.CountryName);
  const city = metadataPick(asset.city, descriptive.city, parsed.City);
  const camera = [metadataPick(asset.camera_make), metadataPick(asset.camera_model)].filter(Boolean).join(" ").trim();
  const captured = metadataPick(asset.captured_at, parsed.DateTimeOriginal, parsed.CreateDate, parsed.DateTimeDigitized);
  const gps = validGps(asset.latitude, asset.longitude)
    ? `${Number(asset.latitude).toFixed(6)}, ${Number(asset.longitude).toFixed(6)}`
    : "";
  const description = metadataPick(asset.description, descriptive.description, parsed.Description, parsed.ImageDescription, parsed.Caption);
  const altAria = metadataPick(source?.alt_text, sourceMeta.alt, sourceMeta.aria);
  const title = metadataPick(source?.title, sourceMeta.title);
  const context = metadataPick(source?.context_text, sourceMeta.context);
  return {
    creator,
    country,
    city,
    camera,
    captured,
    gps,
    description,
    altAria,
    title,
    context,
    sourcePage: metadataPick(source?.source_page, sourceMeta.pageUrl),
    directUrl: metadataPick(source?.source_url, sourceMeta.directUrl),
  };
}

async function findMetadataSpreadsheet(token, rootFolderId) {
  const q = `'${driveQueryEscape(rootFolderId)}' in parents and name = '${driveQueryEscape(METADATA_SHEET_NAME)}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType,parents,webViewLink)", pageSize: "20" });
  const data = await driveJson(token, `https://www.googleapis.com/drive/v3/files?${params.toString()}`);
  return (data.files || [])[0] || null;
}

async function createMetadataSpreadsheet(token, rootFolderId) {
  return driveJson(token, "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,parents,webViewLink", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      name: METADATA_SHEET_NAME,
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: [rootFolderId],
    }),
  });
}

async function ensureMetadataTabs(token, spreadsheetId) {
  let meta = await sheetsJson(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title,index))`
  );
  let sheets = meta.sheets || [];
  const titles = new Set(sheets.map(s => s.properties?.title).filter(Boolean));
  const requests = [];

  if (!titles.has("Dashboard") && sheets.length === 1) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: sheets[0].properties.sheetId, title: "Dashboard" },
        fields: "title",
      },
    });
    titles.delete(sheets[0].properties.title);
    titles.add("Dashboard");
  }

  for (const title of METADATA_SHEET_TABS) {
    if (!titles.has(title)) requests.push({ addSheet: { properties: { title } } });
  }

  if (requests.length) {
    await sheetsJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ requests }),
      }
    );
    meta = await sheetsJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title,index))`
    );
    sheets = meta.sheets || [];
  }
  return sheets;
}

async function formatMetadataSpreadsheet(token, spreadsheetId, sheets) {
  const byTitle = new Map((sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
  const requests = [];
  const dark = { red: 0.09, green: 0.13, blue: 0.20 };
  const blue = { red: 0.09, green: 0.36, blue: 0.83 };
  const light = { red: 0.94, green: 0.96, blue: 0.98 };
  const white = { red: 1, green: 1, blue: 1 };

  for (const title of METADATA_SHEET_TABS) {
    const sheetId = byTitle.get(title);
    if (sheetId == null) continue;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { backgroundColor: dark, textFormat: { foregroundColor: white, bold: true, fontSize: 15 } } },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    });
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 2, endRowIndex: 3 },
        cell: { userEnteredFormat: { backgroundColor: blue, textFormat: { foregroundColor: white, bold: true }, wrapStrategy: "WRAP" } },
        fields: "userEnteredFormat(backgroundColor,textFormat,wrapStrategy)",
      },
    });
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 3 } },
        fields: "gridProperties.frozenRowCount",
      },
    });
  }

  const navId = byTitle.get("Navegador");
  if (navId != null) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: navId, dimension: "COLUMNS", startIndex: 0, endIndex: 28 },
        properties: { pixelSize: 150 },
        fields: "pixelSize",
      },
    });
  }
  const rawId = byTitle.get("Metadata cruda");
  if (rawId != null) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: rawId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
        properties: { pixelSize: 700 },
        fields: "pixelSize",
      },
    });
  }
  const findsId = byTitle.get("Hallazgos");
  if (findsId != null) {
    requests.push({
      repeatCell: {
        range: { sheetId: findsId, startRowIndex: 3, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: 13 },
        cell: { userEnteredFormat: { backgroundColor: light, wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
        fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
      },
    });
  }

  if (requests.length) {
    await sheetsJson(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ requests }),
      }
    );
  }
}

async function syncMetadataSpreadsheet(userId, token, userFolders) {
  const startedAt = Date.now();
  let spreadsheet = await findMetadataSpreadsheet(token, userFolders.root_folder_id);
  const created = !spreadsheet;
  if (!spreadsheet) spreadsheet = await createMetadataSpreadsheet(token, userFolders.root_folder_id);

  const sheets = await ensureMetadataTabs(token, spreadsheet.id);
  const catalog = await db("list_metadata_catalog", { user_id: userId });
  const assets = catalog.assets || [];
  const sources = catalog.sources || [];
  const collections = catalog.collections || [];
  const memberships = catalog.memberships || [];

  const sourceMap = latestSourceMap(sources);
  const collectionMap = collectionLabelsByAsset(collections, memberships);
  const rows = [];
  const findings = [];
  const rawRows = [];
  const formatCounts = new Map();

  let images = 0;
  let videos = 0;
  const coverageCounts = {
    creator: 0, country: 0, city: 0, camera: 0, captured: 0, gps: 0,
    description: 0, altAria: 0, titleContext: 0, sourcePage: 0, drive: 0,
  };

  for (const asset of assets) {
    const source = sourceMap.get(asset.id) || null;
    const sig = assetSignals(asset, source);
    const type = String(asset.media_type || "").toLowerCase() === "video" ? "video" : "image";
    if (type === "video") videos += 1; else images += 1;
    const format = String(asset.format || asset.media_type || "sin formato").toUpperCase();
    formatCounts.set(format, (formatCounts.get(format) || 0) + 1);
    const collectionsText = (collectionMap.get(asset.id) || []).join(", ");
    const dims = asset.width && asset.height ? `${asset.width} × ${asset.height}` : "";
    const mb = asset.byte_size ? Math.round((Number(asset.byte_size) / 1048576) * 1000) / 1000 : "";
    const titleContext = [sig.title, sig.context].filter(Boolean).join(" · ");
    const driveUrl = asset.drive_file_id ? `https://drive.google.com/file/d/${asset.drive_file_id}/view` : "";

    if (sig.creator) coverageCounts.creator++;
    if (sig.country) coverageCounts.country++;
    if (sig.city) coverageCounts.city++;
    if (sig.camera) coverageCounts.camera++;
    if (sig.captured) coverageCounts.captured++;
    if (sig.gps) coverageCounts.gps++;
    if (sig.description) coverageCounts.description++;
    if (sig.altAria) coverageCounts.altAria++;
    if (titleContext) coverageCounts.titleContext++;
    if (sig.sourcePage) coverageCounts.sourcePage++;
    if (asset.drive_file_id) coverageCounts.drive++;

    rows.push([
      asset.human_id || "",
      collectionsText,
      type,
      asset.format || "",
      asset.filename || "",
      asset.display_name || "",
      sig.creator,
      sig.country,
      sig.city,
      sig.camera,
      sig.captured,
      sig.gps,
      dims,
      mb,
      sig.description,
      sig.sourcePage,
      sig.directUrl,
      driveUrl,
      asset.sha256 || "",
      asset.mime_type || "",
      asset.iso ?? "",
      asset.exposure_time || "",
      asset.aperture ?? "",
      asset.focal_length ?? "",
      asset.software || "",
      sig.altAria,
      titleContext,
      asset.created_at || "",
    ].map(sheetText));

    const score = [sig.creator, sig.country, sig.city, sig.camera, sig.captured, sig.gps, sig.description].filter(Boolean).length;
    if (score > 0) {
      findings.push([
        asset.human_id || "",
        score,
        type,
        asset.format || "",
        sig.creator,
        sig.country,
        sig.city,
        sig.camera,
        sig.captured,
        sig.gps,
        sig.description,
        collectionsText,
        driveUrl,
      ].map(sheetText));
    }

    rawRows.push([
      asset.human_id || "",
      sheetText(asset.metadata_json || {}),
      sig.directUrl,
    ]);
  }

  findings.sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])));

  const coverage = [
    ["Creador / persona", coverageCounts.creator, assets.length, assets.length ? coverageCounts.creator / assets.length : 0, "EXIF/IPTC/XMP/Artist; no reconocimiento visual"],
    ["País", coverageCounts.country, assets.length, assets.length ? coverageCounts.country / assets.length : 0, "Metadatos explícitos"],
    ["Ciudad", coverageCounts.city, assets.length, assets.length ? coverageCounts.city / assets.length : 0, "Metadatos explícitos"],
    ["Cámara / celular", coverageCounts.camera, assets.length, assets.length ? coverageCounts.camera / assets.length : 0, "Fabricante y modelo"],
    ["Fecha de captura", coverageCounts.captured, assets.length, assets.length ? coverageCounts.captured / assets.length : 0, "EXIF/XMP"],
    ["GPS válido", coverageCounts.gps, assets.length, assets.length ? coverageCounts.gps / assets.length : 0, "Latitud/longitud distintas de 0,0"],
    ["Descripción", coverageCounts.description, assets.length, assets.length ? coverageCounts.description / assets.length : 0, "EXIF/IPTC/XMP"],
    ["ALT / ARIA", coverageCounts.altAria, assets.length, assets.length ? coverageCounts.altAria / assets.length : 0, "Contexto de la página fuente"],
    ["Título / contexto", coverageCounts.titleContext, assets.length, assets.length ? coverageCounts.titleContext / assets.length : 0, "Página fuente"],
    ["Página fuente", coverageCounts.sourcePage, assets.length, assets.length ? coverageCounts.sourcePage / assets.length : 0, "Página donde se detectó"],
    ["Archivo en Drive", coverageCounts.drive, assets.length, assets.length ? coverageCounts.drive / assets.length : 0, "Google Drive"],
  ];

  const collectionCounts = new Map();
  for (const m of memberships) collectionCounts.set(String(m.collection_id), (collectionCounts.get(String(m.collection_id)) || 0) + 1);
  const collectionRows = collections.map(c => [
    compactCollectionId(c.public_id),
    c.name,
    collectionCounts.get(String(c.id)) || 0,
    c.created_at || "",
  ]);

  const navHeaders = ["ID","Colección(es)","Tipo","Formato","Archivo","Nombre sugerido","Creador / persona","País","Ciudad","Cámara / celular","Fecha captura","GPS","Dimensiones","Tamaño MB","Descripción","Página fuente","URL directa","Abrir en Drive","SHA-256","MIME","ISO","Exposición","Apertura","Focal","Software","ALT / ARIA","Título / contexto","Fecha registro"];
  const hallHeaders = ["ID","Señales","Tipo","Formato","Creador / persona","País","Ciudad","Cámara / celular","Fecha captura","GPS","Descripción","Colección(es)","Abrir en Drive"];
  const dictRows = [
    ["ID","Identificador humano estable del activo","Base de datos","Ej. IMG-01 / VID-01"],
    ["Colección(es)","Colecciones a las que pertenece el activo","Supabase","ID público + nombre"],
    ["Creador / persona","Autor/Artist/Creator embebido cuando existe","EXIF/IPTC/XMP","No identifica visualmente a una persona"],
    ["País","País respaldado por metadatos","Metadatos","Vacío si no hay evidencia"],
    ["Ciudad","Ciudad respaldada por metadatos","Metadatos","Vacío si no hay evidencia"],
    ["Cámara / celular","Fabricante y modelo del dispositivo","EXIF","Puede revelar cámara o teléfono si sobrevivió al procesamiento"],
    ["Fecha captura","Fecha/hora original de captura","EXIF/XMP",""],
    ["GPS","Latitud y longitud válidas","EXIF GPS","0,0 se trata como ausencia"],
    ["Descripción","Descripción embebida","EXIF/IPTC/XMP",""],
    ["Página fuente","Página donde se detectó el recurso","Captura web",""],
    ["URL directa","URL del recurso detectado","Captura web",""],
    ["Abrir en Drive","Enlace al archivo almacenado","Google Drive",""],
    ["SHA-256","Huella exacta de bytes","Backend","Identidad exacta para duplicados"],
    ["ALT / ARIA","Texto accesible de la fuente","Página web",""],
    ["Título / contexto","Título y texto contextual detectado","Página web",""],
    ["Metadata cruda","JSON completo del análisis","Metadata cruda","Conserva campos adicionales"],
  ];

  const dashboard = [
    ["WEB MEDIA COLLECTION · NAVEGADOR DE METADATOS"],
    ["Actualización automática después de cada carga a Google Drive. Solo muestra datos respaldados por archivo o fuente."],
    [],
    ["Métrica","Valor"],
    ["Activos registrados", assets.length],
    ["Imágenes", images],
    ["Videos", videos],
    ["Colecciones", collections.length],
    ["Hallazgos interesantes", findings.length],
    ["Con creador/persona", coverageCounts.creator],
    ["Con país", coverageCounts.country],
    ["Con ciudad", coverageCounts.city],
    ["Con cámara/celular", coverageCounts.camera],
    ["Con fecha de captura", coverageCounts.captured],
    ["Con GPS válido", coverageCounts.gps],
    ["Con descripción", coverageCounts.description],
    [],
    ["Formato","Cantidad"],
    ...[...formatCounts.entries()].sort((a,b) => b[1] - a[1]),
    [],
    ["Última actualización", new Date().toISOString()],
  ];

  const payloads = [
    { range: `${sheetNameA1("Dashboard")}!A1:H${Math.max(25, dashboard.length + 2)}`, values: dashboard },
    { range: `${sheetNameA1("Navegador")}!A1:AB${Math.max(4, rows.length + 3)}`, values: [
      ["NAVEGADOR DE ACTIVOS"],
      ["Usa los filtros para localizar imágenes por ID, colección, formato, creador, ubicación, cámara, fecha y otros campos."],
      navHeaders,
      ...rows,
    ]},
    { range: `${sheetNameA1("Hallazgos")}!A1:M${Math.max(4, findings.length + 3)}`, values: [
      ["HALLAZGOS INTERESANTES"],
      ["Solo aparecen activos con al menos una señal especialmente útil: creador, país, ciudad, cámara/celular, fecha, GPS o descripción."],
      hallHeaders,
      ...findings,
    ]},
    { range: `${sheetNameA1("Cobertura")}!A1:E${Math.max(4, coverage.length + 3)}`, values: [
      ["COBERTURA DE METADATOS"],
      ["Mide cuántos activos tienen cada dato realmente disponible."],
      ["Campo","Con dato","Total","Cobertura","Origen / regla"],
      ...coverage,
    ]},
    { range: `${sheetNameA1("Colecciones")}!A1:D${Math.max(4, collectionRows.length + 3)}`, values: [
      ["COLECCIONES"],
      ["Colecciones registradas y cantidad de activos asociados."],
      ["ID","Nombre","Activos","Creada"],
      ...collectionRows,
    ]},
    { range: `${sheetNameA1("Diccionario")}!A1:D${Math.max(4, dictRows.length + 3)}`, values: [
      ["DICCIONARIO DE DATOS"],
      ["Qué significa cada columna y de dónde proviene."],
      ["Campo","Descripción","Origen","Regla / nota"],
      ...dictRows,
    ]},
    { range: `${sheetNameA1("Metadata cruda")}!A1:C${Math.max(4, rawRows.length + 3)}`, values: [
      ["METADATA CRUDA"],
      ["JSON completo por activo para auditoría y análisis posterior."],
      ["ID","Metadata JSON","URL directa"],
      ...rawRows,
    ]},
  ];

  await sheetsJson(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheet.id)}/values:batchClear`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ ranges: METADATA_SHEET_TABS.map(title => `${sheetNameA1(title)}!A:AZ`) }),
    }
  );

  await sheetsJson(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheet.id)}/values:batchUpdate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: payloads }),
    }
  );

  if (created) {
    await formatMetadataSpreadsheet(token, spreadsheet.id, sheets);
  }

  return {
    ok: true,
    spreadsheetId: spreadsheet.id,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheet.id}/edit`,
    assets: assets.length,
    findings: findings.length,
    durationMs: Date.now() - startedAt,
  };
}

async function syncMetadataForUser(userId, token = null, userFolders = null) {
  const accessToken = token || await accessTokenForUser(userId);
  const folders = userFolders || await ensureUserDriveFolders(userId, accessToken);
  return syncMetadataSpreadsheet(userId, accessToken, folders);
}

async function syncAllMetadataSheetsOnStartup() {
  try {
    const result = await db("list_metadata_users");
    for (const row of result.users || []) {
      try {
        const synced = await syncMetadataForUser(row.user_id);
        console.log(`Metadata Sheet sincronizado para ${row.user_id}: ${synced.assets} activos, ${synced.findings} hallazgos`);
      } catch (error) {
        console.warn(`No se pudo sincronizar Metadata Sheet para ${row.user_id}: ${error.message}`);
      }
    }
  } catch (error) {
    console.warn("No se pudo iniciar la sincronización automática de Metadata Sheets:", error.message);
  }
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
    job.sheetSync = { status: "running" };
    try {
      const sheet = await syncMetadataForUser(ctx.userId, ctx.token, ctx.userFolders);
      job.sheetSync = { status: "done", ...sheet };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("No se pudo sincronizar el navegador de metadatos:", message);
      job.sheetSync = { status: "failed", error: message };
    }
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
        metadataSheetAutoSync: true,
        metadataSheetName: METADATA_SHEET_NAME,
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
        sheetSync: job.sheetSync || null,
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
      let sheetSync;
      try {
        sheetSync = await syncMetadataForUser(current.user.id, token, userFolders);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("No se pudo sincronizar el navegador de metadatos:", message);
        sheetSync = { ok: false, error: message };
      }
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
        sheetSync,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/metadata-sheet/sync") {
      const current = await requireSession(req);
      if (!current) return json(res, 401, { ok: false, error: "No autorizado" });
      const synced = await syncMetadataForUser(current.user.id);
      return json(res, 200, synced);
    }

    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: error instanceof Error ? error.message : "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Web Media Collector Cloud ${VERSION} listening on port ${PORT}`);
  setTimeout(() => {
    syncAllMetadataSheetsOnStartup().catch(error => console.warn("Metadata startup sync:", error.message));
  }, 2500).unref?.();
});

// metadata-sheet-autosync-deploy
