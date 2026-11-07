# Background jobs and worktrees

The existing synchronous tools remain available. The `agy_*` job tools provide a persistent background queue, process-tree cancellation, timeouts, and isolated Git worktrees. The Codex server exposes corresponding `codex_*` tools.

| Tool                | Title              | Purpose                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agy_agent`         | Agy agent          | Launch with `prompt` or `promptFile`, `cwd`, and optional mode, model, effort, worktree, label, session, and timeout. Returns a job ID immediately.                                                                                                                                       |
| `agy_agent_status`  | Agy agent: status  | State, elapsed time, session ID, and recent stderr/events. Omit `jobId` for live agents.                                                                                                                                                                                                  |
| `agy_agent_result`  | Agy agent: result  | Final text and full file path. `waitSec` is 0-10; output is capped at 20,000 characters.                                                                                                                                                                                                  |
| `agy_agent_follow`  | Agy agent: follow  | Wait for an agent to stop or pause; returns the result plus `watchedSec` and `timedOut`. `maxWaitSec` defaults to 1,800 and is capped at 7,200.                                                                                                                                           |
| `agy_agent_message` | Agy agent: message | Steer a running agent, answer its pending question, or resume a stopped session. Returns `{ delivered: "mid-turn" \| "queued" \| "answer" \| "resumed", jobId }`; `jobId` is the follow-up ID when resumed. Overrides (`mode`, `model`, `effort`, `timeoutMin`) apply only when resuming. |
| `agy_agent_answer`  | Agy agent: answer  | Answer a question with `{ jobId, answer, qid? }`, or an app-server approval with `{ jobId, decision: "accept" \| "acceptForSession" \| "decline" \| "cancel" }`.                                                                                                                          |
| `agy_agent_stop`    | Agy agent: stop    | Stop an owned agent's process tree and wait for termination, up to 10 seconds.                                                                                                                                                                                                            |
| `agy_agent_list`    | Agy agent: list    | Recent agents from the shared store, newest first.                                                                                                                                                                                                                                        |
| `agy_agent_read`    | Agy agent: read    | Read `prompt`, `stdout`, `stderr`, `final`, `patch`, `verify`, `reasoning`, or `notes` by character offset, at most 20,000 characters per page.                                                                                                                                           |
| `agy_agent_retry`   | Agy agent: retry   | Retry a paused, lost, or failed agent's saved prompt. Optional `model` overrides the model; `agent: "codex"` hands it to the sibling server. Failed verification can also be retried.                                                                                                     |
| `agy_agent_collect` | Agy agent: collect | Save a binary patch and diff stat, then optionally remove the worktree or worktree and branch.                                                                                                                                                                                            |

`agy_usage`, `agy_selftest`, and `agy_debug_log` retain their names and existing titles. Worker tools remain `ask_orchestrator` and `report_progress`. Tool names use the supplied connector prefix; the sibling exposes the corresponding `codex_agent` / `codex_agent_*` names, with no old-name aliases.

Example tool arguments:

```json
{
  "prompt": "Implement the requested parser change. Do not commit.",
  "cwd": "/absolute/path/to/repository",
  "mode": "write",
  "worktree": true,
  "label": "parser change",
  "timeoutMin": 120
}
```

The default mode is `read` (`--mode plan`) for inspection. `write` uses `--mode accept-edits --sandbox` with a session-only command allow rule. `trusted` uses the same mode/rule without a sandbox, retaining normal approvals; use it for Git Bash/MSYS2 worktree commands when the Windows sandbox fails. `full` explicitly bypasses permission checks. Job prompts travel over stdin. Windows processes are hidden and npm shims resolve directly to JavaScript.

`agy_agent_result` returns diagnostics only when a job has stopped without final text. Diagnostics are capped at 30 lines, 300 characters per line, and 4,000 characters total. A later final answer supersedes an earlier intermediate error.

`agy_agent_follow` keeps its MCP call pending until the job is completed, failed, killed, paused, or lost, or the wait expires. With a client-supplied progress token it reports immediately on local state changes and at least every 20 seconds while waiting. Messages have the form `running | 42s | last event or step summary`, on one line and capped at 120 characters. The heartbeat reads only metadata and the stdout tail; it never starts a process or probes process liveness. Changes written by another server are observed on the next heartbeat. Without a progress token no notifications are sent. A wait timeout returns `timedOut: true`; cancelling the watch only cancels the wait, leaving the job running. A client disconnect also ends the watch; running jobs continue and save their results after the MCP connection closes. In Claude Code the pending call becomes a background task after two minutes, showing the latest progress message and delivering the result when the watch settles.

`agy_agent_message` takes `jobId` and `message`: it answers a pending question first, queues a stream-json user turn for a running agy worker, or resumes a stopped native session as a new job. Delivery reports `answer`, `queued`, or `resumed`, with `jobId` identifying the resumed job. A queued worker must start or stop before receiving a message. Overrides (`mode`, `model`, `effort`, `timeoutMin`) apply only when resuming. A stopped worker needs a `sessionId` and confirmed process cleanup. Follow-ups inherit its worktree and settings, fall back to the original cwd if the worktree was removed, and share queue and quota limits. `agy_agent_answer` answers a specific pending question without resuming a session.

`agy_agent_retry` creates a replacement from a paused, lost, or failed job's saved prompt, optionally changing its model or handing it to another connector with `agent`. For a paused original, replacement creation and the transition to `killed`/`superseded` happen under the same lock, recording `supersededBy` and `finishedAt`. The connector/model quota pause remains in force for new jobs; a manual requeue can still attempt a retry, and a successful retry can lift that pause. Older paused originals whose retry was cleared and which have a `requeuedFrom` or `followUpOf` replacement are migrated to this terminal state when their owning server's pump next sees them.

## Shared store and ownership

Both forks use `~/.agent-jobs/`, containing `config.json`, a machine lock, and `jobs/<id>/`. Each job saves `meta.json`, `prompt.txt`, `stdout`, `stderr`, `final.txt`, and `patch.diff`. Metadata and completed artifacts use atomic replacement; stdout and stderr are streamed to separate files. Metadata includes the owning server PID and process start time. Other servers can read jobs and answer persisted pending questions by ID; running, steering, updating and cancellation retain ownership checks. Requeue creates a new record, so another server can retry a lost job without rewriting its history.

The machine-wide limit defaults to eight running jobs and is enforced with a lock file; stale locks are reclaimed by tombstone rename. Jobs waiting for a slot stay queued. Running and queued jobs whose owner has died become `lost`; partial output remains available. Recorded Windows descendants are checked against their saved start times before cleanup. Finished jobs older than seven days are pruned at startup. Usage-limit pauses are persisted in `pauses.json`; paused jobs retain reset times and retry after reset; without a reset they require explicit requeue. For a clock-only message such as "try again at 5:37 PM", a reset less than two hours in the past is treated as now plus 60 seconds, including messages received seconds after the named minute. If the retry still hits the limit, its fresh message pauses the job again. Older clock times (two hours or more in the past) resolve to tomorrow; future times remain today. A manual requeue supersedes the source job's automatic retry without clearing the connector/model pause.

```json
{
  "maxJobs": 8,
  "wakeHold": true,
  "connectors": {
    "agy": {
      "enabled": true,
      "defaultModel": "gemini-3.8-flash-high",
      "reviewModel": "gemini-4-argon-high"
    }
  }
}
```

`AGENT_JOBS_HOME` overrides the store directory; tests always use temporary directories. `AGENT_JOBS_MAX` overrides `maxJobs`. Config is read at startup. Enable or disable each connector through its MCP server registration; a missing sibling server does not prevent this server from working. Cross-connector handoffs wait unowned until the target server is running.

While jobs run, a helper inhibits sleep. On Windows Modern Standby systems it also holds the display on; detection is cached for one day. On Linux it uses `systemd-inhibit`. The helper exits when the server's stdin pipe closes, and failure to acquire the hold is non-fatal. Set `wakeHold: false` to disable it.

## Worktrees and collection

Worktrees start from the recorded `HEAD` SHA, under `<root>.worktrees/<label>-<id>`, with an `<connector>/<label>-<id>` branch. If the sibling location is inaccessible, creation falls back into the repository's common Git directory under `agent-jobs-worktrees/`. Dirty main-checkout changes are excluded and produce a warning. The worktree's Git directory is added to the CLI's writable directories.

After the job stops, collect with `remove: "none"`, `"worktree"`, or `"worktree+branch"`. Collection stages all files and diffs against the recorded base with `--binary`, capturing new files, binary files, and worker commits. It saves `patch.diff` before removal, returns a capped patch and full path, and reports removal failures. Applying the patch or merging the branch remains the caller's responsibility.

## Claude Code channel notifications (opt-in)

Claude Code Channels let an MCP server push events into a running session. To enable it, set `CLAUDE_AGENTS=1` in the server's environment and launch Claude Code with `claude-agents` (which runs `claude --dangerously-load-development-channels server:codex server:agy`).

When the variable is unset, the server declares no extra capability and sends nothing, so other MCP clients see no change. When it is set, the server declares `experimental: { 'claude/channel': {} }`, adds one line to its instructions, and sends one notification per job when this server's own job reaches `completed`, `failed`, `killed`, `paused`, or `lost`. Jobs owned by other servers are never announced, and a job is not announced twice for the same state. If the session did not load the server as a channel, Claude Code drops the events silently.

The payload is metadata only. The content is `agy job <state>: call agy_agent_result with this job_id` (with the reset time added for `paused`). The attributes are `job_id`, `state`, `agent`, plus `label` (sanitized to `[A-Za-z0-9_-]`, 40 characters at most), `reason`, and `reset_at` when known. Superseding a paused job sends one `killed` transition with `reason: "superseded"` and `superseded_by` identifying its replacement. Worker output (final text, stdout, stderr, patch) is never included, because it would be a prompt-injection vector; call `agy_agent_result` to read it. A failed push is logged and never affects the job.

## Usage

`codex_usage` first asks a short-lived `codex app-server` for live quota without a model turn. If unavailable, it reads the newest `rate_limits` snapshot in `~/.codex/sessions`. `source` is `live` or `session-log` (also present when unavailable), with `available` and optional `reason`. Successful reports include `snapshotAt` (ISO), `snapshotAgeSec`, `meter`, and `fiveHour` / `weekly` windows. Each window has `usedPercent`, `windowMinutes`, `resetsAt` (epoch seconds), `resetAtIso`, and `resetIn`. Reset credits are reported when supplied; they are never spent automatically.

`agy_usage` uses the same snapshot, meter and window fields, nested under vendor-specific `groups`, with `source: live | cache`. Its legacy `refresh` argument respects the shared cache; `tallies` adds local job token totals. Compatibility aliases `takenAt`, `summary`, and window `resetAt` remain available. Quota messages in either connector share absolute ISO, relative duration / retry-delay, and clock-only reset parsing, including the just-passed-time rule above. A model named in a quota message scopes the pause to that model.

`health` includes CLI detection (`available`, `exe`, `reason` when known), version, authentication, model IDs, effective `reviewModel`, `defaultModel`, and `jobsEnabled` within `codexCli` / `agyCli`. Codex additionally reports binary resolution and minimum-version features. Failed health checks retain their structured output shape.

Shared agy read jobs and legacy synchronous tools send one NDJSON prompt initially. Only an empty first response or non-empty `denied_actions` triggers the recovery turn; stdin then closes. A complete first response closes stdin immediately. An empty recovery response preserves an earlier non-empty answer. Timeouts and cancellation close stdin before cleanup. Codex continues to write its prompt and close stdin immediately. Legacy `bg-antigravity` (also used by detached delegate jobs) retains its buffered two-turn read input because it captures stdout directly into files; use `agy_agent` for conditional recovery.

## Development

`src/jobs/` is canonical in the sibling Codex fork. From that fork in Git Bash, `bash scripts/sync-jobs.sh [sibling-repository]` copies it here (the script is identical in both repos and expects both to sit side by side). The comparison test fails on differences when the sibling copy exists. Set `AGENT_JOBS_MIRROR` to require comparison against a specific copy.

Run `npm test` for the fake-worker suite; it starts no real vendor CLIs. Real CLI integration, resume behavior, orphan cleanup with CLI-created commands, Fedora wake inhibition, and a human check for window flashes require a separate opt-in integration run.

## MCP tasks, diagnostics and worker bridge

Only `agy_agent` and `agy_agent_follow` accept task augmentation. Tasks use the status-discriminated modern protocol; `tasks/get` and notifications never mark a result collected. Only `agy_agent_result` and `agy_agent_follow` write that marker. MCP-task jobs never emit channel events; other jobs require the `claude-agents` launcher (`CLAUDE_AGENTS=1`). Channel markers are independent of hook wake markers.

`agy_selftest` exercises the task transport using fake jobs. `agy_debug_log` reads the bounded traffic log; argument strings outside the metadata allowlist are redacted.

Run `npm run build`, then `bash scripts/install-agy-bridge.sh` once to register `agent_bridge` in `%USERPROFILE%\.gemini\config\mcp_config.json` (POSIX: `~/.gemini/config/mcp_config.json`). The script backs up the original, preserves other servers, is idempotent, and supports `--uninstall`. `AGY_MCP_CONFIG_PATH` redirects only the installer for isolated tests; agy 1.5.2 ignores that override and project MCP files.

The registration contains the absolute Node executable and `dist/bridge/agent-bridge.js` path, a long `timeoutSeconds`, and no job-specific environment. The job runner supplies `AGENT_JOB_ID` and `AGENT_JOBS_HOME` to agy; the bridge uses the inherited environment. Without worker identity it advertises no tools and closes quietly on stdin EOF. Actual agy-to-MCP environment inheritance has not been verified without a model turn; fake-child tests cover the runner's propagation.

Every mode allows `mcp(agent_bridge/*)` through session-only `--settings`. Jobs add the `ask_orchestrator` / `report_progress` preamble only when the global config contains the bridge entry. Workers share a question claim; stale mailboxes and mismatched/expired question IDs cannot receive another question's answer. `agy_agent_answer` accepts `{ jobId, qid?, answer }`; MCP tasks expose `input_required` with `elicitation/create`, and `tasks/update` acknowledges answers or approval decisions with plain `{}`.

Detection, optional-agent quota guards and `agy_usage` share `getUsage("agy", probe)` in `src/jobs/usage-cache.ts`: one machine-wide `/usage` probe per five minutes on AC, or fifteen minutes on battery or after failure. Concurrent readers use the previous snapshot without waiting. Detection derives authentication from the cached raw usage response and starts no separate sign-in probe. The legacy `refresh` argument no longer bypasses the shared cache. `tallies` adds local token totals.
