import { describe, it, expect } from 'vitest';
import type { SessionEvent, SessionTrace, SessionOutcome } from '../observability/session-trace.js';
import { computeDigest } from '../observability/digest.js';
import {
  detectCompletedButThrashed,
  detectEditLoop,
  detectErrorStorm,
  detectInterruptMidAction,
  detectRepeatedToolFailure,
  runDetectors,
} from './detectors.js';

// Fixtures build a real SessionTrace and derive the digest with the real
// computeDigest — detectors are tested against the same projection the
// pipeline produces, not hand-rolled digests that could drift.

const SRC = { kind: 'claude-code-jsonl', file: 'fixture.jsonl' } as const;

let seqCounter = 0;
function ev<K extends SessionEvent['kind']>(kind: K, fields: Record<string, unknown> = {}): SessionEvent {
  return { kind, seq: seqCounter++, source: SRC, ...fields } as SessionEvent;
}
const call = (toolName: string, callId: string) => ev('tool_call', { toolName, callId, args: {} });
const result = (callId: string, ok: boolean, errorClass?: string) =>
  ev('tool_result', { callId, ok, errorClass });
const edit = (path: string) => ev('file_change', { action: 'edit', path });
const agentMsg = () => ev('agent_message', { text: 'working on it' });
const userMsg = () => ev('user_message', { text: 'please do the thing' });
const interrupt = (initiator: 'user' | 'system' | 'unknown') => ev('interrupt', { initiator });
const errorEv = (errorClass: string) => ev('error', { errorClass, message: 'boom', fatal: false });

function makeTrace(events: SessionEvent[], outcome: SessionOutcome = 'completed'): SessionTrace {
  return {
    schemaVersion: '1',
    sessionId: 'fixture-session',
    agentCli: { name: 'claude-code' },
    workspace: { cwdScrubbed: '~/repo' },
    outcome,
    events,
    scrubbing: { passes: [] },
  };
}

function inputFor(events: SessionEvent[], outcome: SessionOutcome = 'completed') {
  seqCounter = 0;
  const evs = events;
  const trace = makeTrace(evs, outcome);
  return { trace, digest: computeDigest(trace) };
}

describe('detectRepeatedToolFailure', () => {
  it('fires after 3 failures of the same tool with no intervening success of that tool', () => {
    const input = inputFor([
      call('Bash', 'c1'), result('c1', false, 'timeout'),
      call('Read', 'r1'), result('r1', true), // other-tool success does NOT reset
      call('Bash', 'c2'), result('c2', false, 'timeout'),
      call('Bash', 'c3'), result('c3', false, 'timeout'),
    ]);
    const out = detectRepeatedToolFailure(input);
    expect(out).toHaveLength(1);
    expect(out[0].candidateKey).toBe('repeated-tool-failure|Bash|timeout');
    expect(out[0].dims).toEqual({ toolName: 'Bash', errorClass: 'timeout' });
    expect(out[0].evidence).toHaveLength(3);
    expect(out[0].evidence.every((e) => e.sessionId === 'fixture-session')).toBe(true);
  });

  it('resets the streak when the same tool later succeeds', () => {
    const input = inputFor([
      call('Bash', 'c1'), result('c1', false),
      call('Bash', 'c2'), result('c2', false),
      call('Bash', 'c3'), result('c3', true), // reset
      call('Bash', 'c4'), result('c4', false),
      call('Bash', 'c5'), result('c5', false),
    ]);
    expect(detectRepeatedToolFailure(input)).toHaveLength(0);
  });

  it('defaults the errorClass dim to tool_error when results carry none', () => {
    const input = inputFor([
      call('Edit', 'c1'), result('c1', false),
      call('Edit', 'c2'), result('c2', false),
      call('Edit', 'c3'), result('c3', false),
    ]);
    expect(detectRepeatedToolFailure(input)[0].candidateKey).toBe('repeated-tool-failure|Edit|tool_error');
  });
});

describe('detectEditLoop', () => {
  it('lifts digest editLoops into per-file candidates keyed by basename', () => {
    const input = inputFor([
      edit('C:\\repo\\src\\cli.tsx'), edit('C:\\repo\\src\\cli.tsx'),
      edit('C:\\repo\\src\\cli.tsx'), edit('C:\\repo\\src\\cli.tsx'),
      edit('C:\\repo\\src\\cli.tsx'),
    ]);
    const out = detectEditLoop(input);
    expect(out).toHaveLength(1);
    expect(out[0].candidateKey).toBe('edit-loop|cli.tsx');
    expect(out[0].evidence.length).toBeGreaterThan(0);
  });

  it('stays quiet below the digest edit-loop threshold', () => {
    const input = inputFor([edit('a.ts'), edit('a.ts'), edit('a.ts')]);
    expect(detectEditLoop(input)).toHaveLength(0);
  });
});

describe('detectInterruptMidAction', () => {
  it('fires when a user interrupt lands mid-action', () => {
    const input = inputFor([userMsg(), agentMsg(), interrupt('user')], 'interrupted');
    const out = detectInterruptMidAction(input);
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('user-prompt');
  });

  it('ignores interrupts that follow a user message (not mid-action)', () => {
    const input = inputFor([agentMsg(), userMsg(), interrupt('user')], 'interrupted');
    expect(detectInterruptMidAction(input)).toHaveLength(0);
  });

  it('ignores non-user initiators', () => {
    const input = inputFor([agentMsg(), interrupt('system')], 'interrupted');
    expect(detectInterruptMidAction(input)).toHaveLength(0);
  });

  it('emits a single candidate per session no matter how many interrupts', () => {
    const input = inputFor(
      [agentMsg(), interrupt('user'), agentMsg(), interrupt('user')],
      'interrupted',
    );
    const out = detectInterruptMidAction(input);
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toHaveLength(2);
  });
});

describe('detectErrorStorm', () => {
  it('fires for an error class recurring >=3 times', () => {
    const input = inputFor([errorEv('network'), errorEv('network'), errorEv('network')]);
    const out = detectErrorStorm(input);
    expect(out).toHaveLength(1);
    expect(out[0].candidateKey).toBe('error-storm|network');
    expect(out[0].category).toBe('environment');
  });

  it('never fires for unknown — a storm of unclassified errors supports no statement', () => {
    const input = inputFor([errorEv('unknown'), errorEv('unknown'), errorEv('unknown')]);
    expect(detectErrorStorm(input)).toHaveLength(0);
  });

  it('is suppressed for classes already claimed by repeated-tool-failure in runDetectors', () => {
    const input = inputFor([
      call('Bash', 'c1'), result('c1', false, 'timeout'),
      call('Bash', 'c2'), result('c2', false, 'timeout'),
      call('Bash', 'c3'), result('c3', false, 'timeout'),
    ]);
    const all = runDetectors(input);
    const ids = all.map((c) => c.detectorId);
    expect(ids).toContain('repeated-tool-failure');
    expect(ids).not.toContain('error-storm');
  });
});

describe('detectCompletedButThrashed', () => {
  function thrashEvents(failures: number, total: number): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (let i = 0; i < total; i++) {
      const id = `t${i}`;
      events.push(call('Bash', id));
      events.push(result(id, i >= failures));
    }
    return events;
  }

  it('fires on a completed session with >=40% tool failures over >=10 results', () => {
    const out = detectCompletedButThrashed(inputFor(thrashEvents(5, 12), 'completed'));
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('process');
  });

  it('stays quiet on non-completed outcomes (those are visible failures already)', () => {
    expect(detectCompletedButThrashed(inputFor(thrashEvents(5, 12), 'errored'))).toHaveLength(0);
  });

  it('stays quiet under the volume floor', () => {
    expect(detectCompletedButThrashed(inputFor(thrashEvents(4, 8), 'completed'))).toHaveLength(0);
  });

  it('stays quiet under the failure-rate floor', () => {
    expect(detectCompletedButThrashed(inputFor(thrashEvents(3, 12), 'completed'))).toHaveLength(0);
  });
});

describe('runDetectors', () => {
  it('returns nothing for a clean session', () => {
    const input = inputFor([
      userMsg(),
      call('Read', 'c1'), result('c1', true),
      agentMsg(),
    ]);
    expect(runDetectors(input)).toHaveLength(0);
  });

  it('stamps provider, fingerprint, and detector version on every candidate', () => {
    const input = inputFor([
      call('Bash', 'c1'), result('c1', false),
      call('Bash', 'c2'), result('c2', false),
      call('Bash', 'c3'), result('c3', false),
    ]);
    const [c] = runDetectors(input);
    expect(c.agentCli).toBe('claude-code');
    expect(c.patternFingerprint).toBe(input.digest.patternFingerprint);
    expect(c.detectorVersion).toBe('1');
  });
});
