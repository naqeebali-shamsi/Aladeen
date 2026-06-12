import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DECAY_PARAMS,
  computeImportance,
  computeRetention,
  initialDecayState,
  stepDecay,
} from './decay.js';
import type { Lesson } from './lesson.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');

function lessonAt(opts: {
  sessions?: number;
  lastSeenDaysAgo?: number;
  layer?: 'short' | 'long';
}): Pick<Lesson, 'recurrence' | 'provenance' | 'decay'> {
  const lastSeenAt = opts.lastSeenDaysAgo === undefined
    ? undefined
    : new Date(NOW.getTime() - opts.lastSeenDaysAgo * 86_400_000).toISOString();
  return {
    recurrence: {
      sessionCount: opts.sessions ?? 1,
      eventCount: opts.sessions ?? 1,
      lastSeenAt,
    },
    // The lesson's lifecycle starts when it was last seen — retention ages
    // from max(createdAt, lastSeenAt), so fixtures keep them coherent.
    provenance: { createdAt: lastSeenAt ?? NOW.toISOString(), source: 'detector:test@1' },
    decay: { ...initialDecayState(NOW), layer: opts.layer ?? 'short' },
  };
}

describe('computeImportance', () => {
  it('grows monotonically with distinct-session frequency', () => {
    const one = computeImportance(lessonAt({ sessions: 1, lastSeenDaysAgo: 0 }), NOW);
    const five = computeImportance(lessonAt({ sessions: 5, lastSeenDaysAgo: 0 }), NOW);
    const fifty = computeImportance(lessonAt({ sessions: 50, lastSeenDaysAgo: 0 }), NOW);
    expect(five).toBeGreaterThan(one);
    expect(fifty).toBeGreaterThan(five);
    expect(fifty).toBeLessThanOrEqual(1);
  });

  it('halves the recency term at recencyHalfLifeDays', () => {
    // Isolate recency: frequency term is identical across both lessons.
    const fresh = computeImportance(lessonAt({ sessions: 1, lastSeenDaysAgo: 0 }), NOW);
    const aged = computeImportance(
      lessonAt({ sessions: 1, lastSeenDaysAgo: DEFAULT_DECAY_PARAMS.recencyHalfLifeDays }),
      NOW,
    );
    const freqTerm = 0.5 * (1 / 2); // wf * f/(1+f) with f=1
    expect(fresh - freqTerm).toBeCloseTo(0.5, 5); // wr * 2^0
    expect(aged - freqTerm).toBeCloseTo(0.25, 5); // wr * 2^-1
  });

  it('falls back to provenance.createdAt when the trace had no clocks', () => {
    const lesson = lessonAt({ sessions: 1 }); // lastSeenAt undefined
    expect(computeImportance(lesson, NOW)).toBeCloseTo(
      computeImportance(lessonAt({ sessions: 1, lastSeenDaysAgo: 0 }), NOW),
      10,
    );
  });
});

describe('computeRetention', () => {
  it('is full at age zero and decreases with age', () => {
    expect(computeRetention(0.5, 0, 'long')).toBe(1);
    const day2 = computeRetention(0.5, 2, 'long');
    const day20 = computeRetention(0.5, 20, 'long');
    expect(day2).toBeLessThan(1);
    expect(day20).toBeLessThan(day2);
  });

  it('retains important lessons longer at the same age', () => {
    expect(computeRetention(1, 10, 'long')).toBeGreaterThan(computeRetention(0, 10, 'long'));
  });

  it('reproduces the published FadeMem half-lives at maximum importance', () => {
    // Derivation in decay.ts: lambda(I=1) ≈ 0.099, so retention at the
    // paper's half-lives should land near 0.5 for each layer.
    expect(computeRetention(1, 11.25, 'long')).toBeCloseTo(0.5, 1);
    expect(computeRetention(1, 5, 'short')).toBeCloseTo(0.5, 1);
  });

  it('decays the short layer faster than the long layer past one day', () => {
    expect(computeRetention(0.5, 10, 'short')).toBeLessThan(computeRetention(0.5, 10, 'long'));
  });
});

describe('stepDecay transitions', () => {
  it('promotes a frequently-reinforced short-layer lesson', () => {
    const step = stepDecay(lessonAt({ sessions: 20, lastSeenDaysAgo: 0, layer: 'short' }), NOW);
    expect(step.transition).toBe('promote');
    expect(step.decay.layer).toBe('long');
    expect(step.decay.retention).toBeGreaterThanOrEqual(DEFAULT_DECAY_PARAMS.promoteAt);
  });

  it('never promotes an uncorroborated lesson, even at full retention', () => {
    const step = stepDecay(lessonAt({ sessions: 1, lastSeenDaysAgo: 0, layer: 'short' }), NOW);
    expect(step.decay.retention).toBe(1);
    expect(step.transition).toBe('none');
    expect(step.decay.layer).toBe('short');
  });

  it('demotes a long-layer lesson that decayed under the threshold', () => {
    // 20 days, single session: retention ≈ 0.20 — inside (retireFloor, demoteAt].
    const step = stepDecay(lessonAt({ sessions: 1, lastSeenDaysAgo: 20, layer: 'long' }), NOW);
    expect(step.transition).toBe('demote');
    expect(step.decay.layer).toBe('short');
  });

  it('retires below the floor instead of demoting', () => {
    const step = stepDecay(lessonAt({ sessions: 1, lastSeenDaysAgo: 365, layer: 'short' }), NOW);
    expect(step.transition).toBe('retire');
    expect(step.decay.retention).toBeLessThan(DEFAULT_DECAY_PARAMS.retireFloor);
  });

  it('treats an unparseable anchor as age zero rather than inventing decay', () => {
    const lesson = lessonAt({ sessions: 1 });
    lesson.recurrence.lastSeenAt = 'not-a-date';
    lesson.provenance.createdAt = 'also-not-a-date';
    const step = stepDecay(lesson, NOW);
    expect(step.decay.retention).toBe(1);
    expect(step.transition).toBe('none');
  });

  it('anchors retention on the lesson lifecycle, not stale evidence (backlog bootstrap)', () => {
    // Evidence from 90 days ago, but the lesson was created NOW (first learn
    // run over a historical backlog): full retention, no instant retirement.
    const lesson = lessonAt({ sessions: 1, lastSeenDaysAgo: 90 });
    lesson.provenance.createdAt = NOW.toISOString();
    const step = stepDecay(lesson, NOW);
    expect(step.decay.retention).toBe(1);
    expect(step.transition).toBe('none');
    // The staleness still registers — importance is low, so decay runs fast.
    expect(step.decay.importance).toBeLessThan(0.3);
  });

  it('stamps computedAt from the injected clock', () => {
    const step = stepDecay(lessonAt({ sessions: 1, lastSeenDaysAgo: 1 }), NOW);
    expect(step.decay.computedAt).toBe(NOW.toISOString());
  });
});
