import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { InstagramClient } from "./instagram.js";

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MCP_API_KEY = process.env.MCP_API_KEY;

function getClient() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const userId = process.env.INSTAGRAM_USER_ID;
  if (!token || !userId) {
    throw new Error("Env vars INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID must be set");
  }
  return new InstagramClient({ accessToken: token, igUserId: userId });
}

function createMcpServer() {
  const server = new McpServer({ name: "instagram-insights", version: "1.0.0" });

  server.tool(
    "get_account_insights",
    "Fetch Instagram account metrics: reach, impressions, profile views, and follower count",
    {
      period: z
        .enum(["day", "week", "days_28", "month"])
        .default("days_28")
        .describe("Time period for metrics aggregation"),
    },
    async ({ period }) => {
      const data = await getClient().getAccountInsights(period);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_post_insights",
    "Get detailed performance metrics for a specific Instagram post",
    {
      media_id: z.string().describe("Instagram media ID — get it from list_recent_posts"),
    },
    async ({ media_id }) => {
      const data = await getClient().getPostInsights(media_id);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_audience_data",
    "Get audience demographics: age groups, gender distribution, top cities and countries",
    {},
    async () => {
      const data = await getClient().getAudienceData();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "list_recent_posts",
    "List recent Instagram posts with engagement metrics (likes, comments, reach, impressions)",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of posts to retrieve (max 50)"),
    },
    async ({ limit }) => {
      const data = await getClient().listRecentPosts(limit);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ── MCP Endpoint (Streamable HTTP, stateless) ─────────────────────────────────

function checkApiKey(req, res) {
  if (!MCP_API_KEY) return true;
  const auth = req.headers.authorization ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers["x-api-key"];
  if (key !== MCP_API_KEY) {
    res.status(401).json({ error: "Unauthorized — invalid or missing API key" });
    return false;
  }
  return true;
}

app.post("/mcp", async (req, res) => {
  if (!checkApiKey(req, res)) return;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  res.on("finish", () => server.close().catch(() => {}));
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  if (!checkApiKey(req, res)) return;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  res.on("finish", () => server.close().catch(() => {}));
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  if (!checkApiKey(req, res)) return;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  res.on("finish", () => server.close().catch(() => {}));
  await server.connect(transport);
  await transport.handleRequest(req, res);
});

// ── OAuth — Instagram Login (não requer Página do Facebook) ──────────────────
//
// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login

app.get("/auth/login", (req, res) => {
  const { FACEBOOK_APP_ID, REDIRECT_URI } = process.env;
  if (!FACEBOOK_APP_ID || !REDIRECT_URI) {
    return res.status(500).send("Set FACEBOOK_APP_ID and REDIRECT_URI first");
  }

  const url = new URL("https://api.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", FACEBOOK_APP_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", "instagram_business_basic,instagram_business_manage_insights");
  url.searchParams.set("response_type", "code");
  res.redirect(url.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  const { FACEBOOK_APP_ID: appId, FACEBOOK_APP_SECRET: appSecret, REDIRECT_URI } = process.env;

  if (error) {
    return res.status(400).send(`<pre style="color:red">OAuth error: ${error}\n${error_description}</pre>`);
  }
  if (!code) return res.status(400).send("Missing authorization code");

  try {
    // Step 1: code → short-lived token (POST form-encoded, not query params)
    const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code,
      }),
    });
    const shortData = await shortRes.json();
    console.log("[oauth] short-lived:", JSON.stringify({ ...shortData, access_token: shortData.access_token?.slice(0, 20) + "…" }));
    if (shortData.error_type || shortData.error_message) {
      throw new Error(shortData.error_message ?? JSON.stringify(shortData));
    }

    // shortData: { access_token, user_id }
    const igUserId = String(shortData.user_id);

    // Step 2: short-lived → long-lived token (60 days)
    const llRes = await fetch(
      "https://graph.instagram.com/access_token?" +
        new URLSearchParams({
          grant_type: "ig_exchange_token",
          client_secret: appSecret,
          access_token: shortData.access_token,
        })
    );
    const llData = await llRes.json();
    console.log("[oauth] long-lived:", JSON.stringify({ ...llData, access_token: llData.access_token?.slice(0, 20) + "…" }));
    if (llData.error) throw new Error(llData.error.message ?? JSON.stringify(llData.error));

    // Step 3: fetch profile to confirm identity
    const profileRes = await fetch(
      `https://graph.instagram.com/v22.0/${igUserId}?` +
        new URLSearchParams({
          fields: "id,username,name,biography,followers_count,media_count",
          access_token: llData.access_token,
        })
    );
    const profile = await profileRes.json();
    console.log("[oauth] profile:", JSON.stringify(profile));

    const expiresIn = llData.expires_in ?? 5184000;
    const expiresDate = new Date(Date.now() + expiresIn * 1000).toLocaleDateString("pt-BR");

    res.send(`<!DOCTYPE html>
<html>
<head><title>Instagram MCP – Setup</title>
<style>
  body { font-family: monospace; max-width: 820px; margin: 40px auto; padding: 20px; background: #fafafa; }
  h2 { color: #2e7d32; }
  pre { background: #f0f0f0; padding: 16px; border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
  .box { background: #fff3cd; border: 1px solid #ffc107; padding: 16px; border-radius: 6px; margin: 20px 0; }
</style>
</head>
<body>
  <h2>✅ Autenticação concluída!</h2>

  <h3>Perfil autenticado:</h3>
  <pre>${JSON.stringify(profile, null, 2)}</pre>

  <h3>Long-Lived Access Token (válido até ${expiresDate}):</h3>
  <pre>${llData.access_token}</pre>

  <div class="box">
    <h3>📋 Variáveis de ambiente para o Railway:</h3>
    <pre>INSTAGRAM_ACCESS_TOKEN=${llData.access_token}
INSTAGRAM_USER_ID=${igUserId}</pre>
    <p><strong>Cole esses valores nas variáveis de ambiente do serviço no Railway e faça redeploy.</strong></p>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error("[oauth] error:", err.message);
    res.status(500).send(`<pre style="color:red">Erro: ${err.message}</pre>`);
  }
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "2.0.0",
    auth: "instagram-login",
    igUserConfigured: !!process.env.INSTAGRAM_USER_ID,
    tokenConfigured: !!process.env.INSTAGRAM_ACCESS_TOKEN,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Instagram MCP Server v2 listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`OAuth login:  http://localhost:${PORT}/auth/login`);
  console.log(`Health:       http://localhost:${PORT}/health`);
});
