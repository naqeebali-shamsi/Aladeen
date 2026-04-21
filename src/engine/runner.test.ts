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
