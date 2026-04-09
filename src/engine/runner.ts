import { randomUUID } from 'node:crypto';
import type {
  Blueprint,
  BlueprintContext,
  BlueprintNode,
  ExecutionState,
  IBlueprintRunner,
  INodeExecutor,
  NodeExecution,
  NodeOutcome,
  RunnerHooks,
  Edge,
} from './types.js';
import { validateBlueprint } from './validate.js';
import { DeterministicExecutor } from './deterministic-executor.js';
import { AgenticExecutor } from './agentic-executor.js';
import { StatePersistence } from './state.js';
import {
  type ContextAssembler,
  type EvaluatorScorer,
  type ModelRouter,
  NoopContextAssembler,
  NoopEvaluatorScorer,
} from './contracts.js';
import {
  type RunTelemetrySink,
  NoopTelemetrySink,
  nodeResultPayload,
  runStatusEvent,
  scorecardPayload,
} from './telemetry.js';

export interface RunnerOptions {
  /** Repository root for state persistence. If omitted, persistence is disabled. */
  repoRoot?: string;
  hooks?: RunnerHooks;
  /** Override default persistence (e.g., for testing). */
  persistence?: StatePersistence;
  contextAssembler?: ContextAssembler;
  modelRouter?: ModelRouter;
  evaluatorScorer?: EvaluatorScorer;
  telemetry?: RunTelemetrySink;
  runMode?: 'local-only' | 'hybrid' | 'cloud';
}

/**
 * Walks a Blueprint graph, executing nodes and following edges based on outcomes.
 *
 * Unlike a strict topological-sort executor, this runner follows edges dynamically,
 * which allows retry loops (e.g., lint -> fix -> lint) bounded by maxRetries.
 */
export class BlueprintRunner implements IBlueprintRunner {
  private state: ExecutionState | null = null;
  private cancelled = false;
  private readonly deterministicExec: INodeExecutor;
  private readonly agenticExec: INodeExecutor;
  private readonly persistence: StatePersistence | null;
  private readonly hooks: RunnerHooks;
  private readonly contextAssembler: ContextAssembler;
  private readonly modelRouter?: ModelRouter;
  private readonly evaluatorScorer: EvaluatorScorer;
  private readonly telemetry: RunTelemetrySink;
  private readonly runMode: 'local-only' | 'hybrid' | 'cloud';

  constructor(options: RunnerOptions = {}) {
    this.deterministicExec = new DeterministicExecutor();
    this.contextAssembler = options.contextAssembler ?? new NoopContextAssembler();
    this.modelRouter = options.modelRouter;
    this.evaluatorScorer = options.evaluatorScorer ?? new NoopEvaluatorScorer();
    this.telemetry = options.telemetry ?? new NoopTelemetrySink();
    this.runMode = options.runMode ?? 'local-only';
    this.agenticExec = new AgenticExecutor({
      contextAssembler: this.contextAssembler,
      modelRouter: this.modelRouter,
    });
    this.persistence = options.persistence
      ?? (options.repoRoot ? new StatePersistence(options.repoRoot) : null);
    this.hooks = options.hooks ?? {};
  }

  validate(blueprint: Blueprint): { valid: boolean; errors: string[] } {
    return validateBlueprint(blueprint);
  }

  async run(
    blueprint: Blueprint,
    contextOverrides?: Partial<BlueprintContext>
  ): Promise<ExecutionState> {
    const validation = this.validate(blueprint);
    if (!validation.valid) {
      throw new Error(`Invalid blueprint: ${validation.errors.join('; ')}`);
    }

    const context: BlueprintContext = {
      cwd: contextOverrides?.cwd ?? blueprint.defaultContext.cwd,
      env: { ...blueprint.defaultContext.env, ...contextOverrides?.env },
      ruleFiles: contextOverrides?.ruleFiles ?? blueprint.defaultContext.ruleFiles,
      allowedTools: contextOverrides?.allowedTools ?? blueprint.defaultContext.allowedTools,
      store: { ...blueprint.defaultContext.store, ...contextOverrides?.store },
    };

    const nodeExecutions: Record<string, NodeExecution> = {};
    for (const node of blueprint.nodes) {
      nodeExecutions[node.id] = {
        nodeId: node.id,
        status: 'pending',
        attempts: 0,
        results: [],
      };
    }

    this.state = {
      runId: randomUUID(),
      blueprintId: blueprint.id,
      status: 'running',
      nodeExecutions,
      currentNodeId: blueprint.entryNodeId,
      totalRetries: 0,
      context,
      startedAt: new Date().toISOString(),
      runPolicy: {
        mode: this.runMode,
        cloudFallbackAllowed: this.runMode !== 'local-only',
        maxRunDurationMs: blueprint.maxDurationMs,
        maxTotalRetries: blueprint.maxTotalRetries,
      },
      quality: {
        gateOrder: blueprint.nodes
          .filter((n) => n.kind === 'deterministic')
          .map((n) => n.id),
        gateOutcomes: {},
      },
    };
    this.cancelled = false;

    await this.telemetry.emit({
      type: 'run.started',
      runId: this.state.runId,
      blueprintId: this.state.blueprintId,
      timestamp: new Date().toISOString(),
    });

    return this.walk(blueprint);
  }

  async resume(state: ExecutionState, blueprint: Blueprint): Promise<ExecutionState> {
    this.state = { ...state, status: 'running' };
    this.cancelled = false;
    return this.walk(blueprint);
  }

  getState(): ExecutionState | null {
    return this.state;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  // ─── Core DAG Walker ──────────────────────────────────────────────

  private async walk(blueprint: Blueprint): Promise<ExecutionState> {
    const nodeMap = new Map(blueprint.nodes.map((n) => [n.id, n]));

    while (this.state!.currentNodeId !== null && !this.cancelled) {
      const nodeId = this.state!.currentNodeId;
      const node = nodeMap.get(nodeId);
      if (!node) {
        return this.terminate('failed', `Node "${nodeId}" not found in blueprint`);
      }

      // Wall-clock timeout
      if (blueprint.maxDurationMs) {
        const elapsed = Date.now() - new Date(this.state!.startedAt).getTime();
        if (elapsed > blueprint.maxDurationMs) {
          return this.terminate('escalated', `Wall-clock timeout (${blueprint.maxDurationMs}ms)`);
        }
      }

      // Global retry budget
      if (
        blueprint.maxTotalRetries !== undefined &&
        this.state!.totalRetries > blueprint.maxTotalRetries
      ) {
        return this.terminate(
          'escalated',
          `Global retry budget exhausted (${blueprint.maxTotalRetries})`
        );
      }

      // Resolve scoped context
      const nodeContext = this.resolveNodeContext(node);

      // Mark running
      const exec = this.state!.nodeExecutions[nodeId]!;
      exec.status = 'running';
      exec.startedAt = exec.startedAt ?? new Date().toISOString();
      exec.attempts += 1;
      this.hooks.onNodeStart?.(nodeId, node);
      this.emitStateChange();
      await this.telemetry.emit({
        type: 'node.started',
        runId: this.state!.runId,
        blueprintId: this.state!.blueprintId,
        nodeId,
        timestamp: new Date().toISOString(),
      });

      // Execute
      const executor = node.kind === 'deterministic'
        ? this.deterministicExec
        : this.agenticExec;

      const result = await executor.execute(node, nodeContext);
      exec.results.push(result);
      this.hooks.onNodeComplete?.(nodeId, result);
      await this.telemetry.emit({
        type: 'node.completed',
        runId: this.state!.runId,
        blueprintId: this.state!.blueprintId,
        nodeId,
        timestamp: new Date().toISOString(),
        payload: nodeResultPayload(result),
      });

      if (node.kind === 'deterministic') {
        this.state!.quality ??= {};
        this.state!.quality.gateOutcomes ??= {};
        this.state!.quality.gateOutcomes[nodeId] = result.outcome;
      } else {
        const scorecard = await this.evaluatorScorer.score({
          nodeId,
          result,
          context: nodeContext,
        });
        this.state!.quality ??= {};
        this.state!.quality.evaluatorOverall = scorecard.overall;
        await this.telemetry.emit({
          type: 'scorecard.recorded',
          runId: this.state!.runId,
          blueprintId: this.state!.blueprintId,
          nodeId,
          timestamp: new Date().toISOString(),
          payload: scorecardPayload(scorecard),
        });
      }

      // Merge output into store: both flat (nodeId.key) and nested (nodeId -> object)
      for (const [key, value] of Object.entries(result.output)) {
        this.state!.context.store[`${nodeId}.${key}`] = value;
      }
      this.state!.context.store[nodeId] = result.output;

      // Determine next node based on outcome
      const nextNodeId = this.resolveNext(nodeId, result.outcome, blueprint.edges);

      switch (result.outcome) {
        case 'success':
          exec.status = 'completed';
          exec.completedAt = new Date().toISOString();
          this.state!.currentNodeId = nextNodeId;
          break;

        case 'retry':
          this.handleRetry(node, exec, nextNodeId, blueprint);
          break;

        case 'failure':
          exec.status = 'failed';
          exec.completedAt = new Date().toISOString();
          if (nextNodeId) {
            // Follow failure edge (e.g., lint fail -> fix node)
            this.state!.currentNodeId = nextNodeId;
          } else {
            // No failure edge: run fails
            return this.terminate('failed');
          }
          break;
      }

      // Persist after every node execution
      await this.persist();
      this.emitStateChange();
    }

    // Finalize
    if (this.cancelled) {
      return this.terminate('failed', 'Cancelled by user');
    }

    // currentNodeId is null = we walked off the end of the graph
    if (this.state!.status === 'running') {
      this.state!.status = 'completed';
    }
    this.state!.completedAt = new Date().toISOString();
    await this.persist();
    this.emitStateChange();
    await this.telemetry.emit({
      type: runStatusEvent(this.state!),
      runId: this.state!.runId,
      blueprintId: this.state!.blueprintId,
      timestamp: new Date().toISOString(),
    });
    return this.state!;
  }

  private handleRetry(
    node: BlueprintNode,
    exec: NodeExecution,
    nextNodeId: string | null,
    blueprint: Blueprint
  ): void {
    if (node.kind === 'agentic') {
      this.state!.totalRetries += 1;

      if (exec.attempts > node.maxRetries) {
        // Exhausted per-node retries
        exec.status = 'failed';
        exec.completedAt = new Date().toISOString();
        // Try failure edge
        const failureEdge = this.resolveNext(node.id, 'failure', blueprint.edges);
        if (failureEdge) {
          this.state!.currentNodeId = failureEdge;
        } else {
          this.state!.status = 'escalated';
          this.state!.escalationReason = `Node "${node.id}" exhausted retries with no failure path`;
          this.state!.currentNodeId = null;
          this.hooks.onEscalation?.(this.state!.escalationReason, this.state!);
        }
      } else if (nextNodeId) {
        // Follow explicit retry edge
        this.state!.currentNodeId = nextNodeId;
      }
      // else: no retry edge, stay on same node (re-execute next iteration)
    } else {
      // Deterministic nodes don't retry; treat as failure
      exec.status = 'failed';
      exec.completedAt = new Date().toISOString();
      const failureEdge = this.resolveNext(node.id, 'failure', blueprint.edges);
      this.state!.currentNodeId = failureEdge;
      if (!failureEdge) {
        this.state!.status = 'failed';
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private resolveNodeContext(node: BlueprintNode): BlueprintContext {
    const base = this.state!.context;
    const ov = node.contextOverrides;
    if (!ov) return base;
    return {
      cwd: ov.cwd ?? base.cwd,
      env: { ...base.env, ...ov.env },
      ruleFiles: ov.ruleFiles ?? base.ruleFiles,
      allowedTools: ov.allowedTools ?? base.allowedTools,
      store: { ...base.store, ...ov.store },
    };
  }

  /**
   * Find the next node from an edge list.
   * Priority: exact outcome match > default (undefined on) > null.
   */
  private resolveNext(
    fromId: string,
    outcome: NodeOutcome,
    edges: Edge[]
  ): string | null {
    const outgoing = edges.filter((e) => e.from === fromId);
    const exact = outgoing.find((e) => e.on === outcome);
    if (exact) return exact.to;
    const def = outgoing.find((e) => e.on === undefined);
    if (def) return def.to;
    return null;
  }

  private terminate(
    status: 'failed' | 'escalated',
    reason?: string
  ): ExecutionState {
    this.state!.status = status;
    if (reason) this.state!.escalationReason = reason;
    this.state!.currentNodeId = null;
    this.state!.completedAt = new Date().toISOString();
    if (status === 'escalated' && reason) {
      this.hooks.onEscalation?.(reason, this.state!);
    }
    this.emitStateChange();
    return this.state!;
  }

  private async persist(): Promise<void> {
    if (this.persistence && this.state) {
      await this.persistence.save(this.state).catch(() => {
        // Non-fatal: don't crash the run if persistence fails
      });
    }
  }

  private emitStateChange(): void {
    if (this.state) {
      this.hooks.onStateChange?.(this.state);
    }
  }
}
