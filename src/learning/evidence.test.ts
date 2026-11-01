import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeDigest } from '../observability/digest.js';
import { IngestStorage, sanitizeForFs } from '../observability/storage.js';
import type { SessionEvent, SessionTrace } from '../observability/session-trace.js';
import { loadReviewContext } from './evidence.js';
import { runLearn } from './learn.js';
import { reviewLessons } from './review.js';
import { projectIdForPath } from './scope.js';
import { LessonStore } from './store.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const SOURCE = { kind: 'codex-transcript', file: 'synthetic-fixture.jsonl' } as const;

function trace(sessionId: string, cwd: string, failing = true): SessionTrace {
  const events: SessionEvent[] = [
    { kind: 'session_start', seq: 0, source: SOURCE },
    { kind: 'user_message', seq: 1, source: SOURCE, text: 'Inspect config.json and verify the timeout setting.', origin: 'human' },
    ...(failing ? [2, 3, 4].map((seq): SessionEvent => ({
      kind: 'error', seq, source: SOURCE, errorClass: 'timeout', message: 'Synthetic timeout', fatal: false,
    })) : []),
  ];
  return {
    schemaVersion: '1', sessionId, agentCli: { name: 'codex' },
    workspace: { cwdScrubbed: cwd }, startedAt: '2026-11-02T11:50:00.000Z',
    endedAt: '2026-11-02T11:55:00.000Z', outcome: failing ? 'errored' : 'completed',
    events, scrubbing: { passes: [] },
  };
}

async function writeSession(storage: IngestStorage, session: SessionTrace): Promise<void> {
  await storage.writeTrace(session);
  await storage.writeDigest(computeDigest(session));
}

async function withFixture(check: (root: string, storage: IngestStorage, store: LessonStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'aladeen-evidence-'));
  try {
    await check(root, new IngestStorage(root), new LessonStore(root));
  } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('aladeen-evidence-')) {
      await rm(resolved, { recursive: true, force: true });
    }
  }
}

describe('stored trace evidence integration', () => {
  it('learns and approves a scoped rule using actual detector event coordinates from stored traces', async () => {
    await withFixture(async (root, storage, store) => {
      await writeSession(storage, trace('s1', root));
      await writeSession(storage, trace('s2', root));
      const learned = await runLearn(storage, store, { now: NOW });
      expect(learned.lessons).toHaveLength(1);
      expect(learned.lessons[0].scope.projectId).toBe(projectIdForPath(root));
      const context = await loadReviewContext(storage, root);
      expect(context.evidence).toHaveLength(2);
      const evidence = context.evidence!.find((entry) => entry.sessionId === 's1')!;
      expect(evidence.eventSeqs.has(1)).toBe(true);
      expect([...evidence.candidateEvidence!.get('error-storm|timeout')!]).toEqual([2, 3, 4]);
      expect(reviewLessons(learned.lessons, NOW, context)[0]).toMatchObject({ verdict: 'approve', resolvedEvidenceSessions: 2 });
    });
  });

  it('does not learn phantom failures from tampered digest error aggregates', async () => {
    await withFixture(async (root, storage, store) => {
      for (const id of ['s1', 's2']) {
        await storage.writeTrace(trace(id, root, false));
        await storage.writeDigest(computeDigest(trace(id, root, true)));
      }
      const learned = await runLearn(storage, store, { now: NOW });
      expect(learned.summary.sessionsScanned).toBe(2);
      expect(learned.summary.candidates).toBe(0);
      expect(learned.lessons).toEqual([]);
      const context = await loadReviewContext(storage, root);
      expect(context.evidence).toHaveLength(2);
      expect(context.evidence!.every((entry) => entry.candidateKeys.size === 0)).toBe(true);
    });
  });

  it('holds an existing lesson when its stored traces no longer support the stale digest pattern', async () => {
    await withFixture(async (root, storage, store) => {
      await writeSession(storage, trace('s1', root));
      await writeSession(storage, trace('s2', root));
      const learned = await runLearn(storage, store, { now: NOW });
      for (const id of ['s1', 's2']) await storage.writeTrace(trace(id, root, false));
      const refreshed = await runLearn(storage, store, { now: NOW });
      expect(refreshed.summary.candidates).toBe(0);
      expect(refreshed.lessons[0].id).toBe(learned.lessons[0].id);
      const [decision] = reviewLessons(refreshed.lessons, NOW, await loadReviewContext(storage, root));
      expect(decision.verdict).toBe('hold');
      expect(decision.reasons).toContain('unsupported-source-pattern');
      expect(decision.resolvedEvidenceSessions).toBe(0);
    });
  });

  it.each([1, 999])('holds evidence pointing at unrelated or nonexistent event seq %s', async (seq) => {
    await withFixture(async (root, storage, store) => {
      await writeSession(storage, trace('s1', root));
      await writeSession(storage, trace('s2', root));
      const { lessons } = await runLearn(storage, store, { now: NOW });
      lessons[0].evidence[0].seq = seq;
      const [decision] = reviewLessons(lessons, NOW, await loadReviewContext(storage, root));
      expect(decision.verdict).toBe('hold');
      expect(decision.reasons).toContain('unresolved-event-evidence');
    });
  });

  it.each(['missing', 'corrupt', 'misaddressed'])('cannot validate a lesson against a %s source trace', async (damage) => {
    await withFixture(async (root, storage, store) => {
      await writeSession(storage, trace('s1', root));
      await writeSession(storage, trace('s2', root));
      const { lessons } = await runLearn(storage, store, { now: NOW });
      const traceFile = path.join(root, '.aladeen', 'ingested', 'sessions', `${sanitizeForFs('s2')}.trace.json`);
      if (damage === 'missing') await rm(traceFile);
      else if (damage === 'corrupt') await writeFile(traceFile, '{broken', 'utf-8');
      else await writeFile(traceFile, JSON.stringify(trace('different-session', root)), 'utf-8');
      const refreshed = await runLearn(storage, store, { now: NOW });
      expect(refreshed.summary.tracesMissing).toBe(1);
      const context = await loadReviewContext(storage, root);
      expect(context.evidence!.map((entry) => entry.sessionId)).toEqual(['s1']);
      const [decision] = reviewLessons(lessons, NOW, context);
      expect(decision.verdict).toBe('hold');
      expect(decision.reasons).toContain('missing-source-session');
      expect(decision.resolvedEvidenceSessions).toBe(1);
    });
  });

  it('keeps the same shape in separate projects from corroborating across projects', async () => {
    await withFixture(async (root, storage, store) => {
      const otherRoot = path.join(root, 'other-project');
      await writeSession(storage, trace('a1', root));
      await writeSession(storage, trace('b1', otherRoot));
      const { lessons } = await runLearn(storage, store, { now: NOW });
      expect(lessons).toHaveLength(2);
      expect(lessons.every((lesson) => lesson.status === 'hypothesis')).toBe(true);
      expect(new Set(lessons.map((lesson) => lesson.scope.projectId)).size).toBe(2);
      const decisions = reviewLessons(lessons, NOW, await loadReviewContext(storage, root));
      expect(decisions.every((decision) => decision.verdict === 'hold')).toBe(true);
    });
  });

  it('does not approve a corroborated other-project lesson under the target project context', async () => {
    await withFixture(async (root, storage, store) => {
      const otherRoot = path.join(root, 'other-project');
      for (const id of ['a1', 'a2']) await writeSession(storage, trace(id, root));
      for (const id of ['b1', 'b2']) await writeSession(storage, trace(id, otherRoot));
      const { lessons } = await runLearn(storage, store, { now: NOW });
      const decisions = reviewLessons(lessons, NOW, await loadReviewContext(storage, root));
      const a = decisions.find((decision) => decision.lessonProjectId === projectIdForPath(root))!;
      const b = decisions.find((decision) => decision.lessonProjectId === projectIdForPath(otherRoot))!;
      expect(a.verdict).toBe('approve');
      expect(b.verdict).toBe('hold');
      expect(b.reasons).toContain('project-mismatch');
      expect(b.resolvedEvidenceSessions).toBe(2);
    });
  });
});
