import { describe, it, expect } from 'vitest';
import {
  LEARNED_BLOCK_END,
  LEARNED_BLOCK_START,
  markActuated,
  renderLearnedBlock,
  selectLessonsForActuation,
  spliceLearnedBlock,
} from './actuate.js';
import type { Lesson, LessonStatus } from './lesson.js';

const NOW = new Date('2026-06-12T12:00:00.000Z');

let n = 0;
function makeLesson(opts: {
  status?: LessonStatus;
  retention?: number;
  sessions?: number;
  statement?: string;
}): Lesson {
  n += 1;
  return {
    schemaVersion: '1',
    id: `lesson-${n}`,
    candidateKey: `key-${n}`,
    dims: {},
    statement: opts.statement ?? `Statement for lesson ${n}.`,
    category: 'model-mistake',
    scope: { agentClis: ['claude-code'], universal: false },
    status: opts.status ?? 'corroborated',
    evidence: [{ sessionId: 's1', seq: 0 }],
    seenSessionIds: ['s1'],
    recurrence: { sessionCount: opts.sessions ?? 2, eventCount: 2 },
    decay: {
      layer: 'short',
      importance: 0.5,
      retention: opts.retention ?? 0.9,
      computedAt: NOW.toISOString(),
    },
    provenance: { createdAt: NOW.toISOString(), source: 'detector:test@1' },
    revisions: [{ at: NOW.toISOString(), change: 'created' }],
    actuation: undefined,
    targetFingerprints: [],
  };
}

describe('selectLessonsForActuation', () => {
  it('excludes hypotheses and retired lessons — one session never reaches a surface', () => {
    const selected = selectLessonsForActuation([
      makeLesson({ status: 'hypothesis' }),
      makeLesson({ status: 'retired' }),
      makeLesson({ status: 'corroborated' }),
      makeLesson({ status: 'actuated' }),
    ]);
    expect(selected).toHaveLength(2);
    expect(selected.every((l) => l.status !== 'hypothesis' && l.status !== 'retired')).toBe(true);
  });

  it('ranks by retention and stops at maxRules', () => {
    const lessons = [
      makeLesson({ retention: 0.2 }),
      makeLesson({ retention: 0.9 }),
      makeLesson({ retention: 0.5 }),
    ];
    const selected = selectLessonsForActuation(lessons, { maxRules: 2, maxChars: 10_000 });
    expect(selected).toHaveLength(2);
    expect(selected[0].decay.retention).toBe(0.9);
    expect(selected[1].decay.retention).toBe(0.5);
  });

  it('stops at the character budget', () => {
    const lessons = [
      makeLesson({ retention: 0.9, statement: 'x'.repeat(200) }),
      makeLesson({ retention: 0.8, statement: 'y'.repeat(200) }),
    ];
    const selected = selectLessonsForActuation(lessons, { maxRules: 10, maxChars: 260 });
    expect(selected).toHaveLength(1);
  });
});

describe('renderLearnedBlock', () => {
  it('produces a fenced, attributed block', () => {
    const block = renderLearnedBlock([makeLesson({ statement: 'Do not thrash.' })], NOW);
    expect(block.startsWith(LEARNED_BLOCK_START)).toBe(true);
    expect(block.endsWith(LEARNED_BLOCK_END)).toBe(true);
    expect(block).toContain('Do not thrash.');
    expect(block).toContain('seen in 2 session(s)');
    expect(block).toContain('2026-06-12');
  });
});

describe('spliceLearnedBlock', () => {
  const BLOCK = `${LEARNED_BLOCK_START}\nnew content\n${LEARNED_BLOCK_END}`;

  it('appends to an empty file', () => {
    expect(spliceLearnedBlock('', BLOCK)).toBe(BLOCK + '\n');
  });

  it('appends after existing content without touching it', () => {
    const out = spliceLearnedBlock('# My AGENTS.md\n\nHand-written rules.\n', BLOCK);
    expect(out.startsWith('# My AGENTS.md\n\nHand-written rules.\n')).toBe(true);
    expect(out).toContain(BLOCK);
  });

  it('replaces an existing block in place, preserving surroundings', () => {
    const original = `before\n${LEARNED_BLOCK_START}\nold stuff\n${LEARNED_BLOCK_END}\nafter\n`;
    const out = spliceLearnedBlock(original, BLOCK);
    expect(out).toBe(`before\n${BLOCK}\nafter\n`);
    expect(out).not.toContain('old stuff');
  });

  it('is idempotent — splicing the same block twice yields the same file', () => {
    const once = spliceLearnedBlock('# Doc\n', BLOCK);
    expect(spliceLearnedBlock(once, BLOCK)).toBe(once);
  });

  it('refuses to guess on a corrupt fence', () => {
    expect(() => spliceLearnedBlock(`text\n${LEARNED_BLOCK_START}\nunclosed`, BLOCK)).toThrow(/Corrupt/);
    expect(() => spliceLearnedBlock(`${LEARNED_BLOCK_END}\nbackwards\n${LEARNED_BLOCK_START}`, BLOCK)).toThrow(/Corrupt/);
  });
});

describe('markActuated', () => {
  it('moves corroborated lessons to actuated with an audit trail', () => {
    const lesson = makeLesson({ status: 'corroborated' });
    markActuated([lesson], 'AGENTS.md', 'agents-md', NOW);
    expect(lesson.status).toBe('actuated');
    expect(lesson.actuation).toEqual({
      target: 'agents-md',
      filePath: 'AGENTS.md',
      appliedAt: NOW.toISOString(),
    });
    expect(lesson.revisions.at(-1)?.change).toBe('status:corroborated->actuated');
  });

  it('re-applying an already-actuated lesson records without a status change', () => {
    const lesson = makeLesson({ status: 'actuated' });
    markActuated([lesson], 'AGENTS.md', 'agents-md', NOW);
    expect(lesson.status).toBe('actuated');
    expect(lesson.revisions.at(-1)?.change).toBe('actuated:agents-md');
  });
});
