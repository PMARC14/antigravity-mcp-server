# Antigravity MCP Server

MCP (Model Context Protocol) server for [Google Antigravity CLI](https://antigravity.google/docs/cli-getting-started) (`agy`) integration. Lets any MCP client (Claude Code, Claude Desktop, Cursor, etc.) delegate tasks to Antigravity's agentic CLI — with model selection (Gemini, Claude, GPT-OSS), conversation resume, and workspace controls.

A sibling of [@trishchuk/kimi-mcp-server](https://github.com/x51xxx/kimi-mcp-server), ported to the Antigravity CLI.

## Requirements

- Node.js >= 18
- [Antigravity CLI](https://antigravity.google/docs/cli-getting-started) installed (`agy --version` works) and authenticated (run `agy` once interactively and sign in with your Google account)

## Installation

```bash
npm install -g @trishchuk/antigravity-mcp-server
```

Or run from source:

```bash
npm install && npm run build
```

## MCP client configuration

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "npx",
      "args": ["-y", "@trishchuk/antigravity-mcp-server"],
      "env": {
        "AGY_MCP_CWD": "/path/to/your/project"
      }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add antigravity -- npx -y @trishchuk/antigravity-mcp-server
```

## Tools

| Tool                                 | Description                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask-antigravity`                    | Run a prompt through `agy` in print mode. Supports model override, session resume, `--add-dir`, `--sandbox`, `--dangerously-skip-permissions`, dry-run. |
| `plan-antigravity`                   | Generate a structured implementation plan (JSON or markdown) without mutating anything.                                                                 |
| `review-changes`                     | Collect a git diff (working tree / vs base branch / specific commit) and run a structured code review.                                                  |
| `brainstorm`                         | Structured ideation (divergent, convergent, SCAMPER, design-thinking, lateral).                                                                         |
| `digest-antigravity`                 | Ingest many files/directories and answer a focused question using Antigravity's large model context.                                                    |
| `batch-antigravity`                  | Run multiple atomic tasks sequentially or in parallel (priority order, stop-on-error, concurrency cap).                                                 |
| `bg-antigravity`                     | Detached background tasks: start / status / tail / stop / remove / list. State persists in `~/.agy-mcp/bg/` across server restarts.                     |
| `delegate-antigravity`               | Delegate an implementation task into an isolated git worktree; poll status, then `collect` the diff for selective review.                               |
| `agy_job_start`, `agy_job_status`, `agy_job_result`, `agy_job_cancel` | Start, inspect, retrieve or cancel shared background jobs. |
| `agy_job_list`, `agy_job_read`, `agy_job_requeue` | List jobs, read saved files or requeue a stopped job. |
| `agy_worktree_collect` | Save a worktree patch and optionally remove the worktree or branch. |
| `agy_usage` | Query agy usage limits without a model turn. |
| `list-sessions`                      | List / delete / clear conversation sessions.                                                                                                            |
| `list-models`                        | List model labels currently available (`agy models`).                                                                                                   |
| `health`                             | Diagnose CLI installation, authentication, models, and session state.                                                                                   |
| `ping`, `Help`, `version`, `metrics` | Utilities.                                                                                                                                              |

Ask, plan, review, brainstorm, digest, batch, background and delegate accept `mode`, `effort` and `jsonSchema`. `agy_job_start` accepts `mode` and `effort`.

Background, delegate and batch tools default to `mode: "write"`, with permission skipping disabled. This changes the previous automatic full-permission behavior. Ask, digest, review, plan and brainstorm default to `mode: "read"`.

## Models

The `model` parameter accepts IDs or display labels from `agy models`. Known IDs in agy 1.4.9:

| Model             | IDs                                   |
| ----------------- | ------------------------------------- |
| Gemini 4 Argon    | `gemini-4-argon-{low,medium,high}`    |
| Gemini 3.8 Flash  | `gemini-3.8-flash-{low,medium,high}`  |
| Claude Opus 5.5   | `claude-opus-5-5-{low,medium,high}`   |
| Claude Sonnet 5.5 | `claude-sonnet-5-5-{low,medium,high}` |
| GPT-OSS 120B      | `gpt-oss-120b-medium`                 |

The server explicitly defaults to `gemini-3.8-flash-high`; review uses `gemini-4-argon-high`. Claude models are only used when requested. Use `list-models` for the live list.

## Sessions and conversation resume

`ask-antigravity` supports multi-turn conversations:

```json
{
  "prompt": "Analyze src/auth.ts for security issues",
  "sessionId": "auth-review"
}
```

```json
{
  "prompt": "Now suggest fixes for the issues you found",
  "sessionId": "auth-review"
}
```

Prompts always use one JSON-encoded NDJSON user event on stdin with `--input-format stream-json --output-format stream-json`. The server reads the conversation ID from `init` or `result` events, using the CLI log only as a fallback. The next call with the same `sessionId` resumes via `agy --conversation <uuid>`.

You can also pass a native `conversationId` directly, or `continueLatest: true` for `agy --continue`.

Session storage is in-memory (lost on server restart). Configure with:

- `AGY_SESSION_TTL_MS` — session TTL (default 24h)
- `AGY_MAX_SESSIONS` — max stored sessions (default 50)
- `AGY_MCP_CWD` — default working directory for `agy` runs

## Safety and execution options

- `read` uses `--mode plan` with a session-only read-only command allowlist. A follow-up turn requests the final answer because plan mode otherwise stops after planning; denied commands can abort a headless run.
- `write` uses `--mode accept-edits --sandbox` with the session-only settings rule `{"permissions":{"allow":["command(*)"]}}`, allowing shell commands to run headless.
- `trusted` uses `--mode accept-edits` with the same command rule, without `--sandbox`; normal approvals apply. It supports worktree jobs on the user's own repos when the Windows sandbox breaks Git Bash/MSYS2.
- `full` uses `--dangerously-skip-permissions` and requires an explicit request.

Permission skipping is never the default. `agy_job_start` defaults to read. Legacy `skipPermissions: true` selects full mode; `sandbox: true` selects write mode. Explicit false values disable those features (`sandbox: false` selects read when mode is omitted). Conflicting mode and legacy flags are rejected. Defaults are applied after checking caller input so `mode: "full"` works without an implicit false flag conflicting with it.

The existing execution tools accept `effort` (low, medium, high, xhigh, max) and `jsonSchema` (a schema object or JSON string). Settings and schemas are individual argv elements; prompts never enter a shell or the command line.

Background records stay in `~/.agy-mcp/bg/`. New records keep the full prompt in a separate file and stdout/stderr separately; old records remain readable. Tasks whose process disappeared without a recorded exit have unknown status. Delegate collection stages all changes, saves a binary-capable patch against the starting SHA, and returns at most 20k characters per output plus the patch path before optional cleanup.

Shared jobs use `~/.agent-jobs` (overridable with `AGENT_JOBS_HOME`). Opt in to metadata-only job stop notifications with `AGENT_JOBS_CHANNEL=1`; Claude Code must be launched with `claude-agents` (`claude --dangerously-load-development-channels server:codex server:agy`). `agy_usage` runs `agy -p /usage --output-format json`.

## Development

```bash
npm test            # build and run node --test
npm run lint        # tsc --noEmit
npm run format      # prettier
```

## License

MIT
