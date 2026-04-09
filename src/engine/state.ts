import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionState } from './types.js';
import { ExecutionStateSchema } from './types.js';

/**
 * Persists and restores ExecutionState as JSON files.
 * Storage location: .aladeen/runs/{runId}.json
 */
export class StatePersistence {
  private readonly stateDir: string;

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
}
