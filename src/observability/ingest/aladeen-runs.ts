import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  SessionTraceSchema,
  type SessionEvent,
  type SessionTrace,
  type SessionOutcome,
  type ErrorClass,
} from '../session-trace.js';
import { Scrubber } from '../scrubber.js';
import { ExecutionStateSchema, type ExecutionState, type NodeResult } from '../../engine/types.js';
import { classifyError } from './_shared/classify-error.js';

// Aladeen-runs adds two domain-specific error classes the other ingesters
// never emit. They're passed to the shared classifier as extraClasses so
// they shadow `tool_error` for blueprint-engine failures without polluting
// the generic patterns used by claude-code / opencode / codex ingest.
const ALADEEN_EXTRA_ERROR_RULES = [
  { pattern: /lint|eslint|tsc.*error/, class: 'lint_loop' as const },
  { pattern: /worktree|fatal: '.*' is not a working tree/, class: 'worktree_collision' as const },
];

// Ingester for Aladeen's own blueprint runs. Reads ExecutionState JSON
// files from <repoRoot>/.aladeen/runs/ and converts each to a SessionTrace.
//
// This closes the observability loop: the same `aladeen report` /
// `aladeen replay` that surface failure patterns across Claude Code and
// opencode now also see what Aladeen itself ran. Pattern fingerprints
// computed across all three sources mean a Claude Code session that hit
// the same shape as a previous blueprint run could (eventually) be told
// "blueprint X solved this last time."
//
// Mapping ExecutionState → SessionTrace:
//   - Each NodeExecution's attempts become tool_call + tool_result pairs.
//     toolName = nodeId (deterministic) or adapterId-from-args
//     (agentic, recorded as `agentic:<nodeId>` so it's distinguishable
//     in tool usage rollups).
//   - NodeResult.outcome 'success' → ok=true; 'failure'/'retry' → ok=false.
//   - Run status maps: completed→completed, failed→errored,
//     escalated→gave_up, abandoned→gave_up, running→running, pending→unknown.

const RUN_FILE_RE = /\.json$/i;

export interface AladeenIngestResult {
  trace: SessionTrace;
  warnings: string[];
}

export class AladeenRunsIngester {
  constructor(private readonly scrubber: Scrubber = new Scrubber()) {}

  async listRunFiles(runsDir: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of entries) {
      if (RUN_FILE_RE.test(name)) out.push(path.join(runsDir, name));
    }
    return out;
  }

  async ingestFile(filePath: string): Promise<AladeenIngestResult> {
    const text = await readFile(filePath, 'utf-8');
    const stats = await stat(filePath);
    return this.ingestText(text, filePath, { mtime: stats.mtime });
  }

  ingestText(text: string, filePath: string, opts: { mtime?: Date } = {}): AladeenIngestResult {
    const warnings: string[] = [];
    const parsed = ExecutionStateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      warnings.push(
        `Run file failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
      // Best-effort fallback: try to extract the runId from the raw JSON.
      const rawObj = JSON.parse(text) as { runId?: string; blueprintId?: string };
      return {
        trace: makeStubTrace(rawObj.runId ?? path.basename(filePath, '.json'), rawObj.blueprintId, filePath),
        warnings,
      };
    }

    const state: ExecutionState = parsed.data as ExecutionState;
    const events: SessionEvent[] = [];
    let seq = 0;
    const nextSeq = () => seq++;

    const srcRef = () => ({ kind: 'aladeen-execution-state' as const, file: filePath });

    events.push({
      kind: 'session_start',
      seq: nextSeq(),
      source: srcRef(),
      timestamp: state.startedAt,
    });

    // Walk node executions in their startedAt order — the persisted
    // record preserves them as a flat object, so we re-sort by start time
    // to get a reasonable event stream. Nodes with no startedAt fall
    // back to insertion order.
    const nodeIds = Object.keys(state.nodeExecutions);
    nodeIds.sort((a, b) => {
      const ax = state.nodeExecutions[a]?.startedAt;
      const bx = state.nodeExecutions[b]?.startedAt;
      if (ax && bx) return Date.parse(ax) - Date.parse(bx);
      if (ax) return -1;
      if (bx) return 1;
      return 0;
    });

    for (const nodeId of nodeIds) {
      const exec = state.nodeExecutions[nodeId];
      if (!exec) continue;
      const startTs = exec.startedAt;
      const endTs = exec.completedAt;

      // One tool_call/tool_result pair per attempt — captures the retry
      // loop visibly in the digest's toolUsage count and bucketed
      // fingerprint (multiple failures of the same node bump failure rate).
      for (let attempt = 0; attempt < exec.results.length; attempt++) {
        const result = exec.results[attempt];
        const callId = `${nodeId}#${attempt + 1}`;
        events.push({
          kind: 'tool_call',
          seq: nextSeq(),
          timestamp: startTs,
          source: srcRef(),
          toolName: nodeId,
          callId,
          args: { attempt: attempt + 1, totalAttempts: exec.results.length },
        });

        const ok = result.outcome === 'success';
        const outputText = stringifyNodeResult(result);
        events.push({
          kind: 'tool_result',
          seq: nextSeq(),
          timestamp: endTs ?? startTs,
          source: srcRef(),
          callId,
          ok,
          output: outputText ? this.scrubber.scrubOutput(outputText).text : undefined,
          errorClass: ok ? undefined : classifyNodeError(result),
          durationMs: result.durationMs,
        });

        // Synthesize file_change when a deterministic file-write op
        // succeeded. ExecutionState only stores the op's output (path),
        // not the content, so contentSha256 stays undefined. Still useful
        // because the editLoops detector reads from file paths alone.
        if (ok) {
          const writtenPath = pickWrittenPath(nodeId, result);
          if (writtenPath) {
            events.push({
              kind: 'file_change',
              seq: nextSeq(),
              timestamp: endTs ?? startTs,
              source: srcRef(),
              action: 'edit',
              path: this.scrubber.scrubPath(writtenPath),
            });
          }
        }
      }
    }

    events.push({
      kind: 'session_end',
      seq: nextSeq(),
      source: srcRef(),
      timestamp: state.completedAt,
    });

    const outcome = mapStatusToOutcome(state.status, opts.mtime);

    const trace: SessionTrace = {
      schemaVersion: '1',
      sessionId: `aladeen:${state.runId}`,
      agentCli: {
        name: 'aladeen',
      },
      workspace: {
        cwdScrubbed: this.scrubber.scrubPath(state.context.cwd),
        gitRepoNameHash: createHash('sha256').update(state.context.cwd).digest('hex').slice(0, 16),
        gitBranch: null,
      },
      startedAt: state.startedAt,
      endedAt: state.completedAt,
      outcome,
      events,
      scrubbing: this.scrubber.manifest(),
      ingesterExtras: {
        aladeen: {
          // The load-bearing link: trace ↔ blueprint. Once we have many
          // ingested Aladeen runs and a Claude Code session bucket matches
          // their fingerprint, we can recommend the blueprint that solved
          // that shape last time.
          blueprintId: state.blueprintId,
          totalRetries: state.totalRetries,
          escalationReason: state.escalationReason,
          runPolicy: state.runPolicy,
        },
      },
    };

    const valid = SessionTraceSchema.safeParse(trace);
    if (!valid.success) {
      warnings.push(
        `Generated SessionTrace failed validation: ${valid.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    return { trace, warnings };
  }
}

function stringifyNodeResult(result: NodeResult): string | undefined {
  if (result.error) return result.error;
  if (result.summary) return result.summary;
  const stdout = (result.output as { stdout?: unknown })?.stdout;
  if (typeof stdout === 'string') return stdout;
  try {
    return JSON.stringify(result.output);
  } catch {
    return undefined;
  }
}

function pickWrittenPath(nodeId: string, result: NodeResult): string | undefined {
  // Deterministic file/write ops record the path in result.output.path.
  const out = result.output as { path?: unknown };
  if (typeof out?.path === 'string') return out.path;
  // Some nodes might encode the path in summary like "Wrote /abs/path".
  if (result.summary && /^Wrote\s+(.+)$/i.test(result.summary)) {
    return result.summary.replace(/^Wrote\s+/i, '').trim();
  }
  // nodeId hints — we don't reliably know which deterministic ops wrote
  // files without inspecting the blueprint, so we don't synthesize from
  // nodeId alone.
  void nodeId;
  return undefined;
}

function classifyNodeError(result: NodeResult): ErrorClass {
  const text = result.error ?? result.summary ?? '';
  return classifyError(text, ALADEEN_EXTRA_ERROR_RULES);
}

function mapStatusToOutcome(
  status: ExecutionState['status'],
  mtime?: Date,
): SessionOutcome {
  if (mtime && Date.now() - mtime.getTime() < 5 * 60 * 1000 && (status === 'running' || status === 'pending')) {
    return 'running';
  }
  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'errored';
    case 'escalated': return 'gave_up';
    case 'abandoned': return 'gave_up';
    case 'running': return 'running';
    case 'pending': return 'unknown';
  }
}

function makeStubTrace(runId: string, blueprintId: string | undefined, filePath: string): SessionTrace {
  return {
    schemaVersion: '1',
    sessionId: `aladeen:${runId}`,
    agentCli: { name: 'aladeen' },
    workspace: { cwdScrubbed: '(unknown)' },
    outcome: 'unknown',
    events: [],
    scrubbing: { passes: [] },
    ingesterExtras: { aladeen: { blueprintId, filePath, stub: true } },
  };
}
