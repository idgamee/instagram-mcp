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
    throw new Error(
      "Env vars INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID must be set"
    );
  }
  return new InstagramClient({ accessToken: token, igUserId: userId });
}

function createMcpServer() {
  const server = new McpServer({
    name: "instagram-insights",
    version: "1.0.0",
  });

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
      media_id: z
        .string()
        .describe("Instagram media ID — get it from list_recent_posts"),
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
  if (!MCP_API_KEY) return true; // auth disabled
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

// ── OAuth helpers ─────────────────────────────────────────────────────────────

app.get("/auth/login", (req, res) => {
  const { FACEBOOK_APP_ID, REDIRECT_URI } = process.env;
  if (!FACEBOOK_APP_ID || !REDIRECT_URI) {
    return res.status(500).send("Set FACEBOOK_APP_ID and REDIRECT_URI first");
  }

  const url = new URL("https://www.facebook.com/v22.0/dialog/oauth");
  url.searchParams.set("client_id", FACEBOOK_APP_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set(
    "scope",
    [
      "instagram_manage_insights",
      "pages_show_list",
      "pages_read_engagement",
    ].join(",")
  );
  url.searchParams.set("response_type", "code");
  res.redirect(url.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  const { FACEBOOK_APP_ID: appId, FACEBOOK_APP_SECRET: appSecret, REDIRECT_URI } = process.env;

  if (!code) return res.status(400).send("Missing authorization code");

  try {
    // Short-lived → long-lived token exchange
    const shortRes = await fetch(
      `https://graph.facebook.com/v22.0/oauth/access_token?` +
        new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: REDIRECT_URI, code })
    );
    const shortData = await shortRes.json();
    if (shortData.error) throw new Error(shortData.error.message);

    const llRes = await fetch(
      `https://graph.facebook.com/v22.0/oauth/access_token?` +
        new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: shortData.access_token,
        })
    );
    const llData = await llRes.json();
    if (llData.error) throw new Error(llData.error.message);

    // Discover linked Instagram Business accounts
    const pagesRes = await fetch(
      `https://graph.facebook.com/v22.0/me/accounts?access_token=${llData.access_token}`
    );
    const pagesData = await pagesRes.json();

    const igAccounts = [];
    for (const page of pagesData.data ?? []) {
      const igRes = await fetch(
        `https://graph.facebook.com/v22.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
      );
      const igData = await igRes.json();
      if (igData.instagram_business_account?.id) {
        igAccounts.push({
          pageId: page.id,
          pageName: page.name,
          igUserId: igData.instagram_business_account.id,
        });
      }
    }

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

  <h3>Long-Lived Access Token (válido 60 dias):</h3>
  <pre>${llData.access_token}</pre>

  <h3>Contas Instagram encontradas:</h3>
  <pre>${JSON.stringify(igAccounts, null, 2)}</pre>

  <div class="box">
    <h3>📋 Variáveis de ambiente para o Railway:</h3>
    <pre>INSTAGRAM_ACCESS_TOKEN=${llData.access_token}
${igAccounts.map((a) => `INSTAGRAM_USER_ID=${a.igUserId}  # ${a.pageName}`).join("\n")}</pre>
    <p><strong>Copie esses valores e cole nas variáveis de ambiente do seu serviço no Railway.</strong></p>
  </div>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`<pre style="color:red">Erro: ${err.message}</pre>`);
  }
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    igUserConfigured: !!process.env.INSTAGRAM_USER_ID,
    tokenConfigured: !!process.env.INSTAGRAM_ACCESS_TOKEN,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Instagram MCP Server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`OAuth login:  http://localhost:${PORT}/auth/login`);
  console.log(`Health:       http://localhost:${PORT}/health`);
});
