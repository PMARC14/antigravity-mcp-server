# Handoff: antigravity-mcp-server (fork, branch `agent-standard`)

**What it is.** An MCP server that lets Claude Code run Google Antigravity CLI (`agy`) as background agents. Forked from x51xxx/antigravity-mcp-server (base `74264a82`, 2026-08-18); only 9 of 29 upstream source files are unchanged. **Don't edit `src/jobs/` here:** it's synced from `codex-mcp-tool`, and `sync.test.ts` enforces it.

**Tools:**
- `agy_agent`, `_message`, `_answer`, `_follow`, `_status`, `_result`, `_read`, `_list`, `_stop`, `_retry`, `_collect`;
- `agy_usage`, `agy_selftest`, `agy_debug_log`, `health`.

The legacy tools (`ask-antigravity`, `bg-antigravity`, `delegate-antigravity`, …) load only with `AGY_MCP_LEGACY_TOOLS=1`.

**agy specifics:**
- **Stream-json:** prompts go to stdin as NDJSON turns. `*_agent_message` queues the next turn.
- **Read mode:** `--mode plan` with `read_file(*)`/`list_dir(*)` rules. Shell globs fail agy's permission check on Windows. A second "final answer" turn is sent only when turn 1 has denied actions or an empty reply.
- **Worker bridge:** agy reads MCP servers **only** from the global `~/.gemini/config/mcp_config.json`. Run `bash scripts/install-agy-bridge.sh` once (it's idempotent and supports `--uninstall`). The bridge finds its job through the inherited `AGENT_JOB_ID`/`AGENT_JOBS_HOME`; the permission rule is `mcp(agent_bridge/*)`. Whether agy passes that environment to MCP children is **still unverified live**.
- **Sign-in and usage:** come from the shared cache `~/.agent-jobs/cache/agy-usage.json`. A "signed out" result is re-checked after 60 s. There are no periodic `agy --version` runs (those used to pop console tabs every minute).
- **The quota guard** uses the job's own model group (Gemini, Argon, or Claude/GPT).

**State (2026-11-07):** committed `e3a3b4f` (298/298 tests). Pending: re-sync after the Codex fork's round 2, then the live test after `/mcp` reconnect. The next project is the same as the Codex fork's: merge both into one `agent-jobs` server.
