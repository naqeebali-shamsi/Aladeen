import { describe, expect, it } from 'vitest';
import { AladeenRunsIngester } from './aladeen-runs.js';
import { Scrubber } from '../scrubber.js';
import type { ExecutionState } from '../../engine/types.js';

function baseState(over: Partial<ExecutionState> = {}): ExecutionState {
  return {
    runId: 'run-1',
    blueprintId: 'smoke-test',
    status: 'completed',
    nodeExecutions: {},
    currentNodeId: null,
    totalRetries: 0,
    context: {
      cwd: '/home/test/repo',
      env: {},
      ruleFiles: [],
      allowedTools: [],
      store: {},
    },
    startedAt: '2026-05-19T10:00:00.000Z',
    completedAt: '2026-05-19T10:00:30.000Z',
    ...over,
  };
}

describe('AladeenRunsIngester.ingestText', () => {
  it('maps node attempts to tool_call + tool_result pairs', () => {
    const state = baseState({
      nodeExecutions: {
        echo: {
          nodeId: 'echo',
          status: 'completed',
          attempts: 1,
          results: [{
            outcome: 'success', output: { stdout: 'hello', exitCode: 0 },
            summary: 'Command "echo" exited with code 0', durationMs: 12,
          }],
          startedAt: '2026-05-19T10:00:00.000Z',
          completedAt: '2026-05-19T10:00:00.012Z',
        },
        lint: {
          nodeId: 'lint',
          status: 'failed',
          attempts: 2,
          results: [
            { outcome: 'failure', output: {}, summary: 'eslint error in src/x.ts', error: 'eslint failed', durationMs: 100 },
            { outcome: 'failure', output: {}, summary: 'still failing', error: 'eslint failed', durationMs: 110 },
          ],
          startedAt: '2026-05-19T10:00:01.000Z',
          completedAt: '2026-05-19T10:00:02.000Z',
        },
      },
    });

    const ingester = new AladeenRunsIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(JSON.stringify(state), '/tmp/run-1.json', {
      mtime: new Date('2026-01-01T00:00:00.000Z'),
    });

    const kinds = result.trace.events.map((e) => e.kind);
    // session_start + (echo call+result) + (lint call+result × 2 attempts) + session_end = 8
    expect(kinds).toEqual([
      'session_start',
      'tool_call', 'tool_result',                        // echo
      'tool_call', 'tool_result',                        // lint attempt 1
      'tool_call', 'tool_result',                        // lint attempt 2
      'session_end',
    ]);

    const toolResults = result.trace.events.filter((e) => e.kind === 'tool_result');
    expect(toolResults).toHaveLength(3);
    // First (echo) succeeds; rest fail.
    if (toolResults[0].kind === 'tool_result') expect(toolResults[0].ok).toBe(true);
    if (toolResults[1].kind === 'tool_result') {
      expect(toolResults[1].ok).toBe(false);
      expect(toolResults[1].errorClass).toBe('lint_loop');
    }

    // The blueprintId link is preserved for future replay correlation.
    expect(result.trace.ingesterExtras?.aladeen).toMatchObject({ blueprintId: 'smoke-test' });
  });

  it('maps run status to session outcome', () => {
    const ingester = new AladeenRunsIngester(new Scrubber({ homeDir: '/home/test' }));
    const mk = (status: ExecutionState['status']) =>
      ingester.ingestText(JSON.stringify(baseState({ status })), '/tmp/x.json', {
        mtime: new Date('2026-01-01T00:00:00.000Z'),
      }).trace.outcome;

    expect(mk('completed')).toBe('completed');
    expect(mk('failed')).toBe('errored');
    expect(mk('escalated')).toBe('gave_up');
    expect(mk('abandoned')).toBe('gave_up');
    expect(mk('pending')).toBe('unknown');
  });

  it('synthesizes file_change events from successful file-write nodes', () => {
    const state = baseState({
      nodeExecutions: {
        write: {
          nodeId: 'write',
          status: 'completed',
          attempts: 1,
          results: [{
            outcome: 'success',
            output: { path: '/home/test/repo/out.txt' },
            summary: 'Wrote /home/test/repo/out.txt',
            durationMs: 8,
          }],
          startedAt: '2026-05-19T10:00:00.000Z',
          completedAt: '2026-05-19T10:00:00.008Z',
        },
      },
    });

    const ingester = new AladeenRunsIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(JSON.stringify(state), '/tmp/x.json', {
      mtime: new Date('2026-01-01T00:00:00.000Z'),
    });
    const fc = result.trace.events.find((e) => e.kind === 'file_change');
    expect(fc).toBeDefined();
    if (fc?.kind === 'file_change') {
      expect(fc.path).toBe('~/repo/out.txt');
    }
  });

  it('returns a stub trace with a warning when the JSON does not match the schema', () => {
    const ingester = new AladeenRunsIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(JSON.stringify({ runId: 'bad', not_a_field: true }), '/tmp/bad.json');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.trace.sessionId).toBe('aladeen:bad');
    expect(result.trace.outcome).toBe('unknown');
  });
});
