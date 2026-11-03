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
- `src/utils/agyCommandBuilder.ts` — builds argv and stdin for agy. Prompts are NDJSON user events on stdin with `--input-format stream-json --output-format stream-json`. Read mode sends two turns.
- `src/utils/agyExecutor.ts` and `src/connectors/agy.ts` — parse stream-json events: conversation IDs come from `init` or `result`, final text from `result.response`. The executor can fall back to the CLI log for the ID.
- `src/utils/sessionStorage.ts` — in-memory sessions and per-session locking.
- `src/utils/bgTaskManager.ts` — legacy background tasks stored in `~/.agy-mcp/bg/`; `delegate-antigravity` uses worktrees.
- `src/jobs/` — shared jobs module, synced from the Codex fork, which is its source of truth. Do not edit it here; `scripts/sync-jobs.sh` copies it and `src/jobs/sync.test.ts` checks synchronization.

## Modes and CLI behavior

- `read`: `--mode plan` and a session-only `--settings` allowlist for `git status`, `git diff`, `git log`, `git show`, `rg`, `Get-ChildItem`, `Get-Content`, `ls` and `cat`. The prompt asks the agent to avoid shell commands because an auto-denied command aborts a headless run. Plan mode ends after its planning turn, so a second stdin turn requests the complete answer; the last result wins.
- `write`: `--mode accept-edits --sandbox` and session-only `--settings` allowing `command(*)`.
- `trusted`: `--mode accept-edits` and the same `command(*)` rule, without `--sandbox`. Normal approvals still apply. Use for worktree jobs on the user's own repos when the Windows sandbox breaks Git Bash/MSYS2.
- `full`: `--dangerously-skip-permissions`; bypasses sandbox and approvals and requires an explicit request.

The existing ask, digest, review, plan and brainstorm tools default to read; background, delegate and batch default to write. `agy_job_start` defaults to read. `mode`, `effort` and `jsonSchema` are wired into the existing execution tools; legacy `sandbox` and `skipPermissions` options are checked for conflicts.

The shared tools are `agy_job_start`, `agy_job_status`, `agy_job_result`, `agy_job_cancel`, `agy_job_list`, `agy_job_read`, `agy_job_requeue` and `agy_worktree_collect`. Jobs share `~/.agent-jobs` with the Codex fork; `AGENT_JOBS_HOME` overrides it. `agy_usage` runs `agy -p /usage --output-format json` without a model turn. Set `AGENT_JOBS_CHANNEL=1` in the MCP registration to opt in to metadata-only stop notifications; Claude Code must be launched with `claude-agents` (`claude --dangerously-load-development-channels server:codex server:agy`).

## Conventions

- ESM (`"type": "module"`), Node16 module resolution; relative imports need `.js` extensions.
- Existing tool names use the `ask-antigravity` style; shared job tools use the `agy_` prefix.
