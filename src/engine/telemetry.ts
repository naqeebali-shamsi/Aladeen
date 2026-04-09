import type { EvaluatorScorecard } from './contracts.js';
import type { ExecutionState, NodeResult } from './types.js';

export type TelemetryEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.escalated'
  | 'node.started'
  | 'node.completed'
  | 'scorecard.recorded';

export interface TelemetryEvent {
  type: TelemetryEventType;
  runId: string;
  blueprintId: string;
  nodeId?: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

export interface RunTelemetrySink {
  emit(event: TelemetryEvent): Promise<void>;
}

/**
 * Langfuse-compatible trace interface.
 * Concrete adapters can map these calls to Langfuse SDK or local stores.
 */
export interface TraceAdapter {
  recordTrace(params: {
    traceId: string;
    name: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  recordSpan(params: {
    traceId: string;
    spanId: string;
    name: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  recordScore(params: {
    traceId: string;
    name: string;
    value: number;
    comment?: string;
  }): Promise<void>;
}

export class NoopTelemetrySink implements RunTelemetrySink {
  async emit(): Promise<void> {
    // Intentionally no-op.
  }
}

export class NoopTraceAdapter implements TraceAdapter {
  async recordTrace(): Promise<void> {}
  async recordSpan(): Promise<void> {}
  async recordScore(): Promise<void> {}
}

export function nodeResultPayload(result: NodeResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    durationMs: Math.round(result.durationMs),
    summary: result.summary,
    hasError: Boolean(result.error),
  };
}

export function scorecardPayload(scorecard: EvaluatorScorecard): Record<string, unknown> {
  return {
    overall: scorecard.overall,
    correctness: scorecard.correctness,
    maintainability: scorecard.maintainability,
    regressionRisk: scorecard.regressionRisk,
    notes: scorecard.notes,
  };
}

export function runStatusEvent(state: ExecutionState): TelemetryEventType {
  switch (state.status) {
    case 'completed':
      return 'run.completed';
    case 'failed':
      return 'run.failed';
    case 'escalated':
      return 'run.escalated';
    default:
      return 'run.started';
  }
}
