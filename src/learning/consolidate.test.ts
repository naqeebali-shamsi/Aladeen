import { describe, it, expect } from 'vitest';
import { consolidate } from './consolidate.js';
import { LessonSchema, lessonIdFor, type Lesson } from './lesson.js';
import type { LessonCandidate } from './detectors.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');
const EARLIER = new Date('2026-06-10T12:00:00.000Z');

function candidate(opts: {
  sessionId: string;
  projectId?: string;
  key?: string;
  agentCli?: string;
  observedAt?: string;
  evidence?: number;
  fingerprint?: string;
}): LessonCandidate {
  const evidenceCount = opts.evidence ?? 1;
  return {
    detectorId: 'repeated-tool-failure',
    detectorVersion: '1',
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    candidateKey: opts.key ?? 'repeated-tool-failure|Bash|timeout',
    dims: { toolName: 'Bash', errorClass: 'timeout' },
    statement: 'Bash calls fail repeatedly with timeout.',
    category: 'model-mistake',
    agentCli: opts.agentCli ?? 'claude-code',
    evidence: Array.from({ length: evidenceCount }, (_, i) => ({ sessionId: opts.sessionId, seq: i })),
    observedAt: opts.observedAt ?? NOW.toISOString(),
    patternFingerprint: opts.fingerprint ?? 'fp-default',
  };
}

describe('consolidate — creation', () => {
  it('creates a hypothesis lesson from a single-session candidate', () => {
    const r = consolidate([], [candidate({ sessionId: 's1' })], { now: NOW });
    expect(r.created).toBe(1);
    expect(r.lessons).toHaveLength(1);
    const l = r.lessons[0];
    expect(l.id).toBe(lessonIdFor('repeated-tool-failure|Bash|timeout'));
    expect(l.status).toBe('hypothesis');
    expect(l.recurrence.sessionCount).toBe(1);
    expect(l.scope.universal).toBe(false);
    expect(l.seenSessionIds).toEqual(['s1']);
    expect(l.provenance.source).toBe('detector:repeated-tool-failure@1');
    expect(l.revisions[0].change).toBe('created');
  });

  it('corroborates immediately when one batch carries multiple sessions', () => {
    const r = consolidate(
      [],
      [candidate({ sessionId: 's1' }), candidate({ sessionId: 's2' })],
      { now: NOW },
    );
    const l = r.lessons[0];
    expect(l.status).toBe('corroborated');
    expect(l.recurrence.sessionCount).toBe(2);
  });

  it('flips universal when a second provider corroborates', () => {
    const r = consolidate(
      [],
      [
        candidate({ sessionId: 's1', agentCli: 'claude-code' }),
        candidate({ sessionId: 's2', agentCli: 'codex' }),
      ],
      { now: NOW },
    );
    expect(r.lessons[0].scope.agentClis).toEqual(['claude-code', 'codex']);
    expect(r.lessons[0].scope.universal).toBe(true);
  });
});

describe('consolidate — idempotency', () => {
  it('re-running over the same sessions changes nothing but decay timestamps', () => {
    const first = consolidate(
      [],
      [candidate({ sessionId: 's1' }), candidate({ sessionId: 's2' })],
      { now: EARLIER },
    );
    const second = consolidate(
      first.lessons,
      [candidate({ sessionId: 's1' }), candidate({ sessionId: 's2' })],
      { now: NOW },
    );
    expect(second.created).toBe(0);
    expect(second.reinforced).toBe(0);
    const before = first.lessons[0];
    const after = second.lessons[0];
    expect(after.recurrence.sessionCount).toBe(before.recurrence.sessionCount);
    expect(after.recurrence.eventCount).toBe(before.recurrence.eventCount);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.decay.computedAt).toBe(NOW.toISOString());
  });

  it('does not mutate the caller’s lesson objects', () => {
    const first = consolidate([], [candidate({ sessionId: 's1' })], { now: EARLIER });
    const snapshot = JSON.parse(JSON.stringify(first.lessons[0]));
    consolidate(first.lessons, [candidate({ sessionId: 's2' })], { now: NOW });
    expect(first.lessons[0]).toEqual(snapshot);
  });
});

describe('consolidate — reinforcement and decay', () => {
  it('reinforces with a new session and tracks recency forward only', () => {
    const first = consolidate([], [candidate({ sessionId: 's1', observedAt: EARLIER.toISOString() })], { now: EARLIER });
    const second = consolidate(
      first.lessons,
      [candidate({ sessionId: 's2', observedAt: NOW.toISOString() })],
      { now: NOW },
    );
    expect(second.reinforced).toBe(1);
    const l = second.lessons[0];
    expect(l.recurrence.sessionCount).toBe(2);
    expect(l.recurrence.firstSeenAt).toBe(EARLIER.toISOString());
    expect(l.recurrence.lastSeenAt).toBe(NOW.toISOString());
    expect(l.status).toBe('corroborated');
  });

  it('retires a stale non-actuated lesson and resurrects it on new evidence', () => {
    const first = consolidate(
      [],
      [candidate({ sessionId: 's1', observedAt: '2026-01-01T00:00:00.000Z' })],
      { now: new Date('2026-01-01T00:00:00.000Z') },
    );
    // Five months of silence → decay floors out.
    const decayed = consolidate(first.lessons, [], { now: NOW });
    expect(decayed.retired).toBe(1);
    expect(decayed.lessons[0].status).toBe('retired');

    const back = consolidate(
      decayed.lessons,
      [candidate({ sessionId: 's2', observedAt: NOW.toISOString() })],
      { now: NOW },
    );
    expect(back.resurrected).toBe(1);
    expect(back.lessons[0].status).toBe('corroborated');
  });

  it('never auto-retires an actuated lesson', () => {
    const first = consolidate(
      [],
      [candidate({ sessionId: 's1', observedAt: '2026-01-01T00:00:00.000Z' })],
      { now: new Date('2026-01-01T00:00:00.000Z') },
    );
    first.lessons[0].status = 'actuated';
    const later = consolidate(first.lessons, [], { now: NOW });
    expect(later.retired).toBe(0);
    expect(later.lessons[0].status).toBe('actuated');
    expect(later.lessons[0].decay.retention).toBeLessThan(0.05);
  });

  it('promotes to the long-term layer once corroborated at high retention', () => {
    const r = consolidate(
      [],
      [
        candidate({ sessionId: 's1' }),
        candidate({ sessionId: 's2' }),
        candidate({ sessionId: 's3' }),
      ],
      { now: NOW },
    );
    expect(r.promoted).toBe(1);
    expect(r.lessons[0].decay.layer).toBe('long');
  });
});

describe('consolidate — bounds', () => {
  it('caps evidence while recurrence keeps counting', () => {
    let lessons: Lesson[] = [];
    for (let i = 0; i < 30; i++) {
      lessons = consolidate(
        lessons,
        [candidate({ sessionId: `s${i}`, evidence: 3 })],
        { now: NOW },
      ).lessons;
    }
    const l = lessons[0];
    expect(l.recurrence.sessionCount).toBe(30);
    expect(l.evidence.length).toBeLessThanOrEqual(20);
    // Origin proof: the first session's refs survive rotation.
    expect(l.evidence[0].sessionId).toBe('s0');
    // Liveness proof: the latest session's refs are present.
    expect(l.evidence.some((e) => e.sessionId === 's29')).toBe(true);
  });

  it('collects distinct fingerprints up to the cap', () => {
    const r = consolidate(
      [],
      [
        candidate({ sessionId: 's1', fingerprint: 'fp-a' }),
        candidate({ sessionId: 's2', fingerprint: 'fp-b' }),
        candidate({ sessionId: 's3', fingerprint: 'fp-a' }),
      ],
      { now: NOW },
    );
    expect(r.lessons[0].targetFingerprints).toEqual(['fp-a', 'fp-b']);
  });
});


const PROJECT_A = 'project:' + 'a'.repeat(64);
const PROJECT_B = 'project:' + 'b'.repeat(64);
const SHAPE = 'repeated-tool-failure|Bash|timeout';

describe('consolidate project boundaries', () => {
  it('does not corroborate a shape using one session from each of two projects', () => {
    const result = consolidate([], [
      candidate({ sessionId: 'a1', projectId: PROJECT_A }),
      candidate({ sessionId: 'b1', projectId: PROJECT_B }),
    ], { now: NOW });
    expect(result.created).toBe(2);
    expect(result.lessons).toHaveLength(2);
    expect(result.lessons.every((lesson) => lesson.status === 'hypothesis')).toBe(true);
    expect(result.lessons.map((lesson) => lesson.scope.projectId)).toEqual([PROJECT_A, PROJECT_B]);
    expect(result.lessons.map((lesson) => lesson.id)).toEqual([
      lessonIdFor(`${PROJECT_A}|${SHAPE}`), lessonIdFor(`${PROJECT_B}|${SHAPE}`),
    ]);
    expect(result.lessons.every((lesson) => lesson.candidateKey === SHAPE)).toBe(true);
  });

  it('reinforces and deduplicates only inside the matching project', () => {
    const first = consolidate([], [
      candidate({ sessionId: 'a1', projectId: PROJECT_A, agentCli: 'codex' }),
      candidate({ sessionId: 'b1', projectId: PROJECT_B, agentCli: 'claude-code' }),
    ], { now: EARLIER });
    const second = consolidate(first.lessons, [
      candidate({ sessionId: 'a1', projectId: PROJECT_A, agentCli: 'codex' }),
      candidate({ sessionId: 'a2', projectId: PROJECT_A, agentCli: 'opencode' }),
      candidate({ sessionId: 'a2', projectId: PROJECT_A, agentCli: 'opencode' }),
    ], { now: NOW });
    const a = second.lessons.find((lesson) => lesson.scope.projectId === PROJECT_A)!;
    const b = second.lessons.find((lesson) => lesson.scope.projectId === PROJECT_B)!;
    expect(second.created).toBe(0);
    expect(second.reinforced).toBe(1);
    expect(a.status).toBe('corroborated');
    expect(a.seenSessionIds).toEqual(['a1', 'a2']);
    expect(a.scope.agentClis).toEqual(['codex', 'opencode']);
    expect(b.status).toBe('hypothesis');
    expect(b.seenSessionIds).toEqual(['b1']);
    expect(b.scope.agentClis).toEqual(['claude-code']);
    const repeated = consolidate(second.lessons, [
      candidate({ sessionId: 'a2', projectId: PROJECT_A, agentCli: 'opencode' }),
    ], { now: NOW });
    expect(repeated.reinforced).toBe(0);
    expect(repeated.lessons.map((lesson) => lesson.id)).toEqual(second.lessons.map((lesson) => lesson.id));
  });

  it('preserves unknown legacy lessons without attributing them to a new scoped session', () => {
    const legacy = consolidate([], [candidate({ sessionId: 's1' })], { now: EARLIER }).lessons[0];
    const snapshot = structuredClone(legacy);
    const result = consolidate([legacy], [
      candidate({ sessionId: 's2', projectId: PROJECT_A }),
      candidate({ sessionId: 's3' }),
    ], { now: NOW });
    expect(result.lessons).toHaveLength(2);
    const unknown = result.lessons.find((lesson) => !lesson.scope.projectId)!;
    const known = result.lessons.find((lesson) => lesson.scope.projectId === PROJECT_A)!;
    expect(unknown.id).toBe(lessonIdFor(SHAPE));
    expect(unknown.seenSessionIds).toEqual(['s1', 's3']);
    expect(known.status).toBe('hypothesis');
    expect(known.seenSessionIds).toEqual(['s2']);
    expect(legacy).toEqual(snapshot);
    expect(LessonSchema.safeParse(unknown).success).toBe(true);
    expect(LessonSchema.safeParse(known).success).toBe(true);
  });

  it('does not share distinct-session support even when session IDs match across project partitions', () => {
    const result = consolidate([], [
      candidate({ sessionId: 'same-id', projectId: PROJECT_A }),
      candidate({ sessionId: 'same-id', projectId: PROJECT_B }),
      candidate({ sessionId: 'same-id' }),
    ], { now: NOW });
    expect(result.lessons).toHaveLength(3);
    expect(new Set(result.lessons.map((lesson) => lesson.id)).size).toBe(3);
    expect(result.lessons.every((lesson) => lesson.recurrence.sessionCount === 1)).toBe(true);
  });

  it('schema preserves legacy records and validates scoped identities and optional measurement counters', () => {
    const lesson = consolidate([], [candidate({ sessionId: 's1', projectId: PROJECT_A })], { now: NOW }).lessons[0];
    expect(LessonSchema.parse(lesson).scope.projectId).toBe(PROJECT_A);
    lesson.scope.projectId = 'not-a-project';
    expect(LessonSchema.safeParse(lesson).success).toBe(false);
    delete lesson.scope.projectId;
    expect(LessonSchema.safeParse(lesson).success).toBe(true);
    lesson.measurement = {
      computedAt: NOW.toISOString(), appliedAt: NOW.toISOString(),
      preSessions: 1, preExhibiting: 1, preRate: 1,
      postSessions: 0, postExhibiting: 0, postRate: 0,
      excludedNoTimestamp: 0, verdict: 'insufficient-data',
    };
    expect(LessonSchema.safeParse(lesson).success).toBe(true);
    lesson.measurement.excludedScope = 3;
    lesson.measurement.duplicateObservations = 2;
    expect(LessonSchema.parse(lesson).measurement).toMatchObject({ excludedScope: 3, duplicateObservations: 2 });
    lesson.measurement.excludedScope = -1;
    expect(LessonSchema.safeParse(lesson).success).toBe(false);
  });
});
