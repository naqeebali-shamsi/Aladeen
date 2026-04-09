# DECISION_LOG

One row per decision. Fill this in as you work through the cleanup.

| Component | Decision | Reason | Overlap Eliminated | Risk | Rollback Path |
|-----------|----------|--------|--------------------|------|---------------|
| _example: obsidian-mcp_ | _DISABLE_ | _Only used in one project, loaded globally_ | _Reduced startup context by ~2k tokens_ | _Low — can re-enable anytime_ | _Add back to ~/.claude/settings.json MCP section_ |
| _example: custom review hook_ | _UNINSTALL_ | _Redundant with coderabbit skill_ | _Removed duplicate review path_ | _Low — backed up in archive_ | _Restore hook from backup_ |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |

## Decision Options Reference
- **KEEP** — No change needed
- **KEEP BUT MOVE SCOPE** — Right tool, wrong scope
- **KEEP BUT DISABLE BY DEFAULT** — Useful sometimes, shouldn't always load
- **MERGE INTO OFFICIAL PRIMITIVE** — Replace with built-in feature
- **DISABLE** — Turn off, keep installed
- **UNINSTALL** — Remove completely
- **ARCHIVE** — Save config/code, then remove
