---
name: aladeen-next
description: Pick the next highest-leverage task for Aladeen by synthesizing roadmap, open postrun patterns, recent runs, and recent commits. Produces a ranked 1-3 candidate report with concrete acceptance criteria. Self-evolving via references/decisions.md.
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Write
  - Edit
---

<objective>
Three things kill momentum on a one-developer project: forgetting where you left off, working on what's interesting instead of what's load-bearing, and re-discovering the same problems from scratch each session. This skill exists to surface "the next 1-3 things worth doing" with evidence, so a session can start with a bias toward action.

The skill is **self-evolving** in two narrow, honest ways:
1. Every invocation appends its picks (and why they were chosen) to `references/decisions.md`. Future invocations read that log and refuse to re-suggest items already picked unless their signals have measurably changed.
2. When a picked task gets done — detectable by a postrun pattern flipping `open → resolved`, a new commit touching the named files, or the developer marking it `Status: completed` in decisions.md — the skill records which signals predicted that pick was worth doing. Over time, signal-to-fix correlation accumulates; signals that consistently predict real value get cited first in future reports.
</objective>

<process>

## 1. Gather signals (read-only, in this order)

Run each in parallel where safe.

### a. Open postrun patterns
```bash
ls .claude/skills/aladeen-postrun/references/learnings.md 2>/dev/null
```
If it exists, grep for `Status: open`. Each open pattern is a candidate (highest weight — these are *real failures the system saw*).

### b. Roadmap progress
```bash
ls LOCAL_FIRST_DELIVERY_ROADMAP.md ROADMAP.md .planning/ROADMAP.md 2>/dev/null
```
Read the first that exists. Map each milestone's acceptance metrics against the implemented code (use `Grep` to look for the named features). Milestones whose metrics aren't backed by code or tests are candidates.

### c. Recent runs (last 14 days)
```bash
ls .aladeen/runs/*.json 2>/dev/null
```
Read each. Note: blueprints that have *never* completed successfully, blueprints that completed but had high `attempts` on any node, runs that escalated. Don't re-flag what postrun already covers — defer to those entries.

### d. Recent git activity
```bash
git log --oneline -20
git log --since="14 days ago" --pretty=format:"%h %s" -- src/ | head -30
```
Identify what areas of the code are hot. Hot areas with no recent tests, or that touched the bounded-retry / worktree / state code, are candidates for hardening.

### e. Knowledge graph (if present)
```bash
ls graphify-out/graph.json 2>/dev/null
```
If present, run `/graphify query "what is the highest-betweenness node with no test coverage"` (or equivalent). Bridge nodes without tests are fragility candidates.

### f. Prior decisions
Read `references/decisions.md` if it exists. Pull the last 5 picks. **Do not re-suggest** any item still listed unless the signals that originally surfaced it have measurably worsened (e.g. an open pattern got more runs piled onto it).

## 2. Score and rank

Each candidate gets weighted by which signals support it:

| Signal | Weight | Why |
|---|---|---|
| Open postrun pattern with multiple runs | 5 | Real, recurring failure |
| Open postrun pattern with one run | 3 | Real but single observation |
| Roadmap milestone metric without code backing | 4 | Promised but undelivered |
| Hot code area without tests | 3 | Bug magnet |
| Graph god-node without test coverage | 2 | Fragility |
| Repeated request from prior decisions | -2 | Avoid suggesting what was already shown |

Sum the weights. Take the top 3. Drop anything scoring below 3.

## 3. Output

Print directly to chat (do NOT write a separate file for this part — the developer reads it once and acts):

```
# /aladeen-next — N candidate(s) ranked

## 1. {short title} ({score})
- **Why:** {one sentence}
- **Evidence:** {bulleted list — every item must cite a real file, run ID, commit, or pattern}
- **Acceptance criterion:** {one falsifiable thing — "regression test for X passes", "open pattern Y flips to resolved"}
- **Estimated effort:** small (<30min) | medium (30min-2h) | large (>2h)

## 2. ...

## 3. ...
```

If no candidate scores ≥ 3, print only:
```
/aladeen-next — nothing high-leverage on the board. Last session left things in a clean state.
Lowest-friction option: pick from the backlog (referenceslog) or pick a drift sample to grow the postrun corpus.
```

## 4. Append to decisions log

Append to `references/decisions.md` (create if missing):

```markdown
## YYYY-MM-DD HH:MM — {N} picks

**Picks:**
1. {title} (score: X) — `Status: suggested`
2. ...

**Signals consulted:** {comma-separated list of signal types that fired}

**Notes:** {one line if anything surprised you — e.g. "all 3 picks come from the same postrun pattern"}
```

Do not delete prior entries. When a pick later gets done, edit only its `Status: suggested → completed (commit XXXX)` line.

</process>

<rules>
- Cite real files, real commits, real run IDs, real pattern names. Never invent.
- Refuse to suggest things you cannot defend with citations.
- Bias hard toward what failed in production over what looks elegant on paper.
- The developer's time is the constrained resource — prefer 1 high-confidence pick over 3 mediocre ones.
- Skip if signals are thin: "no candidate ≥ 3" is a valid output.
- If you find a brand-new failure mode in the runs that postrun hasn't classified yet, do NOT silently absorb it — point at it and tell the developer to invoke `/aladeen-postrun` first.
</rules>

<self_evolution>
Two evolution levers, both narrow and honest:

1. **Decision history (`references/decisions.md`)** — append-only log of picks with their rationale and outcome. Future invocations read it to (a) avoid noise and (b) learn which signals tend to predict real value.
2. **Signal weights table in this SKILL.md** — when a pattern of "signal X consistently predicted high-value picks" emerges, edit the weight of X up. When a signal keeps producing picks that fizzle, edit it down. Only adjust weights based on multiple observations, not single events. Note the adjustment + evidence in `references/decisions.md` so the change is auditable.
</self_evolution>
