# Local-First Autonomy Spec (V1)

## Goal
Build a local-only autonomous harness for a solo developer that accepts a feature request and produces a PR-ready local branch with deterministic quality gates.

## Guarantees
- Local-only execution path (no cloud model calls in V1).
- Bounded retries and bounded run duration.
- Hard quality gates before success:
  - typecheck
  - lint
  - tests
  - repo policy checks
- Persistent run state and artifact trail for replay and diagnosis.

## Non-Goals
- Multi-user orchestration and company-level governance.
- Cloud fallback or hybrid routing.
- Full org-chart UX and plugin marketplace integration.

## Reuse-First Components
- Graph context: Graphify output and query workflow.
- Long-term memory: MemPalace recall/writeback patterns.
- Orchestration runtime: existing Aladeen blueprint runner.
- Governance ideas: Paperclip-style budget and trace discipline (adapted, not reimplemented wholesale).

## Runtime Architecture
1. Intake parses a user task into a local feature plan.
2. Context assembler builds a prompt pack from:
   - graph slices
   - memory recall
   - repository digest
3. Planner model proposes a sprint contract.
4. Generator executes against contract in an isolated worktree branch.
5. Deterministic verifiers run in a strict order.
6. Evaluator model scores quality and decides pass/retry.
7. On failure, retry loop continues until budgets are exhausted.
8. On success, branch is marked PR-ready locally.

## Model Tiering (Local-Only)
- Tier A (router/planner): fast local model for task decomposition.
- Tier B (generator): stronger coding local model for implementation.
- Tier C (evaluator): separate local model or isolated persona for critical review.

## Policy Defaults
- `maxNodeRetries`: 2
- `maxTotalRetries`: 5
- `maxRunDurationMs`: 45 minutes
- `cloudFallbackAllowed`: false
- `escalateOnBudgetExhaustion`: true

## Verifier Contract
Mandatory verifier order for V1:
1. Typecheck
2. Lint
3. Tests
4. Git/repo policy checks
5. Diff policy checks

Any failed mandatory gate blocks completion.

## Telemetry Contract (Provider-Agnostic)
Each run records:
- run identity (`runId`, `blueprintId`, `taskId`)
- timing (`startedAt`, `completedAt`, node durations)
- quality (`verifier outcomes`, evaluator scorecard)
- retries (`node retries`, `total retries`)
- escalation (`reason`, failed gate, last errors)

The telemetry API remains Langfuse-compatible through an adapter interface but supports local-first backends.

## CLI Surface (V1)
- `run-local-feature`: execute canonical local blueprint.
- `resume`: resume saved run by ID.
- `inspect-run`: print structured run details and verifier status.

## Acceptance Criteria
- A demo feature task reaches `completed` without human edits on a supported local setup.
- Failures provide actionable escalation reason and artifact path.
- `inspect-run` explains why a run passed/failed and which gate blocked progress.
