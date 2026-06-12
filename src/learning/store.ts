import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LessonSchema, type Lesson } from './lesson.js';
import { sanitizeForFs } from '../observability/storage.js';

// On-disk layout under <repoRoot>/.aladeen/lessons/:
//   <lessonId>.lesson.json    -- one Lesson per file
//
// Mirrors IngestStorage deliberately: dumb passthrough, schema-validated
// reads that skip corrupt files, JSON as the canonical form. Plain files
// were the deliberate substrate choice (see memory/research-agentic-memory.md):
// every local-first memory system that survived verification converged on
// files + a local index, and at lesson-store volume (hundreds, not millions)
// the directory IS the index. A node:sqlite FTS index can bolt on later
// without changing this layout.

export class LessonStore {
  constructor(private readonly repoRoot: string) {}

  private get lessonsDir(): string {
    return path.join(this.repoRoot, '.aladeen', 'lessons');
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.lessonsDir, { recursive: true });
  }

  async write(lesson: Lesson): Promise<string> {
    await this.ensureDirs();
    const filePath = path.join(this.lessonsDir, `${sanitizeForFs(lesson.id)}.lesson.json`);
    await writeFile(filePath, JSON.stringify(lesson, null, 2), 'utf-8');
    return filePath;
  }

  async writeAll(lessons: Lesson[]): Promise<void> {
    for (const lesson of lessons) await this.write(lesson);
  }

  async list(): Promise<Lesson[]> {
    let entries: string[];
    try {
      entries = await readdir(this.lessonsDir);
    } catch {
      return [];
    }
    const out: Lesson[] = [];
    for (const name of entries) {
      if (!name.endsWith('.lesson.json')) continue;
      const filePath = path.join(this.lessonsDir, name);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = LessonSchema.safeParse(JSON.parse(raw));
        if (parsed.success) out.push(parsed.data);
      } catch {
        // Skip unreadable / corrupt lessons.
      }
    }
    return out;
  }
}
