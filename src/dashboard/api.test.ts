import { describe, it, expect } from 'vitest';
import { deriveSystemStatus, buildOverview, basename } from './api.js';
import { ERROR_CLASSES, type RunDigest, type ErrorClass } from '../observability/session-trace.js';

function zeroErrors(): Record<ErrorClass, number> {
  return Object.fromEntries(ERROR_CLASSES.map((c) => [c, 0])) as Record<ErrorClass, number>;
}

function makeDigest(p: Partial<RunDigest> = {}): RunDigest {
  return {
    sessionId: p.sessionId ?? 's1',
    agentCliName: p.agentCliName ?? 'codex',
    outcome: p.outcome ?? 'completed',
    durationMs: p.durationMs,
    activeDurationMs: p.activeDurationMs,
    toolUsage: p.toolUsage ?? {},
    errorCounts: { ...zeroErrors(), ...(p.errorCounts ?? {}) },
    filesChanged: p.filesChanged ?? [],
    toolFailureCount: p.toolFailureCount ?? 0,
    editLoops: p.editLoops ?? [],
    cost: p.cost,
    patternFingerprint: p.patternFingerprint ?? 'aaaa0000bbbb1111',
  };
}

describe('deriveSystemStatus', () => {
  it('is NOMINAL for an empty corpus', () => {
    const v = deriveSystemStatus([]);
    expect(v.level).toBe('NOMINAL');
    expect(v.toolFailingRatio).toBe(0);
  });

  it('is NOMINAL when all clean', () => {
    const digests = [makeDigest(), makeDigest({ sessionId: 's2' })];
    expect(deriveSystemStatus(digests).level).toBe('NOMINAL');
  });

  it('stays NOMINAL at exactly 0.25 (rule is strictly greater)', () => {
    const digests = [
      makeDigest({ sessionId: 'a', toolFailureCount: 3 }),
      makeDigest({ sessionId: 'b' }),
      makeDigest({ sessionId: 'c' }),
      makeDigest({ sessionId: 'd' }),
    ];
    expect(deriveSystemStatus(digests).level).toBe('NOMINAL');
  });

  it('is DEGRADED when tool-failing ratio exceeds 0.25', () => {
    const digests = [
      makeDigest({ sessionId: 'a', toolFailureCount: 3 }),
      makeDigest({ sessionId: 'b', toolFailureCount: 1 }),
      makeDigest({ sessionId: 'c' }),
      makeDigest({ sessionId: 'd' }),
      makeDigest({ sessionId: 'e' }),
    ];
    const v = deriveSystemStatus(digests);
    expect(v.level).toBe('DEGRADED');
    expect(v.toolFailingSessions).toBe(2);
    expect(v.toolFailingRatio).toBeCloseTo(0.4, 5);
  });

  it('is ANOMALY when a single session exceeds 100 of one error class, and surfaces both runaways sorted desc', () => {
    const digests = [
      makeDigest({ sessionId: 'big', agentCliName: 'aladeen', outcome: 'gave_up', errorCounts: { worktree_collision: 2267 } }),
      makeDigest({ sessionId: 'mid', agentCliName: 'aladeen', outcome: 'gave_up', errorCounts: { worktree_collision: 1930 } }),
      makeDigest({ sessionId: 'small', errorCounts: { tool_error: 5 } }),
    ];
    const v = deriveSystemStatus(digests);
    expect(v.level).toBe('ANOMALY');
    expect(v.anomalies).toHaveLength(2);
    expect(v.anomalies[0].sessionId).toBe('big');
    expect(v.anomalies[0].count).toBe(2267);
    expect(v.anomalies[1].count).toBe(1930);
  });
});

describe('buildOverview', () => {
  const digests = [
    makeDigest({ sessionId: 'x1', agentCliName: 'codex', patternFingerprint: 'fp_clean', toolUsage: { lint: 4199, 'fix-lint': 4196 } }),
    makeDigest({ sessionId: 'x2', agentCliName: 'codex', patternFingerprint: 'fp_clean' }),
    makeDigest({ sessionId: 'x3', agentCliName: 'aladeen', outcome: 'gave_up', patternFingerprint: 'fp_runaway', toolFailureCount: 9, errorCounts: { worktree_collision: 2267 }, filesChanged: ['N:\\Aladeen\\src\\hello.ts', '/tmp/hello.ts'], editLoops: [{ path: 'hello.ts', editCount: 1668 }] }),
  ];
  const o = buildOverview(digests, '2026-05-29T00:00:00.000Z', 'N:\\Aladeen');

  it('counts sessions and CLIs', () => {
    expect(o.sessionCount).toBe(3);
    expect(o.byCli).toEqual({ codex: 2, aladeen: 1 });
  });

  it('buckets fingerprints with a sample-derived label, sorted by count', () => {
    expect(o.fingerprints[0].fp).toBe('fp_clean');
    expect(o.fingerprints[0].count).toBe(2);
    expect(o.fingerprints[0].isFailure).toBe(false);
    const runaway = o.fingerprints.find((f) => f.fp === 'fp_runaway')!;
    expect(runaway.isFailure).toBe(true);
    expect(runaway.topError).toBe('worktree_collision');
    expect(runaway.label).toContain('ALADEEN');
  });

  it('detects the lint <=> fix-lint deterministic loop pair', () => {
    expect(o.loopPairs).toHaveLength(1);
    expect(o.loopPairs[0].a).toBe('lint');
    expect(o.loopPairs[0].b).toBe('fix-lint');
    expect(o.loopPairs[0].ratio).toBeGreaterThan(0.99);
  });

  it('rolls up nonzero error classes only', () => {
    expect(o.errorClasses).toEqual({ worktree_collision: 2267 });
  });

  it('counts file hotspots by basename, once per session', () => {
    const hs = o.fileHotspots.find((f) => f.basename === 'hello.ts')!;
    expect(hs.count).toBe(1); // same basename twice in one session counts once
  });

  it('reports honest coverage', () => {
    expect(o.coverage).toEqual({ editLoops: 1, cost: 0, fileRefs: 1, total: 3 });
  });
});

describe('basename', () => {
  it('handles windows and posix paths', () => {
    expect(basename('N:\\Aladeen\\src\\cli.tsx')).toBe('cli.tsx');
    expect(basename('/home/u/p/index.ts')).toBe('index.ts');
    expect(basename('bare.ts')).toBe('bare.ts');
  });
});
