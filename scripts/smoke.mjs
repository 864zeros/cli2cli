/**
 * End-to-end smoke test for cli2cli-mcp.
 * Spawns the built server over stdio, drives a `shell` session, and prints
 * the round-tripped output. No external CLI (claude/gemini) required.
 *
 * Usage:  npm run build && node scripts/smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (res) => JSON.parse(res.content[0].text);

const transport = new StdioClientTransport({ command: "node", args: [serverPath] });
const client = new Client({ name: "cli2cli-smoke", version: "0.1.0" }, { capabilities: {} });

await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const spawnRes = parse(
  await client.callTool({
    name: "spawn_cli_session",
    arguments: {
      cli_type: "shell",
      initial_prompt: process.platform === "win32" ? "echo hello-from-cli2cli" : "echo hello-from-cli2cli"
    }
  })
);
console.log("spawned:", spawnRes.session_id, "->", spawnRes.command);

await sleep(1500);

const readRes = parse(
  await client.callTool({
    name: "read_cli_stream",
    arguments: { session_id: spawnRes.session_id }
  })
);
console.log("--- stream output ---");
console.log(readRes.output.trim());
console.log("--- exited:", readRes.is_exited, "code:", readRes.exit_code, "---");

const pass = readRes.output.includes("hello-from-cli2cli");
console.log(pass ? "\nSMOKE PASS ✅" : "\nSMOKE FAIL ❌");

await client.close();
process.exit(pass ? 0 : 1);
