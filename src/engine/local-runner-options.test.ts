import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  createLocalFirstRunnerOptions,
  HeuristicEvaluatorScorer,
} from './local-runner-options.js';
import type { BlueprintContext, NodeResult } from './types.js';

const noCtx: BlueprintContext = {
  cwd: '.',
  env: {},
  ruleFiles: [],
  allowedTools: [],
  store: {},
};

function node(outcome: NodeResult['outcome']): NodeResult {
  return { outcome, output: {}, durationMs: 1 };
}

describe('createLocalFirstRunnerOptions', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    delete process.env['OLLAMA_MODEL'];
    delete process.env['ALADEEN_MODEL_PLANNER'];
    delete process.env['ALADEEN_MODEL_GENERATOR'];
    delete process.env['ALADEEN_MODEL_EVALUATOR'];
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns a well-formed RunnerOptions with runMode=local-only', () => {
    const opts = createLocalFirstRunnerOptions('/tmp/repo');
    expect(opts.repoRoot).toBe('/tmp/repo');
    expect(opts.runMode).toBe('local-only');
    expect(opts.contextAssembler).toBeDefined();
    expect(opts.modelRouter).toBeDefined();
    expect(opts.evaluatorScorer).toBeDefined();
  });

  it('modelRouter.route() returns the default local model when no env is set', async () => {
    const opts = createLocalFirstRunnerOptions('/tmp/repo');
    const decision = await opts.modelRouter!.route({
      tier: 'generator',
      prompt: '',
      context: noCtx,
    });
    expect(decision.modelId).toBe('qwen2.5-coder:14b');
    expect(decision.tier).toBe('generator');
  });

  it('ALADEEN_MODEL_PLANNER env var overrides the planner tier', async () => {
    process.env['ALADEEN_MODEL_PLANNER'] = 'llama-3.1-70b-instruct';
    const opts = createLocalFirstRunnerOptions('/tmp/repo');
    const decision = await opts.modelRouter!.route({
      tier: 'planner',
      prompt: '',
      context: noCtx,
    });
    expect(decision.modelId).toBe('llama-3.1-70b-instruct');
  });

  it('OLLAMA_MODEL env var overrides the fallback for all tiers', async () => {
    process.env['OLLAMA_MODEL'] = 'deepseek-coder:33b';
    const opts = createLocalFirstRunnerOptions('/tmp/repo');
    const planner = await opts.modelRouter!.route({ tier: 'planner', prompt: '', context: noCtx });
    const generator = await opts.modelRouter!.route({ tier: 'generator', prompt: '', context: noCtx });
    expect(planner.modelId).toBe('deepseek-coder:33b');
    expect(generator.modelId).toBe('deepseek-coder:33b');
  });
});

describe('HeuristicEvaluatorScorer', () => {
  const scorer = new HeuristicEvaluatorScorer();

  it('success → overall=8, low regression risk', async () => {
    const sc = await scorer.score({ nodeId: 'x', result: node('success'), context: noCtx });
    expect(sc.overall).toBe(8);
    expect(sc.regressionRisk).toBe(2);
  });

  it('retry → overall=4, middling regression risk', async () => {
    const sc = await scorer.score({ nodeId: 'x', result: node('retry'), context: noCtx });
    expect(sc.overall).toBe(4);
    expect(sc.regressionRisk).toBe(6);
  });

  it('failure → overall=2, high regression risk', async () => {
    const sc = await scorer.score({ nodeId: 'x', result: node('failure'), context: noCtx });
    expect(sc.overall).toBe(2);
    expect(sc.regressionRisk).toBe(8);
  });
});
