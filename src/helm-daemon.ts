/**
 * helm-daemon.ts — Persistent Background PTY Runtime for cli2cli-helm
 *
 * Hosts all interactive CLI sessions (ConPTY on Windows, POSIX PTY on Unix)
 * inside a persistent background daemon accessible over a local Named Pipe /
 * Unix Domain Socket (`\\.\pipe\cli2cli-helm` or `~/.cli2cli/helm.sock`).
 *
 * Features:
 *   1. Persistent PTY lifecycle decoupled from MCP stdio or TUI clients.
 *   2. Non-destructive cursor-indexed ring buffer (multiple readers never steal bytes).
 *   3. Deterministic 4-state engine: WORKING | BLOCKED | IDLE | EXITED.
 *   4. Dual signal detection: Open Program Status Protocol (OSC 7501) + ANSI regex fallback.
 *   5. Event-driven `session.wait` (zero polling required).
 *   6. Real-time push notifications (`session.output`, `session.state_changed`) for TUI/AOE.
 *   7. Automatic `HELM_SESSION_ID`, `HELM_SLOT`, and `HELM_PIPE` env injection (Helm Link).
 */

import * as net from "node:net";
import * as pty from "node-pty";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { v4 as uuidv4 } from "uuid";

export const IS_WIN = process.platform === "win32";

export const DEFAULT_PIPE_PATH = IS_WIN
  ? "\\\\.\\pipe\\cli2cli-helm"
  : join(homedir(), ".cli2cli", "helm.sock");

/** Maximum retained characters per session ring buffer. */
export const MAX_BUFFER_CHARS = 500_000;

/** Milliseconds of silence before a WORKING session transitions to IDLE. */
export const IDLE_THRESHOLD_MS = 3_000;

export type SessionState = "WORKING" | "BLOCKED" | "IDLE" | "EXITED";

/**
 * Heuristic for detecting an interactive confirmation prompt in a CLI's
 * output stream when the CLI does not emit explicit OSC 7501 sequences.
 */
export const HITL_PROMPT_PATTERN =
  /(\(y\/n\)|\[y\/n\]|yes\/no|approve|confirm|proceed\??|overwrite|are you sure|press enter|choose an option|select an option|❯)/i;

/**
 * Open Program Status Protocol (OSC 7501):
 * Matches `\x1b]7501;state=<working|blocked|idle|done>(;...)?(\x07|\x1b\\)`
 */
// eslint-disable-next-line no-control-regex
export const OSC_7501_PATTERN = /\x1B\]7501;([^\x07\x1B]*)(?:\x07|\x1B\\)/g;

/** Strip ANSI CSI/OSC escape sequences so regex matching works across color codes. */
// eslint-disable-next-line no-control-regex
export const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_PATTERN, "");
}

export interface SessionSummary {
  session_id: string;
  slot: number;
  cli_type: string;
  command: string;
  args: string[];
  working_dir: string;
  state: SessionState;
  is_waiting_for_input: boolean;
  is_exited: boolean;
  exit_code: number | null;
  uptime_ms: number;
  write_cursor: number;
  pid: number;
}

export interface ReadStreamResult {
  session_id: string;
  slot: number;
  output: string;
  next_cursor: number;
  state: SessionState;
  is_waiting_for_input: boolean;
  is_exited: boolean;
  exit_code: number | null;
}

interface ManagedSession {
  id: string;
  slot: number;
  cliType: string;
  command: string;
  args: string[];
  cwd: string;
  process: pty.IPty;
  /** Retained ring buffer of raw output characters. */
  ringBuffer: string;
  /** Monotonically increasing total character count ever written to this session. */
  writeCursor: number;
  /** Named consumer cursors (e.g. default "mcp" consumer when no explicit cursor is passed). */
  consumerCursors: Map<string, number>;
  /** Rolling plain-text tail used for cross-chunk HITL prompt detection. */
  recentTail: string;
  state: SessionState;
  /** Explicit state override set via OSC 7501 until next output/input transition. */
  oscStateOverride: SessionState | null;
  exitCode: number | null;
  startedAt: number;
  lastActivityAt: number;
  idleTimer: NodeJS.Timeout | null;
  events: EventEmitter;
}

/** Preset commands per known cli_type. `custom` uses caller-supplied command/args. */
export function resolvePreset(
  cliType: string,
  initialPrompt: string,
  command?: string,
  args?: string[],
  interactive = true
): { command: string; args: string[] } {
  const userArgs = args && args.length > 0 ? args : null;

  switch (cliType) {
    case "claude":
      if (userArgs) return { command: "claude", args: userArgs };
      if (!interactive) {
        return {
          command: "claude",
          args: initialPrompt ? ["--print", initialPrompt] : ["--print"]
        };
      }
      return {
        command: "claude",
        args: initialPrompt ? [initialPrompt] : []
      };
    case "gemini":
      return {
        command: "gemini",
        args: userArgs ?? (initialPrompt ? [initialPrompt] : [])
      };
    case "antigravity":
    case "agy":
      return {
        command: "agy",
        args: userArgs ?? (initialPrompt ? [initialPrompt] : [])
      };
    case "shell":
      return IS_WIN
        ? { command: "cmd.exe", args: userArgs ?? (initialPrompt ? ["/c", initialPrompt] : []) }
        : { command: "bash", args: userArgs ?? (initialPrompt ? ["-c", initialPrompt] : []) };
    case "custom":
      if (!command) throw new Error("cli_type 'custom' requires a 'command'.");
      return { command, args: args ?? [] };
    default:
      throw new Error(`Unknown cli_type: ${cliType}`);
  }
}

export function resolveCommand(command: string): string {
  if (command.includes("/") || command.includes("\\")) return command;
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

const PLACEHOLDER_VALUE = /^(your[-_].*[-_]here|change[-_]?me|placeholder|x{3,}|<.*>|todo)$/i;

export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (PLACEHOLDER_VALUE.test(value.trim())) continue;
    out[key] = value;
  }
  return out;
}

const TAIL_WINDOW_CHARS = 512;

export class HelmDaemon {
  private sessions = new Map<string, ManagedSession>();
  private subscribers = new Set<net.Socket>();
  private server: net.Server | null = null;
  private pipePath: string;

  constructor(pipePath: string = DEFAULT_PIPE_PATH) {
    this.pipePath = pipePath;
  }

  private allocateSlot(requestedSlot?: number): number {
    const usedSlots = new Set<number>();
    for (const s of this.sessions.values()) {
      if (s.state !== "EXITED") {
        usedSlots.add(s.slot);
      }
    }
    if (requestedSlot && requestedSlot >= 1 && !usedSlots.has(requestedSlot)) {
      return requestedSlot;
    }
    let slot = 1;
    while (usedSlots.has(slot)) {
      slot++;
    }
    return slot;
  }

  private resolveSession(idOrSlot: string | number): ManagedSession {
    const key = String(idOrSlot).trim();
    const direct = this.sessions.get(key);
    if (direct) return direct;

    const slotNum = Number(key);
    if (Number.isInteger(slotNum) && slotNum >= 1) {
      // Prefer active non-exited session in that slot, otherwise most recent in that slot
      let match: ManagedSession | undefined;
      for (const s of this.sessions.values()) {
        if (s.slot === slotNum) {
          if (s.state !== "EXITED") return s;
          match = s;
        }
      }
      if (match) return match;
    }

    // Also allow prefix matching on UUID
    for (const s of this.sessions.values()) {
      if (s.id.startsWith(key)) return s;
    }

    throw new Error(`Session '${idOrSlot}' not found.`);
  }

  private setSessionState(session: ManagedSession, nextState: SessionState): void {
    const prev = session.state;
    if (prev === nextState) return;
    session.state = nextState;
    session.events.emit("state", nextState, prev);
    this.broadcastNotification("session.state_changed", {
      session_id: session.id,
      slot: session.slot,
      previous_state: prev,
      state: nextState,
      is_waiting_for_input: nextState === "BLOCKED",
      is_exited: nextState === "EXITED",
      exit_code: session.exitCode
    });
  }

  private scheduleIdleCheck(session: ManagedSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.state === "EXITED" || session.state === "BLOCKED") return;

    session.idleTimer = setTimeout(() => {
      if (session.state === "WORKING") {
        this.setSessionState(session, "IDLE");
      }
    }, IDLE_THRESHOLD_MS);
  }

  private parseOsc7501(session: ManagedSession, data: string): string {
    let parsedState: SessionState | null = null;
    const cleaned = data.replace(OSC_7501_PATTERN, (_full, payload: string) => {
      const pairs = payload.split(/[;:]/);
      for (let i = 0; i < pairs.length; i++) {
        const part = pairs[i] ?? "";
        if (part.startsWith("state=")) {
          const val = part.slice("state=".length).toLowerCase();
          if (val === "blocked") parsedState = "BLOCKED";
          else if (val === "working") parsedState = "WORKING";
          else if (val === "idle" || val === "done") parsedState = "IDLE";
        } else if (part === "state" && pairs[i + 1]) {
          const val = pairs[i + 1]!.toLowerCase();
          if (val === "blocked") parsedState = "BLOCKED";
          else if (val === "working") parsedState = "WORKING";
          else if (val === "idle" || val === "done") parsedState = "IDLE";
        }
      }
      return "";
    });

    if (parsedState) {
      session.oscStateOverride = parsedState;
      this.setSessionState(session, parsedState);
    }
    return cleaned;
  }

  private handlePtyData(session: ManagedSession, rawData: string): void {
    session.lastActivityAt = Date.now();

    // 1. Check and strip OSC 7501 status sequences before buffering
    const data = this.parseOsc7501(session, rawData);
    if (!data) return;

    // 2. Append to non-destructive cursor ring buffer
    session.ringBuffer += data;
    session.writeCursor += data.length;
    if (session.ringBuffer.length > MAX_BUFFER_CHARS) {
      session.ringBuffer = session.ringBuffer.slice(session.ringBuffer.length - MAX_BUFFER_CHARS);
    }

    // 3. Update rolling plain-text tail for cross-chunk HITL prompt detection
    const plainChunk = stripAnsi(data);
    session.recentTail = (session.recentTail + plainChunk).slice(-TAIL_WINDOW_CHARS);

    // 4. Evaluate 4-state transition if not explicitly locked to BLOCKED by OSC 7501
    if (HITL_PROMPT_PATTERN.test(session.recentTail)) {
      this.setSessionState(session, "BLOCKED");
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
    } else if (session.oscStateOverride !== "BLOCKED") {
      session.oscStateOverride = null;
      if (session.state !== "EXITED") {
        this.setSessionState(session, "WORKING");
        this.scheduleIdleCheck(session);
      }
    }

    session.events.emit("data", data, session.writeCursor);
    this.broadcastNotification("session.output", {
      session_id: session.id,
      slot: session.slot,
      chunk: data,
      write_cursor: session.writeCursor,
      state: session.state
    });
  }

  public spawnSession(params: {
    cli_type: string;
    initial_prompt?: string;
    working_dir?: string;
    command?: string;
    args?: string[];
    interactive?: boolean;
    slot?: number;
    cols?: number;
    rows?: number;
  }): SessionSummary {
    const cliType = String(params.cli_type);
    const initialPrompt = params.initial_prompt ? String(params.initial_prompt) : "";
    const cwd = params.working_dir ? String(params.working_dir) : process.cwd();
    const interactive = params.interactive !== false;
    const cols = params.cols ?? 120;
    const rows = params.rows ?? 40;

    const preset = resolvePreset(
      cliType,
      initialPrompt,
      params.command ? String(params.command) : undefined,
      Array.isArray(params.args) ? params.args : undefined,
      interactive
    );
    const command = resolveCommand(preset.command);
    const sessionId = uuidv4();
    const slot = this.allocateSlot(params.slot);

    const childEnv = {
      ...scrubEnv(process.env),
      HELM_SESSION_ID: sessionId,
      HELM_SLOT: String(slot),
      HELM_PIPE: this.pipePath
    };

    const proc = pty.spawn(command, preset.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: childEnv
    });

    const session: ManagedSession = {
      id: sessionId,
      slot,
      cliType,
      command,
      args: preset.args,
      cwd,
      process: proc,
      ringBuffer: "",
      writeCursor: 0,
      consumerCursors: new Map<string, number>(),
      recentTail: "",
      state: "WORKING",
      oscStateOverride: null,
      exitCode: null,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimer: null,
      events: new EventEmitter()
    };
    session.events.setMaxListeners(50);

    this.scheduleIdleCheck(session);

    proc.onData((data) => {
      this.handlePtyData(session, data);
    });

    proc.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      this.setSessionState(session, "EXITED");
    });

    this.sessions.set(sessionId, session);
    return this.toSummary(session);
  }

  /**
   * Non-destructive read from the session's ring buffer.
   * - If `cursor` (number) is provided, reads from that exact byte/char offset to `writeCursor`.
   * - Otherwise uses a per-consumer named cursor (`consumer_id`, default `"default"`), advancing
   *   only that consumer's cursor so TUI, MCP, and AOE never steal each other's output.
   */
  public readSession(params: {
    session_id: string;
    cursor?: number;
    consumer_id?: string;
    tail_chars?: number;
  }): ReadStreamResult {
    const session = this.resolveSession(params.session_id);
    const earliestAvailable = session.writeCursor - session.ringBuffer.length;

    let readFrom: number;
    if (typeof params.cursor === "number" && Number.isFinite(params.cursor)) {
      readFrom = Math.max(earliestAvailable, Math.min(params.cursor, session.writeCursor));
    } else if (typeof params.tail_chars === "number" && params.tail_chars > 0) {
      readFrom = Math.max(earliestAvailable, session.writeCursor - params.tail_chars);
    } else {
      const consumerId = params.consumer_id ?? "default";
      const saved = session.consumerCursors.get(consumerId) ?? 0;
      readFrom = Math.max(earliestAvailable, Math.min(saved, session.writeCursor));
      session.consumerCursors.set(consumerId, session.writeCursor);
    }

    const offsetInRing = readFrom - earliestAvailable;
    const output = session.ringBuffer.slice(offsetInRing);

    return {
      session_id: session.id,
      slot: session.slot,
      output,
      next_cursor: session.writeCursor,
      state: session.state,
      is_waiting_for_input: session.state === "BLOCKED",
      is_exited: session.state === "EXITED",
      exit_code: session.exitCode
    };
  }

  public writeSession(params: {
    session_id: string;
    input_text: string;
    append_newline?: boolean;
  }): { status: string; session_id: string; slot: number; state: SessionState } {
    const session = this.resolveSession(params.session_id);
    if (session.state === "EXITED") {
      throw new Error(`Session ${session.id} (slot ${session.slot}) has already exited.`);
    }

    const text = String(params.input_text ?? "");
    const appendNewline = params.append_newline !== false;
    session.process.write(appendNewline ? `${text}\r` : text);

    session.oscStateOverride = null;
    session.recentTail = "";
    this.setSessionState(session, "WORKING");
    this.scheduleIdleCheck(session);

    return {
      status: "INPUT_SENT",
      session_id: session.id,
      slot: session.slot,
      state: session.state
    };
  }

  public async waitSession(params: {
    session_id: string;
    until?: Array<"blocked" | "waiting_for_input" | "idle" | "exited" | "pattern">;
    pattern?: string;
    timeout_ms?: number;
    cursor?: number;
    consumer_id?: string;
  }): Promise<ReadStreamResult & { matched_condition: string; timed_out: boolean }> {
    const session = this.resolveSession(params.session_id);
    const targets = new Set(
      (params.until && params.until.length > 0
        ? params.until
        : ["blocked", "idle", "exited"]
      ).map((u) => (u === "waiting_for_input" ? "blocked" : u.toLowerCase()))
    );
    const timeoutMs = Math.max(100, Math.min(params.timeout_ms ?? 60_000, 600_000));
    const userRegex = params.pattern ? new RegExp(params.pattern, "i") : null;

    const checkImmediate = (): string | null => {
      if (targets.has("exited") && session.state === "EXITED") return "exited";
      if (targets.has("blocked") && session.state === "BLOCKED") return "blocked";
      if (targets.has("idle") && session.state === "IDLE") return "idle";
      if (userRegex && userRegex.test(session.recentTail)) return "pattern";
      return null;
    };

    const immediate = checkImmediate();
    if (immediate) {
      const readRes = this.readSession({
        session_id: session.id,
        cursor: params.cursor,
        consumer_id: params.consumer_id
      });
      return { ...readRes, matched_condition: immediate, timed_out: false };
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (matched: string, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.events.off("state", onState);
        session.events.off("data", onData);
        const readRes = this.readSession({
          session_id: session.id,
          cursor: params.cursor,
          consumer_id: params.consumer_id
        });
        resolve({ ...readRes, matched_condition: matched, timed_out: timedOut });
      };

      const onState = (nextState: SessionState) => {
        if (nextState === "EXITED" && targets.has("exited")) finish("exited", false);
        else if (nextState === "BLOCKED" && targets.has("blocked")) finish("blocked", false);
        else if (nextState === "IDLE" && targets.has("idle")) finish("idle", false);
      };

      const onData = () => {
        if (userRegex && userRegex.test(session.recentTail)) {
          finish("pattern", false);
        }
      };

      const timer = setTimeout(() => {
        finish("timeout", true);
      }, timeoutMs);

      session.events.on("state", onState);
      session.events.on("data", onData);
    });
  }

  public resizeSession(params: { session_id: string; cols: number; rows: number }): {
    status: string;
    session_id: string;
    cols: number;
    rows: number;
  } {
    const session = this.resolveSession(params.session_id);
    const cols = Math.max(20, Math.floor(params.cols));
    const rows = Math.max(5, Math.floor(params.rows));
    if (session.state !== "EXITED") {
      session.process.resize(cols, rows);
    }
    return { status: "RESIZED", session_id: session.id, cols, rows };
  }

  public listSessions(): { sessions: SessionSummary[] } {
    const list = [...this.sessions.values()]
      .sort((a, b) => a.slot - b.slot || a.startedAt - b.startedAt)
      .map((s) => this.toSummary(s));
    return { sessions: list };
  }

  public terminateSession(params: { session_id: string }): {
    status: string;
    session_id: string;
    slot: number;
  } {
    const session = this.resolveSession(params.session_id);
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    try {
      session.process.kill();
    } catch {
      /* already dead */
    }
    this.setSessionState(session, "EXITED");
    this.sessions.delete(session.id);
    return { status: "TERMINATED", session_id: session.id, slot: session.slot };
  }

  private toSummary(s: ManagedSession): SessionSummary {
    return {
      session_id: s.id,
      slot: s.slot,
      cli_type: s.cliType,
      command: s.command,
      args: s.args,
      working_dir: s.cwd,
      state: s.state,
      is_waiting_for_input: s.state === "BLOCKED",
      is_exited: s.state === "EXITED",
      exit_code: s.exitCode,
      uptime_ms: Date.now() - s.startedAt,
      write_cursor: s.writeCursor,
      pid: s.process.pid
    };
  }

  private broadcastNotification(method: string, params: unknown): void {
    if (this.subscribers.size === 0) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    for (const sock of this.subscribers) {
      if (sock.destroyed) {
        this.subscribers.delete(sock);
        continue;
      }
      try {
        sock.write(payload);
      } catch {
        this.subscribers.delete(sock);
      }
    }
  }

  private async handleRpc(
    socket: net.Socket,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    switch (method) {
      case "daemon.ping":
        return {
          status: "OK",
          pid: process.pid,
          uptime_ms: Math.floor(process.uptime() * 1000),
          active_sessions: this.sessions.size,
          pipe: this.pipePath
        };
      case "daemon.subscribe":
        this.subscribers.add(socket);
        return { status: "SUBSCRIBED" };
      case "session.spawn":
        return {
          status: "SPAWNED",
          ...this.spawnSession(params as Parameters<HelmDaemon["spawnSession"]>[0])
        };
      case "session.read":
        return this.readSession(params as Parameters<HelmDaemon["readSession"]>[0]);
      case "session.write":
        return this.writeSession(params as Parameters<HelmDaemon["writeSession"]>[0]);
      case "session.wait":
        return await this.waitSession(params as Parameters<HelmDaemon["waitSession"]>[0]);
      case "session.resize":
        return this.resizeSession(params as Parameters<HelmDaemon["resizeSession"]>[0]);
      case "session.list":
        return this.listSessions();
      case "session.terminate":
        return this.terminateSession(params as Parameters<HelmDaemon["terminateSession"]>[0]);
      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  public async listen(): Promise<void> {
    if (!IS_WIN) {
      const sockDir = join(homedir(), ".cli2cli");
      mkdirSync(sockDir, { recursive: true });
      if (existsSync(this.pipePath)) {
        try {
          unlinkSync(this.pipePath);
        } catch {
          /* ignore */
        }
      }
    }

    this.server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;

          void (async () => {
            let reqId: number | string | null = null;
            try {
              const req = JSON.parse(line) as {
                id?: number | string;
                method: string;
                params?: Record<string, unknown>;
              };
              reqId = req.id ?? null;
              const result = await this.handleRpc(socket, req.method, req.params ?? {});
              if (reqId !== null) {
                socket.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, result }) + "\n");
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (reqId !== null) {
                socket.write(
                  JSON.stringify({ jsonrpc: "2.0", id: reqId, error: { message } }) + "\n"
                );
              }
            }
          })();
        }
      });

      socket.on("close", () => {
        this.subscribers.delete(socket);
      });
      socket.on("error", () => {
        this.subscribers.delete(socket);
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.pipePath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
  }
}

// Allow running directly as a standalone background daemon process (`node dist/helm-daemon.js`)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("helm-daemon.js") || process.argv[1].endsWith("helm-daemon.ts"));

if (isDirectRun) {
  const pipe = process.env.HELM_PIPE ?? DEFAULT_PIPE_PATH;
  const daemon = new HelmDaemon(pipe);
  daemon
    .listen()
    .then(() => {
      process.stderr.write(`[cli2cli-helm] daemon listening on ${pipe} (pid ${process.pid})\n`);
    })
    .catch((err) => {
      process.stderr.write(`[cli2cli-helm] daemon failed to start: ${err?.stack ?? err}\n`);
      process.exit(1);
    });
}
