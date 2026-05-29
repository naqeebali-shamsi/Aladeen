import { describe, expect, it } from 'vitest';
import { ClaudeCodeIngester } from './claude-code.js';
import { Scrubber } from '../scrubber.js';

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('ClaudeCodeIngester.ingestText', () => {
  it('maps user/assistant/tool_use/tool_result to normalized events', () => {
    const text = jsonl([
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-19T10:00:00.000Z', content: 'fix the bug' },
      { type: 'user', timestamp: '2026-05-19T10:00:01.000Z', message: { role: 'user', content: 'fix the bug' } },
      { type: 'assistant', timestamp: '2026-05-19T10:00:02.000Z', message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [
            { type: 'text', text: 'I will read src/foo.ts.' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/home/test/src/foo.ts' } },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
      }},
      { type: 'user', timestamp: '2026-05-19T10:00:03.000Z', message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'export const foo = 1;' },
          ],
      }},
      { type: 'assistant', timestamp: '2026-05-19T10:00:04.000Z', message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: '/home/test/src/foo.ts', old_string: 'foo = 1', new_string: 'foo = 2' } },
          ],
      }},
      { type: 'user', timestamp: '2026-05-19T10:00:05.000Z', message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-2', content: 'file edited' },
          ],
      }},
    ]);

    const ingester = new ClaudeCodeIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-1',
      filePath: '/tmp/projects/-home-test-projects/sess-1.jsonl',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });

    const kinds = result.trace.events.map((e) => e.kind);
    expect(kinds).toEqual([
      'session_start',
      'user_message',
      'agent_message',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'file_change',
      'session_end',
    ]);

    // Path is scrubbed.
    const fileChange = result.trace.events.find((e) => e.kind === 'file_change');
    expect(fileChange).toBeDefined();
    if (fileChange?.kind === 'file_change') {
      expect(fileChange.path).toBe('~/src/foo.ts');
      expect(fileChange.action).toBe('edit');
      expect(fileChange.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    }

    // Cost aggregated from assistant.usage.
    expect(result.trace.cost?.inputTokens).toBe(100);
    expect(result.trace.cost?.outputTokens).toBe(20);

    // queue-operation tracked, not emitted as event.
    expect(result.skippedTypes['queue-operation']).toBe(1);

    // Old file (mtime > 5 min ago) and no errors → completed.
    expect(result.trace.outcome).toBe('completed');
  });

  it('marks tool_result as not ok and classifies the error', () => {
    const text = jsonl([
      { type: 'assistant', timestamp: '2026-05-19T10:00:02.000Z', message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'badcmd' } },
          ],
      }},
      { type: 'user', timestamp: '2026-05-19T10:00:03.000Z', message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'bash: badcmd: command not found', is_error: true },
          ],
      }},
    ]);

    const ingester = new ClaudeCodeIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-2',
      filePath: '/tmp/projects/-home-test/sess-2.jsonl',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });

    const toolResult = result.trace.events.find((e) => e.kind === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.kind === 'tool_result') {
      expect(toolResult.ok).toBe(false);
      expect(toolResult.errorClass).toBe('binary_not_found');
    }
  });

  it('detects user-initiated interrupts from queue-operation content', () => {
    const text = jsonl([
      { type: 'user', timestamp: '2026-05-19T10:00:00.000Z', message: { role: 'user', content: 'go' } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-05-19T10:00:05.000Z', content: '/interrupt' },
    ]);

    const ingester = new ClaudeCodeIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-3',
      filePath: '/tmp/x/sess-3.jsonl',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });

    expect(result.trace.events.some((e) => e.kind === 'interrupt')).toBe(true);
    expect(result.trace.outcome).toBe('interrupted');
  });

  it('tolerates corrupt JSONL lines without aborting the whole ingest', () => {
    const text = '{not json\n' + JSON.stringify({
      type: 'user',
      timestamp: '2026-05-19T10:00:00.000Z',
      message: { role: 'user', content: 'ok' },
    }) + '\n';

    const ingester = new ClaudeCodeIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-4',
      filePath: '/tmp/x/sess-4.jsonl',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });

    expect(result.trace.events.some((e) => e.kind === 'user_message')).toBe(true);
  });

  it('classifies a fatal API-error turn as errored and emits a fatal error event', () => {
    const text = jsonl([
      { type: 'user', timestamp: '2026-05-19T10:00:00.000Z', message: { role: 'user', content: 'do it' } },
      { type: 'assistant', timestamp: '2026-05-19T10:00:01.000Z', isApiErrorMessage: true, message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'API Error: 429 Too Many Requests' }],
      }},
    ]);

    const ingester = new ClaudeCodeIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-5',
      filePath: '/tmp/x/sess-5.jsonl',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });

    // Rule 3: an explicit fatal-error turn classifies as errored (not 'completed').
    expect(result.trace.outcome).toBe('errored');
    const err = result.trace.events.find((e) => e.kind === 'error');
    expect(err).toBeDefined();
    if (err?.kind === 'error') {
      expect(err.fatal).toBe(true);
      expect(err.errorClass).toBe('rate_limit');
      expect(err.message).toContain('429');
    }
    // The API-error turn is consumed as an error event, not re-surfaced as an agent_message.
    expect(result.trace.events.some((e) => e.kind === 'agent_message')).toBe(false);
  });

  it('classifies a fatal system-level error (level:error) as errored', () => {
    const text = jsonl([
      { type: 'user', timestamp: '2026-05-19T10:00:00.000Z', message: { role: 'user', content: 'go' } },
      { type: 'system', level: 'error', timestamp: '2026-05-19T10:00:02.000Z', content: 'ENOSPC: no space left on device' },
    ]);

    const ingester = new ClaudeCodeIngester(new Scrubber({ homeDir: '/home/test' }));
    const result = ingester.ingestText(text, {
      sessionId: 'sess-6',
      filePath: '/tmp/x/sess-6.jsonl',
    }, { mtime: new Date('2026-01-01T00:00:00.000Z') });

    expect(result.trace.outcome).toBe('errored');
    expect(result.trace.events.some((e) => e.kind === 'error' && e.fatal)).toBe(true);
  });
});
