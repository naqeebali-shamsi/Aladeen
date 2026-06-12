import { createHash } from 'node:crypto';
import { z } from 'zod';

// Lesson is the durable record of the learning layer: a distilled, recurring
// pattern mined from ingested SessionTraces, with enough provenance to audit
// every claim back to specific sessions and enough lifecycle state to decide
// what deserves space on an actuation surface (AGENTS.md / CLAUDE.md).
//
// Design lineage (see memory/research-agentic-memory.md for the survey):
//   - Record shape follows MemOS's MemCube pattern: content + provenance +
//     versioning + lifecycle, so lessons can be composed/migrated later.
//   - Ranking/pruning state follows FadeMem (arXiv 2601.18642): importance-
//     modulated exponential decay with short/long dual layers. Math lives in
//     decay.ts; this file only persists the computed state.
//   - JSON on disk (one file per lesson, mirroring .aladeen/ingested/) is the
//     canonical form. Semantic-Markdown export for Obsidian/basic-memory is a
//     WRITE-ONLY view — no YAML parser enters the dependency tree.
//
// Honesty invariants (inherited from remedy.ts):
//   - A statement describes an observed SHAPE, never a per-session diagnosis.
//   - Statements are stable per candidateKey: counts/recency live in
//     `recurrence` and are rendered at display time, never baked into prose.
//   - Lessons never auto-apply. Actuation is explicit (`learn --apply`) and
//     recorded here so future ingests can measure post-deploy recurrence.

export const LESSON_CATEGORIES = [
  'model-mistake',   // the agent's own behavior (retry storms, edit loops)
  'user-prompt',     // how the user steers (interrupts, vague asks)
  'environment',     // the machine/repo (missing deps, flaky tooling)
  'process',         // the workflow shape (thrash-but-completed, scope drift)
] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

// Lifecycle. Forward-only except `retired`, which decay can reach from any
// non-actuated state. `verified` is reserved for the recurrence-measurement
// step (post-actuation recurrence drop) — nothing sets it in v1.
export const LESSON_STATUSES = [
  'hypothesis',     // observed in 1 distinct session
  'corroborated',   // observed in >=2 distinct sessions
  'actuated',       // written to an actuation surface
  'verified',       // post-actuation recurrence measurably dropped (future)
  'retired',        // decayed below the retention floor; kept for audit
] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

// Pointer back into a stored SessionTrace. seq addresses the exact event so
// any lesson survives the "prove it" test the same way SourceRef does for
// ingested traces.
export const EvidenceRefSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int().nonnegative().optional(),
  note: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ProvenanceSchema = z.object({
  createdAt: z.string().datetime(),
  // 'detector:<id>@<version>' for Tier-0 deterministic detectors,
  // 'reflection:<model>' once the LLM pass exists, 'manual' for hand edits.
  source: z.string(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const RevisionSchema = z.object({
  at: z.string().datetime(),
  // Free-form but conventional: 'created', 'recurrence+<n>',
  // 'status:<from>-><to>', 'actuated:<target>'.
  change: z.string(),
});
export type Revision = z.infer<typeof RevisionSchema>;

// Persisted output of decay.ts. Recomputed on every `learn` run; stored so
// `lessons` can rank without re-deriving and so transitions are auditable.
export const DecayStateSchema = z.object({
  layer: z.enum(['short', 'long']),
  importance: z.number().min(0).max(1),
  retention: z.number().min(0).max(1),
  computedAt: z.string().datetime(),
});
export type DecayState = z.infer<typeof DecayStateSchema>;

export const ActuationSchema = z.object({
  target: z.enum(['agents-md', 'claude-md']),
  filePath: z.string(),
  appliedAt: z.string().datetime(),
});
export type Actuation = z.infer<typeof ActuationSchema>;

// Output of measure.ts. Observational, NOT causal: it reports the fraction of
// sessions exhibiting this lesson's shape before vs after actuation, split by
// real session timestamp against actuation.appliedAt. A drop is evidence the
// guardrail MAY be working; it is not proof (the shape was actuated because it
// was common, so some regression to the mean is expected, and session mix
// drifts for unrelated reasons). The UI must render it with denominators and
// never claim causation. Only `improved` with >= MIN_POST_SESSIONS flips a
// lesson actuated -> verified; nothing here ever retires a lesson.
export const MEASUREMENT_VERDICTS = [
  'insufficient-data',  // too few post-actuation sessions to say anything
  'improved',           // post rate fell materially below pre rate
  'unchanged',          // within the noise band
  'regressed',          // post rate rose above pre rate (surface, never auto-act)
] as const;
export type MeasurementVerdict = (typeof MEASUREMENT_VERDICTS)[number];

export const MeasurementSchema = z.object({
  computedAt: z.string().datetime(),
  appliedAt: z.string().datetime(),   // echoed from actuation for self-contained reads
  preSessions: z.number().int().nonnegative(),
  preExhibiting: z.number().int().nonnegative(),
  preRate: z.number().min(0).max(1),
  postSessions: z.number().int().nonnegative(),
  postExhibiting: z.number().int().nonnegative(),
  postRate: z.number().min(0).max(1),
  // (preRate - postRate) / preRate: the relative change in recurrence.
  // Positive = recurred LESS after actuation; NEGATIVE = recurred MORE
  // (regressed). Deliberately NOT bounded to [0,1] like the rates above — it
  // can go below 0. Absent when preRate is 0 (no baseline to divide by).
  relativeReduction: z.number().optional(),
  // Sessions dropped from both windows because the source carried no clock.
  excludedNoTimestamp: z.number().int().nonnegative(),
  verdict: z.enum(MEASUREMENT_VERDICTS),
});
export type Measurement = z.infer<typeof MeasurementSchema>;

export const LessonSchema = z.object({
  // Bump when this file changes incompatibly (mirrors SessionTrace).
  schemaVersion: z.literal('1'),
  // sha256(candidateKey) prefix — same convention as patternFingerprint, so
  // ids are stable across re-learns and across machines.
  id: z.string(),
  // Dedup join key: '<detectorId>|<discriminating dims>'. NEVER includes a
  // sessionId — a key identifies a recurring shape, not an occurrence.
  candidateKey: z.string(),
  // The discriminating dimensions, denormalized from candidateKey so
  // consumers (dashboard, export) don't parse the key.
  dims: z.record(z.string()),
  statement: z.string(),
  category: z.enum(LESSON_CATEGORIES),
  scope: z.object({
    // Providers the evidence came from ('claude-code', 'codex', ...).
    agentClis: z.array(z.string()),
    // True once >=2 distinct providers corroborate — a lesson learned on one
    // CLI is not assumed to transfer until a second one shows the same shape.
    universal: z.boolean(),
  }),
  status: z.enum(LESSON_STATUSES),
  // Capped sample (earliest + latest); full distinctness lives in
  // seenSessionIds. See consolidate.ts EVIDENCE_CAP.
  evidence: z.array(EvidenceRefSchema),
  // Every distinct session that exhibited the shape. This is what makes
  // re-running `learn` over the same store idempotent: candidates from
  // already-seen sessions are skipped entirely.
  seenSessionIds: z.array(z.string()),
  recurrence: z.object({
    sessionCount: z.number().int().positive(),
    eventCount: z.number().int().positive(),
    // Trace-derived timestamps only — never invented. Absent when sources
    // carry no clocks (decay falls back to provenance.createdAt).
    firstSeenAt: z.string().datetime().optional(),
    lastSeenAt: z.string().datetime().optional(),
  }),
  decay: DecayStateSchema,
  provenance: ProvenanceSchema,
  revisions: z.array(RevisionSchema),
  actuation: ActuationSchema.optional(),
  // Present only after a measure pass over an actuated lesson. Optional, so
  // lesson files written by v0.2.0 still parse unchanged (schemaVersion stays 1).
  measurement: MeasurementSchema.optional(),
  // patternFingerprints (digest.ts) observed alongside this lesson. The
  // future recurrence-measurement step watches these to score actuated
  // lessons; harmless bookkeeping until then.
  targetFingerprints: z.array(z.string()),
});
export type Lesson = z.infer<typeof LessonSchema>;

export function lessonIdFor(candidateKey: string): string {
  return createHash('sha256').update(candidateKey).digest('hex').slice(0, 16);
}
