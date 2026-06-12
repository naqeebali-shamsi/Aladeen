import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildServer } from './server.js';
import { IngestStorage } from '../observability/storage.js';
import { LessonStore } from '../learning/store.js';
import { consolidate } from '../learning/consolidate.js';
import type { LessonCandidate } from '../learning/detectors.js';
import type { RunDigest, SessionTrace } from '../observability/session-trace.js';

function digest(over: Partial<RunDigest> = {}): RunDigest {
  return {
    sessionId: 'sess-x',
    agentCliName: 'claude-code',
    outcome: 'errored',
    durationMs: 60_000,
    activeDurationMs: 45_000,
    toolUsage: { Edit: 3, Bash: 1 },
    errorCounts: {
      rate_limit: 0, context_overflow: 0, tool_error: 2, parse_error: 0,
      network: 0, auth: 0, binary_not_found: 0, worktree_collision: 0,
      lint_loop: 0, permission_denied: 0, timeout: 0, model_refusal: 0, unknown: 0,
    },
    filesChanged: ['src/foo.ts'],
    toolFailureCount: 2,
    editLoops: [],
    patternFingerprint: 'abcdef0123456789',
    ...over,
  };
}

function trace(sessionId: string): SessionTrace {
  return {
    schemaVersion: '1',
    sessionId,
    agentCli: { name: 'claude-code' },
    workspace: { cwdScrubbed: '~/x' },
    outcome: 'errored',
    events: [
      { kind: 'user_message', seq: 0, source: { kind: 'claude-code-jsonl', file: 'x' }, text: 'fix it' },
    ],
    scrubbing: { passes: [] },
  };
}

// The MCP SDK exposes private request-handler internals we'd otherwise
// need to drive through the transport. Easier: type the server as unknown
// and call the registered tool/resource handlers via the documented
// `.server.request()` route is heavy. For unit coverage we exercise
// the tool/resource callbacks directly by capturing the registrations.
//
// We do this by monkey-patching the registerTool / registerResource
// methods to intercept the (name, config, handler) tuples, then invoke
// the handlers ourselves with a fake "extra" arg. This isolates the
// behavior we wrote in src/mcp/server.ts from the transport machinery
// which has its own tests upstream in the SDK.

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};
type ResourceResult = { contents: Array<{ text: string }> };
type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;
type ResourceHandler = (uri: URL, params: Record<string, unknown>) => Promise<ResourceResult>;

interface Captured {
  tools: Map<string, { config: unknown; handler: ToolHandler }>;
  resources: Map<string, { handler: ResourceHandler }>;
}

async function captureRegistrations(storage: IngestStorage, lessonStore?: LessonStore): Promise<Captured> {
  const captured: Captured = { tools: new Map(), resources: new Map() };

  // Build a server normally, then intercept by patching prototype before construction.
  // Simpler: build it, then walk the private registry. The McpServer keeps
  // registered tools at `server._registeredTools` / `_registeredResources`,
  // but those are unstable internals. Instead use a different approach:
  // intercept via Proxy when constructing.
  //
  // Because the SDK changes shape across versions, the most version-stable
  // hook is to wrap McpServer.prototype.registerTool / registerResource at
  // import time. We can't do that here cleanly, so instead the test calls
  // buildServer twice — once with a real instance to verify it doesn't
  // throw, and once with a Proxy-based interceptor for the callbacks.
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const origRegisterTool = McpServer.prototype.registerTool;
  const origRegisterResource = McpServer.prototype.registerResource;
  McpServer.prototype.registerTool = function (name: string, config: unknown, handler: unknown) {
    captured.tools.set(name, { config, handler: handler as ToolHandler });
    return (origRegisterTool as unknown as (...a: unknown[]) => unknown).call(this, name, config, handler);
  } as typeof McpServer.prototype.registerTool;
  McpServer.prototype.registerResource = function (...args: unknown[]) {
    const [name, , , handler] = args;
    captured.resources.set(name as string, { handler: handler as ResourceHandler });
    return (origRegisterResource as unknown as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof McpServer.prototype.registerResource;
  try {
    buildServer({ storage, lessonStore });
  } finally {
    McpServer.prototype.registerTool = origRegisterTool;
    McpServer.prototype.registerResource = origRegisterResource;
  }
  return captured;
}

// Build a real lesson on disk via the consolidation path so the fixture is
// schema-valid by construction (not a hand-rolled literal that can drift).
function lessonCandidate(sessionId: string): LessonCandidate {
  return {
    detectorId: 'repeated-tool-failure',
    detectorVersion: '1',
    sessionId,
    candidateKey: 'repeated-tool-failure|Bash|timeout',
    dims: { toolName: 'Bash', errorClass: 'timeout' },
    statement: 'Bash calls fail repeatedly with timeout.',
    category: 'model-mistake',
    agentCli: 'claude-code',
    evidence: [{ sessionId, seq: 1 }],
    observedAt: '2026-05-01T00:00:00.000Z',
    patternFingerprint: 'fp-1',
  };
}

async function seedLessons(repoRoot: string): Promise<LessonStore> {
  const store = new LessonStore(repoRoot);
  const { lessons } = consolidate(
    [],
    [lessonCandidate('s1'), lessonCandidate('s2')],
    { now: new Date('2026-06-12T12:00:00.000Z') },
  );
  await store.writeAll(lessons);
  return store;
}

describe('MCP server', () => {
  it('query_failure_patterns returns formatted report text + structured count', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      await storage.writeDigest(digest({ sessionId: 'a' }));
      await storage.writeDigest(digest({ sessionId: 'b' }));

      const captured = await captureRegistrations(storage);
      const tool = captured.tools.get('query_failure_patterns');
      expect(tool).toBeDefined();

      const result = await tool!.handler({});
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Ingested sessions:');
      expect(result.structuredContent).toEqual({
        sessionCount: 2,
        fingerprintCount: 1,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('replay_fingerprint flags an empty bucket as an error and includes the no-match markdown', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      const captured = await captureRegistrations(storage);
      const tool = captured.tools.get('replay_fingerprint');
      expect(tool).toBeDefined();

      const result = await tool!.handler({ fingerprint: 'nope' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No sessions matched');
      expect(result.structuredContent.matchCount).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('replay_fingerprint returns the drill-down markdown for a matching bucket', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      await storage.writeDigest(digest({ sessionId: 's1' }));
      await storage.writeDigest(digest({ sessionId: 's2' }));
      await storage.writeTrace(trace('s1'));
      await storage.writeTrace(trace('s2'));

      const captured = await captureRegistrations(storage);
      const result = await captured.tools.get('replay_fingerprint')!.handler({
        fingerprint: 'abcdef0123456789',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/Matching sessions:\*?\*?\s+2/);
      expect(result.structuredContent.matchCount).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('aladeen://digests resource serializes every stored digest', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      await storage.writeDigest(digest({ sessionId: 'd1' }));

      const captured = await captureRegistrations(storage);
      const resource = captured.resources.get('digests');
      expect(resource).toBeDefined();

      const result = await resource!.handler(new URL('aladeen://digests'), {});
      const parsed = JSON.parse(result.contents[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].sessionId).toBe('d1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('aladeen://sessions/{id} resource returns the trace or a friendly error', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      await storage.writeTrace(trace('present'));

      const captured = await captureRegistrations(storage);
      const handler = captured.resources.get('session')!.handler;

      const ok = await handler(new URL('aladeen://sessions/present'), { sessionId: 'present' });
      expect(JSON.parse(ok.contents[0].text).sessionId).toBe('present');

      const missing = await handler(new URL('aladeen://sessions/missing'), { sessionId: 'missing' });
      expect(missing.isError).toBe(true);
      expect(JSON.parse(missing.contents[0].text).error).toContain('No trace found');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('suggest_remedy returns a known-fix tier for a worktree_collision failure', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      await storage.writeDigest(digest({
        sessionId: 'wc', agentCliName: 'aladeen', outcome: 'gave_up', toolFailureCount: 2267,
        patternFingerprint: 'wc00000000000000',
        errorCounts: { worktree_collision: 2267 } as RunDigest['errorCounts'],
      }));
      const captured = await captureRegistrations(storage);
      const tool = captured.tools.get('suggest_remedy');
      expect(tool).toBeDefined();
      const r = await tool!.handler({ fingerprint: 'wc00000000000000' });
      expect(r.isError).toBe(false);
      expect(r.structuredContent.tier).toBe('known-fix');
      expect(r.structuredContent.ruleCount).toBeGreaterThanOrEqual(1);
      expect(r.content[0].text).toContain('install dependencies inside the git worktree');
      // Machine-actionable structured form (agent can act without scraping markdown).
      expect(r.structuredContent.rules[0].id).toBe('worktree_collision');
      expect(r.structuredContent.rules[0].citations[0].file).toContain('implement-feature.ts');
      expect(typeof r.structuredContent.guardrail).toBe('string');
      expect(r.structuredContent.nFailed).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('suggest_remedy returns tier none for an empty-subSignature failing bucket', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      await storage.writeDigest(digest({
        sessionId: 'es', outcome: 'gave_up', toolFailureCount: 0,
        patternFingerprint: 'es00000000000000',
        errorCounts: {} as RunDigest['errorCounts'],
      }));
      const captured = await captureRegistrations(storage);
      const r = await captured.tools.get('suggest_remedy')!.handler({ fingerprint: 'es00000000000000' });
      expect(r.isError).toBe(false);
      expect(r.structuredContent.tier).toBe('none');
      expect(r.structuredContent.resolvedSampleCount).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('suggest_remedy flags an unknown fingerprint as an error', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      const captured = await captureRegistrations(storage);
      const r = await captured.tools.get('suggest_remedy')!.handler({ fingerprint: 'nope' });
      expect(r.isError).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('suggest_remedy is described as suggesting, never executing', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      const captured = await captureRegistrations(storage);
      const cfg = captured.tools.get('suggest_remedy')!.config as { description: string };
      expect(cfg.description.toLowerCase()).toContain('suggests');
      expect(cfg.description.toLowerCase()).toContain('never executes');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('query_lessons returns ranked lessons with markdown + structured content', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      const lessonStore = await seedLessons(tmp);
      const captured = await captureRegistrations(storage, lessonStore);
      const tool = captured.tools.get('query_lessons');
      expect(tool).toBeDefined();

      const r = await tool!.handler({});
      expect(r.content[0].text).toContain('Bash calls fail repeatedly with timeout');
      expect(r.structuredContent.totalLessons).toBe(1);
      expect(r.structuredContent.returned).toBe(1);
      const lessons = r.structuredContent.lessons as Array<Record<string, unknown>>;
      expect(lessons[0].id).toBeTruthy();
      expect(lessons[0].status).toBe('corroborated'); // 2 distinct sessions
      expect(lessons[0].statement).toContain('Bash');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('query_lessons returns an empty-but-valid result when nothing has been learned', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      const captured = await captureRegistrations(storage, new LessonStore(tmp));
      const r = await captured.tools.get('query_lessons')!.handler({});
      expect(r.content[0].text).toContain('No lessons yet');
      expect(r.structuredContent.totalLessons).toBe(0);
      expect(r.structuredContent.returned).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('query_lessons honors the limit', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'aladeen-mcp-'));
    try {
      const storage = new IngestStorage(tmp);
      const lessonStore = await seedLessons(tmp);
      const captured = await captureRegistrations(storage, lessonStore);
      const r = await captured.tools.get('query_lessons')!.handler({ limit: 1 });
      expect((r.structuredContent.lessons as unknown[]).length).toBeLessThanOrEqual(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
