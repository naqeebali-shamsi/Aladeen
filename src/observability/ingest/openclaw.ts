import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  SessionTraceSchema,
  type SessionEvent,
  type SessionTrace,
  type SessionOutcome,
} from '../session-trace.js';
import { Scrubber } from '../scrubber.js';
import { parseJsonl } from './_shared/jsonl.js';
import { inferOutcome } from './_shared/outcome.js';
import { classifyError } from './_shared/classify-error.js';

// Ingester for OpenClaw agent sessions.
//
// Storage layout (per public skill-pack convention, NOT validated against a
// real OpenClaw vault on this machine — we don't have one installed):
//   ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
//   ~/.openclaw/agents/<agentId>/sessions/sessions.json   -- index, ignored
//
// Each JSONL line is a single message in the Anthropic content-block style:
//   {
//     role: 'user' | 'assistant' | 'system',
//     content: string | ContentBlock[],
//     usage?: { input_tokens, output_tokens, cost?: { total } },
//     timestamp: ISO-8601
//   }
//
// ContentBlock types we handle:
//   { type: 'text', text }
//   { type: 'tool_use', id, name, input }
//   { type: 'tool_result', tool_use_id, content, is_error? }
//
// CAVEAT: shape inferred from third-party skill-pack documentation
// (LobeHub marketplace + OpenClaw project docs). If a real vault reveals
// drift, this parser is the single point to patch — schema, pipeline, and
// downstream report/replay remain stable.

const TOOLS_THAT_WRITE = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
]);

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawMessage {
  role?: string;
  content?: string | ContentBlock[];
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cost?: { total?: number };
  };
}

export interface OpenClawIngestSource {
  sessionId: string;
  filePath: string;
  agentId?: string;
}

export interface OpenClawIngestResult {
  trace: SessionTrace;
  warnings: string[];
  skippedTypes: Record<string, number>;
}

export class OpenClawIngester {
  constructor(private readonly scrubber: Scrubber = new Scrubber()) {}

  // Walk an OpenClaw root or a specific agent's sessions directory. Tolerant
  // of either layout because users may pass --path either way.
  async listSessions(rootPath: string): Promise<OpenClawIngestSource[]> {
    const out: OpenClawIngestSource[] = [];
    let stats;
    try {
      stats = await stat(rootPath);
    } catch {
      return out;
    }
    if (!stats.isDirectory()) return out;

    const agentsDir = await detectAgentsDir(rootPath);
    if (!agentsDir) return out;

    let agents;
    try {
      agents = await readdir(agentsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      const sessionsDir = path.join(agentsDir, agent.name, 'sessions');
      let sessions;
      try {
        sessions = await readdir(sessionsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of sessions) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        out.push({
          sessionId: entry.name.replace(/\.jsonl$/, ''),
          filePath: path.join(sessionsDir, entry.name),
          agentId: agent.name,
        });
      }
    }
    return out;
  }

  async ingestFile(source: OpenClawIngestSource): Promise<OpenClawIngestResult> {
    const text = await readFile(source.filePath, 'utf-8');
    const stats = await stat(source.filePath);
    return this.ingestText(text, source, { mtime: stats.mtime });
  }

  ingestText(
    text: string,
    source: OpenClawIngestSource,
    opts: { mtime?: Date } = {},
  ): OpenClawIngestResult {
    const lines = parseJsonl(text);
    const events: SessionEvent[] = [];
    const skippedTypes: Record<string, number> = {};
    const warnings: string[] = [];

    let earliestTs: string | undefined;
    let latestTs: string | undefined;
    let cost = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedUsd: 0,
      anyReported: false,
    };

    // Pair tool_use → tool_result by id so we can synthesize file_change
    // events on successful Write/Edit/MultiEdit calls.
    const callIndex = new Map<string, { toolName: string; args: Record<string, unknown> }>();

    let seq = 0;
    const nextSeq = () => seq++;

    events.push({
      kind: 'session_start',
      seq: nextSeq(),
      source: { kind: 'openclaw-session', file: source.filePath, line: 0 },
    });

    for (const { raw, lineNumber } of lines) {
      const message = raw as RawMessage;
      const role = message.role;
      const ts = typeof (raw as { timestamp?: unknown }).timestamp === 'string'
        ? ((raw as { timestamp: string }).timestamp)
        : undefined;
      if (ts) {
        if (!earliestTs || ts < earliestTs) earliestTs = ts;
        if (!latestTs || ts > latestTs) latestTs = ts;
      }

      // Cost rollup whenever a message carries it (Anthropic convention
      // attaches it to assistant messages but we accept it anywhere).
      if (message.usage) {
        cost.inputTokens += message.usage.input_tokens ?? 0;
        cost.outputTokens += message.usage.output_tokens ?? 0;
        cost.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
        cost.cacheCreationTokens += message.usage.cache_creation_input_tokens ?? 0;
        if (typeof message.usage.cost?.total === 'number') {
          cost.estimatedUsd += message.usage.cost.total;
        }
        cost.anyReported = true;
      }

      const srcRef = { kind: 'openclaw-session' as const, file: source.filePath, line: lineNumber };
      const content = message.content;

      if (role === 'system') {
        skippedTypes['role:system'] = (skippedTypes['role:system'] ?? 0) + 1;
        continue;
      }

      if (typeof content === 'string') {
        const scrubbed = this.scrubber.scrubMessage(content);
        events.push({
          kind: role === 'assistant' ? 'agent_message' : 'user_message',
          seq: nextSeq(),
          timestamp: ts,
          source: srcRef,
          text: scrubbed.text,
          ...(role === 'assistant' && message.model ? { model: message.model } : {}),
        } as SessionEvent);
        continue;
      }

      if (!Array.isArray(content)) {
        skippedTypes['content:non-array'] = (skippedTypes['content:non-array'] ?? 0) + 1;
        continue;
      }

      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const scrubbed = this.scrubber.scrubMessage(block.text);
          events.push({
            kind: role === 'assistant' ? 'agent_message' : 'user_message',
            seq: nextSeq(),
            timestamp: ts,
            source: srcRef,
            text: scrubbed.text,
            ...(role === 'assistant' && message.model ? { model: message.model } : {}),
          } as SessionEvent);
        } else if (block.type === 'tool_use'
                   && typeof block.id === 'string'
                   && typeof block.name === 'string') {
          const args = block.input && typeof block.input === 'object'
            ? this.scrubber.scrubArgs(block.input as Record<string, unknown>)
            : {};
          callIndex.set(block.id, { toolName: block.name, args });
          events.push({
            kind: 'tool_call',
            seq: nextSeq(),
            timestamp: ts,
            source: srcRef,
            toolName: block.name,
            callId: block.id,
            args,
          });
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const ok = block.is_error !== true;
          const outputText = stringifyToolResultContent(block.content);
          const scrubbedOutput = outputText
            ? this.scrubber.scrubOutput(outputText).text
            : undefined;
          events.push({
            kind: 'tool_result',
            seq: nextSeq(),
            timestamp: ts,
            source: srcRef,
            callId: block.tool_use_id,
            ok,
            output: scrubbedOutput,
            errorClass: ok ? undefined : classifyError(outputText ?? ''),
          });

          if (ok) {
            const call = callIndex.get(block.tool_use_id);
            if (call && TOOLS_THAT_WRITE.has(call.toolName)) {
              const fileArg = typeof call.args['file_path'] === 'string'
                ? (call.args['file_path'] as string)
                : undefined;
              if (fileArg) {
                const newContent = pickWrittenContent(call.toolName, call.args);
                events.push({
                  kind: 'file_change',
                  seq: nextSeq(),
                  timestamp: ts,
                  source: srcRef,
                  action: call.toolName === 'Write' ? 'create' : 'edit',
                  path: this.scrubber.scrubPath(fileArg),
                  contentSha256: newContent
                    ? createHash('sha256').update(newContent).digest('hex')
                    : undefined,
                });
              }
            }
          }
        } else {
          skippedTypes[`content:${block.type}`] = (skippedTypes[`content:${block.type}`] ?? 0) + 1;
        }
      }
    }

    events.push({
      kind: 'session_end',
      seq: nextSeq(),
      source: {
        kind: 'openclaw-session',
        file: source.filePath,
        line: lines.length > 0 ? lines[lines.length - 1].lineNumber : 0,
      },
      timestamp: latestTs,
    });

    const outcome: SessionOutcome = inferOutcome(events, {
      sawFatalError: false,
      sawInterrupt: false,
      mtime: opts.mtime,
    });

    const trace: SessionTrace = {
      schemaVersion: '1',
      sessionId: `openclaw:${source.sessionId}`,
      parentSessionId: source.agentId ? `openclaw-agent:${source.agentId}` : undefined,
      agentCli: { name: 'openclaw' },
      workspace: {
        cwdScrubbed: source.agentId ? `~/.openclaw/agents/${source.agentId}` : '(unknown)',
        gitRepoNameHash: source.agentId
          ? createHash('sha256').update(source.agentId).digest('hex').slice(0, 16)
          : undefined,
        gitBranch: null,
      },
      startedAt: earliestTs,
      endedAt: latestTs,
      outcome,
      events,
      cost: cost.anyReported ? {
        inputTokens: cost.inputTokens || undefined,
        outputTokens: cost.outputTokens || undefined,
        cacheReadTokens: cost.cacheReadTokens || undefined,
        cacheCreationTokens: cost.cacheCreationTokens || undefined,
        estimatedUsd: cost.estimatedUsd > 0 ? cost.estimatedUsd : undefined,
      } : undefined,
      scrubbing: this.scrubber.manifest(),
      ingesterExtras: {
        openclaw: {
          agentId: source.agentId,
          ...(Object.keys(skippedTypes).length > 0 ? { skippedTypes } : {}),
        },
      },
    };

    const parsed = SessionTraceSchema.safeParse(trace);
    if (!parsed.success) {
      warnings.push(
        `SessionTrace failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    return { trace, warnings, skippedTypes };
  }
}

// Locate the `agents/` directory. Accepts either ~/.openclaw or
// ~/.openclaw/agents directly so the CLI default and an explicit --path
// both work.
async function detectAgentsDir(rootPath: string): Promise<string | undefined> {
  const direct = path.join(rootPath, 'agents');
  try {
    const s = await stat(direct);
    if (s.isDirectory()) return direct;
  } catch { /* fall through */ }
  // Already pointing at agents/?
  if (path.basename(rootPath) === 'agents') return rootPath;
  return undefined;
}

function stringifyToolResultContent(content: unknown): string | undefined {
  if (content == null) return undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        try {
          return JSON.stringify(b);
        } catch {
          return '';
        }
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return undefined;
  }
}

function pickWrittenContent(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === 'Write' && typeof args['content'] === 'string') {
    return args['content'] as string;
  }
  if (toolName === 'Edit' && typeof args['new_string'] === 'string') {
    return args['new_string'] as string;
  }
  return undefined;
}

