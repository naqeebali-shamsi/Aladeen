# Aladeen

Observability and learning layer for agent CLIs.

Aladeen reads the session logs that tools like **Claude Code**, **opencode**, and (soon) **Codex** leave behind, normalizes them into a single schema, and produces failure-pattern reports + drill-down replays. It doesn't replace your agent — it watches it work and tells you where it keeps getting stuck.

## What it does today

```
aladeen ingest claude-code          # parse ~/.claude/projects/<repo>/*.jsonl
aladeen ingest opencode             # parse ~/.local/share/opencode/opencode.db
aladeen report                      # show failure-pattern buckets across all ingested sessions
aladeen replay <fingerprint>        # drill into a single bucket: files touched, asks, first failures
```

A single `aladeen report` gives you:

- **Outcomes** — how many sessions completed cleanly, errored, or were silently abandoned (dangling tool calls detected, not just "exit code zero")
- **Failure fingerprints** — sessions with the same shape (agent CLI, outcome, top error classes, failure rate, edit-loop presence) bucket together so recurring problems stop hiding in the noise
- **Edit loops** — files an agent edited >3 times in one session, ranked. Surfaces real thrashing hotspots
- **Tool usage rollup** — what tools your agents actually reach for, across providers
- **Per-session table** — by active duration (idle gaps over 10 min excluded), with toolFail/editLoop annotations

`aladeen replay <fingerprint>` then takes any bucket and produces a markdown drill-down: aggregated tool/file/error totals across the bucket plus the first user ask and first failed tool result from each matching session. The format is intentionally consumable by both humans and downstream agents.

## Why it exists

Every big tech launched a coding CLI. None of them throw away less data than the others, and none expose the data they keep. You can run Claude Code 200 times and have no idea which failure modes are common until you read 200 transcripts. Aladeen turns those transcripts into something you can act on.

The pitch is deliberately small: **don't replace your agent, learn from it**. The orchestrator category (Conductor, Vibe Kanban, Claude Squad, DeerFlow 2.0, Emdash, opencode itself) is saturated. The observability category for CLI-based agents is mostly empty.

## Design invariants

- **Raw secrets and PII never persist.** All ingest paths pass through a versioned scrubber (`src/observability/scrubber.ts`). API keys, JWTs, AWS keys, GitHub PATs, and the user's home-directory path are redacted at the boundary. Inline `[REDACTED:reason]` markers stay greppable.
- **Every event has source provenance.** A `SessionTrace.events[i].source` field points back to the byte range in the original artifact. If a parser disagrees with you, you can reproduce the dispute.
- **Adding a new agent CLI doesn't require schema changes.** Extend the `SourceKind` enum, write an ingester that targets `SessionTrace`, done. The Claude Code (JSONL) and opencode (SQLite) ingesters look completely different on the inside and produce identical `SessionTrace` output.
- **Ordering uses `seq`, not timestamps.** Clocks lie and resumed sessions span days.

## Architecture

```
src/observability/
  session-trace.ts          # SessionTrace + RunDigest Zod schemas
  scrubber.ts               # Versioned redaction passes
  digest.ts                 # SessionTrace → RunDigest projection + fingerprint
  storage.ts                # On-disk layout: .aladeen/ingested/{sessions,digests}/
  report.ts                 # Terminal-friendly multi-section report
  replay.ts                 # Markdown drill-down for a single fingerprint
  ingest/
    claude-code.ts          # ~/.claude/projects/*/sessions/*.jsonl parser
    opencode.ts             # opencode.db SQLite reader (via sqlite3 CLI subprocess)
```

Storage on disk:

```
.aladeen/ingested/
  sessions/<sessionId>.trace.json    # full SessionTrace
  digests/<sessionId>.digest.json    # RunDigest projection
```

SessionIds may contain provider prefixes (`opencode:ses_abc...`). The filesystem layer sanitizes everything outside `[A-Za-z0-9._-]` to `_` so Windows NTFS doesn't interpret `:` as an alternate data stream marker — the canonical id in the trace itself is unchanged.

## Status

- Claude Code ingester: complete
- opencode ingester: complete
- Codex ingester: not yet
- Gemini CLI ingester: not yet
- Aladeen's own blueprint runs → trace store: not yet

The blueprint engine that originally lived here (DAG runner, deterministic + agentic nodes, worktree isolation) is still in `src/engine/`, `src/blueprints/`, `src/isolation/`, and `src/adapters/`. It's been demoted from the project identity but is kept runnable because the runs it produces are the eventual third data source. See `~/.claude/projects/N--Aladeen/memory/project_pivot_observability.md` for the full pivot rationale.

## Known limits

- Tool names not normalized across providers (`Write` vs `write`). Tool usage rollup treats them as distinct.
- Most fingerprint buckets are still size 1 on small ingested datasets — bucket sizes grow with more sessions, but auto-replay ("suggest the blueprint that fixed this shape") needs both more data and a blueprint↔trace link that doesn't exist yet.
- Error classifier mostly defaults to `tool_error`. Heuristic patterns will be refined as more session data accumulates.
- Wall-clock duration is preserved alongside active duration for reference; resumed-across-days sessions report sensible numbers via `activeDurationMs`.

## Requirements

- Node 20+
- `sqlite3` on PATH (only needed for the opencode ingester)
- TypeScript / Vitest / Zod (installed via `npm install`)

## License

Personal project. No license claimed yet.
