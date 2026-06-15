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

// Where a candidate came from: an exact-ask cluster (near-identical phrasing,
// precise → /loop) or a coarse intent group (same KIND of task phrased
// differently across days, recurring → /schedule).
export type LoopSource = 'ask-cluster' | 'intent';

export interface LoopCandidate {
  label: string;            // the cluster's core ask, or the intent's name
  source: LoopSource;
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
  fanoutFiltered: number;   // concurrent ask-clusters excluded as parallel fan-out
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
// Fan-out discrimination: a cluster whose sessions ran concurrently (overlapping
// wall-clock spans) or were spawned near-simultaneously is parallel fan-out
// (e.g. /batch or subagents), already concurrent — NOT a sequential loop.
const NEAR_SIMULTANEOUS_MS = 60_000;       // median start gap below → programmatic spawn
const OVERLAP_FANOUT_RATIO = 0.5;          // ≥ this fraction of consecutive pairs overlap → fan-out
// Intent pass (recall): coarse grouping catches the same KIND of task phrased
// differently across days — the periodic /schedule signal token-clustering misses.
const MIN_INTENT_SESSIONS = 5;
const INTENT_MIN_SPAN_DAYS = 2;

// Coarse intent taxonomy. Each session's first ask may match several; a session
// joins every matching group. `poll` intents watch external state (→ interval).
const INTENTS: ReadonlyArray<{ key: string; label: string; re: RegExp; poll?: boolean }> = [
  { key: 'pr-review', label: 'review open pull requests', re: /\b(pull requests?|prs?|code review|review the (pr|changes)|babysit)\b/i },
  { key: 'tests', label: 'run the test suite', re: /\b(tests?|vitest|jest|specs?|test suite|coverage)\b/i },
  { key: 'lint', label: 'lint & typecheck', re: /\b(lint|linter|eslint|typecheck|tsc|type ?errors?)\b/i },
  { key: 'deploy-ci', label: 'check the deploy / CI', re: /\b(deploy(ed|ment)?|\bci\b|pipeline|build status)\b/i, poll: true },
  { key: 'docs', label: 'update docs / changelog', re: /\b(docs?|readme|changelog|documentation|\badr\b)\b/i },
  { key: 'plan-review', label: 'review the planning docs', re: /\b(plan\.md|\.planning|phase \d|roadmap|plan files?)\b/i },
  { key: 'triage', label: 'triage issues', re: /\b(issues?|backlog|triage|bug reports?)\b/i },
  { key: 'deps', label: 'audit dependencies', re: /\b(dependenc(y|ies)|packages?|npm audit|vulnerabilit|upgrade deps?)\b/i },
];

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
  intents: string[];
  startedMs: number | null;
  endedMs: number | null;
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

// Match intent against the ask's HEADLINE (first line, capped) — the task's
// subject lives up front, so an incidental keyword buried in a long ask doesn't
// trigger a false match. And an ask whose headline hits more than a couple of
// intents is generic boilerplate ("thoroughly explore the codebase…"), not a
// single recurring task — contribute it to none.
const MAX_INTENTS_PER_ASK = 2;
const HEADLINE_CHARS = 80;
function intentsOf(ask: string): string[] {
  const headline = ask.split('\n', 1)[0].slice(0, HEADLINE_CHARS);
  const hits = INTENTS.filter((i) => i.re.test(headline)).map((i) => i.key);
  return hits.length > MAX_INTENTS_PER_ASK ? [] : hits;
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

// Distinguish sequential repetition from parallel fan-out. A human re-running a
// task makes sessions that DON'T overlap in time; an agent harness (/batch,
// subagents, GSD) spawns them concurrently. Near-simultaneous starts or
// overlapping [start,end] spans ⇒ fan-out (already parallel, not a loop).
function concurrencyOf(members: SessionFacts[]): 'sequential' | 'fan-out' {
  const timed = members.filter((m) => m.startedMs != null);
  if (timed.length < 2) return 'sequential';
  const sorted = [...timed].sort((a, b) => (a.startedMs as number) - (b.startedMs as number));
  const gaps = sorted.slice(1).map((m, i) => (m.startedMs as number) - (sorted[i].startedMs as number));
  const medGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  if (medGap < NEAR_SIMULTANEOUS_MS) return 'fan-out';
  let overlaps = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].endedMs ?? (sorted[i - 1].startedMs as number);
    if ((sorted[i].startedMs as number) < prevEnd) overlaps += 1;
  }
  return overlaps / (sorted.length - 1) >= OVERLAP_FANOUT_RATIO ? 'fan-out' : 'sequential';
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

function intentRationale(label: string, n: number, cadence: LoopCadence, safety: LoopSafety): string {
  const gap = cadence.medianGapHours != null ? `~${humanInterval(cadence.medianGapHours)}` : 'no clock';
  let base = `${n} sessions over ${cadence.spanDays.toFixed(0)}d touch this kind of work `
    + `(median gap ${gap}, ${cadence.shape}), phrased differently each time — a recurring routine, not a one-off.`;
  if (safety === 'mutating') base += ' Mutating — gate it behind a clear check before scheduling.';
  return base;
}

// Shared aggregations over a member set (used by both the ask-cluster and the
// intent pass).
function startsOf(members: SessionFacts[]): number[] {
  return members.map((m) => m.startedMs).filter((x): x is number => x != null);
}
function providersOf(members: SessionFacts[]): string[] {
  return [...new Set(members.map((m) => m.provider))].sort();
}
function safetyOf(members: SessionFacts[]): LoopSafety {
  return members.some((m) => m.mutating) ? 'mutating' : 'read-only';
}
function iterateSignals(members: SessionFacts[]): IterateSignals {
  return {
    editLoopSessions: members.filter((m) => m.editLoop).length,
    continuationSessions: members.filter((m) => m.continuation).length,
    thrashSessions: members.filter((m) => m.thrash).length,
  };
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
    facts.push({
      sessionId: d.sessionId,
      provider: d.agentCliName,
      ask,
      tokens,
      intents: intentsOf(ask),
      startedMs: parseMs(trace.startedAt ?? trace.endedAt),
      endedMs: parseMs(trace.endedAt ?? trace.startedAt),
      mutating: !isReadOnly(d),
      editLoop: d.editLoops.length > 0,
      thrash: isThrash(d),
      continuation: hasContinuation(trace),
    });
  }

  const clusters = clusterFacts(facts);
  const humanAsksFound = facts.length;

  const candidates: LoopCandidate[] = [];
  let fanoutFiltered = 0;

  // Pass 1 — exact-ask clusters (near-identical phrasing) → /loop family.
  for (const c of clusters) {
    if (c.members.length < minSessions) continue;
    // A concurrent cluster is parallel fan-out (already running in parallel, e.g.
    // /batch or subagents), not a sequential loop to automate. Exclude; count it.
    if (concurrencyOf(c.members) === 'fan-out') { fanoutFiltered += 1; continue; }
    const cadence = cadenceOf(startsOf(c.members));
    const iterate = iterateSignals(c.members);
    const safety = safetyOf(c.members);
    const cls = classifyCluster(c, cadence, iterate);
    const exemplars = dedupeExemplars(c.members, maxSamples, maxExcerpt);
    const mechanism = chooseMechanism(cls, labelOf(c), exemplars, cadence);
    candidates.push({
      label: labelOf(c),
      source: 'ask-cluster',
      class: cls,
      mechanism,
      command: buildCommand(mechanism, coreAsk(c.members, maxExcerpt), cadence),
      rationale: rationaleFor(mechanism, c.members.length, cadence, safety, iterate),
      sessionCount: c.members.length,
      providers: providersOf(c.members),
      safety,
      cadence,
      iterate,
      sessionIds: c.members.slice(0, maxSamples).map((m) => m.sessionId),
      exemplars,
    });
  }

  // Pass 2 — coarse intent groups (the same KIND of task across days) → /schedule.
  // Complements pass 1: catches periodic recurrence that diverse phrasing hides.
  for (const intent of INTENTS) {
    const members = facts.filter((f) => f.intents.includes(intent.key));
    if (members.length < MIN_INTENT_SESSIONS) continue;
    const cadence = cadenceOf(startsOf(members));
    if (cadence.spanDays < INTENT_MIN_SPAN_DAYS) continue;  // must recur over time
    if (cadence.shape === 'burst') continue;                // bursts are pass 1's job
    const safety = safetyOf(members);
    const mechanism: LoopMechanism = intent.poll ? 'loop-interval' : 'schedule';
    const command = mechanism === 'loop-interval'
      ? `/loop ${cadence.medianGapHours != null ? humanInterval(cadence.medianGapHours) : '1h'} ${intent.label}`
      : `/schedule ${intent.label} (${cadence.medianGapHours != null ? cadenceWord(cadence.medianGapHours) : 'weekly'})`;
    candidates.push({
      label: `${intent.label} — recurring`,
      source: 'intent',
      class: 'recurring',
      mechanism,
      command,
      rationale: intentRationale(intent.label, members.length, cadence, safety),
      sessionCount: members.length,
      providers: providersOf(members),
      safety,
      cadence,
      iterate: iterateSignals(members),
      sessionIds: members.slice(0, maxSamples).map((m) => m.sessionId),
      exemplars: dedupeExemplars(members, maxSamples, maxExcerpt),
    });
  }

  // Rank: specific ask-clusters before coarse intents, then most-recurring,
  // then read-only (safer to loop), then label.
  const sourceRank = (s: LoopSource) => (s === 'ask-cluster' ? 0 : 1);
  candidates.sort((a, b) =>
    sourceRank(a.source) - sourceRank(b.source)
    || b.sessionCount - a.sessionCount
    || Number(a.safety === 'mutating') - Number(b.safety === 'mutating')
    || a.label.localeCompare(b.label));

  const guardrail =
    'Aladeen infers these from recurring shapes in your own session history — it suggests loop '
    + 'automations, it never creates or runs them. Review each before adopting; a mutating task '
    + 'needs a completion check before you let it loop.';
  const coverageNote =
    `Inferred from the first HUMAN ask of ${humanAsksFound}/${ordered.length} sessions `
    + `(origin-tagged; ${noiseFiltered} Aladeen fixtures + ${fanoutFiltered} parallel-fan-out burst(s) filtered). `
    + 'Two passes: exact-ask clusters (precise → /loop) and coarse intent groups (periodic → /schedule). '
    + "File telemetry is partial — codex sessions don't emit file_change — so 'read-only' is best-effort. "
    + 'Nothing leaves your machine; nothing is executed.';

  return {
    candidates,
    sessionsScanned: ordered.length,
    humanAsksFound,
    noiseFiltered,
    fanoutFiltered,
    guardrail,
    coverageNote,
    markdown: buildMarkdown(candidates, ordered.length, humanAsksFound, noiseFiltered, fanoutFiltered, guardrail, coverageNote, minSessions),
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

const SOURCE_TAG: Record<LoopSource, string> = { 'ask-cluster': 'ask', intent: 'intent' };

function buildMarkdown(
  candidates: LoopCandidate[], scanned: number, humanAsks: number, noise: number, fanout: number,
  guardrail: string, coverageNote: string, minSessions: number,
): string {
  const filtered = `${noise} fixtures, ${fanout} fan-out`;
  const L: string[] = [];
  L.push('# Loop candidates', '');
  L.push(`> ${guardrail}`, '');
  if (candidates.length === 0) {
    L.push(`No recurring workflow reached the ${minSessions}-session floor across ${humanAsks} human asks `
      + `(${scanned} sessions scanned; ${filtered} filtered).`, '');
    L.push(`_${coverageNote}_`);
    return L.join('\n');
  }
  L.push(`Found **${candidates.length}** loop candidate(s) across ${humanAsks} human asks `
    + `(${scanned} sessions; ${filtered} filtered):`, '');
  candidates.forEach((c, i) => {
    const cad = c.cadence.medianGapHours != null
      ? `span ${c.cadence.spanDays.toFixed(0)}d, median gap ${humanInterval(c.cadence.medianGapHours)} (${c.cadence.shape})`
      : 'single-occurrence timing (no clock)';
    L.push(`## ${i + 1}. ${c.label}  ·  [${SOURCE_TAG[c.source]}] ${c.class} → ${MECH_LABEL[c.mechanism]}`);
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
