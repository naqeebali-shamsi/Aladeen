import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StatePersistence, isStale } from './state.js';
import type { ExecutionState } from './types.js';

function makeState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    runId: 'r1',
    blueprintId: 'bp',
    status: 'running',
    nodeExecutions: {},
    currentNodeId: 'n1',
    totalRetries: 0,
    context: { cwd: '.', env: {}, ruleFiles: [], allowedTools: [], store: {} },
    startedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

describe('isStale', () => {
  const now = new Date('2026-01-01T03:00:00Z'); // 3h later

  it('flags running runs older than 2× budget', () => {
    const s = makeState({
      runPolicy: { mode: 'local-only', cloudFallbackAllowed: false, maxRunDurationMs: 60_000 },
    });
    expect(isStale(s, now)).toBe(true);
  });

  it('does NOT flag fresh running runs within 2× budget', () => {
    const s = makeState({
      startedAt: new Date(now.getTime() - 30_000).toISOString(),
      runPolicy: { mode: 'local-only', cloudFallbackAllowed: false, maxRunDurationMs: 60_000 },
    });
    expect(isStale(s, now)).toBe(false);
  });

  it('uses default 1h fallback when no policy is set', () => {
    const s1 = makeState({ startedAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString() });
    expect(isStale(s1, now)).toBe(false); // 30min < 2h fallback budget
    const s2 = makeState({ startedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString() });
    expect(isStale(s2, now)).toBe(true); // 3h > 2h
  });

  it('does NOT flag terminal statuses', () => {
    for (const status of ['completed', 'failed', 'escalated', 'abandoned'] as const) {
      const s = makeState({ status });
      expect(isStale(s, now)).toBe(false);
    }
  });

  it('does NOT flag runs that have a completedAt', () => {
    const s = makeState({ completedAt: new Date('2026-01-01T01:00:00Z').toISOString() });
    expect(isStale(s, now)).toBe(false);
  });
});

describe('StatePersistence.sweepStale', () => {
  let tmp: string;
  let persistence: StatePersistence;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'aladeen-state-test-'));
    persistence = new StatePersistence(tmp);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('rewrites stale running runs to abandoned with a reason', async () => {
    const stale = makeState({
      runId: 'stale-1',
      startedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      runPolicy: { mode: 'local-only', cloudFallbackAllowed: false, maxRunDurationMs: 60_000 },
    });
    const fresh = makeState({
      runId: 'fresh-1',
      startedAt: new Date().toISOString(),
      runPolicy: { mode: 'local-only', cloudFallbackAllowed: false, maxRunDurationMs: 600_000 },
    });
    await persistence.save(stale);
    await persistence.save(fresh);

    const swept = await persistence.sweepStale(new Date('2026-01-02T00:00:00Z'));
    expect(swept).toEqual(['stale-1']);

    const reloaded = await persistence.load('stale-1');
    expect(reloaded.status).toBe('abandoned');
    expect(reloaded.completedAt).toBeDefined();
    expect(reloaded.escalationReason).toMatch(/abandoned by sweep/);

    const stillFresh = await persistence.load('fresh-1');
    expect(stillFresh.status).toBe('running');
  });
});
