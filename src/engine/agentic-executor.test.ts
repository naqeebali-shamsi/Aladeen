import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AgenticExecutor,
  resolveTemplate,
  injectContext,
} from './agentic-executor.js';
import { CompletionDetector, type HeadlessResult } from './completion.js';
import type { AgenticNode, BlueprintContext } from './types.js';

const ctx: BlueprintContext = {
  cwd: '.',
  env: {},
  ruleFiles: [],
  allowedTools: [],
  store: {},
};

function node(overrides: Partial<AgenticNode> = {}): AgenticNode {
  return {
    id: 'agent',
    label: 'Agent',
    kind: 'agentic',
    adapterId: 'claude',
    prompt: 'do the thing',
    maxRetries: 2,
    ...overrides,
  };
}

describe('resolveTemplate', () => {
  it('replaces {{key}} and {{store.key}} with store values', () => {
    const out = resolveTemplate('a={{one}}, b={{store.two}}', { one: 'X', two: 'Y' });
    expect(out).toBe('a=X, b=Y');
  });

  it('passes through placeholders when the key is missing', () => {
    const out = resolveTemplate('{{missing}} stays put', {});
    expect(out).toBe('{{missing}} stays put');
  });

  it('JSON-stringifies non-string values', () => {
    const out = resolveTemplate('payload={{obj}}', { obj: { k: 1 } });
    expect(out).toBe('payload={"k":1}');
  });
});

describe('injectContext', () => {
  it('appends repo digest, graph, memory, and model route in order', () => {
    const out = injectContext(
      'PROMPT',
      { repoDigest: 'R', graphContext: 'G', memoryContext: 'M' },
      'qwen2.5-coder:14b'
    );
    expect(out).toContain('PROMPT');
    expect(out.indexOf('[Repo Digest]')).toBeLessThan(out.indexOf('[Graph Context]'));
    expect(out.indexOf('[Graph Context]')).toBeLessThan(out.indexOf('[Memory Context]'));
    expect(out.indexOf('[Memory Context]')).toBeLessThan(out.indexOf('[Model Route]'));
    expect(out).toContain('qwen2.5-coder:14b');
  });

  it('returns the prompt untouched when no context and no modelId', () => {
    expect(injectContext('PROMPT', {})).toBe('PROMPT');
  });
});

describe('AgenticExecutor.execute → toNodeResult', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps a successful headless run to outcome=success', async () => {
    vi.spyOn(CompletionDetector.prototype, 'execute').mockResolvedValue({
      success: true,
      response: 'done',
      sessionId: 'sess-1',
      usage: { inputTokens: 5, outputTokens: 12 },
      exitCode: 0,
    } satisfies HeadlessResult);

    const result = await new AgenticExecutor().execute(node(), ctx);

    expect(result.outcome).toBe('success');
    expect(result.output).toMatchObject({ response: 'done', sessionId: 'sess-1' });
    expect(result.error).toBeUndefined();
  });

  it('maps a timeout to outcome=failure (not retry — retrying would hit the same wall)', async () => {
    vi.spyOn(CompletionDetector.prototype, 'execute').mockResolvedValue({
      success: false,
      response: '',
      exitCode: -1,
      error: 'Timed out after 60000ms',
    } satisfies HeadlessResult);

    const result = await new AgenticExecutor().execute(node({ timeoutMs: 60_000 }), ctx);

    expect(result.outcome).toBe('failure');
    expect(result.error).toMatch(/Timed out/);
  });

  it('maps a non-timeout non-zero exit to outcome=retry (agent might do better next time)', async () => {
    vi.spyOn(CompletionDetector.prototype, 'execute').mockResolvedValue({
      success: false,
      response: 'partial',
      exitCode: 1,
      error: 'agent returned error',
    } satisfies HeadlessResult);

    const result = await new AgenticExecutor().execute(node(), ctx);

    expect(result.outcome).toBe('retry');
    expect(result.output).toMatchObject({ exitCode: 1 });
  });

  it('rejects unknown adapterId without invoking the detector', async () => {
    const spy = vi
      .spyOn(CompletionDetector.prototype, 'execute')
      .mockResolvedValue({ success: true, response: '', exitCode: 0 });

    const result = await new AgenticExecutor().execute(
      node({ adapterId: 'not-a-real-adapter' }),
      ctx
    );

    expect(result.outcome).toBe('failure');
    expect(result.error).toMatch(/No headless config for adapter/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves {{store.key}} placeholders before dispatching the prompt', async () => {
    const spy = vi
      .spyOn(CompletionDetector.prototype, 'execute')
      .mockResolvedValue({ success: true, response: 'ok', exitCode: 0 });

    await new AgenticExecutor().execute(
      node({ prompt: 'Fix these lints: {{store.lintOutput}}' }),
      { ...ctx, store: { lintOutput: '3 errors in src/a.ts' } }
    );

    expect(spy).toHaveBeenCalledWith(
      'claude',
      expect.stringContaining('3 errors in src/a.ts'),
      expect.objectContaining({ cwd: '.' })
    );
  });
});

describe('AgenticExecutor — requiresFileChanges (Audex dogfood D1 fix)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('downgrades success → retry when no files changed', async () => {
    vi.spyOn(CompletionDetector.prototype, 'execute').mockResolvedValue({
      success: true,
      response: 'Sure, what would you like me to do?',
      exitCode: 0,
    });

    const exec = new AgenticExecutor({
      hasUncommittedChanges: async () => false,
    });

    const result = await exec.execute(node({ requiresFileChanges: true }), ctx);

    expect(result.outcome).toBe('retry');
    expect(result.error).toMatch(/no files changed/);
    expect(result.summary).toMatch(/produced no file changes/);
  });

  it('preserves success when files DID change', async () => {
    vi.spyOn(CompletionDetector.prototype, 'execute').mockResolvedValue({
      success: true,
      response: 'Created src/foo.ts',
      exitCode: 0,
    });

    const exec = new AgenticExecutor({
      hasUncommittedChanges: async () => true,
    });

    const result = await exec.execute(node({ requiresFileChanges: true }), ctx);

    expect(result.outcome).toBe('success');
    expect(result.error).toBeUndefined();
  });

  it('skips the file-change check when requiresFileChanges is undefined/false', async () => {
    vi.spyOn(CompletionDetector.prototype, 'execute').mockResolvedValue({
      success: true,
      response: 'ok',
      exitCode: 0,
    });

    const probe = vi.fn(async () => false);
    const exec = new AgenticExecutor({ hasUncommittedChanges: probe });

    const result = await exec.execute(node({ requiresFileChanges: false }), ctx);

    expect(result.outcome).toBe('success');
    expect(probe).not.toHaveBeenCalled();
  });

  it('does NOT run the file-change check on a failed spawn (no false positives)', async () => {
    vi.spyOn(CompletionDetector.prototype, 'execute').mockResolvedValue({
      success: false,
      response: '',
      exitCode: 1,
      error: 'agent exploded',
    });

    const probe = vi.fn(async () => false);
    const exec = new AgenticExecutor({ hasUncommittedChanges: probe });

    const result = await exec.execute(node({ requiresFileChanges: true }), ctx);

    expect(result.outcome).toBe('retry');
    expect(probe).not.toHaveBeenCalled();
  });
});
