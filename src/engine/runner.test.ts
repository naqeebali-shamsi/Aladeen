import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlueprintRunner } from './runner.js';
import { StatePersistence } from './state.js';
import type {
  Blueprint,
  BlueprintNode,
  ExecutionState,
  INodeExecutor,
  NodeResult,
} from './types.js';

class StubExecutor implements INodeExecutor {
  constructor(private readonly outcomes: Map<string, NodeResult>) {}
  async execute(node: BlueprintNode): Promise<NodeResult> {
    const r = this.outcomes.get(node.id);
    if (!r) throw new Error(`no stubbed outcome for node ${node.id}`);
    return r;
  }
}

const failResult: NodeResult = { outcome: 'failure', output: {}, durationMs: 1, error: 'boom' };
const okResult: NodeResult = { outcome: 'success', output: {}, durationMs: 1 };

const loopBlueprint: Blueprint = {
  id: 'loop-test',
  name: 'Lint→Fix→Lint loop',
  version: '1.0.0',
  entryNodeId: 'lint',
  maxTotalRetries: 3,
  nodes: [
    { id: 'lint', label: 'lint', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
    { id: 'fix', label: 'fix',  kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
  ],
  edges: [
    { from: 'lint', to: 'fix', on: 'failure' },
    { from: 'fix',  to: 'lint' },
  ],
  defaultContext: { cwd: '.', env: {}, ruleFiles: [], allowedTools: [], store: {} },
};

describe('BlueprintRunner — bounded retries', () => {
  it('terminates a deterministic failure→fix loop via maxTotalRetries', async () => {
    const runner = new BlueprintRunner();
    const stub = new StubExecutor(new Map([
      ['lint', failResult],
      ['fix', okResult],
    ]));
    // Inject our stub for both kinds (loop only uses deterministic).
    (runner as unknown as { deterministicExec: INodeExecutor }).deterministicExec = stub;

    const final = await runner.run(loopBlueprint);

    expect(final.status).toBe('escalated');
    expect(final.escalationReason).toMatch(/Global retry budget/);
    expect(final.nodeExecutions['lint']!.attempts).toBeLessThanOrEqual(5);
  });
});

// ─── Pick #2: resume from persisted state ───────────────────────────────────

const threeNodeBlueprint: Blueprint = {
  id: 'resume-test',
  name: 'A → B → C',
  version: '1.0.0',
  entryNodeId: 'a',
  nodes: [
    { id: 'a', label: 'a', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
    { id: 'b', label: 'b', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
    { id: 'c', label: 'c', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
  ],
  edges: [
    { from: 'a', to: 'b', on: 'success' },
    { from: 'b', to: 'c', on: 'success' },
  ],
  defaultContext: { cwd: '.', env: {}, ruleFiles: [], allowedTools: [], store: {} },
};

/** Tracks which node ids the executor was asked to run. */
class CountingStubExecutor implements INodeExecutor {
  public readonly calls: string[] = [];
  constructor(private readonly outcomes: Map<string, NodeResult>) {}
  async execute(node: BlueprintNode): Promise<NodeResult> {
    this.calls.push(node.id);
    const r = this.outcomes.get(node.id);
    if (!r) throw new Error(`no stubbed outcome for node ${node.id}`);
    return r;
  }
}

describe('BlueprintRunner.resume — mid-flight state', () => {
  it('picks up at currentNodeId and does NOT re-execute completed nodes', async () => {
    const runner = new BlueprintRunner();
    const stub = new CountingStubExecutor(new Map([
      ['a', okResult],
      ['b', okResult],
      ['c', okResult],
    ]));
    (runner as unknown as { deterministicExec: INodeExecutor }).deterministicExec = stub;

    // Construct a mid-flight state: 'a' already completed, pointer on 'b'.
    const midFlight: ExecutionState = {
      runId: 'resume-1',
      blueprintId: 'resume-test',
      status: 'running',
      nodeExecutions: {
        a: {
          nodeId: 'a',
          status: 'completed',
          attempts: 1,
          results: [okResult],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        b: { nodeId: 'b', status: 'pending', attempts: 0, results: [] },
        c: { nodeId: 'c', status: 'pending', attempts: 0, results: [] },
      },
      currentNodeId: 'b',
      totalRetries: 0,
      context: threeNodeBlueprint.defaultContext,
      startedAt: new Date().toISOString(),
    };

    const final = await runner.resume(midFlight, threeNodeBlueprint);

    expect(final.status).toBe('completed');
    expect(stub.calls).toEqual(['b', 'c']); // a was NOT re-executed
    expect(final.nodeExecutions['a']!.attempts).toBe(1);
    expect(final.nodeExecutions['b']!.status).toBe('completed');
    expect(final.nodeExecutions['c']!.status).toBe('completed');
  });

  it('preserves totalRetries counter across resume', async () => {
    const runner = new BlueprintRunner();
    const stub = new CountingStubExecutor(new Map([
      ['b', okResult],
      ['c', okResult],
    ]));
    (runner as unknown as { deterministicExec: INodeExecutor }).deterministicExec = stub;

    const midFlight: ExecutionState = {
      runId: 'resume-2',
      blueprintId: 'resume-test',
      status: 'running',
      nodeExecutions: {
        a: { nodeId: 'a', status: 'completed', attempts: 1, results: [okResult] },
        b: { nodeId: 'b', status: 'pending', attempts: 0, results: [] },
        c: { nodeId: 'c', status: 'pending', attempts: 0, results: [] },
      },
      currentNodeId: 'b',
      totalRetries: 2, // simulate prior retries
      context: threeNodeBlueprint.defaultContext,
      startedAt: new Date().toISOString(),
    };

    const final = await runner.resume(midFlight, threeNodeBlueprint);
    expect(final.totalRetries).toBe(2); // not reset
  });
});

// ─── Pick #3: runPolicy metadata (roadmap M1) ───────────────────────────────

const onePassBlueprint: Blueprint = {
  id: 'policy-test',
  name: 'single-node',
  version: '1.0.0',
  entryNodeId: 'x',
  maxTotalRetries: 3,
  maxDurationMs: 60_000,
  nodes: [
    { id: 'x', label: 'x', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
  ],
  edges: [],
  defaultContext: { cwd: '.', env: {}, ruleFiles: [], allowedTools: [], store: {} },
};

function runnerWith(outcomes: Map<string, NodeResult>, runMode?: 'local-only' | 'hybrid' | 'cloud'): BlueprintRunner {
  const runner = new BlueprintRunner(runMode ? { runMode } : {});
  const stub = new StubExecutor(outcomes);
  (runner as unknown as { deterministicExec: INodeExecutor }).deterministicExec = stub;
  return runner;
}

describe('BlueprintRunner — retry must NOT follow the default edge (Bug F: opencode dogfood)', () => {
  it('an agentic retry re-executes the same node when there is no on:retry edge — default edge does not absorb retry', async () => {
    // Surfaced by dogfood-audex-2-opencode: implement returned retry (file-changes
    // verifier downgraded a chatty agent), but the runner walked the default
    // implement→typecheck edge as if implement succeeded — defeating the verifier.
    const bp: Blueprint = {
      id: 'agentic-retry-test',
      name: 'A (agentic) → B',
      version: '1.0.0',
      entryNodeId: 'a',
      maxTotalRetries: 2,
      nodes: [
        // maxRetries:2 lets retry happen at least once before exhausting
        { id: 'a', label: 'a', kind: 'agentic', adapterId: 'claude', prompt: '', maxRetries: 2 },
        { id: 'b', label: 'b', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
      ],
      // ONLY a default edge from a → b (no on:retry edge defined)
      edges: [{ from: 'a', to: 'b' }],
      defaultContext: { cwd: '.', env: {}, ruleFiles: [], allowedTools: [], store: {} },
    };

    const runner = new BlueprintRunner();
    const stub = new CountingStubExecutor(new Map([
      ['a', { outcome: 'retry', output: {}, durationMs: 1, error: 'no files changed' }],
      ['b', okResult],
    ]));
    (runner as unknown as { agenticExec: INodeExecutor }).agenticExec = stub;

    const final = await runner.run(bp);

    // 'b' must NOT have been called via the default edge from 'a' on retry.
    expect(stub.calls).not.toContain('b');
    // The run should have escalated/failed without ever advancing to 'b'.
    expect(['escalated', 'failed']).toContain(final.status);
    // 'a' should have been re-executed at least once before exhaustion.
    expect(final.nodeExecutions['a']!.attempts).toBeGreaterThanOrEqual(2);
  });

  it('an explicit on:retry edge IS still honored', async () => {
    const bp: Blueprint = {
      id: 'explicit-retry',
      name: 'A → B (only on retry)',
      version: '1.0.0',
      entryNodeId: 'a',
      nodes: [
        { id: 'a', label: 'a', kind: 'agentic', adapterId: 'claude', prompt: '', maxRetries: 2 },
        { id: 'b', label: 'b', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
      ],
      edges: [
        { from: 'a', to: 'b', on: 'retry' },
        { from: 'b', to: 'a' }, // loop back so we don't terminate immediately
      ],
      defaultContext: { cwd: '.', env: {}, ruleFiles: [], allowedTools: [], store: {} },
      maxTotalRetries: 1,
    };

    const runner = new BlueprintRunner();
    const stub = new CountingStubExecutor(new Map([
      ['a', { outcome: 'retry', output: {}, durationMs: 1 }],
      ['b', okResult],
    ]));
    (runner as unknown as { agenticExec: INodeExecutor }).agenticExec = stub;
    (runner as unknown as { deterministicExec: INodeExecutor }).deterministicExec = stub;

    await runner.run(bp);

    // Explicit on:retry edge fired, so 'b' was reached.
    expect(stub.calls).toContain('b');
  });
});

describe('BlueprintRunner — runPolicy metadata on every run (roadmap M1)', () => {
  it('explicit runMode: "local-only" → mode=local-only, cloudFallbackAllowed=false', async () => {
    const runner = runnerWith(new Map([['x', okResult]]), 'local-only');
    const final = await runner.run(onePassBlueprint);

    expect(final.status).toBe('completed');
    expect(final.runPolicy).toBeDefined();
    expect(final.runPolicy!.mode).toBe('local-only');
    expect(final.runPolicy!.cloudFallbackAllowed).toBe(false);
  });

  it('default (no runMode) still populates runPolicy with the safe default', async () => {
    const runner = runnerWith(new Map([['x', okResult]]));
    const final = await runner.run(onePassBlueprint);

    expect(final.runPolicy).toBeDefined();
    expect(final.runPolicy!.mode).toBe('local-only');
    expect(final.runPolicy!.cloudFallbackAllowed).toBe(false);
  });

  it('runMode: "hybrid" sets cloudFallbackAllowed=true', async () => {
    const runner = runnerWith(new Map([['x', okResult]]), 'hybrid');
    const final = await runner.run(onePassBlueprint);

    expect(final.runPolicy!.mode).toBe('hybrid');
    expect(final.runPolicy!.cloudFallbackAllowed).toBe(true);
  });

  it('carries blueprint-level budgets (maxRunDurationMs, maxTotalRetries) into runPolicy', async () => {
    const runner = runnerWith(new Map([['x', okResult]]), 'local-only');
    const final = await runner.run(onePassBlueprint);

    expect(final.runPolicy!.maxRunDurationMs).toBe(60_000);
    expect(final.runPolicy!.maxTotalRetries).toBe(3);
  });

  it('escalated run still carries runPolicy (metric applies to ALL runs, not just completed)', async () => {
    // Reuse the loopBlueprint pattern — lint keeps failing, fix keeps succeeding,
    // totalRetries exhausts → escalated.
    const runner = runnerWith(new Map([['lint', failResult], ['fix', okResult]]), 'local-only');
    const final = await runner.run(loopBlueprint);

    expect(final.status).toBe('escalated');
    expect(final.runPolicy).toBeDefined();
    expect(final.runPolicy!.mode).toBe('local-only');
  });
});

describe('BlueprintRunner.resume — disk round-trip (roadmap M4)', () => {
  let tmp: string;
  let persistence: StatePersistence;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'aladeen-resume-test-'));
    persistence = new StatePersistence(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('save → load → resume completes the blueprint', async () => {
    // Simulate a partial run that was persisted to disk.
    const partial: ExecutionState = {
      runId: 'disk-1',
      blueprintId: 'resume-test',
      status: 'running',
      nodeExecutions: {
        a: { nodeId: 'a', status: 'completed', attempts: 1, results: [okResult] },
        b: { nodeId: 'b', status: 'pending', attempts: 0, results: [] },
        c: { nodeId: 'c', status: 'pending', attempts: 0, results: [] },
      },
      currentNodeId: 'b',
      totalRetries: 0,
      context: threeNodeBlueprint.defaultContext,
      startedAt: new Date().toISOString(),
    };
    await persistence.save(partial);

    // Load from disk and resume.
    const loaded = await persistence.load('disk-1');
    const runner = new BlueprintRunner({ persistence });
    const stub = new CountingStubExecutor(new Map([
      ['b', okResult],
      ['c', okResult],
    ]));
    (runner as unknown as { deterministicExec: INodeExecutor }).deterministicExec = stub;

    const final = await runner.resume(loaded, threeNodeBlueprint);

    expect(final.status).toBe('completed');
    expect(stub.calls).toEqual(['b', 'c']);

    // And the final state is persisted back to disk.
    const reloaded = await persistence.load('disk-1');
    expect(reloaded.status).toBe('completed');
    expect(reloaded.completedAt).toBeDefined();
  });
});
