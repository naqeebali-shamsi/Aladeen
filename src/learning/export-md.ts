import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Lesson } from './lesson.js';
import { rankLessons } from './learn.js';
import { sanitizeForFs } from '../observability/storage.js';

// WRITE-ONLY semantic-Markdown export: one note per lesson in the
// basic-memory dialect (categorized Observations + wiki Relations), which
// Obsidian reads natively. Aladeen never parses these files back — JSON in
// .aladeen/lessons/ stays canonical, so no YAML parser enters the deps.

export async function exportLessonsMarkdown(lessons: Lesson[], outDir: string): Promise<number> {
  await mkdir(outDir, { recursive: true });
  let count = 0;
  for (const lesson of rankLessons(lessons)) {
    const file = path.join(outDir, `${sanitizeForFs(lesson.id)}.md`);
    await writeFile(file, renderLessonNote(lesson), 'utf-8');
    count += 1;
  }
  return count;
}

export function renderLessonNote(l: Lesson): string {
  const title = l.statement.length > 80 ? `${l.statement.slice(0, 77)}...` : l.statement;
  const providers = l.scope.agentClis.join(', ') + (l.scope.universal ? ' (universal)' : '');
  const evidence = l.evidence
    .slice(0, 10)
    .map((e) => `- [evidence] session ${e.sessionId}${e.seq !== undefined ? ` seq ${e.seq}` : ''}`);
  const relations = [
    `- detected_by [[Aladeen Detector ${l.provenance.source.replace(/^detector:/, '').replace(/@.*$/, '')}]]`,
    ...l.evidence.slice(0, 5).map((e) => `- mined_from [[Aladeen Session ${e.sessionId}]]`),
  ];

  return [
    '---',
    `title: "${title.replace(/"/g, "'")}"`,
    'type: aladeen-lesson',
    `permalink: aladeen/lessons/${l.id}`,
    `tags: [aladeen, lesson, ${l.category}]`,
    '---',
    '',
    `# ${title}`,
    '',
    l.statement,
    '',
    '## Observations',
    `- [status] ${l.status} · ${l.decay.layer}-term · retention ${l.decay.retention.toFixed(2)} #${l.category}`,
    `- [recurrence] ${l.recurrence.sessionCount} distinct session(s), ${l.recurrence.eventCount} sampled event(s)`,
    `- [scope] ${providers}`,
    `- [provenance] ${l.provenance.source}, created ${l.provenance.createdAt.slice(0, 10)}`,
    ...evidence,
    '',
    '## Relations',
    ...relations,
    '',
  ].join('\n');
}
