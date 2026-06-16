import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { applyRemedy, detectInstallPlan, type ApplyDeps, type InstallPlan } from './apply.js';
import { suggestRemedy, runnableFix, REMEDY_RULES } from './remedy.js';
import type { IngestStorage } from './storage.js';
import { ERROR_CLASSES, type RunDigest, type ErrorClass } from './session-trace.js';

// --- fixtures (mirror remedy.test.ts) ---------------------------------------

function zeroErrors(): Record<ErrorClass, number> {
  return Object.fromEntries(ERROR_CLASSES.map((c) => [c, 0])) as Record<ErrorClass, number>;
}
type DOpts = Partial<Omit<RunDigest, 'errorCounts'>> & { errorCounts?: Partial<Record<ErrorClass, number>> };
function d(p: DOpts = {}): RunDigest {
  return {
    sessionId: p.sessionId ?? 's', agentCliName: p.agentCliName ?? 'codex', outcome: p.outcome ?? 'gave_up',
    durationMs: p.durationMs, activeDurationMs: p.activeDurationMs, toolUsage: p.toolUsage ?? {},
    errorCounts: { ...zeroErrors(), ...(p.errorCounts ?? {}) }, filesChanged: p.filesChanged ?? [],
    toolFailureCount: p.toolFailureCount ?? 0, editLoops: p.editLoops ?? [], cost: p.cost,
    patternFingerprint: p.patternFingerprint ?? 'fp_fail',
  };
}
function fakeStorage(digests: RunDigest[]): IngestStorage {
  return { listDigests: async () => digests, loadTrace: async () => null } as unknown as IngestStorage;
}
const EDIT_LOOP = ([{ file: 'a.ts', count: 3 }] as unknown) as RunDigest['editLoops'];

// RemedyResults at each relevant tier
const wcKnownFix = () => suggestRemedy('fp_wc', fakeStorage([
  d({ sessionId: 'wc', agentCliName: 'aladeen', outcome: 'gave_up', errorCounts: { worktree_collision: 2267 }, toolFailureCount: 2267, patternFingerprint: 'fp_wc' }),
]));
const lintLoopKnownFix = () => suggestRemedy('fp_ll', fakeStorage([
  d({ sessionId: 'll', outcome: 'gave_up', errorCounts: { lint_loop: 3 }, toolFailureCount: 3, editLoops: EDIT_LOOP, patternFingerprint: 'fp_ll' }),
]));
const noneTier = () => suggestRemedy('fp_pf', fakeStorage([
  d({ sessionId: 'pf', outcome: 'gave_up', errorCounts: { parse_error: 1 }, toolFailureCount: 1, patternFingerprint: 'fp_pf' }),
]));

// --- mock deps with call tracking -------------------------------------------

function mockDeps(over: { plan?: InstallPlan | null; installExit?: number; worktreeThrows?: boolean } = {}) {
  const calls = { makeWorktree: 0, detect: 0, run: 0, changeSummary: 0, cleanup: 0 };
  const deps: ApplyDeps = {
    detectInstall: async () => { calls.detect++; return 'plan' in over ? (over.plan ?? null) : { manager: 'npm', command: 'npm', args: ['install'] }; },
    makeWorktree: async (id) => {
      calls.makeWorktree++;
      if (over.worktreeThrows) throw new Error('working tree is dirty');
      return { path: `/wt/${id}`, cleanup: async () => { calls.cleanup++; } };
    },
    run: async () => { calls.run++; return { exitCode: over.installExit ?? 0, stdout: 'added 1 package', stderr: '' }; },
    changeSummary: async () => { calls.changeSummary++; return ' M package-lock.json'; },
  };
  return { deps, calls };
}

// --- registry / gate --------------------------------------------------------

describe('runnable-fix registry', () => {
  it('worktree_collision carries a runnable install-deps fix; lint_loop does not (Class B)', () => {
    const wc = REMEDY_RULES.find((r) => r.id === 'worktree_collision')!;
    const ll = REMEDY_RULES.find((r) => r.id === 'lint_loop')!;
    expect(wc.fix?.kind).toBe('install-deps');
    expect(ll.fix).toBeUndefined();
  });
  it('runnableFix unwraps a known-fix-with-fix, returns null otherwise', async () => {
    expect(runnableFix(await wcKnownFix())?.rule.id).toBe('worktree_collision');
    expect(runnableFix(await lintLoopKnownFix())).toBeNull();
    expect(runnableFix(await noneTier())).toBeNull();
  });
});

// --- applyRemedy orchestration ----------------------------------------------

describe('applyRemedy', () => {
  it('runs the worktree_collision fix in isolation and cleans up by default', async () => {
    const { deps, calls } = mockDeps();
    const r = await applyRemedy(await wcKnownFix(), {}, deps);
    expect(r).toMatchObject({ runnable: true, applied: true, exitCode: 0, command: 'npm install', worktreeKept: false });
    expect(calls).toEqual({ makeWorktree: 1, detect: 1, run: 1, changeSummary: 1, cleanup: 1 });
    expect(r.markdown).toContain('nothing merged');
  });

  it('--keep leaves the worktree (no cleanup)', async () => {
    const { deps, calls } = mockDeps();
    const r = await applyRemedy(await wcKnownFix(), { keepWorktree: true }, deps);
    expect(r.worktreeKept).toBe(true);
    expect(calls.cleanup).toBe(0);
  });

  it('declines a non-known-fix tier without creating a worktree', async () => {
    const { deps, calls } = mockDeps();
    const r = await applyRemedy(await noneTier(), {}, deps);
    expect(r).toMatchObject({ runnable: false, applied: false });
    expect(calls.makeWorktree).toBe(0);
    expect(r.reason).toMatch(/suggestion/i);
  });

  it('declines a Class-B known-fix (lint_loop) and points at lessons --apply', async () => {
    const { deps, calls } = mockDeps();
    const r = await applyRemedy(await lintLoopKnownFix(), {}, deps);
    expect(r).toMatchObject({ runnable: false, applied: false });
    expect(calls.makeWorktree).toBe(0);
    expect(r.reason).toMatch(/lessons --apply/);
  });

  it('runnable but not applied when there is no package.json (worktree still cleaned)', async () => {
    const { deps, calls } = mockDeps({ plan: null });
    const r = await applyRemedy(await wcKnownFix(), {}, deps);
    expect(r).toMatchObject({ runnable: true, applied: false });
    expect(r.reason).toMatch(/package\.json/);
    expect(calls).toMatchObject({ makeWorktree: 1, detect: 1, run: 0, cleanup: 1 });
  });

  it('runnable but not applied when the worktree cannot be created (real tree untouched)', async () => {
    const { deps, calls } = mockDeps({ worktreeThrows: true });
    const r = await applyRemedy(await wcKnownFix(), {}, deps);
    expect(r).toMatchObject({ runnable: true, applied: false });
    expect(r.reason).toMatch(/worktree/i);
    expect(calls.cleanup).toBe(0);
    expect(r.markdown).toContain('never touched');
  });

  it('surfaces a non-zero install exit honestly (applied, but flagged)', async () => {
    const { deps } = mockDeps({ installExit: 1 });
    const r = await applyRemedy(await wcKnownFix(), {}, deps);
    expect(r).toMatchObject({ applied: true, exitCode: 1 });
    expect(r.markdown).toMatch(/non-zero/i);
  });
});

// --- package-manager detection (real fs) ------------------------------------

describe('detectInstallPlan', () => {
  it('maps lockfiles to managers, defaults to npm, null without package.json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aladeen-apply-'));
    try {
      expect(await detectInstallPlan(dir)).toBeNull(); // no package.json yet
      await writeFile(path.join(dir, 'package.json'), '{}');
      expect((await detectInstallPlan(dir))?.manager).toBe('npm');
      await writeFile(path.join(dir, 'yarn.lock'), '');
      expect((await detectInstallPlan(dir))?.manager).toBe('yarn');
      await writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
      expect((await detectInstallPlan(dir))?.manager).toBe('pnpm'); // pnpm wins over yarn
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
