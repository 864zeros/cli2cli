# cli2cli-mcp

Bi-directional MCP bridge for driving **headless interactive AI CLIs** (Claude Code,
Gemini CLI, or any command) inside a pseudo-terminal. It is the open-core foundation for
a gateway-driven, human-in-the-loop CLI orchestration layer — the piece a gateway
(Telegram/SMS/webhook) drives to run and supervise CLI sessions remotely, with a
Human-in-the-Loop (HITL) pause on interactive confirmation prompts.

> Target host is a **Windows** mini-PC (ConPTY via `node-pty`). The server also runs on
> POSIX; binary resolution and shell defaults are platform-aware.

## Technical White Paper & `cli2cli-helm` Specification

Read the full architectural specifications, comparative analyses, and benchmarks:  
📖 **[cli2cli: Process-Level Multi-Agent Orchestration via Bi-Directional Pseudo-Terminal Bridges](docs/cli2cli-whitepaper-process-level-agent-orchestration.md)**  
⚓ **[cli2cli-helm & The 3-Pillar Open-Source Ecosystem Spec](docs/cli2cli-helm-spec.md)**  
📊 **[Interactive HTML Report & Embedded SVG Diagrams](cli2cli-helm-overview.html)**
- **The Process-Level Wedge:** Why API-level agent frameworks (LangChain, CrewAI, Swarm) collapse on real developer tools.
- **Persistent Named Pipe Daemon (`helm-daemon`):** Decouples PTY lifecycles from MCP `stdio` over `\\.\pipe\cli2cli-helm` (`~/.cli2cli/helm.sock` on POSIX) with a 500KB non-destructive cursor ring buffer.
- **Deterministic 4-State Engine:** Tracks `WORKING` | `BLOCKED` | `IDLE` | `EXITED` via **OSC 7501** escape sequences, the ANSI regex heuristic, and a 3s quiescence timer.
- **Open-Source 3-Pillar Stack:** Combines `cli2cli-helm` (local multiplexer + `c2c` CLI), `cli2cli-mcp` (6-tool MCP server), and `cli2cli-aoe` (outward mobile HITL command center & SSE dashboard).
- **Zero Token Overhead:** $0.00 external orchestration cost; agents run on host hardware.

## Tools (v0.2.0 — 6 Primitives)

| Tool | Purpose |
|------|---------|
| `spawn_cli_session` | Allocate a persistent PTY slot and launch a CLI (`claude` / `gemini` / `agy` / `shell` / `custom`). Injects `HELM_SLOT` & `HELM_PIPE` (`Helm Link`). |
| `read_cli_stream` | Non-destructively read PTY output from cursor/consumer offset; report 4-state (`WORKING`, `BLOCKED`, `IDLE`, `EXITED`) and `next_cursor`. |
| `write_cli_input` | Feed stdin — confirmations (`y`/`n`), answers, follow-up prompts. Clears `BLOCKED` state. |
| `wait_cli_session` | Event-driven block until session reaches `blocked`, `idle`, `exited`, or matches a regex `pattern` (eliminates polling loops). |
| `list_cli_sessions` | Enumerate live and exited sessions across `helm-daemon`. |
| `terminate_cli_session` | Kill a session and free resources. |

### HITL detection
`read_cli_stream` flips `is_waiting_for_input` to `true` when the output stream matches a
confirmation-prompt heuristic (`(y/n)`, `approve`, `overwrite`, `❯` menu selectors, …).
That is the signal a gateway turns into an Approve / Reject decision. Any input written
via `write_cli_input` clears the flag.

## Build

```sh
npm install      # builds node-pty against your Node ABI (needs build tools on Windows)
npm run build    # tsc -> dist/
```

## Register as an MCP server

**Claude Code** (this repo's target driver):

```sh
claude mcp add cli2cli -- node "/path/to/cli2cli/dist/index.js"
```

Or add to an MCP client config manually:

```json
{
  "mcpServers": {
    "cli2cli": {
      "command": "node",
      "args": ["/path/to/cli2cli/dist/index.js"]
    }
  }
}
```

## Smoke test (no MCP client needed)

`npm run build` then run `node scripts/smoke.mjs` to spawn a `shell` session, drive it,
and print the round-tripped output.

## `cli2cli-helm` (`c2c`) Multi-Pane Multiplexer & Scriptable CLI

Launch the persistent 8-slot interactive TUI multiplexer or run the self-running 4-pane swarm demo:

```sh
npm run build
npm link         # exposes `c2c` and `cli2cli-helm` globally
c2c demo         # launches 4-pane Swarm Demo in GRID4 view
c2c              # attaches TUI cockpit to helm-daemon
```

### TUI Keybindings
- **`1`–`8`**: Switch focus between the 8 ConPTY session slots
- **`v`**: Cycle viewport layout: **`SINGLE`** $\rightarrow$ **`SPLIT2`** (2-up side-by-side) $\rightarrow$ **`GRID4`** ($2\times 2$ quad grid)
- **`y` / `n`**: Instant HITL confirmation (`session.write`) when a slot flags `⚠️ WAIT y/n`
- **`i` / `Enter`**: Type a prompt or command into the focused slot
- **`s`**: Spawn a session in the focused slot (`claude`, `gemini`, `agy`, `shell`, or `custom <cmd>`)
- **`d` / `D`**: `[d]` launches the 4-pane Swarm Demo in `GRID4`; `[D]` launches a single-slot HITL probe
- **`r`**: Toggle raw keystroke passthrough (`append_newline: false`) for interactive TUI menus (`Esc` to exit)
- **`k`**: Terminate the focused slot's session
- **`q` / `Q`**: `[q]` **Detaches** from the TUI while keeping agents alive in `helm-daemon`; `[Q]` terminates all sessions and exits

### Scriptable JSON CLI (`c2c`)
```sh
c2c ping
c2c list
c2c spawn claude "Audit auth.ts" --slot 1
c2c wait 1 --until blocked,idle,exited --timeout 60000
c2c send 1 "y"
c2c read 1 --tail 2000
c2c kill 1
c2c status blocked   # emits OSC 7501 status sequence
```

## Status

v0.2.0 — Persistent `helm-daemon` over Named Pipe + Cursor Ring Buffer + 4-State Engine (`OSC 7501` + regex) + 6-tool MCP server (`wait_cli_session`) + Multi-Pane `c2c` / `cli2cli-helm` TUI & Swarm Demo.
