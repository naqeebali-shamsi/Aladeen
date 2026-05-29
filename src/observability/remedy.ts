import type { IngestStorage } from './storage.js';
import type {
  RunDigest, SessionTrace, SessionEvent, ErrorClass, SessionOutcome,
} from './session-trace.js';
import { matchFingerprint } from './replay.js';

// Actionable Replay — read-only remedy suggestions (the learning layer's first slice).
//
// Given a FAILING pattern fingerprint, return an honest remedy:
//   - a RULE-BASED known-fix pointer when the shape is a solved bug in this repo's own engine, or
//   - EVIDENCE-BASED prior sessions that hit the same (agent + error class) shape and later
//     COMPLETED — their ask, tools, and change-shaped file evidence.
// Confidence is a 4-tier enum (known-fix | medium | low | none); every result prints its
// denominators (nFailed, nResolved). Aladeen SUGGESTS; it never executes or launches an agent.
//
// Pure: I/O happens only through the injected IngestStorage (mirrors replay.ts). No fs, no
// child_process, no network — that is a load-bearing invariant, asserted by remedy.test.ts.
//
// Cross-fingerprint by necessity: patternFingerprint bakes in OUTCOME (digest.ts:132-155), so a
// failing bucket has zero `completed` siblings inside it. The join key is a sub-signature that
// drops outcome/failure-rate/loops and keeps only (agentCli + sorted nonzero error classes).

// HONEST CALIBRATION NOTE (read before trusting tiers):
//   - On the current 199-session store, `worktree_collision` is the only LIVE known-fix
//     (2 sessions: 0bf55f47…, 2fcd8f35…). `lint_loop` is NEVER emitted by any ingester today
//     (0/199) — its rule is armed but only fires once a loop-detecting ingester populates the
//     class AND editLoops are present. Synthetic tests exercise it; live data does not.
//   - The evidence tier (medium/low) became reachable ONLY after relaxing the resolved gate to
//     `outcome==='completed'` (dropping toolFailureCount===0). Under the original gate it was
//     dead code. MEDIUM remains rare; LOW and NONE are the common outcomes. The README under-
//     promises this deliberately (advertises known-fix / low / none, not medium).

export type RemedyTier = 'known-fix' | 'medium' | 'low' | 'none';

export interface RemedyCitation {
  file: string;   // repo-relative; PRIMARY anchor is the symbol/node named in `what`
  lines: string;  // best-effort range; WILL rot — treat `what` as the durable anchor
  what: string;   // names the node/symbol: 'bootstrap-deps node', 'maxTotalRetries', etc.
}

export interface RemedyRule {
  id: 'worktree_collision' | 'lint_loop';
  matchErrorClass: ErrorClass;
  // When set, the rule fires ONLY if it returns true for the failing sample (e.g. editLoops
  // present). Keeps `lint_loop` from asserting a loop the data never proves — a lone tsc failure
  // is classed lint_loop by the ingester regex.
  extraGate?: (sample: RunDigest) => boolean;
  headline: string;     // shape statement, NOT a per-session diagnosis
  remedyText: string;   // 'The known fix for this shape was …' (past tense, about the engine)
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

const FAILURE_OUTCOMES: readonly SessionOutcome[] = ['errored', 'interrupted', 'gave_up'];

// DATA-only registry. EXACTLY TWO entries in v1 (NON-GOAL to add more). The primary anchor for
// each citation is the named node/symbol in `what`; line numbers are best-effort and may rot.
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
      {
        file: 'src/blueprints/implement-feature.ts',
        lines: '88-99',
        what: "the 'bootstrap-deps' node runs the install command in the worktree before any gate",
      },
    ],
  },
  {
    id: 'lint_loop',
    matchErrorClass: 'lint_loop',
    // The lint_loop ErrorClass is produced by the ingester regex /lint|eslint|tsc.*error/ on ANY
    // failed lint/tsc output — it does NOT detect a loop. Gate on actual loop evidence so the rule
    // only fires when the session really looped.
    extraGate: (s) => s.editLoops.length > 0,
    headline:
      'This shape matches a lint/typecheck gate that re-edited the same file repeatedly '
      + '(an edit loop) in your own engine.',
    remedyText:
      'The known fix for this shape was to bound the deterministic fix/check retries so a '
      + 'lint -> fix-lint -> lint cycle cannot run unbounded. Confirm an actual loop occurred '
      + 'before acting.',
    citations: [
      { file: 'src/blueprints/implement-feature.ts', lines: '64', what: 'maxTotalRetries: 5 caps total retries across the loop' },
      { file: 'src/blueprints/implement-feature.ts', lines: '157', what: 'fix-lint node maxRetries: 1' },
      // The verifier exposes a --fix pass but implement-feature runs raw `tsc --noEmit`, not
      // LintVerifier. Cite as available capability, NOT as the fix that ran.
      { file: 'src/engine/verifiers/lint.ts', lines: '24-34', what: 'LintVerifier autoFix/--fix capability (available; not wired into implement-feature)' },
    ],
  },
];

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

// A RESOLVED sibling is any completed session that carries error semantics (non-empty
// subSignature). We deliberately do NOT also require toolFailureCount===0: digest.ts increments
// errorCounts on BOTH failed tool_results AND `error` events, so a genuinely resolved session can
// finish 'completed' yet still carry a non-empty subSignature — requiring zero tool failures would
// wrongly exclude those. 'running' is excluded (outcome !== 'completed'); failure outcomes excluded.
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

// Rank: errorClass-set overlap DESC, then a DETERMINISTIC id tiebreak. RunDigest has no startedAt
// and sessionIds are random — the tiebreak is deterministic but NOT chronological (never call it
// recency).
function rankSiblings(failingClasses: ErrorClass[], candidates: RunDigest[]): RunDigest[] {
  return [...candidates].sort((x, y) => {
    const ox = setIntersect(nonzeroErrorClasses(x), failingClasses).length;
    const oy = setIntersect(nonzeroErrorClasses(y), failingClasses).length;
    if (oy !== ox) return oy - ox;            // more shared classes first
    return y.sessionId.localeCompare(x.sessionId); // deterministic id-stable tiebreak (NOT recency)
  });
}

export async function suggestRemedy(
  rawFingerprint: string,
  storage: IngestStorage,
  opts: SuggestOptions = {},
): Promise<RemedyResult> {
  const maxSamples = Math.min(opts.maxResolvedSamples ?? 3, 3);
  const maxExcerpt = opts.maxExcerptChars ?? 200;

  const allDigests = await storage.listDigests();
  const failingDigests = matchFingerprint(rawFingerprint, allDigests);

  if (failingDigests.length === 0) return emptyResult(rawFingerprint, allDigests);

  const sample = failingDigests[0];           // all share the fp (and thus outcome) by construction
  const fingerprint = sample.patternFingerprint;
  const sig = subSignature(sample);
  const failingClasses = nonzeroErrorClasses(sample);
  const nFailed = failingDigests.length;
  const coverageNote = buildCoverageNote(allDigests);

  const failingBasenames = new Set(sample.filesChanged.map(basename));

  // TIER A: RULE-BASED known-fix. Fires only on a real failure bucket carrying the keyed class
  // AND passing the rule's extraGate (loop evidence for lint_loop).
  const bucketIsFailure = isFailureOutcome(sample.outcome);
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

  // GATE 0: a non-failing bucket (e.g. a directly-queried `completed` fingerprint) has nothing to
  // remediate. The evidence tier below keys only on sub-signature + resolved siblings, so without
  // this guard a completed bucket would surface a low/medium tier whose `n_failed=N` denominator
  // counts sessions that did NOT fail — dishonest. Mirror the known-fix guard; report zero failures.
  if (!bucketIsFailure) {
    return finalize({
      fingerprint, failingDigests, subSignature: sig, tier: 'none',
      ruleMatches: [], resolvedSiblings: [], nFailed: 0, nResolved: 0, coverageNote, maxExcerpt,
    });
  }

  // GATE 1: empty sub-signature => SUPPRESS (the codex|· / claude-code|· no-error-semantics trap).
  if (sig === '') {
    return finalize({
      fingerprint, failingDigests, subSignature: sig, tier: 'none',
      ruleMatches: [], resolvedSiblings: [], nFailed, nResolved: 0, coverageNote, maxExcerpt,
    });
  }

  // TIER B/C: EVIDENCE-BASED nearest-resolved on the sub-signature.
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

// Verb discipline: the evidence path BANS 'fix'/'will fix'/'do this'. The word 'fix' appears only
// on the known-fix tier and inside the literal phrase 'not a fix'.
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
    default:
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
