import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LessonStore } from './store.js';
import { consolidate } from './consolidate.js';
import type { LessonCandidate } from './detectors.js';

// Round-trip through the real fs: whatever consolidate produces must survive
// JSON serialization AND LessonSchema.safeParse on the way back. This is the
// drift alarm between producer (consolidate) and schema (lesson.ts).

const NOW = new Date('2026-06-12T12:00:00.000Z');

function candidate(sessionId: string): LessonCandidate {
  return {
    detectorId: 'edit-loop',
    detectorVersion: '1',
    sessionId,
    candidateKey: 'edit-loop|cli.tsx',
    dims: { file: 'cli.tsx' },
    statement: 'cli.tsx gets re-edited many times within a session.',
    category: 'model-mistake',
    agentCli: 'claude-code',
    evidence: [{ sessionId, seq: 1 }],
    observedAt: NOW.toISOString(),
    patternFingerprint: 'fp-1',
  };
}

describe('LessonStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aladeen-lessons-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips consolidated lessons through disk and schema validation', async () => {
    const store = new LessonStore(root);
    const { lessons } = consolidate([], [candidate('s1'), candidate('s2')], { now: NOW });
    await store.writeAll(lessons);

    const back = await store.list();
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(lessons[0]);
  });

  it('returns empty before any learn run', async () => {
    expect(await new LessonStore(root).list()).toEqual([]);
  });

  it('skips corrupt lesson files instead of failing the listing', async () => {
    const store = new LessonStore(root);
    const { lessons } = consolidate([], [candidate('s1')], { now: NOW });
    await store.writeAll(lessons);

    const dir = path.join(root, '.aladeen', 'lessons');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'broken.lesson.json'), '{ not json', 'utf-8');
    await writeFile(path.join(dir, 'wrong-shape.lesson.json'), '{"schemaVersion":"1"}', 'utf-8');

    const back = await store.list();
    expect(back).toHaveLength(1);
  });
});
