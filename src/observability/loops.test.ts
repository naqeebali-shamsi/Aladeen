import { describe, it, expect } from 'vitest';
import { suggestLoops, tokenize } from './loops.js';
import type { IngestStorage } from './storage.js';
import type { RunDigest, SessionTrace, ErrorClass } from './session-trace.js';

// Fakes mirror remedy.test.ts: digests + traces injected through a stub
// IngestStorage (no fs, no clocks). Timestamps are fixed epoch values so
// cadence math is deterministic.

function dig(p: Partial<RunDigest> = {}): RunDigest {
  return {
    sessionId: p.sessionId ?? 's',
    agentCliName: p.agentCliName ?? 'claude-code',
    outcome: p.outcome ?? 'completed',
    durationMs: p.durationMs,
    activeDurationMs: p.activeDurationMs,
    toolUsage: p.toolUsage ?? {},
    errorCounts: p.errorCounts ?? ({} as Record<ErrorClass, number>),
    filesChanged: p.filesChanged ?? [],
    toolFailureCount: p.toolFailureCount ?? 0,
    editLoops: p.editLoops ?? [],
    cost: p.cost,
    patternFingerprint: p.patternFingerprint ?? 'fp',
  };
}

function trc(
  sessionId: string,
  opts: { ask: string; provider?: string; startedAt?: string; endedAt?: string; extraHuman?: string[] },
): SessionTrace {
  const src = { kind: 'claude-code-jsonl', file: 'x' } as const;
  const events: unknown[] = [];
  let seq = 0;
  events.push({ kind: 'user_message', seq: seq++, source: src, text: opts.ask, origin: 'human' });
  for (const h of opts.extraHuman ?? []) {
    events.push({ kind: 'user_message', seq: seq++, source: src, text: h, origin: 'human' });
  }
  return {
    schemaVersion: '1', sessionId, agentCli: { name: opts.provider ?? 'claude-code' },
    workspace: { cwdScrubbed: '~/x' }, startedAt: opts.startedAt, endedAt: opts.endedAt ?? opts.startedAt,
    outcome: 'completed', events, scrubbing: { passes: [] },
  } as unknown as SessionTrace;
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Group {
  prefix: string; ask: string; n: number; stepMs: number;
  provider?: string; digest?: Partial<RunDigest>; extraHuman?: string[]; startMs?: number;
  // Per-session duration; lets a group's sessions overlap in wall-clock time
  // (the fan-out signal). Default 0 → endedAt == startedAt.
  durationMs?: number;
}
function build(groups: Group[]): IngestStorage {
  const digests: RunDigest[] = [];
  const traces: Record<string, SessionTrace> = {};
  for (const g of groups) {
    for (let i = 0; i < g.n; i++) {
      const id = `${g.prefix}-${i}`;
      const start = (g.startMs ?? T0) + i * g.stepMs;
      digests.push(dig({ sessionId: id, agentCliName: g.provider ?? 'claude-code', ...g.digest }));
      traces[id] = trc(id, {
        ask: g.ask, provider: g.provider,
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + (g.durationMs ?? 0)).toISOString(),
        extraHuman: g.extraHuman,
      });
    }
  }
  return { listDigests: async () => digests, loadTrace: async (id: string) => traces[id] ?? null } as unknown as IngestStorage;
}

describe('tokenize', () => {
  it('lowercases, drops stopwords and short tokens, keeps dotted filenames', () => {
    const t = tokenize('Please FIX the lint in src/app.ts');
    expect(t.has('fix')).toBe(true);
    expect(t.has('lint')).toBe(true);
    expect(t.has('app.ts')).toBe(true);
    expect(t.has('the')).toBe(false);   // stopword
    expect(t.has('please')).toBe(false); // stopword
    expect(t.has('in')).toBe(false);    // short + stopword
  });
});

describe('suggestLoops — clustering & recurrence', () => {
  it('groups near-identical asks into one candidate and keeps distinct asks separate', async () => {
    const storage = build([
      { prefix: 'lint', ask: 'fix the lint errors in the repo', n: 3, stepMs: HOUR },
      { prefix: 'plan', ask: 'review all the PLAN.md files in planning phases', n: 3, stepMs: HOUR },
    ]);
    const r = await suggestLoops(storage);
    expect(r.candidates).toHaveLength(2);
    const labels = r.candidates.map((c) => c.label).join(' | ');
    expect(labels).toMatch(/lint/);
    expect(labels).toMatch(/plan\.md|planning/);
  });

  it('clusters fuzzily on token overlap (varied phrasings of the same task)', async () => {
    const storage = build([
      { prefix: 'a', ask: 'fix the lint errors', n: 1, stepMs: HOUR, startMs: T0 },
      { prefix: 'b', ask: 'fix lint errors please', n: 1, stepMs: HOUR, startMs: T0 + DAY },
      { prefix: 'c', ask: 'fix the lint errors now', n: 1, stepMs: HOUR, startMs: T0 + 2 * DAY },
    ]);
    const r = await suggestLoops(storage, { minSessions: 3 });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].sessionCount).toBe(3);
  });

  it('honors the recurrence floor', async () => {
    const two = build([{ prefix: 'x', ask: 'rotate the api keys quarterly', n: 2, stepMs: DAY }]);
    expect((await suggestLoops(two, { minSessions: 3 })).candidates).toHaveLength(0);
    expect((await suggestLoops(two, { minSessions: 2 })).candidates).toHaveLength(1);
  });

  it('is deterministic across runs', async () => {
    const storage = build([
      { prefix: 'lint', ask: 'fix the lint errors in the repo', n: 4, stepMs: HOUR },
      { prefix: 'plan', ask: 'review all the PLAN.md files', n: 3, stepMs: DAY },
    ]);
    const a = await suggestLoops(storage);
    const b = await suggestLoops(storage);
    expect(a.markdown).toBe(b.markdown);
  });
});

describe('suggestLoops — mechanism mapping', () => {
  it('tight burst on a maintenance gate → .claude/loop.md (iterate)', async () => {
    const storage = build([{ prefix: 'lint', ask: 'the linter failed, fix it', n: 3, stepMs: 6 * MIN }]);
    const c = (await suggestLoops(storage)).candidates[0];
    expect(c.class).toBe('iterate');
    expect(c.mechanism).toBe('loop-md');
    expect(c.cadence.shape).toBe('burst');
  });

  it('tight burst on a non-maintenance task → self-paced /loop', async () => {
    const storage = build([{ prefix: 'pdf', ask: 'extract the tables from the quarterly pdf', n: 3, stepMs: 6 * MIN }]);
    const c = (await suggestLoops(storage)).candidates[0];
    expect(c.class).toBe('iterate');
    expect(c.mechanism).toBe('loop-self-paced');
    expect(c.command.startsWith('/loop ')).toBe(true);
  });

  it('polling shape → fixed-interval /loop with an interval derived from cadence', async () => {
    const storage = build([{ prefix: 'dep', ask: 'check if the deploy finished', n: 3, stepMs: 2 * HOUR }]);
    const c = (await suggestLoops(storage)).candidates[0];
    expect(c.mechanism).toBe('loop-interval');
    expect(c.command).toMatch(/^\/loop 2h /);
  });

  it('regular day-scale cadence → /schedule routine', async () => {
    const storage = build([{ prefix: 'bak', ask: 'run the database backup job', n: 3, stepMs: DAY }]);
    const c = (await suggestLoops(storage)).candidates[0];
    expect(c.cadence.shape).toBe('periodic');
    expect(c.mechanism).toBe('schedule');
    expect(c.command).toMatch(/^\/schedule .*\(daily\)/);
  });

  it('continuation prompts flip a recurring cluster to iterate', async () => {
    const storage = build([{
      prefix: 'feat', ask: 'build the onboarding wizard flow', n: 3, stepMs: 3 * HOUR,
      extraHuman: ['keep going'],
    }]);
    const c = (await suggestLoops(storage)).candidates[0];
    expect(c.iterate.continuationSessions).toBe(3);
    expect(c.class).toBe('iterate');
  });
});

describe('suggestLoops — safety & noise', () => {
  it('marks a cluster mutating if any member changed files', async () => {
    const storage = build([{
      prefix: 'ref', ask: 'refactor the auth module structure', n: 3, stepMs: HOUR,
      digest: { filesChanged: ['auth.ts'], toolUsage: { Edit: 2 } },
    }]);
    expect((await suggestLoops(storage)).candidates[0].safety).toBe('mutating');
  });

  it('marks a cluster read-only when all members used only read tools', async () => {
    const storage = build([{
      prefix: 'aud', ask: 'audit the dependency tree for risks', n: 3, stepMs: DAY,
      digest: { toolUsage: { Read: 5, Grep: 2 }, filesChanged: [] },
    }]);
    expect((await suggestLoops(storage)).candidates[0].safety).toBe('read-only');
  });

  it('filters Aladeen\'s own test/harness fixtures', async () => {
    const storage = build([
      { prefix: 'noise', ask: 'create a file called hello.txt containing exactly hello', n: 3, stepMs: HOUR },
      { prefix: 'real', ask: 'summarize the open github issues for triage', n: 3, stepMs: DAY },
    ]);
    const r = await suggestLoops(storage);
    expect(r.noiseFiltered).toBe(3);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].label).not.toMatch(/hello/);
  });

  it('aggregates providers and ranks most-recurring first', async () => {
    const storage = build([
      { prefix: 'big', ask: 'review the open pull requests', n: 5, stepMs: 8 * HOUR, provider: 'codex' },
      { prefix: 'small', ask: 'update the changelog for the release', n: 3, stepMs: DAY },
    ]);
    const r = await suggestLoops(storage);
    expect(r.candidates[0].sessionCount).toBe(5);
    expect(r.candidates[0].providers).toEqual(['codex']);
  });
});

describe('suggestLoops — iteration 2: fan-out & intent passes', () => {
  it('excludes a near-simultaneous burst as parallel fan-out (not a loop)', async () => {
    const storage = build([{ prefix: 'fan', ask: 'review the phase plan critically', n: 4, stepMs: 5_000 }]);
    const r = await suggestLoops(storage);
    expect(r.candidates).toHaveLength(0);
    expect(r.fanoutFiltered).toBe(1);
  });

  it('treats overlapping wall-clock spans as fan-out even when starts are minutes apart', async () => {
    const storage = build([{ prefix: 'ov', ask: 'restructure the onboarding module', n: 3, stepMs: 5 * MIN, durationMs: 20 * MIN }]);
    const r = await suggestLoops(storage);
    expect(r.candidates).toHaveLength(0);
    expect(r.fanoutFiltered).toBe(1);
  });

  it('keeps a sequential burst (non-overlapping rapid re-runs) as a candidate', async () => {
    const storage = build([{ prefix: 'seq', ask: 'the linter failed, fix it', n: 3, stepMs: 6 * MIN, durationMs: 60_000 }]);
    const r = await suggestLoops(storage);
    expect(r.fanoutFiltered).toBe(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].source).toBe('ask-cluster');
  });

  it('intent pass surfaces a periodic /schedule candidate from differently-phrased asks', async () => {
    const storage = build([
      { prefix: 't0', ask: 'run the unit tests', n: 1, stepMs: DAY, startMs: T0 },
      { prefix: 't1', ask: 'execute the test suite please', n: 1, stepMs: DAY, startMs: T0 + 1 * DAY },
      { prefix: 't2', ask: 'check that vitest passes', n: 1, stepMs: DAY, startMs: T0 + 2 * DAY },
      { prefix: 't3', ask: 'make sure all specs are green', n: 1, stepMs: DAY, startMs: T0 + 3 * DAY },
      { prefix: 't4', ask: 'verify the coverage report', n: 1, stepMs: DAY, startMs: T0 + 4 * DAY },
    ]);
    const r = await suggestLoops(storage);
    const intent = r.candidates.find((c) => c.source === 'intent');
    expect(intent).toBeDefined();
    expect(intent!.mechanism).toBe('schedule');
    expect(intent!.sessionCount).toBe(5);
    expect(intent!.command).toContain('/schedule');
  });

  it('raises no intent candidate below the intent session floor', async () => {
    const storage = build([
      { prefix: 'u0', ask: 'run the unit tests', n: 1, stepMs: DAY, startMs: T0 },
      { prefix: 'u1', ask: 'execute the test suite', n: 1, stepMs: DAY, startMs: T0 + 1 * DAY },
      { prefix: 'u2', ask: 'check that vitest passes', n: 1, stepMs: DAY, startMs: T0 + 2 * DAY },
      { prefix: 'u3', ask: 'verify the coverage report', n: 1, stepMs: DAY, startMs: T0 + 3 * DAY },
    ]);
    const r = await suggestLoops(storage);
    expect(r.candidates.find((c) => c.source === 'intent')).toBeUndefined();
  });
});

describe('suggestLoops — honesty posture', () => {
  it('always states it suggests, never executes', async () => {
    const storage = build([{ prefix: 'x', ask: 'run the smoke checks again', n: 3, stepMs: HOUR }]);
    const r = await suggestLoops(storage);
    expect(r.guardrail).toMatch(/never creates or runs them/i);
    expect(r.markdown).toContain(r.guardrail);
  });

  it('returns an empty, honest report when nothing recurs', async () => {
    const storage = build([{ prefix: 'one', ask: 'do a one-off thing here', n: 1, stepMs: HOUR }]);
    const r = await suggestLoops(storage);
    expect(r.candidates).toHaveLength(0);
    expect(r.markdown).toMatch(/No recurring workflow/i);
  });
});
