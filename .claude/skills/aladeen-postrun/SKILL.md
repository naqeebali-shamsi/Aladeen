---
name: aladeen-postrun
description: Scan Aladeen run artifacts in .aladeen/runs/, classify failures, and append evidence-cited learnings to references/learnings.md. Invoke after blueprint runs or on demand to surface patterns the runtime can't fix on its own.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Edit
  - Write
---

<objective>
Aladeen's runtime persists per-run state to `.aladeen/runs/{runId}.json`. Those artifacts are the only ground truth for whether the harness is actually delivering on its bounded-retry, deterministic-gate guarantees. This skill turns that pile of JSON into actionable knowledge that compounds over time.

The skill is **self-evolving**: each invocation reads the prior `references/learnings.md`, finds NEW patterns in the latest runs that aren't already documented, and appends them with evidence (run ID, node ID, attempt count, error snippet). It never invents — every entry must cite a concrete artifact path.
</objective>

<process>

## 1. Inventory the runs

```bash
ls .aladeen/runs/*.json 2>/dev/null
```

Read each run file. Extract:
- `runId`, `blueprintId`, `status`, `startedAt`, `completedAt` (or null)
- For each node: `attempts`, final `outcome`, last `error` (truncated to 200 chars)
- `escalationReason` if present
- Wall-clock duration if both timestamps exist

## 2. Read prior learnings

Read `references/learnings.md` if it exists. The patterns documented there are the baseline — do not re-report them.

## 3. Classify each run into pattern buckets

Look for these patterns (extend the list when new ones appear):

| Pattern | Detection rule |
|---|---|
| **Runaway retry loop** | Any node with `attempts > 20` |
| **Stuck running** | `status: "running"` with `startedAt` older than 1 hour and no `completedAt` |
| **Escalation w/o failure path** | `escalationReason` matches `/exhausted retries with no failure path/` |
| **Repeating identical error** | Same `error` substring across ≥3 attempts on one node |
| **Worktree dependency miss** | Error matches `/Cannot find module.*node_modules/` (worktrees lack installed deps) |
| **Adapter preflight failure** | Agentic node failure with `error` mentioning `preflight` or `adapter` |
| **Deterministic gate noise** | Lint/test/typecheck node failing with empty stdout (config issue, not code issue) |
| **Wall-clock timeout** | `escalationReason` matches `/Wall-clock timeout/` |
| **Successful blueprint** | `status: "completed"` — record so we know which blueprints actually work end-to-end |

## 4. Diff against prior learnings

For each detected pattern in step 3:
1. Check `references/learnings.md` for an entry already covering this pattern + the same root cause.
2. If covered: skip silently.
3. If new OR same pattern but materially different evidence (different blueprint, different node, different error class): append a new entry.

## 5. Append new entries

Each entry in `references/learnings.md` follows this shape:

```markdown
## YYYY-MM-DD — {pattern-name}

- **Run:** `{runId}` — `.aladeen/runs/{runId}.json`
- **Blueprint:** `{blueprintId}`
- **Node:** `{nodeId}` (kind: deterministic|agentic, attempts: N)
- **Evidence:** `{first ~200 chars of error or escalationReason}`
- **Suggested next action:** {one concrete code/blueprint change — e.g. "add `npm install` step before lint in worktree", "lower fix-lint maxRetries from 5 to 2", "add exitCodeMap for tsc=2 → escalate not retry"}
- **Status:** open

```

If an entry's suggested action gets implemented later, change `Status: open` to `Status: resolved (commit {sha})` rather than deleting it. Resolved entries stay as the audit trail.

## 6. Print a console summary

Always end with a one-screen summary:

```
Aladeen post-run report — {N} runs scanned, {M} new patterns logged
  • {pattern}: run {short-id} ({blueprint})
  • ...
Open patterns: {open-count} (see references/learnings.md)
```

If there are no new patterns and no unresolved open ones, just print:

```
Aladeen post-run report — {N} runs scanned, no new patterns. Existing open: {open-count}.
```

</process>

<rules>
- **Never invent.** Every appended fact must cite a real `runId` and a quoted error fragment.
- **Never delete prior entries.** Resolutions overwrite the `Status:` line only.
- **Never fix code from inside this skill.** This skill observes and reports. Code fixes happen in normal dev flow, prompted by the report.
- **Truncate errors to ~200 chars** in learnings.md. Full errors stay in the run JSON.
- **Skip runs you've already classified.** Use `references/runs-seen.txt` (one runId per line) as the cursor — append new IDs after a successful pass.
- If `.aladeen/runs/` is empty or missing, print `No runs to analyze.` and exit cleanly.
</rules>

<self_evolution>
This skill becomes more useful the more it runs. Two evolution levers:

1. **The pattern table in step 3** — when you see a recurring failure that doesn't match any existing pattern, edit this SKILL.md to add a new row with its detection rule. The next run picks it up automatically.

2. **`references/learnings.md`** — grows monotonically. Open entries are the project's bug backlog informed by real runtime data; resolved entries are the historical record.

When adding a new pattern row, also note in the entry it generated which runs first surfaced it, so a future reader can see why the rule exists.
</self_evolution>
