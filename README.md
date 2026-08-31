# @864zeros/cli2cli-mcp

Bi-directional MCP bridge for driving **headless interactive AI CLIs** (Claude Code,
Gemini CLI, or any command) inside a pseudo-terminal. It is the open-core foundation for
a gateway-driven, human-in-the-loop CLI orchestration layer — the piece a gateway
(Telegram/SMS/webhook) drives to run and supervise CLI sessions remotely, with a
Human-in-the-Loop (HITL) pause on interactive confirmation prompts.

> Target host is a **Windows** mini-PC (ConPTY via `node-pty`). The server also runs on
> POSIX; binary resolution and shell defaults are platform-aware.

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

## Status

v0.1 — MCP core only. Next: the Telegram gateway + SQLite trace/HITL layer (Windows
service, not systemd).
