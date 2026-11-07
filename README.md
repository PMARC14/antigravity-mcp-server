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

| Tool                                                                  | Description                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask-antigravity`                                                     | Run a prompt through `agy` in print mode. Supports model override, session resume, `--add-dir`, `--sandbox`, `--dangerously-skip-permissions`, dry-run. |
| `plan-antigravity`                                                    | Generate a structured implementation plan (JSON or markdown) without mutating anything.                                                                 |
| `review-changes`                                                      | Collect a git diff (working tree / vs base branch / specific commit) and run a structured code review.                                                  |
| `brainstorm`                                                          | Structured ideation (divergent, convergent, SCAMPER, design-thinking, lateral).                                                                         |
| `digest-antigravity`                                                  | Ingest many files/directories and answer a focused question using Antigravity's large model context.                                                    |
| `batch-antigravity`                                                   | Run multiple atomic tasks sequentially or in parallel (priority order, stop-on-error, concurrency cap).                                                 |
| `bg-antigravity`                                                      | Detached background tasks: start / status / tail / stop / remove / list. State persists in `~/.agy-mcp/bg/` across server restarts.                     |
| `delegate-antigravity`                                                | Delegate an implementation task into an isolated git worktree; poll status, then `collect` the diff for selective review.                               |
| `agy_agent`, `agy_agent_status`, `agy_agent_result`, `agy_agent_stop` | Start, inspect, retrieve or cancel shared background jobs.                                                                                              |
| `agy_agent_follow`, `agy_agent_message`, `agy_agent_answer`           | Follow progress, steer/resume a session, or answer a pending question.                                                                                  |
| `agy_agent_list`, `agy_agent_read`, `agy_agent_retry`                 | List jobs, read saved files or requeue a stopped job.                                                                                                   |
| `agy_agent_collect`                                                   | Save a worktree patch and optionally remove the worktree or branch.                                                                                     |
| `agy_usage`                                                           | Query agy usage limits without a model turn.                                                                                                            |
| `list-sessions`                                                       | List / delete / clear conversation sessions.                                                                                                            |
| `list-models`                                                         | List model labels currently available (`agy models`).                                                                                                   |
| `health`                                                              | Diagnose CLI installation, authentication, models, and session state.                                                                                   |
| `ping`, `Help`, `version`, `metrics`                                  | Utilities.                                                                                                                                              |

Ask, plan, review, brainstorm, digest, batch, background and delegate accept `mode`, `effort` and `jsonSchema`. `agy_agent` accepts `mode` and `effort`.

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

Prompts initially use one JSON-encoded NDJSON user event on stdin with `--input-format stream-json --output-format stream-json`. The server reads the conversation ID from `init` or `result` events, using the CLI log only as a fallback. The next call with the same `sessionId` resumes via `agy --conversation <uuid>`.

You can also pass a native `conversationId` directly, or `continueLatest: true` for `agy --continue`.

Session storage is in-memory (lost on server restart). Configure with:

- `AGY_SESSION_TTL_MS` — session TTL (default 24h)
- `AGY_MAX_SESSIONS` — max stored sessions (default 50)
- `AGY_MCP_CWD` — default working directory for `agy` runs

## Safety and execution options

- `read` uses `--mode plan` with a session-only read-only command allowlist. Stdin stays open until the first result. A follow-up requests the final answer only if that result reports non-empty `denied_actions` or an empty response; stdin then closes. Complete first answers finish immediately. A later empty response preserves the earlier non-empty answer. Normal timeout or cancellation closes stdin and terminates the process when no result arrives.
- `write` uses `--mode accept-edits --sandbox` with the session-only settings rule `{"permissions":{"allow":["command(*)"]}}`, allowing shell commands to run headless.
- `trusted` uses `--mode accept-edits` with the same command rule, without `--sandbox`; normal approvals apply. It supports worktree jobs on the user's own repos when the Windows sandbox breaks Git Bash/MSYS2.
- `full` uses `--dangerously-skip-permissions` and requires an explicit request.

Permission skipping is never the default. `agy_agent` defaults to read. Legacy `skipPermissions: true` selects full mode; `sandbox: true` selects write mode. Explicit false values disable those features (`sandbox: false` selects read when mode is omitted). Conflicting mode and legacy flags are rejected. Defaults are applied after checking caller input so `mode: "full"` works without an implicit false flag conflicting with it.

Every mode also allows `mcp(agent_bridge/*)` for the installed worker bridge.

The existing execution tools accept `effort` (low, medium, high, xhigh, max) and `jsonSchema` (a schema object or JSON string). Settings and schemas are individual argv elements; prompts never enter a shell or the command line.

Legacy `bg-antigravity` and detached delegate jobs capture stdout directly to files and retain their existing buffered two-turn read input. Use `agy_agent` for conditional read recovery.

Background records stay in `~/.agy-mcp/bg/`. New records keep the full prompt in a separate file and stdout/stderr separately; old records remain readable. Tasks whose process disappeared without a recorded exit have unknown status. Delegate collection stages all changes, saves a binary-capable patch against the starting SHA, and returns at most 20k characters per output plus the patch path before optional cleanup.

Shared jobs use `~/.agent-jobs` (overridable with `AGENT_JOBS_HOME`). The `claude-agents` launcher sets `CLAUDE_AGENTS=1` for metadata-only notifications (`claude --dangerously-load-development-channels server:codex server:agy`). `agy_usage` runs `agy -p /usage --output-format json`.

## MCP tasks (no launch flag)

Task-enabled Claude Code clients can show `agy_agent` and `agy_agent_follow` in `/tasks` immediately and wake the model when they finish, without a channel environment variable or development-channel launch flag. Client task and wake feature gates still apply. The server supports both the 2026-07-28 tasks extension (`server/discover`, per-request `_meta` client capabilities, `resultType: "task"`) and the 2025-11-25 `task: {}` parameter.

Task IDs are job IDs, retained across reconnects. Task watch adopts an existing job immediately and follows pauses and retries independently of `maxWaitSec`; its final payload is `agy_agent_result`. Use `tasks/get`, `tasks/list`, `tasks/result`, and `tasks/cancel` to inspect, list, await, or stop tasks. Cancelling a result wait or disconnecting leaves running jobs intact. Only explicit result/follow tools write `collected`; task polling, notifications and payload reads do not. MCP-task jobs never emit channel notifications. Ordinary calls keep the follow behavior below.

## Watching jobs and sending follow-ups

`agy_agent_follow` keeps the MCP call pending until the job completes, fails, is killed, pauses, or is lost, or the wait expires. Pass `jobId` and optional `maxWaitSec` (default 1,800, maximum 7,200); the result includes `watchedSec` and `timedOut`. With a client progress token, local state changes report immediately and a heartbeat reports at least every 20 seconds. Messages look like `running | 42s | last event or step summary`, on one line and capped at 120 characters. Heartbeats read only metadata and the stdout tail, without starting processes or probing liveness; other servers' changes appear on the next heartbeat. No token means no notifications. A timeout returns `timedOut: true`; cancelling or disconnecting ends the wait while running jobs continue and save their results. In Claude Code, the pending call becomes a background task after two minutes, showing the latest progress and delivering the result when it settles.

`agy_agent_message` takes `jobId` and `message`: it answers a pending question first, queues a stream-json user turn for a running agy worker, or resumes a stopped native session as a new job. Delivery reports `answer`, `queued`, or `resumed`, with `jobId` identifying the resumed job. A queued worker must start or stop before receiving a message. Overrides (`mode`, `model`, `effort`, `timeoutMin`) apply only when resuming. A stopped worker needs a `sessionId` and confirmed process cleanup. Follow-ups inherit its worktree and settings, fall back to the original cwd if the worktree was removed, and share queue and quota limits. `agy_agent_answer` answers a specific pending question without resuming a session.

## Development

```bash
npm test            # build and run node --test
npm run lint        # tsc --noEmit
npm run format      # prettier
```

## License

MIT

Shared job tools, quota and health fields are documented in [docs/agent-jobs.md](docs/agent-jobs.md). The [symmetry audit](docs/job-surface-audit.md) records intentional vendor differences and legacy-tool recommendations.

### Diagnostics and worker bridge

`agy_selftest` exercises the task transport using fake jobs. `agy_debug_log` reads the bounded traffic log; argument strings outside the metadata allowlist are redacted.

Run `npm run build`, then `bash scripts/install-agy-bridge.sh` once to register `agent_bridge` in `%USERPROFILE%\.gemini\config\mcp_config.json` (POSIX: `~/.gemini/config/mcp_config.json`). The script backs up the original, preserves other servers, is idempotent, and supports `--uninstall`. `AGY_MCP_CONFIG_PATH` redirects only the installer for isolated tests; agy 1.5.2 ignores that override and project MCP files.

The registration contains the absolute Node executable and `dist/bridge/agent-bridge.js` path, a long `timeoutSeconds`, and no job-specific environment. The job runner supplies `AGENT_JOB_ID` and `AGENT_JOBS_HOME` to agy; the bridge uses the inherited environment. Without worker identity it advertises no tools and closes quietly on stdin EOF. Actual agy-to-MCP environment inheritance has not been verified without a model turn; fake-child tests cover the runner's propagation.

Every mode allows `mcp(agent_bridge/*)` through session-only `--settings`. Jobs add the `ask_orchestrator` / `report_progress` preamble only when the global config contains the bridge entry. Workers share a question claim; stale mailboxes and mismatched/expired question IDs cannot receive another question's answer. `agy_agent_answer` accepts `{ jobId, qid?, answer }`; MCP tasks expose `input_required` with `elicitation/create`, and `tasks/update` acknowledges answers or approval decisions with plain `{}`.

### Shared usage cache

Detection, optional-agent quota guards and `agy_usage` share `getUsage("agy", probe)` in `src/jobs/usage-cache.ts`: one machine-wide `/usage` probe per five minutes on AC, or fifteen minutes on battery or after failure. Concurrent readers use the previous snapshot without waiting. Detection derives authentication from the cached raw usage response and starts no separate sign-in probe. The legacy `refresh` argument no longer bypasses the shared cache. `tallies` adds local token totals.
