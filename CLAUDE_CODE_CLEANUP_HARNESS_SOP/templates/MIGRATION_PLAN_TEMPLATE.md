# MIGRATION_PLAN

Ordered phases for executing the cleanup. Fill in specific actions for your environment.

## Phase 1: Backup
- [ ] Back up `~/.claude/` to:
- [ ] Back up project `.claude/` to:
- [ ] Verify backups are complete and readable

## Phase 2: Disable Risky Overlaps
List the overlap clusters from your CAPABILITY_MAP and disable the losers:
- [ ] 
- [ ] 
- [ ] 

## Phase 3: Normalize Memory
- [ ] Shrink `~/.claude/CLAUDE.md` to:
- [ ] Move these instructions to `@` referenced files:
- [ ] Move these instructions to project CLAUDE.md:
- [ ] Remove these global patterns:
- [ ] Add `paths:` frontmatter to these rules:

## Phase 4: Normalize Settings, Plugins & Hooks
- [ ] Move these settings to project scope:
- [ ] Remove these stale references from settings:
- [ ] Uninstall these unused plugins:
- [ ] Fix/disable these hooks:

## Phase 5: Normalize MCP
- [ ] Move these MCP servers to project scope:
- [ ] Move these MCP servers to local scope:
- [ ] Disable/remove these MCP servers:

## Phase 6: Remove Stale Skills & Frameworks
- [ ] Uninstall:
- [ ] Archive (save config, then remove):
- [ ] Disable (keep installed, turn off):
- [ ] Merge into official primitive:

## Phase 7: Verify
- [ ] Run `/doctor`, `/memory`, `/mcp` — confirm clean
- [ ] Complete one real task end-to-end
- [ ] Confirm no missing capabilities

## Rollback Notes
If anything goes wrong, restore from backup path:
- Full rollback: restore entire `~/.claude/` and `.claude/`
- Partial rollback: restore specific layer (see ROLLBACK_GUIDE)
