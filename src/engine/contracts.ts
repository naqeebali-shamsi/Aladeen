import type { BlueprintContext, NodeResult } from './types.js';

export interface ContextBundle {
  graphContext?: string;
  memoryContext?: string;
  repoDigest?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextAssembler {
  assemble(params: {
    nodeId: string;
    prompt: string;
    context: BlueprintContext;
  }): Promise<ContextBundle>;
}

export interface ModelRouteDecision {
  tier: 'planner' | 'generator' | 'evaluator';
  modelId: string;
  reason: string;
}

export interface ModelRouter {
  route(params: {
    tier: 'planner' | 'generator' | 'evaluator';
    prompt: string;
    context: BlueprintContext;
  }): Promise<ModelRouteDecision>;
}

export interface EvaluatorScorecard {
  overall: number;
  correctness: number;
  maintainability: number;
  regressionRisk: number;
  notes?: string;
}

export interface EvaluatorScorer {
  score(params: {
    nodeId: string;
    result: NodeResult;
    context: BlueprintContext;
  }): Promise<EvaluatorScorecard>;
}

export class NoopContextAssembler implements ContextAssembler {
  async assemble(): Promise<ContextBundle> {
    return {};
  }
}

export class StaticModelRouter implements ModelRouter {
  constructor(private readonly defaults: Record<'planner' | 'generator' | 'evaluator', string>) {}

  async route(params: { tier: 'planner' | 'generator' | 'evaluator' }): Promise<ModelRouteDecision> {
    return {
      tier: params.tier,
      modelId: this.defaults[params.tier],
      reason: 'static-router-default',
    };
  }
}

export class NoopEvaluatorScorer implements EvaluatorScorer {
  async score(): Promise<EvaluatorScorecard> {
    return {
      overall: 0,
      correctness: 0,
      maintainability: 0,
      regressionRisk: 0,
      notes: 'No evaluator configured',
    };
  }
}
