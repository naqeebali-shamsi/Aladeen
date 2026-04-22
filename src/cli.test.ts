import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExecutionState } from './engine/types.js';

const execFileAsync = promisify(execFile);

const TSX_CLI = path.resolve('node_modules/tsx/dist/cli.mjs');
const APP_CLI = path.resolve('src/cli.tsx');

type Spawned = { stdout: string; stderr: string; code: number };

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<Spawned> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [TSX_CLI, APP_CLI, ...args],
      { env: { ...process.env, ...extraEnv }, timeout: 30_000 }
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('CLI smoke — roadmap M3 "CLI commands execute without crashing on valid inputs"', { timeout: 60_000 }, () => {
  let repoRoot: string;
  const runId = 'cli-smoke-run';

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), 'aladeen-cli-test-'));
    await mkdir(path.join(repoRoot, '.aladeen', 'runs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function saveRun(state: Partial<ExecutionState> & { runId: string }): Promise<void> {
    const full: ExecutionState = {
      blueprintId: 'test-bp',
      status: 'completed',
      nodeExecutions: {},
      currentNodeId: null,
      totalRetries: 0,
      context: { cwd: '.', env: {}, ruleFiles: [], allowedTools: [], store: {} },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ...state,
    };
    await writeFile(
      path.join(repoRoot, '.aladeen', 'runs', `${full.runId}.json`),
      JSON.stringify(full, null, 2),
      'utf-8'
    );
  }

  it('list-runs prints friendly message on an empty dir (exit 0)', async () => {
    const r = await runCli(['list-runs', '--repo-root', repoRoot]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No saved runs found.');
  });

  it('list-runs lists a saved run with blueprint+status fields (exit 0)', async () => {
    await saveRun({ runId, blueprintId: 'smoke-bp', status: 'completed' });

    const r = await runCli(['list-runs', '--repo-root', repoRoot]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain(runId);
    expect(r.stdout).toContain('smoke-bp');
    expect(r.stdout).toContain('completed');
  });

  it('inspect-run displays status, retries, and escalation reason (M3 metric)', async () => {
    await saveRun({
      runId,
      status: 'escalated',
      totalRetries: 7,
      escalationReason: 'Global retry budget exhausted (5)',
      runPolicy: { mode: 'local-only', cloudFallbackAllowed: false },
    });

    const r = await runCli(['inspect-run', runId, '--repo-root', repoRoot]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Status:');
    expect(r.stdout).toContain('escalated');
    expect(r.stdout).toContain('Retries:');
    expect(r.stdout).toContain('7');
    expect(r.stdout).toContain('Escalated:');
    expect(r.stdout).toContain('Global retry budget exhausted');
    expect(r.stdout).toContain('Mode:');
    expect(r.stdout).toContain('local-only');
  });

  it('inspect-run exits non-zero for a missing runId', async () => {
    const r = await runCli(['inspect-run', 'does-not-exist', '--repo-root', repoRoot]);
    expect(r.code).not.toBe(0);
  });
});
