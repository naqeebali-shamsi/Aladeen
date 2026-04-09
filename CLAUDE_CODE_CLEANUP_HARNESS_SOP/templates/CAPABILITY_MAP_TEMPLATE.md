# CAPABILITY_MAP

Fill one row per tool, plugin, skill, hook, MCP server, or framework in your setup. The goal: identify overlaps and assign one owner per capability.

**Owner status options:** Sole owner | Shared (overlap) | Redundant | Unclear
**Decision options:** KEEP | KEEP BUT MOVE SCOPE | KEEP BUT DISABLE BY DEFAULT | MERGE INTO OFFICIAL PRIMITIVE | DISABLE | UNINSTALL | ARCHIVE

## Memory & Context
| Component | Type | Scope | Owner Status | Decision | Notes |
|-----------|------|-------|-------------|----------|-------|
| _~/.claude/CLAUDE.md_ | _memory_ | _user_ | _Sole owner_ | _KEEP_ | _Shrink to 10 lines max_ |
| _project CLAUDE.md_ | _memory_ | _project_ | _Sole owner_ | _KEEP_ | _Review monthly_ |
| | | | | | |

## Orchestration & Routing
| Component | Type | Scope | Owner Status | Decision | Notes |
|-----------|------|-------|-------------|----------|-------|
| _example: task-master MCP_ | _MCP_ | _user_ | _Shared_ | _KEEP BUT MOVE SCOPE_ | _Move to project_ |
| | | | | | |

## Code Review & Verification
| Component | Type | Scope | Owner Status | Decision | Notes |
|-----------|------|-------|-------------|----------|-------|
| _example: coderabbit_ | _plugin_ | _user_ | _Sole owner_ | _KEEP_ | _Only review tool_ |
| | | | | | |

## Code Generation & Implementation
| Component | Type | Scope | Owner Status | Decision | Notes |
|-----------|------|-------|-------------|----------|-------|
| | | | | | |

## Debugging & Diagnosis
| Component | Type | Scope | Owner Status | Decision | Notes |
|-----------|------|-------|-------------|----------|-------|
| | | | | | |

## Documentation & Research
| Component | Type | Scope | Owner Status | Decision | Notes |
|-----------|------|-------|-------------|----------|-------|
| | | | | | |

## Frontend / Design / Mobile
| Component | Type | Scope | Owner Status | Decision | Notes |
|-----------|------|-------|-------------|----------|-------|
| | | | | | |

## Backend / API / Infra
| Component | Type | Scope | Owner Status | Decision | Notes |
|-----------|------|-------|-------------|----------|-------|
| | | | | | |

## Utility / Glue / Meta
| Component | Type | Scope | Owner Status | Decision | Notes |
|-----------|------|-------|-------------|----------|-------|
| | | | | | |

## Overlap Clusters
Groups of tools that serve the same job — pick a winner, disable the rest:

1. **Cluster:** _example: code review_ — **Tools:** _coderabbit plugin, custom review hook, lint MCP_ — **Winner:** _coderabbit_ — **Remove:** _custom review hook (redundant)_
2. **Cluster:** — **Tools:** — **Winner:** — **Remove:**
3. **Cluster:** — **Tools:** — **Winner:** — **Remove:**
