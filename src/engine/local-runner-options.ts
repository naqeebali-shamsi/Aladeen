import { LocalContextAssembler } from './context/local-context-assembler.js';
import {
  StaticModelRouter,
  type EvaluatorScorecard,
  type EvaluatorScorer,
  type ModelRouter,
} from './contracts.js';
import type { BlueprintContext, NodeResult } from './types.js';
import type { RunnerOptions } from './runner.js';

const DEFAULT_LOCAL_MODEL = 'qwen2.5-coder:14b';

function envModel(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Lightweight scorecard when no LLM-as-judge is wired: maps node outcomes to numbers.
 */
export class HeuristicEvaluatorScorer implements EvaluatorScorer {
  async score(params: {
    nodeId: string;
    result: NodeResult;
    context: BlueprintContext;
  }): Promise<EvaluatorScorecard> {
    const { result } = params;
    if (result.outcome === 'success') {
      return {
        overall: 8,
        correctness: 8,
        maintainability: 7,
        regressionRisk: 2,
        notes: 'Heuristic: success',
      };
    }
    if (result.outcome === 'retry') {
      return {
        overall: 4,
        correctness: 4,
        maintainability: 5,
        regressionRisk: 6,
        notes: 'Heuristic: retry',
      };
    }
    return {
      overall: 2,
      correctness: 2,
      maintainability: 4,
      regressionRisk: 8,
      notes: 'Heuristic: failure',
    };
  }
}

/**
 * Default runner options for local-first harness: context assembly, static model IDs from env, heuristic evaluator.
 */
export function createLocalFirstRunnerOptions(repoRoot: string): RunnerOptions {
  const fallback = envModel('OLLAMA_MODEL', DEFAULT_LOCAL_MODEL);
  const planner = envModel('ALADEEN_MODEL_PLANNER', fallback);
  const generator = envModel('ALADEEN_MODEL_GENERATOR', fallback);
  const evaluator = envModel('ALADEEN_MODEL_EVALUATOR', fallback);

  const modelRouter: ModelRouter = new StaticModelRouter({
    planner,
    generator,
    evaluator,
  });

  return {
    repoRoot,
    runMode: 'local-only',
    contextAssembler: new LocalContextAssembler(),
    modelRouter,
    evaluatorScorer: new HeuristicEvaluatorScorer(),
  };
}
