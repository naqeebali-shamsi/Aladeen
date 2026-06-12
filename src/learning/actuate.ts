import { readFile, writeFile } from 'node:fs/promises';
import type { Lesson } from './lesson.js';
import { rankLessons } from './learn.js';

// Actuation: the ONLY write the learning layer makes outside .aladeen/, and
// it is opt-in (`aladeen learn --apply`), bounded, and fenced.
//
//   - Only corroborated+ lessons qualify — a hypothesis seen in one session
//     never reaches an agent's context.
//   - Hard budget (rules + chars). Claude Code loads the first 200 lines /
//     25KB of its memory index and agents demonstrably ignore rule #47 of a
//     bloated list; a small high-retention set beats an archive. Detail
//     stays in `aladeen lessons`.
//   - Everything lives between Aladeen-owned markers. Content outside the
//     fence is never touched; a half-deleted fence aborts rather than
//     guessing (a wrong splice into someone's AGENTS.md is worse than a
//     failed command).

export const LEARNED_BLOCK_START = '<!-- aladeen:learned:start -->';
export const LEARNED_BLOCK_END = '<!-- aladeen:learned:end -->';

export interface ActuateBudget {
  maxRules: number;
  maxChars: number;
}

export const DEFAULT_ACTUATE_BUDGET: ActuateBudget = {
  maxRules: 10,
  maxChars: 2500,
};

const ACTUATABLE = new Set<Lesson['status']>(['corroborated', 'actuated', 'verified']);

export function selectLessonsForActuation(
  lessons: Lesson[],
  budget: ActuateBudget = DEFAULT_ACTUATE_BUDGET,
): Lesson[] {
  const eligible = rankLessons(lessons.filter((l) => ACTUATABLE.has(l.status)));
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
  const bullets = lessons.map(renderLessonBullet);
  return [
    LEARNED_BLOCK_START,
    '<!-- Managed by `aladeen learn --apply`. Edits inside this block are overwritten. -->',
    '## Learned guardrails (Aladeen)',
    '',
    'Recurring patterns mined from this machine\'s agent session logs. Evidence:',
    '`aladeen lessons`. Updated ' + now.toISOString().slice(0, 10) + '.',
    '',
    ...bullets,
    LEARNED_BLOCK_END,
  ].join('\n');
}

// Pure splice so the fence logic is testable without fs. Returns the new
// file content, or throws when the existing fence is corrupt.
export function spliceLearnedBlock(content: string, block: string): string {
  const start = content.indexOf(LEARNED_BLOCK_START);
  const end = content.indexOf(LEARNED_BLOCK_END);

  if (start === -1 && end === -1) {
    const sep = content.length === 0 ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return content + sep + block + '\n';
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Corrupt aladeen:learned fence (found ${start === -1 ? 'end' : 'start'} marker only, or out of order). `
      + 'Fix or remove the markers manually, then re-run.',
    );
  }
  const before = content.slice(0, start);
  const after = content.slice(end + LEARNED_BLOCK_END.length);
  return before + block + after;
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
): Promise<ApplyResult & { selected: Lesson[] }> {
  const selected = selectLessonsForActuation(lessons, budget);
  if (selected.length === 0) {
    return { filePath, written: false, lessonCount: 0, selected };
  }

  let content = '';
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    // Missing file is fine — the block becomes the whole file.
  }

  const next = spliceLearnedBlock(content, renderLearnedBlock(selected, now));
  await writeFile(filePath, next, 'utf-8');
  return { filePath, written: true, lessonCount: selected.length, selected };
}

// Record the actuation on the lessons themselves (status + audit trail) so
// the future recurrence-measurement step knows when each rule went live.
export function markActuated(
  selected: Lesson[],
  filePath: string,
  target: 'agents-md' | 'claude-md',
  now: Date,
): void {
  const nowIso = now.toISOString();
  for (const lesson of selected) {
    lesson.actuation = { target, filePath, appliedAt: nowIso };
    if (lesson.status === 'corroborated') {
      lesson.revisions.push({ at: nowIso, change: `status:${lesson.status}->actuated` });
      lesson.status = 'actuated';
    } else {
      lesson.revisions.push({ at: nowIso, change: `actuated:${target}` });
    }
  }
}
