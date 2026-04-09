import { describe, it, expect } from 'vitest';
import { validateBlueprint } from './validate.js';
import type { Blueprint } from './types.js';

const minimalBlueprint: Blueprint = {
  id: 'test-minimal',
  name: 'Minimal',
  version: '1.0.0',
  entryNodeId: 'only',
  nodes: [
    {
      id: 'only',
      label: 'Echo',
      kind: 'deterministic',
      op: { type: 'shell', command: 'echo', args: ['ok'] },
    },
  ],
  edges: [],
  defaultContext: {
    cwd: '.',
    env: {},
    ruleFiles: [],
    allowedTools: [],
    store: {},
  },
};

describe('validateBlueprint', () => {
  it('accepts a minimal valid blueprint', () => {
    const result = validateBlueprint(minimalBlueprint);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
