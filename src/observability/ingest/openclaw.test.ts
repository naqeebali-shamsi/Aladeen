import { describe, expect, it } from 'vitest';
import { OpenClawIngester } from './openclaw.js';
import { Scrubber } from '../scrubber.js';

function jsonl(messages: object[]): string {
  return messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
}

describe('OpenClawIngester.ingestText', () => {
  it('maps user/assistant text messages and rolls up usage including USD cost', () => {
    const text = jsonl([
      { role: 'user', content: 'do the thing', timestamp: '2026-05-20T10:00:00.000Z' },
      { role: 'assistant', model: 'opus-4-7',
        content: [{ type: 'text', text: 'on it' }],
        usage: { input_tokens: 100, output_tokens: 20, cost: { total: 0.0042 } },
        timestamp: '2026-05-20T10:00:01.000Z' },
    ]);
    const ingester = new OpenClawIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-1',
      filePath: '/fake/openclaw/agents/cody/sessions/sess-1.jsonl',
      agentId: 'cody',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });

    const kinds = result.trace.events.map((e) => e.kind);
    expect(kinds).toEqual(['session_start', 'user_message', 'agent_message', 'session_end']);

    expect(result.trace.cost?.inputTokens).toBe(100);
    expect(result.trace.cost?.outputTokens).toBe(20);
    expect(result.trace.cost?.estimatedUsd).toBeCloseTo(0.0042);
    expect(result.trace.sessionId).toBe('openclaw:sess-1');
    expect(result.trace.parentSessionId).toBe('openclaw-agent:cody');
    expect(result.trace.agentCli.name).toBe('openclaw');
  });

  it('splits assistant tool_use + user tool_result into tool_call + tool_result, synthesizes file_change on successful Write', () => {
    const text = jsonl([
      { role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: '/home/test/foo.ts', content: 'export const x = 1;' } },
        ],
        timestamp: '2026-05-20T10:00:02.000Z' },
      { role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'wrote 19 bytes' },
        ],
        timestamp: '2026-05-20T10:00:03.000Z' },
      // Failed Edit — no file_change should be emitted.
      { role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: '/home/test/bar.ts', old_string: 'a', new_string: 'b' } },
        ],
        timestamp: '2026-05-20T10:00:04.000Z' },
      { role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-2', content: 'permission denied', is_error: true },
        ],
        timestamp: '2026-05-20T10:00:05.000Z' },
    ]);
    const ingester = new OpenClawIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-2',
      filePath: '/fake/openclaw/agents/cody/sessions/sess-2.jsonl',
      agentId: 'cody',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });

    const kinds = result.trace.events.map((e) => e.kind);
    expect(kinds).toEqual([
      'session_start',
      'tool_call', 'tool_result', 'file_change',   // Successful Write
      'tool_call', 'tool_result',                  // Failed Edit (no file_change)
      'session_end',
    ]);

    const fileChange = result.trace.events.find((e) => e.kind === 'file_change');
    if (fileChange?.kind === 'file_change') {
      expect(fileChange.path).toBe('~/foo.ts');
      expect(fileChange.action).toBe('create');
      expect(fileChange.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    }

    const failResult = result.trace.events.find(
      (e) => e.kind === 'tool_result' && e.callId === 'tool-2',
    );
    if (failResult?.kind === 'tool_result') {
      expect(failResult.ok).toBe(false);
      expect(failResult.errorClass).toBe('permission_denied');
    }
  });

  it('tags user_message.origin for both string and content-array text turns', () => {
    const text = jsonl([
      { role: 'user', content: 'add a logout button to src/nav.tsx', timestamp: '2026-05-20T10:00:00.000Z' },
      { role: 'user', content: '<environment_context><cwd>/home/test</cwd></environment_context>', timestamp: '2026-05-20T10:00:01.000Z' },
      { role: 'user', content: [{ type: 'text', text: '<teammate-message teammate_id="lead">ping</teammate-message>' }], timestamp: '2026-05-20T10:00:02.000Z' },
    ]);
    const ingester = new OpenClawIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-origin',
      filePath: '/x.jsonl',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });

    const origins = result.trace.events
      .filter((e) => e.kind === 'user_message')
      .map((e) => (e.kind === 'user_message' ? e.origin : undefined));
    expect(origins).toEqual(['human', 'injected', 'protocol']);
  });

  it('handles plain string content (Anthropic alternative shape)', () => {
    const text = jsonl([
      { role: 'user', content: 'hello', timestamp: '2026-05-20T10:00:00.000Z' },
    ]);
    const ingester = new OpenClawIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-3',
      filePath: '/x.jsonl',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });
    const userMsg = result.trace.events.find((e) => e.kind === 'user_message');
    expect(userMsg).toBeDefined();
    if (userMsg?.kind === 'user_message') expect(userMsg.text).toBe('hello');
  });

  it('skips system-role messages and counts them in skippedTypes', () => {
    const text = jsonl([
      { role: 'system', content: 'You are a helpful agent.', timestamp: '2026-05-20T10:00:00.000Z' },
      { role: 'user', content: 'hi', timestamp: '2026-05-20T10:00:01.000Z' },
    ]);
    const ingester = new OpenClawIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-4',
      filePath: '/x.jsonl',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });

    expect(result.skippedTypes['role:system']).toBe(1);
    const kinds = result.trace.events.map((e) => e.kind);
    expect(kinds).toEqual(['session_start', 'user_message', 'session_end']);
  });
});
