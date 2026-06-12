import type { Lesson, Measurement, MeasurementVerdict } from './lesson.js';

// Recurrence measurement — the step that turns an actuated lesson into a
// VERIFIED one (or surfaces that it isn't working). Pure: no I/O, clock
// injected.
//
// The question it answers, honestly: after this lesson's guardrail went into
// AGENTS.md at time T, did its failure shape recur in a SMALLER fraction of
// sessions than before T? We split every timestamped session into a
// pre-actuation and post-actuation window by its own clock, and compare the
// fraction of sessions exhibiting the lesson's candidateKey.
//
// This is OBSERVATIONAL, not a controlled experiment. Three honesty rules are
// baked in and must survive downstream rendering:
//   1. Always carry denominators (preSessions / postSessions). A rate with no
//      sample size is a lie.
//   2. Never claim causation. The shape was actuated because it was common, so
//      regression to the mean alone predicts some drop; session mix also drifts
//      for reasons unrelated to the guardrail.
//   3. Only `improved` with a real post-window sample flips actuated->verified.
//      `regressed` is surfaced, never auto-acted on (actuated lessons never
//      auto-retire — that invariant lives in consolidate.ts and is not weakened
//      here).

export interface MeasureParams {
  // Below this many post-actuation sessions, refuse to judge.
  minPostSessions: number;
  // Relative reduction (preRate-postRate)/preRate at/above which we call it
  // improved. 0.5 = "the shape now recurs in at most half as many sessions."
  improveThreshold: number;
  // Post rate must exceed pre rate by at least this relative margin to count
  // as regressed (a noise band so tiny upticks read as unchanged).
  regressMargin: number;
}

export const DEFAULT_MEASURE_PARAMS: MeasureParams = {
  minPostSessions: 5,
  improveThreshold: 0.5,
  regressMargin: 0.05,
};

// One ingested session, reduced to what measurement needs: when it happened
// and which lesson shapes it exhibited. Built by learn.ts from the same
// detector pass that feeds consolidation, so the candidateKeys here are
// exactly the keys consolidate.ts dedups on.
export interface SessionObservation {
  sessionId: string;
  // Epoch ms from trace.endedAt ?? trace.startedAt, or null when the source
  // carried no clock (those sessions can't be windowed and are excluded).
  timestampMs: number | null;
  candidateKeys: Set<string>;
}

// Measure one lesson. Returns null when the lesson has not been actuated
// (nothing to measure against) or its appliedAt is unparseable.
export function measureLesson(
  lesson: Pick<Lesson, 'candidateKey' | 'actuation'>,
  observations: SessionObservation[],
  now: Date,
  params: MeasureParams = DEFAULT_MEASURE_PARAMS,
): Measurement | null {
  if (!lesson.actuation) return null;
  const appliedMs = Date.parse(lesson.actuation.appliedAt);
  if (Number.isNaN(appliedMs)) return null;

  let preSessions = 0;
  let preExhibiting = 0;
  let postSessions = 0;
  let postExhibiting = 0;
  let excludedNoTimestamp = 0;

  for (const obs of observations) {
    if (obs.timestampMs === null) {
      excludedNoTimestamp += 1;
      continue;
    }
    const exhibits = obs.candidateKeys.has(lesson.candidateKey);
    if (obs.timestampMs < appliedMs) {
      preSessions += 1;
      if (exhibits) preExhibiting += 1;
    } else {
      postSessions += 1;
      if (exhibits) postExhibiting += 1;
    }
  }

  const preRate = preSessions > 0 ? preExhibiting / preSessions : 0;
  const postRate = postSessions > 0 ? postExhibiting / postSessions : 0;
  const relativeReduction = preRate > 0 ? (preRate - postRate) / preRate : undefined;

  const verdict = classify(preSessions, preRate, postRate, postSessions, relativeReduction, params);

  return {
    computedAt: now.toISOString(),
    appliedAt: lesson.actuation.appliedAt,
    preSessions,
    preExhibiting,
    preRate,
    postSessions,
    postExhibiting,
    postRate,
    relativeReduction,
    excludedNoTimestamp,
    verdict,
  };
}

function classify(
  preSessions: number,
  preRate: number,
  postRate: number,
  postSessions: number,
  relativeReduction: number | undefined,
  params: MeasureParams,
): MeasurementVerdict {
  if (postSessions < params.minPostSessions) return 'insufficient-data';
  // preRate === 0 → no relative baseline to divide by. Two very different
  // situations land here and MUST NOT be collapsed into 'unchanged':
  //   - preSessions === 0: no pre-actuation window at all → can't compare.
  //   - preSessions > 0 but the shape never occurred before actuation: a real
  //     baseline of zero. Any post-actuation occurrence is the shape APPEARING
  //     after the guardrail — a regression, not stasis (honesty invariant).
  if (relativeReduction === undefined) {
    if (preSessions === 0) return 'insufficient-data';
    return postRate > 0 ? 'regressed' : 'unchanged';
  }
  if (relativeReduction >= params.improveThreshold) return 'improved';
  if (postRate > preRate * (1 + params.regressMargin)) return 'regressed';
  return 'unchanged';
}

export interface MeasureResult {
  lessons: Lesson[];
  measured: number;   // lessons that got a measurement this pass
  verified: number;   // actuated -> verified transitions this pass
}

// Attach measurement to every actuated/verified lesson and flip actuated ->
// verified where the evidence supports it. Mutates clones, mirroring
// consolidate.ts's contract (learn.ts owns persistence).
export function measureLessons(
  lessons: Lesson[],
  observations: SessionObservation[],
  now: Date,
  params: MeasureParams = DEFAULT_MEASURE_PARAMS,
): MeasureResult {
  const nowIso = now.toISOString();
  let measured = 0;
  let verified = 0;

  const out = lessons.map((lesson) => {
    if (!lesson.actuation) return lesson;
    const measurement = measureLesson(lesson, observations, now, params);
    if (!measurement) return lesson;

    const next: Lesson = structuredClone(lesson);
    next.measurement = measurement;
    measured += 1;

    if (measurement.verdict === 'improved' && next.status === 'actuated') {
      next.revisions.push({ at: nowIso, change: 'status:actuated->verified' });
      next.status = 'verified';
      verified += 1;
    }
    return next;
  });

  return { lessons: out, measured, verified };
}

export function formatMeasurement(m: Measurement): string {
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  if (m.verdict === 'insufficient-data') {
    return `measured: insufficient post-actuation data (${m.postSessions} session(s) since `
      + `${m.appliedAt.slice(0, 10)}; need more to judge)`;
  }
  // relativeReduction > 0 means the shape recurred LESS after actuation; < 0
  // means MORE. Spell out the direction rather than leaning on a sign that
  // collides with the usual "negative = bad" reading.
  const change = m.relativeReduction === undefined
    ? ''
    : m.relativeReduction >= 0
      ? ` (${Math.round(m.relativeReduction * 100)}% less often)`
      : ` (${Math.abs(Math.round(m.relativeReduction * 100))}% more often)`;
  const excluded = m.excludedNoTimestamp > 0
    ? ` · ${m.excludedNoTimestamp} session(s) had no clock, excluded`
    : '';
  // The improved/verified path is the one most likely to be over-read as proof.
  // Surface the regression-to-mean caveat wherever the verdict renders, not just
  // in source comments — a common shape drops by reverting to its mean alone.
  const tail = m.verdict === 'improved'
    ? ' · observational, not causal (common shapes regress to the mean)'
    : ' · observational';
  return `measured: shape in ${pct(m.preRate)} of ${m.preSessions} pre-actuation session(s) → `
    + `${pct(m.postRate)} of ${m.postSessions} post${change}${excluded} · ${m.verdict}${tail}`;
}
