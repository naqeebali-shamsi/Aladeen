import type { VerifierScorecard } from './types.js';

export interface GateDefinition {
  id: string;
  required: boolean;
}

export function aggregateGateResults(
  gates: GateDefinition[],
  outcomes: Record<string, 'success' | 'failure' | 'retry'>
): VerifierScorecard {
  const results = gates.map((gate) => ({
    id: gate.id,
    required: gate.required,
    outcome: outcomes[gate.id] ?? 'failure',
  }));
  const failedRequired = results.find((r) => r.required && r.outcome !== 'success');
  return {
    gateOrder: gates.map((g) => g.id),
    results,
    passed: !failedRequired,
    failedRequiredGate: failedRequired?.id,
  };
}
