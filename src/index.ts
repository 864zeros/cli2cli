/**
 * @864zeros/cli2cli-mcp
 *
 * Bi-directional MCP bridge that drives headless interactive AI CLIs
 * (Claude Code, Gemini CLI, or any command) inside a pseudo-terminal.
 *
 * Exposed tools:
 *   - spawn_cli_session     allocate a PTY and launch a CLI
 *   - read_cli_stream       drain buffered output + read HITL/exit state
 *   - write_cli_input       feed stdin (confirmations, answers, prompts)
 *   - list_cli_sessions     enumerate live sessions
 *   - terminate_cli_session kill a session and free resources
 *
 * Target host is Windows (ConPTY); paths and binary resolution are
 * win32-aware but the server also runs on POSIX.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import * as pty from "node-pty";
import { v4 as uuidv4 } from "uuid";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";

const IS_WIN = process.platform === "win32";

/** Bound each session's retained output so a chatty CLI can't grow unbounded. */
const MAX_BUFFER_CHARS = 200_000;

/**
 * Heuristic for detecting an interactive confirmation prompt in a CLI's
 * output stream. When this matches, the session is flagged so the gateway
 * can surface a Human-in-the-Loop decision instead of hanging forever.
 */
const HITL_PROMPT_PATTERN =
  /(\(y\/n\)|\[y\/n\]|yes\/no|approve|confirm|proceed\??|overwrite|are you sure|press enter|choose an option|select an option|❯)/i;

interface CLISession {
  id: string;
  cliType: string;
  command: string;
  args: string[];
  cwd: string;
  process: pty.IPty;
  /** Unread output since the last read_cli_stream drain. */
  buffer: string;
  /** Set when HITL_PROMPT_PATTERN last matched and no input has been sent since. */
  isWaitingForInput: boolean;
  exitCode: number | null;
  startedAt: number;
}

const sessions = new Map<string, CLISession>();

/** Preset commands per known cli_type. `custom` uses caller-supplied command/args. */
function resolvePreset(
  cliType: string,
  initialPrompt: string,
  command?: string,
  args?: string[]
): { command: string; args: string[] } {
  switch (cliType) {
    case "claude":
      // Safe, generic default: one-shot --print. This substrate stays
      // un-opinionated; callers that need autonomous execution (e.g. the AOE)
      // pass their own flags (--dangerously-skip-permissions, etc.) via the
      // "custom" cli_type. Keeps cli2cli-mcp independently sellable.
      return { command: "claude", args: initialPrompt ? ["--print", initialPrompt] : ["--print"] };
    case "gemini":
      return { command: "gemini", args: initialPrompt ? [initialPrompt] : [] };
    case "shell":
      return IS_WIN
        ? { command: "cmd.exe", args: initialPrompt ? ["/c", initialPrompt] : [] }
        : { command: "bash", args: initialPrompt ? ["-c", initialPrompt] : [] };
    case "custom":
      if (!command) throw new Error("cli_type 'custom' requires a 'command'.");
      return { command, args: args ?? [] };
    default:
      throw new Error(`Unknown cli_type: ${cliType}`);
  }
}

/**
 * Resolve a bare command name to an on-disk executable. On Windows the
 * install is frequently a .cmd/.exe shim on PATH (e.g. claude.cmd), which
 * ConPTY needs spelled out. Returns the original name if nothing is found
 * (node-pty will then do its own resolution / surface a spawn error).
 */
function resolveCommand(command: string): string {
  if (command.includes("/") || command.includes("\\")) return command; // explicit path
  if (!IS_WIN) return command;

  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);

  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
    const bare = join(dir, command);
    if (existsSync(bare)) return bare;
  }
  return command;
}

/**
 * Drop env vars whose value is an obvious unfilled placeholder (e.g. a stray
 * ANTHROPIC_API_KEY="your-api-key-here" that would override real OAuth creds and
 * break the spawned CLI). Placeholders should never be propagated to children.
 */
const PLACEHOLDER_VALUE = /^(your[-_].*[-_]here|change[-_]?me|placeholder|x{3,}|<.*>|todo)$/i;

function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (PLACEHOLDER_VALUE.test(value.trim())) continue;
    out[key] = value;
  }
  return out;
}

function appendToBuffer(session: CLISession, data: string): void {
  session.buffer += data;
  if (session.buffer.length > MAX_BUFFER_CHARS) {
    session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_CHARS);
  }
}

const TOOLS: Tool[] = [
  {
    name: "spawn_cli_session",
    description:
      "Spawn a new interactive CLI session inside a PTY. Use cli_type 'claude' or 'gemini' for the known AI CLIs, 'shell' for a one-off command, or 'custom' with an explicit command/args. Returns a session_id used by the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        cli_type: {
          type: "string",
          enum: ["claude", "gemini", "shell", "custom"],
          description: "Which CLI to launch."
        },
        initial_prompt: {
          type: "string",
          description:
            "Initial prompt/instruction (claude/gemini) or command line (shell). Optional for custom."
        },
        working_dir: {
          type: "string",
          description: "Working directory for the session. Defaults to the server CWD."
        },
        command: {
          type: "string",
          description: "For cli_type 'custom': the executable to run."
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "For cli_type 'custom': argument vector."
        }
      },
      required: ["cli_type"]
    }
  },
  {
    name: "read_cli_stream",
    description:
      "Drain and return unread output from a session's PTY, plus whether it is waiting on an interactive (HITL) prompt and whether it has exited.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Active session id." }
      },
      required: ["session_id"]
    }
  },
  {
    name: "write_cli_input",
    description:
      "Write text to a session's stdin (a newline is appended). Use for confirmations (y/n), answers, or follow-up prompts. Clears the waiting-for-input flag.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Active session id." },
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
    name: "list_cli_sessions",
    description: "List all known sessions with their type, cwd, waiting/exited state.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "terminate_cli_session",
    description: "Kill a session's PTY process and release its resources.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Active session id." }
      },
      required: ["session_id"]
    }
  }
];

const server = new Server(
  { name: "864zeros-cli2cli-bridge", version: "0.1.0" },
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
        const cliType = String(args.cli_type);
        const initialPrompt = args.initial_prompt ? String(args.initial_prompt) : "";
        const cwd = args.working_dir ? String(args.working_dir) : process.cwd();

        const preset = resolvePreset(
          cliType,
          initialPrompt,
          args.command ? String(args.command) : undefined,
          Array.isArray(args.args) ? (args.args as string[]) : undefined
        );
        const command = resolveCommand(preset.command);

        const proc = pty.spawn(command, preset.args, {
          name: "xterm-256color",
          cols: 120,
          rows: 40,
          cwd,
          env: scrubEnv(process.env)
        });

        const sessionId = uuidv4();
        const session: CLISession = {
          id: sessionId,
          cliType,
          command,
          args: preset.args,
          cwd,
          process: proc,
          buffer: "",
          isWaitingForInput: false,
          exitCode: null,
          startedAt: Date.now()
        };

        proc.onData((data) => {
          appendToBuffer(session, data);
          if (HITL_PROMPT_PATTERN.test(data)) session.isWaitingForInput = true;
        });
        proc.onExit(({ exitCode }) => {
          session.exitCode = exitCode;
          session.isWaitingForInput = false;
        });

        sessions.set(sessionId, session);

        return ok({
          status: "SPAWNED",
          session_id: sessionId,
          cli_type: cliType,
          command,
          working_dir: cwd
        });
      }

      case "read_cli_stream": {
        const session = sessions.get(String(args.session_id));
        if (!session) throw new Error(`Session ${args.session_id} not found.`);

        const output = session.buffer;
        session.buffer = "";

        return ok({
          session_id: session.id,
          output,
          is_waiting_for_input: session.isWaitingForInput,
          is_exited: session.exitCode !== null,
          exit_code: session.exitCode
        });
      }

      case "write_cli_input": {
        const session = sessions.get(String(args.session_id));
        if (!session) throw new Error(`Session ${args.session_id} not found.`);
        if (session.exitCode !== null) throw new Error(`Session ${session.id} has already exited.`);

        const text = String(args.input_text ?? "");
        const appendNewline = args.append_newline !== false;
        session.process.write(appendNewline ? `${text}\r` : text);
        session.isWaitingForInput = false;

        return ok({ status: "INPUT_SENT", session_id: session.id });
      }

      case "list_cli_sessions": {
        return ok({
          sessions: [...sessions.values()].map((s) => ({
            session_id: s.id,
            cli_type: s.cliType,
            command: s.command,
            working_dir: s.cwd,
            is_waiting_for_input: s.isWaitingForInput,
            is_exited: s.exitCode !== null,
            exit_code: s.exitCode,
            uptime_ms: Date.now() - s.startedAt
          }))
        });
      }

      case "terminate_cli_session": {
        const session = sessions.get(String(args.session_id));
        if (!session) throw new Error(`Session ${args.session_id} not found.`);
        try {
          session.process.kill();
        } catch {
          /* already dead */
        }
        sessions.delete(session.id);
        return ok({ status: "TERMINATED", session_id: session.id });
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP transport.
  process.stderr.write("[cli2cli-mcp] 864zeros bridge online (stdio)\n");
}

run().catch((err) => {
  process.stderr.write(`[cli2cli-mcp] FATAL: ${err?.stack ?? err}\n`);
  process.exit(1);
});
