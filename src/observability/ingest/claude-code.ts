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
import { parseJsonl, type RawLine } from './_shared/jsonl.js';
import { inferOutcome } from './_shared/outcome.js';
import { classifyError } from './_shared/classify-error.js';

// Ingester for Claude Code .jsonl session files. The on-disk layout under
// ~/.claude/projects/<encoded-cwd>/ is:
//   <sessionId>.jsonl                  -- top-level session
//   <sessionId>/subagents/<id>.jsonl   -- spawned subagent sessions
//
// Each line is a JSON object with a `type` field. The shapes we care about:
//   { type: 'user',      message: { role, content: string | ContentBlock[] }, timestamp }
//   { type: 'assistant', message: { role, content: ContentBlock[], model? },  timestamp }
//   { type: 'system',    ... }                       -- skipped
//   { type: 'attachment' | 'file-history-snapshot'
//          | 'last-prompt' | 'queue-operation', ... } -- skipped, kept in ingesterExtras
//
// ContentBlock shapes we read:
//   { type: 'text',        text }
//   { type: 'thinking',    thinking }                 -- skipped for v1
//   { type: 'tool_use',    id, name, input }
//   { type: 'tool_result', tool_use_id, content, is_error? }

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
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
  };
}

export interface IngestSourceFile {
  sessionId: string;
  filePath: string;
  parentSessionId?: string;
}

export interface IngestResult {
  trace: SessionTrace;
  skippedTypes: Record<string, number>;
  warnings: string[];
}

const TOOLS_THAT_WRITE = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
]);

export class ClaudeCodeIngester {
  constructor(private readonly scrubber: Scrubber = new Scrubber()) {}

  // Walk a Claude Code project directory and return every session file
  // (top-level + subagents). Caller decides which ones to ingest.
  async listSessions(projectDir: string): Promise<IngestSourceFile[]> {
    const out: IngestSourceFile[] = [];
    const entries = await readdir(projectDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push({
          sessionId: entry.name.replace(/\.jsonl$/, ''),
          filePath: path.join(projectDir, entry.name),
        });
      }
      if (entry.isDirectory()) {
        const subagentsDir = path.join(projectDir, entry.name, 'subagents');
        try {
          const subEntries = await readdir(subagentsDir, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && sub.name.endsWith('.jsonl')) {
              out.push({
                sessionId: sub.name.replace(/\.jsonl$/, ''),
                filePath: path.join(subagentsDir, sub.name),
                parentSessionId: entry.name,
              });
            }
          }
        } catch {
          // No subagents folder; ignore.
        }
      }
    }

    return out;
  }

  async ingestFile(source: IngestSourceFile): Promise<IngestResult> {
    const text = await readFile(source.filePath, 'utf-8');
    const stats = await stat(source.filePath);
    return this.ingestText(text, source, { mtime: stats.mtime });
  }

  ingestText(
    text: string,
    source: IngestSourceFile,
    opts: { mtime?: Date } = {},
  ): IngestResult {
    const lines = parseJsonl(text);
    const events: SessionEvent[] = [];
    const skippedTypes: Record<string, number> = {};
    const warnings: string[] = [];

    // Accumulators for derived fields.
    let earliestTs: string | undefined;
    let latestTs: string | undefined;
    let sawFatalError = false;
    let sawInterrupt = false;
    let cost = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      anyUsageReported: false,
    };

    // Pairing map: tool_use_id -> {toolName, callSeq, args}. We use this
    // when emitting file_change events from successful Edit/Write calls.
    const callIndex = new Map<string, { toolName: string; args: Record<string, unknown> }>();

    let seq = 0;
    const nextSeq = () => seq++;

    const projectDirName = path.basename(path.dirname(source.filePath));

    events.push({
      kind: 'session_start',
      seq: nextSeq(),
      source: { kind: 'claude-code-jsonl', file: source.filePath, line: 0 },
    });

    for (const { raw, lineNumber } of lines) {
      const type = typeof raw['type'] === 'string' ? (raw['type'] as string) : 'unknown';
      const ts = typeof raw['timestamp'] === 'string' ? (raw['timestamp'] as string) : undefined;
      if (ts) {
        if (!earliestTs || ts < earliestTs) earliestTs = ts;
        if (!latestTs || ts > latestTs) latestTs = ts;
      }

      const srcRef = {
        kind: 'claude-code-jsonl' as const,
        file: source.filePath,
        line: lineNumber,
      };

      if (type === 'user') {
        const message = (raw['message'] as RawMessage | undefined) ?? {};
        const content = message.content;

        if (typeof content === 'string') {
          const scrubbed = this.scrubber.scrubMessage(content);
          events.push({
            kind: 'user_message',
            seq: nextSeq(),
            timestamp: ts,
            source: srcRef,
            text: scrubbed.text,
          });
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              const scrubbed = this.scrubber.scrubMessage(block.text);
              events.push({
                kind: 'user_message',
                seq: nextSeq(),
                timestamp: ts,
                source: srcRef,
                text: scrubbed.text,
              });
            } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              const ok = block.is_error !== true;
              const outputText = stringifyToolResultContent(block.content);
              const scrubbed = outputText
                ? this.scrubber.scrubOutput(outputText).text
                : undefined;
              const errorClass = ok ? undefined : classifyError(outputText ?? '');

              events.push({
                kind: 'tool_result',
                seq: nextSeq(),
                timestamp: ts,
                source: srcRef,
                callId: block.tool_use_id,
                ok,
                output: scrubbed,
                errorClass,
              });

              // Emit file_change when a write-tool call succeeded.
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
            }
            // Other content types (image, etc.) intentionally dropped.
          }
        }
      } else if (type === 'assistant') {
        const message = (raw['message'] as RawMessage | undefined) ?? {};
        const content = message.content;
        const model = message.model;

        if (message.usage) {
          cost.inputTokens += message.usage.input_tokens ?? 0;
          cost.outputTokens += message.usage.output_tokens ?? 0;
          cost.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
          cost.cacheCreationTokens += message.usage.cache_creation_input_tokens ?? 0;
          cost.anyUsageReported = true;
        }

        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              const scrubbed = this.scrubber.scrubMessage(block.text);
              events.push({
                kind: 'agent_message',
                seq: nextSeq(),
                timestamp: ts,
                source: srcRef,
                text: scrubbed.text,
                model,
              });
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
            }
            // 'thinking' blocks dropped — they leak intent more than they
            // add classification signal. Add as a future option.
          }
        }
      } else {
        // queue-operation, file-history-snapshot, system, attachment,
        // last-prompt, etc. Track counts; don't emit events.
        skippedTypes[type] = (skippedTypes[type] ?? 0) + 1;
        // Heuristic interrupt detection: queue-operation with content
        // referencing /interrupt or explicit user-initiated stop signals.
        if (type === 'queue-operation') {
          const content = typeof raw['content'] === 'string' ? (raw['content'] as string) : '';
          if (/^\/(esc|interrupt|stop)\b/i.test(content)) {
            sawInterrupt = true;
            events.push({
              kind: 'interrupt',
              seq: nextSeq(),
              timestamp: ts,
              source: srcRef,
              initiator: 'user',
            });
          }
        }
      }
    }

    events.push({
      kind: 'session_end',
      seq: nextSeq(),
      source: {
        kind: 'claude-code-jsonl',
        file: source.filePath,
        line: lines.length > 0 ? lines[lines.length - 1].lineNumber : 0,
      },
      timestamp: latestTs,
    });

    // Outcome inference (v2). Order matters — earlier checks win.
    //   1. Fresh file mtime → 'running' (session may still be in progress)
    //   2. Saw explicit interrupt event → 'interrupted'
    //   3. Saw fatal error event → 'errored'
    //   4. Trailing tool_results were mostly failures (>=80% of last 5)
    //      and the session ends on a failure → 'errored' (silently bombed)
    //   5. Dangling tool_call (no matching tool_result) at end → 'gave_up'
    //   6. Any meaningful event happened → 'completed'
    //   7. Otherwise → 'unknown'
    const outcome: SessionOutcome = inferOutcome(events, {
      sawFatalError,
      sawInterrupt,
      mtime: opts.mtime,
    });

    const trace: SessionTrace = {
      schemaVersion: '1',
      sessionId: source.sessionId,
      parentSessionId: source.parentSessionId,
      agentCli: { name: 'claude-code' },
      workspace: {
        cwdScrubbed: this.scrubber.scrubPath(decodeProjectDirName(projectDirName)),
        gitRepoNameHash: createHash('sha256').update(projectDirName).digest('hex').slice(0, 16),
        gitBranch: null,
      },
      startedAt: earliestTs,
      endedAt: latestTs,
      outcome,
      events,
      cost: cost.anyUsageReported ? {
        inputTokens: cost.inputTokens || undefined,
        outputTokens: cost.outputTokens || undefined,
        cacheReadTokens: cost.cacheReadTokens || undefined,
        cacheCreationTokens: cost.cacheCreationTokens || undefined,
      } : undefined,
      scrubbing: this.scrubber.manifest(),
      ingesterExtras: Object.keys(skippedTypes).length > 0
        ? { skippedTypes }
        : undefined,
    };

    // Validate at the boundary so a schema regression fails loudly, not at
    // some downstream consumer.
    const parsed = SessionTraceSchema.safeParse(trace);
    if (!parsed.success) {
      warnings.push(
        `SessionTrace failed schema validation: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    return { trace, skippedTypes, warnings };
  }
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

// Best-effort decode of ~/.claude/projects/<encoded>/ folder names back to
// a human-readable cwd. The encoding observed: drive colon and path
// separators collapse to '-'. We can't reliably reverse without ambiguity,
// so we return the encoded form with a leading marker.
function decodeProjectDirName(encoded: string): string {
  if (encoded.startsWith('-')) {
    return `~/...${encoded}`;
  }
  return encoded;
}

