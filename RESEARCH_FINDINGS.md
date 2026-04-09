# Aladeen Research Findings: Advanced Orchestration Patterns

*Compiled: March 2026*

---

## 1. Block's Goose Framework

**Sources**: [GitHub](https://github.com/block/goose), [Block Announcement](https://block.xyz/inside/block-open-source-introduces-codename-goose), [Goose Docs](https://block.github.io/goose/), [Roadmap Discussion](https://github.com/block/goose/discussions/3319)

### Key Findings

- **Rust monorepo** with crates: `goose` (core agent), `goose-server` (backend daemon `goosed`), `goose-cli`, `goose-mcp` (extensions), `mcp-client/mcp-core/mcp-server`
- **MCP-native**: Built on Model Context Protocol from day one; extensions are MCP servers
- **Multi-model**: Works with any LLM provider; supports model switching per task
- **Session isolation**: Each subagent gets own `ExtensionManager`, `ToolMonitor`, communication channels. No shared state between parallel subagents
- **Ralph Loop pattern**: Worker/reviewer iteration with file-based state persistence in `.goose/ralph/`. Fresh context each iteration (avoids context accumulation). Model A works, Model B reviews, loop until done
- **Recipe system**: YAML-based task definitions (`goose run --recipe goose-self-test.yaml`)
- **Per-session agents**: Direction is agent-per-session with isolation, supporting many simultaneous sessions
- **Error handling**: Standardized on `anyhow::Result` for error propagation

### How Stripe Forked and Customized

- Stripe's "Minions" agent loop is a fork of Goose
- Extended to interleave agent loops with deterministic operations (git, lint, test)
- Built Toolshed: centralized MCP server with ~500 tools for internal systems
- Added blueprint state machines on top (deterministic + agentic node mixing)
- Bounded iteration (max 2 CI cycles before human escalation)

### Actionable Recommendations for Aladeen

1. **Adopt Ralph Loop's fresh-context pattern**: Each blueprint iteration should start with clean context + file-based state, not accumulated conversation history
2. **MCP-first extension model**: All tools should be MCP servers from the start
3. **Recipe/YAML task definitions** map well to our blueprint concept
4. **Subagent isolation pattern** (own tool set, own context) validates our worktree approach
5. **Worker/reviewer cross-model pattern** is cheap insurance for quality

---

## 2. MCP Server Patterns for Tool Management

**Sources**: [MCP Spec](https://modelcontextprotocol.io/specification/2025-11-25), [MCP Anniversary](http://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/), [Anthropic MCP Intro](https://www.anthropic.com/news/model-context-protocol), [Enterprise Guide](https://guptadeepak.com/the-complete-guide-to-model-context-protocol-mcp-enterprise-adoption-market-trends-and-implementation-strategies/), [Architecture Overview](https://www.kubiya.ai/blog/model-context-protocol-mcp-architecture-components-and-workflow)

### Key Findings

- **Three primitives**: Tools (actions), Resources (data), Prompts (templates)
- **Server patterns**:
  - **Tool Catalog/Adapter Hub**: Proxy dozens of SaaS APIs as MCP tools (like Stripe's Toolshed)
  - **Prompt Library Server**: Centralized parameterized prompt templates as slash-commands
  - **RAG Server**: `search_corpus`, `get_chunk`, `list_similar` for enterprise docs
- **2025 Nov spec additions**: Tasks primitive for tracking async work (states: working, input_required, completed, failed, cancelled)
- **Auth**: OAuth discovery flow with scoped permissions per agent
- **Rate limiting**: Applied at MCP layer to prevent runaway agents from overloading backends
- **Namespacing**: Isolate capabilities per agent/role
- **Scale**: 97M+ monthly SDK downloads, backed by Anthropic, OpenAI, Google, Microsoft

### Building a Toolshed Equivalent

Key architecture decisions for a centralized tool server:
1. **Tool scoping per agent**: Not all agents need all tools. Blueprint nodes specify which tools are available
2. **Dynamic registration**: Tools can be added/removed at runtime without restarting agents
3. **Namespaced access control**: `git.*` tools for git agents, `test.*` for test agents
4. **Rate limiting per agent**: Prevent any single agent from monopolizing resources
5. **Tool result caching**: Deterministic tool calls (file reads, git status) can be cached

### Actionable Recommendations for Aladeen

1. **Start with tool scoping**: Each blueprint node should declare its tool whitelist
2. **Use MCP Tasks primitive** for async verification steps (CI, tests)
3. **Build tool registry** that maps tool names to MCP server endpoints
4. **Implement per-agent rate limits** from the start (prevents runaway loops)
5. **Design for dynamic tool discovery** so new tools don't require system restarts

---

## 3. Failure Recovery Patterns

**Sources**: [4 Fault Tolerance Patterns](https://dev.to/klement_gunndu/4-fault-tolerance-patterns-every-ai-agent-needs-in-production-jih), [Error Recovery Strategies](https://www.gocodeo.com/post/error-recovery-and-fallback-strategies-in-ai-agent-development), [Microsoft Checkpointing](https://learn.microsoft.com/en-us/agent-framework/tutorials/workflows/checkpointing-and-resuming), [AWS Agent Evaluation](https://aws.amazon.com/blogs/machine-learning/evaluating-ai-agents-real-world-lessons-from-building-agentic-systems-at-amazon/), [Error Handling in Agentic Systems](https://agentsarcade.com/blog/error-handling-agentic-systems-retries-rollbacks-graceful-failure)

### Key Findings

#### Four-Layer Error Handling Model
1. **Layer 1 - Retry with backoff**: For transient errors (network, rate limits). Exponential backoff + jitter to prevent thundering herds
2. **Layer 2 - Model fallback chains**: Primary model -> cheaper fallback -> different provider. Tool calls and history persist across switches
3. **Layer 3 - Error classification**: Route errors correctly:
   - Transient (network/rate limit) -> retry
   - LLM-recoverable (tool failure) -> re-prompt agent with error context
   - User-fixable (missing info) -> pause/escalate
   - Unexpected (bugs) -> bubble up
4. **Layer 4 - Checkpoint recovery**: Save state at every node boundary. Resume from last checkpoint on crash

#### Checkpoint/Resume Strategies
- Save state after each successfully completed blueprint node
- Store side effects in reversible formats (git stashes, temp files)
- Context snapshots as lightweight JSON at critical decision points
- Thread-based resume using checkpoint IDs

#### Loop Detection
- Cap reformulation attempts at 3 (prevents infinite tool-call loops)
- Bounded iteration: max N cycles before escalation (Stripe uses 2)
- Monitor token consumption rate as a loop indicator

#### Escalation
- Timeouts are NOT failures -- they're uncertainty. Don't retry blindly; query state first
- Graceful escalation with full context to human is a sign of maturity, not failure
- Dead letter queue for tasks that exhaust all recovery options

### Actionable Recommendations for Aladeen

1. **Implement all 4 layers** in the blueprint executor
2. **Checkpoint at every node boundary**: serialize node output + git state to JSON
3. **Classify errors in the executor**: different recovery paths for different error types
4. **Cap agentic node iterations at 3** (configurable per blueprint)
5. **Build escalation queue**: tasks that fail all recovery go to human review with full context
6. **Track token consumption** as a health metric; spike = possible loop

---

## 4. Context Engineering

**Sources**: [Anthropic Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [Factory.ai Context Window](https://factory.ai/news/context-window-problem), [JetBrains Research](https://blog.jetbrains.com/research/2025/12/efficient-context-management/), [LangChain Context Engineering](https://blog.langchain.com/context-engineering-for-agents/)

### Key Findings

#### Four Context Strategies (Write, Select, Compress, Isolate)
- **Write**: System prompts, rule files, few-shot examples
- **Select**: Just-in-time retrieval, semantic search, targeted file loading
- **Compress**: Summarize conversation history, clear old tool results
- **Isolate**: Split across subagents, each with own context window

#### Rule File Patterns
- Cursor: `.cursorrules` per directory
- Claude: `CLAUDE.md` per directory, hierarchical
- Codex: `AGENTS.md` per directory
- Pattern: directory-scoped rules that inherit/override from parent

#### Token Budgeting
- Context is a finite resource with diminishing marginal returns
- "Context rot": performance degrades as window grows, even within limits
- Just-in-time > pre-loading: maintain lightweight identifiers, fetch on demand
- Tool result clearing: remove raw outputs from earlier tool calls deep in history

#### Subagents vs Direct Prompting
| Use Subagents When | Use Direct Prompting When |
|---|---|
| Parallel exploration needed | Iterative development with milestones |
| Separation of concerns | Extensive back-and-forth needed |
| Multiple specialized domains | Static content domains |
| Context would bloat main session | Compaction can maintain flow |

#### Fresh Context Pattern (Ralph Loop)
- Each iteration starts with clean context
- State persisted to files between iterations
- Only results (not process) flow back to parent
- Prevents context accumulation across retries

#### Hierarchical Memory
- **User memory**: Personal prefs, project history
- **Org memory**: Style guides, review standards, templates
- **Session memory**: Current task state, progress file

### Actionable Recommendations for Aladeen

1. **Blueprint nodes get scoped context**: Each node declares what context it needs (files, rules, tools)
2. **Implement compaction** in the executor: summarize when approaching limits
3. **Use file-based state between iterations** (Ralph Loop pattern)
4. **Directory-scoped rule files** for per-package agent instructions
5. **Subagents for exploration, direct prompting for implementation**
6. **Token budget per node**: configurable limits that trigger compaction or escalation

---

## 5. Competing Systems Analysis

### Devin AI
**Sources**: [Wikipedia](https://en.wikipedia.org/wiki/Devin_AI), [Digital Applied Guide](https://www.digitalapplied.com/blog/devin-ai-autonomous-coding-complete-guide)

- **Architecture**: Proprietary, closed-source. Full VM per task (shell, browser, editor)
- **Approach**: High autonomy, multi-step planning, web browsing for docs
- **Verification**: End-to-end testing in isolated environments
- **Scale**: Goldman described "hybrid workforce" with 20% efficiency gains
- **Pricing**: Dropped from $500/mo to $20/mo (Devin 2.0, April 2025)
- **Differentiator**: First convincing demo of autonomous SWE; broadest tool access (browser + shell + editor)

### OpenHands (CodeAct)
**Sources**: [ICLR 2025 Paper](https://openreview.net/pdf/95990590797cff8b93c33af989ecf4ac58bde9bb.pdf), [SDK Paper](https://arxiv.org/html/2511.03690v1), [openhands.dev](https://openhands.dev/)

- **Architecture**: Event-sourced state model with deterministic replay. V1 SDK has 4 decoupled packages
- **Agent loop**: Stateless event processor; emits structured events via callbacks
- **Tool system**: Action-Execution-Observation pattern with Pydantic validation. MCP tools are first-class
- **Workspace**: Local/Remote abstraction (same code, swap deployment)
- **Security**: Two-layer: SecurityAnalyzer (risk rating) + ConfirmationPolicy (enforcement)
- **Verification**: Sandboxed containerized execution
- **Differentiator**: Best open-source option; event-sourcing enables replay/audit; modular SDK

### SWE-Agent
**Sources**: [OpenHands vs SWE-Agent comparison](https://localaimaster.com/blog/openhands-vs-swe-agent)

- **Architecture**: Clean, research-oriented. Focused on benchmark performance
- **Approach**: Structured file editing with custom tools
- **Verification**: Test suite execution in sandbox
- **Differentiator**: Research purity; clean architecture researchers love

### Codex CLI (OpenAI)
**Sources**: [OpenAI Blog](https://openai.com/index/unrolling-the-codex-agent-loop/), [GitHub](https://github.com/openai/codex), [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-codex-is-built)

- **Architecture**: Responses API-based agent loop. Prioritized message assembly (system > developer > user)
- **Context**: AGENTS.md files per directory; developer-role messages for sandbox permissions
- **Sandboxing**: Network-disabled by default; configurable autonomy levels
- **Performance**: Linear-time sampling via prompt caching despite quadratic payload growth
- **MCP support**: External tools via MCP (not sandboxed by Codex)
- **Differentiator**: Tight OpenAI integration; prompt caching for speed; simple local-first design

### Goose (Block)
**Sources**: [GitHub](https://github.com/block/goose), [Docs](https://block.github.io/goose/)

- **Architecture**: Rust monorepo; MCP-native extensions
- **Agent loop**: Per-session agents with isolated context
- **Ralph Loop**: Worker/reviewer cross-model iteration with file-based state
- **Verification**: Recipe-based validation (YAML test definitions)
- **Differentiator**: MCP-first; Rust performance; Stripe's production fork proves viability

### Comparative Matrix

| Feature | Devin | OpenHands | SWE-Agent | Codex CLI | Goose |
|---|---|---|---|---|---|
| Open Source | No | Yes | Yes | Yes | Yes |
| Isolation | Full VM | Container | Container | Sandbox | Per-session |
| MCP Support | Unknown | Yes (V1) | No | Yes | Yes (native) |
| Multi-model | Unknown | Yes | Yes | OpenAI only | Yes |
| State Model | Proprietary | Event-sourced | Simple | Message-based | File-based |
| Verification | E2E tests | Sandbox exec | Test suite | Sandbox | Recipes |
| Production Scale | Yes (Cognition) | Growing | Research | Yes (OpenAI) | Yes (Stripe) |

### Actionable Recommendations for Aladeen

1. **Adopt OpenHands' event-sourcing pattern** for the blueprint executor (enables replay, audit, checkpoint)
2. **Use Codex's prioritized message assembly** (system > developer > user) for context construction
3. **Implement Goose's Ralph Loop** for agentic nodes that need iteration
4. **Two-layer security model** from OpenHands (risk assessment separate from enforcement)
5. **AGENTS.md / rule file support** per directory (all major systems converge on this)
6. **Git worktrees over containers** for our use case (lighter than Devin/OpenHands VMs, sufficient isolation)

---

## Cross-Cutting Themes

### All Successful Systems Share

1. **Sandboxed execution**: No system trusts agents with unbounded access
2. **Automated verification**: Tests/lint/CI, never just agent self-assessment
3. **Bounded iteration**: Hard caps on retry cycles
4. **Context isolation**: Subagents or fresh context per iteration
5. **File-based state persistence**: Progress files, checkpoints, not just in-memory
6. **Directory-scoped configuration**: Rule files per directory, not global-only

### Aladeen's Differentiating Opportunity

- **Blueprint state machines** combining deterministic + agentic nodes (Stripe's key innovation, not yet open-source)
- **TypeScript-native** (most competitors are Python or Rust; TS ecosystem is underserved)
- **Local-first with CLI adapters** (leverage existing Claude/Codex/Gemini CLIs)
- **MCP-native tool management** from the start

---

## 6. PTY Session Completion Detection

*Research for AgenticExecutor: how to know when a CLI agent is done*

**Sources**: [Claude Code Headless Docs](https://code.claude.com/docs/en/headless), [Codex Non-Interactive Mode](https://developers.openai.com/codex/noninteractive/), [Gemini CLI Headless](https://geminicli.com/docs/cli/headless/), [Codex CLI Reference](https://developers.openai.com/codex/cli/reference/), [Ralph Loop](https://block.github.io/goose/docs/tutorials/ralph-loop/)

### Critical Finding: Use Headless Mode, Not PTY Parsing

**All three major CLIs now support non-interactive/headless mode** where the process exits on completion. This eliminates the need for PTY output parsing, prompt detection, or quiescence heuristics. The process exit IS the completion signal.

### Per-CLI Headless Capabilities

#### Claude Code (`claude -p`)
- **Flag**: `-p` / `--print`
- **Behavior**: Executes prompt, outputs result to stdout, exits
- **Output formats**: `text` (default), `json`, `stream-json`
- **JSON output**: `{ result, session_id, ... }` -- structured with metadata
- **Structured output**: `--json-schema` flag for schema-validated responses
- **Streaming**: `--output-format stream-json --verbose --include-partial-messages`
- **Tool permissions**: `--allowedTools "Read,Edit,Bash"` (required in headless, no interactive prompts)
- **Session resume**: `--continue` or `--resume <session_id>`
- **System prompt**: `--append-system-prompt` or `--system-prompt` (full replace)
- **Exit codes**: 0 = success, non-zero = failure
- **Also available as**: Python/TypeScript Agent SDK with native message objects

#### Codex CLI (`codex exec`)
- **Command**: `codex exec "<prompt>"` (or `codex e`)
- **Behavior**: Runs non-interactively, final agent message to stdout, progress to stderr
- **Output formats**: text (default), `--json` for JSON Lines
- **JSON events**: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`
- **Completion signal**: `turn.completed` event with token usage metrics
- **Structured output**: `--output-schema ./schema.json -o ./output.json`
- **Permissions**: `--full-auto` (edits allowed), `--sandbox danger-full-access` (CI)
- **Session resume**: `codex exec resume --last` or `codex exec resume <SESSION_ID>`
- **Ephemeral mode**: `--ephemeral` (no disk persistence)
- **Exit codes**: 0 = success, non-zero = failure; `--skip-git-repo-check` for non-git dirs
- **Known issue**: `-q` (quiet mode) can hang on git warnings (GitHub issue #1340)

#### Gemini CLI (positional arg / `--output-format`)
- **Trigger**: Positional argument in non-TTY, or `--output-format` flag
- **Behavior**: Single-turn execution, outputs response, exits
- **Output formats**: text, `json` (single object), streaming JSONL
- **JSON output**: `{ response, stats, error? }` -- includes token usage and latency
- **JSONL events**: `init`, `message`, `tool_use`, `tool_result`, `error`, `result`
- **Unattended mode**: `--yolo` skips confirmation prompts
- **Exit codes**: 0 = success, 1 = general error, 42 = input error, 53 = turn limit exceeded
- **Note**: `-p` flag also available (similar to Claude's)

### Approaches Evaluated

| Approach | Reliability | Complexity | Recommendation |
|---|---|---|---|
| **Headless mode (process exit)** | Excellent | Low | **PRIMARY -- use this** |
| **PTY prompt detection** | Poor | High | Fragile, CLI-dependent regex, breaks on updates |
| **Output quiescence** | Fair | Medium | False positives (agent thinking), false negatives (fast responses) |
| **PTY + interactive mode** | Fair | Very High | Only if headless unavailable (legacy CLIs) |
| **File-based signaling** | Good | Medium | Good supplement for multi-turn (Ralph Loop style) |

### How Competitors Solve This

#### Goose (Block)
- **Does NOT use PTY for agent execution**. Goose is a Rust application with an HTTP server (`goosed`). Agents communicate via API, not terminal parsing
- Ralph Loop uses file-based state (`.goose/ralph/`): worker writes files, reviewer reads them. Each iteration is a fresh process invocation
- Per-session agents managed by the server process, not PTY

#### OpenHands
- **Does NOT use PTY**. Uses event-sourced API with HTTP/WebSocket
- Agent emits structured events via callbacks. Completion = `AgentFinishAction` event
- All tool execution happens through the SDK's typed tool system, not shell parsing
- State tracked via `ConversationState` with append-only `EventLog`

#### SWE-Agent
- **Uses subprocess execution**, not PTY. Commands run via `subprocess.run()` in Python
- Custom tool interface with structured JSON communication
- Completion detected by agent emitting a "submit" action

#### Codex (web/cloud)
- Cloud version runs in isolated microVMs
- Agent loop is server-side; completion is an API event (`turn.completed`)
- CLI version: process exit is the signal (same as our headless approach)

### Key Insight: The Industry Has Moved Past PTY

No production-grade agentic system uses PTY parsing to detect completion. They all use one of:
1. **Process exit** (headless CLI mode) -- simplest, most reliable
2. **API/event-based** (server mode) -- most flexible, requires running daemon
3. **File-based signaling** (Ralph Loop) -- good for multi-iteration patterns

### Recommended Strategy for Aladeen

**Primary (Phase 1): Headless Process Execution**
- Run CLIs in headless mode: `claude -p`, `codex exec`, `gemini <prompt>`
- Use `--output-format json` for structured output parsing
- Process exit = completion. Exit code 0 = success, non-zero = failure
- Parse JSON output for agent response, token usage, session IDs
- This is what the `CompletionDetector` prototype implements

**Secondary (Phase 2): Streaming JSON for Progress**
- Use `stream-json` output for real-time progress monitoring
- Parse streaming events for tool calls, partial results, token usage
- Enables progress reporting in the TUI without waiting for full completion

**Tertiary (Phase 3): Session Resume for Multi-Turn**
- Use `--resume <session_id>` (Claude) / `codex exec resume` for multi-turn workflows
- Enables Ralph Loop pattern: send prompt, get response, evaluate, send follow-up
- Each turn is a separate process invocation (fresh context)

**Fallback: PTY with Quiescence (legacy only)**
- Only for CLIs that lack headless mode
- Combine: output quiescence (no output for N seconds) + prompt regex detection
- Implement as last resort in `CompletionDetector`

### Adapter Changes Required

The current adapters launch interactive PTY sessions. For agentic nodes, they should:
1. Add `AdapterCapabilities.supportsHeadless: boolean`
2. Add `executeHeadless(prompt, options): Promise<HeadlessResult>` to the adapter interface
3. The `AgenticExecutor` calls `executeHeadless()` instead of `startSession()` + `sendInput()`
4. Keep PTY-based `startSession()` for the interactive TUI mode

---

## 7. Blueprint Composition, Templates, Generation, and Self-Improvement

*Research for the next iteration of the blueprint engine*

**Sources**: [Stripe Minions Part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2), [Sitepoint Stripe Analysis](https://www.sitepoint.com/stripe-minions-architecture-explained/), [Goose Recipe Cookbook Generator](https://block.github.io/goose/blog/2025/10/08/recipe-cookbook-generator/), [Goose Subagent Recipes](https://gist.github.com/mootrichard/8a2e4bf200e750f54bebfc78bbe4601f), [Self-Improving Agents (Addy Osmani)](https://addyosmani.com/blog/self-improving-agents/), [OpenAI Self-Evolving Agents Cookbook](https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining), [LangGraph Orchestration](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-ai-framework-2025-complete-architecture-guide-multi-agent-orchestration-analysis), [AgentFlow (Stanford)](https://agentflow.stanford.edu/), [Microsoft Agent Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)

### 7.1 Blueprint Composition (Sub-Blueprints)

#### How Others Handle It

**Stripe Minions**: No evidence of inter-blueprint references or nested composition. Blueprints are standalone state machines. Individual teams create specialized blueprints but there's no documented mechanism for one blueprint to invoke another.

**LangGraph**: Uses **subgraphs** for composition. Related agents are grouped into reusable components (e.g., a "document processing" subgraph with extraction, formatting, classification nodes). Subgraphs execute concurrently via explicit fork/join nodes, with data dependencies controlling ordering. The Orchestrator-Worker pattern uses a `Send` API to dynamically spawn worker subgraphs with specific inputs, each with own state, all writing to a shared state key.

**Goose Recipes**: Support **sub-recipes** for composition. "Generate subrecipes when workflows share common patterns." Sub-recipes inherit the parent's parameters and execute sequentially.

#### Recommendation for Aladeen

Implement a `SubBlueprintNode` -- a new node kind that references another blueprint by ID:

```typescript
interface SubBlueprintNode extends NodeBase {
  kind: 'sub-blueprint';
  blueprintId: string;        // Reference to another blueprint
  inputMapping: Record<string, string>;  // Map parent store keys -> child context.store keys
  outputMapping: Record<string, string>; // Map child result keys -> parent store keys
}
```

**Design rules**:
- Sub-blueprints get their own execution state (isolation)
- Max nesting depth of 3 (prevent infinite recursion)
- Parent waits for child to complete before advancing
- Child inherits parent's `cwd` and `env` unless overridden
- Cycle detection: a blueprint cannot reference itself (directly or transitively)

### 7.2 Blueprint Templates with Variables

#### How Others Handle It

**Goose Recipes**: Uses **minijinja templating** in YAML:
```yaml
parameters:
  - key: feature_description
    description: What feature to implement
    input_type: string
    requirement: required
  - key: target_files
    description: Files to modify
    input_type: string
    requirement: optional
    default: ""

prompt: |
  Implement: {{ feature_description }}
  {% if target_files %}Focus on: {{ target_files }}{% endif %}
```

Parameters declare type, requirement level, defaults, and descriptions. Variables use `{{ var }}` syntax with `{% if %}` conditionals.

**Stripe**: Blueprint customization is at the team level ("individual teams can set up blueprints optimized for their specialized needs") but template variables are not documented in the public blog posts.

**Codex AGENTS.md**: Uses directory-scoped context files rather than template variables. Context is assembled from the filesystem, not from parameterized templates.

#### Recommendation for Aladeen

Add a template layer that resolves variables before validation:

1. **Blueprint JSON uses `{{variable}}` placeholders** in string fields (prompts, file paths, git params)
2. **Blueprint definition includes a `parameters` section**:
```json
{
  "parameters": {
    "feature_description": { "type": "string", "required": true },
    "target_files": { "type": "string", "required": false, "default": "" },
    "branch_name": { "type": "string", "required": false, "default": "feature/auto" }
  }
}
```
3. **Resolution happens before Zod validation**: template engine replaces `{{var}}` with values, then the resolved JSON is validated against `BlueprintSchema`
4. **Use simple mustache-style substitution** (not a full template engine) -- `{{var}}` replacement is sufficient. Conditionals are overkill for JSON blueprints; use default values instead

This keeps blueprints as valid JSON (not YAML with logic), while enabling reuse. A single `implement-feature` blueprint can handle any feature description.

### 7.3 Blueprint Generation (Meta-Orchestration)

#### The Concept

An "architect agent" analyzes a high-level task (e.g., "add OAuth login") and generates a custom blueprint for a "builder agent" to execute. This is the meta-orchestration layer -- the system designs its own workflows.

#### How Others Approach It

**LangGraph Orchestrator-Worker**: A central coordinator receives tasks, decomposes them into subtasks, and dynamically spawns worker nodes. The coordinator maintains global state and makes routing decisions. This is close to blueprint generation but operates at runtime, not as a persisted artifact.

**Stripe Context Assembly**: Before an agent activates, a deterministic pipeline scans the prompt for links/keywords, finds relevant documentation, and curates a "surgical subset of ~15 relevant tools." The system selects which tools/context to provide, but does not generate new workflows.

**AgentFlow (Stanford)**: Coordinates four modules (planner, executor, verifier, generator) through evolving memory. The planner produces structured plans that the executor follows, and the verifier evaluates results. This is the closest to meta-orchestration -- the planner IS generating a workflow.

**72% of enterprise AI projects** now use multi-agent architectures (up from 23% in 2024), with orchestrator-worker being the dominant pattern.

#### Recommendation for Aladeen

Implement in two phases:

**Phase 1: Blueprint Selection** (simpler, implement first)
- Maintain a library of blueprint templates (e.g., `implement-feature`, `fix-bug`, `refactor`, `add-tests`)
- A deterministic classifier (or simple LLM call) maps a task description to the best template
- Template variables are populated from the task description
- No new blueprints generated -- just selection + parameterization

**Phase 2: Blueprint Generation** (ambitious, implement later)
- An agentic "architect" node analyzes the task and codebase
- Outputs a blueprint JSON (nodes, edges, context) as structured output
- The generated blueprint is validated against `BlueprintSchema` before execution
- Use `claude -p --json-schema <BlueprintSchema>` to get schema-validated output
- The architect agent's prompt includes examples of good blueprints as few-shot context
- Generated blueprints are persisted for audit and potential reuse

**Key constraint**: Generated blueprints must pass the same validation as hand-written ones. The `validate()` function is the safety gate.

### 7.4 Learning from Runs

#### What the Research Shows

**OpenAI Self-Evolving Agents** (4-stage loop):
1. Baseline agent executes tasks
2. Feedback collected (human reviewers or LLM-as-judge)
3. Structured eval scores aggregated
4. Metaprompt agent generates improved instructions from failure patterns

The metaprompt agent gets: original prompt + failing output + grader reasoning, then generates improved prompt versions with metadata tracking (timestamps, eval IDs, performance metrics). Version tracking enables rollback if regressions occur.

**Self-Improving Coding Agents** (Addy Osmani):
- AGENTS.md as persistent knowledge base: Patterns/Conventions, Gotchas, Preferences, Recent Learnings
- Four memory channels: git history, progress logs, task state, semantic knowledge
- Failures are learning signals: "if tests fail after 3 tries, output reasoning on why"
- Stop conditions: max iterations, time thresholds, idle detection (no commits in N iterations)
- Drift prevention: periodic fresh starts to combat tunnel vision

**AgentFlow** (Stanford): Planner/executor/verifier/generator with evolving memory. Broadcasts trajectory-level outcomes to align local decisions with global success.

**Concrete metrics reported**:
- 36.9% decrease in average tokens per evaluation through optimization
- 75% grader pass rate or 85% average score as lenient thresholds
- 3 retry attempts per section before human alert

#### Recommendation for Aladeen

Build a `RunAnalytics` system that collects and learns from execution data:

**Phase 1: Metrics Collection** (implement now)
```typescript
interface RunMetrics {
  blueprintId: string;
  runId: string;
  timestamp: string;
  totalDurationMs: number;
  nodeMetrics: Record<string, {
    durationMs: number;
    attempts: number;
    outcome: NodeOutcome;
    tokenUsage?: { input: number; output: number };
    adapterId?: string;
  }>;
  totalTokens: { input: number; output: number };
  overallOutcome: 'completed' | 'failed' | 'escalated';
}
```
Store as append-only JSONL in `.aladeen/runs/`. This is cheap and gives us the data for everything else.

**Phase 2: Failure Pattern Detection** (implement next)
- Aggregate per-node failure rates across runs: "fix-lint fails 40% of the time"
- Identify common failure sequences: "lint -> fix-lint -> lint -> fix-lint -> escalation"
- Detect adapter-specific issues: "codex fails on TypeScript tasks 3x more than claude"
- Flag blueprints that consistently exceed retry budgets

**Phase 3: Prompt Optimization** (implement later)
- For nodes with high failure rates, use a metaprompt agent to generate improved prompts
- A/B test: run original prompt vs. improved prompt on same task type
- Track prompt versions with performance metadata
- Keep version history for rollback

**Phase 4: Blueprint Optimization** (aspirational)
- Auto-suggest adding deterministic verification nodes where agentic nodes frequently fail
- Recommend timeout adjustments based on actual duration distributions
- Suggest retry budget reallocation (move retries from nodes that rarely need them to nodes that do)

### Cross-Cutting Design Principle

All four features share a common insight: **blueprints should be data, not code**. JSON blueprints can be:
- **Composed** (sub-blueprint references)
- **Parameterized** (template variables)
- **Generated** (by architect agents)
- **Analyzed** (by analytics pipelines)
- **Versioned** (in git, with diffs)

This is the same insight that makes Stripe's system work: "the model does not run the system; the system runs the model." Blueprints ARE the system.
