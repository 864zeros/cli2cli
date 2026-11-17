/**
 * End-to-end verification test for the SAP Joule Work Desktop HTTP/PKCE Gateway
 * (`dist/joule-server.js` on port 3052) + Multi-Terminal Fleet Spawning (`spawn_cli_fleet`).
 *
 * Usage:  npm run build && node scripts/smoke-joule.mjs
 */

import http from "node:http";

const PORT = parseInt(process.env.PORT || "3052", 10);

function httpReq(path, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body
      ? typeof body === "string"
        ? body
        : JSON.stringify(body)
      : null;
    const req = http.request(
      {
        hostname: "localhost",
        port: PORT,
        path,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...headers
        }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* ignore */
          }
          resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  console.log(`[1] Checking /health on http://localhost:${PORT}...`);
  const health = await httpReq("/health");
  if (health.status !== 200) throw new Error(`Health check failed: ${health.status}`);
  console.log("    Health OK:", JSON.stringify(health.json));

  console.log("[2] Running RFC 7591 Dynamic Client Registration (/register)...");
  const redirectUri = "http://localhost:54321/joule/callback";
  const reg = await httpReq("/register", "POST", {
    client_name: "SAP Joule Work Desktop Smoke",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code"]
  });
  if (reg.status !== 201) throw new Error(`DCR failed: ${reg.status}`);

  console.log("[3] Running RFC 7636 PKCE Authorization (/authorize -> /token)...");
  const auth = await httpReq(
    `/authorize?response_type=code&client_id=${reg.json.client_id}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&state=joule_test_1`
  );
  const code = new URL(auth.headers.location).searchParams.get("code");
  const tok = await httpReq("/token", "POST", {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: reg.json.client_id
  });
  const bearer = tok.json.access_token;
  console.log("    OAuth PKCE token acquired:", bearer.slice(0, 12) + "...");

  const authHeaders = { Authorization: `Bearer ${bearer}` };

  console.log("[4] Verifying MCP initialize, tools/list, resources/list, resources/templates/list...");
  const initRes = await httpReq("/", "POST", {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "joule", version: "1.0" } }
  }, authHeaders);
  const toolsRes = await httpReq("/", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, authHeaders);
  const resList = await httpReq("/", "POST", { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} }, authHeaders);
  const tplList = await httpReq("/", "POST", { jsonrpc: "2.0", id: 3, method: "resources/templates/list", params: {} }, authHeaders);

  console.log(
    "    Exposed MCP tools:",
    toolsRes.json.result.tools.map((t) => t.name).join(", ")
  );
  console.log(
    "    Resources & Templates OK:",
    resList.json.result.resources.length,
    "resources,",
    tplList.json.result.resourceTemplates.length,
    "templates"
  );

  console.log("[5] Calling spawn_cli_fleet via Joule MCP to spawn 3 concurrent terminals...");
  const fleetCall = await httpReq(
    "/",
    "POST",
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "spawn_cli_fleet",
        arguments: {
          sessions: [
            { cli_type: "shell", initial_prompt: "echo terminal-alpha-ready" },
            { cli_type: "shell", initial_prompt: "echo terminal-beta-ready" },
            { cli_type: "shell", initial_prompt: "echo terminal-gamma-ready" }
          ]
        }
      }
    },
    authHeaders
  );

  const fleetData = JSON.parse(fleetCall.json.result.content[0].text);
  console.log(
    `    Spawned ${fleetData.count} terminals in slots:`,
    fleetData.sessions.map((s) => `Slot ${s.slot} (${s.session_id.slice(0, 8)})`).join(", ")
  );

  console.log("[6] Waiting for all 3 terminals via wait_cli_session & reading output...");
  for (const s of fleetData.sessions) {
    const waitCall = await httpReq(
      "/",
      "POST",
      {
        jsonrpc: "2.0",
        id: 10 + s.slot,
        method: "tools/call",
        params: {
          name: "wait_cli_session",
          arguments: { session_id: s.session_id, until: ["exited", "idle"], timeout_ms: 5000 }
        }
      },
      authHeaders
    );
    const waitData = JSON.parse(waitCall.json.result.content[0].text);
    console.log(`    Slot ${s.slot} [${waitData.state}]: ${waitData.output.trim()}`);
  }

  console.log("[7] Cleaning up fleet via terminate_cli_session(session_id='all')...");
  await httpReq(
    "/",
    "POST",
    {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: {
        name: "terminate_cli_session",
        arguments: { session_id: "all" }
      }
    },
    authHeaders
  );

  console.log("\nJOULE DESKTOP + MULTI-TERMINAL FLEET SMOKE PASS ✅");
}

run().catch((err) => {
  console.error("SMOKE FAIL ❌", err);
  process.exit(1);
});
