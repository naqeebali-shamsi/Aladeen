import { ERROR_CLASSES } from '../observability/session-trace.js';
import { LessonSchema, type Lesson, type LessonCategory } from './lesson.js';

// Policy for built-in deterministic lessons with references resolved against
// regenerated detector evidence. This is not authentication of source transcripts
// or semantic owner-rule conflict checking. User inference remains held.
export const REVIEW_POLICY_VERSION = 'deterministic-v2-scoped-evidence';
// Conservative, provisional eligibility windows, not calibrated confidence or
// proof of causation. Expired evidence stays in memory but cannot auto-actuate.
export const MIN_REVIEW_RETENTION = 0.3;
export const MAX_EVIDENCE_AGE_DAYS = 30;
export const MAX_DECAY_AGE_DAYS = 2;
const DAY_MS = 86_400_000;
const SUPPORTED_PROVIDERS = new Set(['claude-code', 'opencode', 'codex', 'openclaw', 'aladeen']);
const DETECTORS = new Set([
  'repeated-tool-failure', 'edit-loop', 'interrupt-mid-action', 'error-storm',
  'completed-but-thrashed', 'vague-opening-ask', 'correction-followup', 'multi-intent-ask',
]);
const USER_DETECTORS = new Set([
  'interrupt-mid-action', 'vague-opening-ask', 'correction-followup', 'multi-intent-ask',
]);
const ELIGIBLE_STATUSES = new Set(['corroborated', 'actuated', 'verified']);
const SAFE_DIM = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,119}$/;
const ENVIRONMENT_ERRORS = new Set([
  'rate_limit', 'network', 'auth', 'binary_not_found', 'worktree_collision', 'permission_denied', 'timeout',
]);

export interface ReviewEvidence {
  sessionId: string;
  projectId?: string;
  agentCli: string;
  observedAt?: string;
  candidateKeys: ReadonlySet<string>;
  eventSeqs: ReadonlySet<number>;
  // Only coordinates actually emitted by this detector can support its lesson.
  // Optional for source compatibility; omission cannot authorize a write.
  candidateEvidence?: ReadonlyMap<string, ReadonlySet<number>>;
}

export interface ReviewContext {
  projectId?: string;
  evidence?: readonly ReviewEvidence[];
}

export interface LessonReviewDecision {
  lessonId: string;
  policyVersion: string;
  reviewedAt: string;
  verdict: 'approve' | 'hold' | 'reject';
  reasons: string[];
  distinctSessions: number;
  lessonProjectId?: string;
  targetProjectId?: string;
  resolvedEvidenceSessions: number;
}

export type ReviewDecision = LessonReviewDecision;

export function reviewLesson(lesson: Lesson, now: Date, context: ReviewContext = {}): LessonReviewDecision {
  const parsed = LessonSchema.safeParse(lesson);
  const decision: LessonReviewDecision = {
    lessonId: typeof lesson?.id === 'string' ? lesson.id : 'invalid',
    policyVersion: REVIEW_POLICY_VERSION,
    reviewedAt: now.toISOString(),
    verdict: 'approve',
    reasons: [],
    distinctSessions: parsed.success ? new Set(parsed.data.seenSessionIds).size : 0,
    lessonProjectId: parsed.success ? parsed.data.scope.projectId : undefined,
    targetProjectId: context.projectId,
    resolvedEvidenceSessions: 0,
  };
  const hold = (reason: string) => {
    if (decision.verdict !== 'reject') decision.verdict = 'hold';
    if (!decision.reasons.includes(reason)) decision.reasons.push(reason);
  };
  const reject = (reason: string) => {
    decision.verdict = 'reject';
    if (!decision.reasons.includes(reason)) decision.reasons.push(reason);
  };
  if (!parsed.success) {
    reject('invalid-lesson');
    return decision;
  }
  if (!lesson.scope.projectId) hold('missing-project-scope');
  if (!context.projectId) hold('missing-target-project');
  else if (lesson.scope.projectId && lesson.scope.projectId !== context.projectId) hold('project-mismatch');

  if (lesson.status === 'retired') reject('retired-lesson');
  else if (!ELIGIBLE_STATUSES.has(lesson.status)) hold('not-corroborated');

  const seen = new Set(lesson.seenSessionIds);
  const evidenceSessions = new Set(lesson.evidence.map((ref) => ref.sessionId));
  if (seen.size !== lesson.seenSessionIds.length) reject('duplicate-session-ids');
  if (seen.size !== lesson.recurrence.sessionCount) reject('inconsistent-session-count');
  if ([...seen].some((id) => !id.trim())) reject('invalid-session-id');
  if (seen.size < 2) hold('insufficient-distinct-sessions');
  if ([...evidenceSessions].some((id) => !seen.has(id))) reject('evidence-outside-seen-sessions');
  if (evidenceSessions.size < 2) hold('insufficient-evidence-sessions');
  if (lesson.recurrence.eventCount < Math.max(lesson.evidence.length, seen.size)) reject('inconsistent-event-count');
  if (lesson.evidence.some((ref) => ref.seq === undefined)) hold('missing-event-coordinates');
  const providers = new Set(lesson.scope.agentClis);
  if (providers.size === 0 || [...providers].some((provider) => !SUPPORTED_PROVIDERS.has(provider))) {
    reject('invalid-provider-scope');
  }
  if (providers.size !== lesson.scope.agentClis.length || lesson.scope.universal !== (providers.size >= 2)) {
    reject('inconsistent-provider-scope');
  }

  if (!context.evidence) {
    hold('evidence-not-validated');
  } else {
    const byId = new Map<string, ReviewEvidence>();
    const ambiguousIds = new Set<string>();
    for (const evidence of context.evidence) {
      if (byId.has(evidence.sessionId)) ambiguousIds.add(evidence.sessionId);
      else byId.set(evidence.sessionId, evidence);
    }
    const observedProviders = new Set<string>();
    const validSessions = new Set<string>();
    let latestSupportingAt: number | undefined;
    for (const sessionId of seen) {
      const evidence = byId.get(sessionId);
      if (!evidence) { hold('missing-source-session'); continue; }
      if (ambiguousIds.has(sessionId)) { hold('ambiguous-source-session'); continue; }
      if (!lesson.scope.projectId || evidence.projectId !== lesson.scope.projectId) {
        hold('evidence-project-mismatch'); continue;
      }
      if (!providers.has(evidence.agentCli)) { hold('evidence-provider-mismatch'); continue; }
      if (!evidence.candidateKeys.has(lesson.candidateKey)) { hold('unsupported-source-pattern'); continue; }
      if (!evidence.candidateEvidence?.has(lesson.candidateKey)) {
        hold('evidence-not-validated'); continue;
      }
      const observedAt = evidence.observedAt === undefined ? NaN : Date.parse(evidence.observedAt);
      if (!Number.isFinite(observedAt)) { hold('missing-source-timestamp'); continue; }
      if (observedAt > now.getTime()) { hold('future-source-timestamp'); continue; }
      latestSupportingAt = latestSupportingAt === undefined ? observedAt : Math.max(latestSupportingAt, observedAt);
      validSessions.add(sessionId);
      observedProviders.add(evidence.agentCli);
    }
    if (latestSupportingAt !== undefined) {
      if (now.getTime() - latestSupportingAt > MAX_EVIDENCE_AGE_DAYS * DAY_MS) hold('stale-source-evidence');
      if (!lesson.recurrence.lastSeenAt || Date.parse(lesson.recurrence.lastSeenAt) !== latestSupportingAt) {
        hold('inconsistent-evidence-timestamp');
      }
    }
    if ([...providers].some((provider) => !observedProviders.has(provider))) hold('unsubstantiated-provider-scope');
    const resolvedSessions = new Set<string>();
    for (const ref of lesson.evidence) {
      if (!validSessions.has(ref.sessionId)) continue;
      const evidence = byId.get(ref.sessionId)!;
      if (ref.seq === undefined || !evidence.eventSeqs.has(ref.seq)
        || !evidence.candidateEvidence!.get(lesson.candidateKey)!.has(ref.seq)) {
        hold('unresolved-event-evidence'); continue;
      }
      resolvedSessions.add(ref.sessionId);
    }
    decision.resolvedEvidenceSessions = resolvedSessions.size;
    if (resolvedSessions.size < 2) hold('insufficient-resolved-evidence');
  }

  // Never allow stored text to close the owned block or inject Markdown/HTML
  // structure. Exact template matching below is a second, separate boundary.
  const hasControlCharacter = [...lesson.statement].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (hasControlCharacter || /[<>]/.test(lesson.statement)) {
    reject('unsafe-statement-structure');
  }
  const source = /^detector:([a-z-]+)@1$/.exec(lesson.provenance.source);
  const detector = source?.[1];
  if (!detector || !DETECTORS.has(detector)) hold('unrecognized-provenance');
  else if (USER_DETECTORS.has(detector) || lesson.category === 'user-prompt') hold('user-inference-requires-review');
  else if (!matchesTrustedTemplate(lesson, detector)) hold('untrusted-detector-content');

  if (lesson.category === 'user-prompt' && !decision.reasons.includes('user-inference-requires-review')) {
    hold('user-inference-requires-review');
  }
  if (lesson.measurement?.verdict === 'regressed') hold('recurrence-regressed');
  if (lesson.decay.retention < MIN_REVIEW_RETENTION) hold('low-retention');
  const evidenceAt = lesson.recurrence.lastSeenAt;
  if (!evidenceAt) hold('missing-evidence-timestamp');
  else if (Date.parse(evidenceAt) > now.getTime()) hold('future-evidence-timestamp');
  else if (now.getTime() - Date.parse(evidenceAt) > MAX_EVIDENCE_AGE_DAYS * DAY_MS) hold('stale-evidence');
  const decayAge = now.getTime() - Date.parse(lesson.decay.computedAt);
  if (decayAge < 0) hold('future-decay-timestamp');
  else if (decayAge > MAX_DECAY_AGE_DAYS * DAY_MS) hold('stale-decay');
  if (decision.verdict === 'approve') decision.reasons.push('supported-built-in-lesson');
  return decision;
}

export function reviewLessons(lessons: Lesson[], now: Date, context: ReviewContext = {}): LessonReviewDecision[] {
  return lessons.map((lesson) => reviewLesson(lesson, now, context));
}

function matchesTrustedTemplate(lesson: Lesson, detector: string): boolean {
  const dims = lesson.dims;
  let expected: string;
  let category: LessonCategory;
  let keys: string[];
  let key: string;
  switch (detector) {
    case 'repeated-tool-failure': {
      keys = ['toolName', 'errorClass'];
      if (!safeDimension(dims.toolName) || !knownError(dims.errorClass)) return false;
      key = `${detector}|${dims.toolName}|${dims.errorClass}`;
      category = 'model-mistake';
      expected = `\`${dims.toolName}\` calls fail repeatedly with \`${dims.errorClass}\` and identical retries do not change `
        + 'the outcome. Read the first failure\'s output and change approach — different arguments, '
        + 'a different tool, or fix the underlying state — before re-running.';
      break;
    }
    case 'edit-loop': {
      keys = ['file'];
      if (!safeDimension(dims.file) || dims.file === '.' || dims.file === '..') return false;
      key = `${detector}|${dims.file}`;
      category = 'model-mistake';
      expected = `\`${dims.file}\` gets re-edited many times within a session (edit loop). Read the file and plan `
        + 'one consolidated change instead of incremental retries — long edit chains track with thrash.';
      break;
    }
    case 'error-storm': {
      keys = ['errorClass'];
      if (!knownError(dims.errorClass) || dims.errorClass === 'unknown') return false;
      key = `${detector}|${dims.errorClass}`;
      category = ENVIRONMENT_ERRORS.has(dims.errorClass) ? 'environment' : 'model-mistake';
      expected = `\`${dims.errorClass}\` errors recur multiple times within single sessions. When the same error class `
        + 'repeats, stop and address the cause before continuing — repetition without a strategy '
        + 'change did not resolve it in observed sessions.';
      break;
    }
    case 'completed-but-thrashed': {
      keys = [];
      key = detector;
      category = 'process';
      expected = 'Sessions report success while burning a high tool-failure rate — completed outcomes hide '
        + 'thrash. Treat a high-failure "success" as a smell: tighten environment setup or split the '
        + 'task before trusting the pattern.';
      break;
    }
    default: return false;
  }
  return Object.keys(dims).length === keys.length
    && keys.every((name) => Object.hasOwn(dims, name))
    && lesson.candidateKey === key && lesson.category === category && lesson.statement === expected;
}

function safeDimension(value: string | undefined): value is string {
  return typeof value === 'string' && SAFE_DIM.test(value);
}
function knownError(value: string): boolean {
  return ERROR_CLASSES.some((error) => error === value);
}




