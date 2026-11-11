/**
 * cli2cli-mcp (src/index.ts)
 *
 * Bi-directional MCP bridge that connects any MCP host (Claude Code, Gemini CLI,
 * Antigravity, Cursor, or cli2cli-aoe) to the persistent `cli2cli-helm` daemon.
 *
 * Exposed tools:
 *   - spawn_cli_session     allocate a persistent PTY slot and launch a CLI
 *   - read_cli_stream       non-destructively read PTY output + 4-state / HITL status
 *   - write_cli_input       feed stdin (confirmations, answers, prompts)
 *   - wait_cli_session      block until state change (blocked, idle, exited) or regex match
 *   - list_cli_sessions     enumerate live sessions across the daemon
 *   - terminate_cli_session kill a session and free resources
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";
import { HelmClient } from "./helm-client.js";

const CONSUMER_ID = `mcp-${uuidv4().slice(0, 8)}`;
const helm = new HelmClient();

const TOOLS: Tool[] = [
  {
    name: "spawn_cli_session",
    description:
      "Spawn a new persistent interactive CLI session inside the cli2cli-helm PTY daemon. Use cli_type 'claude', 'gemini', 'antigravity'/'agy' for known AI CLIs, 'shell' for a shell command, or 'custom' with an explicit command/args. Returns session_id and slot.",
    inputSchema: {
      type: "object",
      properties: {
        cli_type: {
          type: "string",
          enum: ["claude", "gemini", "antigravity", "agy", "shell", "custom"],
          description: "Which CLI to launch (claude, gemini, antigravity/agy, shell, or custom)."
        },
        initial_prompt: {
          type: "string",
          description:
            "Initial prompt/instruction (claude/gemini/agy) or command line (shell). Optional for custom."
        },
        working_dir: {
          type: "string",
          description: "Working directory for the session. Defaults to the caller/daemon CWD."
        },
        command: {
          type: "string",
          description: "For cli_type 'custom': the executable to run."
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "For cli_type 'custom': argument vector."
        },
        interactive: {
          type: "boolean",
          description:
            "Keep session interactive (default true). Set false for one-shot --print mode on claude."
        },
        slot: {
          type: "number",
          description: "Optional preferred slot number (1..8)."
        }
      },
      required: ["cli_type"]
    }
  },
  {
    name: "read_cli_stream",
    description:
      "Non-destructively read output from a session's PTY ring buffer, plus its 4-state status (WORKING, BLOCKED, IDLE, EXITED), whether it is waiting on an interactive (HITL) prompt, and next_cursor.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Active session UUID or slot number (e.g. '1')."
        },
        cursor: {
          type: "number",
          description:
            "Optional character offset cursor from a previous read_cli_stream call. Omit to read unread output since this MCP client's last read."
        },
        tail_chars: {
          type: "number",
          description: "Optional: peek at the last N characters of the session buffer."
        }
      },
      required: ["session_id"]
    }
  },
  {
    name: "write_cli_input",
    description:
      "Write text to a session's stdin (a newline is appended by default). Use for confirmations (y/n), answers, or follow-up prompts. Clears the BLOCKED / waiting-for-input state.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Active session UUID or slot number (e.g. '1')."
        },
        input_text: { type: "string", description: "Raw text to send (newline auto-appended)." },
        append_newline: {
          type: "boolean",
          description: "Append a trailing newline (default true). Set false to send raw keystrokes."
        }
      },
      required: ["session_id", "input_text"]
    }
  },
  {
    name: "wait_cli_session",
    description:
      "Event-driven wait: blocks until the target session transitions to one of the requested states ('blocked', 'idle', 'exited') or emits output matching a regex 'pattern'. Eliminates polling loops.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Active session UUID or slot number (e.g. '1')."
        },
        until: {
          type: "array",
          items: {
            type: "string",
            enum: ["blocked", "waiting_for_input", "idle", "exited", "pattern"]
          },
          description: "Conditions that resolve the wait (default: ['blocked', 'idle', 'exited'])."
        },
        pattern: {
          type: "string",
          description: "Optional regex pattern to match against recent output."
        },
        timeout_ms: {
          type: "number",
          description: "Maximum time to wait in milliseconds (default 60000)."
        },
        cursor: {
          type: "number",
          description: "Optional read cursor to return output accumulated since that offset."
        }
      },
      required: ["session_id"]
    }
  },
  {
    name: "list_cli_sessions",
    description:
      "List all active and exited sessions in the cli2cli-helm daemon with their slot, type, cwd, 4-state (WORKING, BLOCKED, IDLE, EXITED), and uptime.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "terminate_cli_session",
    description: "Kill a session's PTY process and release its resources.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Active session UUID or slot number (e.g. '1')."
        }
      },
      required: ["session_id"]
    }
  }
];

const server = new Server(
  { name: "cli2cli-bridge", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "spawn_cli_session": {
        const res = await helm.request("session.spawn", {
          ...args,
          working_dir: args.working_dir ?? process.cwd()
        });
        return ok(res);
      }

      case "read_cli_stream": {
        const res = await helm.request("session.read", {
          session_id: String(args.session_id),
          cursor: typeof args.cursor === "number" ? args.cursor : undefined,
          tail_chars: typeof args.tail_chars === "number" ? args.tail_chars : undefined,
          consumer_id: CONSUMER_ID
        });
        return ok(res);
      }

      case "write_cli_input": {
        const res = await helm.request("session.write", {
          session_id: String(args.session_id),
          input_text: String(args.input_text ?? ""),
          append_newline: args.append_newline !== false
        });
        return ok(res);
      }

      case "wait_cli_session": {
        const res = await helm.request("session.wait", {
          session_id: String(args.session_id),
          until: Array.isArray(args.until) ? args.until : undefined,
          pattern: typeof args.pattern === "string" ? args.pattern : undefined,
          timeout_ms: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          cursor: typeof args.cursor === "number" ? args.cursor : undefined,
          consumer_id: CONSUMER_ID
        });
        return ok(res);
      }

      case "list_cli_sessions": {
        const res = await helm.request("session.list", {});
        return ok(res);
      }

      case "terminate_cli_session": {
        const res = await helm.request("session.terminate", {
          session_id: String(args.session_id)
        });
        return ok(res);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal bridge error";
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
});

async function run(): Promise<void> {
  await helm.ensureConnected();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[cli2cli-mcp] connected to helm-daemon & online (stdio)\n");
}

run().catch((err) => {
  process.stderr.write(`[cli2cli-mcp] FATAL: ${err?.stack ?? err}\n`);
  process.exit(1);
});
