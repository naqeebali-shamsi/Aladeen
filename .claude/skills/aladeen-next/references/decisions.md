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

---

## 2026-04-22 — 2 picks (third invocation)

**Picks:**

1. **Tests for `agentic-executor.ts` (the deferred pick)** (score: 5) — `Status: completed (commit 080614a)` — added `src/engine/agentic-executor.test.ts` with 10 tests: `resolveTemplate` (3 cases incl. JSON-stringify for non-strings), `injectContext` (section ordering + no-op pass-through), `toNodeResult` decision branches (success, timeout→failure, exit>0→retry, unknown adapter→failure without detector call), and an E2E assertion that `{{store.lintOutput}}` reaches the detector. Exported `resolveTemplate` and `injectContext` as pure helpers — no behavioral change. Stubs via `vi.spyOn(CompletionDetector.prototype, 'execute')`. All 50 suite tests pass; typecheck clean. No bugs surfaced — the decision logic was correct as written.
   - Rationale: explicitly deferred from invocation #2; still zero test references to `AgenticExecutor`, `toNodeResult`, `resolveTemplate`, or `injectContext` (verified via grep on `**/*.test.ts`). This file owns the retry-vs-failure decision on every agentic run (`src/engine/agentic-executor.ts:113-114` — exit-code/timeout branch) and the `{{store.key}}` template path that feeds fix-lint-style loops. Untested decision logic on the hot path.
   - Evidence: `src/engine/agentic-executor.ts` (170 lines, no test file); graphify marks it a god-node; smoke-agentic runs (`c607e199`, `31101d50`) exercise this file end-to-end in prod.
   - Acceptance: `src/engine/agentic-executor.test.ts` exists with ≥4 tests — (a) `resolveTemplate` replaces `{{store.key}}` and passes through missing keys, (b) `toNodeResult` maps `success=true → success`, (c) `toNodeResult` maps timeout error → `failure` (not retry), (d) `toNodeResult` maps exit>0 non-timeout → `retry`. Stub the `CompletionDetector` via DI or module mock.
   - Effort: small-medium (~45min).

2. **End-to-end test for M1 acceptance metric: "100% of runs include policy metadata"** (score: 4) — `Status: completed (commit 1bcf27b)` — added 5 tests to `runner.test.ts`: explicit `runMode='local-only'` → mode/cloudFallbackAllowed asserted; default (no runMode) same safe default; `runMode='hybrid'` exercises the `cloudFallbackAllowed = runMode !== 'local-only'` branch; blueprint-level `maxRunDurationMs`/`maxTotalRetries` propagate into runPolicy; escalated run still carries runPolicy (the metric applies to ALL runs, not just completed). All 55 tests pass; typecheck clean. No runner changes — contract was correct as written. M1 is now test-backed end-to-end.
   - Rationale: `runner.ts:122-123` populates `state.runPolicy` but no test asserts a completed run actually has it set. `state.test.ts` only round-trips a hand-crafted state with `runPolicy` pre-attached — that validates persistence, not the runner's contract. The M1 metric is today unfalsifiable from the test suite.
   - Evidence: `src/engine/runner.ts:43,63,71,122-123` (runMode wiring); `src/engine/state.test.ts:27,35,77,82` (only uses pre-populated runPolicy); `LOCAL_FIRST_DELIVERY_ROADMAP.md:10` (metric).
   - Acceptance: new test in `runner.test.ts` runs a trivial blueprint with `runMode: 'local-only'`, asserts `finalState.runPolicy.mode === 'local-only'` and `cloudFallbackAllowed === false`. Repeat with default (no runMode) asserting a safe default is still set.
   - Effort: small (~20min).

**Picks considered but dropped:**

- Drift sample for `second-real-agentic-run-success` — still open in postrun, but needs 3+ new samples and each costs a real agentic run; cost > value in a session.
- Tests for `src/adapters/base.ts` — abstract PTY shim, no decision logic; score < 3.
- Tests for `local-runner-options.ts` — pure factory with env-var branches; score ≈ 2.

**Signals consulted:** prior decisions (deferred pick #2 still open), god-node coverage (graphify), roadmap milestones M1–M5, open postrun patterns, recent commits (last 48h = mostly test/docs; weighted accordingly), source-vs-test file map.

**Notes:** Roadmap M1, M2, M3, M4 all turn out to be code-backed — the remaining gaps are *test-backed* not *code-backed*. That's a meaningful shift in the signal landscape and argues for raising the weight of "acceptance metric has code but no asserting test" relative to "acceptance metric unimplemented." Not adjusting the SKILL.md weights yet — one observation isn't enough; flagging for the next invocation to confirm.

---

## 2026-04-22 — 1 pick (fourth invocation)

**Picks:**

1. **Structural tests for `createImplementFeatureLocalBlueprint` (roadmap M2)** (score: 4) — `Status: completed (commit 112a2da)` — added `src/blueprints/implement-feature.test.ts` with 5 assertions: `validateBlueprint` passes (M2-1); gate nodes `{typecheck, lint, test, verify-branch}` all present (M2-2); zero nodes with `op.type='git' && op.action='push'` (M2-3 "no remote push" pinned); `maxDurationMs` + `maxTotalRetries` both declared (M2-4 bounded-time); lint→fix-lint→lint and test→fix-tests→test feedback edges wired. No factory changes — contract was correct as written. Full suite 60/60 pass, typecheck clean. Second consecutive clean-landing "M-metric has code, no test asserts it" pick — pattern holding.
   - Rationale: M2 has two unasserted acceptance metrics — "Blueprint validates with `validateBlueprint`" and "Remove default remote push from local-only flow." Code exists (`src/blueprints/implement-feature.ts:13`) and is wired into the `run-local-feature` CLI (`src/cli.tsx:74,84`), but zero tests reference `createImplementFeatureLocalBlueprint`. Same signal shape as invocation #3 pick #2 (M1 runPolicy) — which landed clean and caught zero bugs; supports the "code-backed but test-unasserted" hypothesis flagged in invocation #3 notes.
   - Evidence: grep `createImplementFeatureLocalBlueprint|implement-feature-local` on `**/*.test.ts` → 0 matches. Factory produces 14 nodes + 16 edges; docstring at `implement-feature.ts:6-8` lists a `commit -> push -> cleanup` flow, but no `push` node exists (good — matches M2) — the drift is latent and only a test would pin it.
   - Acceptance: `src/blueprints/implement-feature.test.ts` with ≥4 assertions — (a) `validateBlueprint(bp).valid === true`; (b) deterministic gate nodes `{typecheck, lint, test, verify-branch}` all present; (c) no node has `op.type === 'git' && op.action === 'push'` (enforces the M2 "no remote push" metric); (d) `maxDurationMs` and `maxTotalRetries` set on the blueprint.
   - Effort: small (~20min).

**Picks considered but dropped:**

- Tests for `LocalContextAssembler.assemble()` (score: 3) — touches `git status`/`git diff` + filesystem + env-var, real logic but moderate value; not essential to any acceptance metric. Hold for a future invocation.
- Drift sample for `second-real-agentic-run-success` — still 1 observation in postrun; needs 2–3 more real agentic runs, each costs minutes + real Claude API calls. Cost > value in a session.
- Tests for `src/adapters/{base,claude,codex,gemini}.ts` — PTY shims for the interactive TUI path, not the agentic hot path (which is `completion.ts`, already tested). Score < 3.

**Signals consulted:** prior decisions (both picks from invocation #3 completed — no de-dup needed), roadmap milestones, source-vs-test file map, open postrun patterns (1, unchanged), recent commits (last 72h = only test additions — weighted down to avoid piling on).

**Notes:** Second consecutive observation of "M-metric has code, no test asserts it." After pick #1 lands cleanly, this will be 2/2 clean wins from this signal — enough to consider bumping its weight in SKILL.md during invocation #5.
