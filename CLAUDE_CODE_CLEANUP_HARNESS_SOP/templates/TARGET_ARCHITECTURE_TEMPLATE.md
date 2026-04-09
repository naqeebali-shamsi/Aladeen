# TARGET_ARCHITECTURE

Define what your clean setup should look like. Fill in what's allowed and forbidden at each layer.

## Layer A: Global Personal Defaults
- **Purpose:** Tiny, universal preferences that apply everywhere
- **Allowed:** Coding style, tone preferences, short behavioral rules
- **Forbidden:** Project-specific instructions, large context blocks, tool configs
- **Files:** `~/.claude/CLAUDE.md`

## Layer B: Reusable Instruction Files
- **Purpose:** Shared instruction blocks referenced via `@path/to/file.md`
- **Allowed:** Cross-project patterns, style guides, workflow templates
- **Forbidden:** State, project-specific data, anything that should be conditional
- **Files:** (list your referenced instruction files here)

## Layer C: Project Context
- **Purpose:** Repo-specific instructions and rules
- **Allowed:** Architecture context, conventions, team rules, conditional rules with `paths:`
- **Forbidden:** Global preferences, user-specific config
- **Files:** `./CLAUDE.md`, `.claude/rules/`

## Layer D: Project-Local State
- **Purpose:** Private or experimental project-specific config
- **Allowed:** Local settings overrides, per-developer preferences
- **Forbidden:** Team-shared config (use Layer C), global config (use Layer A)
- **Files:** `.claude/settings.local.json`

## Layer E: Settings, Hooks, and MCP
- **Purpose:** Execution configuration and external tool access
- **Allowed:** Intentionally scoped hooks, MCP at correct scope, verified tools
- **Forbidden:** Orphaned references, globally-scoped project tools, duplicate capabilities
- **Files:** `~/.claude/settings.json`, `.claude/settings.json`

## Layer F: Skills, Agents, and Plugins
- **Purpose:** Reusable workflows, specialized AI assistants, and third-party extensions
- **Allowed:** Well-scoped skills with clear ownership, agents with defined roles, plugins that serve real needs
- **Forbidden:** Overlapping orchestration, skills/plugins that duplicate built-in features
- **Files:** `.claude/skills/`, `.claude/agents/`, `~/.claude/skills/`, `~/.claude/agents/`
- **Plugin management:** `claude plugin install/uninstall` or `/plugin` in-session
