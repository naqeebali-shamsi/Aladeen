# One-Page Checklist: Claude Code Monthly Cleanup

Print this or keep it pinned. Run through it monthly to prevent drift.

## Pre-Flight
- [ ] Back up `~/.claude/` (timestamped)
- [ ] Back up relevant project `.claude/` directories
- [ ] Note current MCP servers, hooks, plugins, skills, and memory files

## Health Check (Phase B)
- [ ] `/doctor` — no errors
- [ ] `/memory` — nothing unexpected loading
- [ ] `/mcp` — no stale or misscoped servers
- [ ] `/config` — review settings
- [ ] `/help` — everything resolves

## Memory (Phase C)
- [ ] `~/.claude/CLAUDE.md` is small (personal defaults only)
- [ ] Project `CLAUDE.md` is intentional and current
- [ ] Reusable instructions use `@path/to/file.md` references
- [ ] No project-specific state in global memory
- [ ] Nested subtree files aren't force-imported without reason
- [ ] Conditional rules use `paths:` frontmatter

## Settings, Plugins & Hooks (Phase D–E)
- [ ] User-wide settings contain only truly global config
- [ ] Project-specific config lives in project settings files
- [ ] Stale tool references removed from all settings
- [ ] Unused plugins uninstalled (`claude plugin`)
- [ ] Broken hooks disabled or fixed
- [ ] `SessionStart` hooks are lightweight
- [ ] `PreToolUse` hooks reviewed carefully (they fire on every tool call)

## MCP (Phase F)
- [ ] All MCP servers listed with correct scopes (`/mcp` or `claude mcp list`)
- [ ] Project-specific MCP moved off user scope
- [ ] Heavy/unused MCP servers disabled or removed
- [ ] No context warnings at startup

## Tool Ownership (Phase G)
- [ ] One memory strategy (not three)
- [ ] One orchestration strategy (not five)
- [ ] One review strategy
- [ ] One primary owner per capability
- [ ] Redundant tools disabled, archived, or justified in Decision Log

## Verify (Phase H)
- [ ] Open one active project
- [ ] `/memory` loads only intended files
- [ ] Complete one real task end-to-end
- [ ] No missing critical capabilities

## If Running Full SOP, Also Produce:
- [ ] SETUP_AUDIT.md
- [ ] CAPABILITY_MAP.md
- [ ] TARGET_ARCHITECTURE.md
- [ ] MIGRATION_PLAN.md
- [ ] FINAL_STATE.md
- [ ] DECISION_LOG.md
- [ ] ROLLBACK_GUIDE.md
