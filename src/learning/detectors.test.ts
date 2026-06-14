import { describe, it, expect } from 'vitest';
import type { SessionEvent, SessionTrace, SessionOutcome } from '../observability/session-trace.js';
import { computeDigest } from '../observability/digest.js';
import {
  detectCompletedButThrashed,
  detectCorrectionFollowup,
  detectEditLoop,
  detectErrorStorm,
  detectInterruptMidAction,
  detectMultiIntentAsk,
  detectRepeatedToolFailure,
  detectVagueOpeningAsk,
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
const userMsgText = (text: string) => ev('user_message', { text });
const userMsgOrigin = (text: string, origin: 'human' | 'injected' | 'protocol') =>
  ev('user_message', { text, origin });

// Builds `total` Bash call/result pairs where the first `failures` come back ok=false
// — enough volume to trip the completed-but-thrashed / derailment thresholds.
function thrashResults(failures: number, total: number): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (let i = 0; i < total; i++) {
    const id = `t${i}`;
    events.push(call('Bash', id));
    events.push(result(id, i >= failures));
  }
  return events;
}

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

describe('detectVagueOpeningAsk', () => {
  it('fires when the opening ask has no anchor and the session derailed', () => {
    const input = inputFor([userMsgText('fix it'), agentMsg(), interrupt('user')], 'interrupted');
    const out = detectVagueOpeningAsk(input);
    expect(out).toHaveLength(1);
    expect(out[0].candidateKey).toBe('vague-opening-ask');
    expect(out[0].category).toBe('user-prompt');
    expect(out[0].evidence).toHaveLength(1);
    expect(out[0].evidence[0].sessionId).toBe('fixture-session');
  });

  it('stays quiet when the session completed cleanly', () => {
    expect(detectVagueOpeningAsk(inputFor([userMsgText('fix it'), agentMsg()], 'completed'))).toHaveLength(0);
  });

  it('stays quiet when the opening names a file path', () => {
    const input = inputFor([userMsgText('fix the JWT bug in src/auth.ts'), agentMsg()], 'errored');
    expect(detectVagueOpeningAsk(input)).toHaveLength(0);
  });

  it('stays quiet when the opening states acceptance criteria', () => {
    const input = inputFor(
      [userMsgText('make login work so that expired tokens are rejected'), agentMsg()],
      'errored',
    );
    expect(detectVagueOpeningAsk(input)).toHaveLength(0);
  });

  it('treats a backtick code span as a concrete anchor', () => {
    const input = inputFor([userMsgText('the `parseToken` helper is broken'), agentMsg()], 'gave_up');
    expect(detectVagueOpeningAsk(input)).toHaveLength(0);
  });

  it('fires on a completed-but-thrashed session with a vague opener', () => {
    const out = detectVagueOpeningAsk(inputFor([userMsgText('make it work'), ...thrashResults(5, 12)], 'completed'));
    expect(out).toHaveLength(1);
  });

  it('skips an injected opening block and flags the first real human ask', () => {
    const injected = '<environment_context><cwd>/x</cwd></environment_context>';
    const input = inputFor(
      [userMsgText(injected), userMsgText('fix it'), agentMsg(), interrupt('user')],
      'interrupted',
    );
    const out = detectVagueOpeningAsk(input);
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toHaveLength(1);
  });

  it('does not fire when every opening message is injected, non-human content', () => {
    const input = inputFor(
      [userMsgText('<task>review this 1. a 2. b 3. c</task>'), agentMsg(), interrupt('user')],
      'interrupted',
    );
    expect(detectVagueOpeningAsk(input)).toHaveLength(0);
  });
});

describe('detectCorrectionFollowup', () => {
  it('fires when a terse correction follows an agent action', () => {
    const input = inputFor(
      [userMsgText('build the feature'), agentMsg(), userMsgText('no, revert that and keep it simple')],
      'completed',
    );
    const out = detectCorrectionFollowup(input);
    expect(out).toHaveLength(1);
    expect(out[0].candidateKey).toBe('correction-followup');
    expect(out[0].category).toBe('user-prompt');
    expect(out[0].evidence).toHaveLength(1);
  });

  it('ignores correction words in the opening message (no prior agent action)', () => {
    expect(detectCorrectionFollowup(inputFor([userMsgText('actually, start fresh')], 'completed'))).toHaveLength(0);
  });

  it('does not treat a forward constraint as a correction', () => {
    const input = inputFor(
      [userMsgText('add a logout button'), agentMsg(), userMsgText("don't touch the tests")],
      'completed',
    );
    expect(detectCorrectionFollowup(input)).toHaveLength(0);
  });

  it('ignores a non-correction follow-up', () => {
    const input = inputFor(
      [userMsgText('add login'), agentMsg(), userMsgText('now add a logout button too')],
      'completed',
    );
    expect(detectCorrectionFollowup(input)).toHaveLength(0);
  });

  it('captures multiple corrections as evidence, one candidate per session', () => {
    const input = inputFor(
      [
        userMsgText('do the thing'),
        agentMsg(), userMsgText('no, not like that'),
        agentMsg(), userMsgText('revert it'),
      ],
      'completed',
    );
    const out = detectCorrectionFollowup(input);
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toHaveLength(2);
  });

  it('stays transparent to an injected block between the agent action and the correction', () => {
    const input = inputFor(
      [
        userMsgText('build it'),
        agentMsg(),
        userMsgText('<system-reminder>budget note</system-reminder>'),
        userMsgText('no, revert that'),
      ],
      'completed',
    );
    expect(detectCorrectionFollowup(input)).toHaveLength(1);
  });

  it('never treats an injected message as a correction, even with marker words', () => {
    const input = inputFor(
      [
        userMsgText('build it'),
        agentMsg(),
        userMsgText('<environment_context>use X instead of Y</environment_context>'),
      ],
      'completed',
    );
    expect(detectCorrectionFollowup(input)).toHaveLength(0);
  });
});

describe('detectMultiIntentAsk', () => {
  it('fires on a numbered-list opening that derailed', () => {
    const ask = 'do three things:\n1. add login\n2. add logout\n3. wire the nav';
    const out = detectMultiIntentAsk(inputFor([userMsgText(ask), agentMsg(), interrupt('user')], 'interrupted'));
    expect(out).toHaveLength(1);
    expect(out[0].candidateKey).toBe('multi-intent-ask');
    expect(out[0].category).toBe('user-prompt');
  });

  it('fires on connector-bundled asks that derailed', () => {
    const input = inputFor(
      [userMsgText('refactor the parser and also add tests and then update the docs'), agentMsg()],
      'errored',
    );
    expect(detectMultiIntentAsk(input)).toHaveLength(1);
  });

  it('stays quiet when the multi-part ask completed cleanly', () => {
    const ask = 'three things:\n1. a\n2. b\n3. c';
    expect(detectMultiIntentAsk(inputFor([userMsgText(ask), agentMsg()], 'completed'))).toHaveLength(0);
  });

  it('stays quiet on a single-intent ask', () => {
    const input = inputFor([userMsgText('rename the variable in src/cli.tsx'), agentMsg()], 'errored');
    expect(detectMultiIntentAsk(input)).toHaveLength(0);
  });

  it('does not fire on an injected blob that contains a list', () => {
    const input = inputFor(
      [userMsgText('<task>do these:\n1. a\n2. b\n3. c</task>'), agentMsg(), interrupt('user')],
      'interrupted',
    );
    expect(detectMultiIntentAsk(input)).toHaveLength(0);
  });
});

describe('prompt detectors honor the ingest origin tag', () => {
  // When user_message.origin is present, it is authoritative — the regex shape
  // heuristic is consulted only as a legacy fallback for untagged traces.

  it('skips a human-looking opening that ingest tagged injected (tag wins over shape)', () => {
    const input = inputFor([userMsgOrigin('fix it', 'injected'), agentMsg(), interrupt('user')], 'interrupted');
    expect(detectVagueOpeningAsk(input)).toHaveLength(0);
  });

  it('mines an injected-looking opening that ingest tagged human (tag wins over shape)', () => {
    const input = inputFor([userMsgOrigin('<task>fix it</task>', 'human'), agentMsg(), interrupt('user')], 'interrupted');
    expect(detectVagueOpeningAsk(input)).toHaveLength(1);
  });

  it('correction-followup ignores a tagged-injected message even with marker words', () => {
    const input = inputFor(
      [userMsgText('build it'), agentMsg(), userMsgOrigin('no, revert that', 'injected')],
      'completed',
    );
    expect(detectCorrectionFollowup(input)).toHaveLength(0);
  });

  it('falls back to shape classification when origin is absent (legacy trace)', () => {
    const injected = inputFor(
      [userMsgText('<environment_context>x</environment_context>'), agentMsg(), interrupt('user')],
      'interrupted',
    );
    expect(detectVagueOpeningAsk(injected)).toHaveLength(0); // shape → injected → skipped
    const human = inputFor([userMsgText('fix it'), agentMsg(), interrupt('user')], 'interrupted');
    expect(detectVagueOpeningAsk(human)).toHaveLength(1);    // shape → human → mined
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

  it('surfaces prompt-quality candidates alongside behavioral ones', () => {
    const input = inputFor([userMsgText('fix it'), agentMsg(), interrupt('user')], 'interrupted');
    const ids = runDetectors(input).map((c) => c.detectorId);
    expect(ids).toContain('interrupt-mid-action');
    expect(ids).toContain('vague-opening-ask');
  });

  it('stays silent on a clean session even with a terse opening ask', () => {
    const input = inputFor(
      [userMsgText('fix it'), call('Read', 'c1'), result('c1', true), agentMsg()],
      'completed',
    );
    expect(runDetectors(input)).toHaveLength(0);
  });
});
