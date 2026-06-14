import { describe, expect, it } from 'vitest';
import { CodexIngester } from './codex.js';
import { Scrubber } from '../scrubber.js';

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('CodexIngester.ingestText', () => {
  it('maps message / function_call / function_call_output into the standard event stream', () => {
    const text = jsonl([
      { timestamp: '2026-02-19T10:00:00.000Z', type: 'session_meta', payload: {
          id: '019c7604', timestamp: '2026-02-19T10:00:00.000Z',
          cwd: '/home/test/repo', model_provider: 'openai', cli_version: '0.104.0',
      }},
      { timestamp: '2026-02-19T10:00:01.000Z', type: 'response_item', payload: {
          type: 'message', role: 'developer', content: [{ type: 'text', text: 'system instructions...' }],
      }},
      { timestamp: '2026-02-19T10:00:02.000Z', type: 'response_item', payload: {
          type: 'message', role: 'user', content: 'list the repo',
      }},
      { timestamp: '2026-02-19T10:00:03.000Z', type: 'response_item', payload: {
          type: 'function_call', name: 'shell_command', call_id: 'call_1',
          arguments: JSON.stringify({ command: 'ls', workdir: '/home/test/repo' }),
      }},
      { timestamp: '2026-02-19T10:00:04.000Z', type: 'response_item', payload: {
          type: 'function_call_output', call_id: 'call_1',
          output: 'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nfoo.ts\nbar.ts',
      }},
      { timestamp: '2026-02-19T10:00:05.000Z', type: 'response_item', payload: {
          type: 'function_call', name: 'shell_command', call_id: 'call_2',
          arguments: JSON.stringify({ command: 'badcmd', workdir: '/home/test/repo' }),
      }},
      { timestamp: '2026-02-19T10:00:06.000Z', type: 'response_item', payload: {
          type: 'function_call_output', call_id: 'call_2',
          output: "Exit code: 127\nOutput:\n'badcmd' is not recognized as an internal or external command",
      }},
      { timestamp: '2026-02-19T10:00:07.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ]);

    const ingester = new CodexIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, '/tmp/rollout.jsonl', {
      mtime: new Date('2026-01-01T00:00:00.000Z'),
    });

    const kinds = result.trace.events.map((e) => e.kind);
    expect(kinds).toEqual([
      'session_start',
      'user_message',
      'tool_call', 'tool_result',
      'tool_call', 'tool_result',
      'session_end',
    ]);

    expect(result.trace.agentCli).toEqual({ name: 'codex', version: '0.104.0' });
    expect(result.trace.workspace.cwdScrubbed).toBe('~/repo');

    const failResult = result.trace.events.find((e) => e.kind === 'tool_result' && !e.ok);
    if (failResult?.kind === 'tool_result') {
      expect(failResult.errorClass).toBe('binary_not_found');
    }

    // Developer/system messages don't pollute the event stream.
    expect(result.skippedTypes['message:developer']).toBe(1);
  });

  it('tags user_message.origin: human prompt vs injected context vs protocol', () => {
    const text = jsonl([
      { timestamp: '2026-02-19T10:00:01.000Z', type: 'response_item', payload: {
          type: 'message', role: 'user', content: 'list the repo and explain src/cli.tsx',
      }},
      // Codex funnels env/context/abort notices through role=user too.
      { timestamp: '2026-02-19T10:00:02.000Z', type: 'response_item', payload: {
          type: 'message', role: 'user', content: [{ type: 'text', text: '<environment_context><cwd>/home/test/repo</cwd></environment_context>' }],
      }},
      { timestamp: '2026-02-19T10:00:03.000Z', type: 'response_item', payload: {
          type: 'message', role: 'user', content: '<turn_aborted>The user interrupted the previous response</turn_aborted>',
      }},
      { timestamp: '2026-02-19T10:00:04.000Z', type: 'response_item', payload: {
          type: 'message', role: 'user', content: '<subagent_notification>child done</subagent_notification>',
      }},
    ]);
    const ingester = new CodexIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, '/tmp/rollout.jsonl', { mtime: new Date('2026-01-01T00:00:00.000Z') });

    const origins = result.trace.events
      .filter((e) => e.kind === 'user_message')
      .map((e) => (e.kind === 'user_message' ? e.origin : undefined));
    expect(origins).toEqual(['human', 'injected', 'injected', 'protocol']);
  });

  it('treats absent "Exit code:" prefix as ok=true (custom tool output convention)', () => {
    const text = jsonl([
      { timestamp: '2026-02-19T10:00:01.000Z', type: 'response_item', payload: {
          type: 'function_call', name: 'web_search', call_id: 'call_w',
          arguments: JSON.stringify({ query: 'codex docs' }),
      }},
      { timestamp: '2026-02-19T10:00:02.000Z', type: 'response_item', payload: {
          type: 'function_call_output', call_id: 'call_w',
          output: 'Search results: [...]',
      }},
    ]);
    const ingester = new CodexIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, '/tmp/x.jsonl', { mtime: new Date('2026-01-01T00:00:00.000Z') });
    const tr = result.trace.events.find((e) => e.kind === 'tool_result');
    if (tr?.kind === 'tool_result') expect(tr.ok).toBe(true);
  });

  it('falls back to {raw: ...} when function_call arguments are not valid JSON', () => {
    const text = jsonl([
      { timestamp: '2026-02-19T10:00:01.000Z', type: 'response_item', payload: {
          type: 'function_call', name: 'shell_command', call_id: 'call_x',
          arguments: '{"command": "ls"',  // truncated
      }},
    ]);
    const ingester = new CodexIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, '/tmp/x.jsonl', { mtime: new Date('2026-01-01T00:00:00.000Z') });
    const call = result.trace.events.find((e) => e.kind === 'tool_call');
    if (call?.kind === 'tool_call') {
      expect(call.args).toHaveProperty('raw');
    }
  });

  it('flags a dangling function_call (no matching output) as gave_up', () => {
    const text = jsonl([
      { timestamp: '2026-02-19T10:00:01.000Z', type: 'response_item', payload: {
          type: 'function_call', name: 'shell_command', call_id: 'call_d',
          arguments: JSON.stringify({ command: 'sleep 99' }),
      }},
    ]);
    const ingester = new CodexIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, '/tmp/x.jsonl', { mtime: new Date('2026-01-01T00:00:00.000Z') });
    expect(result.trace.outcome).toBe('gave_up');
  });
});
