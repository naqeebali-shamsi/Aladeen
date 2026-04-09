import type { BlueprintContext, NodeResult } from '../types.js';
import type { IVerifier } from './types.js';

/**
 * Chains multiple verifiers in sequence.
 * Stops at the first failure and returns that result.
 * On all-pass, returns an aggregated success result.
 */
export class CompositeVerifier implements IVerifier {
  readonly id: string;

  constructor(
    id: string,
    private readonly verifiers: IVerifier[]
  ) {
    this.id = id;
  }

  async verify(context: BlueprintContext): Promise<NodeResult> {
    const start = performance.now();
    const results: Array<{ id: string; result: NodeResult }> = [];

    for (const verifier of this.verifiers) {
      const result = await verifier.verify(context);
      results.push({ id: verifier.id, result });

      if (result.outcome !== 'success') {
        return {
          outcome: result.outcome,
          output: {
            failedVerifier: verifier.id,
            results: results.map((r) => ({ id: r.id, outcome: r.result.outcome })),
            detail: result.output,
          },
          error: `Verifier "${verifier.id}" failed: ${result.error ?? 'unknown'}`,
          durationMs: performance.now() - start,
        };
      }
    }

    return {
      outcome: 'success',
      output: {
        results: results.map((r) => ({ id: r.id, outcome: r.result.outcome })),
      },
      summary: `All ${this.verifiers.length} verifiers passed`,
      durationMs: performance.now() - start,
    };
  }
}
