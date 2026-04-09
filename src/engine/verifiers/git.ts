import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BlueprintContext, NodeResult } from '../types.js';
import type { IVerifier, GitVerifierConfig } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Verifies git repository state: clean working tree, no conflicts, correct branch, etc.
 */
export class GitVerifier implements IVerifier {
  readonly id: string;

  constructor(private readonly config: GitVerifierConfig) {
    this.id = config.id;
  }

  async verify(context: BlueprintContext): Promise<NodeResult> {
    const start = performance.now();
    const errors: string[] = [];
    const details: Record<string, unknown> = {};

    for (const check of this.config.checks) {
      const result = await this.runCheck(check, context);
      details[check] = result;
      if (!result.ok) {
        errors.push(result.message);
      }
    }

    if (errors.length > 0) {
      return {
        outcome: 'failure',
        output: details,
        error: errors.join('; '),
        durationMs: performance.now() - start,
      };
    }

    return {
      outcome: 'success',
      output: details,
      summary: `${this.config.label}: all git checks passed`,
      durationMs: performance.now() - start,
    };
  }

  private async runCheck(
    check: string,
    context: BlueprintContext
  ): Promise<{ ok: boolean; message: string }> {
    const git = (...args: string[]) =>
      execFileAsync('git', args, { cwd: context.cwd, timeout: this.config.timeoutMs });

    switch (check) {
      case 'clean': {
        const { stdout } = await git('status', '--porcelain');
        const clean = stdout.trim() === '';
        return { ok: clean, message: clean ? 'Working tree is clean' : 'Working tree has uncommitted changes' };
      }

      case 'no-conflicts': {
        const { stdout } = await git('diff', '--name-only', '--diff-filter=U');
        const noConflicts = stdout.trim() === '';
        return { ok: noConflicts, message: noConflicts ? 'No merge conflicts' : `Merge conflicts in: ${stdout.trim()}` };
      }

      case 'on-branch': {
        const { stdout } = await git('rev-parse', '--abbrev-ref', 'HEAD');
        const branch = stdout.trim();
        if (this.config.branchPattern) {
          const re = new RegExp(this.config.branchPattern);
          const matches = re.test(branch);
          return { ok: matches, message: matches ? `On branch "${branch}"` : `Branch "${branch}" does not match pattern "${this.config.branchPattern}"` };
        }
        const onBranch = branch !== 'HEAD'; // Detached HEAD check
        return { ok: onBranch, message: onBranch ? `On branch "${branch}"` : 'Detached HEAD state' };
      }

      case 'committed': {
        const { stdout } = await git('status', '--porcelain');
        const hasChanges = stdout.trim() !== '';
        return { ok: !hasChanges, message: hasChanges ? 'There are uncommitted changes' : 'All changes committed' };
      }

      default:
        return { ok: false, message: `Unknown check: ${check}` };
    }
  }
}
