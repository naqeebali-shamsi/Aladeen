import type { IngestStorage } from './storage.js';
import type { RunDigest, SessionTrace, SessionEvent, ErrorClass } from './session-trace.js';

// Replay primitive (v1, drill-down only).
//
// Given a patternFingerprint, return everything we know about every
// matching session: which files were touched, which tools were used,
// what the agent was asked, what failed and how. This is the human-eyeball
// foundation for a future auto-replay that will (eventually) suggest
// "do what session X did — it solved this same shape." We're not there
// yet — bucket sizes are still too small for confident suggestions, and
// the schema needs a few more ingesters worth of data before we can trust
// the signal.
//
// Output is a single markdown string. Markdown chosen because:
//   - greppable and diffable
//   - renders cleanly in terminals and editors both
//   - downstream "suggest a blueprint" agents can consume it directly
//     without re-parsing structured data

export interface ReplayResult {
  fingerprint: string;
  matchedDigests: RunDigest[];
  markdown: string;
}

export interface ReplayOptions {
  // Max sessions to deep-load. Default 10. Avoids reading huge traces if
  // the bucket is enormous; the digests still drive the rollups.
  maxDeepLoad?: number;
  // Max chars per sampled user_message excerpt. Default 200.
  maxExcerptChars?: number;
}

export async function replayFingerprint(
  rawFingerprint: string,
  storage: IngestStorage,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const allDigests = await storage.listDigests();
  const matches = matchFingerprint(rawFingerprint, allDigests);

  if (matches.length === 0) {
    return {
      fingerprint: rawFingerprint,
      matchedDigests: [],
      markdown: `# Replay ${rawFingerprint}\n\nNo sessions matched. Try \`aladeen report\` to see available fingerprints.\n`,
    };
  }

  const maxDeep = opts.maxDeepLoad ?? 10;
  const maxExcerpt = opts.maxExcerptChars ?? 200;

  const deepLoaded: Array<{ digest: RunDigest; trace: SessionTrace | null }> = [];
  for (const d of matches.slice(0, maxDeep)) {
    deepLoaded.push({ digest: d, trace: await storage.loadTrace(d.sessionId) });
  }

  const fingerprint = matches[0].patternFingerprint;
  const markdown = buildReplayMarkdown(fingerprint, matches, deepLoaded, maxExcerpt);

  return {
    fingerprint,
    matchedDigests: matches,
    markdown,
  };
}

// Prefix match when unambiguous. Exact match wins over prefix. Empty
// input returns no matches. Treats hex case-insensitively.
function matchFingerprint(input: string, digests: RunDigest[]): RunDigest[] {
  const lowered = input.toLowerCase();
  if (!lowered) return [];

  const exact = digests.filter((d) => d.patternFingerprint.toLowerCase() === lowered);
  if (exact.length > 0) return exact;

  const prefixed = digests.filter((d) => d.patternFingerprint.toLowerCase().startsWith(lowered));
  // Only return prefix matches if they all share the same full fingerprint —
  // otherwise the prefix is ambiguous and we shouldn't silently pick one.
  const distinctFingerprints = new Set(prefixed.map((d) => d.patternFingerprint));
  if (distinctFingerprints.size === 1) return prefixed;
  return [];
}

function buildReplayMarkdown(
  fingerprint: string,
  digests: RunDigest[],
  deep: Array<{ digest: RunDigest; trace: SessionTrace | null }>,
  maxExcerpt: number,
): string {
  const lines: string[] = [];
  lines.push(`# Replay ${fingerprint}`);
  lines.push('');

  // Shape summary — these fields are identical across all matches by
  // definition of the fingerprint, so we can read them off the first.
  const sample = digests[0];
  lines.push('## Shape');
  lines.push('');
  lines.push(`- **Agent CLI:** ${sample.agentCliName}`);
  lines.push(`- **Outcome:** ${sample.outcome}`);
  lines.push(`- **Matching sessions:** ${digests.length}`);
  lines.push('');

  // Cross-session aggregates.
  const fileTouchCount = new Map<string, number>();
  const toolUsageTotals: Record<string, number> = {};
  const errorClassTotals: Partial<Record<ErrorClass, number>> = {};
  let totalActiveMs = 0;
  let activeCount = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let costCount = 0;

  for (const d of digests) {
    for (const p of d.filesChanged) {
      fileTouchCount.set(p, (fileTouchCount.get(p) ?? 0) + 1);
    }
    for (const [tool, n] of Object.entries(d.toolUsage)) {
      toolUsageTotals[tool] = (toolUsageTotals[tool] ?? 0) + n;
    }
    for (const [cls, n] of Object.entries(d.errorCounts)) {
      if (n > 0) {
        errorClassTotals[cls as ErrorClass] = (errorClassTotals[cls as ErrorClass] ?? 0) + n;
      }
    }
    if (d.activeDurationMs != null) {
      totalActiveMs += d.activeDurationMs;
      activeCount += 1;
    }
    if (d.cost) {
      totalInput += d.cost.inputTokens ?? 0;
      totalOutput += d.cost.outputTokens ?? 0;
      costCount += 1;
    }
  }

  lines.push('## Aggregates across matching sessions');
  lines.push('');
  if (activeCount > 0) {
    lines.push(`- **Active duration:** total ${fmtMs(totalActiveMs)}, mean ${fmtMs(totalActiveMs / activeCount)} (n=${activeCount})`);
  }
  if (costCount > 0) {
    lines.push(`- **Tokens (sum):** input ${totalInput.toLocaleString()}, output ${totalOutput.toLocaleString()} (n=${costCount} with cost data)`);
  }
  if (Object.keys(errorClassTotals).length > 0) {
    const errStr = Object.entries(errorClassTotals)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([cls, n]) => `${cls}×${n}`)
      .join(', ');
    lines.push(`- **Errors:** ${errStr}`);
  }
  lines.push('');

  // Top tools.
  lines.push('## Tools used');
  lines.push('');
  const sortedTools = Object.entries(toolUsageTotals).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (sortedTools.length === 0) {
    lines.push('_no tool calls recorded_');
  } else {
    for (const [tool, n] of sortedTools) {
      lines.push(`- \`${tool}\` × ${n}`);
    }
  }
  lines.push('');

  // Most-touched files.
  lines.push('## Files touched across the bucket');
  lines.push('');
  const sortedFiles = Array.from(fileTouchCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  if (sortedFiles.length === 0) {
    lines.push('_no file changes recorded_');
  } else {
    for (const [path, n] of sortedFiles) {
      const suffix = n > 1 ? ` _(${n} sessions)_` : '';
      lines.push(`- \`${path}\`${suffix}`);
    }
  }
  lines.push('');

  // Per-session detail (deep-loaded only).
  lines.push(`## Sessions (showing ${deep.length}/${digests.length})`);
  lines.push('');
  for (const { digest, trace } of deep) {
    lines.push(`### \`${digest.sessionId}\``);
    lines.push('');
    const dur = digest.activeDurationMs != null ? fmtMs(digest.activeDurationMs) + ' active' : '—';
    lines.push(`- duration: ${dur}`);
    if (digest.toolFailureCount > 0) lines.push(`- tool failures: ${digest.toolFailureCount}`);
    if (digest.editLoops.length > 0) {
      const loopStr = digest.editLoops.map((l) => `\`${l.path}\` × ${l.editCount}`).join(', ');
      lines.push(`- edit loops: ${loopStr}`);
    }

    if (trace) {
      // First user message — the actual ask.
      const firstUser = trace.events.find((e) => e.kind === 'user_message');
      if (firstUser?.kind === 'user_message') {
        const excerpt = truncate(firstUser.text.trim().replace(/\s+/g, ' '), maxExcerpt);
        lines.push(`- ask: ${excerpt}`);
      }
      // First failed tool_result, if any.
      const firstFail = trace.events.find(
        (e): e is Extract<SessionEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && !e.ok,
      );
      if (firstFail) {
        const out = firstFail.output ? truncate(firstFail.output.replace(/\s+/g, ' '), maxExcerpt) : '_(no output captured)_';
        lines.push(`- first failure (\`${firstFail.errorClass ?? 'unknown'}\`): ${out}`);
      }
    } else {
      lines.push(`- _(trace not available on disk)_`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
