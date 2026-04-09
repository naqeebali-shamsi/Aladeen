import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BlueprintContext, NodeResult } from '../types.js';
import type { IVerifier, LintVerifierConfig } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Runs a configurable linter and reports results.
 * Optionally attempts auto-fix before the final check.
 */
export class LintVerifier implements IVerifier {
  readonly id: string;

  constructor(private readonly config: LintVerifierConfig) {
    this.id = config.id;
  }

  async verify(context: BlueprintContext): Promise<NodeResult> {
    const start = performance.now();
    const opts = { cwd: context.cwd, env: { ...process.env, ...context.env }, timeout: this.config.timeoutMs };

    // Auto-fix pass
    if (this.config.autoFix && this.config.autoFixArgs) {
      try {
        await execFileAsync(
          this.config.command,
          [...(this.config.args ?? []), ...this.config.autoFixArgs],
          opts
        );
      } catch {
        // Auto-fix may exit non-zero if some issues remain; continue to check pass
      }
    }

    // Check pass
    try {
      const { stdout, stderr } = await execFileAsync(
        this.config.command,
        this.config.args ?? [],
        opts
      );
      return {
        outcome: 'success',
        output: { stdout: stdout.trim(), stderr: stderr.trim() },
        summary: `${this.config.label}: all checks passed`,
        durationMs: performance.now() - start,
      };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; message?: string };
      return {
        outcome: 'failure',
        output: {
          stdout: (execErr.stdout ?? '').trim(),
          stderr: (execErr.stderr ?? '').trim(),
        },
        error: `${this.config.label} failed: ${execErr.stderr ?? execErr.message ?? 'unknown'}`,
        durationMs: performance.now() - start,
      };
    }
  }
}
