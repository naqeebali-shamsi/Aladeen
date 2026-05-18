---
name: blueprint-author
description: Scaffold a new Aladeen blueprint JSON (DAG of deterministic + agentic nodes) with retry edges, store templating, and worktree lifecycle. Use when the user asks to "create a blueprint", "add a blueprint", or wants a new orchestration for the engine.
---

# Blueprint Author

Generate a new blueprint JSON under `blueprints/` that passes `validateBlueprint` and respects the runtime's edge-following semantics.

## Hard rules (these are the foot-guns)

1. **Runner is edge-following, NOT topological-sort.** Failure → fix → failure loops are valid and bounded by `maxRetries` on the agentic node and `maxTotalRetries` on the blueprint.
2. **SUCCESS-only subgraph must be acyclic.** Retry/failure edges can form cycles (e.g. `lint → fix-lint → lint`). Success edges may NOT.
3. **Every node must be reachable** from `entryNodeId`. Unreachable nodes fail validation.
4. **At least one terminal node** (a node with no outgoing `on: success` or default edge) must exist.
5. **Agentic nodes that mutate the repo MUST set `requiresFileChanges: true`.** Without it, a chatty agent that asks for clarification will be marked successful. (See commit `5d884a2`.)
6. **Worktree blueprints must `npm install` before lint/test nodes.** `git worktree add` doesn't copy `node_modules` — skipping this triggers a retry loop. (See run `690cbbfe-...`, memory.)
7. **Use `{{store.key}}` templating** to pipe lint/test stderr into the next agent's prompt. The store flows forward.

## File layout

Write JSON to `blueprints/<id>.json`. Match the shape in `src/engine/types.ts` (`BlueprintSchema`).

## Reference skeleton

```json
{
  "id": "example-feature",
  "name": "Example feature blueprint",
  "version": "1.0.0",
  "entryNodeId": "worktree-add",
  "maxTotalRetries": 6,
  "maxDurationMs": 1800000,
  "defaultContext": {
    "cwd": "{{repoRoot}}",
    "env": {},
    "ruleFiles": [],
    "allowedTools": [],
    "store": {}
  },
  "nodes": [
    {
      "id": "worktree-add",
      "label": "Create isolated worktree",
      "kind": "deterministic",
      "op": { "type": "git", "action": "worktree_add", "params": { "branch": "{{taskId}}", "base": "{{baseBranch}}" } }
    },
    {
      "id": "npm-install",
      "label": "Install deps in worktree",
      "kind": "deterministic",
      "op": { "type": "shell", "command": "npm", "args": ["install"] }
    },
    {
      "id": "implement",
      "label": "Agent implements feature",
      "kind": "agentic",
      "adapterId": "{{adapterId}}",
      "prompt": "{{prompt}}",
      "maxRetries": 2,
      "requiresFileChanges": true,
      "contextOverrides": { "allowedTools": ["Read", "Edit", "Write", "Bash"] }
    },
    {
      "id": "lint",
      "label": "Lint changed files",
      "kind": "deterministic",
      "op": { "type": "shell", "command": "npm", "args": ["run", "lint"] }
    },
    {
      "id": "fix-lint",
      "label": "Agent fixes lint failures",
      "kind": "agentic",
      "adapterId": "{{adapterId}}",
      "prompt": "Lint failed. Fix the violations below and re-run.\n\n{{store.lintStderr}}",
      "maxRetries": 2,
      "requiresFileChanges": true
    },
    {
      "id": "commit",
      "label": "Commit + push branch",
      "kind": "deterministic",
      "op": { "type": "git", "action": "commit", "params": { "message": "feat: {{taskId}}" } }
    },
    {
      "id": "worktree-remove",
      "label": "Clean up worktree",
      "kind": "deterministic",
      "op": { "type": "git", "action": "worktree_remove", "params": { "force": "true" } }
    }
  ],
  "edges": [
    { "from": "worktree-add", "to": "npm-install" },
    { "from": "npm-install",  "to": "implement" },
    { "from": "implement",    "to": "lint", "on": "success" },
    { "from": "lint",         "to": "commit", "on": "success" },
    { "from": "lint",         "to": "fix-lint", "on": "failure" },
    { "from": "fix-lint",     "to": "lint", "on": "success" },
    { "from": "commit",       "to": "worktree-remove" }
  ]
}
```

## Self-check before finishing

After writing the file, run:

```bash
npx tsx -e "import { validateBlueprint } from './src/engine/validate.js'; import bp from './blueprints/<id>.json' assert { type: 'json' }; console.log(validateBlueprint(bp));"
```

If `valid: false`, fix the errors before reporting back. Then ask the user whether to invoke `blueprint-validator` (subagent) for a semantic review.
