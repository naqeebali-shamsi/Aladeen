import type { RunDigest, SessionOutcome } from './session-trace.js';

// Text reporter: produces a terminal-friendly summary of ingested digests.
// Outputs a JSON-free human-readable view; consumers can also read the
// raw .digest.json files in .aladeen/ingested/digests/.
//
// Sections (ordered by signal):
//   1. Outcome distribution
//   2. Top failure fingerprints (the bucketed view)
//   3. Most-edited files across sessions (loop-prone areas)
//   4. Tool usage rollup
//   5. Per-session summary table

export interface ReportOptions {
  limitSessions?: number;
  // If true, only show sessions whose outcome != 'completed'. Default true —
  // the report is for failure pattern review, not victory laps.
  failuresOnly?: boolean;
}

export function formatReport(digests: RunDigest[], opts: ReportOptions = {}): string {
  if (digests.length === 0) {
    return 'No ingested sessions yet. Run `aladeen ingest claude-code` first.';
  }

  const lines: string[] = [];
  const heading = (s: string) => {
    lines.push('');
    lines.push(s);
    lines.push('─'.repeat(s.length));
  };

  heading(`Ingested sessions: ${digests.length}`);

  // 1. Outcome distribution
  const outcomes = countBy<SessionOutcome>(digests.map((d) => d.outcome));
  heading('Outcomes');
  for (const [outcome, count] of sortByCountDesc(outcomes)) {
    lines.push(`  ${outcome.padEnd(12)} ${count}`);
  }

  // 2. Failure fingerprints
  const failureDigests = digests.filter((d) =>
    d.outcome === 'errored' || d.outcome === 'interrupted' || d.outcome === 'gave_up' || d.toolFailureCount > 0,
  );
  const fingerprintBuckets = new Map<string, RunDigest[]>();
  for (const d of failureDigests) {
    const arr = fingerprintBuckets.get(d.patternFingerprint) ?? [];
    arr.push(d);
    fingerprintBuckets.set(d.patternFingerprint, arr);
  }
  const sortedBuckets = Array.from(fingerprintBuckets.entries()).sort(
    (a, b) => b[1].length - a[1].length,
  );

  heading(`Failure fingerprints: ${sortedBuckets.length}`);
  if (sortedBuckets.length === 0) {
    lines.push('  (none — no failures detected across ingested sessions)');
  } else {
    for (const [fp, bucket] of sortedBuckets.slice(0, 10)) {
      const sample = bucket[0];
      const topErrors = topEntries(sample.errorCounts, 3)
        .map(([cls, n]) => `${cls}×${n}`)
        .join(', ') || '(no classified errors)';
      lines.push(`  [${bucket.length}×] ${fp}  outcome=${sample.outcome}  errors=${topErrors}`);
      lines.push(`    sample sessions: ${bucket.slice(0, 3).map((b) => b.sessionId).join(', ')}`);
    }
  }

  // 3. Edit loops across sessions
  const editLoopRows: Array<{ sessionId: string; path: string; count: number }> = [];
  for (const d of digests) {
    for (const loop of d.editLoops) {
      editLoopRows.push({ sessionId: d.sessionId, path: loop.path, count: loop.editCount });
    }
  }
  editLoopRows.sort((a, b) => b.count - a.count);
  heading(`Edit loops (file edited >3× in one session): ${editLoopRows.length}`);
  if (editLoopRows.length === 0) {
    lines.push('  (none)');
  } else {
    for (const row of editLoopRows.slice(0, 10)) {
      lines.push(`  ${row.count}× ${row.path}  (${row.sessionId})`);
    }
  }

  // 4. Tool usage rollup
  const allTools: Record<string, number> = {};
  for (const d of digests) {
    for (const [tool, n] of Object.entries(d.toolUsage)) {
      allTools[tool] = (allTools[tool] ?? 0) + n;
    }
  }
  heading('Tool usage (total across sessions)');
  for (const [tool, count] of sortByCountDesc(allTools).slice(0, 12)) {
    lines.push(`  ${tool.padEnd(20)} ${count}`);
  }

  // 5. Per-session summary
  let summary = digests.slice();
  if (opts.failuresOnly !== false) {
    summary = summary.filter((d) => d.outcome !== 'completed' || d.toolFailureCount > 0);
  }
  summary.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  const limit = opts.limitSessions ?? 20;
  heading(`Sessions${opts.failuresOnly !== false ? ' (failures + had-tool-errors)' : ''}: showing top ${Math.min(limit, summary.length)} by duration`);
  if (summary.length === 0) {
    lines.push('  (none match)');
  } else {
    for (const d of summary.slice(0, limit)) {
      const dur = d.durationMs ? `${Math.round(d.durationMs / 1000)}s` : '—';
      const fails = d.toolFailureCount > 0 ? ` toolFails=${d.toolFailureCount}` : '';
      const loops = d.editLoops.length > 0 ? ` editLoops=${d.editLoops.length}` : '';
      lines.push(`  ${d.sessionId}  ${d.outcome.padEnd(11)}  ${dur.padStart(6)}${fails}${loops}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function countBy<T extends string>(items: T[]): Record<T, number> {
  const out: Partial<Record<T, number>> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out as Record<T, number>;
}

function sortByCountDesc(map: Record<string, number>): Array<[string, number]> {
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function topEntries(map: Record<string, number>, n: number): Array<[string, number]> {
  return sortByCountDesc(map)
    .filter(([, count]) => count > 0)
    .slice(0, n);
}
