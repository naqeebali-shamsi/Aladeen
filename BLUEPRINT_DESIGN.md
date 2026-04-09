# Blueprint Engine - Architecture Design

## Overview

The Blueprint Engine is Aladeen's orchestration core. A **Blueprint** is a directed acyclic graph (DAG) that mixes **deterministic nodes** (shell commands, git ops, file ops) with **agentic nodes** (LLM-backed provider adapters). This design is inspired by Stripe's Minions system, adapted to run on top of Aladeen's existing provider adapter pattern.

## Core Concepts

### Nodes

Every node in a Blueprint is either **deterministic** or **agentic**.

| Property | Deterministic | Agentic |
|---|---|---|
| Executor | Shell/git/file operations | Provider adapter (Claude, Gemini, Codex) |
| Outcome | Exit code | Evaluator function or adapter signal |
| Retries | None (fail-fast) | Bounded (default max 2) |
| Cost | Near-zero | LLM API call(s) |

**DeterministicNode** runs predictable operations:
- `shell` - execute a command (e.g., `npm run lint`, `npm test`)
- `git` - git operations (branch, checkout, commit, push, worktree management)
- `file` - read/write/copy/delete files

**AgenticNode** delegates to a provider adapter:
- References an adapter by `adapterId` (matching `IProviderAdapter.id`)
- Includes a `prompt` describing the task
- Has `maxRetries` (default 2) before escalation
- Optional `evaluator` to judge output quality

### Edges

Edges connect nodes with typed transitions:
- `on: 'success'` - follow when node succeeds
- `on: 'failure'` - follow when node fails (enables error-handling paths)
- `on: 'retry'` - follow on retry (typically loops back to a fix node)
- `on: undefined` - default/unconditional edge

This enables patterns like: lint fails -> agent fixes -> lint retries.

### Context Scoping

Each node receives a `BlueprintContext`:
- **cwd** - working directory (can be a git worktree for isolation)
- **env** - environment variables
- **ruleFiles** - paths to instruction/rule files the agent should read
- **allowedTools** - tool whitelist (empty = all allowed)
- **store** - key-value store for passing data between nodes

The blueprint has a `defaultContext` that applies to all nodes. Individual nodes can override specific fields via `contextOverrides`. The runner merges them at execution time.

## Execution Model

### DAG Walker Algorithm

```
1. Initialize ExecutionState with all nodes set to 'pending'
2. Set currentNodeId = entryNodeId
3. Loop:
   a. Resolve context: merge defaultContext + node.contextOverrides
   b. Select executor (DeterministicExecutor or AgenticExecutor)
   c. Execute node, producing a NodeResult
   d. Update NodeExecution record (status, result, attempts)
   e. If agentic node returned 'retry' and attempts < maxRetries:
      - Increment totalRetries
      - If totalRetries > maxTotalRetries → escalate
      - Re-execute the same node
   f. Find outgoing edges matching the result's outcome
   g. If no matching edge → run is complete (success or failure based on last outcome)
   h. Set currentNodeId = edge.to, continue loop
```

The walker is intentionally single-threaded per blueprint run. Parallelism happens at the blueprint level (multiple blueprints in separate worktrees), not within a single blueprint.

### Node Executors

The runner uses the **Strategy pattern** via `INodeExecutor`:

**DeterministicExecutor:**
- `shell` ops: spawn child process, capture stdout/stderr, map exit code to outcome
- `git` ops: execute git commands with structured params
- `file` ops: use Node.js fs APIs directly

**AgenticExecutor:**
- Looks up the provider adapter by `adapterId` from the adapter registry
- Calls `adapter.preflight()` to verify readiness
- Calls `adapter.startSession()` with the scoped context
- Sends the node's `prompt` via `adapter.sendInput()`
- Monitors `SessionEvent` stream for completion
- Runs the evaluator (if any) against the output
- Returns NodeResult based on evaluation

This directly builds on the existing `IProviderAdapter` interface and `BaseProviderAdapter` - no changes needed to the adapter layer.

## State Persistence and Crash Recovery

### Persistence Format

`ExecutionState` is serialized to JSON and written to:
```
{cwd}/.aladeen/runs/{runId}/state.json
```

The state file is updated after every node completion. This gives crash recovery with node-level granularity.

### Recovery Protocol

1. Load `state.json` from disk
2. Validate with `ExecutionStateSchema` (Zod)
3. Call `runner.resume(state, blueprint)`
4. The runner skips all nodes marked `completed` or `skipped`
5. Re-executes the `currentNodeId` (the node that was running when the crash happened)
6. Continues normal DAG walking from there

Node results in `store` are preserved, so recovered runs don't lose inter-node data.

## Bounded Iteration and Escalation

Inspired by Stripe's "max 2 CI cycles" rule:

- Each `AgenticNode` has `maxRetries` (default 2)
- The `Blueprint` has `maxTotalRetries` (global budget across all nodes)
- The `Blueprint` has `maxDurationMs` (wall-clock timeout)

**Escalation triggers:**
1. An agentic node exceeds its `maxRetries`
2. Total retries across all nodes exceed `maxTotalRetries`
3. Wall-clock time exceeds `maxDurationMs`
4. An unrecoverable failure on a node with no failure edge

When escalated, the run status becomes `'escalated'`, the `escalationReason` is set, and the `onEscalation` hook fires. The TUI can then prompt the human for intervention.

## Adapter Integration

The existing adapter system slots in cleanly:

```
Blueprint Engine (new)
  └── AgenticExecutor (new)
        └── IProviderAdapter (existing)
              ├── ClaudeAdapter
              ├── GeminiAdapter
              └── CodexAdapter
```

The `AgenticExecutor` is the bridge. It:
1. Receives an `AgenticNode` with an `adapterId`
2. Looks up the adapter from a registry (the existing `src/adapters/index.ts` barrel)
3. Uses the adapter's PTY-based session to run the agent
4. Translates `SessionEvent` stream into a `NodeResult`

No changes to the adapter interfaces are required. The engine is a new layer on top.

## Example Blueprint: Implement and Verify

```typescript
const implementFeature: Blueprint = {
  id: 'implement-feature',
  name: 'Implement and Verify a Code Change',
  version: '1.0.0',
  entryNodeId: 'create-branch',
  defaultContext: {
    cwd: '/path/to/repo',
    env: {},
    ruleFiles: [],
    allowedTools: [],
    store: {},
  },
  nodes: [
    {
      id: 'create-branch',
      label: 'Create feature branch',
      kind: 'deterministic',
      op: { type: 'git', action: 'branch', params: { name: 'feat/{{feature}}' } },
    },
    {
      id: 'implement',
      label: 'Implement the feature',
      kind: 'agentic',
      adapterId: 'claude',
      prompt: 'Implement the following feature: {{description}}',
      maxRetries: 2,
    },
    {
      id: 'lint',
      label: 'Run linter',
      kind: 'deterministic',
      op: { type: 'shell', command: 'npm', args: ['run', 'lint'] },
    },
    {
      id: 'test',
      label: 'Run tests',
      kind: 'deterministic',
      op: { type: 'shell', command: 'npm', args: ['test'] },
    },
    {
      id: 'fix-lint',
      label: 'Fix lint errors',
      kind: 'agentic',
      adapterId: 'claude',
      prompt: 'Fix the following lint errors:\n{{store.lint_errors}}',
      maxRetries: 1,
    },
    {
      id: 'fix-tests',
      label: 'Fix failing tests',
      kind: 'agentic',
      adapterId: 'claude',
      prompt: 'Fix the following test failures:\n{{store.test_errors}}',
      maxRetries: 1,
    },
    {
      id: 'commit',
      label: 'Commit changes',
      kind: 'deterministic',
      op: { type: 'git', action: 'commit', params: { message: 'feat: {{feature}}' } },
    },
  ],
  edges: [
    { from: 'create-branch', to: 'implement', on: 'success' },
    { from: 'implement', to: 'lint', on: 'success' },
    { from: 'lint', to: 'test', on: 'success' },
    { from: 'lint', to: 'fix-lint', on: 'failure' },
    { from: 'fix-lint', to: 'lint', on: 'success' },
    { from: 'test', to: 'commit', on: 'success' },
    { from: 'test', to: 'fix-tests', on: 'failure' },
    { from: 'fix-tests', to: 'test', on: 'success' },
  ],
  maxTotalRetries: 4,
  maxDurationMs: 10 * 60 * 1000, // 10 minutes
};
```

## Implementation Plan

The following order lets the builder implement incrementally, testing each piece in isolation:

### Phase 1: Core Types and Validation
- [x] `src/engine/types.ts` - All interfaces and Zod schemas (this file)
- [ ] `src/engine/validate.ts` - Blueprint validation (DAG cycle detection, node/edge consistency, Zod parse)

### Phase 2: Node Executors
- [ ] `src/engine/executors/deterministic.ts` - Shell, git, and file operation executor
- [ ] `src/engine/executors/agentic.ts` - Provider adapter executor with retry logic
- [ ] `src/engine/executors/index.ts` - Executor registry/factory

### Phase 3: Blueprint Runner
- [ ] `src/engine/runner.ts` - DAG walker, state management, escalation logic
- [ ] `src/engine/state.ts` - State persistence (save/load from `.aladeen/runs/`)

### Phase 4: Integration
- [ ] `src/engine/index.ts` - Public API barrel export
- [ ] Wire into TUI for status display
- [ ] First end-to-end blueprint test

### Key Principle
Each phase produces working, testable code. Phase 1 can be validated with unit tests on schemas. Phase 2 executors can be tested independently. Phase 3 ties it together. Phase 4 integrates with the rest of Aladeen.
