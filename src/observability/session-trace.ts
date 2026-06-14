import { z } from 'zod';

// SessionTrace is the universal normalized form of an agent CLI session.
// Every ingester (Claude Code JSONL, opencode, Codex, Gemini, Aladeen's own
// ExecutionState) targets this shape. The classifier, pattern miner, and
// replay primitive consume RunDigest, which is derived from SessionTrace.
//
// Design invariants:
//   - Raw secrets/PII never persist. Scrubbing happens at ingest, declared in
//     the Scrubbing envelope so traces can be reprocessed when rules improve.
//   - Every event carries source coordinates so any anomaly traces back to a
//     specific byte range in the original artifact.
//   - Ordering uses monotonic `seq` per session, not timestamps. Clocks lie.
//   - Adding a new agent CLI must not require schema changes — extend the
//     SourceKind union and write an adapter, that's it.

export const SOURCE_KINDS = [
  'claude-code-jsonl',
  'opencode-session',
  'codex-transcript',
  'gemini-cli-log',
  'aladeen-execution-state',
  'openclaw-session',
  'hermes-session',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// Pointer back to the byte range in the original artifact. If a downstream
// consumer disagrees with the parser, this is how you reproduce the dispute.
export const SourceRefSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  byteOffset: z.number().int().nonnegative().optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

// Redaction declaration. `passes` lists every transform applied; bumping a
// version means re-running ingest will produce a strictly better trace.
// Markers in scrubbed strings look like `[REDACTED:<reason>]` so they grep
// cleanly and survive JSON round-trips.
export const SCRUB_REASONS = [
  'secret',           // API keys, tokens, passwords
  'pii',              // emails, names matched against deny-list
  'path-home',        // user's home directory path
  'env-value',        // contents of process.env values
  'file-content',     // verbatim file contents the agent read
  'shell-output',     // stdout/stderr from shell commands
] as const;
export type ScrubReason = (typeof SCRUB_REASONS)[number];

export const ScrubbingSchema = z.object({
  passes: z.array(z.object({
    reason: z.enum(SCRUB_REASONS),
    version: z.string(),
  })),
  // Set true when ingester opts into preserving certain content (e.g. user
  // explicitly allowed file-content retention for one session). Default false.
  optedInRetention: z.record(z.enum(SCRUB_REASONS), z.boolean()).optional(),
});
export type Scrubbing = z.infer<typeof ScrubbingSchema>;

// All events share these fields. Concrete event types extend this with `kind`.
const EventBaseSchema = z.object({
  seq: z.number().int().nonnegative(),
  // ISO 8601. Present when source has it; never invented.
  timestamp: z.string().datetime().optional(),
  source: SourceRefSchema,
});

// Provenance of a role=user turn. Agent CLIs funnel three very different
// things through the same role=user slot, and prompt-quality mining must see
// only the human ones:
//   - human    a real person's prompt.
//   - injected harness-inserted context: environment blocks, AGENTS.md/
//              CLAUDE.md dumps, slash-command expansions, skill/subagent
//              prompts, image placeholders, turn-abort/interrupt notices.
//   - protocol inter-agent / tool machine traffic: teammate & subagent
//              coordination frames, bare JSON dispatch envelopes.
export const USER_MESSAGE_ORIGINS = ['human', 'injected', 'protocol'] as const;
export type UserMessageOrigin = (typeof USER_MESSAGE_ORIGINS)[number];

export const UserMessageEventSchema = EventBaseSchema.extend({
  kind: z.literal('user_message'),
  text: z.string(),              // scrubbed
  // Classified at ingest, where the parser has the most context. OPTIONAL so
  // traces written before this field existed still parse (schemaVersion stays
  // '1'); consumers treat an absent origin as "unknown" and fall back to a
  // shape heuristic. See observability/ingest/_shared/classify-origin.ts.
  origin: z.enum(USER_MESSAGE_ORIGINS).optional(),
  attachments: z.array(z.object({
    type: z.string(),
    pathHash: z.string().optional(),  // sha256 of original path, never the path
  })).optional(),
});

export const AgentMessageEventSchema = EventBaseSchema.extend({
  kind: z.literal('agent_message'),
  text: z.string(),              // scrubbed
  model: z.string().optional(),
});

export const ToolCallEventSchema = EventBaseSchema.extend({
  kind: z.literal('tool_call'),
  toolName: z.string(),          // normalized: Read, Edit, Bash, etc.
  callId: z.string(),            // for pairing with tool_result
  args: z.record(z.unknown()),   // scrubbed
});

export const ToolResultEventSchema = EventBaseSchema.extend({
  kind: z.literal('tool_result'),
  callId: z.string(),
  ok: z.boolean(),
  // Scrubbed. Highest-signal field for failure pattern mining — keep it but
  // truncate aggressively (most tool results compress to <500 bytes).
  output: z.string().optional(),
  errorClass: z.string().optional(),  // see ERROR_CLASSES below
  durationMs: z.number().nonnegative().optional(),
});

export const FileChangeEventSchema = EventBaseSchema.extend({
  kind: z.literal('file_change'),
  action: z.enum(['create', 'edit', 'delete', 'rename']),
  // Paths are kept (not hashed) — they're the highest-signal field for
  // replay and they almost never contain secrets. Home directory components
  // get rewritten to ~ by the scrubber.
  path: z.string(),
  oldPath: z.string().optional(),  // for rename
  // sha256 of new content; lets you detect "agent rewrote the same file 10
  // times with the same result" without storing content.
  contentSha256: z.string().optional(),
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
});

// Open taxonomy. Add freely. Ingesters classify what they can; the miner
// reclassifies later as patterns emerge.
export const ERROR_CLASSES = [
  'rate_limit',
  'context_overflow',
  'tool_error',
  'parse_error',
  'network',
  'auth',
  'binary_not_found',
  'worktree_collision',
  'lint_loop',
  'permission_denied',
  'timeout',
  'model_refusal',
  'unknown',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export const ErrorEventSchema = EventBaseSchema.extend({
  kind: z.literal('error'),
  errorClass: z.enum(ERROR_CLASSES),
  message: z.string(),           // scrubbed
  fatal: z.boolean(),            // did this end the session?
});

export const InterruptEventSchema = EventBaseSchema.extend({
  kind: z.literal('interrupt'),
  // Best-effort. Sometimes you can't tell.
  initiator: z.enum(['user', 'system', 'unknown']),
});

export const SubagentSpawnEventSchema = EventBaseSchema.extend({
  kind: z.literal('subagent_spawn'),
  childSessionId: z.string(),    // join key for the child SessionTrace
  agentType: z.string().optional(),
  taskDescription: z.string().optional(),  // scrubbed
});

export const SessionMarkerEventSchema = EventBaseSchema.extend({
  kind: z.enum(['session_start', 'session_end']),
});

export const SessionEventSchema = z.discriminatedUnion('kind', [
  UserMessageEventSchema,
  AgentMessageEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  FileChangeEventSchema,
  ErrorEventSchema,
  InterruptEventSchema,
  SubagentSpawnEventSchema,
  SessionMarkerEventSchema,
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

// Outcome is derived at ingest time from the event stream. Keep small and
// orthogonal so the classifier doesn't have to second-guess.
export const SESSION_OUTCOMES = [
  'completed',     // ended normally, no fatal errors, no interrupt
  'interrupted',   // user stopped it
  'errored',       // fatal error ended the session
  'gave_up',       // agent refused or stalled (heuristic)
  'running',       // still active when trace was captured
  'unknown',       // ingester couldn't tell
] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

// Cost is optional — many CLIs don't report it. Don't fabricate.
export const CostSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  // USD estimate. Only set if the ingester is confident in pricing.
  estimatedUsd: z.number().nonnegative().optional(),
});

export const SessionTraceSchema = z.object({
  // Schema version. Bump when this file changes incompatibly.
  schemaVersion: z.literal('1'),
  // Stable id, hashed if necessary. Same id across reingest of same source.
  sessionId: z.string(),
  parentSessionId: z.string().optional(),  // for subagent traces
  agentCli: z.object({
    name: z.string(),              // 'claude-code', 'opencode', 'codex', etc.
    version: z.string().optional(),
  }),
  // Where it ran. Cwd is scrubbed (home -> ~). Git branch is nullable
  // because not every session lives in a repo.
  workspace: z.object({
    cwdScrubbed: z.string(),
    gitRepoNameHash: z.string().optional(),  // hash, not name
    gitBranch: z.string().nullable().optional(),
  }),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  outcome: z.enum(SESSION_OUTCOMES),
  events: z.array(SessionEventSchema),
  cost: CostSchema.optional(),
  scrubbing: ScrubbingSchema,
  // Free-form. Ingesters drop format-specific extras here. Anything that
  // graduates to first-class moves out of extras into a real field.
  ingesterExtras: z.record(z.unknown()).optional(),
});
export type SessionTrace = z.infer<typeof SessionTraceSchema>;

// RunDigest is what the classifier and pattern miner consume. It is a
// lossy, query-friendly projection of SessionTrace. Always regeneratable.
export const RunDigestSchema = z.object({
  sessionId: z.string(),
  agentCliName: z.string(),
  outcome: z.enum(SESSION_OUTCOMES),
  // Wall-clock span between first and last event timestamp. Includes idle
  // gaps when the user resumed across days, so this is misleading for any
  // session with breaks. Kept for reference; prefer activeDurationMs.
  durationMs: z.number().nonnegative().optional(),
  // Sum of gaps between consecutive events where gap < IDLE_GAP_MS (10 min).
  // Excludes idle periods. Closer to "actual time the agent was working."
  activeDurationMs: z.number().nonnegative().optional(),
  // Distinct tools used, count each.
  toolUsage: z.record(z.string(), z.number().int().nonnegative()),
  // Top errors by class.
  errorCounts: z.record(z.enum(ERROR_CLASSES), z.number().int().nonnegative()),
  // Files touched. Path basenames are enough for most pattern queries.
  filesChanged: z.array(z.string()),
  // How many tool_result events came back ok=false.
  toolFailureCount: z.number().int().nonnegative(),
  // Did the agent re-edit the same file >N times? (loop heuristic)
  editLoops: z.array(z.object({
    path: z.string(),
    editCount: z.number().int().positive(),
  })),
  cost: CostSchema.optional(),
  // Fingerprint used by the miner to bucket similar runs.
  // Built from: agentCli, outcome, sorted top-3 error classes, sorted top-5
  // file extensions touched. See observability/digest.ts for the algorithm.
  patternFingerprint: z.string(),
});
export type RunDigest = z.infer<typeof RunDigestSchema>;
