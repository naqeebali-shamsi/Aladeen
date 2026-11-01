import { describe, it, expect } from 'vitest';
import {
  measureLesson,
  measureLessons,
  formatMeasurement,
  type SessionObservation,
} from './measure.js';
import type { Lesson, LessonStatus } from './lesson.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');
const APPLIED = '2026-04-01T00:00:00.000Z';
const APPLIED_MS = Date.parse(APPLIED);
const KEY = 'repeated-tool-failure|Bash|timeout';
const PROJECT = 'project:' + 'a'.repeat(64);
const OTHER_PROJECT = 'project:' + 'b'.repeat(64);

let n = 0;
function lesson(opts: { status?: LessonStatus; actuated?: boolean } = {}): Lesson {
  n += 1;
  return {
    schemaVersion: '1',
    id: `lesson-${n}`,
    candidateKey: KEY,
    dims: { toolName: 'Bash', errorClass: 'timeout' },
    statement: 'Bash fails repeatedly with timeout.',
    category: 'model-mistake',
    scope: { agentClis: ['claude-code'], universal: false, projectId: PROJECT },
    status: opts.status ?? 'actuated',
    evidence: [{ sessionId: 's1', seq: 0 }],
    seenSessionIds: ['s1'],
    recurrence: { sessionCount: 2, eventCount: 2 },
    decay: { layer: 'long', importance: 0.6, retention: 0.8, computedAt: NOW.toISOString() },
    provenance: { createdAt: APPLIED, source: 'detector:repeated-tool-failure@1' },
    revisions: [{ at: APPLIED, change: 'created' }],
    actuation: opts.actuated === false ? undefined : { target: 'agents-md', filePath: 'AGENTS.md', appliedAt: APPLIED },
    targetFingerprints: [],
  };
}

function obs(id: string, daysFromApplied: number, exhibits: boolean): SessionObservation {
  return {
    sessionId: id,
    projectId: PROJECT,
    agentCli: 'claude-code',
    timestampMs: APPLIED_MS + daysFromApplied * 86_400_000,
    candidateKeys: exhibits ? new Set([KEY]) : new Set(),
  };
}

// Build N pre and M post sessions with given exhibit-counts.
function window(prefix: string, total: number, exhibiting: number, side: 'pre' | 'post'): SessionObservation[] {
  const sign = side === 'pre' ? -1 : 1;
  return Array.from({ length: total }, (_, i) =>
    obs(`${prefix}-${i}`, sign * (i + 1), i < exhibiting));
}

describe('measureLesson', () => {
  it('returns null for a lesson that was never actuated', () => {
    expect(measureLesson(lesson({ actuated: false }), [], NOW)).toBeNull();
  });

  it('reports insufficient-data below the post-session floor', () => {
    const observations = [...window('pre', 20, 16, 'pre'), ...window('post', 3, 0, 'post')];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.verdict).toBe('insufficient-data');
    expect(m.postSessions).toBe(3);
    expect(m.preSessions).toBe(20);
  });

  it('reports improved when the post rate falls past the threshold', () => {
    // pre: 80% exhibit, post: 10% exhibit → 87.5% relative reduction.
    const observations = [...window('pre', 20, 16, 'pre'), ...window('post', 10, 1, 'post')];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.preRate).toBeCloseTo(0.8, 5);
    expect(m.postRate).toBeCloseTo(0.1, 5);
    expect(m.relativeReduction).toBeCloseTo(0.875, 3);
    expect(m.verdict).toBe('improved');
  });

  it('reports unchanged inside the noise band', () => {
    const observations = [...window('pre', 20, 10, 'pre'), ...window('post', 10, 5, 'post')];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.verdict).toBe('unchanged');
  });

  it('reports regressed when the post rate rises above the margin', () => {
    const observations = [...window('pre', 20, 6, 'pre'), ...window('post', 10, 9, 'post')];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.postRate).toBeGreaterThan(m.preRate);
    expect(m.verdict).toBe('regressed');
  });

  it('reports regressed when a shape ABSENT before actuation appears after (preRate 0)', () => {
    // The bug the pre-publish review caught: preExhibiting 0 with a non-zero
    // post rate must not be called "unchanged" — the shape appeared post-rule.
    const observations = [...window('pre', 10, 0, 'pre'), ...window('post', 6, 3, 'post')];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.preRate).toBe(0);
    expect(m.relativeReduction).toBeUndefined();
    expect(m.verdict).toBe('regressed');
  });

  it('reports insufficient-data when there is no pre-actuation window at all', () => {
    const observations = window('post', 8, 2, 'post');
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.preSessions).toBe(0);
    expect(m.relativeReduction).toBeUndefined();
    expect(m.verdict).toBe('insufficient-data');
  });

  it('reports unchanged when a shape absent before stays absent after (preRate and postRate 0)', () => {
    const observations = [...window('pre', 10, 0, 'pre'), ...window('post', 6, 0, 'post')];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.verdict).toBe('unchanged');
  });

  it('excludes sessions with no timestamp and counts them', () => {
    const observations: SessionObservation[] = [
      ...window('pre', 10, 8, 'pre'),
      ...window('post', 6, 0, 'post'),
      { sessionId: 'noclock', projectId: PROJECT, agentCli: 'claude-code', timestampMs: null, candidateKeys: new Set([KEY]) },
    ];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.excludedNoTimestamp).toBe(1);
    expect(m.preSessions + m.postSessions).toBe(16);
  });

  it('handles a session exactly at appliedAt as post-actuation', () => {
    const observations: SessionObservation[] = [
      ...window('pre', 10, 8, 'pre'),
      { sessionId: 'boundary', projectId: PROJECT, agentCli: 'claude-code', timestampMs: APPLIED_MS, candidateKeys: new Set([KEY]) },
      ...window('post', 5, 0, 'post'),
    ];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.postSessions).toBe(6); // boundary counts as post
  });
});

describe('measureLessons', () => {
  it('flips an actuated lesson to verified on improved, with an audit revision', () => {
    const observations = [...window('pre', 20, 16, 'pre'), ...window('post', 10, 1, 'post')];
    const r = measureLessons([lesson({ status: 'actuated' })], observations, NOW);
    expect(r.verified).toBe(1);
    expect(r.measured).toBe(1);
    expect(r.lessons[0].status).toBe('verified');
    expect(r.lessons[0].measurement?.verdict).toBe('improved');
    expect(r.lessons[0].revisions.at(-1)?.change).toBe('status:actuated->verified');
  });

  it('does not transition on insufficient-data, but still attaches the measurement', () => {
    const observations = [...window('pre', 20, 16, 'pre'), ...window('post', 2, 0, 'post')];
    const r = measureLessons([lesson({ status: 'actuated' })], observations, NOW);
    expect(r.verified).toBe(0);
    expect(r.lessons[0].status).toBe('actuated');
    expect(r.lessons[0].measurement?.verdict).toBe('insufficient-data');
  });

  it('never transitions on regressed and never retires (actuated lessons are sticky)', () => {
    const observations = [...window('pre', 20, 6, 'pre'), ...window('post', 10, 9, 'post')];
    const r = measureLessons([lesson({ status: 'actuated' })], observations, NOW);
    expect(r.verified).toBe(0);
    expect(r.lessons[0].status).toBe('actuated');
    expect(r.lessons[0].measurement?.verdict).toBe('regressed');
  });

  it('leaves non-actuated lessons untouched', () => {
    const r = measureLessons([lesson({ status: 'corroborated', actuated: false })], [], NOW);
    expect(r.measured).toBe(0);
    expect(r.lessons[0].measurement).toBeUndefined();
  });

  it('does not mutate the input lessons', () => {
    const input = [lesson({ status: 'actuated' })];
    const snapshot = JSON.parse(JSON.stringify(input[0]));
    const observations = [...window('pre', 20, 16, 'pre'), ...window('post', 10, 1, 'post')];
    measureLessons(input, observations, NOW);
    expect(input[0]).toEqual(snapshot);
  });

  it('re-measures an already-verified lesson without re-counting the transition', () => {
    const observations = [...window('pre', 20, 16, 'pre'), ...window('post', 10, 1, 'post')];
    const r = measureLessons([lesson({ status: 'verified' })], observations, NOW);
    expect(r.measured).toBe(1);
    expect(r.verified).toBe(0); // already verified — not a new transition
    expect(r.lessons[0].status).toBe('verified');
  });
});

describe('formatMeasurement', () => {
  it('renders the insufficient-data case with the post count', () => {
    const m = measureLesson(lesson(), [...window('pre', 10, 8, 'pre'), ...window('post', 2, 0, 'post')], NOW)!;
    expect(formatMeasurement(m)).toContain('insufficient post-actuation data (2 session(s)');
  });

  it('renders rates, denominators, direction, and the causality caveat for improved', () => {
    const m = measureLesson(lesson(), [...window('pre', 20, 16, 'pre'), ...window('post', 10, 1, 'post')], NOW)!;
    const line = formatMeasurement(m);
    expect(line).toContain('80% of 20 pre-actuation');
    expect(line).toContain('10% of 10 post');
    expect(line).toContain('88% less often');
    expect(line).toContain('observational, not causal');
  });

  it('spells regression as "more often" rather than a bare sign', () => {
    const m = measureLesson(lesson(), [...window('pre', 20, 6, 'pre'), ...window('post', 10, 9, 'post')], NOW)!;
    expect(formatMeasurement(m)).toContain('more often');
  });
});


describe('scoped recurrence boundaries', () => {
  it('does not let clean sessions from another project improve a rule', () => {
    const observations = [
      ...window('pre', 10, 8, 'pre'),
      ...window('post', 2, 2, 'post'),
      ...window('foreign', 50, 0, 'post').map((o) => ({ ...o, projectId: OTHER_PROJECT })),
    ];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.verdict).toBe('insufficient-data');
    expect(m.postSessions).toBe(2);
    expect(m.excludedScope).toBe(50);
  });

  it('only measures supported providers even when marked universal', () => {
    const input = lesson();
    input.scope.universal = true;
    input.scope.agentClis = ['claude-code', 'codex'];
    const observations = [
      ...window('pre', 10, 8, 'pre'),
      ...window('post', 2, 0, 'post').map((o) => ({ ...o, agentCli: 'codex' })),
      ...window('foreign', 20, 0, 'post').map((o) => ({ ...o, agentCli: 'openclaw' })),
    ];
    const m = measureLesson(input, observations, NOW)!;
    expect(m.postSessions).toBe(2);
    expect(m.verdict).toBe('insufficient-data');
    expect(m.excludedScope).toBe(20);
  });

  it('excludes observations with unknown project or provider identity', () => {
    const unknown = [
      { ...obs('unknown-project', 1, false), projectId: undefined },
      { ...obs('unknown-provider', 2, false), agentCli: undefined },
      { ...obs('empty-project', 3, false), projectId: '' },
    ];
    const m = measureLesson(lesson(), [...window('pre', 10, 8, 'pre'), ...unknown], NOW)!;
    expect(m.postSessions).toBe(0);
    expect(m.excludedScope).toBe(3);
    expect(m.verdict).toBe('insufficient-data');
  });

  it('unknown provider labels cannot become measurement authority', () => {
    const input = lesson();
    input.scope.agentClis = ['unknown-provider'];
    const observations = window('post', 10, 0, 'post').map((o) => ({ ...o, agentCli: 'unknown-provider' }));
    const m = measureLesson(input, observations, NOW)!;
    expect(m.postSessions).toBe(0);
    expect(m.excludedScope).toBe(10);
    expect(m.verdict).toBe('insufficient-data');
  });

  it('legacy unscoped lessons cannot become verified from scoped sessions', () => {
    const input = lesson({ status: 'actuated' });
    delete input.scope.projectId;
    const r = measureLessons([input], [...window('pre', 10, 8, 'pre'), ...window('post', 10, 0, 'post')], NOW);
    expect(r.verified).toBe(0);
    expect(r.lessons[0].measurement).toMatchObject({ verdict: 'insufficient-data', excludedScope: 20 });
    expect(r.lessons[0].status).toBe('actuated');
  });

  it('identical duplicates cannot inflate the post-session floor', () => {
    const one = obs('same', 1, false);
    const observations = [...window('pre', 10, 8, 'pre'), ...Array.from({ length: 8 }, () => structuredClone(one))];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(m.postSessions).toBe(1);
    expect(m.duplicateObservations).toBe(7);
    expect(m.verdict).toBe('insufficient-data');
  });

  it('conflicting copies exclude the whole session regardless of input order', () => {
    const first = obs('conflict', 1, false);
    const second = obs('conflict', 1, true);
    const baseline = [...window('pre', 10, 8, 'pre'), ...window('post', 4, 0, 'post')];
    const a = measureLesson(lesson(), [...baseline, first, second], NOW)!;
    const b = measureLesson(lesson(), [...baseline, second, first], NOW)!;
    expect(a).toEqual(b);
    expect(a.postSessions).toBe(4);
    expect(a.duplicateObservations).toBe(2);
    expect(a.verdict).toBe('insufficient-data');
  });

  it('scope differences in duplicate IDs cannot select a favorable version', () => {
    const first = obs('conflict', 1, false);
    const second = { ...first, projectId: OTHER_PROJECT };
    const m = measureLesson(lesson(), [first, second], NOW)!;
    expect(m.postSessions).toBe(0);
    expect(m.duplicateObservations).toBe(2);
  });

  it('invalid, future, reversed and baseline-straddling clocks do not enter windows', () => {
    const invalid: SessionObservation[] = [
      { ...obs('nan', 1, false), timestampMs: Number.NaN },
      { ...obs('infinity', 1, false), timestampMs: Number.POSITIVE_INFINITY },
      { ...obs('future', 1, false), timestampMs: NOW.getTime() + 1 },
      { ...obs('reverse', 1, false), startedAtMs: APPLIED_MS + 2 * 86_400_000 },
      { ...obs('spans', 1, false), startedAtMs: APPLIED_MS - 1 },
      { ...obs('invalid-start', 1, false), startedAtMs: Number.NaN },
    ];
    const m = measureLesson(lesson(), [...window('pre', 10, 8, 'pre'), ...invalid], NOW)!;
    expect(m.postSessions).toBe(0);
    expect(m.excludedNoTimestamp).toBe(6);
    expect(m.verdict).toBe('insufficient-data');
  });

  it.each(['regressed', 'unchanged', 'insufficient-data'] as const)('withdraws verified status when current evidence is %s', (verdict) => {
    const post = verdict === 'regressed' ? window('post', 10, 10, 'post')
      : verdict === 'unchanged' ? window('post', 10, 8, 'post') : window('post', 2, 0, 'post');
    const r = measureLessons([lesson({ status: 'verified' })], [...window('pre', 10, 8, 'pre'), ...post], NOW);
    expect(r.lessons[0].measurement?.verdict).toBe(verdict);
    expect(r.lessons[0].status).toBe('actuated');
    expect(r.lessons[0].revisions.at(-1)?.change).toBe('status:verified->actuated');
    expect(r.verified).toBe(0);
  });

  it('preserves negative evidence for a withdrawn rule', () => {
    const observations = [...window('pre', 10, 2, 'pre'), ...window('post', 10, 10, 'post')];
    const input = lesson({ status: 'corroborated', actuated: false });
    input.measurement = measureLesson(lesson(), observations, NOW)!;
    const snapshot = structuredClone(input);
    const r = measureLessons([input], [], NOW);
    expect(r.measured).toBe(0);
    expect(r.lessons[0]).toEqual(snapshot);
    expect(r.lessons[0].measurement?.verdict).toBe('regressed');
  });

  it('renders scope and duplicate exclusions even when evidence is insufficient', () => {
    const single = obs('same', 1, false);
    const observations = [single, structuredClone(single), { ...obs('foreign', 2, false), projectId: OTHER_PROJECT }];
    const m = measureLesson(lesson(), observations, NOW)!;
    expect(formatMeasurement(m)).toContain('1 session(s) outside known project/provider scope');
    expect(formatMeasurement(m)).toContain('1 duplicate/conflicting observation(s)');
  });
});
