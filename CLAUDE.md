# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## Project Overview

MCP server connecting clients to Google Antigravity CLI (`agy` 1.4.x). It provides synchronous tools, legacy background/delegation tools, and shared background jobs.

## Commands

```bash
npm run build       # tsc -> dist/
npm run lint        # tsc --noEmit
npm test            # build, then node --test on dist/**/*.test.js
```

## Architecture

- `src/index.ts` — MCP server entry, stdio transport and progress notifications.
- `src/tools/registry.ts` and `src/tools/index.ts` — tool interface and registration; individual tool schemas are in `src/tools/`.
- `src/utils/agyCommandBuilder.ts` — builds argv and stdin for agy. Prompts are NDJSON user events on stdin with `--input-format stream-json --output-format stream-json`. Shared jobs and synchronous read mode send one turn initially, keeping stdin open for conditional recovery. Legacy detached bg/delegate keep buffered two-turn read input because stdout is captured directly to files.
- `src/utils/agyExecutor.ts` and `src/connectors/agy.ts` — parse stream-json events: conversation IDs come from `init` or `result`, final text from `result.response`. The executor can fall back to the CLI log for the ID.
- `src/utils/sessionStorage.ts` — in-memory sessions and per-session locking.
- `src/utils/bgTaskManager.ts` — legacy background tasks stored in `~/.agy-mcp/bg/`; `delegate-antigravity` uses worktrees.
- `src/jobs/` — shared jobs module, synced from the Codex fork, which is its source of truth. Do not edit it here; `scripts/sync-jobs.sh` copies it and `src/jobs/sync.test.ts` checks synchronization.

## Modes and CLI behavior

- `read`: `--mode plan` and a session-only `--settings` allowlist for `git status`, `git diff`, `git log`, `git show`, `rg`, `Get-ChildItem`, `Get-Content`, `ls` and `cat`. The prompt asks the agent to avoid shell commands because an auto-denied command aborts a headless run. On the first result, send a second stdin turn only if denied_actions is non-empty or the response is empty, then close stdin. Otherwise close immediately and retain the first answer. A later empty response never replaces an earlier non-empty one. Timeout and cancellation close stdin and terminate the process.
- `write`: `--mode accept-edits --sandbox` and session-only `--settings` allowing `command(*)`.
- `trusted`: `--mode accept-edits` and the same `command(*)` rule, without `--sandbox`. Normal approvals still apply. Use for worktree jobs on the user's own repos when the Windows sandbox breaks Git Bash/MSYS2.
- `full`: `--dangerously-skip-permissions`; bypasses sandbox and approvals and requires an explicit request.

The existing ask, digest, review, plan and brainstorm tools default to read; background, delegate and batch default to write. `agy_agent` defaults to read. `mode`, `effort` and `jsonSchema` are wired into the existing execution tools; legacy `sandbox` and `skipPermissions` options are checked for conflicts.

The shared tools are `agy_agent`, `agy_agent_status`, `agy_agent_result`, `agy_agent_follow`, `agy_agent_message`, `agy_agent_resume`, `agy_agent_answer`, `agy_agent_stop`, `agy_agent_list`, `agy_agent_read`, `agy_agent_retry` and `agy_agent_collect`. Jobs share `~/.agent-jobs` with the Codex fork; `AGENT_JOBS_HOME` overrides it. `agy_usage` runs `agy -p /usage --output-format json` without a model turn.

## MCP tasks (no launch flag)

`agy_agent`, `_follow`, `_retry`, `_resume`, `_answer` and resuming `_message` calls support MCP tasks (2026-07-28 `server/discover`, per-request `_meta` capabilities, `resultType: "task"`; also the 2025-11-25 `task: {}` parameter). The server connects before job initialization so discovery is never delayed.

A task, or a pending call when the client has no tasks, ends at the job's next event: `stopped`, `paused`, `question` or `approval`; the result carries `event` and `jobId`. Worker questions go to Claude, never to a user form. Answer with `agy_agent_answer`, which starts a new task tracking to the following event. Cancelling a wait or disconnecting leaves the worker running. Only explicit result/follow tools write `collected`.

## Watching jobs and sending follow-ups

`agy_agent_follow` keeps its MCP call pending until the job completes, fails, is killed, pauses, or is lost, or the wait expires. `maxWaitSec` defaults to 1,800 and is capped at 7,200; the result includes `watchedSec` and `timedOut`. With a progress token, it reports local state changes immediately and sends a heartbeat at least every 20 seconds, using one-line messages like `running | 42s | last event or step summary` capped at 120 characters. The heartbeat reads metadata and the stdout tail without starting a process or probing liveness; changes from other servers appear on the next heartbeat. Without a token it sends no notifications. Timeout returns `timedOut: true`; cancellation ends only the wait. Disconnect also ends the watch while running jobs continue and save results. In Claude Code, the pending call becomes a background task after two minutes, showing the latest progress and delivering the result when it settles.

`agy_agent_message` takes `jobId` and `message`: it queues a stream-json user turn for a running worker, or resumes a stopped or failed session as a new job (like `agy_agent_resume`). It rejects pending questions and names `agy_agent_answer`. Overrides (`mode`, `model`, `effort`, `timeoutMin`) apply only when resuming. Follow-ups inherit the worktree and settings, fall back to the original cwd if the worktree was removed, and share queue and quota limits.

## Conventions

- ESM (`"type": "module"`), Node16 module resolution; relative imports need `.js` extensions.
- Existing tool names use the `ask-antigravity` style; shared job tools use the `agy_` prefix.

## Job surface parity

See [docs/agent-jobs.md](docs/agent-jobs.md) for common job tools, usage/reset fields and health detection. Shared jobs code is canonical in the sibling Codex fork; edit it there, then run `bash scripts/sync-jobs.sh` from that fork. Vendor-specific tools stay vendor-specific; recommendations are in [docs/job-surface-audit.md](docs/job-surface-audit.md).

### Diagnostics and worker bridge

`agy_selftest` exercises the task transport using fake jobs. `agy_debug_log` reads the bounded traffic log; argument strings outside the metadata allowlist are redacted.

Run `npm run build`, then `bash scripts/install-agy-bridge.sh` once to register `agent_bridge` in `%USERPROFILE%\.gemini\config\mcp_config.json` (POSIX: `~/.gemini/config/mcp_config.json`). The script backs up the original, preserves other servers, is idempotent, and supports `--uninstall`. `AGY_MCP_CONFIG_PATH` redirects only the installer for isolated tests; agy 1.5.2 ignores that override and project MCP files.

The registration contains the absolute Node executable and `dist/bridge/agent-bridge.js` path, a long `timeoutSeconds`, and no job-specific environment. The job runner supplies `AGENT_JOB_ID` and `AGENT_JOBS_HOME` to agy; the bridge uses the inherited environment. Without worker identity it advertises no tools and closes quietly on stdin EOF. Actual agy-to-MCP environment inheritance has not been verified without a model turn; fake-child tests cover the runner's propagation.

Every mode allows `mcp(agent_bridge/*)` through session-only `--settings`. Jobs add the `ask_orchestrator` / `report_progress` preamble only when the global config contains the bridge entry. Workers share a question claim; stale mailboxes and mismatched/expired question IDs cannot receive another question's answer. `agy_agent_answer` accepts `{ jobId, qid?, answer }`. Questions and approvals complete the waiting task with `event: "question"` or `"approval"`; there are no elicitation forms.

### Shared usage cache

Detection, optional-agent quota guards and `agy_usage` share `getUsage("agy", probe)` in `src/jobs/usage-cache.ts`: one machine-wide `/usage` probe per five minutes on AC, or fifteen minutes on battery or after failure. Concurrent readers use the previous snapshot without waiting. Detection derives authentication from the cached raw usage response and starts no separate sign-in probe. The legacy `refresh` argument no longer bypasses the shared cache. `tallies` adds local token totals.
