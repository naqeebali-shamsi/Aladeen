---
name: run-triage
description: Open a specific Aladeen run JSON, surface the failing node + attempt count, cross-reference with references/learnings.md, and propose next action. Invoke as /run-triage <runId> or /run-triage latest. User-only — never let the model invoke this autonomously.
disable-model-invocation: true
---

# Run Triage

A targeted post-mortem on a single run in `.aladeen/runs/`. Complements `/aladeen-postrun` (which sweeps all runs) by drilling into one.

## Inputs

- `<runId>` — full UUID, prefix (8+ chars), or `latest` (most recently modified `.aladeen/runs/*.json`).

## What to produce

A 4-section report:

1. **Run summary** — blueprintId, status (`completed` / `failed` / `escalated`), wall-clock duration, totalRetries.
2. **Failure locus** — which `nodeExecutions[*]` has the most attempts and a non-success terminal result. Show the last `result.error` and `result.summary`.
3. **Pattern match** — grep `.claude/skills/aladeen-postrun/references/learnings.md` for entries that cite this nodeId, error fingerprint, or blueprintId. List matches with their evidence links.
4. **Next action** — one of:
   - **Code fix**: cite the source file + line where the underlying bug lives.
   - **Blueprint fix**: edge missing, wrong `on:` selector, missing `requiresFileChanges`, missing `npm install` before lint, etc.
   - **Environment fix**: missing CLI (use `runCliPreflight`), missing auth env var, worktree without deps.
   - **Already known**: matches an existing learning — point to it.

## Workflow

```bash
# Resolve runId
RUN_FILE=$(ls -t .aladeen/runs/*.json | head -1)   # for "latest"
# or
RUN_FILE=$(ls .aladeen/runs/<prefix>*.json | head -1)

# Read and parse
cat "$RUN_FILE"
```

Then read `nodeExecutions` — pick the node with `status: failed` (or highest `attempts` if escalated). Read its last `result` for `error`, `summary`, and `output`.

## Heuristics for next-action

| Symptom in result | Likely fix |
|---|---|
| `ENOENT` on a binary | preflight or PATH issue → check `src/adapters/preflight.ts` |
| Lint exits non-zero with "Cannot find module" | worktree missing `npm install` step |
| Agentic node exits 0, `requiresFileChanges` false, downstream lint fails on unchanged code | add `requiresFileChanges: true` to the agentic node |
| `git worktree remove` fails with "contains modified or untracked files" | already handled in `30745b5` — verify blueprint uses the fixed action |
| Same deterministic node retries >5 times | retry edge feeds back to itself without bounded counter — check `maxTotalRetries` |

## Never do

- Don't modify `.aladeen/runs/*.json` — that file is canonical evidence and is protected by a `permissions.deny` rule in `.claude/settings.json`.
- Don't propose speculative fixes without citing the run's actual `error` / `summary`.
- Don't loop into a fix — produce the triage, then stop. The user decides whether to act.
