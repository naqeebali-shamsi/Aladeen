import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionState } from './types.js';
import { ExecutionStateSchema } from './types.js';

/**
 * Persists and restores ExecutionState as JSON files.
 * Storage location: .aladeen/runs/{runId}.json
 */
export class StatePersistence {
  private readonly stateDir: string;

  /** Default fallback budget when runPolicy.maxRunDurationMs is not set (1 hour). */
  static readonly DEFAULT_STALE_BUDGET_MS = 60 * 60 * 1000;

  constructor(repoRoot: string) {
    this.stateDir = path.join(repoRoot, '.aladeen', 'runs');
  }

  /** Save execution state to disk. */
  async save(state: ExecutionState): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const filePath = path.join(this.stateDir, `${state.runId}.json`);
    await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  /** Load execution state from disk. Throws if not found or invalid. */
  async load(runId: string): Promise<ExecutionState> {
    const filePath = path.join(this.stateDir, `${runId}.json`);
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return ExecutionStateSchema.parse(parsed);
  }

  /** List every persisted run, skipping any file that fails to parse. */
  async list(): Promise<ExecutionState[]> {
    let files: string[];
    try {
      files = await readdir(this.stateDir);
    } catch {
      return [];
    }
    const out: ExecutionState[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(path.join(this.stateDir, f), 'utf-8');
        out.push(ExecutionStateSchema.parse(JSON.parse(raw)));
      } catch {
        // Skip unreadable / schema-incompatible files; do not crash the caller.
      }
    }
    return out;
  }

  /**
   * Mark stale runs as `abandoned`. A run is stale when:
   *   - status === 'running' (never reached a terminal state)
   *   - no completedAt timestamp
   *   - startedAt is older than 2× runPolicy.maxRunDurationMs (or 1h fallback)
   *
   * Doubling the budget gives genuinely long runs room to complete before we
   * declare them dead. Returns the runIds that were marked.
   */
  async sweepStale(now: Date = new Date()): Promise<string[]> {
    const runs = await this.list();
    const swept: string[] = [];
    for (const r of runs) {
      if (!isStale(r, now)) continue;
      const startedMs = Date.parse(r.startedAt);
      const ageMs = now.getTime() - startedMs;
      const updated: ExecutionState = {
        ...r,
        status: 'abandoned',
        completedAt: now.toISOString(),
        escalationReason:
          r.escalationReason ??
          `Marked abandoned by sweep: status=running with no completedAt, ${Math.round(ageMs / 1000)}s since startedAt.`,
      };
      await this.save(updated);
      swept.push(r.runId);
    }
    return swept;
  }
}

/** Pure helper — exported for tests. */
export function isStale(state: ExecutionState, now: Date): boolean {
  if (state.status !== 'running') return false;
  if (state.completedAt) return false;
  const startedMs = Date.parse(state.startedAt);
  if (Number.isNaN(startedMs)) return false;
  const budgetMs = state.runPolicy?.maxRunDurationMs ?? StatePersistence.DEFAULT_STALE_BUDGET_MS;
  return now.getTime() - startedMs > budgetMs * 2;
}
