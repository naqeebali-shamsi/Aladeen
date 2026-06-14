import crossSpawn from 'cross-spawn';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  SessionTraceSchema,
  type SessionEvent,
  type SessionTrace,
} from '../session-trace.js';
import { Scrubber } from '../scrubber.js';
import { inferOutcome } from './_shared/outcome.js';
import { classifyError } from './_shared/classify-error.js';
import { classifyUserMessageOrigin } from './_shared/classify-origin.js';
import { msToIso } from './_shared/time.js';

// Ingester for SST opencode. Sessions live in a SQLite DB at
//   ~/.local/share/opencode/opencode.db   (global, all projects)
// with three relevant tables:
//   session(id, project_id, parent_id, directory, title, time_created,
//           time_updated, summary_additions, summary_deletions, summary_files)
//   message(id, session_id, time_created, time_updated, data)
//   part   (id, message_id, session_id, time_created, time_updated, data)
//
// Both message.data and part.data are JSON blobs.
//
// Message shapes:
//   { role: 'user'|'assistant', time: {created, completed?}, agent, model: {providerID, modelID},
//     tokens?: {total, input, output, reasoning, cache}, cost?, finish?, ... }
//
// Part shapes (relevant ones):
//   { type: 'text',        text }
//   { type: 'reasoning',   text, time: {start, end} }     -- dropped, same policy as Claude Code
//   { type: 'step-start' }                                -- dropped
//   { type: 'step-finish', reason, tokens, cost }         -- used for token rollup
//   { type: 'tool',        tool, callID, state: {status, input, output?, error?, time} }
//
// Opencode rolls tool_call and tool_result into a single part. We split
// it into two SessionEvents on ingest so the schema stays uniform across
// providers.
//
// SQLite access is via the `sqlite3` CLI as a subprocess (-readonly -json).
// This avoids a native dep at the cost of requiring sqlite3 on PATH.
// Detected at preflight; we surface a clear error if missing.

const TOOLS_THAT_WRITE = new Set(['write', 'edit', 'multiedit']);

export interface OpencodeSession {
  id: string;
  project_id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
}

interface OpencodeMessageRow {
  id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface OpencodePartRow {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
}

interface MessageData {
  role?: string;
  time?: { created?: number; completed?: number };
  agent?: string;
  modelID?: string;
  providerID?: string;
  model?: { providerID?: string; modelID?: string };
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { write?: number; read?: number };
  };
  cost?: number;
  finish?: string;
  // Provider/model-level failure on this turn (auth, overload, output-length,
  // abort). Distinct from a tool's state.error — presence means the turn itself
  // failed, which is the fatal-error signal for inferOutcome rule 3.
  error?: { name?: string; data?: { message?: string } } | string;
}

interface PartData {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: unknown;
    error?: string;
    time?: { start?: number; end?: number };
  };
  reason?: string;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { write?: number; read?: number };
  };
  cost?: number;
}

export type SqlExec = (db: string, query: string) => Promise<unknown[]>;

export interface OpencodeIngesterOptions {
  scrubber?: Scrubber;
  // Inject a custom SQL runner — used for tests and for swapping out the
  // sqlite3-CLI subprocess approach (e.g. for better-sqlite3 in the future).
  sqlExec?: SqlExec;
}

export interface OpencodeIngestResult {
  trace: SessionTrace;
  warnings: string[];
}

export class OpencodeIngester {
  private readonly scrubber: Scrubber;
  private readonly sqlExec: SqlExec;

  constructor(opts: OpencodeIngesterOptions = {}) {
    this.scrubber = opts.scrubber ?? new Scrubber();
    this.sqlExec = opts.sqlExec ?? defaultSqlExec;
  }

  async listSessions(dbPath: string): Promise<OpencodeSession[]> {
    const rows = await this.sqlExec(
      dbPath,
      `SELECT id, project_id, parent_id, directory, title, time_created,
              time_updated, summary_additions, summary_deletions, summary_files
       FROM session
       ORDER BY time_created ASC`,
    );
    return rows as OpencodeSession[];
  }

  async ingestSession(dbPath: string, session: OpencodeSession): Promise<OpencodeIngestResult> {
    const warnings: string[] = [];

    const messageRows = (await this.sqlExec(
      dbPath,
      `SELECT id, time_created, time_updated, data
       FROM message
       WHERE session_id = '${sqlQuoteId(session.id)}'
       ORDER BY time_created ASC`,
    )) as OpencodeMessageRow[];

    const partRows = (await this.sqlExec(
      dbPath,
      `SELECT id, message_id, time_created, data
       FROM part
       WHERE session_id = '${sqlQuoteId(session.id)}'
       ORDER BY time_created ASC, id ASC`,
    )) as OpencodePartRow[];

    // Build message → role map and tokenize cost rollup.
    const messageById = new Map<string, MessageData>();
    const erroredMessages: Array<{ ts: string | undefined; text: string }> = [];
    let agentCliVersion: string | undefined;
    const cost = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      any: false,
    };

    for (const row of messageRows) {
      const data = safeParseJson<MessageData>(row.data);
      if (data) {
        messageById.set(row.id, data);
        if (data.tokens) {
          cost.inputTokens += data.tokens.input ?? 0;
          cost.outputTokens += data.tokens.output ?? 0;
          cost.cacheReadTokens += data.tokens.cache?.read ?? 0;
          cost.cacheCreationTokens += data.tokens.cache?.write ?? 0;
          cost.any = true;
        }
        if (data.error) {
          erroredMessages.push({
            ts: msToIso(row.time_updated || row.time_created),
            text: extractOpencodeErrorText(data.error),
          });
        }
      }
    }

    const events: SessionEvent[] = [];
    let seq = 0;
    const nextSeq = () => seq++;
    let sawFatalError = false;

    const dbBase = path.basename(dbPath);
    const srcRef = () => ({
      kind: 'opencode-session' as const,
      file: dbPath,
      // line: not meaningful for SQLite; encode the row id in byteOffset
      // proxy via a comment in the source ref. Skip for now.
    });

    events.push({
      kind: 'session_start',
      seq: nextSeq(),
      source: srcRef(),
      timestamp: msToIso(session.time_created),
    });

    for (const part of partRows) {
      const partData = safeParseJson<PartData>(part.data);
      if (!partData) continue;
      const message = messageById.get(part.message_id);
      const role = message?.role;
      const ts = msToIso(part.time_created);

      switch (partData.type) {
        case 'text': {
          if (typeof partData.text !== 'string') break;
          const scrubbed = this.scrubber.scrubMessage(partData.text);
          if (role === 'user') {
            events.push({
              kind: 'user_message',
              seq: nextSeq(),
              timestamp: ts,
              source: srcRef(),
              text: scrubbed.text,
              origin: classifyUserMessageOrigin(scrubbed.text),
            });
          } else {
            events.push({
              kind: 'agent_message',
              seq: nextSeq(),
              timestamp: ts,
              source: srcRef(),
              text: scrubbed.text,
              model: message?.modelID ?? message?.model?.modelID,
            });
          }
          break;
        }
        case 'tool': {
          if (typeof partData.tool !== 'string' || typeof partData.callID !== 'string') break;
          const state = partData.state ?? {};
          const status = state.status ?? 'unknown';
          const args = state.input && typeof state.input === 'object'
            ? this.scrubber.scrubArgs(state.input)
            : {};

          // Emit tool_call event using the part's timestamp.
          events.push({
            kind: 'tool_call',
            seq: nextSeq(),
            timestamp: ts,
            source: srcRef(),
            toolName: partData.tool,
            callId: partData.callID,
            args,
          });

          // Only emit tool_result if the call is terminal. running/pending
          // states are mid-flight and would falsely report a result.
          if (status === 'completed' || status === 'error') {
            const ok = status === 'completed';
            const outputText = !ok && state.error
              ? state.error
              : stringifyOutput(state.output);
            const scrubbedOutput = outputText
              ? this.scrubber.scrubOutput(outputText).text
              : undefined;
            const endTs = state.time?.end ? msToIso(state.time.end) : ts;

            events.push({
              kind: 'tool_result',
              seq: nextSeq(),
              timestamp: endTs,
              source: srcRef(),
              callId: partData.callID,
              ok,
              output: scrubbedOutput,
              errorClass: ok ? undefined : classifyError(outputText ?? ''),
              durationMs: state.time?.start && state.time?.end
                ? Math.max(0, state.time.end - state.time.start)
                : undefined,
            });

            if (ok && TOOLS_THAT_WRITE.has(partData.tool)) {
              const filePath = (state.input?.['filePath'] ?? state.input?.['path'] ?? state.input?.['file_path']) as string | undefined;
              if (typeof filePath === 'string') {
                const newContent = pickWrittenContent(partData.tool, state.input ?? {});
                events.push({
                  kind: 'file_change',
                  seq: nextSeq(),
                  timestamp: endTs,
                  source: srcRef(),
                  action: partData.tool === 'write' ? 'create' : 'edit',
                  path: this.scrubber.scrubPath(filePath),
                  contentSha256: newContent
                    ? createHash('sha256').update(newContent).digest('hex')
                    : undefined,
                });
              }
            }
          }
          break;
        }
        // 'reasoning', 'step-start' dropped intentionally.
        // 'step-finish' already accounted via message.tokens rollup above.
        default:
          break;
      }
    }

    // Emit a fatal error event per errored assistant turn (feeds inferOutcome
    // rule 3). Positioned before session_end; seq stays monotonic.
    for (const err of erroredMessages) {
      events.push({
        kind: 'error',
        seq: nextSeq(),
        timestamp: err.ts,
        source: srcRef(),
        errorClass: classifyError(err.text),
        message: this.scrubber.scrubMessage(err.text).text,
        fatal: true,
      });
      sawFatalError = true;
    }

    events.push({
      kind: 'session_end',
      seq: nextSeq(),
      source: srcRef(),
      timestamp: msToIso(session.time_updated),
    });

    // Outcome inference shared with Claude Code's logic.
    const outcome = inferOutcome(events, {
      sawFatalError,
      sawInterrupt: false,
      mtime: session.time_updated ? new Date(session.time_updated) : undefined,
    });

    const trace: SessionTrace = {
      schemaVersion: '1',
      sessionId: `opencode:${session.id}`,
      parentSessionId: session.parent_id ? `opencode:${session.parent_id}` : undefined,
      agentCli: {
        name: 'opencode',
        version: agentCliVersion,
      },
      workspace: {
        cwdScrubbed: this.scrubber.scrubPath(session.directory),
        gitRepoNameHash: createHash('sha256').update(session.project_id).digest('hex').slice(0, 16),
        gitBranch: null,
      },
      startedAt: msToIso(session.time_created),
      endedAt: msToIso(session.time_updated),
      outcome,
      events,
      cost: cost.any ? {
        inputTokens: cost.inputTokens || undefined,
        outputTokens: cost.outputTokens || undefined,
        cacheReadTokens: cost.cacheReadTokens || undefined,
        cacheCreationTokens: cost.cacheCreationTokens || undefined,
      } : undefined,
      scrubbing: this.scrubber.manifest(),
      ingesterExtras: {
        opencode: {
          dbBase,
          title: session.title,
          summary: {
            additions: session.summary_additions ?? 0,
            deletions: session.summary_deletions ?? 0,
            files: session.summary_files ?? 0,
          },
        },
      },
    };

    const parsed = SessionTraceSchema.safeParse(trace);
    if (!parsed.success) {
      warnings.push(
        `SessionTrace failed schema validation: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }

    return { trace, warnings };
  }
}

function safeParseJson<T>(s: string | undefined): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

function stringifyOutput(output: unknown): string | undefined {
  if (output == null) return undefined;
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return undefined;
  }
}

// Pull a human-readable string out of an opencode message-level error, which
// may be a bare string or a `{ name, data: { message } }` object.
function extractOpencodeErrorText(error: NonNullable<MessageData['error']>): string {
  if (typeof error === 'string') return error;
  return error.data?.message ?? error.name ?? 'fatal error';
}

function pickWrittenContent(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'write' && typeof input['content'] === 'string') {
    return input['content'] as string;
  }
  if (tool === 'edit' && typeof input['newString'] === 'string') {
    return input['newString'] as string;
  }
  return undefined;
}

// IDs in opencode look like `ses_abc...` / `msg_abc...` — safe alphanumerics.
// We still defang single quotes defensively.
function sqlQuoteId(id: string): string {
  return id.replace(/'/g, "''");
}

// Default SQL runner: spawn `sqlite3 -readonly -json <db> <query>`. Output
// is a JSON array of row objects (one object per row, keys = column names).
// Empty result sets produce empty string, not "[]" — we tolerate both.
async function defaultSqlExec(db: string, query: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const proc = crossSpawn('sqlite3', ['-readonly', '-json', db, query], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', (err) => reject(new Error(`sqlite3 spawn failed: ${err.message}. Is sqlite3 on PATH?`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`sqlite3 exited ${code}: ${stderr.trim()}`));
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) { resolve([]); return; }
      try {
        const parsed = JSON.parse(trimmed);
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (err) {
        reject(new Error(`sqlite3 -json output not parseable: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}
