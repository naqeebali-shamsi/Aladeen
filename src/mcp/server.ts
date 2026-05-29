import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IngestStorage } from '../observability/storage.js';
import { formatReport } from '../observability/report.js';
import { replayFingerprint } from '../observability/replay.js';
import { suggestRemedy } from '../observability/remedy.js';
import type { RunDigest } from '../observability/session-trace.js';

// Aladeen as an MCP server. Wraps the same observability primitives the
// CLI uses (IngestStorage / formatReport / replayFingerprint) so any
// MCP-aware agent — Claude Code, opencode, Codex, Cursor, etc. — can query
// Aladeen's accumulated knowledge mid-session via a single `.mcp.json` line.
//
// Two tools shipped in this MVP per ROADMAP Channel 2:
//   - query_failure_patterns: returns the report text (bucketed failure
//     fingerprints + edit loops + tool rollup), optionally filtered.
//   - replay_fingerprint: returns the markdown drill-down for a single
//     pattern fingerprint.
//
// Two resources shipped:
//   - aladeen://digests           → JSON array of every RunDigest on disk
//   - aladeen://sessions/{id}     → single SessionTrace JSON (URI template)
//
// All reads are local-only — the server never touches the network and
// never spawns the agent CLIs. The data it serves was produced by prior
// `aladeen ingest <source>` invocations.

export interface BuildServerOptions {
  // Repo root that owns the .aladeen/ingested store. Defaults to process.cwd()
  // when wrapped by the bin entry; tests inject an isolated tmpdir.
  repoRoot?: string;
  // Override the storage; tests prefer this over file-system mocking.
  storage?: IngestStorage;
}

export function buildServer(opts: BuildServerOptions = {}): McpServer {
  const storage = opts.storage ?? new IngestStorage(opts.repoRoot ?? process.cwd());

  const server = new McpServer(
    { name: 'aladeen', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions: [
        'Aladeen is an observability + learning layer over agent CLI session logs.',
        'Use query_failure_patterns to see which failure shapes have recurred in this',
        'repo. Use replay_fingerprint(fp) to drill into a specific bucket and see',
        'concrete file/tool/error aggregates. Use suggest_remedy(fp) for an actionable',
        'read-only remedy; it suggests, never executes. Resources expose the raw digests',
        'and individual session traces.',
      ].join(' '),
    },
  );

  // ── Tool 1: query_failure_patterns ────────────────────────────────────
  server.registerTool(
    'query_failure_patterns',
    {
      title: 'Query failure patterns',
      description:
        'Returns the same failure-pattern report the `aladeen report` CLI produces. ' +
        'Shows outcome distribution, fingerprint buckets, edit-loop hotspots, tool ' +
        'usage rollup, and a per-session table. Use this at the start of a session ' +
        'to learn which failure shapes have recurred in the user\'s history.',
      inputSchema: {
        all: z.boolean().optional()
          .describe('When true, include successful sessions in the per-session table. Default false.'),
        limit: z.number().int().positive().max(200).optional()
          .describe('Max sessions in the per-session table. Default 20.'),
      },
    },
    async (input) => {
      const digests = await storage.listDigests();
      const text = formatReport(digests, {
        failuresOnly: !input.all,
        limitSessions: input.limit ?? 20,
      });
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          sessionCount: digests.length,
          fingerprintCount: countDistinctFingerprints(digests),
        },
      };
    },
  );

  // ── Tool 2: replay_fingerprint ────────────────────────────────────────
  server.registerTool(
    'replay_fingerprint',
    {
      title: 'Replay a failure-pattern fingerprint',
      description:
        'Drill into every session matching a patternFingerprint (prefix match ' +
        'accepted when unambiguous). Returns a markdown report covering cross-session ' +
        'tool/file/error aggregates plus the first user ask and first failed tool ' +
        'result from each matching session. Use this after query_failure_patterns ' +
        'identifies a bucket worth investigating.',
      inputSchema: {
        fingerprint: z.string().min(1)
          .describe('The patternFingerprint shown in query_failure_patterns output. Prefix match works when unambiguous.'),
        max_sessions: z.number().int().positive().max(50).optional()
          .describe('Max sessions to deep-load. Default 10.'),
      },
    },
    async (input) => {
      const result = await replayFingerprint(input.fingerprint, storage, {
        maxDeepLoad: input.max_sessions ?? 10,
      });
      return {
        content: [{ type: 'text', text: result.markdown }],
        structuredContent: {
          fingerprint: result.fingerprint,
          matchCount: result.matchedDigests.length,
        },
        isError: result.matchedDigests.length === 0,
      };
    },
  );

  // ── Tool 3: suggest_remedy ────────────────────────────────────────────
  server.registerTool(
    'suggest_remedy',
    {
      title: 'Suggest a remedy for a failure-pattern fingerprint',
      description:
        'Returns a read-only remedy suggestion for a failing pattern: a known-fix pointer when the ' +
        "shape is a solved bug in this repo's own engine, otherwise the prior sessions that hit " +
        'the same (agent + error) shape and later completed — their ask, tools, and change-shaped ' +
        'file evidence. Confidence is an honest tier (known-fix / medium / low / none) and every ' +
        'result prints its denominators. It SUGGESTS a remedy; it NEVER executes or launches an ' +
        "agent. Acting on a remedy is the calling agent's or human's decision.",
      inputSchema: {
        fingerprint: z.string().min(1)
          .describe('The patternFingerprint from query_failure_patterns. Prefix match when unambiguous.'),
        max_samples: z.number().int().positive().max(20).optional()
          .describe('Max resolved siblings to deep-load for evidence. Default 3 (hard cap 3).'),
      },
    },
    async (input) => {
      const result = await suggestRemedy(input.fingerprint, storage, {
        maxResolvedSamples: input.max_samples ?? 3,
      });
      return {
        content: [{ type: 'text', text: result.markdown }],
        // Machine-actionable structured form so a calling agent can act WITHOUT scraping the
        // markdown. Still suggestion-only: known-fix rules expose their headline/remedy/citations
        // (the agent reads the cited file and applies the analogous fix in ITS own session);
        // resolved siblings expose change-shaped evidence ONLY (path + line counts + sha, never
        // file content). Aladeen does not execute anything.
        structuredContent: {
          fingerprint: result.fingerprint,
          tier: result.tier,
          subSignature: result.subSignature,
          guardrail: result.guardrail,
          nFailed: result.nFailed,
          nResolved: result.nResolved,
          ruleCount: result.ruleMatches.length,
          rules: result.ruleMatches.map((r) => ({
            id: r.id,
            headline: r.headline,
            remedyText: r.remedyText,
            citations: r.citations,
          })),
          resolvedSampleCount: result.resolvedSiblings.length,
          resolvedSiblings: result.resolvedSiblings.map((s) => ({
            sessionId: s.sessionId,
            ask: s.ask,
            sharedTools: s.sharedTools,
            sharedFiles: s.sharedFiles,
            changeShaped: s.changeShaped,
            hasFileTelemetry: s.hasFileTelemetry,
          })),
        },
        isError: result.failingDigests.length === 0,
      };
    },
  );

  // ── Resource 1: aladeen://digests ─────────────────────────────────────
  server.registerResource(
    'digests',
    'aladeen://digests',
    {
      title: 'All ingested run digests',
      description: 'JSON array of every RunDigest currently stored in .aladeen/ingested/digests/. Use this when you need structured access instead of the formatted report.',
      mimeType: 'application/json',
    },
    async () => {
      const digests = await storage.listDigests();
      return {
        contents: [{
          uri: 'aladeen://digests',
          mimeType: 'application/json',
          text: JSON.stringify(digests, null, 2),
        }],
      };
    },
  );

  // ── Resource 2: aladeen://sessions/{sessionId} ────────────────────────
  server.registerResource(
    'session',
    new ResourceTemplate('aladeen://sessions/{sessionId}', { list: undefined }),
    {
      title: 'A single SessionTrace by id',
      description: 'Full SessionTrace JSON for one session. The {sessionId} placeholder accepts the same id format shown in query_failure_patterns output.',
      mimeType: 'application/json',
    },
    async (uri, params) => {
      const sessionId = Array.isArray(params['sessionId']) ? params['sessionId'][0] : params['sessionId'];
      if (!sessionId) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: 'sessionId is required' }),
          }],
          isError: true,
        };
      }
      const trace = await storage.loadTrace(sessionId);
      if (!trace) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ error: `No trace found for sessionId "${sessionId}"` }),
          }],
          isError: true,
        };
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(trace, null, 2),
        }],
      };
    },
  );

  return server;
}

function countDistinctFingerprints(digests: RunDigest[]): number {
  return new Set(digests.map((d) => d.patternFingerprint)).size;
}
