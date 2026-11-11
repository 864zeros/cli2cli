#!/usr/bin/env node
/**
 * cli2cli-helm — Dual-Mode CLI & Multi-Pane TUI Multiplexer (`src/nucleus.ts`)
 *
 * 1. Scriptable JSON CLI (`c2c <cmd>` / `helm <cmd>`):
 *      - `c2c list`                          list all sessions & 4-state status
 *      - `c2c spawn <type> [prompt]`         spawn a session in helm-daemon
 *      - `c2c read <slot|id> [--tail N]`     non-destructively read session output
 *      - `c2c send <slot|id> <text>`         write input to a session
 *      - `c2c wait <slot|id> [--until ...]`  block until state transition or regex match
 *      - `c2c kill <slot|id>`                terminate a session
 *      - `c2c status <working|blocked|idle>` emit OSC 7501 status sequence
 *
 * 2. Interactive Multiplexer Cockpit (`c2c` / `helm` with no args, or `c2c attach`):
 *      - Connects directly to persistent `helm-daemon` over Named Pipe / Socket
 *      - Non-destructive cursor reads + real-time push notifications (`daemon.subscribe`)
 *      - 4-State badges: WORKING (🟢 WORK), BLOCKED (⚠️ WAIT), IDLE (🔵 IDLE), EXITED (⚫ EXIT)
 *      - View modes (`[v]`): Single Focus, 2-Up Split, 4-Up Grid
 *      - Detach (`[q]`): Exits TUI while keeping background agents running (`[Q]` kills all)
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { HelmClient } from "./helm-client.js";
import type { ReadStreamResult, SessionState, SessionSummary } from "./helm-daemon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, "..", "logs");

const SLOT_COUNT = 8;
const MAX_SCROLLBACK_LINES = 500;
const TICK_INTERVAL_MS = 250;

type CockpitMode = "NAV" | "INPUT" | "SPAWN" | "RAW";
type ViewLayout = "SINGLE" | "SPLIT2" | "GRID4";

interface SlotState {
  slot: number; // 1..8
  sessionId: string | null;
  cliType: string;
  command: string;
  cwd: string;
  state: SessionState | "EMPTY";
  isWaitingForInput: boolean;
  isExited: boolean;
  exitCode: number | null;
  uptimeMs: number;
  readCursor: number;
  lines: string[];
  partialLine: string;
  scrollOffset: number; // 0 = pinned to bottom
  unreadHitlAlert: boolean;
  logFile: string | null;
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
    state: "EMPTY",
    isWaitingForInput: false,
    isExited: false,
    exitCode: null,
    uptimeMs: 0,
    readCursor: 0,
    lines: [],
    partialLine: "",
    scrollOffset: 0,
    unreadHitlAlert: false,
    logFile: null
  };
}

export class HelmCockpit {
  private helm = new HelmClient();
  private slots: SlotState[] = Array.from({ length: SLOT_COUNT }, (_, i) => createEmptySlot(i + 1));
  private focusedIndex = 0; // 0..7
  private mode: CockpitMode = "NAV";
  private layout: ViewLayout = "SINGLE";
  private inputBuffer = "";
  private statusBanner =
    "Ready. [s] Spawn  [v] Split View  [1-8] Slot  [y/n] HITL  [q] Detach (keeps agents running)  [Q] Kill All";
  private statusBannerIsAlert = false;
  private tickCount = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private shuttingDown = false;

  async start(): Promise<void> {
    mkdirSync(LOG_DIR, { recursive: true });

    await this.helm.ensureConnected();
    await this.helm.request("daemon.subscribe", {});

    this.helm.on("session.output", (evt: { session_id: string; chunk: string; write_cursor: number; state: SessionState }) => {
      const slot = this.slots.find((s) => s.sessionId === evt.session_id);
      if (slot && evt.write_cursor > slot.readCursor) {
        this.appendOutputToSlot(slot, evt.chunk);
        slot.readCursor = evt.write_cursor;
        slot.state = evt.state;
        slot.isWaitingForInput = evt.state === "BLOCKED";
        this.render();
      }
    });

    this.helm.on(
      "session.state_changed",
      (evt: {
        session_id: string;
        previous_state: SessionState;
        state: SessionState;
        is_waiting_for_input: boolean;
        is_exited: boolean;
        exit_code: number | null;
      }) => {
        const slot = this.slots.find((s) => s.sessionId === evt.session_id);
        if (!slot) return;
        const wasWaiting = slot.isWaitingForInput;
        slot.state = evt.state;
        slot.isWaitingForInput = evt.is_waiting_for_input;
        slot.isExited = evt.is_exited;
        slot.exitCode = evt.exit_code;

        if (!wasWaiting && slot.isWaitingForInput) {
          slot.unreadHitlAlert = true;
          this.statusBanner = `🔔 HITL PROMPT in Slot ${slot.slot} (${slot.cliType})! Press [${slot.slot}] then [y]/[n] or [Enter].`;
          this.statusBannerIsAlert = true;
          process.stdout.write("\x07");
        }
        this.render();
      }
    );

    await this.syncSlotsFromDaemon();
    this.setupTerminal();
    this.render();

    this.pollTimer = setInterval(() => {
      void this.pollTick();
    }, TICK_INTERVAL_MS);
  }

  private setupTerminal(): void {
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

  private appendOutputToSlot(slot: SlotState, rawChunk: string): void {
    if (!rawChunk) return;

    if (slot.logFile) {
      try {
        appendFileSync(slot.logFile, rawChunk, "utf8");
      } catch {
        /* ignore */
      }
    }

    const combined = slot.partialLine + rawChunk;
    const segments = combined.split("\n");
    slot.partialLine = segments.pop() ?? "";

    for (const rawSeg of segments) {
      const crParts = rawSeg.replace(/\r$/, "").split("\r");
      const effective = crParts[crParts.length - 1] ?? "";
      const cleaned = sanitizePtyLine(effective);
      slot.lines.push(cleaned);
    }

    if (slot.partialLine.includes("\r")) {
      const crParts = slot.partialLine.split("\r");
      slot.partialLine = crParts[crParts.length - 1] ?? "";
    }

    if (slot.lines.length > MAX_SCROLLBACK_LINES) {
      slot.lines.splice(0, slot.lines.length - MAX_SCROLLBACK_LINES);
    }
  }

  private async syncSlotsFromDaemon(): Promise<void> {
    const listRes = await this.helm.request<{ sessions: SessionSummary[] }>("session.list");
    for (const s of listRes.sessions) {
      const targetIdx = s.slot >= 1 && s.slot <= SLOT_COUNT ? s.slot - 1 : -1;
      const existing = this.slots.find((sl) => sl.sessionId === s.session_id);
      const slot =
        existing ??
        (targetIdx >= 0 && !this.slots[targetIdx]!.sessionId
          ? this.slots[targetIdx]!
          : this.slots.find((sl) => sl.sessionId === null));

      if (!slot) continue;

      if (slot.sessionId !== s.session_id) {
        this.bindSlotSession(slot, s.session_id, s.cli_type, s.command, s.working_dir, s.state);
      }
      slot.uptimeMs = s.uptime_ms;
      slot.state = s.state;
      slot.isWaitingForInput = s.is_waiting_for_input;
      slot.isExited = s.is_exited;
      slot.exitCode = s.exit_code;

      if (s.write_cursor > slot.readCursor) {
        const readRes = await this.helm.request<ReadStreamResult>("session.read", {
          session_id: s.session_id,
          cursor: slot.readCursor
        });
        if (readRes.output) {
          this.appendOutputToSlot(slot, readRes.output);
        }
        slot.readCursor = readRes.next_cursor;
      }
    }
  }

  private async pollTick(): Promise<void> {
    if (this.isPolling || this.shuttingDown) return;
    this.isPolling = true;
    this.tickCount++;

    try {
      await this.syncSlotsFromDaemon();
      this.render();
    } catch (err) {
      this.statusBanner = `Daemon sync error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.isPolling = false;
    }
  }

  private bindSlotSession(
    slot: SlotState,
    sessionId: string,
    cliType: string,
    command: string,
    cwd: string,
    state: SessionState = "WORKING"
  ): void {
    slot.sessionId = sessionId;
    slot.cliType = cliType;
    slot.command = command;
    slot.cwd = cwd;
    slot.state = state;
    slot.isWaitingForInput = state === "BLOCKED";
    slot.isExited = state === "EXITED";
    slot.exitCode = null;
    slot.uptimeMs = 0;
    slot.readCursor = 0;
    slot.lines = [
      `${FG_CYAN}[Helm] Bound Slot ${slot.slot} -> ${cliType} (${sessionId.slice(0, 8)})${RESET}`,
      `${DIM}[Helm] CWD: ${cwd}${RESET}`
    ];
    slot.partialLine = "";
    slot.scrollOffset = 0;
    slot.unreadHitlAlert = false;
    slot.logFile = join(LOG_DIR, `slot-${slot.slot}-${sessionId.slice(0, 8)}.log`);
  }

  private async spawnInSlot(slotIndex: number, spec: string): Promise<void> {
    const slot = this.slots[slotIndex]!;
    if (slot.sessionId && !slot.isExited) {
      this.statusBanner = `Slot ${slot.slot} is still running. Press [k] to terminate it first.`;
      this.statusBannerIsAlert = true;
      this.render();
      return;
    }

    const trimmed = spec.trim();
    const parts = trimmed ? trimmed.split(/\s+/) : ["shell"];
    const firstToken = parts[0]!.toLowerCase();
    const restText = trimmed.slice(parts[0]!.length).trim();

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
      cliType = "shell";
      initialPrompt = trimmed;
    }

    try {
      this.statusBanner = `Spawning '${cliType}' in Slot ${slot.slot}...`;
      this.statusBannerIsAlert = false;
      this.render();

      const res = await this.helm.request<SessionSummary>("session.spawn", {
        cli_type: cliType,
        slot: slot.slot,
        ...(initialPrompt ? { initial_prompt: initialPrompt } : {}),
        ...(customCommand ? { command: customCommand } : {}),
        ...(customArgs ? { args: customArgs } : {}),
        working_dir: process.cwd()
      });

      this.bindSlotSession(slot, res.session_id, res.cli_type, res.command, res.working_dir, res.state);
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
    const slot = this.slots[slotIndex]!;
    if (slot.sessionId && !slot.isExited) {
      this.statusBanner = `Slot ${slot.slot} is busy. Switch to an empty slot or press [k] first.`;
      this.statusBannerIsAlert = true;
      this.render();
      return;
    }

    const demoScript = [
      "process.stdout.write('\\x1b[36m[Worker] Scanning repository files...\\x1b[0m\\n');",
      "setTimeout(() => {",
      "  process.stdout.write('\\x1b]7501;state=blocked\\x07\\x1b[33m[Worker] Ready to apply patch to src/index.ts. Approve changes? (y/n): \\x1b[0m');",
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
      const res = await this.helm.request<SessionSummary>("session.spawn", {
        cli_type: "custom",
        slot: slot.slot,
        command: "node",
        args: ["-e", demoScript],
        working_dir: process.cwd()
      });

      this.bindSlotSession(slot, res.session_id, "hitl-demo", res.command, res.working_dir, res.state);
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
    const slot = this.slots[slotIndex]!;
    if (!slot.sessionId || slot.isExited) {
      this.statusBanner = `Slot ${slot.slot} has no live session to receive input.`;
      this.statusBannerIsAlert = true;
      this.render();
      return;
    }

    try {
      await this.helm.request("session.write", {
        session_id: slot.sessionId,
        input_text: text,
        append_newline: appendNewline
      });
      slot.isWaitingForInput = false;
      slot.state = "WORKING";
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
    const slot = this.slots[slotIndex]!;
    if (!slot.sessionId) {
      this.statusBanner = `Slot ${slot.slot} is already empty.`;
      this.render();
      return;
    }

    try {
      await this.helm.request("session.terminate", { session_id: slot.sessionId });
    } catch {
      /* ignore */
    }

    const oldType = slot.cliType;
    this.slots[slotIndex] = createEmptySlot(slot.slot);
    this.statusBanner = `Terminated and cleared Slot ${slot.slot} (${oldType}).`;
    this.statusBannerIsAlert = false;
    this.render();
  }

  private cycleLayout(): void {
    if (this.layout === "SINGLE") this.layout = "SPLIT2";
    else if (this.layout === "SPLIT2") this.layout = "GRID4";
    else this.layout = "SINGLE";
    this.statusBanner = `Switched viewport layout to ${this.layout}.`;
    this.statusBannerIsAlert = false;
    this.render();
  }

  public async launchSwarmDemo(autoApprove = true): Promise<void> {
    this.layout = "GRID4";
    this.focusedIndex = 0;

    // Clear slots 1..4 if any old exited sessions exist
    for (let i = 0; i < 4; i++) {
      const sl = this.slots[i]!;
      if (sl.sessionId) {
        try {
          await this.helm.request("session.terminate", { session_id: sl.sessionId });
        } catch {
          /* ignore */
        }
        this.slots[i] = createEmptySlot(sl.slot);
      }
    }

    // Slot 1: Builder Agent (emits work logs -> hits OSC 7501 BLOCKED (y/n) -> resumes on 'y')
    const slot1Script = [
      "const w = (s) => process.stdout.write(s);",
      "w('\\x1b[36m[Builder-Claude] Analyzing src/auth/session.ts...\\x1b[0m\\n');",
      "setTimeout(() => w('\\x1b[32m  ✓ AST parsed (14 modules)\\x1b[0m\\n'), 500);",
      "setTimeout(() => w('\\x1b[32m  ✓ Generated JWT refresh rotation patch (+64 / -18 lines)\\x1b[0m\\n'), 1100);",
      "setTimeout(() => {",
      "  w('\\x1b]7501;state=blocked\\x07\\x1b[33m[HITL GATE] Apply schema migration & overwrite auth.ts? (y/n): \\x1b[0m');",
      "}, 1800);",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  const ans = chunk.trim().toLowerCase();",
      "  if (ans.startsWith('y')) {",
      "    w('\\n\\x1b]7501;state=working\\x07\\x1b[32m[Builder-Claude] Approved! Applying migration...\\x1b[0m\\n');",
      "    setTimeout(() => w('\\x1b[36m[Builder-Claude] Signaling Slot 2 (Test-Runner) via Helm Link...\\x1b[0m\\n'), 600);",
      "    setTimeout(() => { w('\\x1b[32m[Builder-Claude] Build complete (0 errors).\\x1b[0m\\n'); process.exit(0); }, 1400);",
      "  } else {",
      "    w('\\n\\x1b[31m[Builder-Claude] Rejected by operator. Rolling back.\\x1b[0m\\n');",
      "    process.exit(1);",
      "  }",
      "});"
    ].join(" ");

    // Slot 2: Verifier / Playwright Runner (waits for Slot 1 approval, then runs tests and enters IDLE)
    const slot2Script = [
      "const w = (s) => process.stdout.write(s);",
      "w('\\x1b[35m[Verifier-AGY] Helm Link active (HELM_SLOT=' + (process.env.HELM_SLOT||'2') + ')\\x1b[0m\\n');",
      "setTimeout(() => w('\\x1b[36m[Verifier-AGY] Warming headless Chromium test pool...\\x1b[0m\\n'), 700);",
      "setTimeout(() => w('\\x1b[33m[Verifier-AGY] Waiting on Slot 1 HITL gate resolution...\\x1b[0m\\n'), 1900);",
      "setTimeout(() => w('\\x1b[32m  ✓ PLAYWRIGHT: auth.refresh.spec.ts (18/18 passed in 1.1s)\\x1b[0m\\n'), 5200);",
      "setTimeout(() => w('\\x1b[32m  ✓ PLAYWRIGHT:pipe-ipc.spec.ts (24/24 passed in 0.8s)\\x1b[0m\\n'), 6000);",
      "setTimeout(() => {",
      "  w('\\x1b]7501;state=idle\\x07\\x1b[36m[Verifier-AGY] All 42 tests green. Standing by in IDLE state.\\x1b[0m\\n');",
      "}, 6600);",
      "setTimeout(() => process.exit(0), 60000);"
    ].join(" ");

    // Slot 3: Security & Dependency Scanner
    const slot3Script = [
      "const w = (s) => process.stdout.write(s);",
      "w('\\x1b[36m[SecAudit-Gemini] Auditing dependency tree & ConPTY handles...\\x1b[0m\\n');",
      "setTimeout(() => w('  • Checking node-pty ABI & Named Pipe ACLs... \\x1b[32mOK\\x1b[0m\\n'), 900);",
      "setTimeout(() => w('  • Scanning for leaked env tokens (scrubEnv)... \\x1b[32m0 leaks\\x1b[0m\\n'), 1700);",
      "setTimeout(() => w('  • Verifying OSC 7501 state transitions... \\x1b[32mPASS\\x1b[0m\\n'), 2600);",
      "setTimeout(() => { w('\\x1b[32m[SecAudit-Gemini] Audit finished: 0 vulnerabilities.\\x1b[0m\\n'); process.exit(0); }, 3500);"
    ].join(" ");

    // Slot 4: AOE Command Center Supervisor (watches Slot 1 block, displays risk brief, auto-approves after 2.4s)
    const slot4Script = [
      "const w = (s) => process.stdout.write(s);",
      "w('\\x1b[32m[AOE-Command-Center] Subscribed to \\\\\\\\.\\\\pipe\\\\cli2cli-helm\\x1b[0m\\n');",
      "setTimeout(() => w('\\x1b[36m[AOE-Telemetry] Streaming 3 sibling slots to SSE dashboard...\\x1b[0m\\n'), 800);",
      "setTimeout(() => {",
      "  w('\\x1b[33m⚡ [HITL INTERCEPT] Slot 1 entered BLOCKED state!\\x1b[0m\\n');",
      "  w('  ├─ Brief: Apply JWT schema migration & overwrite auth.ts\\n');",
      "  w('  ├─ Risk:  LOW (Local repo, test suite standing by in Slot 2)\\n');",
      "  w('  └─ Dispatched [ ✅ Approve ] [ ❌ Reject ] to Operator\\n');",
      "}, 2000);",
      autoApprove
        ? "setTimeout(() => w('\\x1b[32m[AOE-Command-Center] Auto-Demo Approval: Injecting \"y\" into Slot 1...\\x1b[0m\\n'), 4100);"
        : "setTimeout(() => w('\\x1b[33m[AOE-Command-Center] Press [y] now to approve Slot 1!\\x1b[0m\\n'), 2400);",
      "setTimeout(() => { w('\\x1b]7501;state=idle\\x07\\x1b[36m[AOE-Command-Center] Swarm pipeline complete. All gates signed.\\x1b[0m\\n'); }, 6800);",
      "setTimeout(() => process.exit(0), 60000);"
    ].join(" ");

    const specs: Array<{ slot: number; label: string; script: string }> = [
      { slot: 1, label: "claude-build", script: slot1Script },
      { slot: 2, label: "agy-verify", script: slot2Script },
      { slot: 3, label: "gemini-audit", script: slot3Script },
      { slot: 4, label: "aoe-command", script: slot4Script }
    ];

    for (const sp of specs) {
      const res = await this.helm.request<SessionSummary>("session.spawn", {
        cli_type: "custom",
        slot: sp.slot,
        command: "node",
        args: ["-e", sp.script],
        working_dir: process.cwd()
      });
      this.bindSlotSession(this.slots[sp.slot - 1]!, res.session_id, sp.label, res.command, res.working_dir, res.state);
    }

    this.statusBanner =
      "🚀 4-PANE SWARM DEMO RUNNING IN GRID4! Watch Slot 1 hit ⚠️ WAIT, Slot 4 brief & auto-approve, and Slot 2 verify.";
    this.statusBannerIsAlert = false;
    this.render();

    if (autoApprove) {
      setTimeout(() => {
        const s1 = this.slots[0]!;
        if (s1.sessionId && s1.isWaitingForInput && !s1.isExited) {
          void this.sendSlotInput(0, "y", true);
        }
      }, 4200);
    }
  }

  private async handleKey(key: string): Promise<void> {
    if (key === "\x11" || (key === "\x03" && this.mode === "NAV")) {
      await this.detach();
      return;
    }

    const focused = this.slots[this.focusedIndex]!;

    if (this.mode === "RAW") {
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
      const target = this.slots[this.focusedIndex]!;
      target.unreadHitlAlert = false;
      this.statusBanner = `Focused Slot ${target.slot} (${target.sessionId ? target.cliType : "EMPTY"}).`;
      this.statusBannerIsAlert = false;
      this.render();
      return;
    }

    if (key === "v" || key === "V") {
      this.cycleLayout();
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

    if (key === "d") {
      await this.launchSwarmDemo(true);
      return;
    }

    if (key === "D") {
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

    if (key === `${CSI}A`) {
      focused.scrollOffset = Math.min(Math.max(0, focused.lines.length - 5), focused.scrollOffset + 1);
      this.render();
      return;
    }
    if (key === `${CSI}B`) {
      focused.scrollOffset = Math.max(0, focused.scrollOffset - 1);
      this.render();
      return;
    }
    if (key === `${CSI}5~`) {
      focused.scrollOffset = Math.min(Math.max(0, focused.lines.length - 5), focused.scrollOffset + 10);
      this.render();
      return;
    }
    if (key === `${CSI}6~`) {
      focused.scrollOffset = Math.max(0, focused.scrollOffset - 10);
      this.render();
      return;
    }

    // Lowercase 'q' detaches safely (Herdr/tmux style); Uppercase 'Q' kills all and quits
    if (key === "q") {
      await this.detach();
      return;
    }
    if (key === "Q") {
      await this.killAllAndQuit();
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
    } else if (slot.state === "BLOCKED" || slot.isWaitingForInput) {
      const flash = this.tickCount % 2 === 0;
      stateTag = "⚠️ WAIT y/n";
      colorPrefix = flash ? `${BG_YELLOW}${FG_BLACK}${BOLD}` : `${BG_RED}${FG_WHITE}${BOLD}`;
    } else if (slot.state === "EXITED" || slot.isExited) {
      const code = slot.exitCode ?? 0;
      stateTag = `⚫ EX:${String(code).padEnd(2, " ")}`;
      colorPrefix =
        code === 0
          ? isFocused
            ? `${BG_GRAY}${FG_GREEN}${BOLD}`
            : `${FG_GREEN}`
          : isFocused
          ? `${BG_RED}${FG_WHITE}${BOLD}`
          : `${FG_RED}`;
    } else if (slot.state === "IDLE") {
      stateTag = `🔵 IDLE ${formatDuration(slot.uptimeMs)}`;
      colorPrefix = isFocused ? `${BG_CYAN}${FG_BLACK}${BOLD}` : `${FG_CYAN}${BOLD}`;
    } else {
      stateTag = `🟢 WORK ${formatDuration(slot.uptimeMs)}`;
      colorPrefix = isFocused ? `${BG_GREEN}${FG_BLACK}${BOLD}` : `${FG_GREEN}${BOLD}`;
    }

    const rawText = `${focusPrefix}[${slot.slot}] ${typeLabel} ${stateTag}`;
    const padded = padVisible(rawText, innerWidth);
    return `${colorPrefix}${padded}${RESET}`;
  }

  private getSlotLines(slot: SlotState, maxLines: number): string[] {
    const displayLines = [...slot.lines];
    if (slot.partialLine) {
      displayLines.push(sanitizePtyLine(slot.partialLine));
    }

    if (!slot.sessionId && displayLines.length === 0) {
      displayLines.push(
        `${DIM}  Slot ${slot.slot} is empty.${RESET}`,
        `${DIM}  • Press [s] or [Enter] to spawn (claude, gemini, agy, shell, custom)${RESET}`,
        `${DIM}  • Press [d] to launch an OSC 7501 + HITL confirmation probe${RESET}`,
        `${DIM}  • Press [v] to toggle Single / Split-2 / Grid-4 panes${RESET}`
      );
    }

    const totalLines = displayLines.length;
    const endIdx = Math.max(0, totalLines - slot.scrollOffset);
    const startIdx = Math.max(0, endIdx - maxLines);
    const slice = displayLines.slice(startIdx, endIdx);
    const out: string[] = [];
    for (let i = 0; i < maxLines; i++) {
      out.push(slice[i] ?? "");
    }
    return out;
  }

  private renderPaneHeader(slot: SlotState, width: number, isFocused: boolean): string {
    const marker = isFocused ? `${FG_YELLOW}${BOLD}▶` : `${DIM} `;
    const stateBadge = !slot.sessionId
      ? `${DIM}EMPTY${RESET}`
      : slot.state === "BLOCKED"
      ? `${BG_YELLOW}${FG_BLACK}${BOLD} ⚠️ BLOCKED ${RESET}`
      : slot.state === "IDLE"
      ? `${FG_CYAN}${BOLD}🔵 IDLE${RESET}`
      : slot.state === "EXITED"
      ? `${FG_RED}⚫ EXITED(${slot.exitCode ?? 0})${RESET}`
      : `${FG_GREEN}${BOLD}🟢 WORKING${RESET}`;
    return padVisible(`${marker} SLOT ${slot.slot} [${slot.cliType}]${RESET} │ ${stateBadge} │ ${DIM}${slot.cwd}${RESET}`, width);
  }

  private render(): void {
    if (this.shuttingDown) return;

    const cols = Math.max(80, process.stdout.columns || 120);
    const rows = Math.max(20, process.stdout.rows || 32);
    const outRows: string[] = [];

    const waitingCount = this.slots.filter((s) => s.state === "BLOCKED" || s.isWaitingForInput).length;
    const runningCount = this.slots.filter((s) => s.sessionId && !s.isExited).length;

    // Row 1: Top Header Bar
    const headerLeft = ` ⚓ CLI2CLI-HELM MULTIPLEXER  │  Active: ${runningCount}/8  │  Blocked: ${waitingCount}  │  View: ${this.layout}`;
    const headerRight = `Mode: ${this.mode} `;
    const headerSpace = Math.max(1, cols - visibleLength(headerLeft).length - headerRight.length);
    const headerBg = waitingCount > 0 ? `${BG_YELLOW}${FG_BLACK}${BOLD}` : `${BG_BLUE}${FG_WHITE}${BOLD}`;
    outRows.push(`${headerBg}${headerLeft}${" ".repeat(headerSpace)}${headerRight}${RESET}`);

    // Rows 2–3: 8-Slot Status Grid
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

    const viewportRows = Math.max(6, rows - outRows.length - 3);
    const focused = this.slots[this.focusedIndex]!;

    if (this.layout === "SINGLE") {
      outRows.push(this.renderPaneHeader(focused, cols, true));
      const lines = this.getSlotLines(focused, viewportRows - 1);
      for (const l of lines) {
        outRows.push(truncateAnsi(` ${l}`, cols));
      }
    } else if (this.layout === "SPLIT2") {
      const leftIdx = this.focusedIndex;
      const rightIdx = (this.focusedIndex + 1) % SLOT_COUNT;
      const leftSlot = this.slots[leftIdx]!;
      const rightSlot = this.slots[rightIdx]!;
      const halfWidth = Math.floor((cols - 3) / 2);

      const hLeft = this.renderPaneHeader(leftSlot, halfWidth, true);
      const hRight = this.renderPaneHeader(rightSlot, halfWidth, false);
      outRows.push(`${hLeft} │ ${hRight}`);

      const leftLines = this.getSlotLines(leftSlot, viewportRows - 1);
      const rightLines = this.getSlotLines(rightSlot, viewportRows - 1);
      for (let i = 0; i < viewportRows - 1; i++) {
        const c1 = padVisible(` ${leftLines[i] ?? ""}`, halfWidth);
        const c2 = padVisible(` ${rightLines[i] ?? ""}`, halfWidth);
        outRows.push(`${c1} │ ${c2}`);
      }
    } else {
      // GRID4: 2x2 grid showing slots around focusedIndex (slots 1-4 or 5-8)
      const baseIdx = this.focusedIndex < 4 ? 0 : 4;
      const halfWidth = Math.floor((cols - 3) / 2);
      const topHeight = Math.max(2, Math.floor((viewportRows - 2) / 2));
      const botHeight = Math.max(2, viewportRows - 2 - topHeight);

      const s0 = this.slots[baseIdx]!;
      const s1 = this.slots[baseIdx + 1]!;
      const s2 = this.slots[baseIdx + 2]!;
      const s3 = this.slots[baseIdx + 3]!;

      outRows.push(
        `${this.renderPaneHeader(s0, halfWidth, this.focusedIndex === baseIdx)} │ ${this.renderPaneHeader(
          s1,
          halfWidth,
          this.focusedIndex === baseIdx + 1
        )}`
      );
      const l0 = this.getSlotLines(s0, topHeight);
      const l1 = this.getSlotLines(s1, topHeight);
      for (let i = 0; i < topHeight; i++) {
        outRows.push(`${padVisible(` ${l0[i] ?? ""}`, halfWidth)} │ ${padVisible(` ${l1[i] ?? ""}`, halfWidth)}`);
      }

      outRows.push(
        `${this.renderPaneHeader(s2, halfWidth, this.focusedIndex === baseIdx + 2)} │ ${this.renderPaneHeader(
          s3,
          halfWidth,
          this.focusedIndex === baseIdx + 3
        )}`
      );
      const l2 = this.getSlotLines(s2, botHeight);
      const l3 = this.getSlotLines(s3, botHeight);
      for (let i = 0; i < botHeight; i++) {
        outRows.push(`${padVisible(` ${l2[i] ?? ""}`, halfWidth)} │ ${padVisible(` ${l3[i] ?? ""}`, halfWidth)}`);
      }
    }

    // Footer 1: Keybinding Bar
    const helpBar =
      `${BG_GRAY}${FG_WHITE} ` +
      `${BOLD}[1-8]${RESET}${BG_GRAY}${FG_WHITE} Slot  ` +
      `${BOLD}[v]${RESET}${BG_GRAY}${FG_WHITE} View  ` +
      `${BOLD}[y/n]${RESET}${BG_GRAY}${FG_WHITE} HITL  ` +
      `${BOLD}[i/Enter]${RESET}${BG_GRAY}${FG_WHITE} Input  ` +
      `${BOLD}[s]${RESET}${BG_GRAY}${FG_WHITE} Spawn  ` +
      `${BOLD}[d]${RESET}${BG_GRAY}${FG_WHITE} Demo  ` +
      `${BOLD}[r]${RESET}${BG_GRAY}${FG_WHITE} Raw  ` +
      `${BOLD}[k]${RESET}${BG_GRAY}${FG_WHITE} Kill  ` +
      `${BOLD}[q]${RESET}${BG_GRAY}${FG_WHITE} Detach  ` +
      `${BOLD}[Q]${RESET}${BG_GRAY}${FG_WHITE} QuitAll `;
    outRows.push(padVisible(helpBar, cols) + RESET);

    // Footer 2: Status Banner
    const bannerStyle = this.statusBannerIsAlert ? `${FG_YELLOW}${BOLD}` : `${FG_CYAN}`;
    outRows.push(padVisible(` ${bannerStyle}${this.statusBanner}${RESET}`, cols));

    // Footer 3: Input Line
    let promptLine: string;
    if (this.mode === "INPUT") {
      promptLine = `${FG_GREEN}${BOLD} INPUT (Slot ${focused.slot} ${focused.cliType}) > ${RESET}${this.inputBuffer}${BG_GREEN} ${RESET}`;
    } else if (this.mode === "SPAWN") {
      promptLine = `${FG_MAGENTA}${BOLD} SPAWN (Slot ${focused.slot}) [claude|gemini|agy|shell|custom <args>] > ${RESET}${this.inputBuffer}${BG_MAGENTA} ${RESET}`;
    } else if (this.mode === "RAW") {
      promptLine = `${BG_CYAN}${FG_BLACK}${BOLD} RAW PASSTHROUGH (Slot ${focused.slot}) — keystrokes sent directly to PTY ([Esc] to exit) ${RESET}`;
    } else if (focused.isWaitingForInput) {
      promptLine = `${BG_YELLOW}${FG_BLACK}${BOLD} ⚡ Slot ${focused.slot} BLOCKED! Press [y] to approve, [n] to reject, or [Enter] to reply. ${RESET}`;
    } else {
      promptLine = `${DIM} [NAV] Slot ${focused.slot} — [Enter] Input  [s] Spawn  [v] Layout (${this.layout})  [q] Detach (sessions keep running)${RESET}`;
    }
    outRows.push(padVisible(promptLine, cols));

    const frame = outRows.slice(0, rows).map((r) => `${CSI}2K${r}`).join("\r\n");
    process.stdout.write(`${CSI}H${frame}`);
  }

  async detach(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.helm.close();
    this.restoreTerminal();
    process.stdout.write("[cli2cli-helm] Detached from cockpit. Background sessions remain active in helm-daemon.\r\n");
    process.exit(0);
  }

  async killAllAndQuit(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.pollTimer) clearInterval(this.pollTimer);

    for (const slot of this.slots) {
      if (slot.sessionId && !slot.isExited) {
        try {
          await this.helm.request("session.terminate", { session_id: slot.sessionId });
        } catch {
          /* ignore */
        }
      }
    }

    this.helm.close();
    this.restoreTerminal();
    process.stdout.write("[cli2cli-helm] Terminated all sessions and exited.\r\n");
    process.exit(0);
  }
}

/**
 * CLI Subcommand Dispatcher (`c2c <subcommand>` / `helm <subcommand>`)
 */
async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === "attach" || sub === "tui" || sub === "cockpit") {
    const cockpit = new HelmCockpit();
    await cockpit.start();
    return;
  }

  if (sub === "demo") {
    const cockpit = new HelmCockpit();
    await cockpit.start();
    await cockpit.launchSwarmDemo(!args.includes("--manual"));
    return;
  }

  if (sub === "status") {
    // Emit OSC 7501 sequence directly to stdout for child agents/scripts
    const state = (args[1] ?? "working").toLowerCase();
    process.stdout.write(`\x1b]7501;state=${state}\x07`);
    return;
  }

  const helm = new HelmClient();
  try {
    switch (sub) {
      case "ping": {
        const res = await helm.request("daemon.ping");
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "list":
      case "ls": {
        const res = await helm.request("session.list");
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "spawn": {
        const cliType = args[1] ?? "shell";
        const promptParts: string[] = [];
        let slot: number | undefined;
        let cwd = process.cwd();

        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--slot" && args[i + 1]) {
            slot = Number(args[++i]);
          } else if (args[i] === "--cwd" && args[i + 1]) {
            cwd = args[++i]!;
          } else {
            promptParts.push(args[i]!);
          }
        }
        const res = await helm.request("session.spawn", {
          cli_type: cliType,
          initial_prompt: promptParts.join(" "),
          working_dir: cwd,
          ...(slot ? { slot } : {})
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "read": {
        const id = args[1];
        if (!id) throw new Error("Usage: c2c read <slot|session_id> [--tail N] [--cursor N]");
        let tailChars: number | undefined;
        let cursor: number | undefined;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--tail" && args[i + 1]) tailChars = Number(args[++i]);
          else if (args[i] === "--cursor" && args[i + 1]) cursor = Number(args[++i]);
        }
        const res = await helm.request("session.read", {
          session_id: id,
          ...(tailChars !== undefined ? { tail_chars: tailChars } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          consumer_id: "cli"
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "send":
      case "write": {
        const id = args[1];
        const text = args.slice(2).filter((a) => a !== "--raw").join(" ");
        const raw = args.includes("--raw");
        if (!id) throw new Error("Usage: c2c send <slot|session_id> <text> [--raw]");
        const res = await helm.request("session.write", {
          session_id: id,
          input_text: text,
          append_newline: !raw
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "wait": {
        const id = args[1];
        if (!id) throw new Error("Usage: c2c wait <slot|session_id> [--until blocked,idle,exited] [--pattern REGEX] [--timeout MS]");
        let until: string[] | undefined;
        let pattern: string | undefined;
        let timeoutMs: number | undefined;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--until" && args[i + 1]) until = args[++i]!.split(",");
          else if (args[i] === "--pattern" && args[i + 1]) pattern = args[++i];
          else if (args[i] === "--timeout" && args[i + 1]) timeoutMs = Number(args[++i]);
        }
        const res = await helm.request("session.wait", {
          session_id: id,
          ...(until ? { until } : {}),
          ...(pattern ? { pattern } : {}),
          ...(timeoutMs ? { timeout_ms: timeoutMs } : {}),
          consumer_id: "cli"
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "kill":
      case "terminate": {
        const id = args[1];
        if (!id) throw new Error("Usage: c2c kill <slot|session_id>");
        const res = await helm.request("session.terminate", { session_id: id });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      default:
        console.log(
          [
            "cli2cli-helm (c2c / helm) — Agent-Native Terminal Multiplexer & Runtime",
            "",
            "Usage:",
            "  c2c                                      Launch interactive TUI multiplexer",
            "  c2c list                                 List all sessions & 4-state status",
            "  c2c spawn <type> [prompt] [--slot N]     Spawn claude|gemini|agy|shell|custom",
            "  c2c read <slot|id> [--tail N]            Non-destructively read session output",
            "  c2c send <slot|id> <text> [--raw]        Send input or HITL confirmation (y/n)",
            "  c2c wait <slot|id> [--until blocked,...] Wait for state transition or regex match",
            "  c2c kill <slot|id>                       Terminate session",
            "  c2c status <working|blocked|idle|done>   Emit OSC 7501 status escape sequence"
          ].join("\n")
        );
    }
  } finally {
    helm.close();
  }
}

runCli().catch((err) => {
  process.stdout.write(`\x1b[0m\x1b[?25h\x1b[?1049l`);
  process.stderr.write(`[cli2cli-helm] Error: ${err?.stack ?? err}\r\n`);
  process.exit(1);
});
