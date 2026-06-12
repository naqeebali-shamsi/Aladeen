import type { Lesson, DecayState } from './lesson.js';

// FadeMem-style decay scoring, ported from the published math (arXiv
// 2601.18642) — the only LLM-free, fully-specified consolidation/forgetting
// design the ecosystem survey found. Everything here is pure: no clocks, no
// I/O; `now` is always injected.
//
// What was ported vs adapted (be honest about both):
//   PORTED  retention v(t) = v0 · exp(−λ · Δt^β) with adaptive
//           λ = λbase · exp(−μ · I), dual layers β=0.8 (long) / β=1.2
//           (short), promote/demote thresholds 0.7 / 0.3.
//   ADAPTED importance. FadeMem scores I = α·relevance + β·frequency +
//           γ·recency where relevance is embedding similarity to the current
//           query. A lesson store has no ambient query and v1 ships no
//           embeddings, so α=0 and the remaining weights renormalize:
//           I = wf·f/(1+f) + wr·recency. The α term can return later
//           behind a local-embeddings flag without schema changes.
//   ADAPTED parameters. FadeMem tuned for high-volume conversational
//           memory; lessons are low-volume and high-value. Defaults below
//           are derived so a MAXIMALLY important lesson (I=1) matches the
//           paper's published half-lives (~11.25d long / ~5d short) and an
//           unimportant one (I=0) forgets ~2× faster:
//             t_half = (ln2 / λ)^(1/β)
//             long:  β=0.8, t_half=11.25d → λ = ln2/11.25^0.8 ≈ 0.100
//             short: β=1.2, t_half=5d     → λ = ln2/5^1.2     ≈ 0.100
//           λbase=0.2 with μ=0.7 gives λ(I=1)=0.2·e^−0.7 ≈ 0.099. ✓
//           These are PROVISIONAL until recurrence measurement says
//           otherwise — treat as tunables, not truths.

export interface DecayParams {
  // Importance weights (sum should be 1; renormalized defensively).
  weightFrequency: number;
  weightRecency: number;
  // Recency halves every this many days since the lesson was last seen.
  recencyHalfLifeDays: number;
  // Adaptive forgetting rate: lambda = lambdaBase * exp(-mu * importance).
  lambdaBase: number;
  mu: number;
  // Layer exponents (FadeMem table: long-term decays sub-linearly).
  betaLong: number;
  betaShort: number;
  // Layer transitions on retention (FadeMem thresholds).
  promoteAt: number;
  demoteAt: number;
  // Below this retention a non-actuated lesson retires.
  retireFloor: number;
}

export const DEFAULT_DECAY_PARAMS: DecayParams = {
  weightFrequency: 0.5,
  weightRecency: 0.5,
  recencyHalfLifeDays: 14,
  lambdaBase: 0.2,
  mu: 0.7,
  betaLong: 0.8,
  betaShort: 1.2,
  promoteAt: 0.7,
  demoteAt: 0.3,
  retireFloor: 0.05,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

// I = wf · f/(1+f) + wr · 2^(−age/halfLife). `distinctSessions` is the
// frequency signal (how often the shape recurs), `lastSeenAt ?? createdAt`
// anchors recency — trace timestamps when the source had clocks, our own
// creation stamp otherwise (never invented mid-range values).
export function computeImportance(
  lesson: Pick<Lesson, 'recurrence' | 'provenance'>,
  now: Date,
  params: DecayParams = DEFAULT_DECAY_PARAMS,
): number {
  const weightSum = params.weightFrequency + params.weightRecency;
  const wf = weightSum > 0 ? params.weightFrequency / weightSum : 0.5;
  const wr = weightSum > 0 ? params.weightRecency / weightSum : 0.5;

  const f = lesson.recurrence.sessionCount;
  const frequencyTerm = f / (1 + f);

  const anchor = lesson.recurrence.lastSeenAt ?? lesson.provenance.createdAt;
  const anchorMs = Date.parse(anchor);
  const ageDays = Number.isNaN(anchorMs)
    ? 0
    : Math.max(0, (now.getTime() - anchorMs) / MS_PER_DAY);
  const recencyTerm = Math.pow(2, -ageDays / params.recencyHalfLifeDays);

  return clamp01(wf * frequencyTerm + wr * recencyTerm);
}

// v(t) = exp(−λ · Δt^β), λ = λbase · e^(−μI). v0 is 1: a lesson is fully
// retained at the moment it was last reinforced.
export function computeRetention(
  importance: number,
  ageDays: number,
  layer: 'short' | 'long',
  params: DecayParams = DEFAULT_DECAY_PARAMS,
): number {
  const lambda = params.lambdaBase * Math.exp(-params.mu * clamp01(importance));
  const beta = layer === 'long' ? params.betaLong : params.betaShort;
  const dt = Math.max(0, ageDays);
  return clamp01(Math.exp(-lambda * Math.pow(dt, beta)));
}

export interface DecayStep {
  decay: DecayState;
  // 'promote' short→long, 'demote' long→short, 'retire' below floor.
  // Status mutation is the caller's job — decay.ts knows nothing about
  // lifecycle rules like "actuated lessons never auto-retire".
  transition: 'none' | 'promote' | 'demote' | 'retire';
}

export function stepDecay(
  lesson: Pick<Lesson, 'recurrence' | 'provenance' | 'decay'>,
  now: Date,
  params: DecayParams = DEFAULT_DECAY_PARAMS,
): DecayStep {
  const importance = computeImportance(lesson, now, params);

  // Retention ages from the LESSON's lifecycle — the latest of creation and
  // last reinforcement — not from raw evidence time. Bootstrapping a fresh
  // store from a months-old session backlog must not produce dead-on-arrival
  // lessons (first dogfood run: 31 created, 31 instantly retired). Evidence
  // staleness still bites, just through the importance term: old patterns get
  // a low I, hence a fast λ, and fade within days unless new sessions
  // reinforce them. FadeMem has no backlog concept (it scores a live stream
  // where memory creation IS event time); this split is our adaptation.
  const ageDays = lifecycleAgeDays(lesson, now);

  const currentLayer = lesson.decay.layer;
  const retention = computeRetention(importance, ageDays, currentLayer, params);

  // Promotion needs corroboration (>=2 distinct sessions) on top of the
  // FadeMem retention threshold. Retention is 1 at age zero by construction,
  // so a freshly-created lesson would otherwise promote on its first step —
  // long-term residency must be earned through recurrence, not freshness.
  // (Deviation from the paper, which scores a continuous stream and has no
  // distinct-session concept.)
  const corroborated = lesson.recurrence.sessionCount >= 2;

  let transition: DecayStep['transition'] = 'none';
  let layer = currentLayer;
  if (retention < params.retireFloor) {
    transition = 'retire';
  } else if (currentLayer === 'short' && corroborated && retention >= params.promoteAt) {
    transition = 'promote';
    layer = 'long';
  } else if (currentLayer === 'long' && retention <= params.demoteAt) {
    transition = 'demote';
    layer = 'short';
  }

  return {
    decay: {
      layer,
      importance,
      retention,
      computedAt: now.toISOString(),
    },
    transition,
  };
}

function lifecycleAgeDays(
  lesson: Pick<Lesson, 'recurrence' | 'provenance'>,
  now: Date,
): number {
  const stamps = [lesson.recurrence.lastSeenAt, lesson.provenance.createdAt]
    .map((s) => (s ? Date.parse(s) : Number.NaN))
    .filter((ms) => !Number.isNaN(ms));
  if (stamps.length === 0) return 0;
  const anchorMs = Math.max(...stamps);
  return Math.max(0, (now.getTime() - anchorMs) / MS_PER_DAY);
}

// Fresh lessons start in the short-term layer at full retention — they must
// EARN long-term residency through recurrence (FadeMem's promote path).
export function initialDecayState(now: Date): DecayState {
  return {
    layer: 'short',
    importance: 0,
    retention: 1,
    computedAt: now.toISOString(),
  };
}
