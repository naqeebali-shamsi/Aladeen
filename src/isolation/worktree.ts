import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mkdir, rm, stat, symlink, lstat, unlink } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  taskId: string;
  path: string;
  branch: string;
  baseBranch: string;
  createdAt: Date;
}

export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_A_REPO'
      | 'BRANCH_EXISTS'
      | 'WORKTREE_EXISTS'
      | 'WORKTREE_NOT_FOUND'
      | 'GIT_ERROR',
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export interface WorktreeManagerOptions {
  /**
   * Junction `node_modules` from the main repo into each new worktree.
   * `git worktree add` does not bring node_modules, so deterministic gates
   * (lint/typecheck/test) fail immediately in fresh worktrees. Defaults true.
   * Disable when the worktree's package.json may legitimately differ.
   */
  linkNodeModules?: boolean;
}

export class WorktreeManager {
  private readonly worktreeRoot: string;
  private readonly branchPrefix = 'aladeen';
  private readonly linkNodeModules: boolean;

  constructor(private readonly repoRoot: string, options: WorktreeManagerOptions = {}) {
    this.worktreeRoot = path.join(repoRoot, '.aladeen', 'worktrees');
    this.linkNodeModules = options.linkNodeModules ?? true;
  }

  /** Create a new worktree for an agent task. */
  async create(taskId: string, baseBranch?: string): Promise<WorktreeInfo> {
    await this.ensureGitRepo();

    const branch = `${this.branchPrefix}/${taskId}`;
    const worktreePath = path.join(this.worktreeRoot, taskId);
    const base = baseBranch ?? await this.resolveDefaultBranch();

    // Check if branch already exists
    if (await this.branchExists(branch)) {
      throw new WorktreeError(
        `Branch "${branch}" already exists`,
        'BRANCH_EXISTS'
      );
    }

    // Check if worktree path already exists
    const existing = await this.list();
    if (existing.some((w) => w.taskId === taskId)) {
      throw new WorktreeError(
        `Worktree for task "${taskId}" already exists`,
        'WORKTREE_EXISTS'
      );
    }

    // Ensure parent directory exists
    await mkdir(path.dirname(worktreePath), { recursive: true });

    try {
      await this.git('worktree', 'add', '-b', branch, worktreePath, base);
    } catch (err) {
      throw new WorktreeError(
        `Failed to create worktree for task "${taskId}"`,
        'GIT_ERROR',
        err
      );
    }

    if (this.linkNodeModules) {
      await this.linkNodeModulesIfPresent(worktreePath);
    }

    return {
      taskId,
      path: worktreePath,
      branch,
      baseBranch: base,
      createdAt: new Date(),
    };
  }

  /**
   * Junction the main repo's node_modules into the worktree so deterministic
   * gates can resolve dependencies. Best-effort: if the link can't be created
   * (no node_modules in repo, junction unsupported, target already present),
   * leave it alone — the agent or blueprint can run `npm install` instead.
   */
  private async linkNodeModulesIfPresent(worktreePath: string): Promise<void> {
    const sourceModules = path.join(this.repoRoot, 'node_modules');
    const targetModules = path.join(worktreePath, 'node_modules');

    try {
      const s = await stat(sourceModules);
      if (!s.isDirectory()) return;
    } catch {
      return; // No node_modules in the main repo; nothing to link.
    }

    try {
      await stat(targetModules);
      return; // Target already exists; do not overwrite.
    } catch {
      // expected — fall through to create the junction
    }

    try {
      await symlink(sourceModules, targetModules, 'junction');
    } catch {
      // Junction failed (e.g., POSIX without symlink permission). Non-fatal:
      // the worktree is still usable — blueprints can install deps explicitly.
    }
  }

  /**
   * Unlink any symbolic links inside the worktree (currently just node_modules)
   * before destroying the directory. Without this, recursive deletes follow
   * the link and destroy the target on Windows.
   */
  private async detachLinkedDeps(worktreePath: string): Promise<void> {
    const link = path.join(worktreePath, 'node_modules');
    try {
      const ls = await lstat(link);
      if (ls.isSymbolicLink()) {
        await unlink(link);
      }
    } catch {
      // Not present, not a link, or already detached — nothing to do.
    }
  }

  /** List all active aladeen-managed worktrees. */
  async list(): Promise<WorktreeInfo[]> {
    await this.ensureGitRepo();

    const { stdout } = await this.git('worktree', 'list', '--porcelain');
    return this.parsePorcelain(stdout);
  }

  /** Remove a worktree by task ID. */
  async remove(taskId: string): Promise<void> {
    await this.ensureGitRepo();

    const branch = `${this.branchPrefix}/${taskId}`;
    const worktreePath = path.join(this.worktreeRoot, taskId);

    const existing = await this.list();
    if (!existing.some((w) => w.taskId === taskId)) {
      throw new WorktreeError(
        `No worktree found for task "${taskId}"`,
        'WORKTREE_NOT_FOUND'
      );
    }

    // CRITICAL: detach any symlinked node_modules BEFORE removing the worktree.
    // On Windows, `git worktree remove --force` (and rm -rf) descend into NTFS
    // junctions and delete the link target. Without this step, removing a
    // worktree wipes out the main repo's node_modules. Lesson learned the
    // hard way during the orphaned-state work — see references/learnings.md.
    await this.detachLinkedDeps(worktreePath);

    try {
      await this.git('worktree', 'remove', '--force', worktreePath);
    } catch {
      // If git worktree remove fails, try manual cleanup
      await rm(worktreePath, { recursive: true, force: true });
      await this.git('worktree', 'prune');
    }

    // Clean up the branch
    try {
      await this.git('branch', '-D', branch);
    } catch {
      // Branch may already be deleted; ignore
    }
  }

  /** Remove all aladeen-managed worktrees. */
  async removeAll(): Promise<void> {
    const worktrees = await this.list();
    for (const wt of worktrees) {
      await this.remove(wt.taskId);
    }
  }

  // -- Private helpers --

  private async git(...args: string[]) {
    return execFileAsync('git', args, { cwd: this.repoRoot });
  }

  private async ensureGitRepo(): Promise<void> {
    try {
      await this.git('rev-parse', '--git-dir');
    } catch {
      throw new WorktreeError(
        `"${this.repoRoot}" is not a git repository`,
        'NOT_A_REPO'
      );
    }
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git('rev-parse', '--verify', `refs/heads/${branch}`);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveDefaultBranch(): Promise<string> {
    try {
      const { stdout } = await this.git('symbolic-ref', 'refs/remotes/origin/HEAD');
      // e.g. "refs/remotes/origin/main\n" -> "main"
      return stdout.trim().replace('refs/remotes/origin/', '');
    } catch {
      // Fallback: use HEAD
      return 'HEAD';
    }
  }

  /** Parse `git worktree list --porcelain` output, filtering to aladeen-managed worktrees. */
  private parsePorcelain(output: string): WorktreeInfo[] {
    const results: WorktreeInfo[] = [];
    const blocks = output.split('\n\n').filter(Boolean);

    for (const block of blocks) {
      const lines = block.split('\n');
      let wtPath = '';
      let branch = '';

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wtPath = line.slice('worktree '.length);
        } else if (line.startsWith('branch ')) {
          // e.g. "branch refs/heads/aladeen/task-123"
          branch = line.slice('branch '.length).replace('refs/heads/', '');
        }
      }

      // Only include worktrees managed by aladeen
      if (!branch.startsWith(`${this.branchPrefix}/`)) {
        continue;
      }

      const taskId = branch.slice(`${this.branchPrefix}/`.length);

      // Verify the worktree is under our managed directory
      const normalized = path.normalize(wtPath);
      if (!normalized.startsWith(path.normalize(this.worktreeRoot))) {
        continue;
      }

      results.push({
        taskId,
        path: normalized,
        branch,
        baseBranch: '', // Not available from porcelain output
        createdAt: new Date(), // Not tracked by git; approximate
      });
    }

    return results;
  }
}
