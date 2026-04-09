# Local-First Delivery Roadmap (V1)

## Milestone 1: Core Policy and Contracts
### Scope
- Add local-only execution policy fields to run metadata.
- Add architecture contracts for context assembly, routing, and evaluator scoring.
- Add telemetry interfaces and event schema.

### Acceptance Metrics
- 100% of runs include policy metadata.
- 100% of runs emit start and completion telemetry events.
- Contracts compile and are imported by runner/executor modules.

## Milestone 2: Canonical Local Blueprint
### Scope
- Introduce `implement-feature-local` blueprint template.
- Enforce bounded retries, run duration, and deterministic gate nodes.
- Remove default remote push from local-only flow.

### Acceptance Metrics
- Blueprint validates with `validateBlueprint`.
- All gate nodes are present in the blueprint graph.
- Run terminates with `completed`, `failed`, or `escalated` in bounded time.

## Milestone 3: CLI and UX Surface
### Scope
- Add `run-local-feature`, `resume`, and `inspect-run` CLI commands.
- Expand TUI blueprint view to show gate and escalation context.

### Acceptance Metrics
- CLI commands execute without crashing on valid inputs.
- `inspect-run` displays status, retries, and escalation reason when present.
- TUI shows retry counters and current node status transitions.

## Milestone 4: Observability and Learning Baseline
### Scope
- Wire runner lifecycle telemetry hooks.
- Persist evaluator/verifier outcomes in run state.
- Provide a baseline failure taxonomy for post-run analysis.

### Acceptance Metrics
- Every run writes node-level timing and outcome data.
- At least one run can be replayed from persisted state + artifacts.
- Failure reasons are structured enough to bucket by gate/outcome.

## Milestone 5: Stabilization
### Scope
- Validate type safety and lint status for changed files.
- Tighten docs for setup and local-only constraints.

### Acceptance Metrics
- No new lints in modified files.
- Docs clearly define local-only boundaries and non-goals.
