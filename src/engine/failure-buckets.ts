import type { ExecutionState, NodeOutcome } from './types.js';

/**
 * A bucket of run failures sharing the same gate (nodeId) and outcome shape.
 * Enables "3 runs escalated on lint", "2 runs abandoned", etc. style rollups
 * over persisted `.aladeen/runs/*.json` data.
 */
export interface FailureBucket {
  /** The node id the failure occurred on, or '__run__' for run-level statuses. */
  nodeId: string;
  /** Outcome shape: node outcome, or 'escalated' / 'abandoned' for run-level. */
  outcome: NodeOutcome | 'escalated' | 'abandoned';
  /** Total number of runs matching this bucket. */
  count: number;
  /** Up to 5 concrete runIds in this bucket (in input order). */
  sampleRunIds: string[];
  /** Up to 5 error snippets (first 200 chars each) from the bucket. */
  sampleErrors: string[];
}

const MAX_SAMPLES = 5;
const ERROR_SNIPPET_CAP = 200;

/**
 * Group failed / escalated / abandoned runs by (nodeId, outcome).
 *
 * - Runs with `status === 'completed'` are skipped.
 * - Runs with `status === 'escalated'` or `'abandoned'` produce a run-level
 *   bucket keyed on `__run__` with the matching outcome; the escalationReason
 *   is used as the sample error.
 * - Runs with `status === 'failed'` (or still 'running' with a failed node)
 *   produce one bucket per failed node id, using the last result's error.
 *
 * Exported for CLI use, tests, and the /aladeen-postrun skill.
 */
export function bucketFailures(runs: ExecutionState[]): FailureBucket[] {
  const byKey = new Map<string, FailureBucket>();

  const push = (
    nodeId: string,
    outcome: FailureBucket['outcome'],
    runId: string,
    errorSnippet?: string
  ): void => {
    const key = `${nodeId}::${outcome}`;
    let b = byKey.get(key);
    if (!b) {
      b = { nodeId, outcome, count: 0, sampleRunIds: [], sampleErrors: [] };
      byKey.set(key, b);
    }
    b.count += 1;
    if (b.sampleRunIds.length < MAX_SAMPLES) b.sampleRunIds.push(runId);
    if (errorSnippet && b.sampleErrors.length < MAX_SAMPLES) {
      b.sampleErrors.push(errorSnippet.slice(0, ERROR_SNIPPET_CAP));
    }
  };

  for (const r of runs) {
    if (r.status === 'completed') continue;

    if (r.status === 'escalated' || r.status === 'abandoned') {
      push('__run__', r.status, r.runId, r.escalationReason);
      continue;
    }

    // 'failed' or a still-'running' run that nevertheless has failed nodes.
    let foundFailedNode = false;
    for (const [nodeId, exec] of Object.entries(r.nodeExecutions)) {
      if (exec.status !== 'failed') continue;
      const last = exec.results[exec.results.length - 1];
      push(nodeId, last?.outcome ?? 'failure', r.runId, last?.error);
      foundFailedNode = true;
    }

    if (!foundFailedNode && r.status === 'failed') {
      // Run marked failed but no per-node failure recorded; bucket at run level.
      push('__run__', 'failure', r.runId, r.escalationReason);
    }
  }

  // Largest buckets first so the caller sees the dominant failure modes.
  return Array.from(byKey.values()).sort((a, b) => b.count - a.count);
}
