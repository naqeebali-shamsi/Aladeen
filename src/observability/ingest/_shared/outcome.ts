import type { SessionEvent, SessionOutcome } from '../../session-trace.js';

// Shared event-stream outcome inference. Rule order (earlier wins):
//   1. Fresh mtime (within 5 min) → 'running'
//   2. ctx.sawInterrupt → 'interrupted'
//   3. ctx.sawFatalError → 'errored'
//   4. Trailing tool_results: last 5 ≥ 80% failed AND last one failed → 'errored'
//   5. Dangling tool_call (open IDs at end of stream) → 'gave_up'
//   6. Any meaningful event present → 'completed'
//   7. Otherwise → 'unknown'
//
// Callers MUST pass mtime when they have one. The previous codex.ts inline
// version omitted both the mtime check and the sawInterrupt branch, which
// caused recent codex sessions to misclassify as 'completed' instead of
// 'running'. Promoting this to a shared module fixed that silently.

export interface OutcomeContext {
  sawFatalError: boolean;
  sawInterrupt: boolean;
  // Modification time of the source artifact. If recent (< 5 min), the
  // session is treated as still in progress regardless of trailing events.
  mtime?: Date;
}

export function inferOutcome(events: SessionEvent[], ctx: OutcomeContext): SessionOutcome {
  if (ctx.mtime && Date.now() - ctx.mtime.getTime() < 5 * 60 * 1000) {
    return 'running';
  }
  if (ctx.sawInterrupt) return 'interrupted';
  if (ctx.sawFatalError) return 'errored';

  const toolResults = events.filter(
    (e): e is Extract<SessionEvent, { kind: 'tool_result' }> => e.kind === 'tool_result',
  );
  if (toolResults.length > 0) {
    const tail = toolResults.slice(-5);
    const fails = tail.filter((r) => !r.ok).length;
    const lastResult = toolResults[toolResults.length - 1];
    if (tail.length >= 3 && fails / tail.length >= 0.8 && !lastResult.ok) {
      return 'errored';
    }
  }

  const openCalls = new Set<string>();
  for (const e of events) {
    if (e.kind === 'tool_call') openCalls.add(e.callId);
    else if (e.kind === 'tool_result') openCalls.delete(e.callId);
  }
  if (openCalls.size > 0) return 'gave_up';

  if (events.some((e) => e.kind === 'user_message' || e.kind === 'tool_call')) {
    return 'completed';
  }
  return 'unknown';
}
