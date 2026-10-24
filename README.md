# cli2cli-mcp

Bi-directional MCP bridge for driving **headless interactive AI CLIs** (Claude Code,
Gemini CLI, or any command) inside a pseudo-terminal. It is the open-core foundation for
a gateway-driven, human-in-the-loop CLI orchestration layer — the piece a gateway
(Telegram/SMS/webhook) drives to run and supervise CLI sessions remotely, with a
Human-in-the-Loop (HITL) pause on interactive confirmation prompts.

> Target host is a **Windows** mini-PC (ConPTY via `node-pty`). The server also runs on
> POSIX; binary resolution and shell defaults are platform-aware.

## Technical White Paper

Read the full architectural specification, comparative analysis, and benchmarks:  
📖 **[cli2cli: Process-Level Multi-Agent Orchestration via Bi-Directional Pseudo-Terminal Bridges](docs/cli2cli-whitepaper-process-level-agent-orchestration.md)**
- **The Process-Level Wedge:** Why API-level agent frameworks (LangChain, CrewAI, Swarm) collapse on real developer tools.
- **The ConPTY Pseudo-Terminal Bridge:** Full 120x40 terminal emulation with raw ANSI stream handling.
- **Non-blocking HITL Detection:** Empirical heuristic that flags `(y/n)` prompts before sessions deadlock.
- **The Kate Governance Protocol:** Implementing RULE-000 (*"Machine recommends; human signs"*).
- **Zero Token Overhead:** $0.00 external orchestration cost; agents run on host hardware.

## Tools

| Tool | Purpose |
|------|---------|
| `spawn_cli_session` | Allocate a PTY and launch a CLI (`claude` / `gemini` / `shell` / `custom`). Returns a `session_id`. |
| `read_cli_stream` | Drain unread PTY output; report `is_waiting_for_input` (HITL) and exit state. |
| `write_cli_input` | Feed stdin — confirmations (`y`/`n`), answers, follow-up prompts. |
| `list_cli_sessions` | Enumerate live sessions and their state. |
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

## Nucleus Cockpit (Single-Terminal Mission Control)

Launch the 8-slot interactive TUI supervisor over MCP stdio:

```sh
npm run build
npm run nucleus
```

- **`1`–`8`**: Switch focus between the 8 ConPTY session slots
- **`y` / `n`**: Instant HITL confirmation (`write_cli_input`) when a slot flags `⚠️ WAIT y/n`
- **`i` / `Enter`**: Type a prompt or command into the focused slot
- **`s`**: Spawn a session in the focused slot (`claude`, `gemini`, `agy`, `shell`, or `custom <cmd>`)
- **`d`**: Spawn an interactive HITL probe to test audio bell (`\x07`) + `⚠️ WAIT` alert + `y`/`n` approval
- **`r`**: Toggle raw keystroke passthrough (`append_newline: false`) for interactive TUI menus (`Esc` to exit)
- **`k`**: Terminate the focused slot's session
- **`↑` / `↓` / `PgUp` / `PgDn`**: Scroll through the slot's 500-line ring buffer (full streams also logged to `logs/`)
- **`q`**: Cleanly terminate active sessions and exit

## Status

v0.1 — MCP core + Nucleus 8-slot TUI cockpit. Next: the Telegram gateway + SQLite trace/HITL layer (Windows
service, not systemd).
