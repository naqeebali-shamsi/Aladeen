# Aladeen Roadmap

Two stages, in priority order:

1. **Coverage** — Aladeen must work cleanly against every agent harness in active use. "Ready for all" means an Aladeen user shouldn't have to ask "does this support my tool?"
2. **Distribution** — Aladeen must be discoverable wherever users go to find agent tooling: Claude Code plugins, opencode plugins, MCP server marketplaces, npm, jcode/Hermes/OpenClaw plugin registries as they emerge.

Monetization comes later and only via low-friction channels (sponsorship, marketplace revenue share, optional hosted tier for shared team digests). Coverage is the wedge — without it, nothing else matters.

---

## Stage 1: Coverage

### Storage-shape taxonomy (5 categories)

Every agent harness storage we've encountered fits one of these:

| Shape | Examples | Reference ingester | Marginal cost per new tool |
|-------|----------|--------------------|-----------------------------|
| 1. Per-session JSONL files | Claude Code, Codex, OpenClaw | `src/observability/ingest/claude-code.ts` | ~2 hours |
| 2. SQLite database | opencode, Hermes | `src/observability/ingest/opencode.ts` | ~3 hours |
| 3. Wrapper that defers storage to another harness | Ruflo (wraps Claude Code) | none needed — existing ingester catches the wrapped sessions | 0–1 hours for metadata extras |
| 4. Vector embeddings + opaque raw store | jcode (?), some custom harnesses | none — needs investigation per tool | unknown |
| 5. Markdown vault (Obsidian-backed memory) | Hermes v0.14 Obsidian provider, OpenClaw+Obsidian setups, jrcruciani/obsidian-memory-for-ai | new abstraction needed (see below) | ~1 day for the abstraction; ~2 hours per tool after |

### Current state (committed)

- claude-code (shape 1) — `src/observability/ingest/claude-code.ts`
- opencode (shape 2) — `src/observability/ingest/opencode.ts`
- codex (shape 1) — `src/observability/ingest/codex.ts`
- aladeen-runs (shape 1, internal) — `src/observability/ingest/aladeen-runs.ts`

### Next ingesters (specced below)

| Order | Tool | Shape | Effort | Why this order |
|-------|------|-------|--------|----------------|
| 1 | OpenClaw | 1 (JSONL) | ~2h | Largest active OSS user base outside Claude Code; pattern is direct copy of `claude-code.ts` |
| 2 | Hermes | 2 (SQLite) | ~3h | Nous Research has real adoption; SQLite path mirrors `opencode.ts` |
| 3 | Ruflo metadata | 3 (wrapper) | ~1h | Free coverage of swarm metadata; sessions themselves already covered by claude-code ingester |
| 4 | Obsidian vault (`VaultDelta`) | 5 (markdown vault) | ~1 day for abstraction, then ~2h per consumer | Unlocks Hermes-Obsidian memory + every "second-brain" agent setup |
| 5 | jcode | 4 (TBD) | unknown | Needs source-level investigation of `~/.jcode/` first |
| 6 | Gemini CLI | 1 (likely) | ~2h | Round out big-three model providers |

---

## Ingester template (canonical shape)

Every new ingester MUST conform to this contract so the report/replay/digest layers stay agnostic.

```ts
export class FooIngester {
  constructor(opts?: { scrubber?: Scrubber; /* DI hooks */ });

  // Discover sessions in the canonical storage location.
  listSessions(rootPath: string): Promise<SessionDescriptor[]>;

  // Convert one session into a SessionTrace. Must NOT touch the network.
  // Must pass everything through this.scrubber.
  ingestSession(/* tool-specific input */): Promise<{
    trace: SessionTrace;
    warnings: string[];
  }>;
}
```

Hard rules:

- Every event MUST have a `source: SourceRef` pointing back to the original artifact.
- Every string field that originated in user content MUST pass through `Scrubber.scrubMessage()` or `scrubOutput()`.
- `agentCli.name` MUST be the canonical short name (`claude-code`, `opencode`, `codex`, `openclaw`, `hermes`, `jcode`, `gemini-cli`, …). Lowercase, dash-separated.
- File paths in `file_change.path` MUST be scrubbed via `Scrubber.scrubPath()` (home → `~`).
- All `sessionId` strings written to disk MUST round-trip through `sanitizeForFs()` in `storage.ts`.
- Schema validation via `SessionTraceSchema.safeParse()` MUST happen at the boundary; failures go into `warnings`, not thrown exceptions.
- Outcome inference SHOULD share the logic in `inferOutcome()` (currently inlined in each ingester; will be promoted to a shared module when the third copy lands — already past that threshold; tracked as cleanup item).

---

## Spec: OpenClaw ingester

**Storage:** `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`, with `~/.openclaw/agents/<agentId>/sessions/sessions.json` as an index.

**Per-line shape (inferred from public skill packs, MUST be confirmed against a real session):**

```json
{
  "role": "user" | "assistant" | "system",
  "content": [
    { "type": "text", "text": "..." },
    { "type": "tool_use", "id": "...", "name": "...", "input": {...} },
    { "type": "tool_result", "tool_use_id": "...", "content": "...", "is_error": false }
  ],
  "usage": { "input_tokens": 0, "output_tokens": 0, "cost": { "total": 0 } },
  "timestamp": "ISO-8601"
}
```

**Mapping:**

- `role:user` + `content[].type:text` → `user_message`
- `role:assistant` + `content[].type:text` → `agent_message`
- `content[].type:tool_use` → `tool_call`
- `content[].type:tool_result` → `tool_result`, `ok = !is_error`
- `usage.cost.total` → accumulate into `cost.estimatedUsd`
- `usage.input_tokens` / `usage.output_tokens` → standard cost fields

**File path discovery:** walk the per-agent sessions dirs in `~/.openclaw/agents/*/sessions/`. The `agentId` becomes a `parentSessionId` hint (it's a long-lived agent identity, not a session).

**CLI surface:**
```
aladeen ingest openclaw [--path ~/.openclaw]
```

**Open questions before implementation:**
- Confirm exact per-line shape against a live session — OpenClaw skill pack hints at the structure but no canonical schema is published.
- Does OpenClaw store subagent sessions separately the way Claude Code does (`subagents/` subfolder)? If yes, recursive walk like the Claude Code ingester.
- File-change detection: OpenClaw's write tool name? Probably `Write` / `Edit` matching Claude Code conventions but should be verified.

**Effort:** ~2 hours implementation + 1 hour validation against a real vault.

---

## Spec: Hermes ingester

**Storage:** `~/.hermes/state.db` (SQLite + FTS5).

**Tables to query (must be inspected against a real DB first):**

- `sessions` (likely): id, title, started_at, completed_at, token counts
- `messages` (likely): id, session_id, role, content (text or JSON), timestamp
- `tool_invocations` (likely): id, session_id, name, args, output, ok, duration
- FTS5 virtual tables: skip; the digest doesn't need full-text search

**Implementation pattern:** identical to `opencode.ts` — use the sqlite3 CLI subprocess, inject `sqlExec` for tests, never add a native dep.

**Distinguishing feature:** Hermes does automatic mid-session summarization when approaching context limits. This means a single Hermes session may have a compacted middle and a verbose tail. The ingester should preserve both segments and emit a marker event (e.g., new event kind `summary_boundary` or use existing `session_marker`) so downstream readers can tell where context was compressed.

**Obsidian provider hook (Hermes v0.14+):** the Hermes Obsidian provider keeps memory in a vault via `localhost:27123`. The vault contents are a separate persistence channel; the SQLite DB still has the session itself. For Aladeen v1: ingest only the SQLite. Obsidian vault contents fold into the `VaultDelta` abstraction (below) when that lands.

**CLI surface:**
```
aladeen ingest hermes [--path ~/.hermes/state.db]
```

**Effort:** ~3 hours implementation + 1 hour validation.

---

## Spec: Ruflo metadata extension

**No new ingester.** Ruflo wraps Claude Code; the underlying sessions land in `~/.claude/projects/` and the existing claude-code ingester reads them.

**Optional extension:** Ruflo's swarm topology, SONA routing decisions, and per-agent RL signals are persisted in Ruflo's own state directory (path TBD; investigate `~/.ruflo/` or `.claude-flow/` per the historical name). When a Claude Code session was spawned by Ruflo, attach Ruflo's metadata to the trace's `ingesterExtras.ruflo` field.

**Mechanism:** post-process step that runs after claude-code ingest, looks up each session's id in Ruflo's state, and patches `ingesterExtras.ruflo = { swarmId, parentAgentId, routingDecisions }` if present.

**Effort:** ~1 hour once Ruflo's state path is identified.

---

## Spec: VaultDelta (Obsidian-backed memory abstraction)

This is the **fifth shape** and doesn't fit `SessionTrace` cleanly. Obsidian-backed agents don't produce per-session conversation streams; they produce a **knowledge graph that evolves over time**. The right primitive is different.

**Proposed type (in `src/observability/vault-delta.ts`, new file):**

```ts
export const VaultSnapshotSchema = z.object({
  schemaVersion: z.literal('1'),
  vaultId: z.string(),                        // hashed root path
  agentCli: z.object({ name: z.string() }),   // 'hermes', 'openclaw', 'manual', ...
  capturedAt: z.string().datetime(),
  notes: z.array(z.object({
    pathScrubbed: z.string(),                 // relative to vault root
    frontmatter: z.record(z.unknown()).optional(),
    contentSha256: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    wikilinksOut: z.array(z.string()),        // [[other-note]] targets
    tags: z.array(z.string()),
    modifiedAt: z.string().datetime().optional(),
  })),
  scrubbing: ScrubbingSchema,
});

export const VaultDeltaSchema = z.object({
  schemaVersion: z.literal('1'),
  vaultId: z.string(),
  from: z.string().datetime(),
  to: z.string().datetime(),
  added: z.array(z.object({ pathScrubbed: z.string(), contentSha256: z.string() })),
  modified: z.array(z.object({
    pathScrubbed: z.string(),
    fromSha256: z.string(),
    toSha256: z.string(),
  })),
  removed: z.array(z.object({ pathScrubbed: z.string() })),
  // Promoted insights: heavily-modified notes are likely the "warm storage"
  // that agents promote summaries into. Flag them.
  hotspots: z.array(z.object({
    pathScrubbed: z.string(),
    modificationCount: z.number().int().positive(),
    last: z.string().datetime(),
  })),
});
```

**Why a separate type, not extend SessionTrace:**

`SessionTrace.events` is a totally-ordered conversation stream. A vault is a set of notes that evolve. Forcing one into the other loses signal in both directions. Keep them parallel; the report layer can render both.

**Two ingesters to build on top:**

1. `ObsidianVaultIngester` — point at a vault root, snapshot it. Run repeatedly; consecutive snapshots produce `VaultDelta`s.
2. `HermesObsidianBridgeIngester` — talks to the Hermes Obsidian provider's REST API (`localhost:27123`) to enumerate vault contents, also produces `VaultSnapshot`/`VaultDelta`.

**CLI surface:**
```
aladeen vault snapshot [--vault ~/Documents/MyVault]
aladeen vault delta <fromSnapshotId> <toSnapshotId>
```

**Effort:** ~1 day for the snapshot abstraction + the file-walking Obsidian ingester. ~2 hours for the Hermes REST bridge after.

**Scope discipline:** Do NOT parse markdown bodies for "facts" or NLP-extract anything. Snapshot is content-hash + frontmatter + wikilinks/tags only. Anything richer is a separate downstream layer.

---

## Spec: jcode (gated on investigation)

**Pre-implementation work required:**

1. Clone `github.com/1jehuang/jcode` and locate the session-persistence module. Two repos exist with this name (`1jehuang` and `cnjack`); confirm which is the one with active adoption.
2. Identify the on-disk path (likely `~/.jcode/` or `~/.local/share/jcode/`).
3. Determine the persistence format: SQLite? Custom binary? Or does jcode persist *only* the vector index with no raw transcript?

**If jcode persists raw transcripts:** standard new ingester following shape 1 or 2. Effort ~3 hours.

**If jcode only persists embeddings:** Aladeen has nothing meaningful to ingest. Document the gap, mark as unsupported, link to a jcode issue requesting a transcript export.

---

## Spec: Gemini CLI (lightweight follow-up)

Likely shape 1 (JSONL per session under `~/.gemini/` or `~/.config/gemini/`). Format probably mirrors the existing patterns. Effort ~2 hours. Confirm storage layout before implementing.

---

## Stage 2: Distribution

"Discoverable on any agent marketplace" decomposes into specific shipping targets:

### Channel 1 — npm

`npm install -g aladeen` should Just Work on macOS / Linux / Windows. Today the build does — needs:
- `package.json` `bin` entry pointing at `dist/cli.js`
- `prepublishOnly` script enforcing typecheck + tests + build
- Engine field pinning Node ≥ 20
- README updated with one-line install command
- Pinned `engines.node` so npm refuses to install on unsupported versions

**Effort:** ~1 hour.

### Channel 2 — MCP server bundle

Package Aladeen as an MCP server (separate from the CLI), advertised in:
- Anthropic's MCP server directory
- Claude Code's plugin / MCP marketplace
- opencode's plugin registry
- Codex's MCP / extension surface (if/when one ships)

This is the previously-deferred MCP work. Tools to expose: `query_failure_patterns`, `replay_fingerprint`, `warn_known_failures`, `get_session_history`. Resources: `aladeen://digests`, `aladeen://sessions/<id>`, `aladeen://learnings`.

**Effort:** ~1 day for MVP (two tools + two resources).

### Channel 3 — harness plugin packages

Each major harness has its own plugin/skill format. Ship a small wrapper per harness that depends on the npm package and exposes Aladeen as a native command in that harness:

- **Claude Code skill** (`aladeen.skill` in `~/.claude/skills/`): `/aladeen report`, `/aladeen replay <fp>`, `/aladeen warn-me` hook before destructive actions
- **opencode plugin**: similar surface
- **OpenClaw plugin** (per their plugin SDK)
- **Ruflo skill** (per their MCP-tool registry)
- **Hermes skill** (per their plugin model)

**Effort:** ~2 hours per harness, parallel.

### Channel 4 — directories

Submit to:
- GitHub's awesome-* lists for agent tooling
- Anthropic's tools directory
- LobeHub skills marketplace (referenced by OpenClaw search results — likely accepts third-party submissions)
- Product Hunt / Hacker News once Channels 1–3 are live

**Effort:** ~1 day batched.

### Channel 5 — hosted dashboard (optional, monetization)

A read-only web dashboard that takes uploaded `.aladeen/ingested/` tarballs and renders the same reports + replays as the CLI, optionally sharable with teammates. Pricing tier: free for personal, paid for team digests with multi-user upload.

**Explicitly NOT in scope for the coverage push.** Mentioned only because monetization was asked about. Reconsider only after Channels 1–4 are shipped and there's signal on demand.

---

## Open questions / decisions to make explicitly

1. **Schema migration policy.** When `SessionTrace.schemaVersion` bumps to '2', what happens to on-disk `.trace.json` files? Reingest from source (clean but expensive) or migrate in place? Pick before shipping the first breaking change.
2. **Tool-name normalization.** `Write` vs `write` vs `write_file` across providers is going to bite when bucket sizes grow. Either normalize at ingest (lossy) or maintain a per-provider→canonical map (verbose). Defer until the third-party data starts colliding.
3. **License.** README says "no license claimed yet." Pick one before npm publish. MIT keeps it permissive; AGPL keeps any hosted-fork honest. The hosted-dashboard monetization path would push toward AGPL.
4. **Telemetry.** Anonymous usage metrics (which harness, how many sessions ingested, never the content) would surface real adoption signals. Privacy-default-off; opt-in flag in config.
5. **Maintenance load** of N ingesters. Vendor formats change; each ingester needs a smoke test in CI against a fixture session. Acceptable today (4 ingesters), going to hurt at 10+. Budget for it now.

---

## Suggested execution order (1-2 weeks of focused work)

| Week | Deliverable |
|------|-------------|
| 1.1 | OpenClaw ingester + smoke test against a real session |
| 1.2 | Hermes ingester + smoke test against a real DB |
| 1.3 | Ruflo metadata extension |
| 1.4 | Gemini CLI ingester |
| 1.5 | Promote shared `inferOutcome()` and `classifyError()` to common modules; CI fixture for each ingester |
| 1.6 | npm publish (Channel 1) |
| 2.1 | VaultDelta abstraction + Obsidian file-walking ingester |
| 2.2 | Hermes Obsidian REST bridge |
| 2.3 | jcode investigation, then ingester or doc-the-gap |
| 2.4 | MCP server MVP (Channel 2) |
| 2.5 | Claude Code skill + opencode plugin wrappers (Channel 3, partial) |
| 2.6 | Marketplace submissions (Channel 4) |

End state: every harness in active use is supported, Aladeen is listed in 4+ marketplaces, and the codebase has a clean substrate to add a sixth or seventh harness in a couple of hours without architectural changes.
