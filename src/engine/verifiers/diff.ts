import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BlueprintContext, NodeResult } from '../types.js';
import type { IVerifier, DiffVerifierConfig } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Validates that code changes are scoped to the task — no unrelated modifications.
 * Checks file paths against allowed globs, max files, and max diff size.
 */
export class DiffVerifier implements IVerifier {
  readonly id: string;

  constructor(private readonly config: DiffVerifierConfig) {
    this.id = config.id;
  }

  async verify(context: BlueprintContext): Promise<NodeResult> {
    const start = performance.now();
    const baseRef = this.config.baseRef ?? 'HEAD~1';
    const errors: string[] = [];

    let changedFiles: string[];
    let diffStat: string;
    try {
      const { stdout: filesOutput } = await execFileAsync(
        'git',
        ['diff', '--name-only', baseRef],
        { cwd: context.cwd, timeout: this.config.timeoutMs }
      );
      changedFiles = filesOutput.trim().split('\n').filter(Boolean);

      const { stdout: statOutput } = await execFileAsync(
        'git',
        ['diff', '--stat', baseRef],
        { cwd: context.cwd, timeout: this.config.timeoutMs }
      );
      diffStat = statOutput.trim();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        outcome: 'failure',
        output: {},
        error: `Failed to compute diff: ${message}`,
        durationMs: performance.now() - start,
      };
    }

    // Check max files
    if (this.config.maxFiles !== undefined && changedFiles.length > this.config.maxFiles) {
      errors.push(`Too many files changed: ${changedFiles.length} (max: ${this.config.maxFiles})`);
    }

    // Check allowed paths
    if (this.config.allowedPaths.length > 0) {
      const disallowed = changedFiles.filter((f) => !this.matchesAny(f, this.config.allowedPaths));
      if (disallowed.length > 0) {
        errors.push(`Changes outside allowed paths: ${disallowed.join(', ')}`);
      }
    }

    // Check max diff lines
    if (this.config.maxDiffLines !== undefined) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['diff', baseRef],
          { cwd: context.cwd, timeout: this.config.timeoutMs }
        );
        const lineCount = stdout.split('\n').length;
        if (lineCount > this.config.maxDiffLines) {
          errors.push(`Diff too large: ${lineCount} lines (max: ${this.config.maxDiffLines})`);
        }
      } catch {
        errors.push('Failed to count diff lines');
      }
    }

    if (errors.length > 0) {
      return {
        outcome: 'failure',
        output: { changedFiles, diffStat },
        error: errors.join('; '),
        durationMs: performance.now() - start,
      };
    }

    return {
      outcome: 'success',
      output: { changedFiles, diffStat, fileCount: changedFiles.length },
      summary: `${this.config.label}: ${changedFiles.length} file(s) changed, all within scope`,
      durationMs: performance.now() - start,
    };
  }

  /** Simple glob matching: supports * and ** patterns. */
  private matchesAny(filePath: string, patterns: string[]): boolean {
    return patterns.some((pattern) => {
      const regex = pattern
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*');
      return new RegExp(`^${regex}`).test(filePath);
    });
  }
}
