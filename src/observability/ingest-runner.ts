import { computeDigest } from './digest.js';
import { IngestStorage } from './storage.js';
import type { SessionTrace } from './session-trace.js';

// Common ingest pipeline shared by every `aladeen ingest <source>` CLI
// branch. Replaces ~30 lines of copy-paste per source with a single call.
//
// Each branch only needs to:
//   1. Construct its source-specific ingester
//   2. Resolve the source path (with default + --path override)
//   3. Discover targets via the ingester's own listSessions/listRunFiles/etc.
//   4. Call runIngestPipeline() with an `ingestOne` thunk wiring the
//      ingester's specific ingestFile/ingestSession signature

export interface IngestResult {
  trace: SessionTrace;
  warnings: string[];
}

export interface IngestPipelineOptions<T> {
  // Short canonical name for the source ('claude-code', 'opencode', etc.).
  // Used in the "Ingesting N <sourceLabel> ... from ..." header.
  sourceLabel: string;
  // The path/DB/dir the targets live in. Printed in the header.
  sourcePath: string;
  // 'session' (default) or 'run' — used in the trailing summary.
  itemLabel?: string;
  // Targets the ingester discovered. May be file paths, session metadata
  // objects, etc. — the pipeline doesn't care.
  targets: ReadonlyArray<T>;
  // Per-target ingest call. Wraps whatever ingestFile/ingestSession
  // signature the underlying ingester exposes.
  ingestOne(target: T): Promise<IngestResult>;
  // Stable identifier shown in the per-target log line and in error
  // messages. Receives the optional result so callers can prefer
  // result.trace.sessionId when the trace is available.
  displayId(target: T, result?: IngestResult): string;
  // Storage for traces + digests.
  storage: IngestStorage;
  // Suppress the per-target log lines and the header. Final summary
  // still prints. Default false.
  quiet?: boolean;
  // When true, print non-fatal warnings collected by the ingester.
  // Defaults to false because most ingesters' warnings are noisy on
  // healthy data; aladeen-runs opts in because its warnings carry
  // schema-drift signal worth surfacing.
  printWarnings?: boolean;
  // Test-injectable console sinks. Default to console.log / console.error /
  // console.warn so the CLI path is unchanged.
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface IngestPipelineSummary {
  total: number;
  ok: number;
  warn: number;
  errors: Array<{ id: string; error: string }>;
}

export async function runIngestPipeline<T>(opts: IngestPipelineOptions<T>): Promise<IngestPipelineSummary> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const err = opts.error ?? ((m: string) => console.error(m));
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const itemLabel = opts.itemLabel ?? 'session';

  if (!opts.quiet) {
    log(`Ingesting ${opts.targets.length} ${opts.sourceLabel} ${itemLabel}(s) from ${opts.sourcePath}\n`);
  }

  let ok = 0;
  let warnCount = 0;
  const errors: IngestPipelineSummary['errors'] = [];

  for (const target of opts.targets) {
    let result: IngestResult | undefined;
    let id = opts.displayId(target);
    try {
      result = await opts.ingestOne(target);
      id = opts.displayId(target, result);
      const digest = computeDigest(result.trace);
      await opts.storage.writeTrace(result.trace);
      await opts.storage.writeDigest(digest);
      ok += 1;
      warnCount += result.warnings.length;
      if (!opts.quiet) {
        const fails = digest.toolFailureCount > 0 ? ` toolFails=${digest.toolFailureCount}` : '';
        log(`  ok  ${id.padEnd(38)} events=${result.trace.events.length} outcome=${result.trace.outcome}${fails}`);
        if (opts.printWarnings && result.warnings.length > 0) {
          for (const w of result.warnings) warn(`  warn ${id}: ${w}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ id, error: msg });
      err(`  err ${id}: ${msg}`);
    }
  }

  log(`\nIngested ${ok}/${opts.targets.length} ${itemLabel}(s). Warnings: ${warnCount}.`);
  log(`Run \`aladeen report\` to see failure patterns.`);

  return { total: opts.targets.length, ok, warn: warnCount, errors };
}
