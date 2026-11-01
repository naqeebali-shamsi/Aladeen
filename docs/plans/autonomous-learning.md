# Autonomous learning and mechanic roadmap

Owner direction (2026-11-02): extend Aladeen toward autonomous learning review, decisions, and verified repairs. Implementation starts from the existing dirty local 0.6.0 checkout; unrelated changes are preserved. No publication is authorized by this plan.

## First delivery: deterministic autonomous reviewer

All CLI and daemon actuation routes use the same pure review policy before selecting lessons. Decisions carry lesson ID, policy version, review timestamp, distinct-session count, verdict and stable reason codes. Learning and maintenance persist the latest eligibility snapshot at `.aladeen/lessons/review.json`; this is not a history of successful writes. `aladeen lessons --review --json` previews current decisions without writing guidance. `aladeen learn --json` includes review results.

Approval requires recognized built-in detector provenance, exact built-in guidance templates with constrained dimensions, consistent distinct-session/evidence counts, eligible lifecycle state, sufficient retention and recent evidence. User-prompt inferences and unknown/manual/model-generated lessons are held. Unsafe structure, inconsistent counts and retired lessons are rejected. Regression measurements hold approval. These are conservative engineering defaults, not calibrated statistical confidence or proof of causation. Local JSON provenance is not authenticated, and references are checked structurally, not resolved against raw traces.

Managed writes reject ambiguous fences and propagate read failures other than missing files. Empty approval selection withdraws only the owned block. Unchanged reapplication preserves its original measurement boundary; changed guidance and withdrawn/reintroduced rules start a new boundary. Existing explicit CLI application and daemon opt-out behavior remain the authorization surfaces. No environment repair is triggered by lesson review.

## Current repair boundary

The local WIP already exposes remedy --apply for dependency installation in worktrees. Its current exit-zero result does not demonstrate that the original failure was repaired, and cleanup normally discards the installed dependencies. Worktrees alone do not isolate process credentials, network or lifecycle scripts. Autonomous environment repair should wait for reproduction, explicit postconditions and resource/permission limits.

## Next milestones and acceptance criteria

1. Scope and trustworthy measurements: attach project identity to lessons and observations; exclude ineligible provider/project sessions; resolve evidence references against stored traces. Tests must show unrelated sessions cannot improve a verdict.
2. Honest and reversible guidance: revise causal detector wording, add explicit owner-rule conflict checks, versioned managed-block snapshots, concurrent-edit detection and append-only decision/application records. Tests must preserve owner edits and reverse a trial without disturbing other work.
3. Contextual user learning: distinguish explicit preferences from inferred observations; retain counterexamples and project/task scope. Semantic reflection proposes hypotheses with citations; deterministic policy controls promotion. User-inferred preferences remain held until this mechanism exists.
4. Verified repair experiments: reproduce the failure on the relevant source state; run a constrained candidate repair; repeat the original check and relevant regression checks; preserve evidence/diff and report cleanup errors. Successful installation alone must never pass as a repair.
5. Broader mechanic evaluation: held-out failures across agents/platforms/projects; report verified repair rate, regressions, abstentions and interventions. Grant repair classes authority individually, based on measured results.

## Research used in planning

- https://www.anthropic.com/research/harness-design-long-running-apps ? separation of generation and evaluation; an evaluator is not proof of correctness.
- https://www.anthropic.com/research/demystifying-evals-for-ai-agents ? evaluate environment outcomes and account for variability.
- https://arxiv.org/abs/2303.11366 ? Reflexion: linguistic feedback with episodic memory; does not validate inferred personal preferences.
- https://arxiv.org/abs/2606.04329 ? memory poisoning motivates constraining memory promotion; this implementation does not claim immunity.

## Validation

Synthetic fixtures only; no private logs ingested, no real AGENTS.md actuation, no repairs, no publish. Run full tests, typecheck, lint and build after integration. Record actual outcomes below when completed.


### First delivery result (2026-11-02)

Completed with three parallel agents covering learning review, actuation/repair assessment, and independent research/integration review. Existing local work was preserved.

- Full suite: 451 tests across 46 files passed.
- Typecheck, ESLint and production build passed.
- Built CLI smoke: `lessons --review --json` on a temporary empty repository returned an empty decision set without creating state. `learn --apply --json` with no ingested sessions withdrew only an existing managed block, preserved owner text and wrote the decision snapshot.
- Independent review caught provider-name interpolation and zero-session withdrawal gaps; both were fixed with regression coverage. Regression evidence survives withdrawal so a harmful rule cannot oscillate back into approval on the next run.
- Documentation now distinguishes local dependency-repair experiments from the unverified published npm artifact.

This delivery changes README.md, src/cli.tsx, src/learning/{review.ts,review.test.ts,actuate.ts,actuate.test.ts,store.ts}, src/daemon/{maintenance.ts,maintenance.test.ts}, and this plan. The daemon directory and CLI already contained owner WIP before this delivery. Changes remain uncommitted; no npm publish, Git push or scheduled-task installation was performed.

Remaining milestones above are planned, not delivered. In particular, the current structural reviewer does not infer personal preferences, resolve trace evidence, check semantic owner-rule conflicts or verify environment repairs.


## Second delivery: project scope and resolved evidence

Implementation covers milestone 1. Optional project scope and measurement exclusion counters preserve schema-v1 readability. Known projects partition consolidation and stable lesson IDs; unknown and legacy records stay separate. Source ingesters use actual cwd where available; encoded Claude folders and OpenClaw storage paths cannot authorize project guidance. Updated path scrubbing avoids home-prefix and POSIX case collisions, with legacy home-scrubbed paths requiring reingestion.

Review policy v2 takes an explicit target project and regenerated source evidence. Every supporting session and saved event reference must match the project, provider and detector shape. Detector aggregates are recomputed from stored traces rather than trusting old digest claims. Source timestamps govern evidence freshness. CLI preview, explicit application and daemon maintenance share this context; final application binds scope to the actual destination directory.

Measurement filters project/provider identity, deduplicates sessions and rejects conflicting copies and unusable clocks. Current measurements demote a formerly verified lesson when improvement is no longer supported. The exclusion counters are visible in formatted output. No real private logs were ingested or applied during development.

Validation results will be recorded after integration checks. Remaining milestones 2-5 are still planned; autonomous general-purpose repair and inferred personal preference promotion are not part of this delivery.


### Second delivery result (2026-11-02)

Completed milestone 1 with four parallel workers and an independent integration review.

- Full suite: 538 tests across 48 files passed.
- Typecheck, ESLint and production build passed.
- Built CLI smoke with synthetic local and foreign sessions created two scoped lessons, approved/applied only the local lesson, held the foreign lesson, persisted both decisions and preserved owner text during read-only preview.
- Review fixes include source-derived freshness, home-path boundary/POSIX-case handling, legacy scrub reingestion gates, physical destination checks and normalized target metadata. Directory junctions/file symlinks cannot redirect a learned guidance write; use the physical project path.
- Equivalent Windows separator/case and relative/absolute target spellings now preserve and withdraw the same actuation record. Regression evidence survives withdrawal.

Files added: src/learning/{scope.ts,scope.test.ts,evidence.ts,evidence.test.ts}. Changes also cover lesson schema/detectors/consolidation, reviewer, measurement, learning orchestration, actuation, Claude ingest, path scrubber, CLI/daemon and related tests. Existing unrelated local work remains preserved and all changes remain uncommitted. No real user sessions were ingested, no real guidance block was updated, and no release or scheduled task was installed.

Known limits: source transcript files are locally trusted rather than authenticated. Freshness is based on source session timestamps, not individual supporting event timestamps; a resumed session can contain older events. Project identity is local and directory-based; aliases, subdirectories and worktrees are not inferred to be one repository. Semantic owner-rule conflict checks, contextual personal preferences, versioned reversible trials and verified environment repairs remain later milestones.
