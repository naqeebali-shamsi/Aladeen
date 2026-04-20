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

2. **End-to-end test for `aladeen run --resume`** (score: 5) — `Status: suggested`
   - Roadmap M4: "at least one run can be replayed from persisted state + artifacts" — code exists in `src/cli.tsx:23`, `src/engine/runner.ts:resume()`, but never validated since the abandoned-status schema change.
   - Signals: roadmap metric without backing test, recent state.ts churn (1b90475) makes resume risk-prone
   - Acceptance: integration test that runs deterministic blueprint, kills it mid-flight, calls `runner.resume()`, asserts the run completes with all nodes at `completed`.
   - Effort: small

**Signals consulted:** open postrun patterns (1, low-leverage), god-node coverage (graphify), hot-code commits (last 14d), roadmap milestones, prior decisions (none — first run).

**Notes:** The graphify graph paid off here — it surfaced `BlueprintRunner`, `WorktreeManager`, and `base.ts` as the highest-degree code nodes; all three now have tests except `base.ts`. The agentic stack untested situation is the single biggest fragility on the board.
