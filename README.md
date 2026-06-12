# Aladeen

_Named after the all-purpose word from_ The Dictator _— it means both "positive" and "negative" at once. Fitting for a tool whose whole job is sorting agent sessions into exactly those two piles._

Observability + learning layer for agent CLIs.

Aladeen reads the session logs that tools like **Claude Code**, **opencode**, **Codex**, and **OpenClaw** leave behind, normalizes them into a single schema, surfaces failure-pattern reports + drill-down replays, and — new in v0.2.0 — **learns from them**: deterministic detectors mine recurring lesson shapes, a forgetting curve ranks them by importance and recency, and `aladeen learn --apply` writes the top corroborated guardrails into an Aladeen-owned fenced block in `AGENTS.md` so the next session reads them by default. It doesn't replace your agent — it watches it work and tells it where it keeps getting stuck.

## Install

```
npm install -g aladeen
```

Or run without installing:

```
npx aladeen report
```

## What it does today

```
aladeen ingest claude-code          # parse ~/.claude/projects/<repo>/*.jsonl
aladeen ingest opencode             # parse ~/.local/share/opencode/opencode.db
aladeen ingest codex                # parse ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
aladeen ingest openclaw             # parse ~/.openclaw/agents/<id>/sessions/*.jsonl
aladeen ingest aladeen-runs         # parse <repo>/.aladeen/runs/*.json (Aladeen's own runs)
aladeen report                      # show failure-pattern buckets across all ingested sessions
aladeen replay <fingerprint>        # drill into a single bucket: files touched, asks, first failures
aladeen remedy <fingerprint>        # suggest a read-only remedy: known-fix pointer or prior resolved sessions
aladeen learn                       # mine lessons from ingested sessions; rank by forgetting curve
aladeen learn --apply               # write top corroborated lessons into an AGENTS.md fenced block
aladeen lessons                     # list ranked lessons with evidence counts and decay state
```

## MCP server (in-session queries from any agent)

Once you've ingested some sessions, Aladeen also ships as an **MCP server** so any MCP-aware agent (Claude Code, opencode, Codex, Cursor, etc.) can query the accumulated knowledge mid-session — no context switch, no CLI invocation.

Add this to a project's `.mcp.json` (or your global MCP config):

```json
{
  "mcpServers": {
    "aladeen": {
      "command": "aladeen-mcp"
    }
  }
}
```

The server runs locally over stdio, reads `<cwd>/.aladeen/ingested/`, and exposes:

- **Tool** `query_failure_patterns({ all?, limit? })` — the same report `aladeen report` produces
- **Tool** `replay_fingerprint({ fingerprint, max_sessions? })` — markdown drill-down for one bucket
- **Tool** `suggest_remedy({ fingerprint, max_samples? })` — a read-only remedy suggestion for a failing pattern: prior sessions of the same shape that later completed, a known-fix pointer where one exists, and an honest confidence tier. It **suggests, never executes** — see [Actionable replay](#actionable-replay-landing).
- **Resource** `aladeen://digests` — JSON of every stored `RunDigest`
- **Resource** `aladeen://sessions/{sessionId}` — full `SessionTrace` for one session

The server never touches the network and never launches an agent — `suggest_remedy` included. It only reads what prior `aladeen ingest <source>` runs wrote to disk.

A single `aladeen report` gives you:

- **Outcomes** — how many sessions completed cleanly, errored, or were silently abandoned (dangling tool calls detected, not just "exit code zero")
- **Failure fingerprints** — sessions with the same shape (agent CLI, outcome, top error classes, failure rate, edit-loop presence) bucket together so recurring problems stop hiding in the noise
- **Edit loops** — files an agent edited >3 times in one session, ranked. Surfaces real thrashing hotspots
- **Tool usage rollup** — what tools your agents actually reach for, across providers
- **Per-session table** — by active duration (idle gaps over 10 min excluded), with toolFail/editLoop annotations

`aladeen replay <fingerprint>` then takes any bucket and produces a markdown drill-down: aggregated tool/file/error totals across the bucket plus the first user ask and first failed tool result from each matching session. The format is intentionally consumable by both humans and downstream agents.

<a id="actionable-replay-landing"></a>

### Actionable replay (learning layer — landing now)

The first slice of the learning layer turns the read-only drill-down into a **read-only suggestion**. Given a failing pattern, Aladeen looks for prior sessions that hit the same `(agent + error class)` shape and later completed, and surfaces what they were asked, the tools they used, and the files they touched — plus a **known-fix** pointer when the failure is a solved bug in this repo's own engine (e.g. `worktree_collision` → install deps in the worktree before the gate, the `bootstrap-deps` node in `src/blueprints/implement-feature.ts`; a lint/typecheck **edit loop** → bounded retry, `maxTotalRetries` in the same blueprint — the linter's `--fix` capability in `src/engine/verifiers/lint.ts` is available but not wired into this blueprint).

Confidence is an honest tier — **known-fix** / **medium** / **low** / **none** — and every suggestion prints its denominators (how many failed sessions, how many resolved siblings). Most buckets are still small, so **none** ("no comparable resolved session in your history yet — read-only drill-down only") is the common, expected answer. Today the only live known-fix on a typical store is `worktree_collision`; the `lint_loop` rule is armed but only fires once a session is classified with an actual edit loop.

**Aladeen suggests; it never runs the agent.** This is not orchestration: there is no auto-execution, no synthesized patch, and only change-shaped evidence is shown (file path, action, line counts — never file content). A human, or an MCP-connected agent, decides whether to act. See [Known limits](#known-limits) for what's explicitly out of scope.

### Learning module (v0.2.0)

The second slice of the learning layer reads the same ingested sessions and mines **lessons** — recurring shapes that show up across sessions and providers. Five deterministic detectors (no LLM, no cloud) cover the load-bearing cases: repeated tool failures, edit loops, user interrupts mid-action, error storms, and "succeeded but thrashed" sessions where the outcome column says success and the path says retry-storm.

Each lesson carries event-level evidence refs back into stored traces, gets re-ranked on every `learn` run by a forgetting curve (importance × decay; math ported from FadeMem, arXiv 2601.18642), and graduates `hypothesis → corroborated → actuated` only as distinct sessions corroborate it. The store is plain JSON under `.aladeen/lessons/` — gitignored, machine-local, schema-versioned.

```
aladeen learn                       # mine + consolidate + rank; suggests nothing for free
aladeen lessons                     # ranked list with retention, status, evidence
aladeen learn --apply               # write top lessons into AGENTS.md fenced block
aladeen lessons --export-md <dir>   # semantic Markdown export (Obsidian / basic-memory compatible)
```

`--apply` is opt-in and bounded: only **corroborated** lessons (≥2 distinct sessions) qualify, the block is capped at 10 rules / 2500 chars (to fit Claude Code's 200-line / 25KB MEMORY.md budget head-room), and it lives between Aladeen-owned markers (`<!-- aladeen:learned:start/end -->`) so content outside the fence is never touched. A corrupt fence aborts rather than guesses. The decision to build this in-house instead of adopting a memory framework (Mem0, Letta, Zep/Graphiti, LangMem, Cognee, A-MEM, MemOS, basic-memory) is recorded as ADR-0013, backed by a 13-system primary-source survey.

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
  ingest-runner.ts          # Generic per-source ingest pipeline (loop, counters, summary)
  ingest/
    _shared/
      jsonl.ts              # parseJsonl(text) + RawLine
      time.ts               # msToIso(ms)
      outcome.ts            # inferOutcome(events, ctx) — shared event-stream classifier
      classify-error.ts     # classifyError(text, extraClasses?) — pattern union
    claude-code.ts          # ~/.claude/projects/<encoded-cwd>/*.jsonl parser
    opencode.ts             # opencode.db SQLite reader (via sqlite3 CLI subprocess)
    codex.ts                # ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl parser
    openclaw.ts             # ~/.openclaw/agents/<id>/sessions/*.jsonl parser
    aladeen-runs.ts         # <repoRoot>/.aladeen/runs/*.json ExecutionState parser
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
- Codex ingester: complete
- OpenClaw ingester: complete (fixture-validated; real-vault smoke test pending)
- Aladeen's own blueprint runs → trace store: complete
- MCP server bundle: complete (`aladeen-mcp` bin; read-only tools + resources)
- Observability (ingest + report + fingerprint buckets + read-only replay + MCP): complete
- Learning layer — actionable replay (`suggest_remedy`, `worktree_collision` known-fix + tiered evidence): complete (read-only suggestions only, no auto-execution; evidence tier returns `none` for most buckets on small stores — expected. See [Known limits](#known-limits))
- Learning module (`aladeen learn` / `lessons`, Tier-0 detectors, FadeMem-style decay, fenced AGENTS.md actuation, semantic Markdown export): complete in v0.2.0. Post-actuation recurrence measurement (the step that turns `actuated → verified`) and Tier-1 LLM reflection over flagged sessions are planned next, behind v0.2.x classifier refinement
- Hermes ingester: planned (gated on `~/.hermes/state.db` schema inspection)
- Gemini CLI ingester: planned (gated on confirming actual storage path)
- jcode ingester: planned (gated on upstream-repo inspection)

See `ROADMAP.md` for the full plan, including the canonical ingester contract and distribution channels.

The blueprint engine that originally lived here (DAG runner, deterministic + agentic nodes, worktree isolation) is still in `src/engine/`, `src/blueprints/`, `src/isolation/`, and `src/adapters/`. It's been demoted from the project identity but is kept runnable because the runs it produces are training data for the observability layer.

<a id="known-limits"></a>

## Known limits

- Tool names not normalized across providers (`Write` vs `write`). Tool usage rollup treats them as distinct.
- Most fingerprint buckets are still size 1 on small ingested datasets, so the learning layer's data-mined suggestions are usually tiered **low** or **none** rather than confident — bucket sizes grow with more sessions. The only high-confidence suggestion today is the rule-encoded **`worktree_collision`** known fix; the `lint_loop` rule is armed but not yet emitted by any ingester on real data.
- **Auto-replay — Aladeen running the fix itself — is explicitly out of scope for v1.** Remedy suggestions are read-only: an ask, the tools/files a resolving session used, and a known-fix pointer where one exists. Acting on them is the human's or MCP-connected agent's decision. Letting Aladeen execute would make it the orchestrator the project deliberately stopped being.
- Error classifier mostly defaults to `tool_error`. Heuristic patterns will be refined as more session data accumulates.
- Wall-clock duration is preserved alongside active duration for reference; resumed-across-days sessions report sensible numbers via `activeDurationMs`.

## Requirements

- Node 20+
- **No native dependency for the core.** The observability commands (`ingest` / `report` / `replay` / `remedy`) and the `aladeen-mcp` server are pure JS — they run anywhere Node 20+ does.
- The interactive TUI and blueprint runner (`aladeen run` / `tui` / `setup`) use [`node-pty`](https://github.com/microsoft/node-pty), an **optional** native dependency with prebuilt binaries for macOS and Windows. On Linux it compiles from source (needs Python 3 + a C/C++ toolchain); if it can't build, `npm install` still succeeds and only those interactive commands are unavailable.
- `sqlite3` on PATH (only needed for the opencode ingester)
- TypeScript / Vitest / Zod (installed via `npm install`)
- `gitleaks` (optional) — powers the pre-commit secret scan (`.githooks/pre-commit`, auto-activated by `npm install`); CI scans regardless. See [`docs/security/SECRET-INCIDENT-REMEDIATION.md`](docs/security/SECRET-INCIDENT-REMEDIATION.md).

## License

MIT. See `LICENSE`.
