# BUILD SPEC — Actionable Replay (+ README tense-split + name one-liner)

Status: FINAL, converged. Tech-lead build spec for three deliverables. Resolves every
adversarial-review mustFix. Stays inside the PM MVP + non-goals. Every contested claim below
was re-verified against repo source and the live 199-session store before locking.

---

## 0. Ground truth verified before locking this spec

Read directly from source (not the brief):

- `src/observability/digest.ts:43-50` — `errorCounts` ONLY increments inside the `tool_result`
  `!ok` branch (or rare standalone `error` events). **Consequence: any digest with a nonzero
  error class has `toolFailureCount > 0`; any clean-completed session has empty `errorCounts`.**
- `src/observability/digest.ts:30-32` — `errorCounts` is zero-filled across all 13 `ERROR_CLASSES`
  on every digest (dense). A digest from older code or a hand-written test fixture may be sparse;
  `RunDigestSchema` (`z.record(z.enum(ERROR_CLASSES), number)`) accepts sparse, so code must
  tolerate missing keys (`?? 0`).
- `src/observability/digest.ts:132-155` — `patternFingerprint = sha256(agentCli | OUTCOME |
  top-3 errorClasses | failure-rate-bucket | hasEditLoops).slice(0,16)`. Outcome is baked in, so
  a failing bucket has zero `completed` siblings by construction. Matching MUST be cross-fingerprint.
- `src/observability/replay.ts:71` — `matchFingerprint` is private; exact-then-prefix match,
  prefix only when unambiguous. We export it (add `export` keyword only).
- `src/observability/ingest/aladeen-runs.ts:19-22` — `lint_loop` is classified by regex
  `/lint|eslint|tsc.*error/` against ANY failed tool output; `worktree_collision` by
  `/worktree|fatal: '.*' is not a working tree/`. **Neither detects a loop.** A single
  non-looping tsc failure is classed `lint_loop`.
- `src/blueprints/implement-feature.ts` (NOT `src/engine/blueprints/` — that path does not exist):
  `bootstrap-deps` node at **lines 88-99** (`npm install --no-audit --no-fund`, 10-min timeout);
  `maxTotalRetries: 5` at **line 64**; `fix-lint` `maxRetries: 1` at **line 157**.
- `src/engine/verifiers/lint.ts:24-34` — `LintVerifier` autoFix block. **It is NOT wired into
  implement-feature.ts** (the blueprint runs raw `tsc --noEmit` via shell at lines 138-148).
  So the lint.ts citation must be qualified, not asserted as the fix that ran.
- Live store: **199 sessions, 42 fingerprints** (confirmed via `query_failure_patterns`).
  Both worktree_collision buckets exist: `0bf55f47e07870a4` and `2fcd8f35eae88754`, each
  matchCount 1, both `aladeen | gave_up`. `lint_loop` appears in **0/199** digests.
- `src/dashboard/server.ts:138-147` — `/api/replay/:fp` block to clone. Security headers,
  127.0.0.1 bind, GET/HEAD-only gate all live in `handle()` and are inherited by new routes.
- `src/dashboard/web/app.js:473-501` — `interfaceQuery`; line 500 renders
  `<button class="replay-btn" data-replay-open>⟳ REPLAY THIS FIX</button>`; line 503-517
  `parseReplay` regex-scrapes markdown; line 519-526 `openReplayModal`; line 571-573 delegated
  `[data-replay-open]` listener already calls `openReplayModal`. **The new card reuses that
  delegated listener for the RAW DRILL-DOWN link — no new wiring.**
- `src/mcp/server.ts:88-119` — `replay_fingerprint` registration to mirror; instructions at 45-51.
- Existing test files: `src/observability/replay.test.ts`, `src/mcp/server.test.ts`,
  `src/dashboard/server.test.ts` — extend these.

### The decision that unblocks the whole feature (mustFix: DEAD EVIDENCE TIER)

The original design's resolved-sibling gate (`outcome==='completed' AND toolFailureCount===0`)
combined with the matchable gate (`non-empty subSignature`) is **mutually exclusive on this and
any conformant corpus** — proven above. Two options:

- (A) ship `known-fix` + `none` only, cut the evidence tier entirely.
- (B) relax the resolved gate to **`outcome==='completed'`** (drop `toolFailureCount===0`), and
  build the subSignature from `errorCounts`. A session that hit `parse_error`/`tool_error`
  mid-run but still completed becomes the resolution. Counterfactual verified in the review:
  ~101 completed sessions carry nonzero error classes and would become matchable under (B).

**LOCKED: option (B).** It is the only choice that makes "matching a failure to a prior
resolution" a real, live capability on the user's own data while staying honest. The
empty-subSignature suppression gate STAYS (it kills the 45-clean-completions-to-1-gave_up trap
that has no error semantics). `running` is still excluded (not a resolution).

This changes one definition: a **resolved sibling** = `outcome === 'completed'` AND
`subSignature(d) !== ''` (i.e. it carries at least one nonzero error class it overcame). We do
NOT require `toolFailureCount === 0`. We explicitly DO NOT count `running` or any failure outcome.

---

## DELIVERABLE (a) — ACTIONABLE REPLAY

### (a) One-line value

Given a failing pattern, Aladeen returns an honest, read-only remedy — a known-fix pointer into
this repo's own engine when the shape is a solved bug, otherwise the prior sessions that hit the
same `(agent + error)` shape and later completed — that a human or MCP agent can act on. Aladeen
never runs the agent.

### (a) MVP (exactly this, nothing more)

1. ONE new pure module `src/observability/remedy.ts` exporting
   `suggestRemedy(fingerprint, storage, opts?): Promise<RemedyResult>`. I/O only via the injected
   `IngestStorage` (`listDigests()` / `loadTrace()`). No `fs`, no `child_process`, no `spawn`, no
   network. Mirrors `replay.ts` purity.
2. `REMEDY_RULES` as a DATA-only `readonly` const: **exactly two** entries (`worktree_collision`,
   `lint_loop`). A rule fires only when the FAILING bucket's outcome is a failure
   (`errored`/`gave_up`/`interrupted`) AND its `errorCounts` carries the keyed class AND (for
   `lint_loop` only) `editLoops.length > 0` (loop evidence gate — see mustFix below).
3. Cross-fingerprint evidence matcher on `subSignature = agentCliName | sorted(nonzero errorClasses)`
   with hard gates: empty subSignature → suppress; resolved candidate = same subSignature AND
   `outcome==='completed'`; zero candidates → tier `none`. Rank by errorClass-set overlap, then a
   deterministic id tiebreak. Cap 3.
4. 4-tier enum `known-fix | medium | low | none` with tier-bound, templated guardrail copy and a
   live-derived `coverageNote`. Confidence is COMPUTED from rule-hit or sibling count `n`, never
   asserted. Denominators (`nFailed`, `nResolved`) printed on every tier.
5. `src/observability/remedy.test.ts` (synthetic digests; see Test Plan).
6. ONE upstream change: add `export` to `matchFingerprint` in `replay.ts` (zero behavior change).

Then the SURFACES slice (separate but specified here):
7. ONE new MCP tool `suggest_remedy` in `src/mcp/server.ts`, mirroring `replay_fingerprint`.
8. ONE new route `GET /api/remedy/:fp` in `src/dashboard/server.ts`, cloned from `/api/replay/`.
9. Rewire `app.js interfaceQuery`: replace the `⟳ REPLAY THIS FIX` button with a REMEDY CARD
   (tier badge + guardrail + ask/tools/change-shaped files) and a `RAW DRILL-DOWN ↗` link that
   reuses the untouched `openReplayModal`. Delete `parseReplay` reliance for the card.

---

### (a) ALGORITHM — `src/observability/remedy.ts`

This is the locked, review-corrected version. Differences from the original engineering design are
called out inline as `// FIX(...)`.

```typescript
// ============================================================================
// src/observability/remedy.ts  — CORE REMEDY ENGINE (pure; I/O via storage only)
// ============================================================================
import type { IngestStorage } from './storage.js';
import type {
  RunDigest, SessionTrace, SessionEvent, ErrorClass, SessionOutcome,
} from './session-trace.js';
import { matchFingerprint } from './replay.js'; // NEW export (add `export` keyword only)

// --- Public types -----------------------------------------------------------
export type RemedyTier = 'known-fix' | 'medium' | 'low' | 'none';

export interface RemedyCitation {
  file: string;   // repo-relative; PRIMARY key is the symbol/node name in `what`
  lines: string;  // best-effort line range; WILL rot — treat `what` as the durable anchor
  what: string;   // names the node/symbol: 'bootstrap-deps node', 'maxTotalRetries', etc.
}

export interface RemedyRule {
  id: 'worktree_collision' | 'lint_loop';
  matchErrorClass: ErrorClass;
  // FIX(lint_loop overclaim): extra predicate. When set, the rule fires ONLY if it returns true
  // for the failing sample (e.g. editLoops present). Keeps `lint_loop` from asserting a loop the
  // data never proves — a lone tsc failure is classed lint_loop by the ingester regex.
  extraGate?: (sample: RunDigest) => boolean;
  headline: string;     // shape statement, NOT a per-session diagnosis
  remedyText: string;   // 'The known fix for this shape was ...' (past tense, about the engine)
  citations: RemedyCitation[];
}

export interface ChangeShapedFile {
  path: string;
  action?: 'create' | 'edit' | 'delete' | 'rename';
  linesAdded?: number;
  linesRemoved?: number;
  contentSha256?: string; // hash only — NEVER content
}

export interface ResolvedSibling {
  sessionId: string;
  outcome: SessionOutcome;            // always 'completed' (gate)
  sharedErrorClasses: ErrorClass[];   // intersection with failing bucket
  sharedTools: string[];              // tool names (digest.toolUsage keys)
  sharedFiles: string[];              // basenames shared with failing bucket (may be [])
  changeShaped: ChangeShapedFile[];   // [] => render 'no file telemetry for this session'
  hasFileTelemetry: boolean;          // false => UI must SAY so, never imply a clean change set
  ask?: string;                       // first user_message excerpt (deep-loaded), truncated
}

export interface RemedyResult {
  fingerprint: string;             // resolved full fp (or raw input if no bucket)
  failingDigests: RunDigest[];     // the matched failing bucket (length 0 => 404 / isError)
  subSignature: string;            // 'agentCli|cls,cls' — '' when no nonzero classes
  tier: RemedyTier;
  ruleMatches: RemedyRule[];       // 0 or 1 in v1 (first matching rule wins)
  resolvedSiblings: ResolvedSibling[]; // capped at 3; [] for known-fix/none
  guardrail: string;               // tier-bound, templated (author cannot upgrade by tone)
  coverageNote: string;            // derived LIVE from storage counts
  nFailed: number;                 // failing bucket size
  nResolved: number;               // # completed siblings on the subSignature
  markdown: string;                // render reusing replay.ts vocabulary
}

export interface SuggestOptions {
  maxResolvedSamples?: number;     // default 3, hard-capped at 3 in v1
  maxExcerptChars?: number;        // default 200 (matches replay.ts)
}

// --- Constants ---------------------------------------------------------------
const FAILURE_OUTCOMES: readonly SessionOutcome[] = ['errored', 'interrupted', 'gave_up'];

// DATA-only registry. EXACTLY TWO entries in v1 (NON-GOAL to add more).
// FIX(citation path): src/blueprints/implement-feature.ts (NO /engine/). Verified single file.
// FIX(citation rot): primary anchor is the named node/symbol in `what`; lines are best-effort.
export const REMEDY_RULES: readonly RemedyRule[] = [
  {
    id: 'worktree_collision',
    matchErrorClass: 'worktree_collision',
    headline: 'This shape matches a known bug in your own engine: a git worktree without its deps.',
    remedyText:
      'The known fix for this shape was to install dependencies inside the git worktree before '
      + 'running gates — node_modules is not copied by `git worktree add`. Confirm this is the '
      + 'same cause before acting; the classifier matches the word "worktree" broadly.',
    citations: [
      { file: 'src/blueprints/implement-feature.ts', lines: '88-99',
        what: "the 'bootstrap-deps' node runs the install command in the worktree before any gate" },
    ],
  },
  {
    id: 'lint_loop',
    matchErrorClass: 'lint_loop',
    // FIX(lint_loop overclaim, highest severity): the lint_loop ErrorClass is produced by the
    // ingester regex /lint|eslint|tsc.*error/ on ANY failed lint/tsc output — it does NOT detect
    // a loop. Gate on actual loop evidence so the rule only fires when the session really looped.
    extraGate: (s) => s.editLoops.length > 0,
    headline:
      'This shape matches a lint/typecheck gate that re-edited the same file repeatedly '
      + '(an edit loop) in your own engine.',
    remedyText:
      'The known fix for this shape was to bound the deterministic fix/check retries so a '
      + 'lint -> fix-lint -> lint cycle cannot run unbounded. Confirm an actual loop occurred '
      + 'before acting.',
    citations: [
      { file: 'src/blueprints/implement-feature.ts', lines: '64',
        what: 'maxTotalRetries: 5 caps total retries across the loop' },
      { file: 'src/blueprints/implement-feature.ts', lines: '157',
        what: 'fix-lint node maxRetries: 1' },
      // FIX(lint.ts not wired): qualify — the verifier exposes a --fix pass but the
      // implement-feature blueprint runs raw `tsc --noEmit`, not LintVerifier. Cite as available
      // capability, NOT as the fix that ran.
      { file: 'src/engine/verifiers/lint.ts', lines: '24-34',
        what: 'LintVerifier autoFix/--fix capability (available; not wired into implement-feature)' },
    ],
  },
] as const;

// --- Pure helpers (exported for tests) --------------------------------------
export function nonzeroErrorClasses(d: RunDigest): ErrorClass[] {
  return (Object.entries(d.errorCounts ?? {}) as [ErrorClass, number][])
    .filter(([, n]) => n > 0)
    .map(([cls]) => cls)
    .sort();
}

// Cross-fingerprint join key. Outcome / failure-rate / loops DROPPED on purpose — they are what
// make the primary fingerprint outcome-coupled. '' when no nonzero classes (suppression sentinel).
export function subSignature(d: RunDigest): string {
  const classes = nonzeroErrorClasses(d);
  if (classes.length === 0) return '';
  return `${d.agentCliName}|${classes.join(',')}`;
}

function isFailureOutcome(o: SessionOutcome): boolean {
  return FAILURE_OUTCOMES.includes(o);
}

// FIX(dead evidence tier): a RESOLVED sibling is any completed session that carries error
// semantics (non-empty subSignature). We do NOT require toolFailureCount===0 — that gate plus the
// non-empty-subSignature gate is mutually exclusive given digest.ts:45-49 and kills the tier.
// 'running' is excluded (outcome !== 'completed'). A failure outcome is excluded.
function isResolved(d: RunDigest): boolean {
  return d.outcome === 'completed' && subSignature(d) !== '';
}

function setIntersect(a: ErrorClass[], b: ErrorClass[]): ErrorClass[] {
  const bs = new Set(b);
  return a.filter((x) => bs.has(x));
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

// Rank: errorClass-set overlap DESC, then a DETERMINISTIC id tiebreak.
// FIX(false recency): RunDigest has no startedAt; sessionIds are random UUIDs / hashes. The
// tiebreak is deterministic but NOT chronological — do not call it recency anywhere.
function rankSiblings(failingClasses: ErrorClass[], candidates: RunDigest[]): RunDigest[] {
  return [...candidates].sort((x, y) => {
    const ox = setIntersect(nonzeroErrorClasses(x), failingClasses).length;
    const oy = setIntersect(nonzeroErrorClasses(y), failingClasses).length;
    if (oy !== ox) return oy - ox;            // more shared classes first
    return y.sessionId.localeCompare(x.sessionId); // deterministic id-stable tiebreak (NOT recency)
  });
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
export async function suggestRemedy(
  rawFingerprint: string,
  storage: IngestStorage,
  opts: SuggestOptions = {},
): Promise<RemedyResult> {
  const maxSamples = Math.min(opts.maxResolvedSamples ?? 3, 3);
  const maxExcerpt = opts.maxExcerptChars ?? 200;

  const allDigests = await storage.listDigests();
  const failingDigests = matchFingerprint(rawFingerprint, allDigests); // reused from replay.ts

  if (failingDigests.length === 0) return emptyResult(rawFingerprint, allDigests);

  const sample = failingDigests[0];           // all share the fp (and thus outcome) by construction
  const fingerprint = sample.patternFingerprint;
  const sig = subSignature(sample);
  const failingClasses = nonzeroErrorClasses(sample);
  const nFailed = failingDigests.length;
  const coverageNote = buildCoverageNote(allDigests);

  const failingBasenames = new Set(sample.filesChanged.map(basename));

  // --- TIER A: RULE-BASED known-fix. Fires only on a real failure bucket carrying the keyed
  //     class AND passing the rule's extraGate (loop evidence for lint_loop). ---
  const bucketIsFailure = isFailureOutcome(sample.outcome);
  // NOTE: review flagged completed-but-dirty firing a known-fix. We gate strictly on
  // isFailureOutcome(outcome) — a completed session never reaches the rule path.
  const ruleMatches: RemedyRule[] = [];
  if (bucketIsFailure) {
    for (const rule of REMEDY_RULES) {
      const hasClass = (sample.errorCounts[rule.matchErrorClass] ?? 0) > 0;
      const gateOk = rule.extraGate ? rule.extraGate(sample) : true;
      if (hasClass && gateOk) { ruleMatches.push(rule); break; } // first match wins
    }
  }
  if (ruleMatches.length > 0) {
    return finalize({
      fingerprint, failingDigests, subSignature: sig, tier: 'known-fix',
      ruleMatches, resolvedSiblings: [], nFailed, nResolved: 0, coverageNote, maxExcerpt,
    });
  }

  // --- GATE 1: empty sub-signature => SUPPRESS. The codex|· / claude-code|· trap. ---
  if (sig === '') {
    return finalize({
      fingerprint, failingDigests, subSignature: sig, tier: 'none',
      ruleMatches: [], resolvedSiblings: [], nFailed, nResolved: 0, coverageNote, maxExcerpt,
    });
  }

  // --- TIER B/C: EVIDENCE-BASED nearest-resolved on the sub-signature. ---
  const candidates = allDigests.filter((d) =>
    d.sessionId !== sample.sessionId && subSignature(d) === sig && isResolved(d));
  const nResolved = candidates.length;

  // GATE 2: zero resolved siblings => NONE (explicit no-resolution, prints denominators).
  if (nResolved === 0) {
    return finalize({
      fingerprint, failingDigests, subSignature: sig, tier: 'none',
      ruleMatches: [], resolvedSiblings: [], nFailed, nResolved: 0, coverageNote, maxExcerpt,
    });
  }

  const ranked = rankSiblings(failingClasses, candidates).slice(0, maxSamples);

  // Deep-load ONLY the capped survivors for ask + change-shaped evidence.
  const siblings: ResolvedSibling[] = [];
  for (const d of ranked) {
    const trace = await storage.loadTrace(d.sessionId);
    siblings.push(toResolvedSibling(d, trace, failingClasses, failingBasenames, maxExcerpt));
  }

  const tier: RemedyTier = nResolved >= 3 ? 'medium' : 'low';
  return finalize({
    fingerprint, failingDigests, subSignature: sig, tier,
    ruleMatches: [], resolvedSiblings: siblings, nFailed, nResolved, coverageNote, maxExcerpt,
  });
}

function toResolvedSibling(
  d: RunDigest, trace: SessionTrace | null, failingClasses: ErrorClass[],
  failingBasenames: Set<string>, maxExcerpt: number,
): ResolvedSibling {
  const sharedErrorClasses = setIntersect(nonzeroErrorClasses(d), failingClasses);
  const sharedTools = Object.keys(d.toolUsage);
  const sharedFiles = d.filesChanged.map(basename).filter((b) => failingBasenames.has(b));

  let changeShaped: ChangeShapedFile[] = [];
  let ask: string | undefined;
  if (trace) {
    const changes = trace.events.filter(
      (e): e is Extract<SessionEvent, { kind: 'file_change' }> => e.kind === 'file_change');
    changeShaped = changes.map((c) => ({
      path: c.path, action: c.action,
      linesAdded: c.linesAdded, linesRemoved: c.linesRemoved, contentSha256: c.contentSha256,
    }));
    const firstUser = trace.events.find((e) => e.kind === 'user_message');
    if (firstUser?.kind === 'user_message') {
      ask = truncate(firstUser.text.trim().replace(/\s+/g, ' '), maxExcerpt);
    }
  }
  // hasFileTelemetry reflects the digest's record, independent of whether the trace loaded.
  const hasFileTelemetry = d.filesChanged.length > 0 || changeShaped.length > 0;
  return {
    sessionId: d.sessionId, outcome: d.outcome, sharedErrorClasses, sharedTools, sharedFiles,
    changeShaped, hasFileTelemetry, ask,
  };
}

// FIX(badge/guardrail agreement; verb discipline): evidence path BANS 'fix'/'will fix'/'do this'.
// The word 'fix' appears only on the known-fix tier and inside the literal phrase 'not a fix'.
function guardrailFor(tier: RemedyTier, nFailed: number, nResolved: number): string {
  switch (tier) {
    case 'known-fix':
      return 'This shape matches a solved bug in your own engine; the citation points at the fix '
        + 'that landed for it. Confirm it is the same cause before acting. Read-only suggestion — '
        + 'Aladeen does not run it.';
    case 'medium':
      return `n=${nResolved} resolved session(s) shared this shape; here is what they touched and `
        + 'what they were asked. This is a lead, not a fix — judge it yourself. Aladeen does not '
        + 'run anything.';
    case 'low':
      return `Weak signal: only n=${nResolved} resolved session(s) share this shape. Here is what `
        + 'it touched — treat it as a lead, not a fix.';
    case 'none':
      return 'No comparable resolved session in your history yet. Read-only drill-down only. '
        + `(n_failed=${nFailed}, n_resolved=${nResolved})`;
  }
}

function buildCoverageNote(all: RunDigest[]): string {
  const total = all.length;
  const withFiles = all.filter((d) => d.filesChanged.length > 0).length;
  const withCost = all.filter((d) => d.cost != null).length;
  const withLoops = all.filter((d) => d.editLoops.length > 0).length;
  return `Coverage across ${total} sessions: filesChanged ${withFiles}/${total}, `
    + `cost ${withCost}/${total}, editLoops ${withLoops}/${total}. `
    + 'Change-shaped evidence only — no diff stored (privacy invariant).';
}

interface FinalizeArgs {
  fingerprint: string; failingDigests: RunDigest[]; subSignature: string; tier: RemedyTier;
  ruleMatches: RemedyRule[]; resolvedSiblings: ResolvedSibling[];
  nFailed: number; nResolved: number; coverageNote: string; maxExcerpt: number;
}
function finalize(a: FinalizeArgs): RemedyResult {
  const guardrail = guardrailFor(a.tier, a.nFailed, a.nResolved);
  const markdown = buildRemedyMarkdown(a, guardrail);
  return {
    fingerprint: a.fingerprint, failingDigests: a.failingDigests, subSignature: a.subSignature,
    tier: a.tier, ruleMatches: a.ruleMatches, resolvedSiblings: a.resolvedSiblings,
    guardrail, coverageNote: a.coverageNote, nFailed: a.nFailed, nResolved: a.nResolved, markdown,
  };
}

function emptyResult(raw: string, all: RunDigest[]): RemedyResult {
  const coverageNote = buildCoverageNote(all);
  const guardrail = guardrailFor('none', 0, 0);
  return {
    fingerprint: raw, failingDigests: [], subSignature: '', tier: 'none',
    ruleMatches: [], resolvedSiblings: [], guardrail, coverageNote, nFailed: 0, nResolved: 0,
    markdown: `# Remedy ${raw}\n\nNo sessions matched this fingerprint. `
      + 'Try `aladeen report` to list available fingerprints.\n\n' + guardrail + '\n',
  };
}

// Markdown render reuses replay.ts section vocabulary. Tier badge first; guardrail last; the
// change-shaped block labels coverage honestly and never emits a diff.
function buildRemedyMarkdown(a: FinalizeArgs, guardrail: string): string {
  const L: string[] = [];
  L.push(`# Remedy ${a.fingerprint}`, '');
  L.push(`**Tier:** ${a.tier.toUpperCase()}  ·  n_failed=${a.nFailed}  ·  n_resolved=${a.nResolved}`, '');
  const sample = a.failingDigests[0];
  if (sample) {
    L.push('## Failing shape');
    L.push(`- **Agent CLI:** ${sample.agentCliName}`);
    L.push(`- **Outcome:** ${sample.outcome}`);
    L.push(`- **Sub-signature:** \`${a.subSignature || '(none — no classified errors)'}\``, '');
  }
  if (a.ruleMatches.length > 0) {
    L.push('## Known fix');
    for (const r of a.ruleMatches) {
      L.push(`**${r.headline}**`, '', r.remedyText, '');
      for (const c of r.citations) L.push(`- \`${c.file}:${c.lines}\` — ${c.what}`);
      L.push('');
    }
  } else if (a.resolvedSiblings.length > 0) {
    L.push(`## Prior resolved sessions (${a.resolvedSiblings.length} of n=${a.nResolved})`, '');
    for (const s of a.resolvedSiblings) {
      L.push(`### \`${s.sessionId}\``);
      if (s.ask) L.push(`- ask: ${s.ask}`);
      L.push(`- shared error classes: ${s.sharedErrorClasses.join(', ') || '—'}`);
      L.push(`- tools: ${s.sharedTools.join(', ') || '—'}`);
      if (!s.hasFileTelemetry || s.changeShaped.length === 0) {
        L.push('- _no file telemetry for this session_'); // never blank-implying-clean
      } else {
        L.push('- change-shaped evidence (files + line counts; no diff stored — privacy invariant):');
        for (const f of s.changeShaped) {
          const act = f.action ? `${f.action} ` : '';
          const adds = f.linesAdded != null ? ` +${f.linesAdded}` : '';
          const dels = f.linesRemoved != null ? ` -${f.linesRemoved}` : '';
          L.push(`  - ${act}\`${f.path}\`${adds}${dels}`);
        }
      }
      L.push('');
    }
  } else {
    L.push('## No remedy', '');
    L.push('No comparable resolved session in your history yet. Read-only drill-down only.', '');
  }
  L.push(`> ${guardrail}`, '', `_${a.coverageNote}_`);
  return L.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
```

#### Honest acknowledgement to embed as a code comment in `remedy.ts` (mustFix: scope honesty)

Add this comment above `suggestRemedy`:

```
// HONEST CALIBRATION NOTE (read before trusting tiers):
//   - On the current 199-session store, `worktree_collision` is the only LIVE known-fix
//     (2 sessions: 0bf55f47…, 2fcd8f35…). `lint_loop` is NEVER emitted by any ingester today
//     (0/199) — its rule is armed but only fires once a loop-detecting ingester populates the
//     class AND editLoops are present. Synthetic tests exercise it; live data does not.
//   - The evidence tier (medium/low) became reachable ONLY after relaxing the resolved gate to
//     `outcome==='completed'` (dropping toolFailureCount===0). Under the original gate it was
//     dead code. MEDIUM remains rare; LOW and NONE are the common outcomes. The README under-
//     promises this deliberately (advertises known-fix / low / none, not medium).
```

---

### (a) THE KNOWN-REMEDY REGISTRY (data shipped in v1)

| id | matchErrorClass | extra gate | headline (shape, not diagnosis) | citation (primary anchor = symbol) |
|---|---|---|---|---|
| `worktree_collision` | `worktree_collision` | none (failure outcome only) | "known bug: a git worktree without its deps" | `src/blueprints/implement-feature.ts` — `bootstrap-deps` node (≈88-99) |
| `lint_loop` | `lint_loop` | `editLoops.length > 0` | "lint/typecheck gate re-edited the same file repeatedly (edit loop)" | `src/blueprints/implement-feature.ts` — `maxTotalRetries` (≈64), `fix-lint maxRetries` (≈157); `src/engine/verifiers/lint.ts` — `LintVerifier autoFix` (≈24-34, available, NOT wired into this blueprint) |

NON-GOAL: no third rule, no predicate DSL, no `minOccurrences`/`loopPair` tuples in v1.

---

### (a) MCP TOOL + DASHBOARD CARD CONTRACT

#### MCP tool `suggest_remedy` (in `src/mcp/server.ts`, registered after `replay_fingerprint`)

```typescript
server.registerTool(
  'suggest_remedy',
  {
    title: 'Suggest a remedy for a failure-pattern fingerprint',
    description:
      'Returns a read-only remedy suggestion for a failing pattern: a known-fix pointer when the '
      + 'shape is a solved bug in this repo\'s own engine, otherwise the prior sessions that hit '
      + 'the same (agent + error) shape and later completed — their ask, tools, and change-shaped '
      + 'file evidence. Confidence is an honest tier (known-fix / medium / low / none) and every '
      + 'result prints its denominators. It SUGGESTS a remedy; it NEVER executes or launches an '
      + 'agent. Acting on a remedy is the calling agent\'s or human\'s decision.',
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
      structuredContent: {
        fingerprint: result.fingerprint,
        tier: result.tier,
        ruleCount: result.ruleMatches.length,
        resolvedSampleCount: result.resolvedSiblings.length,
      },
      isError: result.failingDigests.length === 0,
    };
  },
);
```

Also append ONE sentence to the server `instructions` block (server.ts:45-51):
"Use suggest_remedy(fp) for an actionable read-only remedy; it suggests, never executes."

Import at top of server.ts: `import { suggestRemedy } from '../observability/remedy.js';`

#### Dashboard route `GET /api/remedy/:fp` (in `src/dashboard/server.ts`, after the /api/replay block)

```typescript
if (pathname.startsWith('/api/remedy/')) {
  const fp = pathname.slice('/api/remedy/'.length);
  const r = await suggestRemedy(fp, ctx.storage, { maxResolvedSamples: 3 });
  sendJson(res, r.failingDigests.length > 0 ? 200 : 404, {
    fingerprint: r.fingerprint,
    subSignature: r.subSignature,
    tier: r.tier,
    guardrail: r.guardrail,
    coverageNote: r.coverageNote,
    ruleMatches: r.ruleMatches,
    resolvedSiblings: r.resolvedSiblings,
    nFailed: r.nFailed,
    nResolved: r.nResolved,
    markdown: r.markdown,
  });
  return;
}
```

Import at top: `import { suggestRemedy } from '../observability/remedy.js';`
`/api/replay/:fp` stays byte-for-byte unchanged.

#### Dashboard card — `app.js` (LOCKED field names match `remedy.ts` exactly)

mustFix RESOLVED: the original two slices disagreed on field names (`headline`/`remedyText` vs
`title`/`text`; `tools`/`filesTouched` vs `sharedTools`/`changeShaped`). **The CORE module's names
win.** `app.js` reads: `rm.headline`, `rm.remedyText`, `rm.citations[].what`, `s.sharedTools`,
`s.changeShaped[]`, `s.hasFileTelemetry`, `s.ask`. The badge labels:

```javascript
// FIX(badge/guardrail agreement): medium badge is 'LEAD', NOT 'LIKELY'. No badge word may carry
// more confidence than the templated guardrail. Only known-fix asserts a fix.
const TIER_LABEL = { 'known-fix': 'KNOWN FIX', medium: 'LEAD', low: 'THIN', none: 'NONE' };

function renderRemedyCard(r, fp) {   // pure string builder; no fetch, no state mutation
  const lines = [];
  const badge = `<span class="remedy-badge tier-${r.tier}">${TIER_LABEL[r.tier]}</span>`;
  lines.push(`<div class="line prompt">&gt; REMEDY · ${esc(fp.slice(0,12))} ${badge}`
    + `  [n_failed=${r.nFailed} · n_resolved=${r.nResolved}]</div>`);
  lines.push(`<div class="line remedy-guardrail">${esc(r.guardrail)}</div>`); // verbatim, never edited

  if (r.tier === 'known-fix' && r.ruleMatches.length) {
    const rm = r.ruleMatches[0];
    lines.push(`<div class="line"><span class="meta">KNOWN FIX: </span>`
      + `<span class="ask">${esc(rm.headline)} ${esc(rm.remedyText)}</span></div>`);
    const cites = (rm.citations || []).map((c) => `${esc(c.file)}:${esc(c.lines)} (${esc(c.what)})`).join(' · ');
    if (cites) lines.push(`<div class="line meta">EVIDENCE: ${cites}</div>`);
  }

  if (r.tier === 'medium' || r.tier === 'low') {       // verb discipline: never emit 'fix' here
    for (const s of (r.resolvedSiblings || [])) {       // already capped at 3 upstream
      if (s.ask) lines.push(`<div class="line"><span class="meta">ASK: </span>`
        + `<span class="ask">${esc(s.ask)}</span></div>`);
      if (s.sharedTools && s.sharedTools.length)
        lines.push(`<div class="line meta">DID: ${esc(s.sharedTools.join(' → '))}</div>`);
      if (s.hasFileTelemetry && s.changeShaped && s.changeShaped.length) {
        const files = s.changeShaped.slice(0,4).map((f) => {
          const d = (f.linesAdded != null || f.linesRemoved != null)
            ? ` (+${f.linesAdded ?? 0}/-${f.linesRemoved ?? 0})` : '';
          return `${esc(basename(f.path))}${esc(d)}`;
        }).join(' · ');
        lines.push(`<div class="line meta change-shaped">`
          + `FILES (change-shaped, no diff stored): ${files}</div>`);
      } else {
        lines.push(`<div class="line meta change-shaped">no file telemetry for this session</div>`);
      }
    }
  }

  lines.push(`<div class="line meta">${esc(r.coverageNote)}</div>`);
  // RAW DRILL-DOWN reuses the EXISTING delegated [data-replay-open] listener -> openReplayModal.
  lines.push(`<div class="line"><a class="raw-link" data-replay-open="${esc(fp)}" `
    + `role="button" tabindex="0">RAW DRILL-DOWN ↗</a></div>`);
  return lines.join('');
}
```

`interfaceQuery(fp)` tail (replaces the `parseReplay`/`/api/replay` block at app.js:484-500):

```javascript
let r;
try { r = await fetch(`/api/remedy/${encodeURIComponent(fp)}`).then((x) => x.json()); }
catch (e) { pane.innerHTML += `<div class="line fail">remedy error: ${esc(String(e))}</div>`; return; }
const bucket = (state.data.fingerprints || []).find((f) => f.fp === fp);
pane.innerHTML =
  `<div class="line prompt">&gt; PATTERN ${esc(fp.slice(0,12))}</div>` +
  `<div class="line meta">DECODED: ${esc(bucket?.label || '—')}</div>` +
  renderRemedyCard(r, fp);
```

Delete `parseReplay` (now unused for the card; `openReplayModal` still hits the untouched
`/api/replay`). The string `REPLAY THIS FIX` must not appear anywhere in app.js after this change.

---

## DELIVERABLE (b) — README TENSE SPLIT

The README at `N:\Aladeen\README.md` has ALREADY been partially edited (name line, tagline,
Actionable replay section, `suggest_remedy` bullet, Status, Known limits). But it **overclaims per
the corrected engineering reality** and must be reconciled. Apply these exact edits:

1. **Tagline (line 5)** — keep as-is: `Observability layer for agent CLIs, with a learning layer
   landing on top.` (Honest: "landing", not "delivered".)

2. **Intro paragraph (line 7)** — soften the matcher claim. Replace
   `A **learning layer** — matching a failing pattern to the prior sessions that resolved the same
   shape — is actively landing on top of that`
   with:
   `A **learning layer** is landing on top of that: for a failing pattern, Aladeen surfaces a
   read-only remedy — a known-fix pointer when the shape is a solved bug in this repo's own engine,
   and (as your history grows) the prior sessions that hit the same shape and later completed.`

3. **Actionable replay section (lines 71-77)** — fix the lint_loop overclaim and the
   "completed cleanly" wording. Replace the body so it reads:
   - First paragraph: keep the worktree_collision known-fix example. For the lint example, replace
     "the `lint ⇄ fix-lint` loop → bounded retry" with
     "a lint/typecheck **edit loop** → bounded retry, `maxTotalRetries` in the same blueprint
     (the linter's `--fix` capability in `src/engine/verifiers/lint.ts` is available but not wired
     into this blueprint)".
   - Replace "later completed cleanly" with "later completed" (we relaxed the gate; a resolving
     session may have hit errors mid-run).
   - Confidence-tier line: keep **known-fix / low / none** as the advertised tiers (do NOT advertise
     medium — it is rare). Keep the "none is the common, expected answer" sentence.
   - Add one honest sentence: "Today the only live known-fix on a typical store is
     `worktree_collision`; the `lint_loop` rule is armed but only fires once a session is classified
     with an actual edit loop."

4. **`suggest_remedy` MCP bullet (line 53)** — keep, but change "prior resolved sessions of the
   same shape" to "prior sessions of the same shape that later completed". Keep "suggests, never
   executes".

5. **Status (line 135)** — keep the line but make the scope honest:
   `Learning layer / actionable replay (suggest_remedy, worktree_collision known-fix + tiered
   evidence): landing — read-only suggestions only, no auto-execution. The evidence tier returns
   `none` for most buckets on small stores (expected). See [Known limits](#known-limits).`

6. **Known limits (lines 149-150)** — keep both bullets. They are honest. Adjust the first to name
   the live reality: "...the only high-confidence suggestion today is the rule-encoded
   **`worktree_collision`** known fix; the `lint_loop` rule is armed but not yet emitted by any
   ingester on real data."

7. **DO NOT touch** the delivered observability bullets (lines 61-65), Design invariants,
   Architecture, "Why it exists". **DO NOT** bump Node 20+ to Node 24 (CUT). The delivered
   observability claims (ingest/report/fingerprint buckets/edit-loops/tool rollup/read-only MCP)
   stay unhedged.

Citations in prose name symbols (`bootstrap-deps`, `maxTotalRetries`), not line numbers (they rot).

---

## DELIVERABLE (c) — NAME ONE-LINER

Already present at README.md line 3 and it is correct. Keep verbatim:

```
_Named after the all-purpose word from_ The Dictator _— it means both "positive" and "negative" at once. Fitting for a tool whose whole job is sorting agent sessions into exactly those two piles._
```

No invented acronym; honest *The Dictator* reference tying "positive AND negative" to the
success/failure classifier. Placement: directly under the H1.

---

## FILE PLAN

| Path | Action | Purpose |
|---|---|---|
| `src/observability/remedy.ts` | create | Core engine: `suggestRemedy`, `REMEDY_RULES`, `subSignature`, types. Pure; I/O via injected storage only. |
| `src/observability/remedy.test.ts` | create | Unit tests over synthetic digests (Test Plan below). |
| `src/observability/replay.ts` | edit | Add `export` to `matchFingerprint` (line 71). Zero behavior change. |
| `src/mcp/server.ts` | edit | Register `suggest_remedy` after `replay_fingerprint`; import `suggestRemedy`; add 1 instructions sentence. |
| `src/mcp/server.test.ts` | edit | Extend with suggest_remedy tool tests. |
| `src/dashboard/server.ts` | edit | Add `GET /api/remedy/:fp` after `/api/replay/` block; import `suggestRemedy`. |
| `src/dashboard/server.test.ts` | edit | Extend with /api/remedy tests + /api/replay regression snapshot. |
| `src/dashboard/web/app.js` | edit | Add `renderRemedyCard`, rewrite `interfaceQuery` tail, remove `REPLAY THIS FIX` button + `parseReplay` reliance. |
| `README.md` | edit | Reconcile (b) tense-split + lint_loop honesty; (c) name line already correct. |

---

## ACCEPTANCE CRITERIA

(a) `suggestRemedy('0bf55f47', storage)` (live worktree_collision) returns `tier === 'known-fix'`,
    `ruleMatches[0].id === 'worktree_collision'`, markdown contains "install dependencies inside the
    git worktree" and citation `src/blueprints/implement-feature.ts:88-99`.

(a) `suggestRemedy` on a failing fingerprint whose subSignature is empty (live `claude-code|·`,
    `codex|·` gave_up buckets) returns `tier === 'none'`, `resolvedSiblings.length === 0`, and the
    literal sentence "No comparable resolved session in your history yet. Read-only drill-down only."
    It does NOT surface same-CLI completed sessions.

(a) `suggestRemedy` on a non-empty-signature failing fingerprint with zero completed siblings on the
    subSignature returns `tier === 'none'` and prints `n_failed=X` and `n_resolved=0`. `running`
    sessions are excluded from the resolved pool.

(a) `lint_loop` rule does NOT fire on a failing digest that carries the class but has
    `editLoops.length === 0` (synthetic). It fires only with the class AND `editLoops.length > 0`.

(a) The known-fix rule does NOT fire on a `completed` bucket carrying `worktree_collision`
    (gated on `isFailureOutcome(outcome)`).

(a) Evidence tier is reachable: a synthetic `completed` digest with the same subSignature as a
    failing bucket yields `tier === 'low'` (n=1) or `tier === 'medium'` (n>=3), `resolvedSiblings`
    capped at 3, ranked by errorClass-overlap then deterministic id tiebreak.

(a) MCP `suggest_remedy` is registered alongside the two read-only tools, returns
    `{ content:[{type:'text',text}], structuredContent:{fingerprint,tier,ruleCount,resolvedSampleCount} }`,
    `isError === (failingDigests.length===0)`. Description contains "suggests" and "never executes".
    No `child_process`/`spawn`/`net` import is reachable from `remedy.ts` (static assertion).

(a) `GET /api/remedy/:fp` returns structured JSON (200 when bucket exists, else 404).
    `GET /api/replay/:fp` is byte-for-byte unchanged (snapshot assertion on keys
    `{fingerprint, matchCount, markdown}`). Non-GET to `/api/remedy/` returns 405 (inherited gate).

(a) `app.js` contains no occurrence of "REPLAY THIS FIX". The card renders a tier badge
    (`KNOWN FIX`/`LEAD`/`THIN`/`NONE`) + the tier-bound guardrail; the `RAW DRILL-DOWN` link opens
    the old read-only markdown modal via the existing `openReplayModal`.

(a) No medium/low card output contains "fix"/"will fix"/imperative "do this"; "fix" appears only in
    the known-fix path and in the literal phrase "not a fix". Asserted via regex over the four tier
    fixtures.

(a) `coverageNote` and every change-shaped block are derived from live storage counts; a sibling
    with empty file telemetry renders "no file telemetry for this session", never blank. No output
    contains file content or a synthesized diff (no ```` ```diff ````, no `+++/---`).

(b) README intro + Actionable replay + Status + Known limits read the matcher as roadmap and name
    `worktree_collision` as the only live known-fix; `lint_loop` scoped as "armed, not yet live".
    Delivered observability bullets (lines 61-65) unchanged. `grep -i "replay this fix"` over the
    repo returns 0 matches.

(c) README has the one-line name gloss under the H1 tying "Aladeen" to *The Dictator*'s word
    (positive AND negative) and the success/failure classifier — no invented acronym.

Build + tests: `tsc --noEmit` passes; `remedy.test.ts` passes; existing replay/MCP/dashboard tests
still pass.

---

## EXPLICIT NON-GOALS (CUT — do not build)

- No auto-execution of any agent/blueprint. Aladeen suggests; a human or MCP agent acts.
- No weighted similarity score (`0.50*errorJaccard + 0.20*toolCosine + 0.15*fileOverlap +
  0.15*askSim`), no tunable weight consts, no sparse-feature renormalization, no
  tool_error/unknown down-weight multiplier. Ranking is plain errorClass-overlap then deterministic
  id tiebreak.
- No `askSim`/lazy-top-15 pass; no "fix-after-error precedes last file_change" seq-ordering bump.
- No ML, no embeddings, no learned ranking.
- No third REMEDY_RULES entry; no predicate DSL / `minOccurrences` / `loopPair` tuples.
- No schema change, no new RunDigest/SessionTrace fields, no new ingester.
- No new runtime dependency. node:http + Zod + MCP SDK only; client stays buildless vanilla ESM.
- No synthesized patch/diff. Only action + path + linesAdded/linesRemoved + contentSha256, labelled
  "change-shaped evidence (no diff stored — privacy invariant)".
- No fabricated percentage confidence. Tier is the 4-value enum with denominators printed.
- No "COPY FOR AGENT" clipboard button, no chip-color theming spec, no anomaly-banner rewiring
  beyond reusing the existing routing, no 6-row pixel layout.
- README does NOT advertise the `medium` tier (rare) and does NOT bump Node 20+ to Node 24.
- Do not deflate delivered observability claims (ingest/report/fingerprint buckets/edit-loops/tool
  rollup/read-only MCP tools+resources).

---

## TEST PLAN

`src/observability/remedy.test.ts` (synthetic digests, no fs):

1. worktree_collision known-fix: failing `{agentCliName:'aladeen', outcome:'gave_up',
   errorCounts.worktree_collision>0}` → `tier==='known-fix'`, `ruleMatches[0].id==='worktree_collision'`,
   markdown contains "install dependencies inside the git worktree" and
   "src/blueprints/implement-feature.ts:88-99".
2. lint_loop fires ONLY with loop evidence: `{outcome:'errored', errorCounts.lint_loop>0,
   editLoops:[{path,editCount:5}]}` → `tier==='known-fix'`. Same digest with `editLoops:[]` →
   does NOT fire (falls through to evidence/none).
3. rule does NOT fire on completed bucket: `{outcome:'completed', worktree_collision>0}` →
   `bucketIsFailure` false → not known-fix.
4. empty sub-signature suppression: failing bucket with all `errorCounts===0` → `subSignature===''`
   → `tier==='none'`, guardrail contains "No comparable resolved session in your history yet.
   Read-only drill-down only." (assert as SUBSTRING — there is a trailing denominator parenthetical).
   `resolvedSiblings.length===0`; no same-CLI completed session surfaced.
5. no resolved sibling on non-empty signature: `{parse_error>0}` failing with zero completed
   subSignature siblings → `tier==='none'`, markdown contains "n_failed=" and "n_resolved=0".
6. running is NOT a resolution: the only same-subSignature candidate has `outcome:'running'` →
   excluded → `nResolved===0` → `tier==='none'`.
7. LOW tier reachable (post-gate-relaxation): exactly 1 `completed` digest with the SAME
   subSignature as the failing bucket → `tier==='low'`, `resolvedSiblings.length===1`, guardrail
   contains "Weak signal" and "n=1".
8. MEDIUM tier: >=3 such completed siblings → `tier==='medium'`, capped at 3, guardrail contains
   the actual n and the phrase "lead, not a fix".
9. ranking by overlap then deterministic tiebreak: two siblings — the one sharing MORE error
   classes sorts first; assert tiebreak is sessionId-desc (NOT described as recency anywhere).
10. change-shaped evidence, no diff: a sibling whose trace has file_change events → markdown shows
    "create `path` +N -M" and the literal "no diff stored — privacy invariant"; assert markdown
    contains no ```` ```diff ````, no `+++`/`---`, no file content.
11. empty file telemetry sibling: resolved sibling with `filesChanged:[]` and no file_change events
    → markdown shows "no file telemetry for this session", not a blank/clean-implying line.
12. banned-word verb discipline: for tier low AND medium, the rendered markdown must NOT contain
    "will fix" or imperative "do this"; "fix" appears only inside "not a fix".
13. coverageNote live-derived: N digests where K have filesChanged → coverageNote contains
    "filesChanged K/N".
14. no-bucket input: `suggestRemedy('does-not-exist', storage)` → `failingDigests===[]`,
    `tier==='none'`, markdown contains "No sessions matched this fingerprint".
15. purity / non-spawn: static assertion that `remedy.ts` imports only `./storage.js`,
    `./session-trace.js` (types) and `./replay.js` (matchFingerprint) — no `node:child_process`,
    `node:fs`, `spawn`, or network module.

`src/mcp/server.test.ts` (extend; inject synthetic IngestStorage):

16. worktree_collision fp → `structuredContent.tier==='known-fix'`, `ruleCount>=1`, non-empty
    `content[0].text`, `isError===false`.
17. empty-subSignature fp → `tier==='none'`, `resolvedSampleCount===0`, `isError===false`.
18. unknown fp → `isError===true`.
19. tool description contains "suggests" AND "never executes".

`src/dashboard/server.test.ts` (extend; 127.0.0.1:0 with synthetic storage):

20. `GET /api/remedy/<wc-fp>` → 200, `body.tier==='known-fix'`, `body.ruleMatches.length>=1`,
    body has `subSignature/guardrail/coverageNote/markdown/nFailed/nResolved`.
21. `GET /api/remedy/<empty-sig-fp>` → 200, `body.tier==='none'`, `body.nResolved===0`,
    `body.guardrail` CONTAINS "No comparable resolved session in your history yet. Read-only
    drill-down only." (substring, not equality — trailing denominators).
22. `GET /api/remedy/<no-such-fp>` → 404.
23. REGRESSION: `GET /api/replay/<fp>` body keys === `{fingerprint, matchCount, markdown}` and
    value unchanged from before this change.
24. `POST /api/remedy/..` → 405.

`app.js` card (string-snapshot, extract `renderRemedyCard` as testable if a harness exists; else
snapshot the four tier fixtures):

25. "REPLAY THIS FIX" never appears in any output.
26. medium/low output never contains word-boundary "fix" except inside "not a fix".
27. known-fix output contains "KNOWN FIX" and "implement-feature.ts".
28. every output contains "n_failed=" and "n_resolved=".
29. sibling with `hasFileTelemetry===false` renders "no file telemetry for this session", not an
    empty FILES row.
30. no output renders a contentSha256 as if it were file content; FILES line carries "no diff
    stored".

Manual smoke (acceptance, not automated): `aladeen dashboard` against the live 199-session store →
click the worktree_collision row → KNOWN FIX badge + bootstrap-deps citation; click a
`claude-code|·` gave_up row → NONE badge + suppression sentence + working RAW DRILL-DOWN. Confirm
"REPLAY THIS FIX" appears nowhere in the DOM. MCP smoke: call `suggest_remedy` via the registered
aladeen MCP server; confirm text + structuredContent and no new process/socket.

---

## OPEN RISKS

- **Evidence tier quality is bounded by a coarse classifier.** The classifier mostly defaults to
  `tool_error` (README known-limit). A subSignature that is only `tool_error` over-matches. v1 does
  NOT down-weight it (CUT), so low/medium cards keyed on `tool_error` alone are weak — the guardrail
  ("a lead, not a fix") and printed denominators are the only mitigation. Acceptable for v1; revisit
  when the classifier improves.
- **The gate relaxation (drop `toolFailureCount===0`) admits survivorship.** A completed session may
  have completed DESPITE the shared error, not by resolving it. v1 surfaces it as a "lead" only and
  never claims causation on the evidence path. The CUT seq-ordering verification bump would mitigate
  this later.
- **lint_loop is dead on live data (0/199).** Shipping the rule is fine (synthetic-tested,
  future-proof) provided the README scopes it as "armed, not yet live" — locked above.
- **Citation line numbers will rot** when implement-feature.ts / lint.ts change. Mitigation: the
  durable anchor is the named node/symbol in `RemedyCitation.what`; lines are best-effort. A future
  maintainer edit to those files does not break correctness, only the line hint.
