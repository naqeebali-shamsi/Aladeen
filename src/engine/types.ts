import { z } from 'zod';

// ─── Node Result ────────────────────────────────────────────────────────────

export type NodeOutcome = 'success' | 'failure' | 'retry';

export interface NodeResult {
  outcome: NodeOutcome;
  /** Arbitrary output data from the node (stdout, file paths, metrics, etc.) */
  output: Record<string, unknown>;
  /** Human-readable summary of what happened */
  summary?: string;
  /** Error message if outcome is failure or retry */
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
}

export const NodeResultSchema = z.object({
  outcome: z.enum(['success', 'failure', 'retry']),
  output: z.record(z.unknown()),
  summary: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number(),
});

// ─── Blueprint Context ──────────────────────────────────────────────────────

/** Scoped execution context provided to each node. */
export interface BlueprintContext {
  /** Working directory for this node (may be a worktree) */
  cwd: string;
  /** Environment variables merged on top of process.env */
  env: Record<string, string>;
  /** Paths to rule/instruction files the agent should read */
  ruleFiles: string[];
  /** Allowed tool names (empty = all allowed). Only relevant for agentic nodes. */
  allowedTools: string[];
  /** Key-value store for passing data between nodes */
  store: Record<string, unknown>;
}

export const BlueprintContextSchema = z.object({
  cwd: z.string(),
  env: z.record(z.string()),
  ruleFiles: z.array(z.string()),
  allowedTools: z.array(z.string()),
  store: z.record(z.unknown()),
});

// ─── Nodes ──────────────────────────────────────────────────────────────────

/** Common fields shared by all node types. */
interface NodeBase {
  /** Unique node identifier within a blueprint */
  id: string;
  /** Human-readable label for display */
  label: string;
  /** Optional context overrides merged onto the blueprint-level context */
  contextOverrides?: Partial<BlueprintContext>;
  /** Timeout in ms. Node is killed and marked 'failure' after this. */
  timeoutMs?: number;
}

/**
 * A deterministic node runs a shell command, git operation, or file operation.
 * No LLM involved. Outcome is determined solely by exit code / result.
 */
export interface DeterministicNode extends NodeBase {
  kind: 'deterministic';
  /** The operation to perform */
  op:
    | { type: 'shell'; command: string; args?: string[] }
    | { type: 'git'; action: 'checkout' | 'commit' | 'push' | 'branch' | 'worktree_add' | 'worktree_remove'; params: Record<string, string> }
    | { type: 'file'; action: 'read' | 'write' | 'copy' | 'delete'; path: string; content?: string; dest?: string };
  /** Map exit code (or result) to outcome. Default: 0 = success, else failure. */
  exitCodeMap?: Record<number, NodeOutcome>;
}

/**
 * An agentic node delegates work to an LLM-backed provider adapter.
 * It has bounded retries and scoped context.
 */
export interface AgenticNode extends NodeBase {
  kind: 'agentic';
  /** Which provider adapter to use (matches IProviderAdapter.id) */
  adapterId: string;
  /** The prompt/instruction sent to the agent */
  prompt: string;
  /** Maximum retry attempts before escalating (default: 2) */
  maxRetries: number;
  /** Optional: a function name or inline check to evaluate the agent's output */
  evaluator?: string;
}

export type BlueprintNode = DeterministicNode | AgenticNode;

// ─── Zod Schemas for Nodes ──────────────────────────────────────────────────

const NodeBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  contextOverrides: BlueprintContextSchema.partial().optional(),
  timeoutMs: z.number().positive().optional(),
});

export const DeterministicNodeSchema = NodeBaseSchema.extend({
  kind: z.literal('deterministic'),
  op: z.discriminatedUnion('type', [
    z.object({ type: z.literal('shell'), command: z.string(), args: z.array(z.string()).optional() }),
    z.object({ type: z.literal('git'), action: z.enum(['checkout', 'commit', 'push', 'branch', 'worktree_add', 'worktree_remove']), params: z.record(z.string()) }),
    z.object({ type: z.literal('file'), action: z.enum(['read', 'write', 'copy', 'delete']), path: z.string(), content: z.string().optional(), dest: z.string().optional() }),
  ]),
  exitCodeMap: z.record(z.coerce.number(), z.enum(['success', 'failure', 'retry'])).optional(),
});

export const AgenticNodeSchema = NodeBaseSchema.extend({
  kind: z.literal('agentic'),
  adapterId: z.string(),
  prompt: z.string(),
  maxRetries: z.number().int().min(0).default(2),
  evaluator: z.string().optional(),
});

export const BlueprintNodeSchema = z.discriminatedUnion('kind', [
  DeterministicNodeSchema,
  AgenticNodeSchema,
]);

// ─── Edges ──────────────────────────────────────────────────────────────────

/** Typed connection between two nodes. */
export interface Edge {
  /** Source node id */
  from: string;
  /** Target node id */
  to: string;
  /** Which outcome triggers this edge (undefined = any outcome / default path) */
  on?: NodeOutcome;
  /** Optional condition expression evaluated against the source node's output */
  condition?: string;
}

export const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  on: z.enum(['success', 'failure', 'retry']).optional(),
  condition: z.string().optional(),
});

// ─── Blueprint ──────────────────────────────────────────────────────────────

/** A Blueprint is a DAG of deterministic and agentic nodes connected by edges. */
export interface Blueprint {
  /** Unique blueprint identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Version string for the blueprint definition */
  version: string;
  /** All nodes in the graph */
  nodes: BlueprintNode[];
  /** Directed edges connecting nodes */
  edges: Edge[];
  /** The node id where execution begins */
  entryNodeId: string;
  /** Default context applied to all nodes (overridable per-node) */
  defaultContext: BlueprintContext;
  /** Max wall-clock time for the entire blueprint run (ms) */
  maxDurationMs?: number;
  /** Max total agentic retry cycles across all nodes before escalation */
  maxTotalRetries?: number;
}

export const BlueprintSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  version: z.string(),
  nodes: z.array(BlueprintNodeSchema),
  edges: z.array(EdgeSchema),
  entryNodeId: z.string(),
  defaultContext: BlueprintContextSchema,
  maxDurationMs: z.number().positive().optional(),
  maxTotalRetries: z.number().int().min(0).optional(),
});

// ─── Execution State ────────────────────────────────────────────────────────

export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface NodeExecution {
  nodeId: string;
  status: NodeStatus;
  /** Number of times this node has been attempted */
  attempts: number;
  /** Results from each attempt (last = most recent) */
  results: NodeResult[];
  /** ISO timestamp when the node started */
  startedAt?: string;
  /** ISO timestamp when the node finished */
  completedAt?: string;
}

/** Tracks the full state of a blueprint execution run. */
export interface ExecutionState {
  /** Unique run identifier */
  runId: string;
  /** The blueprint being executed */
  blueprintId: string;
  /** Overall status */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'escalated';
  /** Per-node execution tracking */
  nodeExecutions: Record<string, NodeExecution>;
  /** The node currently being executed (null if done) */
  currentNodeId: string | null;
  /** Accumulated retry count across all agentic nodes */
  totalRetries: number;
  /** The resolved context (merged default + overrides) */
  context: BlueprintContext;
  /** ISO timestamp when the run started */
  startedAt: string;
  /** ISO timestamp when the run finished */
  completedAt?: string;
  /** If escalated, the reason */
  escalationReason?: string;
  /** Optional run policy metadata (local-only mode, budgets). */
  runPolicy?: RunPolicy;
  /** Optional quality snapshots (verifier + evaluator outcomes). */
  quality?: QualitySnapshot;
}

export interface RunPolicy {
  mode: 'local-only' | 'hybrid' | 'cloud';
  cloudFallbackAllowed: boolean;
  maxRunDurationMs?: number;
  maxTotalRetries?: number;
}

export interface QualitySnapshot {
  gateOrder?: string[];
  gateOutcomes?: Record<string, NodeOutcome>;
  evaluatorOverall?: number;
}

export const ExecutionStateSchema = z.object({
  runId: z.string(),
  blueprintId: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'escalated']),
  nodeExecutions: z.record(z.object({
    nodeId: z.string(),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
    attempts: z.number(),
    results: z.array(NodeResultSchema),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
  })),
  currentNodeId: z.string().nullable(),
  totalRetries: z.number(),
  context: BlueprintContextSchema,
  startedAt: z.string(),
  completedAt: z.string().optional(),
  escalationReason: z.string().optional(),
  runPolicy: z.object({
    mode: z.enum(['local-only', 'hybrid', 'cloud']),
    cloudFallbackAllowed: z.boolean(),
    maxRunDurationMs: z.number().optional(),
    maxTotalRetries: z.number().optional(),
  }).optional(),
  quality: z.object({
    gateOrder: z.array(z.string()).optional(),
    gateOutcomes: z.record(z.enum(['success', 'failure', 'retry'])).optional(),
    evaluatorOverall: z.number().optional(),
  }).optional(),
});

// ─── Runner Interface ───────────────────────────────────────────────────────

/** Interface for the blueprint execution engine. */
export interface IBlueprintRunner {
  /** Validate a blueprint definition (structure + DAG integrity) */
  validate(blueprint: Blueprint): { valid: boolean; errors: string[] };
  /** Execute a blueprint, returning the final state */
  run(blueprint: Blueprint, context?: Partial<BlueprintContext>): Promise<ExecutionState>;
  /** Resume a previously persisted execution state */
  resume(state: ExecutionState, blueprint: Blueprint): Promise<ExecutionState>;
  /** Get current execution state (for monitoring) */
  getState(): ExecutionState | null;
  /** Request graceful cancellation of the current run */
  cancel(): Promise<void>;
}

/** Interface for node executors (strategy pattern). */
export interface INodeExecutor {
  execute(node: BlueprintNode, context: BlueprintContext): Promise<NodeResult>;
}

/** Callback hooks for observability. */
export interface RunnerHooks {
  onNodeStart?: (nodeId: string, node: BlueprintNode) => void;
  onNodeComplete?: (nodeId: string, result: NodeResult) => void;
  onEscalation?: (reason: string, state: ExecutionState) => void;
  onStateChange?: (state: ExecutionState) => void;
}
