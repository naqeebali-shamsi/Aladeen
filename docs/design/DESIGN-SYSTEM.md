# ALADEEN // FLIGHT RECORDER — Design System Contract

> **Status:** Implementable contract. Code from this directly.
> **Concept:** `MU-TH-UR 6000 // ALADEEN INTERFACE` — amber Nostromo phosphor base, WOPR/Starfleet verdict-spine, GRIDRUNNER hi-score power-law.
> **Surface:** Localhost web app (`aladeen dashboard`) served by a `node:http` server bound to `127.0.0.1` only, reading the same `.aladeen/ingested/digests/*.json` via `IngestStorage.listDigests()` / `loadTrace()`.
> **Mood:** Lonely, industrial, authoritative. A single amber phosphor terminal at 0300. **Calm by default, dread on alarm. Motion must mean something.**
> **Non-negotiables:** 100% local (no CDN, no network with user data, self-hosted fonts). Zero new runtime deps (Vite + uPlot are devDependencies only). Every number derived from `listDigests()` at render time — **zero hardcoded hero literals.**

This file is the single source of truth for tokens, type, components, motion, and a11y. Code references in it are verified against the repo (`src/observability/session-trace.ts`, `storage.ts`, `replay.ts`, `report.ts`).

---

## 1. Design Tokens (CSS Custom Properties)

All tokens live in `:root` in `src/dashboard/web/theme.css`. **Lint-ban raw color literals in JSX/CSS** — every color is a named token with a recorded contrast ratio in its comment. Contrast measured against `--bg #0A0700`, re-validated *after* the scanline + vignette + glow layers composite (a 6% scanline over `--bg` still leaves amber > 8:1).

### 1.1 Color

```css
:root {
  /* ---- Surfaces ---- */
  --bg:        #0A0700; /* warm near-black; NOT #000 (a hair of warmth sells the CRT) */
  --surface:   #15100A; /* panel fill */
  --recess:    #0F0B05; /* inset wells, drilldown panes */

  /* ---- Phosphor primary (amber) ---- */
  --primary:   #FFB000; /* 9.6:1 on --bg  → AAA. Default text + telemetry */
  --accent:    #FFC838; /* the single FOCUSED value; brighter amber */
  --dim:       #C77800; /* 4.6:1 on --bg  → AA. Secondary labels ONLY. */
                        /* NEVER dim further via opacity over the glow layer — silently fails AA. */

  /* ---- Status channel (color is ONE of 4 channels; see §6.3) ---- */
  --ok:        #33FF66; /* 13.8:1 → AAA. completed / healthy */
  --warn:      #FFCC66; /* gave_up / caution */
  --danger:    #CC0000; /* LCARS red (NEVER #FF0000). anomaly / errored. Reserved. */
  --running:   #54E6F0; /* 11.9:1 → AAA cyan. running state */

  /* ---- Focus ring (distinct hue from resting amber, survives reduced-motion) ---- */
  --focus:     #54E6F0; /* cyan, 11.9:1 on --bg */

  /* ---- Per-CLI identity (consistent hue across every panel; small-multiple discipline) ---- */
  --cli-codex:       #FFB000; /* dominant fleet → primary amber */
  --cli-claude-code: #FFC838;
  --cli-opencode:    #C77800;
  --cli-aladeen:     #54E6F0;

  /* ---- Replay CTA (the ONE warmer accent; in-canon HOT amber→white, NOT synthwave magenta→cyan) ---- */
  --replay-from: #FFB000;
  --replay-to:   #FFF4D6; /* hot-to-white; the lone gradient in the UI */

  /* ---- CRT ambience (separate non-interactive layer; auto-dims, see §5) ---- */
  --scan:      rgba(0,0,0,0.28); /* scanline darkening, capped ≤6% effective */
  --vignette:  rgba(0,0,0,0.55); /* corner falloff, capped ≤10% */
}
```

**Banned as body/table text:** `#B37400` (3.6:1, fails AA — large/UI 3:1 only), saturated `#00FF00`/`#FF0000` (bloom shimmer). Reserve any saturated pure hue for ≤1 hero glyph.

### 1.2 Type Scale (px; rem at 16px base)

| Token            | px / rem        | Family            | Use                                                        |
|------------------|-----------------|-------------------|------------------------------------------------------------|
| `--fs-odometer`  | 48 / 3.0        | VT323             | The single anomaly count-up. Qualifies as large text (3:1) |
| `--fs-verdict`   | 28 / 1.75       | Orbitron          | STATUS RETICLE hero verdict                                |
| `--fs-kpi`       | 18 / 1.125      | IBM Plex Mono     | KPI numbers (load-bearing)                                 |
| `--fs-header`    | 14 / 0.875      | Orbitron          | Section labels (`PRIORITY ONE`, `FLEET VITALS`)            |
| `--fs-body`      | 16 / 1.0        | IBM Plex Mono     | Body / default                                             |
| `--fs-label`     | 14 / 0.875      | IBM Plex Mono     | Condensed labels                                           |
| `--fs-dense`     | 13 / 0.8125     | IBM Plex Mono     | **Dense-cell FLOOR — never below.** 42-row table cells     |
| `--fs-caption`   | 11 / 0.6875     | IBM Plex Mono     | Coverage captions                                          |
| `--fs-hex`       | 10 / 0.625      | IBM Plex Mono     | Fingerprint copy-key (never a headline)                    |

Line-height: ≥1.4 body, ≥1.3 dense tables. `font-feature-settings: 'tnum' 1;` on **every** numeric column. `letter-spacing: 0.08em` on uppercase chrome. All numbers AND hex use IBM Plex Mono (VT323 has weak `0/O`, `1/l` disambiguation — it must NOT carry numbers that matter).

### 1.3 Spacing, Radius, Glow

```css
:root {
  /* Spacing — 4px base scale */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-7: 48px; --sp-8: 64px;

  /* Radius */
  --r-bezel: 22px; /* cassette-futurism outer chassis */
  --r-panel: 0px;  /* panels are squared; corners drawn with ⌜⌝⌞⌟ brackets, not radius */
  --r-pill:  999px;/* toggles */

  /* Glow — capped ≤4px blur, SAME hue as text, NEVER white, NEVER on number widgets */
  --glow-sm:  0 0 1px currentColor;                       /* body ≤14px: tight only */
  --glow-md:  0 0 1px currentColor, 0 0 4px currentColor; /* headers / glyphs */
  --glow-none: none;                                      /* all KPI / count widgets */
}
```

**Glow rules:** body copy (≤14px) gets `--glow-sm` only. The verdict reticle, KPIs, and error bars get `--glow-none` — motion/bloom must never fight the 5-second read. The only earned heavy bloom is the anomaly odometer (≥48px), and even there it never animates.

---

## 2. Typefaces (free, OFL, self-hosted woff2 — zero CDN)

Vendored into `src/dashboard/web/fonts/` and `@font-face`-declared locally. **No Google Fonts call ever** (local-first; logs carry code + scrubbed secrets).

| Role            | Family            | License | Source (download once, vendor woff2)                     | Subset           |
|-----------------|-------------------|---------|----------------------------------------------------------|------------------|
| DISPLAY         | **Orbitron**      | OFL     | github.com/theleagueof / Google Fonts repo (OFL)         | Latin, caps      |
| MONO-DATA       | **IBM Plex Mono** | OFL     | github.com/IBM/plex (OFL)                                 | Latin + box-glyph|
| AMBIENCE        | **VT323**         | OFL     | github.com/pholtz/VT323 / Google Fonts repo (OFL)        | Latin digits     |

- **Orbitron** — squared 2001/HAL caps, section headers + masthead ONLY, ≥18px, `letter-spacing 0.08em` uppercase.
- **IBM Plex Mono** — DEFAULT for all load-bearing numbers + hex (strong `0/O`, `1/l`). `font-feature-settings 'tnum' 1` on numeric columns.
- **VT323** — AMBIENCE ONLY: boot/console scrollback + the single anomaly odometer (≥48px). Never carries the numbers that matter.

`font-display: swap;` Fallbacks: Orbitron→`ui-sans-serif`; Plex Mono→`ui-monospace, "Courier New"`; VT323→`ui-monospace`.

---

## 3. Layout

- **Outer chassis:** `.bezel` — `border-radius: var(--r-bezel)`, inset rim shadow, faint top-left specular streak. The amber screen sits behind "glass" on trustworthy local hardware.
- **Responsive floor (CORRECTED from the inherited no-scroll 1440×900):** a **min-height responsive grid** with a documented breakpoint, **13px dense-cell floor that never shrinks below AA**, and **controlled below-the-fold vertical scroll allowed** (real laptops are 1366×768 + browser chrome + OS scaling). The BRIDGE top fold (verdict + vitals + anomaly) must fit one viewport; the lower panels may scroll.
- **Grid:** 12-col CSS grid inside the bezel. Full-width PRIORITY ONE banner row on top (`height:0` nominal). Below: a `[STATUS | CLI TILES | FLEET VITALS]` top strip, a `[CONSOLE/power-law | ERROR-BARS + LOOP]` mid block, a `[ACTIVE-TIME | FILE HOTSPOTS | OUTCOMES]` bottom strip.
- **Negative space:** ~60% empty in the nominal state. Density rises only as alarms fire.
- **Panel frame:** each panel framed by 1px corner brackets `⌜⌝⌞⌟` in `--dim`. No left LCARS rail. Channel nav = top-right rotary selector `[01 BRIDGE][02 PATTERNS][03 TRACE]`.
- **CRT overlay:** one fixed full-viewport `<CrtOverlay>` (scanlines + vignette + optional throttled grain) on its own compositor layer (`transform: translateZ(0)`, `pointer-events:none`) so it never repaints when the 199-digest data reloads.

Breakpoints: `≥1280px` full 12-col bridge; `768–1279px` collapse top strip to 2-up, stack mid block; `<768px` single column (degraded but legible — not a target, must not break).

---

## 4. Component Inventory

Every component lists **states**. Components are pure-CSS/SVG where possible; uPlot (canvas) only for data-dense bar/scatter charts.

### 4.1 CRT Frame (`.bezel` + `<CrtOverlay>`)
Non-interactive chrome. **States:** static only (no interactive bezel controls — retro look, terrible usability if clickable). Auto-dims ambience (§5).

### 4.2 Panel (`<Panel title>`)
Bordered region with `⌜⌝⌞⌟` brackets + Orbitron `--fs-header` title.
**States:** `resting` | `focus-within` (cyan ring on the panel's active control, not the panel) | `filtered` (when cross-filter active, non-matching panels dim label to `--dim`).

### 4.3 Status Reticle (`<StatusReticle status subtext>`)
280px circular amber ring, 3px stroke; center verdict text (Orbitron `--fs-verdict`). Verdict from `deriveSystemStatus(digests)` (§7).
**States:** `NOMINAL` (amber steady, glyph `●`) | `DEGRADED` (amber, glyph `◻`, opens here on current data: tool-failing/total > 0.25) | `ANOMALY` (`--danger`, glyph `◆`, fires when any session > 100 of one error class). Number widget → **never animates.**

### 4.4 Priority-One Banner (`<AnomalyBanner anomalies>`)
Full-width, `height:0` nominal (mounted, for transition). On ANOMALY → 64px, `--danger`, left-edge 6px solid, `⚠` glyph. Shows **BOTH** runaways derived from data: e.g. `worktree_collision N across M sessions · <id> x<max> · <id> x<next>` + the dual-arc wall-vs-active gauge + `[INSPECT TRACE →]` `[⟳ REPLAY]`.
**States:** `collapsed` (height 0) | `active` (64px, the ONE reserved pulse, §5) | `acknowledged` (see Open Question — decay/ack TBD).

### 4.5 Anomaly Odometer (`<Odometer value>`)
VT323 `--fs-odometer`, the one place a heavy same-hue red bloom is earned. Wired to the **actual argmax attempt count** from digests.
**States:** `count-up` (default, motion) | `reduced` (snaps to final value instantly). Never below 0.9 opacity, never above 1Hz.

### 4.6 Dual-Arc Gauge (`<WallActiveGauge wallMs activeMs>`)
SVG. A ghost arc = `durationMs` (wall, idle-spanned) BEHIND a solid arc = `activeDurationMs`. Teaches the wall-vs-active caveat visually. Label `ACTIVE 2m00s` solid + `wall 48.8d ⚠ idle-spanned` dim. **Never wall alone.** Static.

### 4.7 Status Light / Idiot-Light (`<StatusLight kind count>`)
14px LED + glyph + visible text label (4-channel encoding, §6.3). 
**States:** `completed ●` `--ok` steady | `gave_up ◻` `--warn` (slow-blink, RM→static) | `errored ▲` `--danger` | `running ▸` `--running` (pulse, RM→static `▸ RUNNING`) | `anomaly ◆` `--danger`.

### 4.8 CLI Link Tile (`<CliTile name count sparkline>`)
Cobb Semiotic-Standard monochrome pictogram + VT323 count + tiny outcome sparkline. Hue = per-CLI token (§1.1).
**States:** `resting` | `hover` (sparkline scrub) | `selected` (cross-filters all panels; cyan focus ring) | `focus-visible`.

### 4.9 Color-Block Bar — THE keystone primitive (`<LogBar n max hue glyph>`)
**Build this FIRST — it unblocks ~70% of the bridge.** A `div` whose width encodes a **log-scaled** magnitude:
```
width = 40 + 320 * (log10(n + 1) / log10(max + 1))   // px
```
Powers: the 42-fingerprint power-law, error-class bars, tool rollup, the 199-tile outcome strip. Reduced-motion-safe by construction (static). Hue/glyph encode category. Segmented "LED bargraph" ticks for the cassette look without distorting length.
**States:** `resting` | `hover` (1px scanline-highlight sweep across the row, RM→static highlight) | `selected` | `tail` (dimmed `--dim`).

### 4.10 Error-Class Log Bars (`<ErrorLogScale counts>`)
Horizontal log10 bars (uPlot `scales.y.distr:3` OR hand-rolled `<LogBar>`), Cobb glyph per class, raw-count VT323 overlay. `worktree_collision` clipped with a **zig-zag axis-break** + `4197 ▲` badge so `tool_error 1505` → `network 4` stay legible. Caption: `~N of M = 1 anomaly`.
**Fallback (if zig-zag eats cycles):** pure log10 bars + `▲` overflow badge + caption `worktree_collision dwarfs all others`. Defer literal zig-zag to fast-follow.

### 4.11 Loop Detector Card (`<LoopDetector pairs>`)
Detects tool pairs where `|a-b|/max(a,b) < 0.05 && both > 100`. Two interlocked counter-rotating `⟳` glyphs (RM→static) + ratio bar `lint ⇄ fix-lint 4199 : 4196 (99.9%)` + `2 sessions` tie-label. Tooltip cites the known deterministic-loop bug.
**States:** `resting` | `hover` (per-session breakdown).

### 4.12 Fingerprint Row / Hi-Score Power-Law (`<FingerprintRow digestSample count>`)
Ranked `<LogBar>` row. Label = derived `{AGENT}·{OUTCOME}·{topError}` read from a **sample digest** in the bucket (NOT a reversed hash — fingerprint is one-way sha256). Per-error glyph. 16-hex demoted to a 10px copy-key. 1px dashed `RECURRING/ONE-OFF` boundary at count=2. Folded `LONG TAIL — N shapes seen once` row. `SHOW NOMINAL (n)` recesses success buckets in `--dim`.
**States:** `resting` | `hover` | `focus` (roving-tabindex, cyan ring) | `selected` (triggers INTERFACE type-on) | `nominal-recessed`.

### 4.13 INTERFACE Reply Pane (`<InterfacePane fingerprint>`)
The signature interaction. Selecting a row types `INTERFACING WITH PATTERN <hex>…` (block caret) into the console, then reveals decoded label + aggregate + the lone `⟳ REPLAY` button (`--replay-from`→`--replay-to` gradient). Reply body = existing `replay.ts` output (first-ask + first-fail extracts) rendered as rows.
**States:** `idle` | `typing` (motion) | `revealed` | `reduced/repeat-query` (**instant-reveal**, hold-to-skip — never tax a power user mid-forensics). Reply announced via `aria-live="polite"`.

### 4.14 Replay Button (`<ReplayButton fp>`)
Primary action, ≥44px hit target (WCAG 2.2). Lone `--replay-from`→`--replay-to` HOT-amber gradient. Wired to `replay_fingerprint(fp)` — confirm server-side call vs deep-link (Open Question).
**States:** `resting` | `hover` (brighten to `--accent`) | `focus-visible` (cyan ring) | `active` | `disabled`.

### 4.15 Sparkline (`<Sparkline series>`)
Tiny inline SVG polyline, `--dim`, outcome-encoded. Static. Supporting evidence only.

### 4.16 Active-Time Histogram (`<ActiveTimeHistogram>`)
Log-decade bins (`<1s, 1–10s, 10s–1m, 1–10m, 10m–1h, 1–4h`) as `<LogBar>` rows, p50/p90 reticle markers, `ACTIVE · idle excluded` badge. **Always `activeDurationMs`, never `durationMs`.**

### 4.17 File Hotspots (`<FileHotspots>`)
Top-8 **basename** bars (full Windows path on explicit click only — legibility + privacy). `⚠ SPARSE 145 refs / 199` caveat chip.

### 4.18 Outcome Strip (`<OutcomeStrip digests>`)
8px 100%-stacked status bar + the 199-tile small-multiple (`<LogBar>` family), glyph-encoded, gave_up/errored cells lit.

### 4.19 Trace Filmstrip (`<TraceFilmstrip events>`)
Screen 03. Seq-ordered 24px glyph-tiles: `tool_call` (dim) / `tool_result.ok` / `tool_result` `ok:false` (red tick) / `error` (red `⚠`, 1.4× enlarged) / `file_change`. Ordered by `seq`, NOT timestamp (clocks lie per schema). Header reuses replay extracts: `ASK:` (first user message) + `FIRST FAIL:` (first `ok:false` tool_result). Duration readout: big `ACTIVE 2m00s` + dim `wall 48.8d ⚠`.
**States:** `resting` | tile `hover` (basename→full path) | tile `click` → RAW-JSON peek (the ONLY modal, from `/api/trace/:id`).

### 4.20 Glyph Legend (`<GlyphLegend>`)
Always-on header strip. Cobb Semiotic-Standard error-class glyphs are not self-evident — the legend is the persistent key; glyphs are never the sole carrier for the long tail.

### 4.21 Rotary Channel Selector / Toggles
Rotary `[01 BRIDGE][02 PATTERNS][03 TRACE]` (real tab control, obvious, keyboard-reachable — NOT a skeuomorphic knob). `CRT-FX` and `MOTION` toggles: 2-state pills, persisted to `localStorage`.

### 4.22 Boot Handshake (`<BootMask>`)
Black screen, block caret, type-on tied to REAL load milestones (mount `.aladeen/ingested` → parse digests → bucket fingerprints), announces `WARN worktree_collision x<N>` BEFORE the grid resolves. `<2.2s`, skippable, replayed once via `sessionStorage`. **RM→** render final log instantly as static (~600ms) so the anomaly warning is still SEEN, then grid.

---

## 5. Motion & Ambience Spec

**Core law: MOTION MUST MEAN SOMETHING. Steady state is STATIC.** The reduced path is built FIRST; the animated path is the enhancement.

| Effect | Default | `prefers-reduced-motion: reduce` OR MOTION-off toggle |
|--------|---------|-------------------------------------------------------|
| Scanlines `≤6%` + vignette `≤10%` | ON (ambience, not motion) | STAYS (auto-dim to `≤2%` under `prefers-contrast:more` / `forced-colors:active`) |
| Glow (same-hue, ≤4px) | ON, never on number widgets | STAYS (static) |
| **PRIORITY ONE pulse** (the ONE reserved alarm) | `1.0s` opacity `1→0.4` on `--danger` ring, `≤1Hz`, fires ONLY on ANOMALY | OFF → banner is **static red text** (still seen) |
| Anomaly odometer count-up | rAF count-up | snaps to final value instantly |
| Block caret blink | `530ms steps(1)` hard blink | static solid block |
| Type-on (INTERFACE / boot) | `~8–12ms/char` (drilldown), slower for boot | full string instant; drilldowns still expand, no typing |
| Boot handshake | `<2.2s` sweep + flash | skipped; final log shown static ~600ms |
| Loop `⟳` counter-rotation | slow rotate | static glyphs |
| Status-light `running` pulse / `gave_up` slow-blink | gated pulse | static `▸ RUNNING` / static `◻` |
| Hover row scanline-sweep | 1px sweep | static highlight |
| Optional phosphor grain canvas | `~10fps`, 128px tile, alpha `0.03–0.05` | **canvas not mounted at all** |

**Hard caps (photosensitivity):** no flicker below 0.9 opacity, no pulse above 1Hz, glow bloom ≤4px. **DROP the V-hold roll entirely** (conflates "machine broken" with "your run broken" + photosensitivity liability — the banner pulse carries the alarm). Number widgets (verdict, KPIs, error bars) NEVER animate. `document.hidden` pauses all animation; low `hardwareConcurrency` auto-disables grain.

---

## 6. Accessibility Guardrails

### 6.1 Contrast (WCAG: 4.5:1 body, 3:1 large ≥24px or ≥18.66px bold / UI)
Measured against `--bg #0A0700` AND post-composite with scanlines, never pure `#000`. `--primary` 9.6:1 (AAA), `--ok` 13.8:1, `--running`/`--focus` 11.9:1, `--dim` 4.6:1 (AA — never dimmed further via opacity over glow). Banned body text: `#B37400` (3.6:1), saturated `#00FF00`/`#FF0000`.

### 6.2 Type / Hit Targets
Base 16px; dense-cell floor 13px (never lower); line-height ≥1.4 body / ≥1.3 dense. `'tnum' 1` on numeric columns. Click targets ≥24px (SC 2.5.8); primary replay ≥44px.

### 6.3 Colorblind-Safe Status — 4-channel encoding (color + glyph + luminance + text)
**Never color alone** (~8% of men can't distinguish red/green). Validate in deuteranopia sim AND pure grayscale.

| Status   | Glyph | Color       | Visible text | aria-label |
|----------|-------|-------------|--------------|------------|
| completed| `●`   | `--ok`      | `COMPLETED`  | "completed" |
| gave_up  | `◻`   | `--warn`    | `GAVE UP`    | "gave up"   |
| errored  | `▲`   | `--danger`  | `ERRORED`    | "errored"   |
| running  | `▸`   | `--running` | `RUNNING`    | "running"   |
| anomaly  | `◆`   | `--danger`  | `ANOMALY`    | "anomaly — runaway loop" |

Error-class glyphs (Cobb-style, rendered in mono so they align): `worktree_collision ⟳ · tool_error ⚠ · timeout ⏱ · auth ⚿ · parse_error ≠ · binary_not_found ⌀ · rate_limit ⇊ · permission_denied ⊘ · network ⚡`. Always-on legend (§4.20) carries the key.

### 6.4 Focus / Keyboard
`:focus-visible` = 2px solid `--focus` (cyan), 2px offset, 3:1 min vs element AND bg. No bare `outline:none`. Focus hue distinct from resting amber. Tab order = visual order (top-left→bottom-right); skip-link to the fingerprint table; Enter/Space triggers the INTERFACE query / opens drilldown; **roving-tabindex on the 42 fingerprint rows** (arrows rove, not 42 tab stops). Focus ring survives reduced-motion.

### 6.5 No-Text-Overwhelm Budget (enforced against real data)
≤7 top-level panels. KPI label ≤3 words + 1 number. Fingerprint row = `glyph + count + 8-hex + 1 error chip` (no prose). Axis label ≤2 words; tooltip ≤12 words. **DEFER to drilldown:** full hash, sessionIds, raw counts, markdown. **CUT from grid:** absolute Windows paths → basename only; raw/wall-clock `durationMs` → formatted `activeDurationMs` + separate `idle Xd` chip; full UUIDs → last 6 chars + agent glyph. Compact numbers (`4,197` / `11.1k`). Error power-law on LOG axis.

### 6.6 Honest-Coverage Captions — never fake zeros
`edit loops detected in 7/199` (field PRESENT with value 0 elsewhere — NOT "NO TELEMETRY 148"), `cost present 51/199`, `⚠ SPARSE 145 file-refs/199`, `ACTIVE · idle excluded` badge preferring `activeDurationMs` over the 48.8d wall-clock.

### 6.7 All Numbers Data-Derived — zero literals
The verdict, the tool-fail KPI, both runaway counts are computed from `listDigests()` at render time. A forensic tool whose hero numbers are hardcoded destroys its own premise — the board honestly relaxes to NOMINAL once the runaway bug is fixed and re-ingested.

---

## 7. `deriveSystemStatus(digests)` — the verdict contract (NET-NEW)

Pure function, one-line test, lives beside the aggregate rollups (shared with `report.ts`). Returns `'nominal' | 'degraded' | 'anomaly'`.

```
ANOMALY  if any single session contributes > 100 of one errorClass   (fires on the runaway sessions)
DEGRADED if toolFailingSessions / total > 0.25                        (current data opens DEGRADED)
NOMINAL  otherwise
```

`toolFailingSessions` = count of digests with `toolFailureCount > 0`. **Do not lead with the `completed` vanity count** — the reticle opens DEGRADED/ANOMALY, not green. Thresholds need a one-line sign-off (Open Question).

---

## 8. Build / Serve Contract (local-first, zero new runtime deps)

- **Server:** `src/dashboard/server.ts` — `node:http` (stdlib), `listen({host:'127.0.0.1'})` with an assert that refuses to start on any non-loopback host. Reuses `new IngestStorage(repoRoot)`; computes aggregates from the 199 digests on each hit (cheap, <50ms), ships ~10–30KB of pre-rolled numbers, never 199 raw files. CSP `default-src 'self'; connect-src 'self'; img-src 'self' data:` blocks all outbound network. Routes: `/api/overview`, `/api/fingerprints`, `/api/errors`, `/api/tools`, `/api/sessions`, `/api/trace/:id`.
- **CLI:** `program.command('dashboard')` in `src/cli.tsx` beside `report` — `--repo-root`, `--port 7493`, `--no-open`. Opens via OS opener (`start`/`open`/`xdg-open`), no npm dep.
- **Web:** Vite SPA at `src/dashboard/web/` (Vite + `@vitejs/plugin-react` + `uplot` as **devDependencies only** — never in the `files` allowlist). Charts: uPlot canvas for data-dense bars/scatter; hand-rolled SVG for bespoke retro widgets (gauges, status lights, klaxon). One `useUplot(opts, data)` hook (no React wrapper lib). `vite build` → `dist/dashboard/web`.
- **Fonts:** vendored woff2 in `src/dashboard/web/fonts/`, `@font-face` local. Optional `--offline` vendors any remaining ESM into `.aladeen/dashboard/vendor/`.

---

## 9. Open Questions (carry into implementation)

1. **Toolchain sign-off** — confirm Vite-as-devDep vs buildless import-map before any pixel work (react-dom + a serve path are absent today; react@19 is bound to Ink).
2. **`deriveSystemStatus` thresholds** — who owns ANOMALY `>100/class` and DEGRADED `>0.25`? Needs a one-line test + sign-off.
3. **Anomaly acknowledgement** — the worktree runaway is a known, already-fixed bug in historical logs; every open re-fires the klaxon (alarm fatigue). Ack/dismiss state? Decay ("resolved if not seen in last N days")? Or rely purely on re-ingestion relaxing the verdict?
4. **Live-reload** — poll vs `fs.watch` vs manual `RE-SCAN` button + last-ingest timestamp in header (cheapest correct answer).
5. **Responsive floor** — confirm the relaxation to a responsive min-height grid + controlled below-fold scroll + 13px dense floor; must the BRIDGE top fold fit one viewport?
6. **Zig-zag axis-break** — accept the log10 + `▲` overflow-badge fallback if the SVG zig-zag eats iteration cycles.
7. **Replay wiring** — does `⟳ REPLAY` call `replay_fingerprint(fp)` server-side or deep-link to its output? Confirm so the affordance doesn't over-promise.
