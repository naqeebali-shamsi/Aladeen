# Audit Prompt — Plan Mode (Dry Run)

Paste this into Claude Code to run a full environment audit. This produces planning documents only — nothing gets changed.

---

**Copy everything below this line into Claude Code:**

```
You are a Claude Code environment auditor. Your job is to inspect my entire setup and produce a cleanup plan. Do NOT apply any changes — planning only. The only files you should create are the four planning documents listed below.

## What to audit

Inspect all of these:
- ~/.claude/CLAUDE.md
- ~/.claude/settings.json (look for hooks, MCP servers, and any stale references)
- All project CLAUDE.md files in this repo
- .claude/rules/ (check for paths: frontmatter and scope)
- .claude/agents/ (subagent definitions)
- .claude/skills/ and .claude/commands/ (slash commands)
- Installed plugins (run /plugin or `claude plugin` in bash)
- All MCP servers and their scopes (run /mcp or `claude mcp list` in bash)
- All hook definitions in every settings file (SessionStart, PreToolUse, PostToolUse, Notification, Stop, SubagentStop)
- Any custom memory systems, shared-brain patterns, or custom scripts

If a category is empty or doesn't exist in my setup, note it and move on.

## Principles to apply

- Official Claude Code primitives are the base layer — prefer them over third-party tools
- One owner per capability — no two tools should own the same job
- Project-local over user-global when scope is project-specific
- Disable before delete — prefer reversible changes
- No overlap without written justification

## For every component, assign one decision

- KEEP
- KEEP BUT MOVE SCOPE
- KEEP BUT DISABLE BY DEFAULT
- MERGE INTO OFFICIAL PRIMITIVE
- DISABLE
- UNINSTALL
- ARCHIVE

## Produce these documents

Save all four to ~/.claude/audits/ (create the directory if needed):

1. **SETUP_AUDIT.md** — Snapshot of current environment: full inventory, problems found, highest-risk issues, immediate priorities
2. **CAPABILITY_MAP.md** — Every tool/plugin/skill/hook/MCP mapped to its capability bucket with owner status and keep/remove decision
3. **TARGET_ARCHITECTURE.md** — The intended clean architecture by layer (global defaults, project context, rules, settings, hooks, MCP, skills, agents, plugins)
4. **MIGRATION_PLAN.md** — Ordered phases for executing the cleanup with specific actions per phase

## Before writing the documents

Summarize your key findings and highest-risk items in your response so I can see them immediately without opening files.

## The plan is complete when it identifies

- One memory strategy
- One orchestration strategy
- One review strategy
- Explicit global vs. project scope for everything
- Every major overlap cluster

Each document should be comprehensive but concise — aim for 50-150 lines each.
```
