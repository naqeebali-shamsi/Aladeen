# ALADEEN // FLIGHT RECORDER — Dashboard Screens

> **Concept:** MU-TH-UR 6000 // ALADEEN INTERFACE — amber Nostromo phosphor base,
> WOPR/Starfleet verdict-spine, GRIDRUNNER hi-score power-law.
> **Mood:** Alone with the machine at 0300. It already knows what broke.
> **Delivery:** `aladeen dashboard` → localhost web app on `127.0.0.1`. 100% local. Reads the
> same on-disk `.aladeen/ingested/` JSON the CLI reads. Never touches the network with user data.

---

## 0. Reading this document

Every widget below is bound to **EXACT** fields from `src/observability/session-trace.ts`. Two
shapes matter:

- **`RunDigest`** (`RunDigestSchema`, session-trace.ts:228-258) — the lossy, query-friendly
  projection the dashboard renders from. Served as `/api/digests.json`. Fields:
  `sessionId`, `agentCliName`, `outcome`, `durationMs`, `activeDurationMs`, `toolUsage`
  (`Record<string, number>`), `errorCounts` (`Record<ErrorClass, number>`), `filesChanged`
  (`string[]`), `toolFailureCount`, `editLoops` (`{ path, editCount }[]`), `cost`,
  `patternFingerprint` (16-hex, sha256, **one-way** — see digest.ts:154).
- **`SessionTrace`** (`SessionTraceSchema`, session-trace.ts:197-224) — the full event stream,
  loaded on demand per session for the TRACE screen via `/api/trace/:id`. Key fields:
  `events[]` (discriminated union, session-trace.ts:162-172), `agentCli.name`, `workspace`,
  `outcome`, `cost`, `scrubbing`.

**Derivation contract (NON-NEGOTIABLE):** every hero number is computed from `listDigests()`
(`storage.ts:51`) at render time. **Zero literals.** When the worktree bug is re-ingested as
fixed, the board must honestly relax from ANOMALY → DEGRADED → NOMINAL with no code change. The
numbers in the wireframes below are the **current** computed values from the user's 199 digests
and exist only to show what the board renders today.

**`patternFingerprint` is one-way.** Per `digest.ts:132-155` the fingerprint is
`sha256(agentCli.name | outcome | top-3 errorClasses sorted | failure-rate-bucket | loops-flag).slice(0,16)`.
You **cannot** reverse it to a label. Every human-readable `{AGENT}·{OUTCOME}·{topError}` label is
read off a **sample digest** in the bucket (`bucket[0].agentCliName`, `bucket[0].outcome`,
`topEntries(bucket[0].errorCounts, 1)`), exactly as `report.ts:60-66` already does.

**Derived helpers the dashboard needs (net-new, design-owned):**

```
deriveSystemStatus(digests): 'NOMINAL' | 'DEGRADED' | 'ANOMALY'
  ANOMALY  if ∃ digest where max(values(errorCounts)) > 100        // a single session ran away
  DEGRADED if toolFailingSessions / total > 0.25                   // tool-level pain is endemic
           where toolFailingSessions = digests.filter(d => d.toolFailureCount > 0).length
  NOMINAL  otherwise
  // Current data: 107/199 (53.8%) tool-failing AND a 2267-collision session → ANOMALY (degrades to DEGRADED post-fix).

logWidth(n, max): 40 + 320 * log10(n+1) / log10(max+1)   // px. The ONE chart primitive (Starfleet graft).
                                                          // A colored <div> whose width IS the magnitude. No chart lib.
```

---

## Global chrome (present on every screen)

- **Cassette-futurism bezel** — beige `.bezel` chassis (border-radius 22px, inset rim shadow)
  framing the amber screen. Signals "your local hardware, your disk."
- **Masthead** — `ALADEEN // FLIGHT RECORDER` in Orbitron, with a live **last-ingest timestamp**
  read from the newest digest file mtime, and a **[⟳ RE-SCAN]** control (re-fetches
  `/api/digests.json`; cheapest correct live-reload — no fs.watch, no poll).
- **Rotary channel selector** (top-right): `[01 BRIDGE] [02 PATTERNS] [03 TRACE]`.
- **Always-on glyph legend strip** — the long-tail error glyphs (parse/permission/binary) are not
  self-evident, so the key is permanent: `● completed · ○ gave_up · ▲ errored · ⟳ running · ⚠ anomaly`
  and the error-class glyphs (`⟳ worktree · ⚠ tool · ≠ parse · ⏱ timeout · ⚿ auth · ⌀ binary · ⇊ rate · ⊘ perm · ⚡ net`).
- **Footer status line** — `CRT-FX [ON] · MOTION [reduce] · 100% LOCAL · 127.0.0.1 · v0.1.0`.
  Both CRT-FX and MOTION persist to `localStorage`.

**A11y / motion invariants (apply everywhere):**
- Steady state is **STATIC** (scanlines ≤6%, vignette ≤10%, same-hue glow, zero movement). If it
  moves, it is data. Number widgets never animate.
- Reduced-motion is the baseline that always works; animation is the enhancement. Under
  `prefers-reduced-motion` the anomaly klaxon collapses to **static red text** — never disappears.
- Never color alone: every status carries glyph **shape** + text label (4-channel encoding).
- Amber `#FFB000` on `#0A0700` ≈ 9.6:1 (AAA); dim `#C77800` held ≥4.5:1, validated
  **post-composite** (after scanline + vignette + glow layers).
- One reserved alarm motion: a single 1.0s opacity 1→0.4 pulse at ≤1Hz on the `#CC0000` PRIORITY
  ONE ring, fired only when the ANOMALY rule trips. No radar sweep, no V-hold roll.

---

# SCREEN 00 — BOOT HANDSHAKE

**Purpose:** Announce the anomaly **before the grid renders**, in-character, so a 3am operator
knows what is on fire in under 2.2 seconds.

**Widget / type:** Full-screen black, single block caret, VT323 type-on log tied to **real load
milestones** (each line prints as its `/api/*` promise resolves — not faked timing).

**Real data shown (computed from `listDigests()`):**
- `199 SESSIONS` = `digests.length`
- `4 CLI LINKS` = `new Set(digests.map(d => d.agentCliName)).size`
- `FINGERPRINTS 42` = `new Set(digests.map(d => d.patternFingerprint)).size`
- The WARN line = `sum(d.errorCounts.worktree_collision)` across digests = **4197**, and the count
  of runaway sessions where `max(values(d.errorCounts)) > 100` = **2**.

**5-second read:** "Something called `worktree_collision` happened 4197 times. Two sessions. That
is the priority."

**Progressive disclosure:** Skippable (any key / click). Replayed **once per browser session** via
`sessionStorage`. **Hard-gated behind `prefers-reduced-motion`** — reduced users skip straight to
the static BRIDGE with the warning already visible (no flicker, no caret).

```
████████████████████████████████████████████████████████████████████████████
█                                                                            █
█  FLIGHT RECORDER 2037 READY                                                █
█  MOUNTING .aladeen/ingested .......... OK                                  █
█  199 SESSIONS                                                              █
█  4 CLI LINKS  [codex · claude-code · opencode · aladeen]                   █
█  FINGERPRINTS 42                                                           █
█                                                                            █
█  ⚠ PRIORITY ONE — worktree_collision x4197  (2 runaway sessions)          █  ← amber WARN, pre-render
█  _                                                                         █  ← block caret, 530ms steps(1)
█                                                                            █
█                                          [ press any key to skip ]         █
████████████████████████████████████████████████████████████████████████████
```

---

# SCREEN 01 — BRIDGE (Mission Control)

**Purpose:** The single mission-control read. One glance answers: *is a runaway loop burning my
agents, and what is the one thing on fire?* ~60% negative space when nominal. Verdict-first,
alarm-by-exception (WOPR spine graft).

**Responsive floor:** min-height responsive 12-col grid, 13px dense-cell floor (never below AA).
Controlled vertical scroll allowed below the fold on 1366×768 + browser chrome. No fixed-viewport
clipping.

## 01.A — PRIORITY ONE BANNER (anomaly hero)

- **Field binding:** `errorCounts.worktree_collision` summed across all digests = **4197**; the two
  runaway sessions surfaced by `max(values(d.errorCounts)) > 100` are
  **`aladeen:b9428fa6` x2267** (the larger) and **`aladeen:690cbbfe` x1930**. Duration contrast from
  the same digest: `durationMs` (wall) vs `activeDurationMs` (active).
- **Type:** Full-width band, `height:0` when nominal → inflates to 64px `#CC0000` on ANOMALY (Lumon
  inflate graft). Shows **BOTH** runaways: count + sum. Dual-arc gauge: ghost wall-clock arc behind
  solid active arc, teaching the wall-vs-active caveat visually.
- **5-second read:** "A runaway loop fired 4197 collisions across 2 sessions. The worst attempted
  2267 times over 48.8 days of wall-clock but only ~2 minutes of actual work."
- **Drill-down:** `[INSPECT TRACE →]` → SCREEN 03 for `b9428fa6`. `[⟳ REPLAY]` → SCREEN 02 with that
  bucket's fingerprint pre-interfaced.
- **Motion:** the one reserved 1.0s opacity 1→0.4 pulse on the `#CC0000` hairline ring, ≤1Hz, ANOMALY only.

## 01.B — STATUS RETICLE (verdict)

- **Field binding:** `deriveSystemStatus(digests)`. Subtext = `toolFailingSessions/total` where
  `toolFailingSessions = digests.filter(d => d.toolFailureCount > 0).length`.
- **Type:** 280px circular amber ring, center verdict text. **Static** (number widget never animates).
- **Real data:** opens **DEGRADED** (107/199 = 53.8% tool-failing > 0.25 threshold), escalating to
  **ANOMALY** because a session exceeds 100 of one error class.
- **5-second read:** "Sessions mostly 'complete', but more than half carry tool-level failure. Not green."
- **Drill-down:** click → expands the rule that fired ("DEGRADED: 107/199 > 25%" + "ANOMALY: b9428fa6 wt_collision 2267 > 100").
- **Note:** deliberately suppresses the 189/199 "completed" vanity count — it would under-alarm.

## 01.C — 4 CLI LINK TILES

- **Field binding:** `agentCliName` distribution. `countBy(digests.map(d => d.agentCliName))`.
- **Type:** 4 Cobb Semiotic-Standard monochrome pictogram tiles, VT323 count + tiny per-CLI outcome
  sparkline (`outcome` distribution within that CLI's digests).
- **Real data:** codex **139** / claude-code **40** / opencode **12** / aladeen **8**.
- **5-second read:** "codex dominates the corpus; aladeen's own runs are few but that's where the runaway lives."
- **Drill-down:** click a tile → SCREEN 02 filtered to that `agentCliName`.

## 01.D — FLEET VITALS (idiot-lights) + tool-failure gauge

- **Field binding:** `outcome` distribution (`completed`/`gave_up`/`errored`/`running` from
  `SESSION_OUTCOMES`, session-trace.ts:177-185) + contrarian KPI `toolFailingSessions/total`.
- **Type:** 4 glyph LEDs (`● ○ ▲ ⟳`) with VT323 counts + a half-gauge for the tool-failure ratio.
- **Real data:** completed **189 ●** / gave_up **8 ○** / errored **1 ▲** / running **1 ⟳**;
  TOOL-LEVEL FAILURES **107/199 → 53.8%**.
- **5-second read:** "Outcomes look healthy; the tool-failure gauge says otherwise. Trust the gauge."
- **Drill-down:** `gave_up 8` click → SCREEN 02 filtered to `outcome=gave_up` (includes both runaways).

## 01.E — CENTRAL CONSOLE (power-law spectrum + INTERFACE reply pane)

- **Field binding:** `patternFingerprint` buckets. Bucket = group digests by `patternFingerprint`;
  bucket sizes give the power-law `45, 25, 21, 11, 10, 8, 7, 7, 6, 5, … (22 singletons)`.
- **Type:** the `logWidth(bucketSize, maxBucket)` color-block primitive, one row per fingerprint,
  glyph + count. The hero panel. Beneath it, the INTERFACE reply pane (initially empty).
- **5-second read:** "A handful of failure shapes dominate; a long tail of one-offs."
- **Drill-down:** this is the **signature INTERFACE interaction** — see SCREEN 02. Selecting a row
  here types the reply into this pane in place (no nav).

## 01.F — ERROR-CLASS LOG BARS

- **Field binding:** `errorCounts` summed across all digests (`Record<ErrorClass, number>`,
  session-trace.ts:242).
- **Type:** horizontal `log10` bars (the `logWidth` primitive), one per nonzero `ErrorClass`, VT323
  raw-count overlay, Cobb glyph per class. `worktree_collision` clipped with a zig-zag axis-break +
  `4197 ▲` overflow badge so the smaller classes stay legible.
- **Real data:** worktree_collision **4197** / tool_error **1505** / parse_error **161** / timeout
  **147** / auth **75** / binary_not_found **39** / rate_limit **15** / permission_denied **14** /
  network **4**.
- **5-second read:** "worktree_collision dwarfs everything; tool_error is the real recurring pain."
- **Drill-down:** caption `⌞ ~1930 of 4197 = 1 anomaly session ⌟`. Click a class → SCREEN 02 filtered.
- **Fallback (if zig-zag eats cycles):** pure log10 bars + `4197 ▲` badge + the explicit caption.

## 01.G — LOOP DETECTOR card

- **Field binding:** `toolUsage` totals for the deterministic-loop pair. Rule:
  `|a-b| / max(a,b) < 0.05 AND both > 100` over `toolUsage` totals → `lint` vs `fix-lint`.
- **Type:** two interlocked counter-rotating `⟳` glyphs + ratio bar.
- **Real data:** `lint 4199 ⇄ fix-lint 4196 (99.9%)`, seen across **2 sessions**.
- **5-second read:** "lint and fix-lint call each other in a near-perfect 1:1 — a deterministic retry loop."
- **Drill-down:** tooltip cites the known bug (MEMORY.md: bounded-retry). Click → SCREEN 03 for the loop session.

## 01.H — ACTIVE-TIME HISTOGRAM

- **Field binding:** `activeDurationMs` (session-trace.ts:238) — **never** `durationMs` (wall-clock).
- **Type:** log-decade-binned horizontal bars (`<1s, 1-10s, 10s-1m, 1-10m, 10m-1h, 1-4h`) with p50/p90
  reticle markers + an **`ACTIVE · idle excluded`** badge.
- **Real data:** p50 ~3.5m, p90 ~53.5m (computed over the 199 `activeDurationMs` values).
- **5-second read:** "Most real work is minutes, not the days the wall-clock implies."

## 01.I — FILE HOTSPOTS

- **Field binding:** `filesChanged` (session-trace.ts:244, absolute Windows paths). Count by
  **basename**; full path on hover only.
- **Type:** top-8 horizontal basename bars + a `⚠ SPARSE 145 refs / 199` honest-coverage chip.
- **Real data:** index.ts 7 / types.ts 6 / cli.tsx 5 / runner.ts 4 / …
- **5-second read:** "Edits cluster in a few hot files, but file telemetry is sparse — don't over-read it."
- **Drill-down:** basename hover → full `N:\Aladeen\src\...` path.

## 01.J — OUTCOMES status strip

- **Field binding:** `outcome` for all 199 digests, rendered as a 100%-stacked strip.
- **Type:** 199-tile single-row strip, one glyph per session (`● ○ ▲ ⟳`).
- **5-second read:** "199 sessions, a thin band of non-completed at the tail."
- **Drill-down:** hover a tile → `sessionId` + outcome; click → SCREEN 03.

```
+==========================================================================================+
| ::: cassette-futurism beige bezel — your local hardware, your disk, never the network ::: |
| +--------------------------------------------------------------------------------------+ |
| | ⚠ PRIORITY ONE · RUNAWAY LOOP · worktree_collision 4197 across 2 sessions             | |  ← height:0 nominal → 64px #CC0000
| |   b9428fa6 x2267   690cbbfe x1930   · ACTIVE 2m00s / WALL 48.8d (idle)  [INSPECT →][⟳]| |     1.0s pulse, ANOMALY only
| +--------------------------------------------------------------------------------------+ |
| ALADEEN // FLIGHT RECORDER       last-ingest 2026-05-29 [⟳ RE-SCAN]   (01)BRIDGE 02 03   |
| +-----------------------+  +----------------------------+  +---------------------------+ |
| | ⌜      STATUS      ⌝  |  | ⌜   CLI INTERFACE LINKS ⌝  |  | ⌜     FLEET VITALS     ⌝  | |
| |     .-''''''-.        |  |  [▤] codex       139 ▁▂▁▃  |  |  ● COMPLETED       189   | |
| |   /  DEGRADED  \      |  |  [◫] claude-code  40 ▁▁▂   |  |  ○ GAVE_UP           8   | |  ← ○ slow-blink
| |  | →ANOMALY⚠   |      |  |  [◧] opencode     12 ▁     |  |  ▲ ERRORED           1   | |
| |   \  107/199  /       |  |  [◩] aladeen       8 ▁▔    |  |  ⟳ RUNNING           1   | |
| |     '-......-'        |  |                            |  | ------------------------- | |
| | tool-fail signal hi   |  |  4 LINKS NOMINAL           |  | TOOL-LEVEL FAILURES       | |
| | ⌞ wt_collision x4197⌟ |  | ⌞                        ⌟ |  | 107/199 [▮▮▮▮▮▯▯▯▯] 53.8%  | |
| +-----------------------+  +----------------------------+  +---------------------------+ |
| +--------------------------------------------------+  +------------------------------+ |
| | ⌜ CONSOLE // FINGERPRINT POWER-LAW (42)      ⌝   |  | ⌜ ERROR CLASS · LOG10 ·   ⌝  | |
| | CODEX·CLEAN·45x      ████████████████████  45    |  | ⟳ worktree_collisn ▓▓▓/\4197 | |  ← /\ axis-break
| | CLAUDE·CLEAN·25x     ███████████████       25    |  | ⚠ tool_error       ▓▓▓▓ 1505 | |
| | CODEX·tool_error·21x ██████████████        21    |  | ≠ parse_error      ▓▓▓   161 | |
| | CODEX·timeout·11x    █████████             11    |  | ⏱ timeout          ▓▓▓   147 | |
| | CODEX·to+auth·10x    ████████              10    |  | ⚿ auth             ▓▓     75 | |
| | ... recurring ↑ ──────────────────────────────  |  | ⌀ binary_not_found ▓▓     39 | |
| | LONG TAIL — 22 shapes seen once   [+ expand] 22  |  | ⇊ rate_limit       ▓      15 | |
| | ------------------------------------------------ |  | ⊘ permission_denied▓      14 | |
| | > INTERFACING WITH PATTERN 2fcd8f35█             |  | ⚡ network          ▏      4  | |
| | ⌞ arrow=rove  enter=query  ⟳=replay          ⌟   |  | ⌞ ~1930 of 4197 = 1 anomaly⌟ | |
| +--------------------------------------------------+  +------------------------------+ |
| +---------------------------+ +-------------------------+ +---------------------------+ |
| | ⌜ ACTIVE TIME · idle excl⌝| | ⌜ FILE HOTSPOTS       ⌝ | | ⌜  LOOP DETECTOR      ⌝   | |
| | <1s   ▓▓                  | | index.ts    ▓▓▓▓▓▓▓ 7   | |    ⟳            ⟳         | |
| | 1-10s ▓▓▓                 | | types.ts    ▓▓▓▓▓▓  6   | |   lint   ⇄   fix-lint     | |
| | 10s-1m▓▓▓▓▓                | | cli.tsx     ▓▓▓▓▓   5   | |   4199   :   4196 (99.9%) | |
| | 1-10m ▓▓▓▓▓▓▓▓ p50=3.5m   | | runner.ts   ▓▓▓▓    4   | |   deterministic retry     | |
| | 10m-1h▓▓▓▓▓▓ p90=53.5m    | | ⚠ SPARSE 145 refs/199   | |   loop · 2 sessions       | |
| | 1-4h  ▓▓                  | ⌞ basename; full path/hov⌟ | ⌞ known bug (MEMORY.md)  ⌟ | |
| +---------------------------+ +-------------------------+ +---------------------------+ |
| +--------------------------------------------------------------------------------------+ |
| | OUTCOMES [●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●○○○○○○○○▲⟳] 199 SES | |
| +--------------------------------------------------------------------------------------+ |
| ⌞ CRT-FX [ON] · MOTION [reduce] · 100% LOCAL · 127.0.0.1 · scanlines 6% · v0.1.0       ⌟ |
+==========================================================================================+
```

---

# SCREEN 02 — PATTERNS (42-fingerprint power-law)

**Purpose:** The spine of the product's learning value. Browse the failure shapes, recess the
success buckets, fold the long tail, and — the core loop — **query a fingerprint and get the
known-good replay fix**. GRIDRUNNER hi-score table, re-skinned amber, no arcade copy.

## 02.A — POWER-LAW SPECTRUM (hi-score rows)

- **Field binding:** `patternFingerprint` buckets (grouped digests). Each row's label is read from a
  **sample digest** in the bucket — `{agentCliName} · {outcome} · {topError}` where topError =
  `topEntries(bucket[0].errorCounts, 1)` (exactly the report.ts:60-66 pattern). The 16-hex
  `patternFingerprint` is demoted to a 10px IBM Plex Mono **copy-key**, never a headline (it is
  one-way; it is not the label).
- **Type:** descending `logWidth(bucketSize, maxBucket)` color-block rows. Per-error glyph. tnum digits.
- **Real data:** 42 distinct fingerprints; bucket sizes `45, 25, 21, 11, 10, 8, 7, 7, 6, 5, …`;
  **22 singletons**.
- **5-second read:** "These five shapes are most of my failures. Here's the one to fix first."
- **Progressive disclosure / drill-down:**
  - **`SHOW NOMINAL (n)`** toggle recesses success-head buckets (clean completions) in dim `#C77800`
    so failure shapes dominate.
  - **1px dashed RECURRING / ONE-OFF boundary** at the `count=2` line.
  - **`LONG TAIL — 22 shapes seen once`** folds into one expandable row.
  - **Selecting a row → the INTERFACE type-on** (02.B).

## 02.B — INTERFACE REPLY PANE (the signature interaction)

- **Behavior:** clicking/Enter on a row types `INTERFACING WITH PATTERN <hex>…` with a blinking
  caret into the reply pane, then reveals the decoded label + the cross-session aggregate, then the
  lone **HOT amber → white** `⟳ REPLAY` button. This is the in-character "ask the ship's computer"
  gesture — theme + progressive disclosure + the product's core loop in one.
- **Field binding (the reply body IS `replay.ts` output):** the aggregate rows are literally what
  `buildReplayMarkdown` (replay.ts:86-221) already produces:
  - **Shape** — `agentCliName`, `outcome`, matching-session count (replay.ts:99-103).
  - **Aggregates** — summed `activeDurationMs`, summed `cost.inputTokens/outputTokens` (n with cost
    data), `errorClassTotals` sorted (replay.ts:139-153).
  - **Tools used** — top-12 from summed `toolUsage` (replay.ts:157-166).
  - **Files touched** — top-20 from `filesChanged` touch-count (replay.ts:170-182).
  - **Per session** — for up to `maxDeepLoad` (10), the **`ask:`** (first `user_message.text`,
    truncated, replay.ts:201-205) and **`first failure:`** (first `tool_result` with `ok=false`,
    its `errorClass` + truncated `output`, replay.ts:207-213).
- **REPLAY wiring (open question, default safe):** `⟳ REPLAY` calls the existing MCP primitive
  `replay_fingerprint(fp)` server-side and renders the returned markdown. If backend wiring is
  deferred, it deep-links to the replay output instead — the UI must not promise more than the
  backend delivers.
- **5-second read:** "Last time this shape happened, here's exactly what was asked, what failed, and
  the run that fixed it."
- **CRITICAL motion fix:** instant-reveal on repeat queries / hold-to-skip, so the fiction never
  taxes a power user mid-forensics. Reduced-motion → instant full reveal, no caret.

## 02.C — Keyboard path

Roving `tabindex` over the (up to) 42 rows; arrow keys rove; Enter triggers the INTERFACE query; the
typed reply announced via `aria-live="polite"`. 2px focus ring at 2px offset in a hue distinct from
resting amber (cyan/sunflower) that survives reduced-motion.

```
+==========================================================================================+
| ALADEEN · 02 PATTERNS                                     [SHOW NOMINAL (3)]  01 (02) 03  |
| +--------------------------------------------------------------------------------------+ |
| | ⌜ FINGERPRINT POWER-LAW · 42 SHAPES · sorted by bucket size                       ⌝  | |
| |                                                                                      | |
| |  CODEX · CLEAN · 45x          ████████████████████████████████████  45  9e1c… [copy] | |
| |  CLAUDE-CODE · CLEAN · 25x    ████████████████████████████        25  4a07… [copy]   | |  ← nominal head (dim, toggle-recess)
| |  CODEX · completed · tool_err ██████████████████████████          21  2fcd… [copy]   | |
| |  CODEX · completed · timeout  ███████████████████                 11  7b31… [copy]   | |
| |  CODEX · completed · auth     █████████████████                   10  c5d9… [copy]   | |
| |  - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - RECURRING ↑   | |  ← 1px dashed @ count=2
| |  CLAUDE · gave_up · parse     ████████                            8   18ff… [copy]   | |     ONE-OFF ↓
| |  ALADEEN · gave_up · worktree ███████                             7   b942… [copy]   | |  ← the runaway bucket
| |  ...                                                                                 | |
| |  ▸ LONG TAIL — 22 shapes seen once                            [+ expand]   22        | |
| +--------------------------------------------------------------------------------------+ |
| +--------------------------------------------------------------------------------------+ |
| | ⌜ INTERFACE                                                                       ⌝  | |
| | > PATTERN 2fcd8f35a91b…                                                              | |
| |   DECODED: CODEX · completed · tool_error                                            | |
| | > REMEDY · 2fcd8f35a91b  [LEAD]   [n_failed=21 · n_resolved=21]                      | |  ← tier badge + denominators
| |   n=21 resolved session(s) shared this shape; a lead, not a fix — judge it yourself. | |  ← tier-bound guardrail (verbatim)
| |   Aladeen does not run anything.                                                     | |
| |   ASK: "fix the failing lint step in the deterministic executor and re-run…"         | |  ← prior resolved session's ask
| |   DID: shell_command → lint → fix-lint → apply_patch → Read                          | |  ← sharedTools
| |   FILES (change-shaped, no diff stored): runner.ts (+8/-2) · cli.tsx (+4/-0)         | |  ← path + line counts, never content
| |   Coverage across 199 sessions: filesChanged 22/199 · cost 51/199 · editLoops 7/199  | |  ← live coverageNote
| |                                                              RAW DRILL-DOWN ↗        | |  ← opens the read-only /api/replay modal
| | ⌞ arrow=rove · enter=interface · KNOWN FIX | LEAD | THIN | NONE · suggests, never runs ⌟| |
| +--------------------------------------------------------------------------------------+ |
| ⌞ 100% LOCAL · hex is a copy-key, not a label (sha256 one-way) · MOTION [reduce]       ⌟ |
+==========================================================================================+
```

---

# SCREEN 03 — TRACE (single-session forensic filmstrip)

**Purpose:** Answer *what shape did THIS failure take* in seconds. Leads with `activeDurationMs`;
wall-clock badged as idle-spanned. Reached from any drill-down (banner, outcome strip, loop card,
CLI tile, replay per-session row).

**Data source:** `/api/trace/:id` → full `SessionTrace` via `storage.loadTrace(sessionId)`.

## 03.A — EVENT FILMSTRIP

- **Field binding:** `trace.events[]` (`SessionEventSchema` union, session-trace.ts:162-172),
  ordered by `seq` (session-trace.ts:65 — ordering is `seq`, not timestamps; "clocks lie").
- **Type:** seq-ordered 24px glyph-tiles left-to-right, one per event:
  - `tool_call` → dim amber tile (`toolName`)
  - `tool_result` with `ok=true` → ok tile; `ok=false` → red tick (+ `errorClass`)
  - `error` → red `⚠` flag, 1.4× enlarged (`errorClass`, `fatal`)
  - `file_change` → file tile (`action`, basename of `path`)
- **5-second read:** "The failure is a wall of red ticks at the same `seq` band — that's where it ran away."
- **Drill-down:** hover a tile → event detail (`seq`, `toolName`/`errorClass`, truncated
  `output`/`message`); click a `tool_result.fail` → its paired `tool_call` highlighted via `callId`.

## 03.B — DURATION READOUT

- **Field binding:** `activeDurationMs` (big) + `durationMs` (small, badged) from the digest.
- **Type:** big amber `ACTIVE 2m00s` + small dim-red `wall 48.8d ⚠ idle-spanned`. Never wall alone.
- **5-second read:** "2 minutes of real work spread across 48 days of an open laptop."

## 03.C — HEADER EXTRACTS

- **Field binding:** reused **verbatim** from replay extraction:
  - **`ASK:`** = first `user_message.text` (replay.ts:201-205).
  - **`FIRST FAIL:`** = first `tool_result` with `ok=false` → `errorClass` + truncated `output`
    (replay.ts:207-213).
- **5-second read:** "Here's what was asked and the first thing that broke."

## 03.D — FILES TOUCHED

- **Field binding:** `file_change.path` events / digest `filesChanged`. Basenames only.
- **Type:** basename tiles. Full `N:\Aladeen\…` Windows path on **explicit click only** (paths are
  scrubbed home→~ but kept; never auto-expand).

## 03.E — EDIT-LOOP / OSCILLATION evidence

- **Field binding:** `editLoops` (`{ path, editCount }[]`, session-trace.ts:248-251) — present with
  value `0` in most sessions; loops detected in **7/199**. For `b9428fa6`, `editCount 1668` on a
  single file.
- **Type:** tiny ranked list with honest `7/199 INSTRUMENTED` caption. Supporting evidence, never the headline.
- **5-second read:** "This one session rewrote the same file 1668 times — the loop, made literal."

## 03.F — RAW-JSON PEEK

- **Field binding:** the full `SessionTrace` JSON from `/api/trace/:id`.
- **Type:** the **only modal** in the entire app. Scrubbing envelope (`scrubbing.passes`) shown at
  the top so the operator knows what was redacted.
- **5-second read (on demand):** "Show me the raw bytes — and confirm secrets were scrubbed."

```
+==========================================================================================+
| ALADEEN // FLIGHT RECORDER · 03 TRACE · aladeen:b9428fa6                  01 02 (03)      |
| +--------------------------------------------------------------------------------------+ |
| | ⌜ DURATION ⌝   ACTIVE 2m00s            wall 48.8d ⚠ idle-spanned                      | |
| | ⌜ ASK      ⌝   "set up worktree isolation for the implement-feature blueprint and…"  | |  ← replay.ts firstUser
| | ⌜ FIRST FAIL⌝  (worktree_collision) "fatal: '.aladeen/wt/hello' already exists…"      | |  ← replay.ts firstFail
| +--------------------------------------------------------------------------------------+ |
| +--------------------------------------------------------------------------------------+ |
| | ⌜ EVENT FILMSTRIP · seq-ordered ⌝                                                  ⌝ | |
| |  ▸call ✓ok ▸call ⚠✗ ⚠✗ ⚠✗ ⚠✗ ⚠✗ ⚠✗ ⚠✗ ⚠✗ ⚠✗ ⚠✗ ⚠✗ ⚠✗ ⚠✗ … (worktree_collision ×2267) | |  ← wall of red = the runaway
| |  ⌞ hover = seq + errorClass + output · click ✗ pairs its tool_call via callId      ⌟ | |
| +--------------------------------------------------------------------------------------+ |
| +----------------------------------+  +----------------------------------------------+ |
| | ⌜ FILES TOUCHED ⌝                 |  | ⌜ EDIT OSCILLATION · 7/199 INSTRUMENTED  ⌝   | |
| |  hello.ts   wt-manager.ts         |  |  hello.ts        editCount 1668              | |  ← editLoops
| |  ⌞ basename; full path on click ⌟ |  |  ⌞ supporting evidence, not the headline  ⌟  | |
| +----------------------------------+  +----------------------------------------------+ |
| ⌞ [{ } RAW JSON PEEK]  scrubbing: path-home, secret, shell-output  · 100% LOCAL        ⌟ |
+==========================================================================================+
```

---

## Server contract (for the implementer)

`aladeen dashboard` binds a `node:http` server to `127.0.0.1` (never `0.0.0.0`) serving:
- `GET /` → one static HTML shell + self-hosted woff2 (Orbitron, IBM Plex Mono, VT323 — no CDN).
- `GET /api/digests.json` → `await storage.listDigests()` (the full `RunDigest[]`).
- `GET /api/trace/:id` → `await storage.loadTrace(id)` (one `SessionTrace`), for SCREEN 03 + RAW PEEK.
- `POST /api/replay/:fp` (optional) → `replay_fingerprint(fp)` markdown, for the `⟳ REPLAY` button.

**Toolchain note (blocking, ~1 day):** `react-dom`, a bundler, and an HTTP server are all absent
from `package.json` today (react@19 is bound to Ink for the TUI). Recommendation: add **Vite as a
devDependency only** (never shipped) + the tiny `node:http` server above. Confirm
Vite-vs-buildless-import-map before pixel work.
