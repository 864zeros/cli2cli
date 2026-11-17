/**
 * cli2cli-mcp (src/index.ts)
 *
 * Bi-directional MCP bridge that connects any MCP host (SAP Joule Work Desktop,
 * Claude Code, Gemini CLI, Antigravity, Cursor, or cli2cli-aoe) to the
 * persistent `cli2cli-helm` daemon.
 *
 * Exposed tools:
 *   - spawn_cli_session     allocate a persistent PTY slot (1..N) and launch a CLI
 *   - spawn_cli_fleet       spawn any number of concurrent CLI terminal sessions in one call
 *   - read_cli_stream       non-destructively read PTY output + 4-state / HITL status
 *   - write_cli_input       feed stdin (confirmations, answers, prompts)
 *   - wait_cli_session      block until state change (blocked, idle, exited) or regex match
 *   - list_cli_sessions     enumerate live sessions across the daemon
 *   - terminate_cli_session kill a session (or 'all') and free resources
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "node:url";
import { HelmClient } from "./helm-client.js";
import type { SessionSummary } from "./helm-daemon.js";

const CONSUMER_ID = `mcp-${uuidv4().slice(0, 8)}`;
export const helm = new HelmClient();

export const TOOLS: Tool[] = [
  {
    name: "spawn_cli_session",
    description:
      "Spawn a new persistent interactive CLI terminal session inside the cli2cli-helm PTY daemon. Supports unlimited concurrent slots (1..N). Use cli_type 'claude', 'gemini', 'antigravity'/'agy' for known AI CLIs, 'shell' for a shell command, or 'custom' with an explicit command/args. Returns session_id and slot.",
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
          description: "Optional preferred slot number (1..N; unlimited concurrent slots supported)."
        }
      },
      required: ["cli_type"]
    }
  },
  {
    name: "spawn_cli_fleet",
    description:
      "Spawn multiple concurrent CLI terminal sessions in parallel inside the cli2cli-helm PTY daemon. Pass either a 'sessions' array of per-terminal specs (heterogeneous CLIs/directories/prompts) or 'count' + template fields to fan out N identical terminals.",
    inputSchema: {
      type: "object",
      properties: {
        sessions: {
          type: "array",
          description: "Explicit list of terminal session specifications to spawn concurrently.",
          items: {
            type: "object",
            properties: {
              cli_type: {
                type: "string",
                enum: ["claude", "gemini", "antigravity", "agy", "shell", "custom"]
              },
              initial_prompt: { type: "string" },
              working_dir: { type: "string" },
              command: { type: "string" },
              args: { type: "array", items: { type: "string" } },
              interactive: { type: "boolean" },
              slot: { type: "number" }
            },
            required: ["cli_type"]
          }
        },
        count: {
          type: "number",
          description: "Number of homogeneous terminal sessions to spawn when 'sessions' is omitted (1..64)."
        },
        cli_type: {
          type: "string",
          enum: ["claude", "gemini", "antigravity", "agy", "shell", "custom"],
          description: "Template CLI type when using 'count'."
        },
        initial_prompt: {
          type: "string",
          description: "Template initial prompt or command when using 'count'."
        },
        working_dir: {
          type: "string",
          description: "Template working directory when using 'count'."
        },
        command: {
          type: "string",
          description: "Template executable for cli_type 'custom' when using 'count'."
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Template args for cli_type 'custom' when using 'count'."
        },
        interactive: {
          type: "boolean",
          description: "Keep spawned sessions interactive (default true)."
        }
      }
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
          description: "Active session UUID or slot number (e.g. '1', '2', '12')."
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
    description:
      "Kill a session's PTY process and release its resources. Pass session_id='all' to terminate all active sessions.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Active session UUID, slot number (e.g. '1'), or 'all' to terminate every session."
        }
      },
      required: ["session_id"]
    }
  }
];

export async function executeToolCall(
  name: string,
  rawArgs: Record<string, unknown> = {},
  consumerId: string = CONSUMER_ID
): Promise<unknown> {
  const args = rawArgs ?? {};

  switch (name) {
    case "spawn_cli_session": {
      return await helm.request("session.spawn", {
        ...args,
        working_dir: args.working_dir ?? process.cwd()
      });
    }

    case "spawn_cli_fleet": {
      const sessions = Array.isArray(args.sessions)
        ? (args.sessions as Array<Record<string, unknown>>).map((s) => ({
            ...s,
            working_dir: s.working_dir ?? args.working_dir ?? process.cwd()
          }))
        : undefined;
      return await helm.request("session.spawn_fleet", {
        ...args,
        ...(sessions ? { sessions } : {}),
        working_dir: args.working_dir ?? process.cwd()
      });
    }

    case "read_cli_stream": {
      return await helm.request("session.read", {
        session_id: String(args.session_id),
        cursor: typeof args.cursor === "number" ? args.cursor : undefined,
        tail_chars: typeof args.tail_chars === "number" ? args.tail_chars : undefined,
        consumer_id: consumerId
      });
    }

    case "write_cli_input": {
      return await helm.request("session.write", {
        session_id: String(args.session_id),
        input_text: String(args.input_text ?? ""),
        append_newline: args.append_newline !== false
      });
    }

    case "wait_cli_session": {
      return await helm.request("session.wait", {
        session_id: String(args.session_id),
        until: Array.isArray(args.until) ? args.until : undefined,
        pattern: typeof args.pattern === "string" ? args.pattern : undefined,
        timeout_ms: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        cursor: typeof args.cursor === "number" ? args.cursor : undefined,
        consumer_id: consumerId
      });
    }

    case "list_cli_sessions": {
      return await helm.request("session.list", {});
    }

    case "terminate_cli_session": {
      const target = String(args.session_id).trim();
      if (target.toLowerCase() === "all") {
        const list = await helm.request<{ sessions: SessionSummary[] }>("session.list", {});
        const terminated: Array<{ session_id: string; slot: number }> = [];
        for (const s of list.sessions) {
          try {
            await helm.request("session.terminate", { session_id: s.session_id });
            terminated.push({ session_id: s.session_id, slot: s.slot });
          } catch {
            /* ignore */
          }
        }
        return { status: "TERMINATED_ALL", count: terminated.length, terminated };
      }
      return await helm.request("session.terminate", {
        session_id: target
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createMcpServer(): Server {
  const server = new Server(
    { name: "cli2cli-bridge", version: "0.2.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const list = await helm.request<{ sessions: SessionSummary[] }>("session.list", {});
    return {
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
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "cli2cli://session/{session_id}",
        name: "CLI2CLI Session Output & Status by Slot or UUID",
        description: "Non-destructively inspect the tail output and 4-state status of any CLI session.",
        mimeType: "application/json"
      }
    ]
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === "cli2cli://sessions") {
      const list = await helm.request("session.list", {});
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(list, null, 2)
          }
        ]
      };
    }
    const prefix = "cli2cli://session/";
    if (uri.startsWith(prefix)) {
      const id = decodeURIComponent(uri.slice(prefix.length));
      const res = await helm.request("session.read", {
        session_id: id,
        tail_chars: 4000,
        consumer_id: CONSUMER_ID
      });
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(res, null, 2)
          }
        ]
      };
    }
    throw new Error(`Unknown resource URI: ${uri}`);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    try {
      const res = await executeToolCall(name, (rawArgs ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: JSON.stringify(res) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal bridge error";
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  });

  return server;
}

const isDirectRun =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === process.argv[1] ||
    process.argv[1].endsWith("index.js") ||
    process.argv[1].endsWith("index.ts"));

if (isDirectRun) {
  (async () => {
    await helm.ensureConnected();
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("[cli2cli-mcp] connected to helm-daemon & online (stdio)\n");
  })().catch((err) => {
    process.stderr.write(`[cli2cli-mcp] FATAL: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
