Fixture provenance:

- agy-pong-failed.ndjson is stdout captured on 2026-10-29 from a tiny run in a temp directory. No init event was emitted. Stderr (profile write denials, auth and network failures) is omitted.
- agy-write-success.ndjson is a real agy 1.4 capture of a `--mode accept-edits --sandbox` run that edited a file and ran an allowed shell command. Real shapes worth noting: `init` carries `conversation_id` at the top level and `init.model` (no `init.conversation_id`); `step_update` events carry per-step `usage`; `result` carries `usage.total_tokens`.
- agy-denied.ndjson and agy-denied.stderr.txt are a real capture of a run where a command was auto-denied: `result.status` is SUCCESS, `result.response` is empty, `result.denied_actions` lists the denial, and stderr holds the `jetski: no output produced ... auto-denied` reason.
- Captures were scrubbed: the local user path and name were replaced with `C:\work\scratch` / `user`.
