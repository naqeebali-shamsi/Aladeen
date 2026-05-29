import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { replayFingerprint } from './replay.js';
import { IngestStorage } from './storage.js';
import type { RunDigest, SessionTrace } from './session-trace.js';

function digest(over: Partial<RunDigest> = {}): RunDigest {
  return {
    sessionId: 'sess-1',
    agentCliName: 'claude-code',
    outcome: 'completed',
    durationMs: 60_000,
    activeDurationMs: 30_000,
    toolUsage: { Edit: 2 },
    errorCounts: {
      rate_limit: 0, context_overflow: 0, tool_error: 1, parse_error: 0,
      network: 0, auth: 0, binary_not_found: 0, worktree_collision: 0,
      lint_loop: 0, permission_denied: 0, timeout: 0, model_refusal: 0, unknown: 0,
    },
    filesChanged: ['src/foo.ts'],
    toolFailureCount: 1,
    editLoops: [],
    patternFingerprint: 'abc123def456abc1',
    ...over,
  };
}

function trace(sessionId: string, over: Partial<SessionTrace> = {}): SessionTrace {
  return {
    schemaVersion: '1',
    sessionId,
    agentCli: { name: 'claude-code' },
    workspace: { cwdScrubbed: '~/x' },
    outcome: 'completed',
    events: [
      { kind: 'user_message', seq: 0, source: { kind: 'claude-code-jsonl', file: 'x' }, text: 'fix the bug' },
      { kind: 'tool_result', seq: 1, source: { kind: 'claude-code-jsonl', file: 'x' }, callId: 'a', ok: false, output: 'oops', errorClass: 'tool_error' },
    ],
    scrubbing: { passes: [] },
    ...over,
  };
}

describe('replayFingerprint', () => {
  it('returns empty markdown when no matches', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-replay-'));
    try {
      const storage = new IngestStorage(tmp);
      const result = await replayFingerprint('nope', storage);
      expect(result.matchedDigests).toEqual([]);
      expect(result.markdown).toContain('No sessions matched');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('aggregates files and tools across matching digests', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-replay-'));
    try {
      const storage = new IngestStorage(tmp);
      const d1 = digest({ sessionId: 's1', filesChanged: ['src/foo.ts', 'src/bar.ts'], toolUsage: { Edit: 3, Bash: 2 } });
      const d2 = digest({ sessionId: 's2', filesChanged: ['src/foo.ts'], toolUsage: { Edit: 1 } });
      const d3 = digest({ sessionId: 's3', patternFingerprint: 'different00000000' });

      await storage.writeDigest(d1);
      await storage.writeDigest(d2);
      await storage.writeDigest(d3);
      await storage.writeTrace(trace('s1'));
      await storage.writeTrace(trace('s2'));

      const result = await replayFingerprint('abc123def456abc1', storage);
      expect(result.matchedDigests).toHaveLength(2);
      // foo.ts in both sessions → "(2 sessions)" annotation
      expect(result.markdown).toMatch(/`src\/foo\.ts`.*\(2 sessions\)/);
      // bar.ts only in one
      expect(result.markdown).toContain('`src/bar.ts`');
      // Tool totals
      expect(result.markdown).toMatch(/`Edit` × 4/);
      expect(result.markdown).toMatch(/`Bash` × 2/);
      // Per-session ask appears
      expect(result.markdown).toContain('ask: fix the bug');
      expect(result.markdown).toContain("first failure (`tool_error`)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts a prefix match when unambiguous', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-replay-'));
    try {
      const storage = new IngestStorage(tmp);
      await storage.writeDigest(digest({ sessionId: 's1', patternFingerprint: 'abc111111111aaaa' }));
      await storage.writeDigest(digest({ sessionId: 's2', patternFingerprint: 'abc111111111aaaa' }));
      await storage.writeTrace(trace('s1'));
      await storage.writeTrace(trace('s2'));

      const result = await replayFingerprint('abc11', storage);
      expect(result.matchedDigests).toHaveLength(2);
      expect(result.fingerprint).toBe('abc111111111aaaa');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects an ambiguous prefix match', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-replay-'));
    try {
      const storage = new IngestStorage(tmp);
      await storage.writeDigest(digest({ sessionId: 's1', patternFingerprint: 'abc111111111aaaa' }));
      await storage.writeDigest(digest({ sessionId: 's2', patternFingerprint: 'abc222222222bbbb' }));

      const result = await replayFingerprint('abc', storage);
      expect(result.matchedDigests).toHaveLength(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
