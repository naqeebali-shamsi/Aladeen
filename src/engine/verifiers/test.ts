import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BlueprintContext, NodeResult } from '../types.js';
import type { IVerifier, TestVerifierConfig } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Runs a test suite and reports pass/fail with parsed output.
 */
export class TestVerifier implements IVerifier {
  readonly id: string;

  constructor(private readonly config: TestVerifierConfig) {
    this.id = config.id;
  }

  async verify(context: BlueprintContext): Promise<NodeResult> {
    const start = performance.now();

    try {
      const { stdout, stderr } = await execFileAsync(
        this.config.command,
        this.config.args ?? [],
        {
          cwd: context.cwd,
          env: { ...process.env, ...context.env },
          timeout: this.config.timeoutMs,
        }
      );
      return {
        outcome: 'success',
        output: { stdout: stdout.trim(), stderr: stderr.trim() },
        summary: `${this.config.label}: all tests passed`,
        durationMs: performance.now() - start,
      };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      const output = (execErr.stdout ?? '') + (execErr.stderr ?? '');

      return {
        outcome: 'failure',
        output: {
          stdout: (execErr.stdout ?? '').trim(),
          stderr: (execErr.stderr ?? '').trim(),
          exitCode: execErr.code,
          // Include raw output so agentic fix nodes can parse failure details
          rawOutput: output.trim(),
        },
        error: `${this.config.label} failed with exit code ${execErr.code ?? 'unknown'}`,
        durationMs: performance.now() - start,
      };
    }
  }
}
