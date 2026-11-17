#!/usr/bin/env node
/**
 * joule-server.ts — Native SAP Joule Work Desktop Gateway for `cli2cli-mcp`
 *
 * Exposes `cli2cli-helm` & `cli2cli-mcp` directly to SAP Joule Work Desktop over:
 *   1. Streamable HTTP MCP (`POST /` and `POST /mcp`)
 *   2. RFC 7591 Dynamic Client Registration (`POST /register`)
 *   3. RFC 7636 OAuth 2.0 PKCE (`GET /authorize`, `POST /token`, `/.well-known/*`)
 *   4. REST & OpenAPI 3.0 convenience endpoints (`/api/*`, `/openapi.json`)
 *
 * Default port: 3052 (override via `PORT` env var or `--port <N>`).
 */

import * as http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, executeToolCall, helm } from "./index.js";
import type { SessionSummary } from "./helm-daemon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SHARED_BRIDGE_TOKEN_FILE = resolve(REPO_ROOT, "..", "ce3-mcp-joule-bridge", ".mcp-token");
const LOCAL_TOKEN_FILE = join(REPO_ROOT, ".mcp-token");

function parsePort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      return parseInt(args[i + 1]!, 10);
    }
    if (args[i]?.startsWith("--port=")) {
      return parseInt(args[i]!.split("=")[1]!, 10);
    }
  }
  return parseInt(process.env.PORT || "3052", 10);
}

const PORT = parsePort();
const BASE_URL = `http://localhost:${PORT}`;

function resolvePersistentToken(): string {
  if (process.env.MCP_TOKEN && process.env.MCP_TOKEN.trim()) {
    return process.env.MCP_TOKEN.trim();
  }
  for (const candidate of [SHARED_BRIDGE_TOKEN_FILE, LOCAL_TOKEN_FILE]) {
    try {
      if (existsSync(candidate)) {
        const stored = readFileSync(candidate, "utf8").trim();
        if (stored) return stored;
      }
    } catch {
      /* ignore */
    }
  }
  const token = "joule_" + randomBytes(24).toString("hex");
  try {
    writeFileSync(LOCAL_TOKEN_FILE, token, "utf8");
  } catch {
    /* ignore */
  }
  return token;
}

const MCP_TOKEN = resolvePersistentToken();
const authCodes = new Map<string, { redirect_uri: string; expires: number }>();
const validTokens = new Set<string>([MCP_TOKEN]);

const OAUTH_META = {
  issuer: BASE_URL,
  authorization_endpoint: `${BASE_URL}/authorize`,
  token_endpoint: `${BASE_URL}/token`,
  registration_endpoint: `${BASE_URL}/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "client_credentials"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"]
};

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

async function handleMcpRpc(message: {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<unknown> {
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: (params?.protocolVersion as string) || "2024-11-05",
          capabilities: {
            tools: {},
            resources: {}
          },
          serverInfo: {
            name: "cli2cli-bridge",
            version: "0.2.0"
          }
        }
      };

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS }
      };

    case "tools/call": {
      const toolName = String(params?.name ?? "");
      const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await executeToolCall(toolName, toolArgs, "joule-mcp");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }]
          }
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [{ type: "text", text: msg }]
          }
        };
      }
    }

    case "resources/list": {
      const list = await helm.request<{ sessions: SessionSummary[] }>("session.list", {});
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            {
              uri: "cli2cli://sessions",
              name: "CLI2CLI Active Terminal Sessions Fleet",
              description: "Live status summary of all PTY terminal sessions hosted in helm-daemon.",
              mimeType: "application/json"
            },
            ...list.sessions.map((s) => ({
              uri: `cli2cli://session/${s.slot}`,
              name: `Slot ${s.slot}: ${s.cli_type} (${s.state})`,
              description: `PTY session ${s.session_id} in ${s.working_dir}`,
              mimeType: "application/json"
            }))
          ]
        }
      };
    }

    case "resources/templates/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resourceTemplates: [
            {
              uriTemplate: "cli2cli://session/{session_id}",
              name: "CLI2CLI Session Output & Status by Slot or UUID",
              description: "Non-destructively inspect the tail output and 4-state status of any CLI session.",
              mimeType: "application/json"
            }
          ]
        }
      };

    case "resources/read": {
      const uri = String(params?.uri ?? "");
      if (uri === "cli2cli://sessions") {
        const list = await helm.request("session.list", {});
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(list, null, 2) }]
          }
        };
      }
      const prefix = "cli2cli://session/";
      if (uri.startsWith(prefix)) {
        const target = decodeURIComponent(uri.slice(prefix.length));
        const readRes = await helm.request("session.read", {
          session_id: target,
          tail_chars: 4000,
          consumer_id: "joule-mcp"
        });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(readRes, null, 2) }]
          }
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown resource URI: ${uri}` }
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", BASE_URL);
  const p = url.pathname;

  // 1. Health check (compatible with ce3-mcp-joule-bridge probe.js)
  if (req.method === "GET" && p === "/health") {
    const ping = await helm.request("daemon.ping", {}).catch(() => ({ status: "OFFLINE" }));
    sendJson(res, 200, {
      status: "ok",
      service: "cli2cli-joule-bridge",
      version: "0.2.0",
      port: PORT,
      tools_count: TOOLS.length,
      daemon: ping
    });
    return;
  }

  // 1b. Serve Live-Wired Portal & Report Engine (/portal, /engine, /open)
  if (req.method === "GET" && (p === "/portal" || p === "/engine")) {
    const htmlFile =
      p === "/portal"
        ? resolve(REPO_ROOT, "..", "PORTAL_PREVIEW.html")
        : resolve(REPO_ROOT, "..", "overview-report-engine.html");
    if (existsSync(htmlFile)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(htmlFile, "utf8"));
      return;
    }
  }

  if (req.method === "GET" && p === "/open") {
    const rawTarget = (url.searchParams.get("path") || "").trim();
    const cleaned = rawTarget.replace(/\s*\(\+.*$/, "").replace(/^file:\/\/\/?/i, "").replace(/\//g, "\\");
    const spDocRoot = "C:\\Users\\I820965\\SAP SE\\CPIT CE3 - DFE Architecture Workspace - Documents";
    const devRoot = resolve(REPO_ROOT, "..");
    const candidates = [
      cleaned,
      join(spDocRoot, cleaned),
      join(spDocRoot, "General", cleaned),
      join(devRoot, cleaned),
      join(devRoot, "deliverables", cleaned)
    ];
    const resolvedFile = candidates.find((c) => {
      try {
        return Boolean(c && existsSync(c) && statSync(c).isFile());
      } catch {
        return false;
      }
    });
    if (resolvedFile) {
      const ext = extname(resolvedFile).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".md": "text/plain; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".jsonld": "application/ld+json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".drawio": "application/xml; charset=utf-8",
        ".pdf": "application/pdf"
      };
      res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream" });
      res.end(readFileSync(resolvedFile));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Deliverable file not found on disk: ${rawTarget}`);
    return;
  }

  // 2. OAuth 2.0 Discovery (RFC 8414 / RFC 9728)
  if (
    req.method === "GET" &&
    (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration")
  ) {
    sendJson(res, 200, OAUTH_META);
    return;
  }
  if (req.method === "GET" && p === "/.well-known/oauth-protected-resource") {
    sendJson(res, 200, { resource: BASE_URL, authorization_servers: [BASE_URL] });
    return;
  }

  // 3. Dynamic Client Registration (RFC 7591)
  if (req.method === "POST" && p === "/register") {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    sendJson(res, 201, {
      client_id: "cli2cli-joule-bridge",
      client_secret: MCP_TOKEN,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      redirect_uris: meta.redirect_uris || [],
      grant_types: meta.grant_types || ["authorization_code"],
      response_types: meta.response_types || ["code"],
      token_endpoint_auth_method: meta.token_endpoint_auth_method || "none"
    });
    return;
  }

  // 4. OAuth 2.0 PKCE Authorization (auto-approve local single-user workstation)
  if (req.method === "GET" && p === "/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const state = url.searchParams.get("state") || "";
    const code = randomBytes(16).toString("hex");
    authCodes.set(code, { redirect_uri: redirectUri, expires: Date.now() + 300_000 });
    const cb = new URL(redirectUri);
    cb.searchParams.set("code", code);
    cb.searchParams.set("state", state);
    res.writeHead(302, { Location: cb.toString() });
    res.end();
    return;
  }

  // 5. OAuth 2.0 Token Exchange (RFC 6749)
  if (req.method === "POST" && p === "/token") {
    const body = await readBody(req);
    const ct = req.headers["content-type"] || "";
    const params = ct.includes("application/json")
      ? (JSON.parse(body || "{}") as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(body));

    if (params.grant_type === "authorization_code") {
      const stored = authCodes.get(params.code || "");
      if (!stored || stored.expires < Date.now()) {
        sendJson(res, 400, { error: "invalid_grant" });
        return;
      }
      authCodes.delete(params.code!);
    }
    validTokens.add(MCP_TOKEN);
    sendJson(res, 200, { access_token: MCP_TOKEN, token_type: "Bearer", expires_in: 86400 });
    return;
  }

  // 6. OpenAPI 3.0 Spec for Joule Actions / REST integrations
  if (req.method === "GET" && p === "/openapi.json") {
    sendJson(res, 200, {
      openapi: "3.0.3",
      info: {
        title: "cli2cli-mcp Multi-Terminal PTY Orchestrator API",
        version: "0.2.0",
        description:
          "Spawn and orchestrate unlimited concurrent interactive CLI terminals (claude, gemini, agy, shell, custom) from SAP Joule Work Desktop."
      },
      servers: [{ url: BASE_URL }],
      paths: {
        "/api/sessions": {
          get: { operationId: "listSessions", summary: "List all active and exited CLI terminal sessions" }
        },
        "/api/spawn": {
          post: { operationId: "spawnSession", summary: "Spawn a new CLI terminal session" }
        },
        "/api/spawn-fleet": {
          post: { operationId: "spawnFleet", summary: "Spawn N concurrent CLI terminal sessions in parallel" }
        },
        "/api/read": {
          post: { operationId: "readStream", summary: "Non-destructively read PTY output and 4-state status" }
        },
        "/api/write": {
          post: { operationId: "writeInput", summary: "Send stdin input or HITL (y/n) confirmation to a session" }
        },
        "/api/wait": {
          post: { operationId: "waitSession", summary: "Event-driven wait for state change or regex pattern" }
        },
        "/api/terminate": {
          post: { operationId: "terminateSession", summary: "Terminate a CLI session (or 'all')" }
        }
      }
    });
    return;
  }

  // 7. REST API convenience routes (/api/*)
  if (p.startsWith("/api/")) {
    const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    try {
      if (req.method === "GET" && p === "/api/sessions") {
        sendJson(res, 200, await executeToolCall("list_cli_sessions", {}, "joule-rest"));
        return;
      }
      if (req.method === "POST" && p === "/api/spawn") {
        sendJson(res, 200, await executeToolCall("spawn_cli_session", body, "joule-rest"));
        return;
      }
      if (req.method === "POST" && p === "/api/spawn-fleet") {
        sendJson(res, 200, await executeToolCall("spawn_cli_fleet", body, "joule-rest"));
        return;
      }
      if (req.method === "POST" && p === "/api/read") {
        sendJson(res, 200, await executeToolCall("read_cli_stream", body, "joule-rest"));
        return;
      }
      if (req.method === "POST" && p === "/api/write") {
        sendJson(res, 200, await executeToolCall("write_cli_input", body, "joule-rest"));
        return;
      }
      if (req.method === "POST" && p === "/api/wait") {
        sendJson(res, 200, await executeToolCall("wait_cli_session", body, "joule-rest"));
        return;
      }
      if (req.method === "POST" && p === "/api/terminate") {
        sendJson(res, 200, await executeToolCall("terminate_cli_session", body, "joule-rest"));
        return;
      }
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  // 8. Streamable HTTP MCP endpoint (/ and /mcp) for SAP Joule Work Desktop
  if (p === "/" || p === "/mcp") {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token || !validTokens.has(token)) {
      sendJson(
        res,
        401,
        { error: "unauthorized" },
        {
          "WWW-Authenticate": `Bearer realm="${BASE_URL}", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`
        }
      );
      return;
    }

    if (req.method === "GET") {
      sendJson(res, 405, { error: "Method Not Allowed — use POST" });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    let message: {
      jsonrpc?: string;
      id?: number | string | null;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      message = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    if (message.id === undefined || message.id === null || message.method?.startsWith("notifications/")) {
      res.writeHead(202);
      res.end();
      return;
    }

    try {
      const rpcResponse = await handleMcpRpc(message);
      const sessionId =
        (req.headers["mcp-session-id"] as string) || "sess-" + randomBytes(8).toString("hex");
      sendJson(res, 200, rpcResponse, { "Mcp-Session-Id": sessionId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: msg }
      });
    }
    return;
  }

  sendJson(res, 404, {
    error: "Not found",
    endpoints: ["/", "/mcp", "/health", "/openapi.json", "/api/sessions"]
  });
}

async function start(): Promise<void> {
  await helm.ensureConnected();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : "Internal server error" });
      }
    });
  });

  server.listen(PORT, () => {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║   cli2cli-joule — SAP Joule Work Desktop Gateway (v0.2.0)    ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");
    console.log(`  Base URL   : ${BASE_URL}`);
    console.log(`  OpenAPI    : ${BASE_URL}/openapi.json`);
    console.log(`  Tools      : ${TOOLS.length} (${TOOLS.map((t) => t.name).join(", ")})`);
    console.log(`  Daemon Pipe: \\\\.\\pipe\\cli2cli-helm (unlimited PTY slots 1..N)`);
    console.log(`\n  Register in SAP Joule Work Desktop:`);
    console.log(`    Extensions → Connectors → + New → Add Connector`);
    console.log(`    Name: CLI2CLI Multi-Terminal Orchestrator`);
    console.log(`    URL : ${BASE_URL}   (leave Client ID / Secret blank)\n`);
  });
}

start().catch((err) => {
  console.error("[cli2cli-joule] FATAL:", err);
  process.exit(1);
});
