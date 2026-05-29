import { createHash } from 'node:crypto';
import type { SessionTrace, RunDigest, ErrorClass, SessionEvent } from './session-trace.js';
import { ERROR_CLASSES } from './session-trace.js';

// SessionTrace → RunDigest. Lossy, query-friendly projection.
//
// patternFingerprint algorithm (v2):
//   sha256(
//     agentCli.name
//     | outcome
//     | top-3 errorClasses by count, sorted alphabetically
//     | failure-rate bucket: 'none' | 'low' (<20%) | 'mid' (20-60%) | 'high' (>60%)
//     | hasEditLoops boolean
//   ).slice(0, 16)
//
// v1 also included top-5 file extensions per session, which made every
// bucket size 1 on real data — the per-session ext fingerprint was unique
// just because every session touches a different mix of files. v2 drops
// extensions entirely and bucketizes the failure-rate to make similar
// failure shapes collide regardless of which files they touched.

// Gap (ms) above which we treat consecutive events as separated by user
// idle time and exclude from activeDurationMs. 10 min picked because
// shorter gaps usually mean "agent is thinking / running tool" and longer
// gaps usually mean "user walked away / closed laptop / resumed next day."
export const IDLE_GAP_MS = 10 * 60 * 1000;

export function computeDigest(trace: SessionTrace): RunDigest {
  const toolUsage: Record<string, number> = {};
  const errorCounts: Record<ErrorClass, number> = Object.fromEntries(
    ERROR_CLASSES.map((c) => [c, 0]),
  ) as Record<ErrorClass, number>;
  const filesChanged = new Set<string>();
  const editsByPath = new Map<string, number>();
  let toolResultCount = 0;
  let toolFailureCount = 0;

  for (const event of trace.events) {
    switch (event.kind) {
      case 'tool_call':
        toolUsage[event.toolName] = (toolUsage[event.toolName] ?? 0) + 1;
        break;
      case 'tool_result':
        toolResultCount += 1;
        if (!event.ok) {
          toolFailureCount += 1;
          const cls = (event.errorClass as ErrorClass | undefined) ?? 'tool_error';
          if (ERROR_CLASSES.includes(cls)) {
            errorCounts[cls] += 1;
          }
        }
        break;
      case 'file_change':
        filesChanged.add(event.path);
        editsByPath.set(event.path, (editsByPath.get(event.path) ?? 0) + 1);
        break;
      case 'error':
        if (ERROR_CLASSES.includes(event.errorClass as ErrorClass)) {
          errorCounts[event.errorClass as ErrorClass] += 1;
        }
        break;
    }
  }

  // Edit loops: same file edited > 3 times in a single session. Threshold is
  // a v1 hand-pick; tune after first batch.
  const editLoops = Array.from(editsByPath.entries())
    .filter(([, n]) => n > 3)
    .map(([p, n]) => ({ path: p, editCount: n }))
    .sort((a, b) => b.editCount - a.editCount);

  return {
    sessionId: trace.sessionId,
    agentCliName: trace.agentCli.name,
    outcome: trace.outcome,
    durationMs: computeWallClockDurationMs(trace),
    activeDurationMs: computeActiveDurationMs(trace.events),
    toolUsage,
    errorCounts,
    filesChanged: Array.from(filesChanged),
    toolFailureCount,
    editLoops,
    cost: trace.cost,
    patternFingerprint: fingerprint(
      trace,
      errorCounts,
      toolResultCount,
      toolFailureCount,
      editLoops.length > 0,
    ),
  };
}

function computeWallClockDurationMs(trace: SessionTrace): number | undefined {
  if (!trace.startedAt || !trace.endedAt) return undefined;
  const start = Date.parse(trace.startedAt);
  const end = Date.parse(trace.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

// Walk timestamps in order, sum only gaps below IDLE_GAP_MS. Anything
// larger is excluded as idle/resume. Returns undefined when there aren't
// enough timestamps to compute anything.
function computeActiveDurationMs(events: SessionEvent[]): number | undefined {
  const stamps: number[] = [];
  for (const e of events) {
    if (e.timestamp) {
      const t = Date.parse(e.timestamp);
      if (!Number.isNaN(t)) stamps.push(t);
    }
  }
  if (stamps.length < 2) return undefined;
  stamps.sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1];
    if (gap < IDLE_GAP_MS) total += gap;
  }
  return total;
}

function bucketFailureRate(toolResults: number, toolFailures: number): string {
  if (toolResults === 0) return 'none';
  const rate = toolFailures / toolResults;
  if (rate === 0) return 'none';
  if (rate < 0.2) return 'low';
  if (rate < 0.6) return 'mid';
  return 'high';
}

function fingerprint(
  trace: SessionTrace,
  errorCounts: Record<ErrorClass, number>,
  toolResults: number,
  toolFailures: number,
  hasEditLoops: boolean,
): string {
  const topErrors = Object.entries(errorCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cls]) => cls)
    .sort();

  const input = [
    trace.agentCli.name,
    trace.outcome,
    topErrors.join(','),
    bucketFailureRate(toolResults, toolFailures),
    hasEditLoops ? 'loops' : 'no-loops',
  ].join('|');

  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
