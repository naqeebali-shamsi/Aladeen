# Audit Prompt — Apply Mode

Paste this into Claude Code after you've reviewed and approved the plan from the dry-run audit. This executes the cleanup.

**Important:** If you're starting a new Claude Code session (not continuing from the audit), the prompt below tells Claude to read the audit files first. Make sure they exist at the path specified (default: `~/.claude/audits/`). If you saved them somewhere else, update the path in the prompt before pasting.

---

**Copy everything below this line into Claude Code:**

```
You are a Claude Code environment cleaner. You will execute a cleanup migration based on a previously completed audit plan.

## Step 1: Read the audit artifacts

First, read these files (adjust the path if you saved them elsewhere):
- ~/.claude/audits/SETUP_AUDIT.md
- ~/.claude/audits/CAPABILITY_MAP.md
- ~/.claude/audits/TARGET_ARCHITECTURE.md
- ~/.claude/audits/MIGRATION_PLAN.md

If any file is missing, stop and tell me which one. Do not proceed without all four.

## Step 2: Back up before changing anything

Create a timestamped backup:
```bash
BACKUP="$HOME/claude-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
cp -a ~/.claude "$BACKUP/dot-claude"
cp -a .claude "$BACKUP/project-claude" 2>/dev/null || true
echo "Backup at: $BACKUP"
```
Record the backup path — you'll reference it in the ROLLBACK_GUIDE.

## Step 3: Execute the migration plan

Work through the phases in MIGRATION_PLAN.md in order. For each change:
- Apply the change
- Verify the change worked:
  - Settings files are still valid JSON (parse them)
  - Run /mcp or `claude mcp list` to confirm MCP is clean
  - No broken references or dangling paths
- Record the decision and outcome

Prefer reversible changes first (disable before delete). Disable risky overlaps before uninstalling anything.

## Constraints

- Do NOT delete user-authored assets without confirming backup exists
- Do NOT leave dead references in settings files
- Do NOT keep cross-project shared-brain patterns unless I explicitly ask for them
- Do NOT leave multiple owners for the same capability without written justification
- If blocked on any step, record the blocker and continue with all safe remaining work

## Step 4: Produce these documents

Save to the same ~/.claude/audits/ directory:

1. **FINAL_STATE.md** — Summary of the clean environment: surviving components, disabled components, open risks, verification results
2. **DECISION_LOG.md** — Every decision made: component, action taken, reason, overlap eliminated, risk, rollback path
3. **ROLLBACK_GUIDE.md** — How to undo the changes: full rollback from backup + partial rollback by layer (memory, settings, hooks, MCP, plugins, skills)

Summarize key outcomes in your response so I can see them immediately.
```
