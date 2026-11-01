import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectIdForPath } from './scope.js';
import type { ReviewContext } from './review.js';
import { createHash } from 'node:crypto';
import type { Lesson } from './lesson.js';
import { rankLessons } from './learn.js';
import { reviewLesson } from './review.js';

// Actuation writes only inside an Aladeen-owned fence. Every path, including
// scheduled maintenance, passes through the same autonomous evidence review.
export const LEARNED_BLOCK_START = '<!-- aladeen:learned:start -->';
export const LEARNED_BLOCK_END = '<!-- aladeen:learned:end -->';

export interface ActuateBudget {
  maxRules: number;
  maxChars: number;
}
export const DEFAULT_ACTUATE_BUDGET: ActuateBudget = { maxRules: 10, maxChars: 2500 };

export function selectLessonsForActuation(
  lessons: Lesson[],
  budget: ActuateBudget = DEFAULT_ACTUATE_BUDGET,
  now: Date = new Date(),
  context?: ReviewContext,
): Lesson[] {
  const eligible = rankLessons(lessons.filter((lesson) => reviewLesson(lesson, now, context).verdict === 'approve'));
  const selected: Lesson[] = [];
  let chars = 0;
  for (const lesson of eligible) {
    if (selected.length >= budget.maxRules) break;
    const line = renderLessonBullet(lesson);
    if (chars + line.length > budget.maxChars) break;
    selected.push(lesson);
    chars += line.length;
  }
  return selected;
}

export function renderLessonBullet(l: Lesson): string {
  const providers = l.scope.universal
    ? `${l.scope.agentClis.join(', ')}; universal`
    : l.scope.agentClis.join(', ');
  return `- ${l.statement} _(seen in ${l.recurrence.sessionCount} session(s): ${providers})_`;
}

export function renderLearnedBlock(lessons: Lesson[], now: Date): string {
  return [
    LEARNED_BLOCK_START,
    '<!-- Managed by `aladeen learn --apply`. Edits inside this block are overwritten. -->',
    '## Learned guardrails (Aladeen)',
    '',
    'Recurring patterns mined from this machine\'s agent session logs. Evidence:',
    '`aladeen lessons`. Updated ' + now.toISOString().slice(0, 10) + '.',
    '',
    ...lessons.map(renderLessonBullet),
    LEARNED_BLOCK_END,
  ].join('\n');
}

// Validate the entire marker sequence before replacing OR withdrawing a block.
// Duplicate fences are ambiguous ownership and must never consume owner text.
export function spliceLearnedBlock(content: string, block: string): string {
  const starts = content.split(LEARNED_BLOCK_START).length - 1;
  const ends = content.split(LEARNED_BLOCK_END).length - 1;
  if (starts === 0 && ends === 0) {
    if (!block) return content;
    const sep = content.length === 0 ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return content + sep + block + '\n';
  }
  const start = content.indexOf(LEARNED_BLOCK_START);
  const end = content.indexOf(LEARNED_BLOCK_END);
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new Error('Corrupt aladeen:learned fence: expected one ordered start/end pair. Fix or remove the markers manually, then re-run.');
  }
  return content.slice(0, start) + block + content.slice(end + LEARNED_BLOCK_END.length);
}

export interface ApplyResult {
  filePath: string;
  written: boolean;
  lessonCount: number;
}

export async function applyLearnedBlock(
  filePath: string,
  lessons: Lesson[],
  now: Date,
  budget: ActuateBudget = DEFAULT_ACTUATE_BUDGET,
  context?: ReviewContext,
): Promise<ApplyResult & { selected: Lesson[] }> {
  // Bind writes to the physical destination directory. A lexical alias must
  // not let project A's lesson reach project B through a directory junction.
  // File symlinks are refused rather than followed across owner boundaries.
  try {
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error('Refusing learned guidance target symlink');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const targetRoot = await realpath(path.dirname(path.resolve(filePath)));
  if (projectIdForPath(targetRoot) !== projectIdForPath(path.dirname(path.resolve(filePath)))) {
    throw new Error('Refusing learned guidance through a directory alias; use its physical project path');
  }
  const selected = selectLessonsForActuation(lessons, budget, now, { ...context, projectId: projectIdForPath(targetRoot) });
  let content = '';
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = spliceLearnedBlock(content, selected.length ? renderLearnedBlock(selected, now) : '');
  if (next === content) return { filePath, written: false, lessonCount: selected.length, selected };
  await writeFile(filePath, next, 'utf-8');
  return { filePath, written: true, lessonCount: selected.length, selected };
}

// Statement hashes live in the existing append-only revision audit so stored
// schema-v1 lessons remain compatible. Reapplication of the SAME rule must not
// move the measurement boundary on every scheduled maintenance cycle.
const STATEMENT_REVISION = 'actuation-statement:';
function sameTargetPath(a: string, b: string): boolean {
  const identify = (value: string) => projectIdForPath(value) ?? projectIdForPath(path.resolve(value));
  const first = identify(a);
  return first !== undefined && first === identify(b);
}
function statementRevision(lesson: Lesson): string {
  return STATEMENT_REVISION + createHash('sha256').update(lesson.statement).digest('hex');
}

export function markActuated(
  selected: Lesson[],
  filePath: string,
  target: 'agents-md' | 'claude-md',
  now: Date,
): void {
  const nowIso = now.toISOString();
  for (const lesson of selected) {
    const revision = statementRevision(lesson);
    const priorRevision = [...lesson.revisions].reverse().find((r) => r.change.startsWith(STATEMENT_REVISION));
    const sameTarget = lesson.actuation?.target === target && sameTargetPath(lesson.actuation.filePath, filePath);
    // Legacy records lack a hash: retain their baseline and establish a hash
    // now rather than retroactively inventing when their wording changed.
    const sameStatement = !priorRevision || priorRevision.change === revision;
    if (sameTarget && sameStatement) {
      if (!priorRevision) lesson.revisions.push({ at: nowIso, change: revision });
      continue;
    }
    lesson.actuation = { target, filePath, appliedAt: nowIso };
    delete lesson.measurement;
    lesson.revisions.push({ at: nowIso, change: revision });
    if (lesson.status === 'corroborated' || lesson.status === 'verified') {
      lesson.revisions.push({ at: nowIso, change: `status:${lesson.status}->actuated` });
      lesson.status = 'actuated';
    } else {
      lesson.revisions.push({ at: nowIso, change: `actuated:${target}` });
    }
  }
}

// Reconcile every published set, including budget displacement and withdrawal
// after regression. A later reintroduction needs a new observation boundary.
export function markWithdrawn(
  lessons: Lesson[],
  selected: Lesson[],
  filePath: string,
  target: 'agents-md' | 'claude-md',
  now: Date,
): void {
  const selectedIds = new Set(selected.map((lesson) => lesson.id));
  for (const lesson of lessons) {
    if (selectedIds.has(lesson.id) || lesson.actuation?.target !== target || !sameTargetPath(lesson.actuation.filePath, filePath)) continue;
    delete lesson.actuation;
    // Preserve negative evidence so withdrawal cannot cause automatic reapproval.
    // markActuated clears measurements only when a genuinely new trial starts.
    lesson.revisions.push({ at: now.toISOString(), change: `withdrawn:${target}` });
    if (lesson.status === 'actuated' || lesson.status === 'verified') {
      lesson.revisions.push({ at: now.toISOString(), change: `status:${lesson.status}->corroborated` });
      lesson.status = 'corroborated';
    }
  }
}
