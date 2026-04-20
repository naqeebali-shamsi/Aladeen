# Graph Report - .  (2026-04-20)

## Corpus Check
- Corpus is ~30,961 words - fits in a single context window. You may not need a graph.

## Summary
- 326 nodes · 399 edges · 34 communities detected
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 20 edges (avg confidence: 0.82)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Routing & Eval Contracts|Routing & Eval Contracts]]
- [[_COMMUNITY_Blueprint Engine Core|Blueprint Engine Core]]
- [[_COMMUNITY_Provider Adapter Sessions|Provider Adapter Sessions]]
- [[_COMMUNITY_Cleanup SOP Audit Workflow|Cleanup SOP Audit Workflow]]
- [[_COMMUNITY_Verifier Composition|Verifier Composition]]
- [[_COMMUNITY_Agentic Executor Implementation|Agentic Executor Implementation]]
- [[_COMMUNITY_Multi-CLI Orchestration PRD|Multi-CLI Orchestration PRD]]
- [[_COMMUNITY_Blueprint Runner State Machine|Blueprint Runner State Machine]]
- [[_COMMUNITY_Worktree Isolation|Worktree Isolation]]
- [[_COMMUNITY_Cleanup SOP Pre-Flight & Constraints|Cleanup SOP Pre-Flight & Constraints]]
- [[_COMMUNITY_Deterministic Executor|Deterministic Executor]]
- [[_COMMUNITY_Blueprint Composition Roadmap|Blueprint Composition Roadmap]]
- [[_COMMUNITY_Headless Run Script|Headless Run Script]]
- [[_COMMUNITY_TUI App|TUI App]]
- [[_COMMUNITY_Local-First V1 + Narrative|Local-First V1 + Narrative]]
- [[_COMMUNITY_Local Context Assembler|Local Context Assembler]]
- [[_COMMUNITY_PTY Runtime Layer|PTY Runtime Layer]]
- [[_COMMUNITY_Architecture Principles|Architecture Principles]]
- [[_COMMUNITY_SOP Maintenance Cadence|SOP Maintenance Cadence]]
- [[_COMMUNITY_Implement-Feature Blueprint Factory|Implement-Feature Blueprint Factory]]
- [[_COMMUNITY_Agentic Coding Ecosystem (DevinOpenHandsSWE)|Agentic Coding Ecosystem (Devin/OpenHands/SWE)]]
- [[_COMMUNITY_SOP Acceptance Criteria|SOP Acceptance Criteria]]
- [[_COMMUNITY_SOP Rationale|SOP Rationale]]
- [[_COMMUNITY_PluginHook Decision Order|Plugin/Hook Decision Order]]
- [[_COMMUNITY_Blueprint TUI View|Blueprint TUI View]]
- [[_COMMUNITY_Telemetry Milestone|Telemetry Milestone]]
- [[_COMMUNITY_Hook Catalog|Hook Catalog]]
- [[_COMMUNITY_Environment Inventory|Environment Inventory]]
- [[_COMMUNITY_Vitest Config|Vitest Config]]
- [[_COMMUNITY_TUI Index|TUI Index]]
- [[_COMMUNITY_Engine Index|Engine Index]]
- [[_COMMUNITY_Verifier Index|Verifier Index]]
- [[_COMMUNITY_Adapter Index|Adapter Index]]
- [[_COMMUNITY_Stabilization Milestone|Stabilization Milestone]]

## God Nodes (most connected - your core abstractions)
1. `BlueprintRunner` - 14 edges
2. `WorktreeManager` - 11 edges
3. `Aladeen: Multi-CLI Orchestration PRD` - 11 edges
4. `Blueprint Engine` - 10 edges
5. `DeterministicExecutor` - 8 edges
6. `Target Architecture Template` - 8 edges
7. `QuiescenceDetector` - 6 edges
8. `Audit Plan Command Prompt (Dry Run)` - 6 edges
9. `ClaudeAdapter` - 5 edges
10. `CodexAdapter` - 5 edges

## Surprising Connections (you probably didn't know these)
- `Bounded Iteration & Escalation` --semantically_similar_to--> `Policy Defaults (retries, duration)`  [INFERRED] [semantically similar]
  BLUEPRINT_DESIGN.md → LOCAL_FIRST_AUTONOMY_SPEC.md
- `FR-6 Policy Engine` --semantically_similar_to--> `Policy Defaults (retries, duration)`  [INFERRED] [semantically similar]
  PRD.md → LOCAL_FIRST_AUTONOMY_SPEC.md
- `Rationale: Industry Has Moved Past PTY` --rationale_for--> `AgenticExecutor`  [INFERRED]
  RESEARCH_FINDINGS.md → BLUEPRINT_DESIGN.md
- `Verifier Contract (typecheck/lint/tests)` --conceptually_related_to--> `DeterministicNode`  [INFERRED]
  LOCAL_FIRST_AUTONOMY_SPEC.md → BLUEPRINT_DESIGN.md
- `Ralph Loop Pattern` --rationale_for--> `AgenticExecutor`  [INFERRED]
  RESEARCH_FINDINGS.md → BLUEPRINT_DESIGN.md

## Hyperedges (group relationships)
- **Local-First V1 Autonomous Pipeline** — local_first_spec_runtime_arch, local_first_spec_verifier_contract, local_first_spec_model_tiering, local_first_spec_policy_defaults, local_first_spec_cli_surface [EXTRACTED 0.95]
- **Blueprint Engine Execution Core** — blueprint_design_dag_walker, blueprint_design_deterministic_executor, blueprint_design_agentic_executor, blueprint_design_state_persistence [EXTRACTED 0.95]
- **Multi-CLI Adapter Triad** — prd_claude_code, prd_gemini_cli, prd_codex_cli, prd_fr1_adapter_layer [EXTRACTED 0.95]
- **Cleanup Output Documents Trio** — template_setup_audit, template_capability_map, template_target_architecture, template_migration_plan [EXTRACTED 1.00]
- **Apply Phase Output Documents** — template_final_state, template_decision_log, template_rollback_guide [EXTRACTED 1.00]
- **Six-Layer Target Architecture** — template_layer_a_global, template_layer_b_reusable, template_layer_c_project, template_layer_d_local, template_layer_e_settings, template_layer_f_skills [EXTRACTED 1.00]

## Communities

### Community 0 - "Routing & Eval Contracts"
Cohesion: 0.07
Nodes (13): NoopContextAssembler, NoopEvaluatorScorer, StaticModelRouter, createLocalFirstRunnerOptions(), envModel(), HeuristicEvaluatorScorer, StubExecutor, StatePersistence (+5 more)

### Community 1 - "Blueprint Engine Core"
Cohesion: 0.07
Nodes (38): AgenticExecutor, AgenticNode, Blueprint Engine, Bounded Iteration & Escalation, BlueprintContext Scoping, DAG Walker Algorithm, DeterministicExecutor, DeterministicNode (+30 more)

### Community 2 - "Provider Adapter Sessions"
Cohesion: 0.08
Nodes (4): ClaudeAdapter, CodexAdapter, GeminiAdapter, AdapterRegistry

### Community 3 - "Cleanup SOP Audit Workflow"
Cohesion: 0.1
Nodes (28): Audit Apply Command Prompt, Audit Plan Command Prompt (Dry Run), First-Time Cleanup Flow, @ File Reference Syntax, MCP Scoping Rules (user/project/local), Seven Output Documents, paths: Frontmatter for Conditional Rules, Phase B: Baseline Health Check (+20 more)

### Community 4 - "Verifier Composition"
Cohesion: 0.09
Nodes (5): CompositeVerifier, DiffVerifier, GitVerifier, LintVerifier, TestVerifier

### Community 5 - "Agentic Executor Implementation"
Cohesion: 0.13
Nodes (5): AgenticExecutor, injectContext(), resolveTemplate(), CompletionDetector, QuiescenceDetector

### Community 6 - "Multi-CLI Orchestration PRD"
Cohesion: 0.15
Nodes (17): IProviderAdapter, Aladeen: Multi-CLI Orchestration PRD, Claude Code CLI, Codex CLI, FR-1 Provider Adapter Layer, FR-2 Preflight Diagnostics, FR-4 Output Normalization, FR-5 TUI Workspace (+9 more)

### Community 7 - "Blueprint Runner State Machine"
Cohesion: 0.26
Nodes (1): BlueprintRunner

### Community 8 - "Worktree Isolation"
Cohesion: 0.32
Nodes (2): WorktreeError, WorktreeManager

### Community 9 - "Cleanup SOP Pre-Flight & Constraints"
Cohesion: 0.15
Nodes (13): Pre-Flight Backup Checks, Tool Ownership Checks, Cleanup SOP is a Process Not a Plugin, Apply Mode Constraints, Six Candidate Evaluation Questions, Reintroduction Review Prompt, Always Back Up First Tip, Kit File Structure (+5 more)

### Community 10 - "Deterministic Executor"
Cohesion: 0.46
Nodes (1): DeterministicExecutor

### Community 11 - "Blueprint Composition Roadmap"
Cohesion: 0.32
Nodes (8): AgentFlow (Stanford), Blueprint Composition (Sub-Blueprints), Blueprint Generation (Architect Agent), Blueprint Templates with Variables, Rationale: Blueprints Should Be Data, Not Code, Goose Recipes (YAML), LangGraph Orchestrator-Worker, Learning from Runs (Metaprompt / RunAnalytics)

### Community 12 - "Headless Run Script"
Cohesion: 0.48
Nodes (4): cleanup(), log(), main(), patchForWorktree()

### Community 13 - "TUI App"
Cohesion: 0.43
Nodes (4): broadcastCommand(), logMessage(), sendCommand(), startSession()

### Community 14 - "Local-First V1 + Narrative"
Cohesion: 0.29
Nodes (7): Ground Rules Workflow, LinkedIn Narrative Pillars, LinkedIn Positioning: Applied AI Engineer, 4-Week Publishing Arc, Local-First V1 Goal, Local-First Guarantees, V1 Local-First Addendum

### Community 15 - "Local Context Assembler"
Cohesion: 0.47
Nodes (1): LocalContextAssembler

### Community 16 - "PTY Runtime Layer"
Cohesion: 0.4
Nodes (1): PtyRuntime

### Community 17 - "Architecture Principles"
Cohesion: 0.5
Nodes (4): Plan Mode Principles, Core Principle: Justify Against Primitives, Eight Design Principles, Official Claude Code Architecture Baseline

### Community 18 - "SOP Maintenance Cadence"
Cohesion: 0.5
Nodes (4): One-Page Monthly Checklist, Monthly Maintenance 5 Minutes, Kit Workflow Diagram, Maintenance Schedule

### Community 19 - "Implement-Feature Blueprint Factory"
Cohesion: 1.0
Nodes (2): createImplementFeatureBlueprint(), createImplementFeatureLocalBlueprint()

### Community 20 - "Agentic Coding Ecosystem (Devin/OpenHands/SWE)"
Cohesion: 0.67
Nodes (3): Devin AI, OpenHands (CodeAct), SWE-Agent

### Community 21 - "SOP Acceptance Criteria"
Cohesion: 0.67
Nodes (3): Expected Cleanup Results, Acceptance Criteria Checklist, Verification Results Section

### Community 22 - "SOP Rationale"
Cohesion: 0.67
Nodes (3): No Automatic Cleanup Rationale, SOP Purpose: Deliberate Environment, When to Run the SOP

### Community 23 - "Plugin/Hook Decision Order"
Cohesion: 0.67
Nodes (3): Seven Decision Options, Decision Priority Order, Phase G: Normalize Plugins, Skills, MCP, Frameworks

### Community 24 - "Blueprint TUI View"
Cohesion: 1.0
Nodes (0): 

### Community 25 - "Telemetry Milestone"
Cohesion: 1.0
Nodes (2): Telemetry Contract (Langfuse-compatible), Milestone 4: Observability & Learning

### Community 26 - "Hook Catalog"
Cohesion: 1.0
Nodes (2): Supported Hook Events Catalog, Phase E: Normalize Hooks

### Community 27 - "Environment Inventory"
Cohesion: 1.0
Nodes (2): Inputs to Gather Before Starting, Environment Snapshot Inventory

### Community 28 - "Vitest Config"
Cohesion: 1.0
Nodes (0): 

### Community 29 - "TUI Index"
Cohesion: 1.0
Nodes (0): 

### Community 30 - "Engine Index"
Cohesion: 1.0
Nodes (0): 

### Community 31 - "Verifier Index"
Cohesion: 1.0
Nodes (0): 

### Community 32 - "Adapter Index"
Cohesion: 1.0
Nodes (0): 

### Community 33 - "Stabilization Milestone"
Cohesion: 1.0
Nodes (1): Milestone 5: Stabilization

## Knowledge Gaps
- **50 isolated node(s):** `BlueprintContext Scoping`, `ESLint flat config`, `Vitest smoke test`, `Ground Rules Workflow`, `4-Week Publishing Arc` (+45 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Blueprint TUI View`** (2 nodes): `execute()`, `BlueprintView.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Telemetry Milestone`** (2 nodes): `Telemetry Contract (Langfuse-compatible)`, `Milestone 4: Observability & Learning`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Hook Catalog`** (2 nodes): `Supported Hook Events Catalog`, `Phase E: Normalize Hooks`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Environment Inventory`** (2 nodes): `Inputs to Gather Before Starting`, `Environment Snapshot Inventory`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Vitest Config`** (1 nodes): `vitest.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `TUI Index`** (1 nodes): `index.tsx`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Engine Index`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Verifier Index`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Adapter Index`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Stabilization Milestone`** (1 nodes): `Milestone 5: Stabilization`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `BlueprintRunner` connect `Blueprint Runner State Machine` to `Routing & Eval Contracts`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **What connects `BlueprintContext Scoping`, `ESLint flat config`, `Vitest smoke test` to the rest of the system?**
  _50 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Routing & Eval Contracts` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `Blueprint Engine Core` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `Provider Adapter Sessions` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Cleanup SOP Audit Workflow` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Verifier Composition` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._