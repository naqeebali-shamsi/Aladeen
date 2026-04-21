# /aladeen-next decision log

Append-only. Each invocation writes one block. When a pick gets done, edit
only its `Status:` line — do not delete or reorder.

---

## 2026-04-21 22:30 — 2 picks (first invocation)

**Picks:**

1. **Cover the agentic execution stack with tests** (score: 9) — `Status: completed (commit 828b765)` — added `completion.test.ts` (16 tests covering CLAUDE/CODEX/GEMINI buildArgs + parseOutput + parseStreamEvent) and `deterministic-executor.test.ts` (6 tests covering shell + file ops). The file-ops test surfaced a real bug: `execFileOp` was ignoring `context.cwd` (worked only because `scripts/run-blueprint.ts` pre-resolved paths via `patchForWorktree`) and didn't auto-create parent dirs. Fixed in same commit. Skill validated: a pick rooted in graph-fragility signals immediately surfaced architectural debt.
   - Untested critical files: `src/engine/completion.ts`, `src/engine/agentic-executor.ts`, `src/engine/deterministic-executor.ts`, `src/adapters/base.ts`, `src/adapters/claude.ts`, `src/adapters/codex.ts`, `src/adapters/gemini.ts`
   - Signals: god-node fragility (×3 god nodes untested), recent hot code (smoke-agentic exercised this stack live), V1 promise (these files ARE the agentic loop)
   - Acceptance: `src/engine/completion.test.ts` exists; mocks `child_process.spawn`; verifies CLAUDE_CONFIG.parseOutput handles the JSON shape we observed in run `c607e199` and the failure shape from a non-zero exit. Plus a small parseOutput test for codex/gemini configs.
   - Effort: medium

2. **End-to-end test for `aladeen run --resume`** (score: 5) — `Status: completed (commit 3e97942)` — added 3 tests to `runner.test.ts`: (a) resume from a mid-flight state picks up at `currentNodeId` and does NOT re-execute completed nodes, verified via CountingStubExecutor asserting only `['b', 'c']` were called (not `['a', 'b', 'c']`); (b) `totalRetries` counter preserved across resume; (c) full disk round-trip — save → load via `StatePersistence` → `runner.resume()` → completed state persisted back. Roadmap M4 metric "at least one run can be replayed from persisted state + artifacts" now backed by code. No bugs surfaced — the resume path was correct as designed.
   - Roadmap M4: "at least one run can be replayed from persisted state + artifacts" — code exists in `src/cli.tsx:23`, `src/engine/runner.ts:resume()`, but never validated since the abandoned-status schema change.
   - Signals: roadmap metric without backing test, recent state.ts churn (1b90475) makes resume risk-prone
   - Acceptance: integration test that runs deterministic blueprint, kills it mid-flight, calls `runner.resume()`, asserts the run completes with all nodes at `completed`.
   - Effort: small

**Signals consulted:** open postrun patterns (1, low-leverage), god-node coverage (graphify), hot-code commits (last 14d), roadmap milestones, prior decisions (none — first run).

**Notes:** The graphify graph paid off here — it surfaced `BlueprintRunner`, `WorktreeManager`, and `base.ts` as the highest-degree code nodes; all three now have tests except `base.ts`. The agentic stack untested situation is the single biggest fragility on the board.

---

## 2026-04-21 22:15 — 1 pick (second invocation)

**Picks:**

1. **Failure-bucketing utility closes M4 metric** (score: 7) — `Status: completed (commit b5df67d)` — added `src/engine/failure-buckets.ts` exporting `bucketFailures(runs): FailureBucket[]` plus 6 unit tests. Groups by `(nodeId, outcome)` with run-level bucket for escalated/abandoned, sorted by count descending, capped at 5 sample runIds/errors, error snippets truncated at 200 chars. Verified on live data: the 8 persisted runs bucket into `[{nodeId: '__run__', outcome: 'abandoned', count: 2, sampleRunIds: [690cbbfe..., b9428fa6...]}]` — the two historical orphans correctly surface as the dominant failure pattern. Roadmap M4 metric 3 ("failure reasons structured enough to bucket by gate/outcome") now backed by code AND live data.
   - Roadmap M4: "Failure reasons are structured enough to bucket by gate/outcome" — partial before; `gateOutcomes` + `escalationReason` existed but no grouping function.
   - Signals: roadmap metric without code backing (×4), last unmet M4 metric, evidence-cited from `.aladeen/runs/*.json`.
   - Acceptance: `bucketFailures()` groups 8 live runs; test asserts sort order, sample cap, error truncation.
   - Effort: small-medium.

**Picks deferred (score ≥ 3 but lower priority):**

- Tests for `agentic-executor.ts` (score 6) — template resolution / context injection / toNodeResult. Last meaningful god-node gap; deferred to keep this invocation atomic.

**Signals consulted:** roadmap gaps, god-node coverage (graphify), prior decisions (both #1 and #2 completed — no de-dup needed), recent commits (last 24h = heavy test additions; weighted down to avoid piling more tests in the same areas).

**Notes:** Roadmap M4 now fully green (3/3 metrics backed). The decisions log is starting to show a signal: picks rooted in roadmap metrics produce high-certainty wins (M4-2 and M4-3 both landed clean, no bugs surfaced). Graph-fragility picks are higher variance — they surface bugs (pick #1) but sometimes those bugs eat the time budget.
