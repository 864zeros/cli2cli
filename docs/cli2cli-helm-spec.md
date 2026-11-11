# cli2cli-helm & The Open-Source `cli2cli` Ecosystem

**A Technical Specification & Implementation Roadmap**  
**Author(s):** Jeff Conn (Founder, 864zeros LLC) & Zane Fields (Technical Lead & Systems Architect)  
**Organization:** 864zeros LLC  
**Classification:** Open-Source Architectural Specification (MIT / Apache 2.0)  
**Date:** November 2026  
**Document ID:** `864z-SPEC-2026-002-HELM`

---

## 1. Executive Summary & Open-Source Ecosystem Positioning

While **`cli2cli-mcp`** v0.1 proved that AI coding assistants (Claude Code, Gemini CLI, Antigravity, Codex, OpenCode, aider) can be orchestrated as OS processes inside native pseudo-terminals (Windows ConPTY / POSIX PTY), tying process lifecycles to a single MCP `stdio` client limited its use as a standalone multiplexer.

With tools like `Herdr` (`herdr.dev`) entering the space as local terminal multiplexers, the entire **`cli2cli` stack** is designed as a **100% free, open-source, vendor-neutral ecosystem** that goes a step further: combining a local agent-aware multiplexer (**`cli2cli-helm`**), a standard MCP bridge (**`cli2cli-mcp`**), and an outward mobile/remote command-center & observability pillar (**`cli2cli-aoe`**).

Crucially, **all proprietary personas or company-specific configurations (such as "Kate") are strictly external user plugins/prompts**. The core three pillars are completely generic, abstract, and ready for any developer to adopt out of the box.

### The Three Open-Source Pillars of `cli2cli`

| Pillar | Metaphor | Open-Source Role & Abstraction | License |
| :--- | :--- | :--- | :--- |
| **`cli2cli-helm`** | **The Ship's Bridge** *(Local Runtime & Multiplexer)* | Persistent background PTY daemon (`helm-daemon`), 4-state tracker (`OSC 7501` + regex), multi-pane TUI cockpit, scriptable JSON CLI (`helm` / `c2c`), and peer-to-peer `Helm Link`. | Open Source (MIT) |
| **`cli2cli-mcp`** | **The Engine Room** *(Protocol Adapter)* | Stateless MCP server (`spawn`, `read`, `write`, `list`, `wait`, `terminate`) that connects any MCP-compliant LLM or IDE to `cli2cli-helm`. | Open Source (MIT) |
| **`cli2cli-aoe`** | **The Command Center** *(Outward Comms, HITL Governance & Telemetry)* | Pluggable remote command & observability pillar: routes `BLOCKED` / permission gates to external channels (Telegram, Slack, Discord, Webhooks, Mobile), pluggable AI Executive Summarizer (bring-your-own prompt/model), and live SSE dashboard stream. | Open Source (MIT) |

---

## 2. Why `cli2cli` Beats `Herdr` as an Open-Source Stack

| Capability | `Herdr` (`herdrdev/herdr`) | The `cli2cli` Stack (`helm` + `mcp` + `aoe`) |
| :--- | :--- | :--- |
| **Local Agent Multiplexer** | Yes (`herdr` TUI + `herdr-core` daemon) | **Yes (`cli2cli-helm` TUI + `helm-daemon`)** |
| **Zero-Config HITL Prompt Detection** | Requires `OSC 7501` or basic PTY state | **Dual Engine:** `OSC 7501` protocol **+** automatic ANSI regex heuristic (`(y/n)`, `approve`, `❯`) that catches uninstrumented CLIs |
| **First-Party MCP Server** | Community add-on (`herdr-mcp`) | **First-party core pillar (`cli2cli-mcp`)** with zero-polling `wait_cli_session` |
| **Outward Mobile Command Center** | None (Desktop/SSH bound) | **`cli2cli-aoe` included:** Approve/Reject blocked agents from your phone (Telegram/Slack/Webhook) with optional AI risk summaries and live SSE web dashboard |
| **Windows ConPTY Native** | Secondary port | **First-class Windows ConPTY & POSIX parity** |

---

## 3. Core Architecture (`cli2cli-helm` + `cli2cli-mcp` + `cli2cli-aoe`)

```
  ┌────────────────────────────────────────────────────────────────────────────┐
  │                   OUTWARD COMMAND CENTER (cli2cli-aoe)                     │
  │                                                                            │
  │  ┌─────────────────────────┐   ┌────────────────────┐   ┌───────────────┐  │
  │  │ Channel Adapters        │   │ Pluggable Brief AI │   │ Live Web SSE  │  │
  │  │ (Telegram/Slack/Webhook)│◀──│ (Optional LLM Risk │   │ Dashboard     │  │
  │  │ [ ✅ Allow ] [ ❌ Deny ] │   │  Summarizer Hook)  │   │ (Event Stream)│  │
  │  └────────────┬────────────┘   └─────────▲──────────┘   └───────▲───────┘  │
  └───────────────┼──────────────────────────┼──────────────────────┼──────────┘
                  │                          │                      │
                  ▼                          │                      │
  ┌──────────────────────────────┐  ┌────────┴─────────┐            │
  │       helm TUI Cockpit       │  │   cli2cli-mcp    │            │
  │   (Local Terminal Multiplex) │  │ (MCP Stdio/SSE)  │            │
  └───────────────┬──────────────┘  └────────┬─────────┘            │
                  │                          │                      │
                  ▼                          ▼                      ▼
  ══════════════════════════════════════════════════════════════════════════════
           Named Pipe (\\.\pipe\cli2cli-helm) / Unix Socket / HTTP+SSE
  ══════════════════════════════════════════════════════════════════════════════
                                        │
                                        ▼
  ┌────────────────────────────────────────────────────────────────────────────┐
  │                       helm-daemon (cli2cli-helm Core)                      │
  │                                                                            │
  │  • Non-Destructive Cursor Ring-Buffer (Multi-Consumer Read Streams)        │
  │  • @xterm/headless 2D Screen Grid (120x40) + Raw Disk Log Sink             │
  │  • 4-State Engine: WORKING | BLOCKED | IDLE | EXITED                       │
  │  • Dual Signal Detector: OSC 7501 Protocol + HITL ANSI Regex Fallback      │
  │  • Event Emitter for zero-polling `wait_cli_session` & AOE webhooks        │
  │                                                                            │
  │       ConPTY │                    ConPTY │                   ConPTY │      │
  │              ▼                           ▼                          ▼      │
  │   ┌────────────────────┐      ┌────────────────────┐     ┌───────────────┐ │
  │   │ Slot 1: claude     │◀────▶│ Slot 2: gemini/agy │◀───▶│ Slot 3: shell │ │
  │   │ (HELM_SLOT=1)      │ Helm │ (HELM_SLOT=2)      │Helm │ (HELM_SLOT=3) │ │
  │   └────────────────────┘ Link └────────────────────┘Link └───────────────┘ │
  └────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Pillar 1 Specification: `cli2cli-helm` (The Runtime & Multiplexer)

### 4.1 Persistent Background Daemon (`helm-daemon`)
* **Decoupled Lifecycles:** `helm-daemon` runs as an independent background process owning all `node-pty` handles.
* **Zero-Orphan Detach/Reattach:** Closing the `helm` TUI window (`Ctrl+B d` or `d`) or restarting an MCP client leaves all running agent sessions untouched.
* **IPC Transport:** Listens on Windows Named Pipe `\\.\pipe\cli2cli-helm` (`~/.cli2cli/helm.sock` on POSIX) and optional localhost HTTP/SSE port `127.0.0.1:8779` so `cli2cli-aoe` and web dashboards can subscribe to real-time events without Redis if desired.
* **Auto-Spawn:** Running any `helm` CLI command or starting `cli2cli-mcp` automatically boots `helm-daemon` in the background if it is not already running.

### 4.2 Non-Destructive Cursor Ring-Buffer (Multi-Consumer Reads)
* Every session maintains a monotonically increasing byte/chunk counter (`writeCursor`, up to `MAX_BUFFER_CHARS = 500_000` retained in memory, plus optional disk logging).
* Consumers pass an optional `cursor: number` when reading.
* `read_cli_stream` returns `{ output, next_cursor, state, is_waiting_for_input, exit_code }` without mutating other consumers' view of the stream.

### 4.3 Deterministic 4-State Engine (`OSC 7501` + Heuristic + Quiescence)
Every session slot is continuously classified into one of four semantic states:

| State | Badge | Trigger Condition |
| :--- | :--- | :--- |
| **`WORKING`** | `🟢 WORK` | Process is actively emitting stdout/stderr or received an `OSC 7501;state=working` sequence. |
| **`BLOCKED`** | `⚠️ WAIT` | Matched `OSC 7501;state=blocked` **OR** matched `HITL_PROMPT_PATTERN` (`(y/n)`, `approve`, `overwrite`, `❯`, etc.). |
| **`IDLE`** | `🔵 IDLE` | Process is alive, not `BLOCKED`, and has emitted `0` bytes for $\ge \text{IDLE\_THRESHOLD\_MS}$ (default `3000ms`), or emitted `OSC 7501;state=idle` / `done`. |
| **`EXITED`** | `⚫ EXIT` | Underlying PTY process terminated (`exitCode !== null`). |

### 4.4 Dual-Mode CLI (`helm` / `c2c`) & `Helm Link` Peer Discovery
The `helm` (aliased as `c2c`) binary operates in two modes:

1. **Interactive Multiplexer Mode (`helm` or `helm attach`):**
   * Launches the full-screen terminal cockpit connected to `helm-daemon`.
   * Supports **Single Focus**, **2-Up Split**, and **4-Up Grid** views (`v`), instant `y`/`n` approval keys, raw passthrough (`r`), and **Detach (`d`)**.
2. **Scriptable JSON Mode (for humans, shell scripts, and sibling agents):**
   * `helm list [--json]` — Lists all slots, PIDs, states (`WORKING`, `BLOCKED`, `IDLE`, `EXITED`), and CWDs.
   * `helm spawn <cli_type> [prompt] [--slot 2] [--cwd path]` — Spawns a session in a specific or next-available slot.
   * `helm read <slot|id> [--tail 50] [--cursor N]` — Non-destructively reads session output.
   * `helm send <slot|id> <text> [--raw]` — Injects keystrokes or prompts (`y`, `n`, follow-up instructions).
   * `helm wait <slot|id> [--until blocked,idle,exited] [--timeout 60000]` — Blocks until state change and prints output.
   * `helm kill <slot|id>` — Terminates a session.
   * `helm status <working|blocked|idle|done>` — Emits an `OSC 7501` status sequence from inside a child script.

#### `Helm Link` (Zero-Token Peer-to-Peer Agent Interop)
When `helm-daemon` spawns a child PTY, it injects environment metadata into the child process:
* `HELM_SESSION_ID=<uuid>`
* `HELM_SLOT=<1..8>`
* `HELM_PIPE=\\.\pipe\cli2cli-helm`

Any coding agent running inside Slot 1 can discover and coordinate with Slot 2 using simple one-line shell calls (`c2c send 2 "npm test" && c2c wait 2`) or via `cli2cli-mcp`.

---

## 5. Pillar 2 Specification: `cli2cli-mcp` (The Protocol Bridge)

A lightweight, zero-state MCP server that connects to `helm-daemon` and exposes **6 standard MCP tools** to any LLM client:
1. `spawn_cli_session`
2. `read_cli_stream` *(supports non-destructive `cursor`)*
3. `write_cli_input`
4. `list_cli_sessions` *(includes 4-state `WORKING` | `BLOCKED` | `IDLE` | `EXITED`)*
5. `wait_cli_session` *(event-driven block until `blocked`, `idle`, `exited`, or regex `pattern`)*
6. `terminate_cli_session`

---

## 6. Pillar 3 Specification: `cli2cli-aoe` (Abstracted Outward Command Center)

To make **`cli2cli-aoe`** a universal open-source pillar, all hardcoded personas, private user IDs, and proprietary business logic are removed in favor of **clean, pluggable interfaces**:

### 6.1 Core Abstraction Layers in `cli2cli-aoe`
1. **`NotifierAdapter` (Outward Comms Channels):**
   * Standard interface (`sendApprovalRequest(event)`, `onDecisionCallback(handler)`, `sendAlert(message)`).
   * **Built-in Open-Source Adapters:**
     * **Telegram Bot Adapter** (configured purely via `AOE_TELEGRAM_TOKEN` and `AOE_ALLOWED_CHAT_IDS`)
     * **Slack / Discord Webhook & Interactive Button Adapter**
     * **Generic HTTP Webhook Adapter** (POSTs JSON on `BLOCKED` state, accepts callback POST to approve/reject)
2. **`SummarizerHook` (Optional Pluggable Executive Briefer):**
   * When a session enters `BLOCKED` (or hits `gate-hook.sh`), `cli2cli-aoe` can either:
     * **Raw Mode (Zero LLM / $0 cost):** Forward the clean terminal tail + command summary directly to the user's phone with `[ ✅ Approve ]` / `[ ❌ Reject ]` buttons.
     * **AI Briefer Mode (Bring-Your-Own Prompt/Model):** Pass the terminal diff through a user-configured system prompt (`AOE_SUMMARIZER_PROMPT_FILE`, defaulting to a clean neutral DevOps Risk Assessor prompt) to summarize *Action*, *Risk Level*, and *Recommendation* before dispatching to mobile. (864zeros can simply load `kate_prompt.md` via config locally without baking Kate into the open-source repo).
3. **Observability & Live Stream (`watching/`):**
   * Subscribes to `helm-daemon` events (and optional `claude-code-intercept` hooks) and serves the live SSE dashboard + SQLite/NDJSON audit log out of the box.

---

## 7. Implementation Roadmap

### Phase 1: `helm-daemon` & Non-Destructive Cursor Ring-Buffer (`cli2cli-helm`)
1. Build `helm-daemon` hosting the `node-pty` session registry over a Windows Named Pipe (`\\.\pipe\cli2cli-helm`) / Unix socket.
2. Implement the cursor-indexed ring buffer (`read(sessionId, cursor)`) so multiple clients (TUI, MCP, AOE) can read concurrently without stealing bytes.
3. Refactor `cli2cli-mcp` into a stateless client of `helm-daemon` (auto-starting the daemon on launch).

### Phase 2: 4-State Engine (`OSC 7501` + Quiescence) & `wait_cli_session`
1. Add `OSC 7501` escape parser + 3-second quiescence timer (`IDLE`) + `HITL_PROMPT_PATTERN` (`BLOCKED`) to transition sessions across `WORKING` | `BLOCKED` | `IDLE` | `EXITED`.
2. Expose the 6th MCP tool: `wait_cli_session` backed by `EventEmitter` state transitions (zero polling).

### Phase 3: The `helm` / `c2c` CLI & `Helm Link`
1. Build the CLI supporting both `helm` / `c2c` (TUI attach) and scriptable JSON subcommands (`list`, `spawn`, `read`, `send`, `wait`, `kill`, `status`).
2. Inject `HELM_SESSION_ID`, `HELM_SLOT`, and `HELM_PIPE` into spawned PTY environments.

### Phase 4: Multi-Pane `helm` TUI & Abstracted `cli2cli-aoe` Connectors
1. Upgrade the TUI (`nucleus.ts` $\rightarrow$ `helm-tui.ts`) with IPC push events, **Detach (`d`)**, **Split-2 / Grid-4 (`v`)**, and `@xterm/headless` screen rendering.
2. Abstract `cli2cli-aoe` so the Summarizer persona is loaded from an external config/prompt file (with a neutral open-source default) and connect `cli2cli-aoe` directly to `helm-daemon`'s event stream.

---
*Released under the MIT License by 864zeros LLC.*
