import type {
  SessionTrace,
  RunDigest,
  ErrorClass,
} from '../observability/session-trace.js';
import type { EvidenceRef, LessonCategory } from './lesson.js';

// Tier-0 deterministic detectors: pure functions over one ingested session
// that emit LessonCandidates — recurring-shape hypotheses with event-level
// evidence. No LLM, no I/O, no clocks. The LLM reflection pass (Tier-1,
// future) targets sessions these detectors flag; it does not replace them.
//
// Statement discipline (remedy.ts honesty invariant): a statement describes
// the observed SHAPE plus generic guidance. It never diagnoses a specific
// session, never invents causes, and never embeds counts — recurrence is
// rendered at display time from lesson.recurrence so re-learns don't churn
// prose. Statements must stay stable per candidateKey.
//
// candidateKey design: '<detectorId>|<dims>' and NEVER a sessionId or
// provider name. One key = one recurring shape; consolidate.ts merges
// occurrences across sessions and providers (scope.agentClis tracks where
// the evidence came from, and `universal` flips at >=2 providers).

export const DETECTOR_VERSION = '1';

export interface LessonCandidate {
  detectorId: string;
  detectorVersion: string;
  sessionId: string;
  candidateKey: string;
  dims: Record<string, string>;
  statement: string;
  category: LessonCategory;
  agentCli: string;
  evidence: EvidenceRef[];
  // Trace-derived only (endedAt ?? startedAt). Never invented.
  observedAt?: string;
  patternFingerprint: string;
}

export interface DetectorInput {
  trace: SessionTrace;
  digest: RunDigest;
}

// Cap evidence refs per candidate per session — one streak can be hundreds
// of events long (the 1930-attempt loop of run 690cbbfe says hello).
const EVIDENCE_PER_SESSION = 5;

// --- repeated-tool-failure -------------------------------------------------
// >=3 failed tool_results for the same tool without an intervening success
// OF THAT TOOL. Interleaved other-tool activity does not reset the streak:
// "tried Bash, failed, read a file, tried the same Bash again, failed" is
// still the retry-without-change shape.

const REPEATED_TOOL_FAILURE_THRESHOLD = 3;

export function detectRepeatedToolFailure(input: DetectorInput): LessonCandidate[] {
  const { trace } = input;
  const toolByCallId = new Map<string, string>();
  for (const e of trace.events) {
    if (e.kind === 'tool_call') toolByCallId.set(e.callId, e.toolName);
  }

  interface Streak { fails: number; seqs: number[]; errorClass: string }
  const streaks = new Map<string, Streak>();
  const fired = new Map<string, Streak>();

  for (const e of trace.events) {
    if (e.kind !== 'tool_result') continue;
    const tool = toolByCallId.get(e.callId);
    if (!tool) continue;
    if (e.ok) {
      streaks.delete(tool);
      continue;
    }
    const s = streaks.get(tool) ?? { fails: 0, seqs: [], errorClass: '' };
    s.fails += 1;
    if (s.seqs.length < EVIDENCE_PER_SESSION) s.seqs.push(e.seq);
    if (!s.errorClass && e.errorClass) s.errorClass = e.errorClass;
    streaks.set(tool, s);
    if (s.fails >= REPEATED_TOOL_FAILURE_THRESHOLD) {
      // Keep the longest streak per tool for evidence.
      const prev = fired.get(tool);
      if (!prev || s.fails > prev.fails) fired.set(tool, s);
    }
  }

  return Array.from(fired.entries()).map(([tool, s]) => {
    const errorClass = s.errorClass || 'tool_error';
    return makeCandidate(input, {
      detectorId: 'repeated-tool-failure',
      dims: { toolName: tool, errorClass },
      statement:
        `\`${tool}\` calls fail repeatedly with \`${errorClass}\` and identical retries do not change `
        + 'the outcome. Read the first failure\'s output and change approach — different arguments, '
        + 'a different tool, or fix the underlying state — before re-running.',
      category: 'model-mistake',
      evidence: s.seqs.map((seq) => ({ sessionId: trace.sessionId, seq })),
    });
  });
}

// --- edit-loop ---------------------------------------------------------------
// Lifts RunDigest.editLoops (same file edited >3 times in one session) into
// a per-file lesson. The file basename is the discriminating dim: the same
// file thrashing across many sessions is the signal worth surfacing.

export function detectEditLoop(input: DetectorInput): LessonCandidate[] {
  const { trace, digest } = input;
  return digest.editLoops.map((loop) => {
    const seqs: number[] = [];
    for (const e of trace.events) {
      if (e.kind === 'file_change' && e.path === loop.path && seqs.length < EVIDENCE_PER_SESSION) {
        seqs.push(e.seq);
      }
    }
    const base = baseName(loop.path);
    return makeCandidate(input, {
      detectorId: 'edit-loop',
      dims: { file: base },
      statement:
        `\`${base}\` gets re-edited many times within a session (edit loop). Read the file and plan `
        + 'one consolidated change instead of incremental retries — long edit chains track with thrash.',
      category: 'model-mistake',
      evidence: seqs.map((seq) => ({ sessionId: trace.sessionId, seq })),
    });
  });
}

// --- interrupt-mid-action ----------------------------------------------------
// A user-initiated interrupt while the agent was mid-action (last meaningful
// event was agent output or tool activity) — the human yanked the wheel.
// One candidate per session regardless of interrupt count; cross-session
// recurrence is what makes it a lesson.

export function detectInterruptMidAction(input: DetectorInput): LessonCandidate[] {
  const { trace } = input;
  const seqs: number[] = [];
  let prevMeaningful: string | undefined;
  for (const e of trace.events) {
    if (e.kind === 'session_start' || e.kind === 'session_end') continue;
    if (e.kind === 'interrupt') {
      if (
        e.initiator === 'user'
        && (prevMeaningful === 'agent_message' || prevMeaningful === 'tool_call' || prevMeaningful === 'tool_result')
        && seqs.length < EVIDENCE_PER_SESSION
      ) {
        seqs.push(e.seq);
      }
    } else {
      prevMeaningful = e.kind;
    }
  }
  if (seqs.length === 0) return [];
  return [makeCandidate(input, {
    detectorId: 'interrupt-mid-action',
    dims: {},
    statement:
      'Sessions get interrupted while the agent is mid-action — direction drifted from intent. '
      + 'Front-load constraints in the ask (target files, acceptance criteria, what NOT to touch) '
      + 'to cut mid-run corrections.',
    category: 'user-prompt',
    evidence: seqs.map((seq) => ({ sessionId: trace.sessionId, seq })),
  })];
}

// --- error-storm ---------------------------------------------------------------
// The same error class occurring >=3 times in one session, scattered or not.
// Suppressed for classes already claimed by repeated-tool-failure in the same
// session (that detector names the tool — strictly more actionable), and for
// 'unknown' (a storm of unclassified errors supports no honest statement).

const ERROR_STORM_THRESHOLD = 3;

const ERROR_CATEGORY: Record<string, LessonCategory> = {
  rate_limit: 'environment',
  network: 'environment',
  auth: 'environment',
  binary_not_found: 'environment',
  worktree_collision: 'environment',
  permission_denied: 'environment',
  timeout: 'environment',
  context_overflow: 'model-mistake',
  tool_error: 'model-mistake',
  parse_error: 'model-mistake',
  lint_loop: 'model-mistake',
  model_refusal: 'model-mistake',
};

export function detectErrorStorm(
  input: DetectorInput,
  suppressClasses: ReadonlySet<string> = new Set(),
): LessonCandidate[] {
  const { trace, digest } = input;
  const out: LessonCandidate[] = [];
  for (const [cls, count] of Object.entries(digest.errorCounts) as Array<[ErrorClass, number]>) {
    if (count < ERROR_STORM_THRESHOLD) continue;
    if (cls === 'unknown') continue;
    if (suppressClasses.has(cls)) continue;
    const seqs: number[] = [];
    for (const e of trace.events) {
      if (seqs.length >= EVIDENCE_PER_SESSION) break;
      if (e.kind === 'error' && e.errorClass === cls) seqs.push(e.seq);
      // Mirror digest.ts: a failed result with no class counts as tool_error.
      else if (e.kind === 'tool_result' && !e.ok && (e.errorClass ?? 'tool_error') === cls) seqs.push(e.seq);
    }
    out.push(makeCandidate(input, {
      detectorId: 'error-storm',
      dims: { errorClass: cls },
      statement:
        `\`${cls}\` errors recur multiple times within single sessions. When the same error class `
        + 'repeats, stop and address the cause before continuing — repetition without a strategy '
        + 'change did not resolve it in observed sessions.',
      category: ERROR_CATEGORY[cls] ?? 'environment',
      evidence: seqs.map((seq) => ({ sessionId: trace.sessionId, seq })),
    }));
  }
  return out;
}

// --- completed-but-thrashed ------------------------------------------------------
// outcome=completed with a high tool-failure rate: the outcome column says
// success, the path says thrash. This is the "completed-but-thrashed" signal
// from the v0.2.0 dogfood verdict — 37/37 'failure' buckets were
// outcome=completed, so outcome alone is a liar.

const THRASH_MIN_RESULTS = 10;
const THRASH_FAILURE_RATE = 0.4;

export function detectCompletedButThrashed(input: DetectorInput): LessonCandidate[] {
  const { trace, digest } = input;
  if (digest.outcome !== 'completed') return [];
  let results = 0;
  const failSeqs: number[] = [];
  for (const e of trace.events) {
    if (e.kind !== 'tool_result') continue;
    results += 1;
    if (!e.ok && failSeqs.length < EVIDENCE_PER_SESSION) failSeqs.push(e.seq);
  }
  if (results < THRASH_MIN_RESULTS) return [];
  if (digest.toolFailureCount / results < THRASH_FAILURE_RATE) return [];
  return [makeCandidate(input, {
    detectorId: 'completed-but-thrashed',
    dims: {},
    statement:
      'Sessions report success while burning a high tool-failure rate — completed outcomes hide '
      + 'thrash. Treat a high-failure "success" as a smell: tighten environment setup or split the '
      + 'task before trusting the pattern.',
    category: 'process',
    evidence: failSeqs.map((seq) => ({ sessionId: trace.sessionId, seq })),
  })];
}

// --- orchestration ---------------------------------------------------------------

export function runDetectors(input: DetectorInput): LessonCandidate[] {
  const repeated = detectRepeatedToolFailure(input);
  const claimedClasses = new Set(repeated.map((c) => c.dims.errorClass));
  return [
    ...repeated,
    ...detectEditLoop(input),
    ...detectInterruptMidAction(input),
    ...detectErrorStorm(input, claimedClasses),
    ...detectCompletedButThrashed(input),
  ];
}

function makeCandidate(
  input: DetectorInput,
  fields: {
    detectorId: string;
    dims: Record<string, string>;
    statement: string;
    category: LessonCategory;
    evidence: EvidenceRef[];
  },
): LessonCandidate {
  const dimPart = Object.values(fields.dims).join('|');
  return {
    detectorId: fields.detectorId,
    detectorVersion: DETECTOR_VERSION,
    sessionId: input.trace.sessionId,
    candidateKey: dimPart ? `${fields.detectorId}|${dimPart}` : fields.detectorId,
    dims: fields.dims,
    statement: fields.statement,
    category: fields.category,
    agentCli: input.trace.agentCli.name,
    evidence: fields.evidence,
    observedAt: input.trace.endedAt ?? input.trace.startedAt,
    patternFingerprint: input.digest.patternFingerprint,
  };
}

// Cross-platform basename: trace paths arrive in whatever separator the
// source OS used; node:path.basename only splits the host platform's.
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
