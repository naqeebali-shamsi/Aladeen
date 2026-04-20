import { describe, it, expect } from 'vitest';
import { CLAUDE_CONFIG, CODEX_CONFIG, GEMINI_CONFIG, HEADLESS_CONFIGS } from './completion.js';

// These tests cover the pure parts of the headless config (buildArgs, parseOutput,
// parseStreamEvent). Spawn integration is intentionally NOT tested here — that
// path is exercised end-to-end by smoke-agentic.json runs.

describe('CLAUDE_CONFIG', () => {
  describe('buildArgs', () => {
    it('uses -p, defaults to JSON output', () => {
      const args = CLAUDE_CONFIG.buildArgs('do thing', { cwd: '.' });
      expect(args).toEqual(['-p', 'do thing', '--output-format', 'json']);
    });

    it('respects allowedTools, systemPrompt, resumeSessionId', () => {
      const args = CLAUDE_CONFIG.buildArgs('do thing', {
        cwd: '.',
        allowedTools: ['Read', 'Edit'],
        systemPrompt: 'be terse',
        resumeSessionId: 'abc',
        outputFormat: 'stream-json',
      });
      expect(args).toEqual([
        '-p', 'do thing',
        '--output-format', 'stream-json',
        '--allowedTools', 'Read,Edit',
        '--append-system-prompt', 'be terse',
        '--resume', 'abc',
      ]);
    });
  });

  describe('parseOutput', () => {
    it('parses success JSON shape from a real run (mirrors c607e199)', () => {
      const stdout = JSON.stringify({
        result: 'Created src/utils/format-duration.ts.',
        session_id: 'sess-123',
        usage: { input_tokens: 8, output_tokens: 560 },
      });
      const r = CLAUDE_CONFIG.parseOutput(stdout, 0);
      expect(r.success).toBe(true);
      expect(r.response).toBe('Created src/utils/format-duration.ts.');
      expect(r.sessionId).toBe('sess-123');
      expect(r.usage).toEqual({ inputTokens: 8, outputTokens: 560 });
    });

    it('falls back to plain text when stdout is not JSON', () => {
      const r = CLAUDE_CONFIG.parseOutput('hello world\n', 0);
      expect(r.success).toBe(true);
      expect(r.response).toBe('hello world');
    });

    it('returns failure with truncated stdout in error on non-zero exit', () => {
      const r = CLAUDE_CONFIG.parseOutput('a'.repeat(2000), 2);
      expect(r.success).toBe(false);
      expect(r.exitCode).toBe(2);
      expect(r.error).toMatch(/exited with code 2/);
      expect(r.error?.length).toBeLessThan(700);
    });
  });

  describe('parseStreamEvent', () => {
    it('returns text_delta for stream_event with text delta', () => {
      const ev = CLAUDE_CONFIG.parseStreamEvent!(
        JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hi' } } })
      );
      expect(ev?.type).toBe('text_delta');
      expect(ev?.data).toBe('hi');
    });

    it('returns turn_complete for result events', () => {
      const ev = CLAUDE_CONFIG.parseStreamEvent!(JSON.stringify({ type: 'result', result: 'done' }));
      expect(ev?.type).toBe('turn_complete');
    });

    it('returns null on unparseable lines', () => {
      expect(CLAUDE_CONFIG.parseStreamEvent!('not json')).toBeNull();
    });
  });
});

describe('CODEX_CONFIG', () => {
  it('builds args with exec + --json + --full-auto + prompt last', () => {
    const args = CODEX_CONFIG.buildArgs('write code', {
      cwd: '.',
      outputFormat: 'json',
      allowedTools: ['Edit'],
    });
    expect(args).toEqual(['exec', '--json', '--full-auto', 'write code']);
  });

  it('parses JSONL stream — picks up item.completed text and turn.completed usage', () => {
    const lines = [
      JSON.stringify({ type: 'item.completed', item: { text: 'first chunk' } }),
      JSON.stringify({ type: 'item.completed', item: { text: 'final answer' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 200 } }),
    ];
    const r = CODEX_CONFIG.parseOutput(lines.join('\n'), 0);
    expect(r.success).toBe(true);
    expect(r.response).toBe('final answer');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
  });

  it('skips non-JSON noise lines without crashing', () => {
    const lines = [
      'progress: working...',
      JSON.stringify({ type: 'item.completed', item: { text: 'ok' } }),
      'more noise',
    ];
    const r = CODEX_CONFIG.parseOutput(lines.join('\n'), 0);
    expect(r.success).toBe(true);
    expect(r.response).toBe('ok');
  });

  it('falls back to raw stdout when no parseable items found', () => {
    const r = CODEX_CONFIG.parseOutput('just text\n', 0);
    expect(r.response).toBe('just text');
  });
});

describe('GEMINI_CONFIG', () => {
  it('uses --yolo when allowedTools provided, --output-format json by default', () => {
    const args = GEMINI_CONFIG.buildArgs('do', { cwd: '.', allowedTools: ['Edit'] });
    expect(args).toEqual(['--output-format', 'json', '--yolo', 'do']);
  });

  it('maps gemini exit codes to readable error labels', () => {
    expect(GEMINI_CONFIG.parseOutput('', 42).error).toMatch(/input error/);
    expect(GEMINI_CONFIG.parseOutput('', 53).error).toMatch(/turn limit/);
    expect(GEMINI_CONFIG.parseOutput('', 1).error).toMatch(/general error/);
  });

  it('parses success JSON with stats', () => {
    const stdout = JSON.stringify({
      response: 'hello from gemini',
      stats: { input_tokens: 10, output_tokens: 20 },
    });
    const r = GEMINI_CONFIG.parseOutput(stdout, 0);
    expect(r.success).toBe(true);
    expect(r.response).toBe('hello from gemini');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});

describe('HEADLESS_CONFIGS registry', () => {
  it('exposes claude, codex, gemini, local-ollama, local-llama-cpp', () => {
    expect(Object.keys(HEADLESS_CONFIGS).sort()).toEqual(
      ['claude', 'codex', 'gemini', 'local-llama-cpp', 'local-ollama'].sort()
    );
  });
});
