/**
 * Nucleus — Single-Terminal Mission Control Cockpit for cli2cli-mcp
 *
 * Supervises and steers up to 8 simultaneous CLI sessions (Claude Code,
 * Gemini CLI, Antigravity, Shell, Custom) over MCP stdio + ConPTY.
 *
 * Capabilities:
 *   1. Connects to dist/index.js via MCP StdioClientTransport (single consumer)
 *   2. Live 8-slot status grid (status, uptime, waiting/HITL badge, exit code)
 *   3. Audio (\x07 BEL) + flashing visual alert when any worker hits HITL (y/n)
 *   4. Keys 1–8 switch slot focus; quick y/n HITL keys, prompt injection (i/Enter),
 *      raw keystroke passthrough (r), quick-spawn (s), HITL demo probe (d), kill (k)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "index.js");
const LOG_DIR = join(__dirname, "..", "logs");

const SLOT_COUNT = 8;
const MAX_SCROLLBACK_LINES = 500;
const POLL_INTERVAL_MS = 200;

type CockpitMode = "NAV" | "INPUT" | "SPAWN" | "RAW";

interface SlotState {
  slot: number; // 1..8
  sessionId: string | null;
  cliType: string;
  command: string;
  cwd: string;
  isWaitingForInput: boolean;
  isExited: boolean;
  exitCode: number | null;
  uptimeMs: number;
  lines: string[];
  partialLine: string;
  scrollOffset: number; // 0 = pinned to bottom
  unreadHitlAlert: boolean;
  finalDrained: boolean;
  logFile: string | null;
}

interface SessionSummary {
  session_id: string;
  cli_type: string;
  command: string;
  working_dir: string;
  is_waiting_for_input: boolean;
  is_exited: boolean;
  exit_code: number | null;
  uptime_ms: number;
}

interface ReadStreamResult {
  session_id: string;
  output: string;
  is_waiting_for_input: boolean;
  is_exited: boolean;
  exit_code: number | null;
}

// ANSI styling constants
const ESC = "\x1b";
const CSI = `${ESC}[`;
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const FG_BLACK = `${CSI}30m`;
const FG_RED = `${CSI}31m`;
const FG_GREEN = `${CSI}32m`;
const FG_YELLOW = `${CSI}33m`;
const FG_BLUE = `${CSI}34m`;
const FG_MAGENTA = `${CSI}35m`;
const FG_CYAN = `${CSI}36m`;
const FG_WHITE = `${CSI}37m`;
const BG_RED = `${CSI}41m`;
const BG_GREEN = `${CSI}42m`;
const BG_YELLOW = `${CSI}43m`;
const BG_BLUE = `${CSI}44m`;
const BG_MAGENTA = `${CSI}45m`;
const BG_CYAN = `${CSI}46m`;
const BG_GRAY = `${CSI}100m`;

// Strip cursor movement / screen clear CSI sequences from child PTY output
// while preserving SGR color codes (\x1b[...m) so child output cannot corrupt the cockpit grid.
// eslint-disable-next-line no-control-regex
const UNSAFE_CSI_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[A-LN-Za-ln-z@-~]|\].*?(?:\x07|\x1B\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const ALL_ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g;

function sanitizePtyLine(line: string): string {
  return line
    .replace(UNSAFE_CSI_PATTERN, (match) => (match.endsWith("m") && match.startsWith("\x1b[") ? match : ""))
    .replace(/[\x00-\x08\x0B-\x1A\x1C-\x1F\x7F]/g, "")
    .replace(/\t/g, "  ");
}

function visibleLength(str: string): string {
  return str.replace(ALL_ANSI_PATTERN, "");
}

function truncateAnsi(str: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  const plain = visibleLength(str);
  if (plain.length <= maxCols) return str;
  // Walk string preserving SGR sequences up to maxCols visible chars
  let vis = 0;
  let out = "";
  let i = 0;
  while (i < str.length && vis < maxCols - 1) {
    if (str[i] === "\x1b" && str[i + 1] === "[") {
      const end = str.indexOf("m", i);
      if (end !== -1) {
        out += str.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += str[i];
    vis++;
    i++;
  }
  return out + RESET + "…";
}

function padVisible(str: string, width: number): string {
  const len = visibleLength(str).length;
  if (len >= width) return truncateAnsi(str, width);
  return str + " ".repeat(width - len);
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function createEmptySlot(slotNum: number): SlotState {
  return {
    slot: slotNum,
    sessionId: null,
    cliType: "-",
    command: "",
    cwd: process.cwd(),
    isWaitingForInput: false,
    isExited: false,
    exitCode: null,
    uptimeMs: 0,
    lines: [],
    partialLine: "",
    scrollOffset: 0,
    unreadHitlAlert: false,
    finalDrained: false,
    logFile: null
  };
}

class NucleusCockpit {
  private client!: Client;
  private transport!: StdioClientTransport;
  private slots: SlotState[] = Array.from({ length: SLOT_COUNT }, (_, i) => createEmptySlot(i + 1));
  private focusedIndex = 0; // 0..7
  private mode: CockpitMode = "NAV";
  private inputBuffer = "";
  private statusBanner = "Ready. Press [s] to spawn a CLI session, [d] for HITL demo, [1-8] to switch slots.";
  private statusBannerIsAlert = false;
  private tickCount = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private shuttingDown = false;

  async start(): Promise<void> {
    mkdirSync(LOG_DIR, { recursive: true });

    this.transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_PATH],
      stderr: "pipe"
    });
    this.client = new Client({ name: "cli2cli-nucleus", version: "0.1.0" }, { capabilities: {} });
    await this.client.connect(this.transport);

    this.setupTerminal();
    this.render();

    this.pollTimer = setInterval(() => {
      void this.pollTick();
    }, POLL_INTERVAL_MS);
  }

  private setupTerminal(): void {
    // Enter alternate screen buffer, hide cursor, clear screen
    process.stdout.write(`${CSI}?1049h${CSI}?25l${CSI}2J${CSI}H`);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      void this.handleKey(key);
    });

    process.stdout.on("resize", () => {
      process.stdout.write(`${CSI}2J${CSI}H`);
      this.render();
    });
  }

  private restoreTerminal(): void {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    process.stdout.write(`${RESET}${CSI}?25h${CSI}?1049l`);
  }

  private async callMcpTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await this.client.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text?: string }>;
    const text = content?.[0]?.text ?? "{}";
    if (res.isError) {
      throw new Error(text);
    }
    return JSON.parse(text) as T;
  }

  private appendOutputToSlot(slot: SlotState, rawChunk: string): void {
    if (!rawChunk) return;

    if (slot.logFile) {
      try {
        appendFileSync(slot.logFile, rawChunk, "utf8");
      } catch {
        /* ignore log write errors */
      }
    }

    // Normalize line endings: handle \r\n as newline, bare \r as line overwrite
    const combined = slot.partialLine + rawChunk;
    const segments = combined.split("\n");
    slot.partialLine = segments.pop() ?? "";

    for (const rawSeg of segments) {
      // If bare \r exists inside the line, keep the text after the last non-empty \r overwrite
      const crParts = rawSeg.replace(/\r$/, "").split("\r");
      const effective = crParts[crParts.length - 1] ?? "";
      const cleaned = sanitizePtyLine(effective);
      slot.lines.push(cleaned);
    }

    // Also handle bare \r overwrites in the active partial line
    if (slot.partialLine.includes("\r")) {
      const crParts = slot.partialLine.split("\r");
      slot.partialLine = crParts[crParts.length - 1] ?? "";
    }

    if (slot.lines.length > MAX_SCROLLBACK_LINES) {
      slot.lines.splice(0, slot.lines.length - MAX_SCROLLBACK_LINES);
    }
  }

  private async pollTick(): Promise<void> {
    if (this.isPolling || this.shuttingDown) return;
    this.isPolling = true;
    this.tickCount++;

    try {
      const listRes = await this.callMcpTool<{ sessions: SessionSummary[] }>("list_cli_sessions");
      const byId = new Map<string, SessionSummary>();
      for (const s of listRes.sessions) {
        byId.set(s.session_id, s);
      }

      // Auto-bind any externally spawned session to the first empty slot
      for (const s of listRes.sessions) {
        const alreadyBound = this.slots.some((slot) => slot.sessionId === s.session_id);
        if (!alreadyBound) {
          const empty = this.slots.find((slot) => slot.sessionId === null);
          if (empty) {
            this.bindSlotSession(empty, s.session_id, s.cli_type, s.command, s.working_dir);
          }
        }
      }

      // Drain streams and update statuses for all active slots
      for (const slot of this.slots) {
        if (!slot.sessionId) continue;

        const summary = byId.get(slot.sessionId);
        if (summary) {
          slot.uptimeMs = summary.uptime_ms;
          slot.command = summary.command;
          slot.cwd = summary.working_dir;
        }

        if (!slot.finalDrained) {
          try {
            const streamRes = await this.callMcpTool<ReadStreamResult>("read_cli_stream", {
              session_id: slot.sessionId
            });

            if (streamRes.output) {
              this.appendOutputToSlot(slot, streamRes.output);
            }

            const wasWaiting = slot.isWaitingForInput;
            slot.isWaitingForInput = streamRes.is_waiting_for_input;
            slot.isExited = streamRes.is_exited;
            slot.exitCode = streamRes.exit_code;

            // Rising-edge HITL alert trigger
            if (!wasWaiting && slot.isWaitingForInput) {
              slot.unreadHitlAlert = true;
              this.statusBanner = `🔔 HITL PROMPT in Slot ${slot.slot} (${slot.cliType})! Press [${slot.slot}] then [y]/[n] or [Enter].`;
              this.statusBannerIsAlert = true;
              // Emit terminal BEL for audio alert
              process.stdout.write("\x07");
            }

            if (slot.isExited) {
              slot.finalDrained = true;
              slot.isWaitingForInput = false;
              slot.unreadHitlAlert = false;
            }
          } catch {
            slot.isExited = true;
            slot.finalDrained = true;
          }
        }
      }

      this.render();
    } catch (err) {
      this.statusBanner = `Poll error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.isPolling = false;
    }
  }

  private bindSlotSession(
    slot: SlotState,
    sessionId: string,
    cliType: string,
    command: string,
    cwd: string
  ): void {
    slot.sessionId = sessionId;
    slot.cliType = cliType;
    slot.command = command;
    slot.cwd = cwd;
    slot.isWaitingForInput = false;
    slot.isExited = false;
    slot.exitCode = null;
    slot.uptimeMs = 0;
    slot.lines = [
      `${ FG_CYAN }[Nucleus] Bound Slot ${slot.slot} -> ${cliType} (${sessionId.slice(0, 8)})${RESET}`,
      `${ DIM }[Nucleus] CWD: ${cwd}${RESET}`
    ];
    slot.partialLine = "";
    slot.scrollOffset = 0;
    slot.unreadHitlAlert = false;
    slot.finalDrained = false;
    slot.logFile = join(LOG_DIR, `slot-${slot.slot}-${sessionId.slice(0, 8)}.log`);
  }

  private async spawnInSlot(slotIndex: number, spec: string): Promise<void> {
    const slot = this.slots[slotIndex];
    if (slot.sessionId && !slot.isExited) {
      this.statusBanner = `Slot ${slot.slot} is still running. Press [k] to terminate it first.`;
      this.statusBannerIsAlert = true;
      this.render();
      return;
    }

    const trimmed = spec.trim();
    const parts = trimmed ? trimmed.split(/\s+/) : ["shell"];
    const firstToken = parts[0].toLowerCase();
    const restText = trimmed.slice(parts[0].length).trim();

    const knownTypes = new Set(["claude", "gemini", "antigravity", "agy", "shell", "custom"]);
    let cliType = "shell";
    let initialPrompt = "";
    let customCommand: string | undefined;
    let customArgs: string[] | undefined;

    if (knownTypes.has(firstToken)) {
      cliType = firstToken;
      if (cliType === "custom") {
        const customParts = restText.split(/\s+/).filter(Boolean);
        customCommand = customParts[0] ?? "cmd.exe";
        customArgs = customParts.slice(1);
      } else {
        initialPrompt = restText;
      }
    } else {
      // Treat arbitrary command as a shell command or interactive shell
      cliType = "shell";
      initialPrompt = trimmed;
    }

    try {
      this.statusBanner = `Spawning '${cliType}' in Slot ${slot.slot}...`;
      this.statusBannerIsAlert = false;
      this.render();

      const res = await this.callMcpTool<{
        session_id: string;
        cli_type: string;
        command: string;
        working_dir: string;
      }>("spawn_cli_session", {
        cli_type: cliType,
        ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
        ...(customCommand ? { command: customCommand } : {}),
        ...(customArgs ? { args: customArgs } : {}),
        working_dir: process.cwd()
      });

      this.bindSlotSession(slot, res.session_id, res.cli_type, res.command, res.working_dir);
      this.statusBanner = `Spawned ${res.cli_type} in Slot ${slot.slot} (${res.session_id.slice(0, 8)}).`;
      this.statusBannerIsAlert = false;
      this.render();
    } catch (err) {
      this.statusBanner = `Spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.statusBannerIsAlert = true;
      this.render();
    }
  }

  private async spawnHitlDemoInSlot(slotIndex: number): Promise<void> {
    const slot = this.slots[slotIndex];
    if (slot.sessionId && !slot.isExited) {
      this.statusBanner = `Slot ${slot.slot} is busy. Switch to an empty slot or press [k] first.`;
      this.statusBannerIsAlert = true;
      this.render();
      return;
    }

    const demoScript = [
      "process.stdout.write('\\x1b[36m[Worker] Scanning repository files...\\x1b[0m\\n');",
      "setTimeout(() => {",
      "  process.stdout.write('\\x1b[33m[Worker] Ready to apply patch to src/index.ts. Approve changes? (y/n): \\x1b[0m');",
      "}, 600);",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  const ans = chunk.trim().toLowerCase();",
      "  if (ans.startsWith('y')) {",
      "    console.log('\\n\\x1b[32m[Worker] Approved! Patch applied cleanly.\\x1b[0m');",
      "    process.exit(0);",
      "  } else {",
      "    console.log('\\n\\x1b[31m[Worker] Rejected by operator. Aborting.\\x1b[0m');",
      "    process.exit(1);",
      "  }",
      "});"
    ].join(" ");

    try {
      const res = await this.callMcpTool<{
        session_id: string;
        cli_type: string;
        command: string;
        working_dir: string;
      }>("spawn_cli_session", {
        cli_type: "custom",
        command: "node",
        args: ["-e", demoScript],
        working_dir: process.cwd()
      });

      this.bindSlotSession(slot, res.session_id, "hitl-demo", res.command, res.working_dir);
      this.statusBanner = `Launched HITL probe in Slot ${slot.slot}. Wait 0.6s for bell + ⚠️ WAIT alert!`;
      this.statusBannerIsAlert = false;
      this.render();
    } catch (err) {
      this.statusBanner = `Demo spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      this.statusBannerIsAlert = true;
      this.render();
    }
  }

  private async sendSlotInput(slotIndex: number, text: string, appendNewline = true): Promise<void> {
    const slot = this.slots[slotIndex];
    if (!slot.sessionId || slot.isExited) {
      this.statusBanner = `Slot ${slot.slot} has no live session to receive input.`;
      this.statusBannerIsAlert = true;
      this.render();
      return;
    }

    try {
      await this.callMcpTool("write_cli_input", {
        session_id: slot.sessionId,
        input_text: text,
        append_newline: appendNewline
      });
      slot.isWaitingForInput = false;
      slot.unreadHitlAlert = false;
      slot.scrollOffset = 0;
      const display = appendNewline ? JSON.stringify(text) : `raw(${JSON.stringify(text)})`;
      this.statusBanner = `Sent ${display} -> Slot ${slot.slot} (${slot.cliType}).`;
      this.statusBannerIsAlert = false;
      this.render();
    } catch (err) {
      this.statusBanner = `Write error: ${err instanceof Error ? err.message : String(err)}`;
      this.statusBannerIsAlert = true;
      this.render();
    }
  }

  private async terminateSlot(slotIndex: number): Promise<void> {
    const slot = this.slots[slotIndex];
    if (!slot.sessionId) {
      this.statusBanner = `Slot ${slot.slot} is already empty.`;
      this.render();
      return;
    }

    try {
      await this.callMcpTool("terminate_cli_session", { session_id: slot.sessionId });
    } catch {
      /* session may have already exited */
    }

    const oldType = slot.cliType;
    this.slots[slotIndex] = createEmptySlot(slot.slot);
    this.statusBanner = `Terminated and cleared Slot ${slot.slot} (${oldType}).`;
    this.statusBannerIsAlert = false;
    this.render();
  }

  private async handleKey(key: string): Promise<void> {
    // Global emergency exit: Ctrl+C in NAV mode, or Ctrl+Q anywhere
    if (key === "\x11" || (key === "\x03" && this.mode === "NAV")) {
      await this.shutdown();
      return;
    }

    const focused = this.slots[this.focusedIndex];

    if (this.mode === "RAW") {
      // Esc or Ctrl+] exits RAW passthrough mode
      if (key === "\x1b" || key === "\x1d") {
        this.mode = "NAV";
        this.statusBanner = `Exited RAW mode for Slot ${focused.slot}.`;
        this.statusBannerIsAlert = false;
        this.render();
        return;
      }
      await this.sendSlotInput(this.focusedIndex, key, false);
      return;
    }

    if (this.mode === "INPUT" || this.mode === "SPAWN") {
      if (key === "\x1b" || key === "\x03") {
        this.mode = "NAV";
        this.inputBuffer = "";
        this.statusBanner = "Cancelled.";
        this.statusBannerIsAlert = false;
        this.render();
        return;
      }
      if (key === "\r" || key === "\n") {
        const submitted = this.inputBuffer;
        const activeMode = this.mode;
        this.mode = "NAV";
        this.inputBuffer = "";
        if (activeMode === "INPUT") {
          await this.sendSlotInput(this.focusedIndex, submitted, true);
        } else {
          await this.spawnInSlot(this.focusedIndex, submitted);
        }
        return;
      }
      if (key === "\x7f" || key === "\b") {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
        this.render();
        return;
      }
      if (key >= " " && !key.startsWith("\x1b")) {
        this.inputBuffer += key;
        this.render();
      }
      return;
    }

    // NAV mode keybindings
    if (key >= "1" && key <= "8") {
      this.focusedIndex = Number(key) - 1;
      const target = this.slots[this.focusedIndex];
      target.unreadHitlAlert = false;
      this.statusBanner = `Focused Slot ${target.slot} (${target.sessionId ? target.cliType : "EMPTY"}).`;
      this.statusBannerIsAlert = false;
      this.render();
      return;
    }

    if (key === "y" || key === "Y" || key === "n" || key === "N") {
      if (focused.sessionId && !focused.isExited) {
        await this.sendSlotInput(this.focusedIndex, key.toLowerCase(), true);
      } else {
        this.statusBanner = `Slot ${focused.slot} is not running. Press [s] to spawn or [d] for HITL demo.`;
        this.render();
      }
      return;
    }

    if (key === "i" || key === "\r" || key === "\n") {
      if (!focused.sessionId || focused.isExited) {
        this.mode = "SPAWN";
        this.inputBuffer = "";
        this.statusBanner = `Slot ${focused.slot} is empty — enter CLI to spawn (e.g. 'shell', 'claude', 'gemini', 'agy'):`;
        this.render();
        return;
      }
      this.mode = "INPUT";
      this.inputBuffer = "";
      this.render();
      return;
    }

    if (key === "s" || key === "S") {
      this.mode = "SPAWN";
      this.inputBuffer = "";
      this.render();
      return;
    }

    if (key === "d" || key === "D") {
      await this.spawnHitlDemoInSlot(this.focusedIndex);
      return;
    }

    if (key === "r" || key === "R") {
      if (focused.sessionId && !focused.isExited) {
        this.mode = "RAW";
        this.statusBanner = `RAW keystroke mode active on Slot ${focused.slot}. Press [Esc] to return to NAV.`;
        this.statusBannerIsAlert = false;
        this.render();
      } else {
        this.statusBanner = `Slot ${focused.slot} has no live session for RAW mode.`;
        this.render();
      }
      return;
    }

    if (key === "k" || key === "K") {
      await this.terminateSlot(this.focusedIndex);
      return;
    }

    // Scrollback navigation: Up/Down arrows and PageUp/PageDown
    if (key === `${CSI}A`) {
      focused.scrollOffset = Math.min(
        Math.max(0, focused.lines.length - 5),
        focused.scrollOffset + 1
      );
      this.render();
      return;
    }
    if (key === `${CSI}B`) {
      focused.scrollOffset = Math.max(0, focused.scrollOffset - 1);
      this.render();
      return;
    }
    if (key === `${CSI}5~`) {
      focused.scrollOffset = Math.min(
        Math.max(0, focused.lines.length - 5),
        focused.scrollOffset + 10
      );
      this.render();
      return;
    }
    if (key === `${CSI}6~`) {
      focused.scrollOffset = Math.max(0, focused.scrollOffset - 10);
      this.render();
      return;
    }

    if (key === "q" || key === "Q") {
      await this.shutdown();
    }
  }

  private renderSlotBadge(slot: SlotState, isFocused: boolean, cellWidth: number): string {
    const innerWidth = Math.max(16, cellWidth);
    const focusPrefix = isFocused ? "▶" : " ";
    const typeLabel = slot.cliType.slice(0, 7).padEnd(7, " ");

    let stateTag: string;
    let colorPrefix: string;

    if (!slot.sessionId) {
      stateTag = "EMPTY";
      colorPrefix = isFocused ? `${BG_BLUE}${FG_WHITE}${BOLD}` : `${DIM}${FG_WHITE}`;
    } else if (slot.isWaitingForInput) {
      const flash = this.tickCount % 2 === 0;
      stateTag = "⚠️ WAIT y/n";
      colorPrefix = flash
        ? `${BG_YELLOW}${FG_BLACK}${BOLD}`
        : `${BG_RED}${FG_WHITE}${BOLD}`;
    } else if (slot.isExited) {
      const code = slot.exitCode ?? 0;
      stateTag = `EX:${String(code).padEnd(2, " ")} ${formatDuration(slot.uptimeMs)}`;
      colorPrefix =
        code === 0
          ? isFocused
            ? `${BG_GRAY}${FG_GREEN}${BOLD}`
            : `${FG_GREEN}`
          : isFocused
          ? `${BG_RED}${FG_WHITE}${BOLD}`
          : `${FG_RED}`;
    } else {
      stateTag = `RUN ${formatDuration(slot.uptimeMs)}`;
      colorPrefix = isFocused ? `${BG_GREEN}${FG_BLACK}${BOLD}` : `${FG_GREEN}${BOLD}`;
    }

    const rawText = `${focusPrefix}[${slot.slot}] ${typeLabel} ${stateTag}`;
    const padded = padVisible(rawText, innerWidth);
    return `${colorPrefix}${padded}${RESET}`;
  }

  private render(): void {
    if (this.shuttingDown) return;

    const cols = Math.max(80, process.stdout.columns || 120);
    const rows = Math.max(20, process.stdout.rows || 32);
    const outRows: string[] = [];

    const waitingCount = this.slots.filter((s) => s.isWaitingForInput).length;
    const runningCount = this.slots.filter((s) => s.sessionId && !s.isExited).length;

    // Row 1: Top Header Bar
    const headerLeft = ` ⚛️  CLI2CLI NUCLEUS COCKPIT  │  Active: ${runningCount}/8  │  HITL Waiting: ${waitingCount}`;
    const headerRight = `Mode: ${this.mode} `;
    const headerSpace = Math.max(1, cols - visibleLength(headerLeft).length - headerRight.length);
    const headerBg = waitingCount > 0 ? `${BG_YELLOW}${FG_BLACK}${BOLD}` : `${BG_BLUE}${FG_WHITE}${BOLD}`;
    outRows.push(`${headerBg}${headerLeft}${" ".repeat(headerSpace)}${headerRight}${RESET}`);

    // Rows 2–3: 8-Slot Status Grid (2 rows × 4 columns; 3 separators " │ " = 9 chars + 2 margin chars = 11 chars)
    const cellWidth = Math.floor((cols - 11) / 4);
    const row1Cells = this.slots
      .slice(0, 4)
      .map((s, idx) => this.renderSlotBadge(s, this.focusedIndex === idx, cellWidth))
      .join(" │ ");
    const row2Cells = this.slots
      .slice(4, 8)
      .map((s, idx) => this.renderSlotBadge(s, this.focusedIndex === idx + 4, cellWidth))
      .join(" │ ");

    outRows.push(padVisible(` ${row1Cells}`, cols));
    outRows.push(padVisible(` ${row2Cells}`, cols));

    // Row 4: Divider + Focused Slot Metadata
    const focused = this.slots[this.focusedIndex];
    const slotStatusText = !focused.sessionId
      ? `${DIM}EMPTY${RESET}`
      : focused.isWaitingForInput
      ? `${BG_YELLOW}${FG_BLACK}${BOLD} ⚠️ WAITING FOR INPUT (y/n) ${RESET}`
      : focused.isExited
      ? `${FG_RED}EXITED (code ${focused.exitCode ?? 0})${RESET}`
      : `${FG_GREEN}${BOLD}RUNNING (${formatDuration(focused.uptimeMs)})${RESET}`;

    const scrollTag =
      focused.scrollOffset > 0 ? ` ${FG_YELLOW}[Scrolled +${focused.scrollOffset}]${RESET}` : "";
    const focusHeader = `${FG_CYAN}${BOLD}━━ SLOT ${focused.slot} [${focused.cliType}]${RESET} │ ${slotStatusText}${scrollTag} │ ${DIM}${focused.cwd}${RESET}`;
    outRows.push(padVisible(focusHeader, cols));

    // Stream Viewport Area: occupies remaining rows minus 3 footer lines
    const streamHeight = Math.max(5, rows - outRows.length - 3);
    const displayLines = [...focused.lines];
    if (focused.partialLine) {
      displayLines.push(sanitizePtyLine(focused.partialLine));
    }

    if (!focused.sessionId && displayLines.length === 0) {
      displayLines.push(
        `${DIM}  Slot ${focused.slot} is empty.${RESET}`,
        `${DIM}  • Press [s] or [Enter] to spawn a CLI session (claude, gemini, agy, shell, custom)${RESET}`,
        `${DIM}  • Press [d] to launch a live HITL confirmation probe (tests audio bell + ⚠️ WAIT + y/n)${RESET}`,
        `${DIM}  • Press [1-8] to switch between the 8 ConPTY slots${RESET}`
      );
    }

    const totalLines = displayLines.length;
    const endIdx = Math.max(0, totalLines - focused.scrollOffset);
    const startIdx = Math.max(0, endIdx - streamHeight);
    const visibleSlice = displayLines.slice(startIdx, endIdx);

    for (let i = 0; i < streamHeight; i++) {
      const line = visibleSlice[i] ?? "";
      outRows.push(truncateAnsi(` ${line}`, cols));
    }

    // Footer 1: Keybinding Bar
    const helpBar =
      `${BG_GRAY}${FG_WHITE} ` +
      `${BOLD}[1-8]${RESET}${BG_GRAY}${FG_WHITE} Slot  ` +
      `${BOLD}[y/n]${RESET}${BG_GRAY}${FG_WHITE} HITL Approve/Reject  ` +
      `${BOLD}[i/Enter]${RESET}${BG_GRAY}${FG_WHITE} Prompt  ` +
      `${BOLD}[s]${RESET}${BG_GRAY}${FG_WHITE} Spawn  ` +
      `${BOLD}[d]${RESET}${BG_GRAY}${FG_WHITE} Demo HITL  ` +
      `${BOLD}[r]${RESET}${BG_GRAY}${FG_WHITE} Raw  ` +
      `${BOLD}[k]${RESET}${BG_GRAY}${FG_WHITE} Kill  ` +
      `${BOLD}[q]${RESET}${BG_GRAY}${FG_WHITE} Quit `;
    outRows.push(padVisible(helpBar, cols) + RESET);

    // Footer 2: Status / Alert Banner
    const bannerStyle = this.statusBannerIsAlert ? `${FG_YELLOW}${BOLD}` : `${FG_CYAN}`;
    outRows.push(padVisible(` ${bannerStyle}${this.statusBanner}${RESET}`, cols));

    // Footer 3: Interactive Command / Input Line
    let promptLine: string;
    if (this.mode === "INPUT") {
      promptLine = `${FG_GREEN}${BOLD} INPUT (Slot ${focused.slot} ${focused.cliType}) > ${RESET}${this.inputBuffer}${BG_GREEN} ${RESET}`;
    } else if (this.mode === "SPAWN") {
      promptLine = `${FG_MAGENTA}${BOLD} SPAWN (Slot ${focused.slot}) [claude|gemini|agy|shell|custom <args>] > ${RESET}${this.inputBuffer}${BG_MAGENTA} ${RESET}`;
    } else if (this.mode === "RAW") {
      promptLine = `${BG_CYAN}${FG_BLACK}${BOLD} RAW PASSTHROUGH (Slot ${focused.slot}) — keystrokes sent directly to PTY ([Esc] to exit) ${RESET}`;
    } else if (focused.isWaitingForInput) {
      promptLine = `${BG_YELLOW}${FG_BLACK}${BOLD} ⚡ Slot ${focused.slot} waiting for input! Press [y] to approve, [n] to reject, or [Enter] to type custom reply. ${RESET}`;
    } else {
      promptLine = `${DIM} [NAV] Focused: Slot ${focused.slot} — Press [Enter] to send input, [s] to spawn, [d] to test HITL.${RESET}`;
    }
    outRows.push(padVisible(promptLine, cols));

    // Paint frame atomically with \r\n line endings for Windows ConPTY compatibility
    const frame = outRows.slice(0, rows).map((r) => `${CSI}2K${r}`).join("\r\n");
    process.stdout.write(`${CSI}H${frame}`);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const slot of this.slots) {
      if (slot.sessionId && !slot.isExited) {
        try {
          await this.callMcpTool("terminate_cli_session", { session_id: slot.sessionId });
        } catch {
          /* ignore */
        }
      }
    }

    try {
      await this.client.close();
    } catch {
      /* ignore */
    }

    this.restoreTerminal();
    process.stdout.write("[Nucleus] Mission control offline.\r\n");
    process.exit(0);
  }
}

const cockpit = new NucleusCockpit();
cockpit.start().catch((err) => {
  process.stdout.write(`\x1b[0m\x1b[?25h\x1b[?1049l`);
  process.stderr.write(`[Nucleus] Fatal error: ${err?.stack ?? err}\r\n`);
  process.exit(1);
});
