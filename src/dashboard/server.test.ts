import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IngestStorage } from '../observability/storage.js';
import { startDashboardServer, type DashboardServerHandle } from './server.js';
import type { RunDigest, SessionTrace } from '../observability/session-trace.js';

const digest: RunDigest = {
  sessionId: 'sess-1',
  agentCliName: 'codex',
  outcome: 'gave_up',
  toolUsage: { Bash: 3 },
  errorCounts: { worktree_collision: 2267 } as RunDigest['errorCounts'],
  filesChanged: ['N:\\repo\\a.ts'],
  toolFailureCount: 4,
  editLoops: [],
  patternFingerprint: 'deadbeefdeadbeef',
};

const trace: SessionTrace = {
  schemaVersion: '1',
  sessionId: 'sess-1',
  agentCli: { name: 'codex' },
  workspace: { cwdScrubbed: '~/repo' },
  outcome: 'gave_up',
  events: [
    { seq: 0, kind: 'user_message', text: 'do the thing', source: { kind: 'codex-transcript', file: 'x' } },
    { seq: 1, kind: 'tool_result', callId: 'c1', ok: false, errorClass: 'worktree_collision', source: { kind: 'codex-transcript', file: 'x' } },
  ],
  scrubbing: { passes: [{ reason: 'path-home', version: '1' }] },
};

const handles: DashboardServerHandle[] = [];
const tmpdirs: string[] = [];

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  await Promise.all(tmpdirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function bootServer() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aladeen-dash-'));
  tmpdirs.push(dir);
  const storage = new IngestStorage(dir);
  await storage.writeDigest(digest);
  await storage.writeTrace(trace);
  const handle = await startDashboardServer({ storage, host: '127.0.0.1', port: 0, repoRoot: dir });
  handles.push(handle);
  return handle;
}

describe('dashboard server', () => {
  it('refuses to bind a non-loopback host', async () => {
    const storage = new IngestStorage('.');
    await expect(startDashboardServer({ storage, host: '0.0.0.0' })).rejects.toThrow(/loopback/i);
  });

  it('serves the derived overview from /api/digests.json', async () => {
    const { url } = await bootServer();
    const res = await fetch(`${url}api/digests.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.sessionCount).toBe(1);
    expect(body.verdict.level).toBe('ANOMALY');
    expect(body.verdict.anomalies[0].count).toBe(2267);
  });

  it('serves a single trace and 404s for unknown ids', async () => {
    const { url } = await bootServer();
    const ok = await fetch(`${url}api/trace/sess-1`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).sessionId).toBe('sess-1');

    const missing = await fetch(`${url}api/trace/nope`);
    expect(missing.status).toBe(404);
  });

  it('returns replay markdown for a matching fingerprint', async () => {
    const { url } = await bootServer();
    const res = await fetch(`${url}api/replay/deadbeefdeadbeef`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matchCount).toBe(1);
    expect(body.markdown).toContain('Replay');
  });

  it('blocks path traversal', async () => {
    const { url } = await bootServer();
    // encoded traversal should not escape the static root
    const res = await fetch(`${url}..%2f..%2f..%2fpackage.json`);
    expect([403, 404]).toContain(res.status);
  });

  it('404s unknown api routes', async () => {
    const { url } = await bootServer();
    const res = await fetch(`${url}api/nope`);
    expect(res.status).toBe(404);
  });

  it('GET /api/loops returns a read-only loop-candidate report', async () => {
    const { url } = await bootServer();
    const res = await fetch(`${url}api/loops`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.candidates)).toBe(true);
    for (const k of ['sessionsScanned', 'humanAsksFound', 'guardrail', 'coverageNote', 'markdown']) {
      expect(body).toHaveProperty(k);
    }
    expect(body.guardrail.toLowerCase()).toContain('never creates or runs them');
  });

  it('GET /api/remedy returns a known-fix remedy for the worktree_collision bucket', async () => {
    const { url } = await bootServer();
    const res = await fetch(`${url}api/remedy/deadbeefdeadbeef`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier).toBe('known-fix');
    expect(body.ruleMatches.length).toBeGreaterThanOrEqual(1);
    for (const k of ['subSignature', 'guardrail', 'coverageNote', 'markdown', 'nFailed', 'nResolved']) {
      expect(body).toHaveProperty(k);
    }
  });

  it('GET /api/remedy returns tier none for an empty-subSignature failing bucket', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aladeen-dash-'));
    tmpdirs.push(dir);
    const storage = new IngestStorage(dir);
    await storage.writeDigest({
      ...digest, sessionId: 'empty', patternFingerprint: 'empty00000000000',
      outcome: 'gave_up', toolFailureCount: 0,
      errorCounts: {} as RunDigest['errorCounts'],
    });
    const handle = await startDashboardServer({ storage, host: '127.0.0.1', port: 0, repoRoot: dir });
    handles.push(handle);
    const res = await fetch(`${handle.url}api/remedy/empty00000000000`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier).toBe('none');
    expect(body.nResolved).toBe(0);
    expect(body.guardrail).toContain('No comparable resolved session in your history yet');
  });

  it('GET /api/remedy 404s an unknown fingerprint; POST is 405', async () => {
    const { url } = await bootServer();
    expect((await fetch(`${url}api/remedy/no-such-fp`)).status).toBe(404);
    expect((await fetch(`${url}api/remedy/deadbeefdeadbeef`, { method: 'POST' })).status).toBe(405);
  });

  it('REGRESSION: /api/replay/:fp shape is unchanged', async () => {
    const { url } = await bootServer();
    const res = await fetch(`${url}api/replay/deadbeefdeadbeef`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['fingerprint', 'markdown', 'matchCount']);
    expect(body.matchCount).toBe(1);
  });
});
