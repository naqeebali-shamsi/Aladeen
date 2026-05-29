import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runIngestPipeline } from './ingest-runner.js';
import { IngestStorage } from './storage.js';
import type { SessionTrace } from './session-trace.js';

function trace(sessionId: string, over: Partial<SessionTrace> = {}): SessionTrace {
  return {
    schemaVersion: '1',
    sessionId,
    agentCli: { name: 'test' },
    workspace: { cwdScrubbed: '~/x' },
    outcome: 'completed',
    events: [
      { kind: 'user_message', seq: 0, source: { kind: 'claude-code-jsonl', file: 'x' }, text: 'hi' },
    ],
    scrubbing: { passes: [] },
    ...over,
  };
}

interface FakeTarget { id: string; willFail?: boolean; warnings?: string[]; }

describe('runIngestPipeline', () => {
  it('writes a trace + digest per target and counts successes', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-pipeline-'));
    try {
      const storage = new IngestStorage(tmp);
      const logs: string[] = [];
      const errs: string[] = [];

      const summary = await runIngestPipeline<FakeTarget>({
        sourceLabel: 'test',
        sourcePath: '/fake',
        targets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        ingestOne: async (t) => ({ trace: trace(t.id), warnings: t.warnings ?? [] }),
        displayId: (t) => t.id,
        storage,
        log: (m) => logs.push(m),
        error: (m) => errs.push(m),
      });

      expect(summary).toMatchObject({ total: 3, ok: 3, warn: 0, errors: [] });
      // Three success log lines + header + summary + report-hint
      expect(logs.filter((m) => m.includes('ok  '))).toHaveLength(3);
      expect(logs.find((m) => m.includes('Ingested 3/3 session(s)'))).toBeDefined();
      expect(errs).toEqual([]);

      // Confirm storage actually wrote both trace + digest for each.
      const digests = await storage.listDigests();
      expect(digests.map((d) => d.sessionId).sort()).toEqual(['a', 'b', 'c']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('isolates per-target errors without aborting the batch', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-pipeline-'));
    try {
      const storage = new IngestStorage(tmp);
      const errs: string[] = [];

      const summary = await runIngestPipeline<FakeTarget>({
        sourceLabel: 'test',
        sourcePath: '/fake',
        targets: [{ id: 'good' }, { id: 'broken', willFail: true }, { id: 'good2' }],
        ingestOne: async (t) => {
          if (t.willFail) throw new Error('boom');
          return { trace: trace(t.id), warnings: [] };
        },
        displayId: (t) => t.id,
        storage,
        log: () => {},
        error: (m) => errs.push(m),
        quiet: true,
      });

      expect(summary.total).toBe(3);
      expect(summary.ok).toBe(2);
      expect(summary.errors).toEqual([{ id: 'broken', error: 'boom' }]);
      expect(errs.some((m) => m.includes('err broken: boom'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('aggregates warning counts and conditionally prints them', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-pipeline-'));
    try {
      const storage = new IngestStorage(tmp);
      const warns: string[] = [];

      const summary = await runIngestPipeline<FakeTarget>({
        sourceLabel: 'test',
        sourcePath: '/fake',
        itemLabel: 'run',
        targets: [{ id: 'a', warnings: ['schema drift'] }, { id: 'b' }],
        ingestOne: async (t) => ({ trace: trace(t.id), warnings: t.warnings ?? [] }),
        displayId: (t) => t.id,
        storage,
        printWarnings: true,
        log: () => {},
        warn: (m) => warns.push(m),
      });

      expect(summary.warn).toBe(1);
      expect(warns.some((m) => m.includes('warn a: schema drift'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('uses itemLabel in the summary line so callers can say "run" vs "session"', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-pipeline-'));
    try {
      const storage = new IngestStorage(tmp);
      const logs: string[] = [];

      await runIngestPipeline<FakeTarget>({
        sourceLabel: 'aladeen-runs',
        sourcePath: '/fake',
        itemLabel: 'run',
        targets: [{ id: 'a' }],
        ingestOne: async (t) => ({ trace: trace(t.id), warnings: [] }),
        displayId: (t) => t.id,
        storage,
        log: (m) => logs.push(m),
      });

      expect(logs.find((m) => m.includes('Ingested 1/1 run(s)'))).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
