import type { IngestStorage } from './storage.js';
import type { RunDigest, SessionTrace } from './session-trace.js';
import { classifyUserMessageOrigin } from './ingest/_shared/classify-origin.js';

// Loop-candidate inference — read-only suggestions for what recurring work in the
// user's history could become a Claude Code automation:
//   - `/loop` (self-paced)   iterate-until-done / fix-until-clean (the Ralph loop)
//   - `/loop <interval>`     fixed-cadence polling of external state
//   - `/schedule`            periodic, time-anchored cloud routines
//   - `.claude/loop.md`      a standing maintenance check
//
// The signal is the FIRST HUMAN ask per session. That extraction only became
// reliable once provenance was tagged at ingest (user_message.origin, v0.5.0) —
// before that, injected env/skill/teammate blocks masqueraded as the opening
// ask. So this analyzer is a direct payoff of that work: it reads the origin tag
// (falling back to the shape classifier for legacy traces), clusters the real
// human asks across sessions, and scores each cluster's loop-fitness.
//
// Pure: I/O happens ONLY through the injected IngestStorage (mirrors remedy.ts /
// replay.ts). No fs, no child_process, no network. Aladeen SUGGESTS loops; it
// never creates or runs them — adopting one is the human's call. Cross-CLI by
// design: /loop is Claude-only, but recurring work in ANY ingested CLI (codex,
// opencode, …) is a candidate to automate AS a Claude Code loop.

export type LoopClass = 'recurring' | 'iterate';
export type LoopMechanism = 'loop-self-paced' | 'loop-interval' | 'schedule' | 'loop-md';
export type LoopSafety = 'read-only' | 'mutating';

export interface LoopCadence {
  spanDays: number;
  medianGapHours: number | null; // null when <2 timestamped sessions
  shape: 'burst' | 'periodic' | 'irregular' | 'unknown';
}

export interface IterateSignals {
  editLoopSessions: number;
  continuationSessions: number;
  thrashSessions: number;
}

export interface LoopCandidate {
  label: string;            // top salient tokens of the cluster
  class: LoopClass;
  mechanism: LoopMechanism;
  command: string;          // concrete suggestion derived from the user's own asks
  rationale: string;
  sessionCount: number;
  providers: string[];      // distinct agentCli names contributing
  safety: LoopSafety;
  cadence: LoopCadence;
  iterate: IterateSignals;
  sessionIds: string[];     // capped sample
  exemplars: string[];      // capped sample of real opener excerpts
}

export interface LoopReport {
  candidates: LoopCandidate[];
  sessionsScanned: number;
  humanAsksFound: number;
  noiseFiltered: number;    // Aladeen's own test/harness fixtures dropped
  guardrail: string;
  coverageNote: string;
  markdown: string;
}

export interface SuggestLoopsOptions {
  minSessions?: number;     // recurrence floor for a candidate (default 3)
  maxSamples?: number;      // session ids / exemplars per candidate (default 5)
  maxExcerptChars?: number; // exemplar truncation (default 140)
}

const DEFAULT_MIN_SESSIONS = 3;
const DEFAULT_MAX_SAMPLES = 5;
const DEFAULT_MAX_EXCERPT = 140;
const JACCARD_THRESHOLD = 0.5;
const TIGHT_BURST_HOURS = 0.5;      // median gap below this → iterate-until-done
const PERIODIC_MIN_HOURS = 12;      // schedule-able cadence band
const PERIODIC_MAX_HOURS = 24 * 10;
const PERIODIC_CV_MAX = 0.6;        // gap coefficient-of-variation for "regular"
const THRASH_MIN_RESULTS = 10;
const THRASH_RATE = 0.3;

// Tools that cannot mutate the workspace. A session is read-only iff every tool
// it used is in this set (or it used none). Conservative: anything else —
// including shell/bash (codex routes all writes through shell) — is mutating.
const READONLY_TOOLS = new Set([
  'read', 'grep', 'glob', 'ls', 'cat', 'view', 'webfetch', 'websearch',
  'web_search', 'notebookread', 'list', 'get', 'fetch', 'search', 'todoread',
]);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'its', 'as', 'at', 'by', 'from',
  'i', 'we', 'you', 'me', 'my', 'our', 'your', 'please', 'can', 'could', 'would',
  'should', 'do', 'does', 'did', 'so', 'if', 'then', 'now', 'let', 'lets',
  'want', 'need', 'make', 'use', 'using', 'all', 'any', 'some', 'into', 'out',
  'up', 'down', 'over', 'about', 'what', 'which', 'how', 'why', 'when', 'where',
  'will', 'have', 'has', 'had', 'not', 'no', 'yes', 'ok', 'okay', 'just', 'also',
]);

// Aladeen's own blueprint test/harness prompts — they recur but are not the
// user's manual workflow (they're agentic-node prompts Aladeen itself drove via
// opencode/codex/claude). Dropped from clustering, counted as noise. The
// load-bearing tells are store-template references ({{store.x}}, "in the store
// under", "lint.stderr") that only Aladeen's template resolution emits.
const NOISE_RE = [
  /create a file called hello\.txt/i,
  /you are working in .*\.aladeen[/\\]worktrees/i,
  /\bsmoke[- ]?test\b.*\bblueprint\b/i,
  /\{\{\s*store\./i,
  /\bin the store under\b/i,
  /\b(?:lint|test|build|typecheck)\.(?:stderr|stdout)\b/i,
];

// Terse continuation / acknowledgement openers — a nudge, not a task-defining
// ask. Excluded from cluster labels (they feed the iterate signal instead).
const CONTINUATION_RE =
  /^(continue|keep going|go on|go ahead|proceed|next|carry on|resume|again|more|yep|yeah|sure|do it|that works|sounds good|still (failing|broken|wrong)|try again|not done|keep)\b/i;

// Opener shapes that poll external state → fixed-interval loop fits.
const POLL_RE = /\b(check|poll|watch|monitor|until|wait for|is it (done|ready|finished)|finished|deploy(ed|ment)?|ci\b|pipeline|status|pending|merge[ds]?)\b/i;

// Standing maintenance gates → a `.claude/loop.md` check is the natural home.
const MAINTENANCE_RE = /\b(lint|linter|eslint|typecheck|tsc|type ?error|test|tests|vitest|build|format|prettier)\b/i;

interface SessionFacts {
  sessionId: string;
  provider: string;
  ask: string;
  tokens: Set<string>;
  startedMs: number | null;
  mutating: boolean;
  editLoop: boolean;
  thrash: boolean;
  continuation: boolean;
}

interface Cluster {
  signature: Set<string>;     // tokens of the first member (stable seed)
  members: SessionFacts[];
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9+#._-]*/g)) {
    const t = m[0];
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function wordCount(s: string): number {
  const m = s.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function firstHumanAsk(t: SessionTrace): string | undefined {
  for (const e of t.events) {
    if (e.kind !== 'user_message') continue;
    const origin = e.origin ?? classifyUserMessageOrigin(e.text);
    if (origin === 'human') return e.text.trim();
  }
  return undefined;
}

function hasContinuation(t: SessionTrace): boolean {
  let seenFirst = false;
  for (const e of t.events) {
    if (e.kind !== 'user_message') continue;
    const origin = e.origin ?? classifyUserMessageOrigin(e.text);
    if (origin !== 'human') continue;
    if (!seenFirst) { seenFirst = true; continue; }
    if (CONTINUATION_RE.test(e.text.trim())) return true;
  }
  return false;
}

function isReadOnly(d: RunDigest): boolean {
  const tools = Object.keys(d.toolUsage);
  if (d.filesChanged.length > 0) return false;
  return tools.every((t) => READONLY_TOOLS.has(t.toLowerCase()));
}

function isThrash(d: RunDigest): boolean {
  const results = Object.values(d.toolUsage).reduce((a, b) => a + b, 0);
  return results >= THRASH_MIN_RESULTS && d.toolFailureCount / results >= THRASH_RATE;
}

function cadenceOf(ms: number[]): LoopCadence {
  const sorted = ms.filter((x) => x != null).sort((a, b) => a - b);
  if (sorted.length < 2) {
    return { spanDays: 0, medianGapHours: null, shape: 'unknown' };
  }
  const spanDays = (sorted[sorted.length - 1] - sorted[0]) / 86_400_000;
  const gaps = sorted.slice(1).map((v, i) => v - sorted[i]);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGapHours = sortedGaps[Math.floor(sortedGaps.length / 2)] / 3_600_000;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : Infinity;
  let shape: LoopCadence['shape'];
  if (medianGapHours < TIGHT_BURST_HOURS) shape = 'burst';
  else if (cv <= PERIODIC_CV_MAX && medianGapHours >= PERIODIC_MIN_HOURS && medianGapHours <= PERIODIC_MAX_HOURS) shape = 'periodic';
  else shape = 'irregular';
  return { spanDays, medianGapHours, shape };
}

function humanInterval(hours: number): string {
  if (hours < 1) return `${Math.max(5, Math.round(hours * 60))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function cadenceWord(hours: number): string {
  if (hours <= 36) return 'daily';
  if (hours <= PERIODIC_MAX_HOURS) return 'weekly';
  return 'periodically';
}

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

// The representative ask for a cluster = the SHORTEST member ask (the cleanest
// "core" phrasing), single-lined and truncated. Honest: it is the user's own
// wording, not a fabricated command.
function coreAsk(members: SessionFacts[], maxExcerpt: number): string {
  const shortest = [...members].sort((a, b) => a.ask.length - b.ask.length)[0];
  return truncate(shortest.ask, Math.min(maxExcerpt, 80));
}

// Label = the cluster's cleanest core phrasing (the shortest member ask), not a
// bag of top tokens — descriptive and honest (the user's own words).
function labelOf(c: Cluster): string {
  return coreAsk(c.members, 64);
}

function classifyCluster(c: Cluster, cadence: LoopCadence, iterate: IterateSignals): LoopClass {
  const n = c.members.length;
  const iterativeMembers = Math.max(iterate.editLoopSessions, iterate.continuationSessions);
  if (cadence.shape === 'burst') return 'iterate';
  if (iterativeMembers >= Math.ceil(n / 2)) return 'iterate';
  return 'recurring';
}

function chooseMechanism(
  cls: LoopClass, label: string, exemplars: string[], cadence: LoopCadence,
): LoopMechanism {
  const text = `${label} ${exemplars.join(' ')}`;
  if (cls === 'iterate') {
    return MAINTENANCE_RE.test(text) ? 'loop-md' : 'loop-self-paced';
  }
  if (POLL_RE.test(text)) return 'loop-interval';
  if (cadence.shape === 'periodic') return 'schedule';
  return 'loop-self-paced';
}

function buildCommand(mech: LoopMechanism, core: string, cadence: LoopCadence): string {
  switch (mech) {
    case 'loop-interval': {
      const iv = cadence.medianGapHours != null ? humanInterval(cadence.medianGapHours) : '30m';
      return `/loop ${iv} ${core}`;
    }
    case 'schedule': {
      const word = cadence.medianGapHours != null ? cadenceWord(cadence.medianGapHours) : 'daily';
      return `/schedule ${core} (${word})`;
    }
    case 'loop-md':
      return `/loop ${core}   # or make it the standing check in .claude/loop.md`;
    case 'loop-self-paced':
    default:
      return `/loop ${core}`;
  }
}

function rationaleFor(
  mech: LoopMechanism, n: number, cadence: LoopCadence, safety: LoopSafety, iterate: IterateSignals,
): string {
  const gap = cadence.medianGapHours != null ? `~${humanInterval(cadence.medianGapHours)}` : 'no clock';
  let base: string;
  switch (mech) {
    case 'loop-md':
      base = `Recurs as a maintenance gate (${iterate.editLoopSessions} edit-loop / ${iterate.continuationSessions} hand-nudged of ${n}); if these were sequential fix-until-clean runs, a self-paced loop or .claude/loop.md check fits — confirm they weren't parallel fan-out first.`;
      break;
    case 'loop-self-paced':
      base = cadence.shape === 'burst'
        ? `Recurs in tight bursts (median gap ${gap}) — either rapid manual re-runs (→ a self-paced loop helps) or parallel fan-out (already concurrent, no loop needed); confirm which before adopting.`
        : `Recurs across ${n} sessions without a fixed cadence — start it as a self-paced loop.`;
      break;
    case 'loop-interval':
      base = `Polls external state across ${n} sessions (${gap}); a fixed-interval loop fits.`;
      break;
    case 'schedule':
    default:
      base = `Runs on a regular cadence (${gap}) across ${n} sessions — a cloud routine keeps it going unattended.`;
  }
  if (safety === 'mutating') {
    base += ' Mutating task — define a clear completion check before letting it loop.';
  }
  return base;
}

export async function suggestLoops(
  storage: IngestStorage,
  opts: SuggestLoopsOptions = {},
): Promise<LoopReport> {
  const minSessions = opts.minSessions ?? DEFAULT_MIN_SESSIONS;
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const maxExcerpt = opts.maxExcerptChars ?? DEFAULT_MAX_EXCERPT;

  const digests = await storage.listDigests();
  // Deterministic order so clustering is stable across runs.
  const ordered = [...digests].sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  const facts: SessionFacts[] = [];
  let noiseFiltered = 0;
  for (const d of ordered) {
    const trace = await storage.loadTrace(d.sessionId);
    if (!trace) continue;
    const ask = firstHumanAsk(trace);
    if (!ask) continue;
    if (NOISE_RE.some((re) => re.test(ask))) { noiseFiltered += 1; continue; }
    // Terse continuation openers are nudges, not task-defining asks.
    if (CONTINUATION_RE.test(ask) && wordCount(ask) <= 4) { noiseFiltered += 1; continue; }
    const tokens = tokenize(ask);
    if (tokens.size === 0) continue;
    const startedMs = parseMs(trace.startedAt ?? trace.endedAt);
    facts.push({
      sessionId: d.sessionId,
      provider: d.agentCliName,
      ask,
      tokens,
      startedMs,
      mutating: !isReadOnly(d),
      editLoop: d.editLoops.length > 0,
      thrash: isThrash(d),
      continuation: hasContinuation(trace),
    });
  }

  const clusters = clusterFacts(facts);
  const humanAsksFound = facts.length;

  const candidates: LoopCandidate[] = [];
  for (const c of clusters) {
    if (c.members.length < minSessions) continue;
    const cadence = cadenceOf(c.members.map((m) => m.startedMs).filter((x): x is number => x != null));
    const iterate: IterateSignals = {
      editLoopSessions: c.members.filter((m) => m.editLoop).length,
      continuationSessions: c.members.filter((m) => m.continuation).length,
      thrashSessions: c.members.filter((m) => m.thrash).length,
    };
    const safety: LoopSafety = c.members.some((m) => m.mutating) ? 'mutating' : 'read-only';
    const cls = classifyCluster(c, cadence, iterate);
    const exemplars = dedupeExemplars(c.members, maxSamples, maxExcerpt);
    const mechanism = chooseMechanism(cls, labelOf(c), exemplars, cadence);
    const core = coreAsk(c.members, maxExcerpt);
    candidates.push({
      label: labelOf(c),
      class: cls,
      mechanism,
      command: buildCommand(mechanism, core, cadence),
      rationale: rationaleFor(mechanism, c.members.length, cadence, safety, iterate),
      sessionCount: c.members.length,
      providers: [...new Set(c.members.map((m) => m.provider))].sort(),
      safety,
      cadence,
      iterate,
      sessionIds: c.members.slice(0, maxSamples).map((m) => m.sessionId),
      exemplars,
    });
  }

  // Rank: most-recurring first, then read-only (safer to loop), then label.
  candidates.sort((a, b) =>
    b.sessionCount - a.sessionCount
    || Number(a.safety === 'mutating') - Number(b.safety === 'mutating')
    || a.label.localeCompare(b.label));

  const guardrail =
    'Aladeen infers these from recurring shapes in your own session history — it suggests loop '
    + 'automations, it never creates or runs them. Review each before adopting; a mutating task '
    + 'needs a completion check before you let it loop.';
  const coverageNote =
    `Inferred from the first HUMAN ask of ${humanAsksFound}/${ordered.length} sessions `
    + `(origin-tagged; ${noiseFiltered} Aladeen test/harness fixtures filtered). Clustering groups `
    + 'near-identical asks, so a tight "burst" cadence may be parallel/retry fan-out rather than '
    + 'sequential repetition, and a periodic task phrased differently each time is under-counted. '
    + "File telemetry is partial — codex sessions don't emit file_change — so 'read-only' is "
    + 'best-effort. Nothing leaves your machine; nothing is executed.';

  return {
    candidates,
    sessionsScanned: ordered.length,
    humanAsksFound,
    noiseFiltered,
    guardrail,
    coverageNote,
    markdown: buildMarkdown(candidates, ordered.length, humanAsksFound, noiseFiltered, guardrail, coverageNote, minSessions),
  };
}

// Greedy single-pass clustering: assign each ask to the existing cluster with the
// highest token-Jaccard above threshold; else seed a new cluster. Deterministic
// given the sessionId-sorted input.
function clusterFacts(facts: SessionFacts[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const f of facts) {
    let best: Cluster | undefined;
    let bestScore = JACCARD_THRESHOLD;
    for (const c of clusters) {
      const score = jaccard(f.tokens, c.signature);
      if (score >= bestScore) { best = c; bestScore = score; }
    }
    if (best) {
      best.members.push(f);
    } else {
      clusters.push({ signature: f.tokens, members: [f] });
    }
  }
  return clusters;
}

function dedupeExemplars(members: SessionFacts[], cap: number, maxExcerpt: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    const ex = truncate(m.ask, maxExcerpt);
    const key = ex.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ex);
    if (out.length >= cap) break;
  }
  return out;
}

function parseMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

const MECH_LABEL: Record<LoopMechanism, string> = {
  'loop-self-paced': '/loop (self-paced)',
  'loop-interval': '/loop <interval>',
  'schedule': '/schedule (routine)',
  'loop-md': '.claude/loop.md',
};

function buildMarkdown(
  candidates: LoopCandidate[], scanned: number, humanAsks: number, noise: number,
  guardrail: string, coverageNote: string, minSessions: number,
): string {
  const L: string[] = [];
  L.push('# Loop candidates', '');
  L.push(`> ${guardrail}`, '');
  if (candidates.length === 0) {
    L.push(`No recurring workflow reached the ${minSessions}-session floor across ${humanAsks} human asks `
      + `(${scanned} sessions scanned, ${noise} fixtures filtered).`, '');
    L.push(`_${coverageNote}_`);
    return L.join('\n');
  }
  L.push(`Found **${candidates.length}** loop candidate(s) across ${humanAsks} human asks `
    + `(${scanned} sessions, ${noise} fixtures filtered):`, '');
  candidates.forEach((c, i) => {
    const cad = c.cadence.medianGapHours != null
      ? `span ${c.cadence.spanDays.toFixed(0)}d, median gap ${humanInterval(c.cadence.medianGapHours)} (${c.cadence.shape})`
      : 'single-occurrence timing (no clock)';
    L.push(`## ${i + 1}. ${c.label}  ·  ${c.class} → ${MECH_LABEL[c.mechanism]}`);
    L.push(`- **recurrence:** ${c.sessionCount} sessions · providers: ${c.providers.join(', ')}`);
    L.push(`- **cadence:** ${cad}`);
    L.push(`- **safety:** ${c.safety}`);
    L.push(`- **suggested:** \`${c.command}\``);
    L.push(`- **why:** ${c.rationale}`);
    L.push(`- **seen in:** ${c.sessionIds.join(', ')}${c.sessionCount > c.sessionIds.length ? ` (+${c.sessionCount - c.sessionIds.length} more)` : ''}`);
    for (const ex of c.exemplars) L.push(`  - _"${ex}"_`);
    L.push('');
  });
  L.push(`_${coverageNote}_`);
  return L.join('\n');
}
