import { describe, it, expect } from 'vitest';
import { createImplementFeatureLocalBlueprint } from './implement-feature.js';
import { validateBlueprint } from '../engine/validate.js';

const bp = createImplementFeatureLocalBlueprint({
  taskId: 'e2e-001',
  prompt: 'Add a formatDuration helper.',
  adapterId: 'claude',
  repoRoot: '/tmp/repo',
});

describe('createImplementFeatureLocalBlueprint — roadmap M2 structural contract', () => {
  it('passes validateBlueprint (M2: "Blueprint validates with validateBlueprint")', () => {
    const { valid, errors } = validateBlueprint(bp);
    expect(valid, errors.join('; ')).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('includes all deterministic gate nodes (M2: "All gate nodes are present")', () => {
    const ids = new Set(bp.nodes.map((n) => n.id));
    for (const gate of ['typecheck', 'lint', 'test', 'verify-branch']) {
      expect(ids, `missing gate node: ${gate}`).toContain(gate);
    }
  });

  it('has NO git push action anywhere (M2: "Remove default remote push from local-only flow")', () => {
    const pushNodes = bp.nodes.filter(
      (n) => n.kind === 'deterministic' && n.op.type === 'git' && n.op.action === 'push'
    );
    expect(pushNodes).toHaveLength(0);
  });

  it('declares a bounded time budget (M2: "Run terminates ... in bounded time")', () => {
    expect(bp.maxDurationMs).toBeGreaterThan(0);
    expect(bp.maxTotalRetries).toBeGreaterThanOrEqual(0);
  });

  it('routes lint/test failures through their fix-loop nodes', () => {
    // Failure edges exist
    expect(bp.edges).toContainEqual(
      expect.objectContaining({ from: 'lint', to: 'fix-lint', on: 'failure' })
    );
    expect(bp.edges).toContainEqual(
      expect.objectContaining({ from: 'test', to: 'fix-tests', on: 'failure' })
    );
    // Fix nodes cycle back into their gate
    expect(bp.edges).toContainEqual(expect.objectContaining({ from: 'fix-lint', to: 'lint' }));
    expect(bp.edges).toContainEqual(expect.objectContaining({ from: 'fix-tests', to: 'test' }));
  });
});
