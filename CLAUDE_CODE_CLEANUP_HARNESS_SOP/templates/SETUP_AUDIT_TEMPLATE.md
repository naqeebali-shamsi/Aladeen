# SETUP_AUDIT

Fill this out during Phase B of the SOP. This is your "before" snapshot.

## Environment Snapshot
- **Date:**
- **Machine:**
- **OS:**
- **Claude Code version:**
- **Backup path:**

## Current Inventory

| Category | Count | Details |
|----------|-------|---------|
| User memory files | | |
| Project memory files | | |
| Rules files (`.claude/rules/`) | | |
| Hooks | | |
| Plugins installed | | |
| MCP servers (user scope) | | |
| MCP servers (project scope) | | |
| MCP servers (local scope) | | |
| Skills (`.claude/skills/`) | | |
| Subagents (`.claude/agents/`) | | |

## `/doctor` Output
```
(paste output here)
```

## `/memory` Output
```
(paste output here)
```

## `/mcp` Output
```
(paste output here)
```

## `/config` Output
```
(paste output here)
```

## Hook Inventory
List every hook found in settings files:

| Hook Name | Event | Settings File | What It Does |
|-----------|-------|---------------|-------------|
| _example_ | _SessionStart_ | _~/.claude/settings.json_ | _Checks for updates_ |
| _example_ | _PreToolUse_ | _~/.claude/settings.json_ | _Blocks writes to .env files_ |
| | | | |

## Plugin Inventory
List installed plugins (from `claude plugin` or `/plugin`):

| Plugin | Status | Real Usage | Notes |
|--------|--------|-----------|-------|
| | | | |

## Problems Found
- 

## Highest-Risk Issues
Things that are actively causing confusion, errors, or wasted context:
1. 
2. 
3. 

## Immediate Priorities
What to fix first:
1. 
2. 
3. 
