import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { BlueprintFrame } from './BlueprintView.js';
import type { Blueprint, ExecutionState, NodeExecution } from '../engine/types.js';

const blueprint: Blueprint = {
  id: 'tui-test',
  name: 'TUI Retry Counter',
  version: '1.0.0',
  entryNodeId: 'lint',
  nodes: [
    { id: 'lint', label: 'Run linter', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
    { id: 'fix', label: 'Fix lint errors', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
    { id: 'test', label: 'Run tests', kind: 'deterministic', op: { type: 'shell', command: 'noop' } },
  ],
  edges: [
    { from: 'lint', to: 'test', on: 'success' },
    { from: 'lint', to: 'fix', on: 'failure' },
    { from: 'fix', to: 'lint' },
  ],
  defaultContext: { cwd: '.', env: {}, ruleFiles: [], allowedTools: [], store: {} },
};

function exec(over: Partial<NodeExecution> & { nodeId: string; status: NodeExecution['status']; attempts: number }): NodeExecution {
  return { results: [], ...over };
}

function state(over: Partial<ExecutionState> = {}): ExecutionState {
  return {
    runId: 'tui-run-1',
    blueprintId: 'tui-test',
    status: 'running',
    nodeExecutions: {
      lint: exec({ nodeId: 'lint', status: 'running', attempts: 3 }),
      fix:  exec({ nodeId: 'fix',  status: 'completed', attempts: 2 }),
      test: exec({ nodeId: 'test', status: 'pending', attempts: 0 }),
    },
    currentNodeId: 'lint',
    totalRetries: 4,
    context: blueprint.defaultContext,
    startedAt: new Date().toISOString(),
    runPolicy: { mode: 'local-only', cloudFallbackAllowed: false },
    ...over,
  };
}

describe('BlueprintFrame — roadmap M3 "TUI shows retry counters and current node status transitions"', () => {
  it('renders the per-node attempt counter when attempts > 1', () => {
    const { lastFrame } = render(
      <BlueprintFrame blueprint={blueprint} state={state()} logs={[]} done={false} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Run linter');
    // The lint node had 3 attempts; the frame should show "(attempt 3)".
    expect(frame).toContain('(attempt 3)');
    // The fix node had 2 attempts; should also surface.
    expect(frame).toContain('(attempt 2)');
  });

  it('renders the global retry counter from totalRetries', () => {
    const { lastFrame } = render(
      <BlueprintFrame blueprint={blueprint} state={state({ totalRetries: 4 })} logs={[]} done={false} />
    );
    expect(lastFrame()).toContain('4 retries');
  });

  it('marks the current node with the arrow indicator', () => {
    const { lastFrame } = render(
      <BlueprintFrame blueprint={blueprint} state={state({ currentNodeId: 'lint' })} logs={[]} done={false} />
    );
    // The arrow is rendered next to the current node's label.
    const frame = lastFrame() ?? '';
    const lintLine = frame.split('\n').find((l) => l.includes('Run linter')) ?? '';
    expect(lintLine).toContain('<-');
  });

  it('shows ESCALATED status and the escalation reason', () => {
    const { lastFrame } = render(
      <BlueprintFrame
        blueprint={blueprint}
        state={state({
          status: 'escalated',
          currentNodeId: null,
          escalationReason: 'Global retry budget exhausted (3)',
        })}
        logs={[]}
        done={true}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ESCALATED');
    expect(frame).toContain('Global retry budget exhausted');
  });

  it('shows progress as completedCount/totalNodes', () => {
    const { lastFrame } = render(
      <BlueprintFrame blueprint={blueprint} state={state()} logs={[]} done={false} />
    );
    // 1 of 3 nodes completed (the 'fix' node in our synthetic state).
    expect(lastFrame()).toContain('1/3');
  });

  it('renders without state (initial render before runner emits)', () => {
    const { lastFrame } = render(
      <BlueprintFrame blueprint={blueprint} state={null} logs={[]} done={false} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('TUI Retry Counter');
    expect(frame).toContain('0/3');
    expect(frame).toContain('PENDING');
  });
});
