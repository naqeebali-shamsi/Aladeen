import type { IngestStorage } from '../observability/storage.js';
import type { Lesson } from './lesson.js';
import type { DecayParams } from './decay.js';
import { runDetectors, type LessonCandidate } from './detectors.js';
import { consolidate } from './consolidate.js';
import { LessonStore } from './store.js';
import {
  measureLessons,
  formatMeasurement,
  type SessionObservation,
  type MeasureParams,
} from './measure.js';

// `aladeen learn` orchestration: ingested store -> Tier-0 detectors ->
// consolidation -> decay-ranked lesson store. Read-only over the ingested
// sessions; writes only under .aladeen/lessons/. Suggests, never executes —
// actuation is a separate explicit step (actuate.ts, `--apply`).

export interface LearnSummary {
  sessionsScanned: number;
  tracesMissing: number;
  candidates: number;
  created: number;
  reinforced: number;
  promoted: number;
  demoted: number;
  retired: number;
  resurrected: number;
  totalLessons: number;
  activeLessons: number;
  // Recurrence measurement over actuated lessons.
  measured: number;
  verified: number;
}

export interface LearnResult {
  summary: LearnSummary;
  lessons: Lesson[];
}

export interface LearnOptions {
  now?: Date;
  params?: DecayParams;
  measureParams?: MeasureParams;
}

export async function runLearn(
  storage: IngestStorage,
  store: LessonStore,
  opts: LearnOptions = {},
): Promise<LearnResult> {
  const now = opts.now ?? new Date();

  const digests = await storage.listDigests();
  const candidates: LessonCandidate[] = [];
  // One observation per scanned session, feeding recurrence measurement.
  // Built from the SAME detector pass that feeds consolidation, so the
  // candidateKeys here match exactly what lessons dedup on.
  const observations: SessionObservation[] = [];
  let tracesMissing = 0;

  for (const digest of digests) {
    const trace = await storage.loadTrace(digest.sessionId);
    if (!trace) {
      tracesMissing += 1;
      continue;
    }
    const sessionCandidates = runDetectors({ trace, digest });
    candidates.push(...sessionCandidates);
    observations.push({
      sessionId: trace.sessionId,
      timestampMs: parseTimestamp(trace.endedAt ?? trace.startedAt),
      candidateKeys: new Set(sessionCandidates.map((c) => c.candidateKey)),
    });
  }

  const existing = await store.list();
  const result = consolidate(existing, candidates, { now, params: opts.params });

  // Measure actuated lessons against the post-actuation session window and
  // flip improved ones to verified. Runs after consolidation so it sees the
  // freshest recurrence counts.
  const measured = measureLessons(result.lessons, observations, now, opts.measureParams);
  await store.writeAll(measured.lessons);

  const active = measured.lessons.filter((l) => l.status !== 'retired');
  return {
    summary: {
      sessionsScanned: digests.length,
      tracesMissing,
      candidates: candidates.length,
      created: result.created,
      reinforced: result.reinforced,
      promoted: result.promoted,
      demoted: result.demoted,
      retired: result.retired,
      resurrected: result.resurrected,
      totalLessons: measured.lessons.length,
      activeLessons: active.length,
      measured: measured.measured,
      verified: measured.verified,
    },
    lessons: measured.lessons,
  };
}

function parseTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function formatLearnSummary(s: LearnSummary): string {
  const lines = [
    `Scanned ${s.sessionsScanned} ingested session(s)`
      + (s.tracesMissing > 0 ? ` (${s.tracesMissing} digest(s) had no trace — reingest to fix)` : ''),
    `Detected ${s.candidates} candidate occurrence(s)`,
    `Lessons: ${s.totalLessons} total, ${s.activeLessons} active`
      + ` — ${s.created} created, ${s.reinforced} reinforced, ${s.retired} retired`
      + (s.resurrected > 0 ? `, ${s.resurrected} resurrected` : ''),
  ];
  if (s.promoted > 0 || s.demoted > 0) {
    lines.push(`Layers: ${s.promoted} promoted to long-term, ${s.demoted} demoted to short-term`);
  }
  if (s.measured > 0) {
    // `measured` includes already-verified lessons re-measured this run, so the
    // label must not claim they are all merely "actuated".
    lines.push(`Measured ${s.measured} actuated/verified lesson(s) for recurrence`
      + (s.verified > 0 ? `, ${s.verified} newly verified (post-actuation recurrence dropped)` : ' (accruing post-actuation sessions)'));
  }
  lines.push('', 'Next: `aladeen lessons` to review, `aladeen learn --apply` to write top lessons into AGENTS.md.');
  return lines.join('\n');
}

export interface FormatLessonsOptions {
  includeRetired?: boolean;
}

export function rankLessons(lessons: Lesson[]): Lesson[] {
  return [...lessons].sort((a, b) =>
    b.decay.retention - a.decay.retention
    || b.recurrence.sessionCount - a.recurrence.sessionCount
    || a.id.localeCompare(b.id));
}

export function formatLessons(lessons: Lesson[], opts: FormatLessonsOptions = {}): string {
  const active = lessons.filter((l) => l.status !== 'retired');
  const retired = lessons.filter((l) => l.status === 'retired');
  const shown = opts.includeRetired ? [...rankLessons(active), ...rankLessons(retired)] : rankLessons(active);

  if (lessons.length === 0) {
    return 'No lessons yet. Run `aladeen ingest <source>` then `aladeen learn`.';
  }

  const header = `LESSONS — ${active.length} active, ${retired.length} retired`
    + (opts.includeRetired || retired.length === 0 ? '' : ' (use --all to include retired)');
  const blocks = shown.map((l) => formatLessonLine(l));
  return [header, '', ...blocks].join('\n');
}

function formatLessonLine(l: Lesson): string {
  const scope = l.scope.universal
    ? `${l.scope.agentClis.join(', ')} — universal`
    : l.scope.agentClis.join(', ');
  const lastSeen = l.recurrence.lastSeenAt ? ` · last seen ${l.recurrence.lastSeenAt.slice(0, 10)}` : '';
  const meta = `id ${l.id} · ${l.recurrence.sessionCount} session(s), ${l.recurrence.eventCount} event(s)`
    + `${lastSeen} · ${l.decay.layer}-term · evidence ${l.evidence.length} ref(s)`;
  const lines = [
    `  ${retentionBar(l.decay.retention)} ${l.decay.retention.toFixed(2)}  ${l.status.toUpperCase()}  [${l.category}]  ${scope}`,
    `      ${l.statement}`,
    `      ${meta}`,
  ];
  if (l.measurement) lines.push(`      ${formatMeasurement(l.measurement)}`);
  lines.push('');
  return lines.join('\n');
}

function retentionBar(retention: number): string {
  const filled = Math.round(retention * 5);
  return '█'.repeat(filled) + '░'.repeat(5 - filled);
}
