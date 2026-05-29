// Pure projection layer: RunDigest[] -> the single hero payload the dashboard
// renders (/api/digests.json). Every number here is DERIVED from the digests at
// call time — there are zero hardcoded hero literals. When the runaway-loop bug
// logs are re-ingested as fixed, the verdict relaxes ANOMALY -> DEGRADED ->
// NOMINAL with no code change. Kept pure (no I/O) so it unit-tests cleanly and
// the client ships no aggregation logic that could drift from the server.
//
// Mirrors the rollups the text `report.ts` and `replay.ts` already produce, so
// the dashboard and the CLI never disagree about what the corpus contains.

import {
  ERROR_CLASSES,
  type RunDigest,
  type ErrorClass,
  type SessionOutcome,
} from '../observability/session-trace.js';

// ── Verdict contract (NET-NEW, design-owned; see docs/design/DESIGN-SYSTEM.md §7) ──
//   ANOMALY  if any single session contributes > 100 of one errorClass
//   DEGRADED if toolFailingSessions / total > 0.25
//   NOMINAL  otherwise
export const ANOMALY_ERROR_THRESHOLD = 100;
export const DEGRADED_TOOL_FAIL_RATIO = 0.25;

export type VerdictLevel = 'NOMINAL' | 'DEGRADED' | 'ANOMALY';

export interface Anomaly {
  sessionId: string;
  errorClass: ErrorClass;
  count: number;
  agentCliName: string;
  outcome: SessionOutcome;
}

export interface Verdict {
  level: VerdictLevel;
  toolFailingSessions: number;
  total: number;
  toolFailingRatio: number;
  anomalies: Anomaly[];
}

export interface FingerprintBucket {
  fp: string;
  count: number;
  agentCliName: string;
  outcome: SessionOutcome;
  topError: ErrorClass | null;
  label: string;
  sampleSessionId: string;
  isFailure: boolean;
}

export interface LoopPair {
  a: string;
  b: string;
  aCount: number;
  bCount: number;
  ratio: number; // 1.0 == perfect lock-step
  sessions: number;
}

export interface ActiveTimeBin {
  bin: string;
  count: number;
}

export interface FileHotspot {
  basename: string;
  count: number;
  fullPaths: string[];
}

export interface Coverage {
  editLoops: number;
  cost: number;
  fileRefs: number;
  total: number;
}

export interface OverviewPayload {
  generatedAt: string;
  repoRoot: string;
  sessionCount: number;
  digests: RunDigest[];
  verdict: Verdict;
  outcomes: Record<string, number>;
  byCli: Record<string, number>;
  errorClasses: Record<string, number>;
  toolUsage: Record<string, number>;
  loopPairs: LoopPair[];
  fingerprints: FingerprintBucket[];
  activeTimeBins: ActiveTimeBin[];
  activeTimePercentiles: { p50: number | null; p90: number | null };
  fileHotspots: FileHotspot[];
  coverage: Coverage;
}

const FAILURE_OUTCOMES: ReadonlySet<SessionOutcome> = new Set([
  'errored',
  'interrupted',
  'gave_up',
]);

// ── Verdict ────────────────────────────────────────────────────────────────

export function deriveSystemStatus(digests: RunDigest[]): Verdict {
  const total = digests.length;
  const toolFailingSessions = digests.filter((d) => d.toolFailureCount > 0).length;
  const toolFailingRatio = total === 0 ? 0 : toolFailingSessions / total;

  const anomalies: Anomaly[] = [];
  for (const d of digests) {
    let worstClass: ErrorClass | null = null;
    let worstCount = 0;
    for (const cls of ERROR_CLASSES) {
      const n = d.errorCounts[cls] ?? 0;
      if (n > worstCount) {
        worstCount = n;
        worstClass = cls;
      }
    }
    if (worstClass && worstCount > ANOMALY_ERROR_THRESHOLD) {
      anomalies.push({
        sessionId: d.sessionId,
        errorClass: worstClass,
        count: worstCount,
        agentCliName: d.agentCliName,
        outcome: d.outcome,
      });
    }
  }
  anomalies.sort((a, b) => b.count - a.count);

  const level: VerdictLevel = anomalies.length > 0
    ? 'ANOMALY'
    : toolFailingRatio > DEGRADED_TOOL_FAIL_RATIO
      ? 'DEGRADED'
      : 'NOMINAL';

  return { level, toolFailingSessions, total, toolFailingRatio, anomalies };
}

// ── The single hero payload ──────────────────────────────────────────────────

export function buildOverview(
  digests: RunDigest[],
  generatedAt: string,
  repoRoot: string,
): OverviewPayload {
  return {
    generatedAt,
    repoRoot,
    sessionCount: digests.length,
    digests,
    verdict: deriveSystemStatus(digests),
    outcomes: rollupOutcomes(digests),
    byCli: rollupByCli(digests),
    errorClasses: rollupErrorClasses(digests),
    toolUsage: rollupToolUsage(digests),
    loopPairs: detectLoopPairs(digests),
    fingerprints: bucketFingerprints(digests),
    activeTimeBins: binActiveTime(digests),
    activeTimePercentiles: activeTimePercentiles(digests),
    fileHotspots: topFileHotspots(digests, 8),
    coverage: coverage(digests),
  };
}

// ── Rollups ──────────────────────────────────────────────────────────────────

function rollupOutcomes(digests: RunDigest[]): Record<string, number> {
  return sortRecordDesc(countBy(digests.map((d) => d.outcome)));
}

function rollupByCli(digests: RunDigest[]): Record<string, number> {
  return sortRecordDesc(countBy(digests.map((d) => d.agentCliName)));
}

function rollupErrorClasses(digests: RunDigest[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of digests) {
    for (const cls of ERROR_CLASSES) {
      const n = d.errorCounts[cls] ?? 0;
      if (n > 0) out[cls] = (out[cls] ?? 0) + n;
    }
  }
  return sortRecordDesc(out);
}

function rollupToolUsage(digests: RunDigest[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of digests) {
    for (const [tool, n] of Object.entries(d.toolUsage)) {
      out[tool] = (out[tool] ?? 0) + n;
    }
  }
  return sortRecordDesc(out);
}

// Deterministic-loop heuristic: a tool `t` whose paired `fix-<t>` is called in
// near-lockstep (|a-b|/max < 0.05) with both > 100 is a retry loop. Generalizes
// the lint <=> fix-lint pair without hardcoding it.
function detectLoopPairs(digests: RunDigest[]): LoopPair[] {
  const totals = rollupToolUsage(digests);
  const pairs: LoopPair[] = [];
  for (const [tool, aCount] of Object.entries(totals)) {
    const partner = `fix-${tool}`;
    const bCount = totals[partner];
    if (bCount === undefined) continue;
    const max = Math.max(aCount, bCount);
    if (max <= 100) continue;
    const drift = Math.abs(aCount - bCount) / max;
    if (drift >= 0.05) continue;
    const sessions = digests.filter(
      (d) => (d.toolUsage[tool] ?? 0) > 0 && (d.toolUsage[partner] ?? 0) > 0,
    ).length;
    pairs.push({ a: tool, b: partner, aCount, bCount, ratio: 1 - drift, sessions });
  }
  return pairs.sort((x, y) => Math.max(y.aCount, y.bCount) - Math.max(x.aCount, x.bCount));
}

// Group by patternFingerprint. The fingerprint is one-way sha256 (digest.ts),
// so the human label is read off a SAMPLE digest in the bucket — exactly the
// report.ts:60-66 pattern — never reversed from the hash.
function bucketFingerprints(digests: RunDigest[]): FingerprintBucket[] {
  const buckets = new Map<string, RunDigest[]>();
  for (const d of digests) {
    const arr = buckets.get(d.patternFingerprint) ?? [];
    arr.push(d);
    buckets.set(d.patternFingerprint, arr);
  }

  const rows: FingerprintBucket[] = [];
  for (const [fp, bucket] of buckets) {
    const sample = bucket[0];
    const topError = topErrorClass(sample);
    const isFailure =
      FAILURE_OUTCOMES.has(sample.outcome) || sample.toolFailureCount > 0;
    const label = [
      sample.agentCliName.toUpperCase(),
      sample.outcome,
      topError ?? 'CLEAN',
    ].join(' · ');
    rows.push({
      fp,
      count: bucket.length,
      agentCliName: sample.agentCliName,
      outcome: sample.outcome,
      topError,
      label,
      sampleSessionId: sample.sessionId,
      isFailure,
    });
  }
  return rows.sort((a, b) => b.count - a.count);
}

function topErrorClass(d: RunDigest): ErrorClass | null {
  let best: ErrorClass | null = null;
  let bestN = 0;
  for (const cls of ERROR_CLASSES) {
    const n = d.errorCounts[cls] ?? 0;
    if (n > bestN) {
      bestN = n;
      best = cls;
    }
  }
  return best;
}

// Log-decade bins over activeDurationMs (never durationMs / wall-clock — that
// includes idle days and lies about real work; see digest.ts IDLE_GAP_MS).
const ACTIVE_BINS: Array<{ bin: string; maxMs: number }> = [
  { bin: '<1s', maxMs: 1_000 },
  { bin: '1-10s', maxMs: 10_000 },
  { bin: '10s-1m', maxMs: 60_000 },
  { bin: '1-10m', maxMs: 600_000 },
  { bin: '10m-1h', maxMs: 3_600_000 },
  { bin: '1-4h', maxMs: 14_400_000 },
  { bin: '>4h', maxMs: Infinity },
];

function binActiveTime(digests: RunDigest[]): ActiveTimeBin[] {
  const counts = ACTIVE_BINS.map((b) => ({ bin: b.bin, count: 0 }));
  for (const d of digests) {
    const ms = d.activeDurationMs;
    if (ms == null) continue;
    const idx = ACTIVE_BINS.findIndex((b) => ms < b.maxMs);
    if (idx >= 0) counts[idx].count += 1;
  }
  return counts;
}

function activeTimePercentiles(digests: RunDigest[]): { p50: number | null; p90: number | null } {
  const values = digests
    .map((d) => d.activeDurationMs)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  if (values.length === 0) return { p50: null, p90: null };
  const pick = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
  return { p50: pick(0.5), p90: pick(0.9) };
}

function topFileHotspots(digests: RunDigest[], limit: number): FileHotspot[] {
  const byBase = new Map<string, { count: number; fullPaths: Set<string> }>();
  for (const d of digests) {
    // Count each basename once per session (presence), not per raw path repeat.
    const seen = new Set<string>();
    for (const p of d.filesChanged) {
      const base = basename(p);
      if (seen.has(base)) {
        byBase.get(base)?.fullPaths.add(p);
        continue;
      }
      seen.add(base);
      const entry = byBase.get(base) ?? { count: 0, fullPaths: new Set<string>() };
      entry.count += 1;
      entry.fullPaths.add(p);
      byBase.set(base, entry);
    }
  }
  return Array.from(byBase.entries())
    .map(([base, e]) => ({ basename: base, count: e.count, fullPaths: Array.from(e.fullPaths).slice(0, 5) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function coverage(digests: RunDigest[]): Coverage {
  return {
    editLoops: digests.filter((d) => d.editLoops.length > 0).length,
    cost: digests.filter((d) => d.cost && (d.cost.inputTokens != null || d.cost.estimatedUsd != null)).length,
    fileRefs: digests.filter((d) => d.filesChanged.length > 0).length,
    total: digests.length,
  };
}

// ── Small helpers (kept local; mirror report.ts so behaviour matches the CLI) ──

export function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

function sortRecordDesc(rec: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(rec).sort((a, b) => b[1] - a[1]));
}
