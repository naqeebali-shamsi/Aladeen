# ROLLBACK_GUIDE

How to undo the cleanup if something breaks. Fill this in during Phase A (backup) and Phase H (verify).

## Backup Location
- **Full backup path:**
- **Date created:**
- **What's included:**

## Full Rollback

Restore everything to pre-cleanup state:

**macOS / Linux:**
```bash
# cp -a preserves dotfiles and permissions
cp -a ~/claude-backup-YYYYMMDD-HHMMSS/dot-claude/. ~/.claude/
cp -a ~/claude-backup-YYYYMMDD-HHMMSS/project-claude/. .claude/
```

**Windows (PowerShell):**
```powershell
Copy-Item -Recurse -Force "$env:USERPROFILE\claude-backup-YYYYMMDD-HHMMSS\dot-claude\*" "$env:USERPROFILE\.claude\"
Copy-Item -Recurse -Force "$env:USERPROFILE\claude-backup-YYYYMMDD-HHMMSS\project-claude\*" ".claude\"
```

Steps:
1. Stop any running Claude Code sessions
2. Restore `~/.claude/` from backup (commands above)
3. Restore project `.claude/` from backup
4. Restart Claude Code and run `/doctor` to verify

## Partial Rollback by Layer

### Memory
What to restore:
- 
How to restore:
- 

### Settings
What to restore:
- 
How to restore:
- 

### Hooks
What to restore:
- 
How to restore:
- 

### MCP
What to restore:
- 
How to restore:
- 

### Plugins
What to restore:
- 
How to restore (use `claude plugin install`):
- 

### Skills / Agents / Commands
What to restore:
- 
How to restore:
- 
