import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { suggestRemedy, subSignature, nonzeroErrorClasses, REMEDY_RULES } from './remedy.js';
import type { IngestStorage } from './storage.js';
import {
  ERROR_CLASSES, type RunDigest, type SessionTrace, type ErrorClass, type SessionOutcome,
} from './session-trace.js';

function zeroErrors(): Record<ErrorClass, number> {
  return Object.fromEntries(ERROR_CLASSES.map((c) => [c, 0])) as Record<ErrorClass, number>;
}

type DOpts = Partial<Omit<RunDigest, 'errorCounts'>> & { errorCounts?: Partial<Record<ErrorClass, number>> };
function d(p: DOpts = {}): RunDigest {
  return {
    sessionId: p.sessionId ?? 's',
    agentCliName: p.agentCliName ?? 'codex',
    outcome: p.outcome ?? 'gave_up',
    durationMs: p.durationMs,
    activeDurationMs: p.activeDurationMs,
    toolUsage: p.toolUsage ?? {},
    errorCounts: { ...zeroErrors(), ...(p.errorCounts ?? {}) },
    filesChanged: p.filesChanged ?? [],
    toolFailureCount: p.toolFailureCount ?? 0,
    editLoops: p.editLoops ?? [],
    cost: p.cost,
    patternFingerprint: p.patternFingerprint ?? 'fp_fail',
  };
}

function fakeStorage(digests: RunDigest[], traces: Record<string, SessionTrace> = {}): IngestStorage {
  return {
    listDigests: async () => digests,
    loadTrace: async (id: string) => traces[id] ?? null,
  } as unknown as IngestStorage;
}

function traceWith(
  sessionId: string,
  opts: { ask?: string; files?: Array<{ path: string; action?: string; linesAdded?: number; linesRemoved?: number }> } = {},
): SessionTrace {
  const events: unknown[] = [];
  let seq = 0;
  if (opts.ask) events.push({ kind: 'user_message', seq: seq++, source: { kind: 'codex-transcript', file: 'x' }, text: opts.ask });
  for (const f of opts.files ?? []) {
    events.push({ kind: 'file_change', seq: seq++, source: { kind: 'codex-transcript', file: 'x' }, action: f.action ?? 'edit', path: f.path, linesAdded: f.linesAdded, linesRemoved: f.linesRemoved });
  }
  return { schemaVersion: '1', sessionId, agentCli: { name: 'codex' }, workspace: { cwdScrubbed: '~/x' }, outcome: 'completed' as SessionOutcome, events, scrubbing: { passes: [] } } as unknown as SessionTrace;
}

describe('helpers + registry', () => {
  it('ships exactly two remedy rules', () => {
    expect(REMEDY_RULES).toHaveLength(2);
    expect(REMEDY_RULES.map((r) => r.id).sort()).toEqual(['lint_loop', 'worktree_collision']);
  });
  it('subSignature drops outcome, keeps agent + sorted nonzero classes; empty when none', () => {
    expect(subSignature(d({ agentCliName: 'codex', errorCounts: { tool_error: 2, parse_error: 1 } }))).toBe('codex|parse_error,tool_error');
    expect(subSignature(d({ errorCounts: {} }))).toBe('');
    expect(nonzeroErrorClasses(d({ errorCounts: { auth: 1 } }))).toEqual(['auth']);
  });
});

describe('suggestRemedy — known-fix tier', () => {
  it('1. worktree_collision failure → known-fix with the bootstrap-deps citation', async () => {
    const fail = d({ sessionId: 'wc', agentCliName: 'aladeen', outcome: 'gave_up', errorCounts: { worktree_collision: 2267 }, toolFailureCount: 2267, patternFingerprint: 'fp_wc' });
    const r = await suggestRemedy('fp_wc', fakeStorage([fail]));
    expect(r.tier).toBe('known-fix');
    expect(r.ruleMatches[0].id).toBe('worktree_collision');
    expect(r.markdown).toContain('install dependencies inside the git worktree');
    expect(r.markdown).toContain('src/blueprints/implement-feature.ts:88-99');
  });

  it('2. lint_loop rule fires ONLY with edit-loop evidence', async () => {
    const withLoop = d({ outcome: 'errored', errorCounts: { lint_loop: 3 }, editLoops: [{ path: 'a.ts', editCount: 5 }], patternFingerprint: 'fp_ll1' });
    expect((await suggestRemedy('fp_ll1', fakeStorage([withLoop]))).tier).toBe('known-fix');
    const noLoop = d({ outcome: 'errored', errorCounts: { lint_loop: 3 }, editLoops: [], patternFingerprint: 'fp_ll2' });
    const r2 = await suggestRemedy('fp_ll2', fakeStorage([noLoop]));
    expect(r2.ruleMatches).toHaveLength(0);
    expect(r2.tier).not.toBe('known-fix');
  });

  it('3. known-fix rule does NOT fire on a completed bucket carrying the class', async () => {
    const completedWc = d({ outcome: 'completed', errorCounts: { worktree_collision: 5 }, toolFailureCount: 5, patternFingerprint: 'fp_cwc' });
    const r = await suggestRemedy('fp_cwc', fakeStorage([completedWc]));
    expect(r.ruleMatches).toHaveLength(0);
    expect(r.tier).not.toBe('known-fix');
  });
});

describe('suggestRemedy — none / suppression', () => {
  it('4. empty sub-signature failure is suppressed to none (no same-CLI completions surfaced)', async () => {
    const emptyFail = d({ sessionId: 'ef', outcome: 'gave_up', errorCounts: {}, patternFingerprint: 'fp_empty' });
    const sameCliCompleted = d({ sessionId: 'c', outcome: 'completed', errorCounts: {}, patternFingerprint: 'fp_c' });
    const r = await suggestRemedy('fp_empty', fakeStorage([emptyFail, sameCliCompleted]));
    expect(r.tier).toBe('none');
    expect(r.subSignature).toBe('');
    expect(r.resolvedSiblings).toHaveLength(0);
    expect(r.guardrail).toContain('No comparable resolved session in your history yet. Read-only drill-down only.');
    // Also assert the sentence lands in the markdown body, not only the guardrail.
    expect(r.markdown).toContain('No comparable resolved session in your history yet. Read-only drill-down only.');
  });

  it('5. non-empty signature with zero resolved siblings → none, prints denominators', async () => {
    const parseFail = d({ outcome: 'errored', errorCounts: { parse_error: 4 }, patternFingerprint: 'fp_pf' });
    const r = await suggestRemedy('fp_pf', fakeStorage([parseFail]));
    expect(r.tier).toBe('none');
    expect(r.markdown).toContain('n_failed=');
    expect(r.markdown).toContain('n_resolved=0');
  });

  it('6. running sessions are excluded from the resolved pool', async () => {
    const failP = d({ sessionId: 'f', outcome: 'errored', errorCounts: { parse_error: 1 }, patternFingerprint: 'fp_p1' });
    const running = d({ sessionId: 'r', outcome: 'running', errorCounts: { parse_error: 1 }, patternFingerprint: 'fp_run' });
    const r = await suggestRemedy('fp_p1', fakeStorage([failP, running]));
    expect(r.nResolved).toBe(0);
    expect(r.tier).toBe('none');
  });

  it('16. directly-queried completed bucket → none with n_failed=0 (never mislabels completions as failed)', async () => {
    // Regression: the evidence tier keys only on sub-signature + resolved siblings, so a COMPLETED
    // bucket queried directly used to surface a low/medium tier whose n_failed=N counted sessions
    // that did not fail. GATE 0 now suppresses it to none with an honest zero failure-count.
    const completedQueried = d({ sessionId: 'cq', outcome: 'completed', errorCounts: { tool_error: 2 }, patternFingerprint: 'fp_completed_q' });
    const completedSibling = d({ sessionId: 'cs', outcome: 'completed', errorCounts: { tool_error: 1 }, patternFingerprint: 'fp_completed_sib' });
    const r = await suggestRemedy('fp_completed_q', fakeStorage([completedQueried, completedSibling]));
    expect(r.tier).toBe('none');
    expect(r.nFailed).toBe(0);
    expect(r.resolvedSiblings).toHaveLength(0);
    expect(r.markdown).toContain('n_failed=0');
  });

  it('14. unknown fingerprint → empty bucket, none tier, no-match markdown', async () => {
    const r = await suggestRemedy('does-not-exist', fakeStorage([d({ patternFingerprint: 'other' })]));
    expect(r.failingDigests).toEqual([]);
    expect(r.tier).toBe('none');
    expect(r.markdown).toContain('No sessions matched this fingerprint');
  });
});

describe('suggestRemedy — evidence tier', () => {
  it('7. one completed sibling on the sub-signature → low (n=1) with change-shaped evidence', async () => {
    const fail = d({ sessionId: 'fa', outcome: 'errored', errorCounts: { tool_error: 2 }, patternFingerprint: 'fp_te_fail', filesChanged: ['/r/a.ts'] });
    const resolved = d({ sessionId: 'ra', outcome: 'completed', errorCounts: { tool_error: 1 }, patternFingerprint: 'fp_te_ok', toolUsage: { Edit: 3 }, filesChanged: ['/r/a.ts'] });
    const r = await suggestRemedy('fp_te_fail', fakeStorage([fail, resolved], { ra: traceWith('ra', { ask: 'do thing', files: [{ path: '/r/a.ts', action: 'edit', linesAdded: 5, linesRemoved: 1 }] }) }));
    expect(r.tier).toBe('low');
    expect(r.resolvedSiblings).toHaveLength(1);
    expect(r.guardrail).toContain('Weak signal');
    expect(r.guardrail).toContain('n=1');
  });

  it('8. three completed siblings → medium, capped at 3', async () => {
    const fail = d({ sessionId: 'fb', outcome: 'errored', errorCounts: { tool_error: 2 }, patternFingerprint: 'fp_b' });
    const sibs = [1, 2, 3, 4].map((i) => d({ sessionId: `s${i}`, outcome: 'completed', errorCounts: { tool_error: 1 }, patternFingerprint: `fp_ok${i}` }));
    const r = await suggestRemedy('fp_b', fakeStorage([fail, ...sibs]));
    expect(r.tier).toBe('medium');
    expect(r.nResolved).toBe(4);
    expect(r.resolvedSiblings).toHaveLength(3);
    expect(r.guardrail).toContain('lead, not a fix');
  });

  it('9. siblings ordered by deterministic sessionId-desc tiebreak (not recency)', async () => {
    const fail = d({ sessionId: 'f9', outcome: 'errored', errorCounts: { tool_error: 1 }, patternFingerprint: 'fp9' });
    const aaa = d({ sessionId: 'aaa', outcome: 'completed', errorCounts: { tool_error: 1 }, patternFingerprint: 'fpA' });
    const zzz = d({ sessionId: 'zzz', outcome: 'completed', errorCounts: { tool_error: 1 }, patternFingerprint: 'fpZ' });
    const r = await suggestRemedy('fp9', fakeStorage([fail, aaa, zzz]));
    expect(r.resolvedSiblings.map((s) => s.sessionId)).toEqual(['zzz', 'aaa']);
  });

  it('10. change-shaped evidence shows files + line counts, never a diff', async () => {
    const fail = d({ sessionId: 'f10', outcome: 'errored', errorCounts: { tool_error: 1 }, patternFingerprint: 'fp10' });
    const resolved = d({ sessionId: 's10', outcome: 'completed', errorCounts: { tool_error: 1 }, patternFingerprint: 'fpok10', filesChanged: ['/r/a.ts'] });
    const r = await suggestRemedy('fp10', fakeStorage([fail, resolved], { s10: traceWith('s10', { files: [{ path: '/r/a.ts', action: 'edit', linesAdded: 5, linesRemoved: 1 }] }) }));
    expect(r.markdown).toContain('/r/a.ts');
    expect(r.markdown).toContain('+5');
    expect(r.markdown).toContain('no diff stored — privacy invariant');
    expect(r.markdown).not.toMatch(/```diff/);
    expect(r.markdown).not.toContain('+++');
  });

  it('11. resolved sibling with no file telemetry says so, never blank-implies-clean', async () => {
    const fail = d({ sessionId: 'f11', outcome: 'errored', errorCounts: { auth: 1 }, patternFingerprint: 'fp11' });
    const sib = d({ sessionId: 's11', outcome: 'completed', errorCounts: { auth: 1 }, patternFingerprint: 'fpok11', filesChanged: [] });
    const r = await suggestRemedy('fp11', fakeStorage([fail, sib], { s11: traceWith('s11', {}) }));
    expect(r.markdown).toContain('no file telemetry for this session');
  });

  it('12. verb discipline: evidence tiers never say "will fix"/"do this"; "fix" only in "not a fix"', async () => {
    const failLow = d({ sessionId: 'fl', outcome: 'errored', errorCounts: { timeout: 1 }, patternFingerprint: 'fpl' });
    const sibLow = d({ sessionId: 'sl', outcome: 'completed', errorCounts: { timeout: 1 }, patternFingerprint: 'fpsl' });
    const low = await suggestRemedy('fpl', fakeStorage([failLow, sibLow]));
    const failMed = d({ sessionId: 'fm', outcome: 'errored', errorCounts: { network: 1 }, patternFingerprint: 'fpm' });
    const sibsMed = [1, 2, 3].map((i) => d({ sessionId: `m${i}`, outcome: 'completed', errorCounts: { network: 1 }, patternFingerprint: `fpm${i}` }));
    const med = await suggestRemedy('fpm', fakeStorage([failMed, ...sibsMed]));
    for (const md of [low.markdown, med.markdown]) {
      expect(md).not.toContain('will fix');
      expect(md).not.toMatch(/\bdo this\b/);
      const fixCount = (md.match(/fix/gi) || []).length;
      const notAFix = (md.match(/not a fix/gi) || []).length;
      expect(fixCount).toBe(notAFix);
    }
  });

  it('13. coverageNote is derived live from storage counts', async () => {
    const fail = d({ sessionId: 'cf', outcome: 'errored', errorCounts: { timeout: 1 }, patternFingerprint: 'fpc', filesChanged: ['/x/a.ts'] });
    const o1 = d({ sessionId: 'o1', outcome: 'completed', errorCounts: {}, patternFingerprint: 'fpo1' });
    const o2 = d({ sessionId: 'o2', outcome: 'completed', errorCounts: {}, patternFingerprint: 'fpo2' });
    const r = await suggestRemedy('fpc', fakeStorage([fail, o1, o2]));
    expect(r.coverageNote).toContain('filesChanged 1/3');
  });
});

describe('suggestRemedy — purity invariant', () => {
  it('15. remedy.ts imports no fs / child_process / network module', () => {
    const src = readFileSync(fileURLToPath(new URL('./remedy.ts', import.meta.url)), 'utf8');
    // Assert on actual import/require statements, not the word appearing in prose comments.
    expect(src).not.toMatch(/from ['"](node:)?child_process['"]/);
    expect(src).not.toMatch(/from ['"](node:)?fs(\/promises)?['"]/);
    expect(src).not.toMatch(/from ['"]node:(net|http|https|dgram|tls)['"]/);
    expect(src).not.toMatch(/require\(\s*['"](node:)?(child_process|fs|net|http)['"]\s*\)/);
    expect(src).not.toMatch(/\bspawn\s*\(/);
  });
});
