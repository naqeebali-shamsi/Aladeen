# Claude Code Cleanup SOP
> v1.0 — March 2026

## Purpose

Turn a messy Claude Code environment into a deliberate one.

Your target end state:
- One clear memory strategy
- One clear orchestration strategy
- One clear review strategy
- Explicit global vs. project scope boundaries
- No overlapping control planes unless the overlap is justified in writing

## When to Run This

Run the full SOP when:
- Claude Code feels noisy, inconsistent, or slow
- `/doctor` shows warnings or errors
- `/memory` loads too much irrelevant context
- MCP tools consume too much startup context
- Multiple skills, hooks, MCP servers, or frameworks serve the same job
- You're setting up a new machine
- You're onboarding a monorepo or large multi-workspace repo

Run a light pass monthly (see the One-Page Checklist).

## Design Principles

1. Official Claude Code primitives are the base layer.
2. One owner per capability.
3. Project-local state over user-global state when scope is project-specific.
4. Keep always-loaded memory small.
5. Disable before deleting.
6. Reversible changes before destructive cleanup.
7. Real usage over hypothetical usage.
8. Explicit configuration over magical side effects.

## Claude Code's Official Architecture (Your Baseline)

These are the built-in primitives you should build on:

| Layer | What | Where |
|-------|------|-------|
| Personal defaults | Tiny global instructions | `~/.claude/CLAUDE.md` |
| Repo-wide instructions | Project context | `./CLAUDE.md` at project root |
| Reusable instruction files | Shared across files via `@` references | `@path/to/file.md` inside any CLAUDE.md |
| Modular rules | Conditional instructions | `.claude/rules/` with `paths:` frontmatter |
| User-wide config | Global settings | `~/.claude/settings.json` |
| Project shared config | Team settings | `.claude/settings.json` |
| Private project config | Local overrides | `.claude/settings.local.json` |
| Hooks | Automation triggers | Defined in settings files only |
| MCP servers | External tool access | Scoped as `local`, `project`, or `user` |
| Skills (slash commands) | Reusable workflows | `.claude/skills/` (or legacy `.claude/commands/`) |
| Subagents | Specialized AI assistants | `.claude/agents/` |
| Plugins | Third-party extensions | Managed via `claude plugin install` |
| User-global skills | Personal reusable workflows | `~/.claude/skills/` (or legacy `~/.claude/commands/`) |
| User-global agents | Personal subagents | `~/.claude/agents/` |

**How `@` file references work:**
```markdown
# In your CLAUDE.md:
@docs/coding-standards.md
@.claude/instructions/testing-rules.md
```
This inlines the referenced file's content when CLAUDE.md loads. Use it to keep your CLAUDE.md small while sharing instructions across files.

**How `paths:` frontmatter works in rules:**
```markdown
---
paths:
  - "src/frontend/**"
  - "*.tsx"
---
Only apply these instructions when working on frontend files.
Use React Server Components by default...
```
This rule only loads when Claude is working on files matching those patterns.

## Inputs — Gather Before You Start

Collect all of these before making any changes:

- [ ] `~/.claude/CLAUDE.md`
- [ ] `~/.claude/settings.json`
- [ ] Project `CLAUDE.md` file(s)
- [ ] `.claude/rules/` directory contents
- [ ] `.claude/agents/` directory contents
- [ ] `.claude/skills/` (or legacy `.claude/commands/`) directory contents
- [ ] Installed plugins (`claude plugin` or `/plugin` in-session)
- [ ] MCP server list and scopes (run `claude mcp list` in your terminal)
- [ ] Hook definitions (check all settings.json files for `hooks` keys)
- [ ] Custom scripts
- [ ] Existing backup location (if any)

## Hard Rules

1. **Back up before changing anything.**
2. Remove overlap before adding new capability.
3. Keep project-specific state out of global memory.
4. No new tool gets added without a written reason.
5. No user-wide enablement for tools that are only useful in one project.
6. If two tools own the same job, one must be disabled, archived, merged, or justified.

## Capability Ownership Model

Every capability needs one primary owner. Here's the recommended model:

| Capability | Primary Owner |
|------------|---------------|
| Memory & instructions | Official Claude Code memory hierarchy |
| Project context | Project `CLAUDE.md` + `.claude/rules/` |
| Config & hooks | Settings files |
| External tool access | MCP |
| Reusable heavyweight workflows | Skills (`.claude/skills/`) or custom slash commands |
| Code review | One primary review path + at most one complementary static analysis or security path |

---

## The Procedure

### Phase A: Back Up Everything

Create a timestamped backup of:
- `~/.claude/` (entire directory)
- Relevant project `.claude/` directories
- Current settings files
- Current memory files

Record the backup path. You'll need it if something goes wrong.

**macOS / Linux:**
```bash
BACKUP="$HOME/claude-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
cp -a ~/.claude "$BACKUP/dot-claude"
cp -a .claude "$BACKUP/project-claude"
echo "Backup at: $BACKUP"
```

**Windows (PowerShell):**
```powershell
$backup = "$env:USERPROFILE\claude-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Path $backup -Force
Copy-Item -Recurse "$env:USERPROFILE\.claude" "$backup\dot-claude"
Copy-Item -Recurse ".claude" "$backup\project-claude"
Write-Host "Backup at: $backup"
```

### Phase B: Baseline Health Check

Run these commands inside Claude Code and record the output:

```
/doctor
/memory
/config
/mcp
/help
```

In your terminal, also run:

```bash
claude mcp list
```

**Record any of these problems:**
- Plugin, skill, or MCP errors
- Context usage warnings
- Broken hooks
- Unexpected memory loading
- Unexpected globally-active MCP servers

### Phase C: Normalize Memory

1. Shrink `~/.claude/CLAUDE.md` to tiny personal defaults only (coding style, preferred tone — nothing project-specific).
2. Move reusable but non-global instructions into separate files and reference them with `@path/to/file.md` in your CLAUDE.md.
3. Keep project-specific instructions in the project's `CLAUDE.md`.
4. Remove global shared-brain patterns unless cross-project state is explicitly desired.
5. Use nested subtree `CLAUDE.md` files for scoped areas in large repos.
6. Don't force-reference subtree files from root unless they truly must load at startup.
7. Convert broad instruction chunks into `.claude/rules/` where appropriate.
8. Add `paths:` frontmatter to any rule that should load conditionally (see syntax example above).
9. Remove any undocumented or unofficial frontmatter — stick to the documented `paths:` field.

### Phase D: Normalize Settings and Plugins

1. Keep truly user-wide settings in `~/.claude/settings.json`.
2. Move project-specific config into `.claude/settings.json` or `.claude/settings.local.json`.
3. Remove stale or dead references from settings — any entries pointing to tools you no longer have installed.
4. Remove config entries pointing to unavailable or defunct tools.
5. Keep hooks defined in settings files only.
6. Review installed plugins (`claude plugin` or `/plugin`). Uninstall plugins you don't actively use — they add context and startup cost.

### Phase E: Normalize Hooks

For each hook, document:

| Hook | Event | Scope | Blocks on failure? | Decision |
|------|-------|-------|-------------------|----------|
| | | | | Keep / Move / Simplify / Disable / Remove |

Claude Code's supported hook events:
- `SessionStart` — runs when a session begins
- `PreToolUse` — runs before a tool call (supports `matcher` to filter by tool name)
- `PostToolUse` — runs after a tool call (supports `matcher` to filter by tool name)
- `Notification` — runs on notifications
- `Stop` — runs when the main agent stops
- `SubagentStop` — runs when a subagent stops

Rules of thumb:
- Keep `SessionStart` hooks lightweight — they run on every new session
- Be extremely careful with `PreToolUse` hooks — they fire on every tool call
- Avoid hooks that mutate too much automatically
- Remove ornamental hooks with no real operating value

### Phase F: Normalize MCP

For each MCP server, document:

| Server | Current Scope | Real Usage | Correct Scope | Decision |
|--------|--------------|------------|---------------|----------|
| | | | user / project / local | Keep / Move / Disable / Remove |

Scoping rules:
- `user` — only for truly cross-project utilities (defined in `~/.claude/settings.json`)
- `project` — for team-shared repo tools (defined in `.claude/settings.json`)
- `local` — for private or experimental project-specific servers (defined in `.claude/settings.local.json`)
- Move heavy project-specific MCP off `user` scope to reduce startup context

### Phase G: Normalize Plugins, Skills, MCP Servers, and Frameworks

For every plugin, skill pack, MCP server, subagent, or framework, assign one decision:

| Decision | When to use |
|----------|-------------|
| **KEEP** | It works, it's the right scope, it's the sole owner of its capability |
| **KEEP BUT MOVE SCOPE** | Good tool, wrong scope (e.g., global but should be project-local) |
| **KEEP BUT DISABLE BY DEFAULT** | Useful occasionally, shouldn't load every session |
| **MERGE INTO OFFICIAL PRIMITIVE** | Its job can be done by a built-in Claude Code feature |
| **DISABLE** | Not currently needed, might want it later |
| **UNINSTALL** | Not needed, won't want it later |
| **ARCHIVE** | Save the config/code somewhere, then remove |

Decision priority:
1. Official over third-party
2. Simple over clever
3. Project-local over user-global when scope is project-specific
4. One owner over multiple overlapping owners
5. Real usage over hypothetical usage

If a category is empty (e.g., you have no custom commands), skip it and move on.

### Phase H: Verify in a Real Project

From an active project root, run:

```
/doctor
/memory
/mcp
/help
```

Then complete one real task end-to-end:
1. Inspect something
2. Plan a change
3. Implement it
4. Verify the result

**Success means:** The environment supports real work without confusion, missing capabilities, or unexpected tool loading.

---

## Acceptance Criteria

Your cleanup pass is complete only when ALL of these are true:

- [ ] `/doctor` has no errors
- [ ] Startup context is clean
- [ ] Memory loads are intentional (nothing unexpected)
- [ ] Project subtree instructions load only when relevant
- [ ] Rules with `paths:` are conditional
- [ ] Stale tool references are gone from all settings files
- [ ] MCP scopes are intentional
- [ ] One memory strategy exists
- [ ] One orchestration strategy exists
- [ ] One review strategy exists
- [ ] The environment is understandable by reading a small number of files

## Reintroduction Policy

Before re-enabling any removed tool, ALL four conditions must be true:

1. It solves a **recurring real problem** (not a hypothetical one)
2. No official Claude Code primitive already covers it
3. No surviving tool already owns that capability
4. Its scope is clearly defined

If reintroduced, record in your Decision Log:
- Reason for reintroduction
- Capability it owns
- Scope (user / project / local)
- How to roll it back

Use the `prompts/REINTRODUCTION_REVIEW_PROMPT.md` for this.

## Where to Save Output Documents

Create a dedicated directory for your cleanup artifacts:

```bash
mkdir -p ~/.claude/audits/$(date +%Y-%m-%d)
```

Save all produced documents there. This keeps them out of your project directory and easy to find later.

Each run of this SOP should produce or update these files (blank templates are in the `templates/` folder):

| Document | Purpose | When |
|----------|---------|------|
| `SETUP_AUDIT.md` | Snapshot of your environment before changes | Phase B |
| `CAPABILITY_MAP.md` | Every tool mapped to its capability bucket | Phase C–G |
| `TARGET_ARCHITECTURE.md` | Your intended setup architecture | Phase C |
| `MIGRATION_PLAN.md` | Ordered list of changes to make | Phase C–G |
| `FINAL_STATE.md` | What your setup looks like after cleanup | Phase H |
| `DECISION_LOG.md` | Every keep/disable/remove decision with reasoning | Throughout |
| `ROLLBACK_GUIDE.md` | How to undo changes | Phase A + H |

## Maintenance Schedule

**Monthly (5 min)** — use the One-Page Checklist:
- `/doctor`
- `/memory`
- `/mcp`
- Hook review
- Plugin and skill drift review

**Full SOP re-run** — do this after:
- Setting up a new machine
- A large tool installation spree
- A major repo architecture change

## Core Principle

Official Claude Code primitives are the default architecture. Any plugin, skill, hook, MCP server, or framework must justify its existence against that base layer and against every other tool that already owns the same capability.
