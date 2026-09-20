const http = require("node:http");
const { URL } = require("node:url");

const VERSION = "4.0.0";
const PORT = Number(process.env.PORT || 8787);

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
        databaseConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY),
        googleOAuthConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        now: new Date().toISOString()
      });
    }

    if (req.method === "GET" && url.pathname === "/api/drive/status") {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        return json(res, 503, {
          ok: false,
          code: "GOOGLE_OAUTH_NOT_CONFIGURED",
          message: "Google OAuth web credentials are not configured yet."
        });
      }
      return json(res, 200, {
        ok: true,
        configured: true,
        message: "Google OAuth credentials are configured. User authorization flow is the next step."
      });
    }

    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: "Internal server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Web Media Collector Cloud ${VERSION} listening on port ${PORT}`);
});
