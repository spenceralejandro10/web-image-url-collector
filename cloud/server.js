const http = require("node:http");
const crypto = require("node:crypto");
const { URL, URLSearchParams } = require("node:url");

const VERSION = "4.0.0";
const PORT = Number(process.env.PORT || 8787);
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const DB_FUNCTION_URL = process.env.WMC_DB_FUNCTION_URL || "";
const DB_BACKEND_KEY = process.env.WMC_DB_BACKEND_KEY || "";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 90);

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
        cloud: true,
        databaseConfigured: Boolean(DB_FUNCTION_URL && DB_BACKEND_KEY),
        googleOAuthConfigured: googleConfigured(),
        now: new Date().toISOString(),
      });
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

    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: error instanceof Error ? error.message : "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Web Media Collector Cloud ${VERSION} listening on port ${PORT}`);
});
