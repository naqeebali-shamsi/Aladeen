# Claude Code Cleanup SOP
> v1.0 — March 2026

A ready-to-use standard operating procedure for cleaning up bloated Claude Code environments. Includes the full SOP, copy-paste prompts, fill-in templates, and a monthly maintenance checklist.

## The Workflow

```
Read SOP ──> Paste Audit Prompt ──> Review Output ──> Paste Apply Prompt ──> Verify ──> Monthly Checklist
   │              (dry run)            (you decide)      (executes cleanup)    (real task)    (prevent drift)
   v
 product-files/    prompts/            ~/.claude/audits/     prompts/          /doctor        ONE_PAGE_
 CLEANUP_SOP.md    AUDIT_PLAN_         (your artifacts)      AUDIT_APPLY_      /memory        CHECKLIST.md
                   COMMAND.md                                COMMAND.md
```

## What's Inside

```
product-files/
  CLAUDE_CODE_CLEANUP_SOP.md           — The full step-by-step cleanup procedure
  ONE_PAGE_CHECKLIST.md                — Monthly maintenance checklist (print this)

prompts/
  AUDIT_PLAN_COMMAND.md                — Paste into Claude Code to run a dry-run audit
  AUDIT_APPLY_COMMAND.md               — Paste into Claude Code to execute the cleanup
  REINTRODUCTION_REVIEW_PROMPT.md      — Use when considering re-adding a removed tool

templates/
  SETUP_AUDIT_TEMPLATE.md              — Document your current environment state
  CAPABILITY_MAP_TEMPLATE.md           — Map every tool to its capability bucket
  TARGET_ARCHITECTURE_TEMPLATE.md      — Define your ideal setup layers
  MIGRATION_PLAN_TEMPLATE.md           — Plan the cleanup phases
  FINAL_STATE_TEMPLATE.md              — Record what your setup looks like after cleanup
  DECISION_LOG_TEMPLATE.md             — Log every keep/disable/remove decision
  ROLLBACK_GUIDE_TEMPLATE.md           — Document how to undo changes if needed

FAQ.md                                 — Common questions
```

**About the templates:** The prompts instruct Claude Code to generate these documents automatically during the audit. The templates exist as references for what good output looks like, and for manual use if you prefer to fill them in yourself.

## How to Use This Kit

### First-time cleanup (30–60 min)

1. **Read the SOP** — `product-files/CLAUDE_CODE_CLEANUP_SOP.md`. Understand the phases before touching anything.
2. **Run the audit (dry run)** — Copy the prompt from `prompts/AUDIT_PLAN_COMMAND.md` into Claude Code. This produces audit documents without changing anything.
3. **Review the outputs** — Look at the generated SETUP_AUDIT, CAPABILITY_MAP, TARGET_ARCHITECTURE, and MIGRATION_PLAN. Make sure you agree with the proposed changes.
4. **Apply the cleanup** — Copy the prompt from `prompts/AUDIT_APPLY_COMMAND.md` into Claude Code. This executes the migration and produces FINAL_STATE, DECISION_LOG, and ROLLBACK_GUIDE.
5. **Verify** — Open a real project, run a real task, confirm nothing is broken.

### Monthly maintenance (5 min)

Use `product-files/ONE_PAGE_CHECKLIST.md` to spot-check for drift. Run `/doctor`, `/memory`, `/mcp`, `/config`, review hooks, check for plugin and skill creep.

### When you want to add a tool back

Use `prompts/REINTRODUCTION_REVIEW_PROMPT.md` before re-enabling anything you removed. It forces you to justify the addition against your current architecture.

## Tips

- **Always back up first.** The SOP enforces this, but it's worth repeating.
- **Disable before deleting.** You can always delete later. You can't un-delete easily.
- **Save your audit artifacts** in `~/.claude/audits/YYYY-MM-DD/` so you can compare over time.
- **Templates are starting points.** Adapt the column names, add rows, make them yours.
- **The prompts work best pasted directly into Claude Code** as a new conversation or at the start of a session.
