import { describe, it, expect } from 'vitest';
import { consolidate } from './consolidate.js';
import { lessonIdFor, type Lesson } from './lesson.js';
import type { LessonCandidate } from './detectors.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');
const EARLIER = new Date('2026-06-10T12:00:00.000Z');

function candidate(opts: {
  sessionId: string;
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
