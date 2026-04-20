import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeterministicExecutor } from './deterministic-executor.js';
import type { BlueprintContext, DeterministicNode } from './types.js';

const ctx = (cwd: string): BlueprintContext => ({
  cwd,
  env: {},
  ruleFiles: [],
  allowedTools: [],
  store: {},
});

const shellNode = (
  command: string,
  args: string[],
  extras: Partial<DeterministicNode> = {}
): DeterministicNode => ({
  id: 'n',
  label: 'test',
  kind: 'deterministic',
  op: { type: 'shell', command, args },
  ...extras,
} as DeterministicNode);

describe('DeterministicExecutor — shell', () => {
  it('succeeds with stdout when command exits 0', async () => {
    const exec = new DeterministicExecutor();
    const node = shellNode('node', ['-e', 'process.stdout.write("hello")']);
    const r = await exec.execute(node, ctx(process.cwd()));
    expect(r.outcome).toBe('success');
    expect((r.output as { stdout: string }).stdout).toBe('hello');
    expect((r.output as { exitCode: number }).exitCode).toBe(0);
  });

  it('returns failure with stderr captured when command exits non-zero', async () => {
    const exec = new DeterministicExecutor();
    const node = shellNode('node', ['-e', 'process.exit(2)']);
    const r = await exec.execute(node, ctx(process.cwd()));
    expect(r.outcome).toBe('failure');
    expect(r.error).toBeDefined();
  });

  it('respects exitCodeMap to remap exit codes (1 → retry)', async () => {
    const exec = new DeterministicExecutor();
    const node = shellNode('node', ['-e', 'process.exit(1)'], {
      exitCodeMap: { 1: 'retry' },
    } as Partial<DeterministicNode>);
    const r = await exec.execute(node, ctx(process.cwd()));
    expect(r.outcome).toBe('retry');
  });
});

describe('DeterministicExecutor — file ops', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'aladeen-detexec-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('writes a file and resolves the path relative to cwd', async () => {
    const exec = new DeterministicExecutor();
    const node: DeterministicNode = {
      id: 'w',
      label: 'write',
      kind: 'deterministic',
      op: { type: 'file', action: 'write', path: 'sub/hello.txt', content: 'hi' },
    };
    const r = await exec.execute(node, ctx(tmp));
    expect(r.outcome).toBe('success');
    const written = await readFile(path.join(tmp, 'sub', 'hello.txt'), 'utf-8');
    expect(written).toBe('hi');
  });

  it('reads a file written previously', async () => {
    const exec = new DeterministicExecutor();
    await exec.execute(
      {
        id: 'w',
        label: 'write',
        kind: 'deterministic',
        op: { type: 'file', action: 'write', path: 'a.txt', content: 'payload' },
      },
      ctx(tmp)
    );
    const r = await exec.execute(
      {
        id: 'r',
        label: 'read',
        kind: 'deterministic',
        op: { type: 'file', action: 'read', path: 'a.txt' },
      },
      ctx(tmp)
    );
    expect(r.outcome).toBe('success');
    expect((r.output as { content: string }).content).toBe('payload');
  });
});

describe('DeterministicExecutor — guard', () => {
  it('throws when given an agentic node', async () => {
    const exec = new DeterministicExecutor();
    await expect(
      exec.execute(
        {
          id: 'a',
          label: 'agentic',
          kind: 'agentic',
          adapterId: 'claude',
          prompt: 'x',
          maxRetries: 0,
        },
        ctx(process.cwd())
      )
    ).rejects.toThrow(/cannot execute node kind: agentic/);
  });
});
