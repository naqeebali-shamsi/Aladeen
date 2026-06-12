import {
  lessonIdFor,
  type Lesson,
  type Revision,
} from './lesson.js';
import type { LessonCandidate } from './detectors.js';
import {
  DEFAULT_DECAY_PARAMS,
  initialDecayState,
  stepDecay,
  type DecayParams,
} from './decay.js';

// Consolidation merges per-session LessonCandidates into the durable lesson
// set and advances decay for everything else. Pure: storage I/O lives in the
// caller (learn.ts), the clock is injected.
//
// The load-bearing property is IDEMPOTENCY: re-running `learn` over the same
// ingested store must not double-count. Distinctness is tracked in
// seenSessionIds — a candidate from an already-seen session is dropped
// before it can touch recurrence, evidence, or timestamps. `learn` is thus a
// pure function of (ingested sessions, clock); only decay moves between
// identical runs.

// Evidence is a bounded sample: the earliest refs prove origin, the latest
// prove the shape is still alive. Middle occurrences are represented by
// recurrence counts instead of refs.
const EVIDENCE_CAP = 20;
const EVIDENCE_HEAD = 5;

// Past this many distinct sessions we stop appending ids (and therefore stop
// counting NEW recurrence for the shape). A lesson reinforced by 1000
// sessions has nothing left to prove; the cap keeps lesson files bounded.
const SEEN_SESSIONS_CAP = 1000;

const FINGERPRINT_CAP = 20;

export interface ConsolidateOptions {
  now: Date;
  params?: DecayParams;
}

export interface ConsolidateResult {
  lessons: Lesson[];
  created: number;
  reinforced: number;
  promoted: number;
  demoted: number;
  retired: number;
  resurrected: number;
}

export function consolidate(
  existing: Lesson[],
  candidates: LessonCandidate[],
  opts: ConsolidateOptions,
): ConsolidateResult {
  const params = opts.params ?? DEFAULT_DECAY_PARAMS;
  const nowIso = opts.now.toISOString();

  // Never mutate the caller's lessons — consolidate returns a new set.
  const byKey = new Map<string, Lesson>();
  for (const lesson of existing) byKey.set(lesson.candidateKey, structuredClone(lesson));

  const grouped = new Map<string, LessonCandidate[]>();
  for (const c of candidates) {
    const group = grouped.get(c.candidateKey);
    if (group) group.push(c);
    else grouped.set(c.candidateKey, [c]);
  }

  const result: ConsolidateResult = {
    lessons: [],
    created: 0,
    reinforced: 0,
    promoted: 0,
    demoted: 0,
    retired: 0,
    resurrected: 0,
  };

  for (const [key, group] of grouped) {
    const lesson = byKey.get(key);
    if (!lesson) {
      byKey.set(key, createLesson(key, group, nowIso));
      result.created += 1;
      continue;
    }
    if (reinforceLesson(lesson, group, nowIso)) {
      result.reinforced += 1;
      if (lesson.status === 'retired') {
        // New evidence resurrects a retired lesson — recurrence outvotes decay.
        transitionStatus(lesson, 'corroborated', nowIso);
        result.resurrected += 1;
      }
    }
  }

  // Decay marches for every lesson, reinforced or not.
  for (const lesson of byKey.values()) {
    const step = stepDecay(lesson, opts.now, params);
    lesson.decay = step.decay;

    if (step.transition === 'promote') {
      result.promoted += 1;
      pushRevision(lesson, nowIso, 'layer:short->long');
    } else if (step.transition === 'demote') {
      result.demoted += 1;
      pushRevision(lesson, nowIso, 'layer:long->short');
    } else if (step.transition === 'retire') {
      // Actuated/verified lessons never auto-retire: they live on a surface
      // the user can see, and only recurrence measurement may judge them.
      if (lesson.status !== 'actuated' && lesson.status !== 'verified' && lesson.status !== 'retired') {
        transitionStatus(lesson, 'retired', nowIso);
        result.retired += 1;
      }
    }

    // Lifecycle catch-up: corroboration can arrive in the same run that
    // created the lesson (several sessions in one batch).
    if (lesson.status === 'hypothesis' && lesson.recurrence.sessionCount >= 2) {
      transitionStatus(lesson, 'corroborated', nowIso);
    }

    result.lessons.push(lesson);
  }

  return result;
}

function createLesson(key: string, group: LessonCandidate[], nowIso: string): Lesson {
  const first = group[0];
  const fresh: Lesson = {
    schemaVersion: '1',
    id: lessonIdFor(key),
    candidateKey: key,
    dims: first.dims,
    statement: first.statement,
    category: first.category,
    scope: { agentClis: [], universal: false },
    status: 'hypothesis',
    evidence: [],
    seenSessionIds: [],
    recurrence: { sessionCount: 1, eventCount: 1 },
    decay: initialDecayState(new Date(nowIso)),
    provenance: {
      createdAt: nowIso,
      source: `detector:${first.detectorId}@${first.detectorVersion}`,
    },
    revisions: [{ at: nowIso, change: 'created' }],
    actuation: undefined,
    targetFingerprints: [],
  };
  // Recurrence/evidence/scope all flow through the same merge path the
  // reinforcement case uses; start from zero and let it fill.
  fresh.recurrence.sessionCount = 0;
  fresh.recurrence.eventCount = 0;
  reinforceLesson(fresh, group, nowIso, /* recordRevision */ false);
  return fresh;
}

// Returns true when at least one candidate came from an unseen session.
function reinforceLesson(
  lesson: Lesson,
  group: LessonCandidate[],
  nowIso: string,
  recordRevision = true,
): boolean {
  const seen = new Set(lesson.seenSessionIds);
  const newOnes = group.filter((c) => !seen.has(c.sessionId));
  if (newOnes.length === 0) return false;
  if (lesson.seenSessionIds.length >= SEEN_SESSIONS_CAP) return false;

  // A detector can emit multiple candidates for the same key+session only if
  // buggy; collapse defensively by sessionId.
  const bySession = new Map<string, LessonCandidate>();
  for (const c of newOnes) if (!bySession.has(c.sessionId)) bySession.set(c.sessionId, c);

  for (const c of bySession.values()) {
    lesson.seenSessionIds.push(c.sessionId);
    lesson.recurrence.sessionCount += 1;
    lesson.recurrence.eventCount += Math.max(1, c.evidence.length);

    appendEvidence(lesson, c);

    if (!lesson.scope.agentClis.includes(c.agentCli)) {
      lesson.scope.agentClis.push(c.agentCli);
      lesson.scope.agentClis.sort();
    }

    if (c.patternFingerprint
      && !lesson.targetFingerprints.includes(c.patternFingerprint)
      && lesson.targetFingerprints.length < FINGERPRINT_CAP) {
      lesson.targetFingerprints.push(c.patternFingerprint);
    }

    if (c.observedAt) {
      if (!lesson.recurrence.firstSeenAt || c.observedAt < lesson.recurrence.firstSeenAt) {
        lesson.recurrence.firstSeenAt = c.observedAt;
      }
      if (!lesson.recurrence.lastSeenAt || c.observedAt > lesson.recurrence.lastSeenAt) {
        lesson.recurrence.lastSeenAt = c.observedAt;
      }
    }
  }

  lesson.scope.universal = lesson.scope.agentClis.length >= 2;
  if (recordRevision) {
    pushRevision(lesson, nowIso, `recurrence+${bySession.size}`);
  }
  return true;
}

function appendEvidence(lesson: Lesson, c: LessonCandidate): void {
  for (const ref of c.evidence.slice(0, 2)) {
    if (lesson.evidence.length < EVIDENCE_CAP) {
      lesson.evidence.push(ref);
    } else {
      // Keep the head (origin proof), rotate the tail (liveness proof).
      lesson.evidence.splice(EVIDENCE_HEAD, 1);
      lesson.evidence.push(ref);
    }
  }
}

function transitionStatus(lesson: Lesson, to: Lesson['status'], nowIso: string): void {
  if (lesson.status === to) return;
  pushRevision(lesson, nowIso, `status:${lesson.status}->${to}`);
  lesson.status = to;
}

function pushRevision(lesson: Lesson, at: string, change: string): void {
  const rev: Revision = { at, change };
  lesson.revisions.push(rev);
  // Revisions are an audit trail, not a transaction log — cap to the most
  // recent 50 with the original 'created' entry pinned.
  if (lesson.revisions.length > 50) {
    lesson.revisions = [lesson.revisions[0], ...lesson.revisions.slice(-49)];
  }
}
