import { describe, it, expect } from 'vitest';
import { bucketFailures } from './failure-buckets.js';
import type { ExecutionState, NodeResult } from './types.js';

function makeRun(partial: Partial<ExecutionState> & { runId: string; status: ExecutionState['status'] }): ExecutionState {
  return {
    blueprintId: 'bp',
    nodeExecutions: {},
    currentNodeId: null,
    totalRetries: 0,
    context: { cwd: '.', env: {}, ruleFiles: [], allowedTools: [], store: {} },
    startedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...partial,
  } as ExecutionState;
}

const failResult = (error: string): NodeResult => ({
  outcome: 'failure',
  output: {},
  error,
  durationMs: 1,
});

describe('bucketFailures', () => {
  it('returns empty array for all-completed runs', () => {
    const runs: ExecutionState[] = [
      makeRun({ runId: 'r1', status: 'completed' }),
      makeRun({ runId: 'r2', status: 'completed' }),
    ];
    expect(bucketFailures(runs)).toEqual([]);
  });

  it('groups abandoned runs into a run-level bucket with the escalationReason', () => {
    const runs: ExecutionState[] = [
      makeRun({ runId: 'r1', status: 'abandoned', escalationReason: 'Marked by sweep: 49d' }),
      makeRun({ runId: 'r2', status: 'abandoned', escalationReason: 'Marked by sweep: 50d' }),
    ];
    const buckets = bucketFailures(runs);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      nodeId: '__run__',
      outcome: 'abandoned',
      count: 2,
      sampleRunIds: ['r1', 'r2'],
    });
    expect(buckets[0]!.sampleErrors).toEqual(['Marked by sweep: 49d', 'Marked by sweep: 50d']);
  });

  it('groups failed nodes by (nodeId, outcome) across runs', () => {
    const mkFailedLint = (runId: string, err: string): ExecutionState =>
      makeRun({
        runId,
        status: 'failed',
        nodeExecutions: {
          lint: {
            nodeId: 'lint',
            status: 'failed',
            attempts: 1,
            results: [failResult(err)],
          },
        },
      });
    const runs: ExecutionState[] = [
      mkFailedLint('r1', 'tsc syntax error at line 42'),
      mkFailedLint('r2', 'tsc syntax error at line 99'),
      mkFailedLint('r3', 'different error'),
    ];
    const buckets = bucketFailures(runs);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      nodeId: 'lint',
      outcome: 'failure',
      count: 3,
      sampleRunIds: ['r1', 'r2', 'r3'],
    });
  });

  it('sorts buckets by count descending', () => {
    const runs: ExecutionState[] = [
      makeRun({ runId: 'a1', status: 'abandoned', escalationReason: 'x' }),
      makeRun({
        runId: 'f1',
        status: 'failed',
        nodeExecutions: {
          test: { nodeId: 'test', status: 'failed', attempts: 1, results: [failResult('e1')] },
        },
      }),
      makeRun({
        runId: 'f2',
        status: 'failed',
        nodeExecutions: {
          test: { nodeId: 'test', status: 'failed', attempts: 1, results: [failResult('e2')] },
        },
      }),
      makeRun({
        runId: 'f3',
        status: 'failed',
        nodeExecutions: {
          test: { nodeId: 'test', status: 'failed', attempts: 1, results: [failResult('e3')] },
        },
      }),
    ];
    const buckets = bucketFailures(runs);
    expect(buckets[0]!.count).toBe(3);
    expect(buckets[0]!.nodeId).toBe('test');
    expect(buckets[1]!.count).toBe(1);
  });

  it('caps sampleRunIds and sampleErrors at 5 and truncates error snippets', () => {
    const runs: ExecutionState[] = Array.from({ length: 10 }, (_, i) =>
      makeRun({
        runId: `r${i}`,
        status: 'failed',
        nodeExecutions: {
          lint: {
            nodeId: 'lint',
            status: 'failed',
            attempts: 1,
            results: [failResult('x'.repeat(500))],
          },
        },
      })
    );
    const [bucket] = bucketFailures(runs);
    expect(bucket!.count).toBe(10);
    expect(bucket!.sampleRunIds).toHaveLength(5);
    expect(bucket!.sampleErrors).toHaveLength(5);
    expect(bucket!.sampleErrors[0]!.length).toBeLessThanOrEqual(200);
  });

  it('produces separate buckets for the same node with different outcomes', () => {
    const runs: ExecutionState[] = [
      makeRun({
        runId: 'r1',
        status: 'failed',
        nodeExecutions: {
          lint: {
            nodeId: 'lint',
            status: 'failed',
            attempts: 1,
            results: [{ outcome: 'retry', output: {}, error: 'wanted retry', durationMs: 1 }],
          },
        },
      }),
      makeRun({
        runId: 'r2',
        status: 'failed',
        nodeExecutions: {
          lint: {
            nodeId: 'lint',
            status: 'failed',
            attempts: 1,
            results: [failResult('hard fail')],
          },
        },
      }),
    ];
    const buckets = bucketFailures(runs);
    expect(buckets).toHaveLength(2);
    const outcomes = buckets.map((b) => b.outcome).sort();
    expect(outcomes).toEqual(['failure', 'retry']);
  });
});
