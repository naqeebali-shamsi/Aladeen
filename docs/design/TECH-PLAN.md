# ALADEEN // FLIGHT RECORDER — Dashboard Build Plan (TECH-PLAN)

> Concept: **MU-TH-UR 6000 // ALADEEN INTERFACE** (amber Nostromo phosphor) with the WOPR verdict-spine and GRIDRUNNER hi-score power-law grafted in. This document is the **engineering build plan** for `aladeen dashboard`: deps, file layout, the Commander command, the localhost JSON API contract, the Vite build pipeline, and a phased checklist. Visual/UX intent lives in the design JSON; this file is how we ship it.

---

## 0. Hard constraints this plan honors

- **Local-first, non-negotiable.** The HTTP server binds **`127.0.0.1` only** (never `0.0.0.0`, never `localhost` which can resolve to a routable address on some setups). No external requests, no CDN, no telemetry. Fonts are **self-hosted woff2** committed to the repo — zero font CDN calls. Content-Security-Policy header is `default-src 'self'` so the page physically cannot phone home even if a future dep tries.
- **Zero budget.** Every dependency is free/OSS (MIT/OFL/Apache-2.0). **No charting library** — the design's "color-block length on a log scale IS the chart" graft means every chart is one reusable pure-CSS `<Bar>` primitive. That deletes the single heaviest dependency (D3/Recharts) at zero cost.
- **Reuse the existing data layer.** The server is a thin read-only shell over the already-shipped `IngestStorage` (`listDigests()`, `loadTrace(id)`) and `replayFingerprint()`. No new on-disk format, no schema change. The same `.aladeen/ingested/{sessions,digests}/*.json` the MCP server and `report` CLI already read.
- **ESM + NodeNext.** Matches `tsconfig.json` (`module: NodeNext`, `target: ESNext`, `jsx: react-jsx`). All server imports use the `.js` extension convention already in the codebase.

---

## 1. Dependencies (exact, with dev-only vs runtime split)

The SPA is **pre-built at publish time** and shipped as static files in `dist/`. Therefore **the browser/build toolchain is `devDependencies` only — it is NEVER installed by an end user** who runs `npx aladeen dashboard`. The only *new runtime* dependency is `react-dom` (peer of the already-present `react@19`).

### New `dependencies` (shipped, runtime)
| Package | Version | Why | License |
|---|---|---|---|
| `react-dom` | `^19.2.0` (match installed `react@^19.2.4`) | Render the SPA in the browser. `react` is already a dep (currently bound to Ink for the TUI); `react-dom` is its missing web half. | MIT |

> **No web framework, no Express.** The server is Node's built-in `node:http` + `node:fs/promises` (already used everywhere in the codebase). Express/Fastify/Koa add surface area and a dependency for ~40 lines of static-file + 3-route logic we can write by hand. Keeps the install lean and the local-first audit trivial.

### New `devDependencies` (build-time only, never shipped to users)
| Package | Version | Why | License |
|---|---|---|---|
| `vite` | `^7.0.0` | Build + dev-serve the SPA. Dev `vite` server gives HMR while building the dashboard; `vite build` emits the static bundle into `dist/dashboard/`. | MIT |
| `@vitejs/plugin-react` | `^5.0.0` (the v7-compatible major) | React Fast Refresh + JSX transform for the Vite pipeline. | MIT |

### Self-hosted font assets (committed, not npm deps)
Downloaded once, committed under `src/dashboard/public/fonts/`, served `'self'`. All OFL-licensed:
- **Orbitron** (`Orbitron-Regular.woff2`, `-Bold.woff2`) — display / masthead / section headers.
- **IBM Plex Mono** (`IBMPlexMono-Regular.woff2`, `-Medium.woff2`) — **all load-bearing numbers and hex** (strong `0/O`, `1/l` disambiguation; the design explicitly forbids VT323 for numbers).
- **VT323** (`VT323-Regular.woff2`) — **ambience only**: the boot/console scrollback and the single anomaly odometer.

> Already present and reused as-is: `commander@^12`, `zod@^3`, `react@^19`. The dashboard adds nothing to the MCP/Ink/PTY stack.

### `package.json` deltas
```jsonc
{
  "dependencies": {
    "react-dom": "^19.2.0"          // NEW (runtime)
  },
  "devDependencies": {
    "vite": "^7.0.0",               // NEW (build only)
    "@vitejs/plugin-react": "^5.0.0" // NEW (build only)
  },
  "scripts": {
    // existing "build": "tsc" stays; we COMPOSE the dashboard build into it:
    "build": "npm run build:server && npm run build:dashboard",
    "build:server": "tsc",
    "build:dashboard": "vite build",
    "dev:dashboard": "vite",        // HMR dev loop while building the SPA
    "prepublishOnly": "npm run typecheck && npm run test && npm run build"
  }
}
```
`dist/` is already in the `files` allowlist, so the built dashboard ships automatically once it lands under `dist/dashboard/`. No change to `files`.

---

## 2. File layout under `src/`

```
src/
  dashboard/
    server.ts                 # node:http server, binds 127.0.0.1, serves SPA + JSON API
    server.test.ts            # vitest: routes, 127.0.0.1 bind, content-types, 404s
    api.ts                    # pure functions: digests->API shapes (deriveSystemStatus, rollups)
    api.test.ts               # vitest: deriveSystemStatus thresholds, aggregation correctness
    open-browser.ts           # cross-platform "open URL" (no `open` npm dep — spawn per-OS)
    index.html                # Vite entry HTML (the bezel + #root mount + CSP meta)
    main.tsx                  # React entry: createRoot(...).render(<App/>)
    App.tsx                   # channel router: 01 BRIDGE / 02 PATTERNS / 03 TRACE + boot mask
    theme.css                 # palette vars, scanline/vignette layers, reduced-motion gates
    fonts.css                 # @font-face for the 3 self-hosted families
    lib/
      useDigests.ts           # fetch /api/digests.json once, expose derived selectors
      logScale.ts             # width = 40 + 320*log10(n+1)/log10(max+1)  (the chart keystone)
      glyphs.ts               # Cobb-standard glyph map: CLIs + 9 error classes + status
      format.ts               # fmtMs, basename(winPath), tnum helpers (mirrors report.ts)
    components/
      Bar.tsx                 # THE reusable log-width color-block. Powers every chart.
      StatusReticle.tsx       # NOMINAL/DEGRADED/ANOMALY verdict ring
      PriorityBanner.tsx      # height:0 -> 64px #CC0000 klaxon (the one reserved motion)
      BootMask.tsx            # <2.2s type-on handshake, sessionStorage-gated, skippable
      CliTile.tsx             # 4 CLI pictogram tiles
      FleetVitals.tsx         # outcome idiot-lights + tool-failure half-gauge
      PowerLawConsole.tsx     # 42-fingerprint ranked rows + INTERFACE reply pane
      ErrorClassBars.tsx      # log10 bars + worktree axis-break / overflow badge
      LoopDetector.tsx        # lint <=> fix-lint paired bars
      ActiveTimeHistogram.tsx # log-decade active-duration bins
      FileHotspots.tsx        # top-8 basename bars (+ SPARSE 145/199 caveat chip)
      OutcomesStrip.tsx       # 199-tile status strip
      GlyphLegend.tsx         # always-on header legend (long-tail glyph key)
      TraceFilmstrip.tsx      # 03 TRACE: seq-ordered event glyph tiles + raw-JSON modal
    public/
      fonts/                  # self-hosted woff2 (Orbitron, IBM Plex Mono, VT323)
  cli.tsx                     # +1 new command: `dashboard` (wires server.ts + open-browser.ts)
vite.config.ts                # repo root; root=src/dashboard, outDir=dist/dashboard, base=/
```

Rationale: `server.ts` / `api.ts` are plain TS compiled by the **existing `tsc`** into `dist/dashboard/server.js` (they live under `src/`, so `rootDir: ./src` -> `outDir: ./dist` already covers them). The SPA (`main.tsx`, `App.tsx`, components, css, public) is compiled by **Vite** into `dist/dashboard/` static assets. The two pipelines write into the same `dist/dashboard/` folder but never collide: `tsc` emits `server.js`/`api.js`; Vite emits `index.html` + `assets/*` (see §5).

---

## 3. The `aladeen dashboard` Commander command

Slots into `src/cli.tsx` alongside `report`/`replay`/`ingest`, mirroring their `--repo-root` convention.

```ts
program
  .command('dashboard')
  .description('Open the local FLIGHT RECORDER dashboard (reads .aladeen/ingested, 100% local)')
  .option('--repo-root <path>', 'Repository root that owns .aladeen/ingested', process.cwd())
  .option('--port <n>', 'Port to bind on 127.0.0.1 (0 = pick a free port)', '4173')
  .option('--no-open', 'Do not auto-open the browser; just print the URL')
  .action(async (opts: { repoRoot: string; port: string; open: boolean }) => {
    const { startDashboardServer } = await import('./dashboard/server.js');
    const { openBrowser } = await import('./dashboard/open-browser.js');
    const storage = new IngestStorage(opts.repoRoot);
    const { url, close } = await startDashboardServer({
      storage,
      host: '127.0.0.1',                 // local-first: hardcoded, not configurable
      port: Number.parseInt(opts.port, 10) || 0,
    });
    console.log(`FLIGHT RECORDER online -> ${url}   (Ctrl-C to stop, 100% local)`);
    if (opts.open) await openBrowser(url);
    process.on('SIGINT', () => { close(); process.exit(0); });
  });
```

- **Dynamic `import()`** so the heavy dashboard code isn't loaded for `report`/`ingest`/`tui` runs.
- `startDashboardServer` resolves the static root from `import.meta.url` -> `dist/dashboard/` (the published location). In `tsx`/dev it resolves to the same relative path under `src` via a `DASHBOARD_STATIC_DIR` env override used only by tests.
- `openBrowser` shells out per-OS with **no npm dep**: Windows `cmd /c start ""`, macOS `open`, Linux `xdg-open` — via the already-present `cross-spawn`. Failure is non-fatal (we already printed the URL).
- `--no-open` and `--port` support headless/SSH and port-conflict cases. Port `0` lets the OS assign a free port (printed back).

---

## 4. Localhost JSON API contract

Three GET routes + static assets. All responses `Content-Type: application/json`, `Cache-Control: no-store` (the user re-ingests; never serve stale), `Content-Security-Policy: default-src 'self'`. Server is read-only — **no POST, no mutation, no replay execution server-side** (see §4.4).

### 4.1 `GET /api/digests.json` — the single hero payload
One round trip powers the entire BRIDGE + PATTERNS view. Built from `await storage.listDigests()` then projected by pure functions in `api.ts`. **Every number is derived here, zero literals** (honors the design's "all numbers data-derived" guardrail).

```jsonc
{
  "generatedAt": "2026-05-29T12:00:00.000Z",   // header "last scan" timestamp
  "repoRoot": "N:\\Aladeen",
  "sessionCount": 199,
  "digests": [ /* RunDigest[] verbatim from listDigests() — the raw rows */ ],

  // ---- server-derived rollups so the client ships no aggregation logic that could drift ----
  "verdict": {                                   // deriveSystemStatus(digests)
    "level": "ANOMALY",                          // "NOMINAL" | "DEGRADED" | "ANOMALY"
    "toolFailingSessions": 107,                  // count(d.toolFailureCount > 0 || outcome in {errored,gave_up,interrupted})
    "toolFailingRatio": 0.538,                   // -> DEGRADED rule: ratio > 0.25
    "anomalies": [                               // ANOMALY rule: any session with >100 of one error class
      { "sessionId": "b9428fa6...", "errorClass": "worktree_collision", "count": 2267, "agentCliName": "aladeen", "outcome": "gave_up" },
      { "sessionId": "690cbbfe...", "errorClass": "worktree_collision", "count": 1930, "agentCliName": "aladeen", "outcome": "gave_up" }
    ]
  },
  "outcomes":    { "completed": 189, "gave_up": 8, "running": 1, "errored": 1 },
  "byCli":       { "codex": 139, "claude-code": 40, "opencode": 12, "aladeen": 8 },
  "errorClasses":{ "worktree_collision": 4197, "tool_error": 1505, "parse_error": 161,
                   "timeout": 147, "auth": 75, "binary_not_found": 39, "rate_limit": 15,
                   "permission_denied": 14, "network": 4 },           // sum across digests, nonzero kept
  "toolUsage":   { "shell_command": 11102, "lint": 4199, "fix-lint": 4196, "apply_patch": 987, "...": 0 },
  "loopPairs":   [ { "a": "lint", "b": "fix-lint", "aCount": 4199, "bCount": 4196, "ratio": 0.999, "sessions": 2 } ],
  "fingerprints": [                              // the PATTERNS spine, pre-sorted desc by count
    { "fp": "6eb7c0a37f5e4a99", "count": 45, "agentCliName": "codex", "outcome": "completed",
      "topError": null, "label": "CODEX.CLEAN.45x", "sampleSessionId": "..." }
    // ...42 rows. label = {AGENT}.{OUTCOME}.{topError||CLEAN} read from a SAMPLE digest, NOT a hash reversal
  ],
  "activeTimeBins": [ { "bin": "<1s", "count": 3 }, { "bin": "1-10s", "count": 11 }, /* log decades */ ],
  "fileHotspots":  [ { "basename": "index.ts", "count": 7, "fullPaths": ["N:\\Aladeen\\src\\index.ts"] } ],
  "coverage":      { "editLoops": 7, "cost": 51, "fileRefs": 145, "total": 199 }  // honest-coverage captions
}
```

> Sizing: 199 digests at the observed shape pretty-print to a few hundred KB; over `127.0.0.1` this is one sub-10ms read. No pagination needed. The derived rollups are computed server-side specifically so the React layer can't accidentally re-derive a different `53.8%` than the verdict.

### 4.2 `GET /api/trace/:id` — single-session forensic detail (03 TRACE)
Lazy: only fetched when the user opens a TRACE. Calls `storage.loadTrace(id)` (which itself runs `sanitizeForFs(id)`), returns the full `SessionTrace` JSON, or `404 {"error":"..."}` when absent. The `:id` accepts the same id format shown in fingerprint rows. This is the source for the filmstrip and the "ASK:" / "FIRST FAIL:" header extracts (the same `events.find(user_message)` / `events.find(tool_result && !ok)` logic already in `replay.ts:199-213` — lifted into `lib/format.ts`, shared).

### 4.3 `GET /api/replay/:fp` — pattern drill-down (optional, fast-follow)
Wraps the existing `replayFingerprint(fp, storage)` and returns `{ fingerprint, matchCount, markdown }`. The INTERFACE reply pane can render `markdown` directly (it's already the human-readable bucket aggregate). **Decision (resolves the openQuestion):** the `⟳ REPLAY` button is a **read-only deep-link to this drill-down** in v1 — it shows the known-good fix, it does **not** re-execute an agent (Aladeen is an observability layer, not an orchestrator; executing would violate the product's own framing). If/when a true auto-replay primitive exists, this route is where it'd attach.

### 4.4 Static assets
Any non-`/api/*` path serves from the static root: `/` -> `index.html`, `/assets/*` and `/fonts/*` -> the Vite output, with correct MIME (`text/html`, `application/javascript`, `text/css`, `font/woff2`). Unknown paths fall back to `index.html` (SPA routing) except under `/assets|/fonts` where a miss is a real `404`. Path-traversal guard: resolved path must stay inside the static root.

---

## 5. Build pipeline (how Vite output ships in `dist/` and is served)

`vite.config.ts` at repo root:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/dashboard',          // index.html + main.tsx live here
  base: '/',                      // absolute asset URLs, served from the node server root
  plugins: [react()],
  build: {
    outDir: '../../dist/dashboard', // emit alongside the tsc-compiled server.js
    emptyOutDir: false,             // CRITICAL: tsc already wrote server.js here; don't wipe it
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: { host: '127.0.0.1', port: 5173 }, // dev-only HMR; never the shipped path
});
```

Pipeline order in `npm run build`:
1. `tsc` (`build:server`) compiles **all** of `src/**` -> `dist/**`, including `dist/dashboard/server.js`, `api.js`, `open-browser.js`. (It does NOT emit `main.tsx`/components usefully for the browser — that's Vite's job — but harmless `.js` for them is fine; the server never imports them.)
2. `vite build` (`build:dashboard`) compiles the SPA -> `dist/dashboard/index.html` + `dist/dashboard/assets/*` + copies `public/fonts/*`. `emptyOutDir: false` preserves `server.js` from step 1.
3. Result in the npm tarball (`files: ["dist", ...]`):
   ```
   dist/dashboard/
     server.js  api.js  open-browser.js   <- from tsc, run by Node
     index.html                            <- from Vite, served to browser
     assets/main-<hash>.js  main-<hash>.css
     fonts/*.woff2
   ```
4. At runtime `server.ts` computes `staticRoot = dirname(fileURLToPath(import.meta.url))` -> `dist/dashboard/`, serves `index.html` + `assets` + `fonts` from there. **The end user never runs Vite** — they get pre-built static files.

> Excluded from publish concerns: `vite`/`@vitejs/plugin-react` are devDeps, so `npm install aladeen` pulls neither. The dashboard is "just static files + a tiny http server" by the time it reaches a user.

---

## 6. Derivation rules that are NET-NEW logic (own them explicitly)

These live in `src/dashboard/api.ts`, are pure, and are unit-tested in `api.test.ts` so the board's alarms are pinned to data, not vibes:

- **`deriveSystemStatus(digests)`** ->
  - `ANOMALY` if **any** session contributes `> 100` of a single error class (today: 2 sessions x worktree_collision). This is the loudest state and, per a11y guardrail, **collapses to static red text under reduced-motion** — never disappears.
  - else `DEGRADED` if `toolFailingSessions / total > 0.25` (today 107/199 = 53.8%).
  - else `NOMINAL`. The board **relaxes honestly** to NOMINAL once the runaway bug logs are re-ingested out — no hardcoded 4197.
- **Anomaly acknowledgement (resolves openQuestion):** the runaway is a *known, fixed* bug in historical logs, so re-firing the klaxon every open is alarm-fatigue. v1 ships an **`localStorage` "ACK" dismiss** that visually downgrades the PRIORITY ONE banner to a thin static line (the verdict level itself still reports ANOMALY honestly — ack changes presentation, not truth). A `seen-in-last-N-days` decay is a fast-follow.
- **Live data (resolves openQuestion):** a manual **`RE-SCAN`** control re-fetches `/api/digests.json`; the header shows `generatedAt`. No `fs.watch`/polling in v1 — cheapest correct answer for a file-on-disk reader.

---

## 7. Phased implementation checklist (working prototype first)

**Phase 0 — toolchain (≈0.5 day)**
- [ ] Add `react-dom` (dep), `vite` + `@vitejs/plugin-react` (devDeps). `vite.config.ts`. `build` script split.
- [ ] `src/dashboard/index.html` + `main.tsx` rendering a literal "FLIGHT RECORDER" so `vite build` + serve round-trips end-to-end.

**Phase 1 — server + API (≈1 day)**
- [ ] `server.ts` (node:http, 127.0.0.1, static + 3 routes, CSP/no-store, traversal guard). `server.test.ts`.
- [ ] `api.ts`: `deriveSystemStatus`, all rollups, `fingerprints[]` with derived labels. `api.test.ts` pins thresholds (107/199, both runaways, 22 singletons).
- [ ] `dashboard` Commander command + `open-browser.ts`. Verify `aladeen dashboard` opens a real browser at the derived URL.

**Phase 2 — the chart keystone (≈0.5 day)**
- [ ] `logScale.ts` + `Bar.tsx` (the one CSS primitive). `glyphs.ts`, `format.ts` (lift `basename`/`fmtMs`/extract logic from report.ts/replay.ts). `theme.css` + `fonts.css` with the 3 self-hosted woff2 + reduced-motion gates built FIRST.

**Phase 3 — 01 BRIDGE (≈1.5 days)**
- [ ] `StatusReticle`, `PriorityBanner` (height:0 default, the one reserved pulse), `CliTile`x4, `FleetVitals`, `PowerLawConsole` + INTERFACE reply pane, `ErrorClassBars` (log10 + overflow badge — defer literal zig-zag axis-break per openQuestion), `LoopDetector`, `ActiveTimeHistogram`, `FileHotspots`, `OutcomesStrip`, `GlyphLegend`. ~60% negative space nominal.

**Phase 4 — 02 PATTERNS + 03 TRACE (≈1.5 days)**
- [ ] PATTERNS: 42 ranked rows, RECURRING/ONE-OFF dashed boundary at count=2, folded "LONG TAIL — 22 shapes seen once", roving-tabindex keyboard path, INTERFACE type-on (instant-reveal on repeat).
- [ ] TRACE: `TraceFilmstrip` from `/api/trace/:id`, ACTIVE-vs-wall dual readout, ASK/FIRST-FAIL extracts, basename tiles, the single raw-JSON modal.

**Phase 5 — polish + a11y + motion (≈1 day)**
- [ ] `BootMask` (<2.2s, sessionStorage-once, skippable, reduced-motion skip), CRT-FX + MOTION localStorage toggles, anomaly ACK dismiss, RE-SCAN, post-composite contrast check, focus rings, `aria-live` for the INTERFACE reply. Responsive min-height grid (1366x768 floor, 13px dense-cell floor, controlled below-fold scroll).

---

## 8. Open decisions baked in (so build can start)
- **Server framework:** none — `node:http`. (Avoids a runtime dep.)
- **Charts:** none — `Bar.tsx` CSS primitive only.
- **REPLAY button:** read-only deep-link to `/api/replay/:fp` markdown (no agent execution).
- **Live reload:** manual RE-SCAN + `generatedAt` header (no fs.watch in v1).
- **Anomaly fatigue:** `localStorage` ACK downgrades presentation; verdict stays honest; decay is fast-follow.
- **Axis-break:** ship log10 bars + `4197 ▲` overflow badge + caption first; literal zig-zag glyph is fast-follow.
