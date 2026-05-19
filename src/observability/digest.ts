import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SessionTrace, RunDigest, ErrorClass } from './session-trace.js';
import { ERROR_CLASSES } from './session-trace.js';

// SessionTrace → RunDigest. Lossy, query-friendly projection.
//
// patternFingerprint algorithm (v1):
//   sha256(
//     agentCli.name
//     | outcome
//     | top-3 errorClasses by count, sorted alphabetically
//     | top-5 file extensions by edit count, sorted alphabetically
//   ).slice(0, 16)
//
// Cheap and stable. Two runs with the same fingerprint share the same
// failure shape at a coarse level — that's enough to bucket for review.
// Refine after first batch of real runs surfaces what's actually noisy.

export function computeDigest(trace: SessionTrace): RunDigest {
  const toolUsage: Record<string, number> = {};
  const errorCounts: Record<ErrorClass, number> = Object.fromEntries(
    ERROR_CLASSES.map((c) => [c, 0]),
  ) as Record<ErrorClass, number>;
  const filesChanged = new Set<string>();
  const editsByPath = new Map<string, number>();
  let toolFailureCount = 0;

  for (const event of trace.events) {
    switch (event.kind) {
      case 'tool_call':
        toolUsage[event.toolName] = (toolUsage[event.toolName] ?? 0) + 1;
        break;
      case 'tool_result':
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

  const durationMs = computeDurationMs(trace);

  return {
    sessionId: trace.sessionId,
    agentCliName: trace.agentCli.name,
    outcome: trace.outcome,
    durationMs,
    toolUsage,
    errorCounts,
    filesChanged: Array.from(filesChanged),
    toolFailureCount,
    editLoops,
    cost: trace.cost,
    patternFingerprint: fingerprint(trace, errorCounts, filesChanged),
  };
}

function computeDurationMs(trace: SessionTrace): number | undefined {
  if (!trace.startedAt || !trace.endedAt) return undefined;
  const start = Date.parse(trace.startedAt);
  const end = Date.parse(trace.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

function fingerprint(
  trace: SessionTrace,
  errorCounts: Record<ErrorClass, number>,
  filesChanged: Set<string>,
): string {
  const topErrors = Object.entries(errorCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cls]) => cls)
    .sort();

  const extCounts = new Map<string, number>();
  for (const p of filesChanged) {
    const ext = path.extname(p) || '(no-ext)';
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  const topExts = Array.from(extCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([e]) => e)
    .sort();

  const input = [
    trace.agentCli.name,
    trace.outcome,
    topErrors.join(','),
    topExts.join(','),
  ].join('|');

  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
