import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorktreeManager } from './worktree.js';

const execFileAsync = promisify(execFile);

/**
 * Regression test for the "junction-followed-during-remove" bug.
 *
 * Symptom: removing a worktree wiped out the main repo's node_modules because
 * `git worktree remove --force` descended into the NTFS junction we created
 * during `create()`.
 *
 * Fix: detach the link before removal. This test would have caught it.
 */
describe('WorktreeManager — node_modules survives worktree removal', () => {
  let tmp: string;
  let repoRoot: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'aladeen-worktree-test-'));
    repoRoot = path.join(tmp, 'repo');
    await mkdir(repoRoot, { recursive: true });

    // Initialise a real git repo with one commit on main so worktree add works.
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'test@aladeen.local'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'aladeen-test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, 'README.md'), '# test\n', 'utf-8');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

    // Seed a fake node_modules with a sentinel file so we can prove it survives.
    const nm = path.join(repoRoot, 'node_modules');
    await mkdir(path.join(nm, 'fake-pkg'), { recursive: true });
    await writeFile(path.join(nm, 'fake-pkg', 'index.js'), 'module.exports = 1;\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('preserves the main repo node_modules after create + remove', async () => {
    const mgr = new WorktreeManager(repoRoot, { linkNodeModules: true });
    await mgr.create('survive-test');

    // Junction must exist inside the worktree so the next assertion is meaningful.
    const linkedNm = path.join(repoRoot, '.aladeen', 'worktrees', 'survive-test', 'node_modules');
    await expect(stat(linkedNm)).resolves.toBeDefined();

    await mgr.remove('survive-test');

    // The main repo's node_modules + sentinel file MUST still exist.
    const sentinel = path.join(repoRoot, 'node_modules', 'fake-pkg', 'index.js');
    const s = await stat(sentinel);
    expect(s.isFile()).toBe(true);

    // Worktree directory should be gone.
    const wtRoot = path.join(repoRoot, '.aladeen', 'worktrees');
    const remaining = await readdir(wtRoot).catch(() => []);
    expect(remaining).not.toContain('survive-test');
  });
});
