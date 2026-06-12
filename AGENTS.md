<!-- aladeen:learned:start -->
<!-- Managed by `aladeen learn --apply`. Edits inside this block are overwritten. -->
## Learned guardrails (Aladeen)

Recurring patterns mined from this machine's agent session logs. Evidence:
`aladeen lessons`. Updated 2026-06-12.

- `tool_error` errors recur multiple times within single sessions. When the same error class repeats, stop and address the cause before continuing — repetition without a strategy change did not resolve it in observed sessions. _(seen in 41 session(s): aladeen, claude-code, codex; universal)_
- `timeout` errors recur multiple times within single sessions. When the same error class repeats, stop and address the cause before continuing — repetition without a strategy change did not resolve it in observed sessions. _(seen in 10 session(s): codex)_
- `shell_command` calls fail repeatedly with `tool_error` and identical retries do not change the outcome. Read the first failure's output and change approach — different arguments, a different tool, or fix the underlying state — before re-running. _(seen in 18 session(s): codex)_
- `shell_command` calls fail repeatedly with `parse_error` and identical retries do not change the outcome. Read the first failure's output and change approach — different arguments, a different tool, or fix the underlying state — before re-running. _(seen in 5 session(s): codex)_
- `parse_error` errors recur multiple times within single sessions. When the same error class repeats, stop and address the cause before continuing — repetition without a strategy change did not resolve it in observed sessions. _(seen in 14 session(s): claude-code, codex; universal)_
- `shell_command` calls fail repeatedly with `timeout` and identical retries do not change the outcome. Read the first failure's output and change approach — different arguments, a different tool, or fix the underlying state — before re-running. _(seen in 6 session(s): codex)_
- `auth` errors recur multiple times within single sessions. When the same error class repeats, stop and address the cause before continuing — repetition without a strategy change did not resolve it in observed sessions. _(seen in 6 session(s): codex)_
- `binary_not_found` errors recur multiple times within single sessions. When the same error class repeats, stop and address the cause before continuing — repetition without a strategy change did not resolve it in observed sessions. _(seen in 5 session(s): codex)_
- `decisions.md` gets re-edited many times within a session (edit loop). Read the file and plan one consolidated change instead of incremental retries — long edit chains track with thrash. _(seen in 2 session(s): claude-code)_
<!-- aladeen:learned:end -->
