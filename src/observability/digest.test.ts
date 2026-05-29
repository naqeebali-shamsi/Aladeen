import { describe, expect, it } from 'vitest';
import { computeDigest } from './digest.js';
import type { SessionTrace, SessionEvent } from './session-trace.js';

function trace(events: SessionEvent[], over: Partial<SessionTrace> = {}): SessionTrace {
  return {
    schemaVersion: '1',
    sessionId: 'sess-1',
    agentCli: { name: 'claude-code' },
    workspace: { cwdScrubbed: '~/Aladeen' },
    startedAt: '2026-05-19T10:00:00.000Z',
    endedAt: '2026-05-19T10:01:00.000Z',
    outcome: 'completed',
    events,
    scrubbing: { passes: [] },
    ...over,
  };
}

describe('computeDigest', () => {
  it('counts tool usage, failures, and edit loops', () => {
    const events: SessionEvent[] = [
      { kind: 'session_start', seq: 0, source: { kind: 'claude-code-jsonl', file: 'x' } },
      { kind: 'tool_call', seq: 1, source: { kind: 'claude-code-jsonl', file: 'x' }, toolName: 'Edit', callId: 'a', args: {} },
      { kind: 'tool_result', seq: 2, source: { kind: 'claude-code-jsonl', file: 'x' }, callId: 'a', ok: true },
      { kind: 'file_change', seq: 3, source: { kind: 'claude-code-jsonl', file: 'x' }, action: 'edit', path: 'src/foo.ts' },
      { kind: 'file_change', seq: 4, source: { kind: 'claude-code-jsonl', file: 'x' }, action: 'edit', path: 'src/foo.ts' },
      { kind: 'file_change', seq: 5, source: { kind: 'claude-code-jsonl', file: 'x' }, action: 'edit', path: 'src/foo.ts' },
      { kind: 'file_change', seq: 6, source: { kind: 'claude-code-jsonl', file: 'x' }, action: 'edit', path: 'src/foo.ts' },
      { kind: 'tool_call', seq: 7, source: { kind: 'claude-code-jsonl', file: 'x' }, toolName: 'Bash', callId: 'b', args: {} },
      { kind: 'tool_result', seq: 8, source: { kind: 'claude-code-jsonl', file: 'x' }, callId: 'b', ok: false, errorClass: 'binary_not_found' },
      { kind: 'session_end', seq: 9, source: { kind: 'claude-code-jsonl', file: 'x' } },
    ];

    const d = computeDigest(trace(events, { outcome: 'errored' }));
    expect(d.toolUsage).toEqual({ Edit: 1, Bash: 1 });
    expect(d.toolFailureCount).toBe(1);
    expect(d.errorCounts.binary_not_found).toBe(1);
    expect(d.filesChanged).toEqual(['src/foo.ts']);
    expect(d.editLoops).toEqual([{ path: 'src/foo.ts', editCount: 4 }]);
    expect(d.durationMs).toBe(60_000);
    expect(d.patternFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it('computes activeDurationMs by skipping idle gaps over 10 minutes', () => {
    const events: SessionEvent[] = [
      { kind: 'user_message', seq: 0, source: { kind: 'claude-code-jsonl', file: 'x' }, timestamp: '2026-05-19T10:00:00.000Z', text: 'a' },
      { kind: 'agent_message', seq: 1, source: { kind: 'claude-code-jsonl', file: 'x' }, timestamp: '2026-05-19T10:00:30.000Z', text: 'b' },
      // 1 hour gap (idle) → excluded
      { kind: 'user_message', seq: 2, source: { kind: 'claude-code-jsonl', file: 'x' }, timestamp: '2026-05-19T11:00:30.000Z', text: 'c' },
      { kind: 'agent_message', seq: 3, source: { kind: 'claude-code-jsonl', file: 'x' }, timestamp: '2026-05-19T11:01:00.000Z', text: 'd' },
    ];
    const d = computeDigest(trace(events, {
      startedAt: '2026-05-19T10:00:00.000Z',
      endedAt: '2026-05-19T11:01:00.000Z',
    }));
    expect(d.durationMs).toBe(61 * 60 * 1000);            // wall-clock 61 min
    expect(d.activeDurationMs).toBe(30_000 + 30_000);     // 30s + 30s, gap excluded
  });

  it('buckets failure-rate into none/low/mid/high in the fingerprint', () => {
    const mkResults = (failRatio: number): SessionEvent[] => {
      const out: SessionEvent[] = [];
      for (let i = 0; i < 10; i++) {
        out.push({
          kind: 'tool_result', seq: i, source: { kind: 'claude-code-jsonl', file: 'x' },
          callId: `c${i}`, ok: i / 10 >= failRatio,
          errorClass: i / 10 < failRatio ? 'tool_error' : undefined,
        });
      }
      return out;
    };
    const low = computeDigest(trace(mkResults(0.1), { outcome: 'errored' }));
    const mid = computeDigest(trace(mkResults(0.4), { outcome: 'errored' }));
    const high = computeDigest(trace(mkResults(0.8), { outcome: 'errored' }));
    // All three should have different fingerprints because the bucket
    // changes. (Same agentCli + outcome + top error class otherwise.)
    expect(new Set([low.patternFingerprint, mid.patternFingerprint, high.patternFingerprint]).size).toBe(3);
  });

  it('produces the same fingerprint for runs with the same shape', () => {
    const mkEvents = (): SessionEvent[] => [
      { kind: 'tool_result', seq: 0, source: { kind: 'claude-code-jsonl', file: 'x' }, callId: 'a', ok: false, errorClass: 'rate_limit' },
      { kind: 'file_change', seq: 1, source: { kind: 'claude-code-jsonl', file: 'x' }, action: 'edit', path: 'src/x.ts' },
    ];
    const a = computeDigest(trace(mkEvents(), { sessionId: 'one', outcome: 'errored' }));
    const b = computeDigest(trace(mkEvents(), { sessionId: 'two', outcome: 'errored' }));
    expect(a.patternFingerprint).toBe(b.patternFingerprint);
  });

  it('produces different fingerprints when outcome differs', () => {
    const events: SessionEvent[] = [
      { kind: 'file_change', seq: 0, source: { kind: 'claude-code-jsonl', file: 'x' }, action: 'edit', path: 'src/x.ts' },
    ];
    const a = computeDigest(trace(events, { outcome: 'completed' }));
    const b = computeDigest(trace(events, { outcome: 'errored' }));
    expect(a.patternFingerprint).not.toBe(b.patternFingerprint);
  });
});
