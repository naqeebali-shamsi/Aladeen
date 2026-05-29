import { describe, expect, it } from 'vitest';
import { OpencodeIngester, type OpencodeSession, type SqlExec } from './opencode.js';
import { Scrubber } from '../scrubber.js';

function makeSqlExec(fixtures: Record<string, unknown[]>): SqlExec {
  return async (_db, query) => {
    // Match on the first non-whitespace word after FROM.
    const m = /FROM\s+(\w+)/i.exec(query);
    const table = m?.[1];
    if (!table || !(table in fixtures)) return [];
    return fixtures[table];
  };
}

const baseSession: OpencodeSession = {
  id: 'ses_test1',
  project_id: 'proj_a',
  parent_id: null,
  directory: '/home/test/repo',
  title: 'fix the bug',
  time_created: 1_700_000_000_000,
  time_updated: 1_700_000_120_000,
  summary_additions: null,
  summary_deletions: null,
  summary_files: null,
};

describe('OpencodeIngester.ingestSession', () => {
  it('maps text parts to user/agent_message based on role', async () => {
    const sqlExec = makeSqlExec({
      message: [
        { id: 'msg_u', time_created: 1_700_000_001_000, time_updated: 1_700_000_001_000,
          data: JSON.stringify({ role: 'user', time: { created: 1_700_000_001_000 } }) },
        { id: 'msg_a', time_created: 1_700_000_002_000, time_updated: 1_700_000_002_000,
          data: JSON.stringify({ role: 'assistant', modelID: 'llama3', providerID: 'ollama',
                                 tokens: { input: 100, output: 50, cache: { write: 0, read: 0 } } }) },
      ],
      part: [
        { id: 'p1', message_id: 'msg_u', time_created: 1_700_000_001_000,
          data: JSON.stringify({ type: 'text', text: 'do the thing' }) },
        { id: 'p2', message_id: 'msg_a', time_created: 1_700_000_002_000,
          data: JSON.stringify({ type: 'text', text: 'on it' }) },
      ],
    });
    const ingester = new OpencodeIngester({
      scrubber: new Scrubber({ homeDir: '/home/test' }),
      sqlExec,
    });
    const result = await ingester.ingestSession('/fake/db', baseSession);

    const kinds = result.trace.events.map((e) => e.kind);
    expect(kinds).toEqual(['session_start', 'user_message', 'agent_message', 'session_end']);
    expect(result.trace.cost?.inputTokens).toBe(100);
    expect(result.trace.cost?.outputTokens).toBe(50);
    expect(result.trace.agentCli.name).toBe('opencode');
  });

  it('splits a tool part into tool_call + tool_result, classifies errors, emits file_change on write success', async () => {
    const sqlExec = makeSqlExec({
      message: [
        { id: 'msg_a', time_created: 1_700_000_002_000, time_updated: 1_700_000_002_000,
          data: JSON.stringify({ role: 'assistant', modelID: 'llama3', providerID: 'ollama' }) },
      ],
      part: [
        // successful write — should emit call + result + file_change
        { id: 'p1', message_id: 'msg_a', time_created: 1_700_000_002_000,
          data: JSON.stringify({
            type: 'tool', tool: 'write', callID: 'call_1',
            state: {
              status: 'completed',
              input: { filePath: '/home/test/repo/foo.ts', content: 'export const x = 1;' },
              output: 'wrote 19 bytes',
              time: { start: 1_700_000_002_000, end: 1_700_000_002_500 },
            },
          }) },
        // failed tool — should emit call + result with errorClass
        { id: 'p2', message_id: 'msg_a', time_created: 1_700_000_003_000,
          data: JSON.stringify({
            type: 'tool', tool: 'write', callID: 'call_2',
            state: {
              status: 'error',
              input: { path: 'hello.txt', content: 'hi' },
              error: 'The write tool was called with invalid arguments: SchemaError(Missing key at ["filePath"])',
              time: { start: 1_700_000_003_000, end: 1_700_000_003_100 },
            },
          }) },
      ],
    });
    const ingester = new OpencodeIngester({
      scrubber: new Scrubber({ homeDir: '/home/test' }),
      sqlExec,
    });
    const result = await ingester.ingestSession('/fake/db', baseSession);

    const kinds = result.trace.events.map((e) => e.kind);
    expect(kinds).toEqual([
      'session_start',
      'tool_call', 'tool_result', 'file_change',
      'tool_call', 'tool_result',
      'session_end',
    ]);

    const fileChange = result.trace.events.find((e) => e.kind === 'file_change');
    if (fileChange?.kind === 'file_change') {
      expect(fileChange.path).toBe('~/repo/foo.ts');
      expect(fileChange.action).toBe('create');
      expect(fileChange.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    }

    const failResult = result.trace.events.find(
      (e) => e.kind === 'tool_result' && e.callId === 'call_2',
    );
    if (failResult?.kind === 'tool_result') {
      expect(failResult.ok).toBe(false);
      expect(failResult.errorClass).toBe('parse_error');
      expect(failResult.durationMs).toBe(100);
    }
  });

  it('flags a session with mostly-failing trailing tools as errored', async () => {
    const oldSession = { ...baseSession, time_updated: 1_700_000_000_000 };
    const tool = (id: string, ok: boolean) => ({
      id: `p${id}`, message_id: 'msg_a', time_created: 1_700_000_000_000 + Number(id),
      data: JSON.stringify({
        type: 'tool', tool: 'bash', callID: `call_${id}`,
        state: { status: ok ? 'completed' : 'error', input: {}, output: ok ? 'ok' : 'fail',
                 error: ok ? undefined : 'fail',
                 time: { start: 1_700_000_000_000, end: 1_700_000_000_100 } },
      }),
    });
    const sqlExec = makeSqlExec({
      message: [
        { id: 'msg_a', time_created: 1_700_000_002_000, time_updated: 1_700_000_002_000,
          data: JSON.stringify({ role: 'assistant', modelID: 'm' }) },
      ],
      part: [tool('1', false), tool('2', false), tool('3', false), tool('4', false), tool('5', false)],
    });
    const ingester = new OpencodeIngester({
      scrubber: new Scrubber({ homeDir: '/home/test' }),
      sqlExec,
    });
    const result = await ingester.ingestSession('/fake/db', oldSession);
    expect(result.trace.outcome).toBe('errored');
  });

  it('listSessions returns rows from the session table', async () => {
    const sqlExec = makeSqlExec({ session: [baseSession] });
    const ingester = new OpencodeIngester({ sqlExec });
    const out = await ingester.listSessions('/fake/db');
    expect(out).toEqual([baseSession]);
  });
});
