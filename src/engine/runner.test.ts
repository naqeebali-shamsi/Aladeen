import { describe, it, expect } from 'vitest';
import { BlueprintRunner } from './runner.js';
import type { Blueprint, BlueprintNode, INodeExecutor, NodeResult } from './types.js';

class StubExecutor implements INodeExecutor {
  constructor(private readonly outcomes: Map<string, NodeResult>) {}
  async execute(node: BlueprintNode): Promise<NodeResult> {
    const r = this.outcomes.get(node.id);
    if (!r) throw new Error(`no stubbed outcome for node ${node.id}`);
    return r;
  }
}

const failResult: NodeResult = { outcome: 'failure', output: {}, durationMs: 1, error: 'boom' };
const okResult: NodeResult = { outcome: 'success', output: {}, durationMs: 1 };

const loopBlueprint: Blueprint = {
  id: 'loop-test',
  name: 'Lint→Fix→Lint loop',
  version: '1.0.0',
  entryNodeId: 'lint',
  maxTotalRetries: 3,
  nodes: [
    { id: 'lint', label: 'lint', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
    { id: 'fix', label: 'fix',  kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
  ],
  edges: [
    { from: 'lint', to: 'fix', on: 'failure' },
    { from: 'fix',  to: 'lint' },
  ],
  defaultContext: { cwd: '.', env: {}, ruleFiles: [], allowedTools: [], store: {} },
};

describe('BlueprintRunner — bounded retries', () => {
  it('terminates a deterministic failure→fix loop via maxTotalRetries', async () => {
    const runner = new BlueprintRunner();
    const stub = new StubExecutor(new Map([
      ['lint', failResult],
      ['fix', okResult],
    ]));
    // Inject our stub for both kinds (loop only uses deterministic).
    (runner as unknown as { deterministicExec: INodeExecutor }).deterministicExec = stub;

    const final = await runner.run(loopBlueprint);

    expect(final.status).toBe('escalated');
    expect(final.escalationReason).toMatch(/Global retry budget/);
    expect(final.nodeExecutions['lint']!.attempts).toBeLessThanOrEqual(5);
  });
});
