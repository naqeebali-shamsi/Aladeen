import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  SessionTraceSchema,
  type SessionEvent,
  type SessionTrace,
} from '../session-trace.js';
import { Scrubber } from '../scrubber.js';
import { parseJsonl } from './_shared/jsonl.js';
import { inferOutcome } from './_shared/outcome.js';
import { classifyError } from './_shared/classify-error.js';

// Ingester for OpenAI Codex CLI session transcripts. Codex writes JSONL
// rollouts to:
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl
//
// Each line is a JSON event with `timestamp`, `type`, and `payload`.
// Top-level event types observed:
//   - session_meta   one-per-session header (id, cwd, model_provider, cli_version, instructions)
//   - turn_context   model/tool/permission settings per turn
//   - response_item  canonical conversation stream (messages, function_call, function_call_output, reasoning, custom_tool_call*)
//   - event_msg      UX events (task_started, task_complete, token_count, user_message, agent_message, ...)
//
// We map from `response_item` because it's the canonical artifact;
// `event_msg` is treated as a side channel and only used for end-of-task
// markers. Reasoning items are dropped, same policy as the other
// ingesters.
//
// Known limit: file_change synthesis is intentionally not implemented.
// Codex routes all file ops through `shell_command`, so detecting writes
// requires parsing arbitrary shell strings (cat > FILE, tee, git apply,
// here-docs…). That's a fragile heuristic with high false-positive risk;
// defer until a cleaner signal lands. The fingerprint and tool-usage
// rollups still work because the failure-rate and tool-name dimensions
// fire regardless.

const SHELL_OUTPUT_EXIT_RE = /^Exit code:\s*(-?\d+)/m;

interface SessionMetaPayload {
  id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model_provider?: string;
}

interface FunctionCallPayload {
  type: 'function_call';
  name?: string;
  call_id?: string;
  arguments?: string;       // JSON-encoded string
}

interface FunctionCallOutputPayload {
  type: 'function_call_output';
  call_id?: string;
  output?: string;
}

interface MessagePayload {
  type: 'message';
  role?: 'user' | 'assistant' | 'developer' | 'system';
  content?: Array<{ type?: string; text?: string }> | string;
}

export interface CodexIngestResult {
  trace: SessionTrace;
  warnings: string[];
  skippedTypes: Record<string, number>;
}

export class CodexIngester {
  constructor(private readonly scrubber: Scrubber = new Scrubber()) {}

  // Walk a Codex sessions root and return every rollout-*.jsonl found.
  // The on-disk layout is YYYY/MM/DD/rollout-*.jsonl, but we tolerate any
  // depth so a user can pass either ~/.codex/sessions or a specific day.
  async listSessions(rootDir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
          out.push(full);
        }
      }
    };
    await walk(rootDir);
    return out;
  }

  async ingestFile(filePath: string): Promise<CodexIngestResult> {
    const text = await readFile(filePath, 'utf-8');
    const stats = await stat(filePath);
    return this.ingestText(text, filePath, { mtime: stats.mtime });
  }

  ingestText(text: string, filePath: string, opts: { mtime?: Date } = {}): CodexIngestResult {
    const lines = parseJsonl(text);
    const events: SessionEvent[] = [];
    const skippedTypes: Record<string, number> = {};
    const warnings: string[] = [];

    let seq = 0;
    const nextSeq = () => seq++;

    let meta: SessionMetaPayload = {};
    let sessionStartTs: string | undefined;
    let lastTs: string | undefined;
    let cliVersion: string | undefined;

    const srcRef = (line: number) => ({
      kind: 'codex-transcript' as const,
      file: filePath,
      line,
    });

    events.push({
      kind: 'session_start',
      seq: nextSeq(),
      source: srcRef(0),
    });

    for (const { raw, lineNumber } of lines) {
      const ts = typeof raw['timestamp'] === 'string' ? (raw['timestamp'] as string) : undefined;
      if (ts) {
        if (!sessionStartTs || ts < sessionStartTs) sessionStartTs = ts;
        if (!lastTs || ts > lastTs) lastTs = ts;
      }
      const type = typeof raw['type'] === 'string' ? (raw['type'] as string) : 'unknown';
      const payload = (raw['payload'] as Record<string, unknown> | undefined) ?? {};

      if (type === 'session_meta') {
        meta = payload as SessionMetaPayload;
        cliVersion = meta.cli_version;
        if (meta.timestamp && (!sessionStartTs || meta.timestamp < sessionStartTs)) {
          sessionStartTs = meta.timestamp;
        }
        continue;
      }

      if (type !== 'response_item' && type !== 'event_msg' && type !== 'turn_context') {
        skippedTypes[type] = (skippedTypes[type] ?? 0) + 1;
        continue;
      }

      const payloadType = typeof payload['type'] === 'string' ? (payload['type'] as string) : 'unknown';

      // event_msg side channel: only mine task markers and ignore noise.
      if (type === 'event_msg') {
        skippedTypes[`event_msg:${payloadType}`] = (skippedTypes[`event_msg:${payloadType}`] ?? 0) + 1;
        continue;
      }
      if (type === 'turn_context') {
        skippedTypes['turn_context'] = (skippedTypes['turn_context'] ?? 0) + 1;
        continue;
      }

      // response_item dispatch.
      switch (payloadType) {
        case 'message': {
          const m = payload as unknown as MessagePayload;
          const role = m.role;
          if (role === 'developer' || role === 'system') {
            // System prompts are huge and have no failure-mining signal.
            skippedTypes[`message:${role}`] = (skippedTypes[`message:${role}`] ?? 0) + 1;
            break;
          }
          const text = extractMessageText(m.content);
          if (!text) break;
          const scrubbed = this.scrubber.scrubMessage(text);
          if (role === 'user') {
            events.push({
              kind: 'user_message',
              seq: nextSeq(),
              timestamp: ts,
              source: srcRef(lineNumber),
              text: scrubbed.text,
            });
          } else if (role === 'assistant') {
            events.push({
              kind: 'agent_message',
              seq: nextSeq(),
              timestamp: ts,
              source: srcRef(lineNumber),
              text: scrubbed.text,
            });
          }
          break;
        }
        case 'function_call':
        case 'custom_tool_call': {
          const fc = payload as unknown as FunctionCallPayload;
          const callId = fc.call_id;
          const name = fc.name;
          if (!callId || !name) break;
          const argsObj = parseFunctionCallArgs(fc.arguments);
          const scrubbedArgs = this.scrubber.scrubArgs(argsObj);
          events.push({
            kind: 'tool_call',
            seq: nextSeq(),
            timestamp: ts,
            source: srcRef(lineNumber),
            toolName: name,
            callId,
            args: scrubbedArgs,
          });
          break;
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const out = payload as unknown as FunctionCallOutputPayload;
          if (!out.call_id) break;
          const rawOut = typeof out.output === 'string' ? out.output : '';
          const exitMatch = SHELL_OUTPUT_EXIT_RE.exec(rawOut);
          // For shell_command the convention is "Exit code: N\n..." in
          // the first line. For other tools we don't have a uniform signal,
          // so absent an explicit "Exit code:" prefix we default to ok=true.
          const ok = exitMatch ? exitMatch[1] === '0' : true;
          const scrubbed = rawOut ? this.scrubber.scrubOutput(rawOut).text : undefined;
          events.push({
            kind: 'tool_result',
            seq: nextSeq(),
            timestamp: ts,
            source: srcRef(lineNumber),
            callId: out.call_id,
            ok,
            output: scrubbed,
            errorClass: ok ? undefined : classifyError(rawOut),
          });
          break;
        }
        case 'reasoning':
          skippedTypes['reasoning'] = (skippedTypes['reasoning'] ?? 0) + 1;
          break;
        default:
          skippedTypes[`response_item:${payloadType}`] = (skippedTypes[`response_item:${payloadType}`] ?? 0) + 1;
      }
    }

    events.push({
      kind: 'session_end',
      seq: nextSeq(),
      source: srcRef(lines.length > 0 ? lines[lines.length - 1].lineNumber : 0),
      timestamp: lastTs,
    });

    const outcome = inferOutcome(events, {
      sawFatalError: false,
      sawInterrupt: false,
      mtime: opts.mtime,
    });

    const trace: SessionTrace = {
      schemaVersion: '1',
      sessionId: `codex:${meta.id ?? path.basename(filePath, '.jsonl')}`,
      agentCli: {
        name: 'codex',
        version: cliVersion,
      },
      workspace: {
        cwdScrubbed: meta.cwd ? this.scrubber.scrubPath(meta.cwd) : '(unknown)',
        gitRepoNameHash: meta.cwd
          ? createHash('sha256').update(meta.cwd).digest('hex').slice(0, 16)
          : undefined,
        gitBranch: null,
      },
      startedAt: sessionStartTs,
      endedAt: lastTs,
      outcome,
      events,
      // Codex token_count payloads in observed sessions don't include the
      // input/output counts — they're informational rate-limit signals.
      // Leave cost undefined until a session yields actual numbers.
      scrubbing: this.scrubber.manifest(),
      ingesterExtras: Object.keys(skippedTypes).length > 0
        ? { codex: { skippedTypes, modelProvider: meta.model_provider, originator: meta.originator } }
        : { codex: { modelProvider: meta.model_provider, originator: meta.originator } },
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

function extractMessageText(content: MessagePayload['content']): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function parseFunctionCallArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { raw: args };
  } catch {
    // Codex sometimes stores partial-stream arguments that aren't valid
    // JSON at end-of-line. Don't crash — record the raw string and let
    // the downstream consumer decide what to do.
    return { raw: args };
  }
}

