import {
  logWidth, fmtMs, fmtCompact, pct, esc, basename,
  STATUS_GLYPH, ERR_GLYPH, CLI_PIC, cliColor,
} from '/lib.js';

// ── State ────────────────────────────────────────────────────────────────
const state = {
  data: null,
  channel: 'bridge',
  selectedFp: null,
  traceId: null,
  showNominal: false,
  longtailOpen: false,
  motion: 'full',
  crt: 'on',
  acked: new Set(JSON.parse(localStorage.getItem('aladeen.acked') || '[]')),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bootSkip = false;

// ── Init ───────────────────────────────────────────────────────────────────
function initPrefs() {
  const motionPref = localStorage.getItem('aladeen.motion');
  const prefersReduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  state.motion = motionPref || (prefersReduce ? 'reduce' : 'full');
  state.crt = localStorage.getItem('aladeen.crt') || 'on';
  document.documentElement.dataset.motion = state.motion;
  document.documentElement.dataset.crt = state.crt;
}

async function fetchOverview() {
  const res = await fetch('/api/digests.json');
  if (!res.ok) throw new Error(`/api/digests.json → ${res.status}`);
  return res.json();
}

async function boot() {
  const bootEl = document.getElementById('boot');
  const reduced = state.motion === 'reduce';
  const alreadyBooted = sessionStorage.getItem('aladeen.booted');

  const dataP = fetchOverview().catch((e) => ({ __error: String(e) }));

  if (reduced || alreadyBooted) {
    state.data = await dataP;
    bootEl.style.display = 'none';
    render();
    return;
  }

  document.addEventListener('keydown', () => { bootSkip = true; }, { once: true });
  bootEl.addEventListener('click', () => { bootSkip = true; });

  const data = await dataP;
  state.data = data;
  const v = data.verdict || {};
  const anomaly = (v.anomalies || [])[0];
  const lines = [
    'FLIGHT RECORDER 2037 READY',
    'MOUNTING .aladeen/ingested .......... OK',
    `${data.sessionCount ?? 0} SESSIONS`,
    `${Object.keys(data.byCli || {}).length} CLI LINKS  [${Object.keys(data.byCli || {}).join(' · ')}]`,
    `FINGERPRINTS ${(data.fingerprints || []).length}`,
    '',
  ];
  if (anomaly) {
    const total = (v.anomalies || []).reduce((s, a) => s + a.count, 0);
    lines.push(`WARN PRIORITY ONE — ${anomaly.errorClass} x${total} (${v.anomalies.length} runaway sessions)`);
  }

  await typeLines(bootEl, lines);
  sessionStorage.setItem('aladeen.booted', '1');
  await sleep(bootSkip ? 0 : 350);
  bootEl.style.display = 'none';
  render();
}

async function typeLines(el, lines) {
  el.style.display = 'block';
  let html = '';
  for (const line of lines) {
    const warn = line.startsWith('WARN');
    const cls = warn ? 'ln warn' : 'ln';
    if (bootSkip) { html += `<div class="${cls}">${esc(line)}</div>`; el.innerHTML = html + skipHint(); continue; }
    html += `<div class="${cls}"></div>`;
    el.innerHTML = html + `<span class="caret"></span>` + skipHint();
    const target = el.querySelectorAll('.ln');
    const cur = target[target.length - 1];
    for (let i = 0; i < line.length; i++) {
      if (bootSkip) { cur.textContent = line; break; }
      cur.textContent += line[i];
      await sleep(warn ? 14 : 8);
    }
  }
  el.innerHTML = html + skipHint();
}
const skipHint = () => `<div class="skip">[ press any key to skip ]</div>`;

// ── Render ───────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  if (state.data?.__error) {
    app.innerHTML = `<div class="panel"><h2>NO SIGNAL</h2><div class="caption">Could not read ingested digests: ${esc(state.data.__error)}<br/>Run <b>aladeen ingest claude-code</b> then re-scan.</div></div>`;
    return;
  }
  app.innerHTML =
    headerHTML() + legendHTML() +
    `<div id="channel">${channelHTML()}</div>` +
    footerHTML();
  wire(app);
}

function headerHTML() {
  const d = state.data;
  const ingest = d?.generatedAt ? new Date(d.generatedAt).toISOString().slice(0, 16).replace('T', ' ') : '—';
  const tab = (id, label) => `<button data-chan="${id}" aria-selected="${state.channel === id}">${label}</button>`;
  return `
  <header class="mast">
    <h1>ALADEEN <span class="slash">//</span> FLIGHT RECORDER</h1>
    <div class="mast-right">
      <span class="last-ingest">last-ingest ${esc(ingest)}</span>
      <button class="rescan" id="rescan">⟳ RE-SCAN</button>
      <div class="channels">
        ${tab('bridge', '01 Bridge')}${tab('patterns', '02 Patterns')}${tab('trace', '03 Trace')}
      </div>
    </div>
  </header>`;
}

function legendHTML() {
  const s = Object.entries(STATUS_GLYPH).slice(0, 5).map(([k, g]) => `<b>${g}</b> ${k}`).join(' · ');
  const e = Object.entries(ERR_GLYPH).slice(0, 9).map(([k, g]) => `<b>${g}</b> ${k.replace(/_/g, ' ')}`).join('  ');
  return `<div class="legend"><span>${s}</span><span>${e}</span></div>`;
}

function footerHTML() {
  return `<div class="footer">
    <span>CRT-FX <b>${state.crt.toUpperCase()}</b></span>
    <button class="toggle" id="t-crt">toggle CRT</button>
    <span>MOTION <b>${state.motion === 'reduce' ? 'REDUCE' : 'FULL'}</b></span>
    <button class="toggle" id="t-motion">toggle motion</button>
    <span>100% LOCAL</span><span>127.0.0.1</span><span>v0.1.0</span>
  </div>`;
}

function channelHTML() {
  if (state.channel === 'patterns') return patternsHTML();
  if (state.channel === 'trace') return traceHTML();
  return bridgeHTML();
}

// ── 01 BRIDGE ──────────────────────────────────────────────────────────────
function bridgeHTML() {
  const d = state.data;
  return priorityHTML(d) + `
  <div class="grid cols-3">
    ${panel('STATUS', reticleHTML(d))}
    ${panel('CLI INTERFACE LINKS', cliTilesHTML(d))}
    ${panel('FLEET VITALS', fleetVitalsHTML(d))}
  </div>
  <div class="grid bridge-mid">
    ${panel('CONSOLE // FINGERPRINT POWER-LAW', powerLawHTML(d, 8) + interfacePaneHTML())}
    ${panel('ERROR CLASS · LOG10', errorBarsHTML(d))}
  </div>
  <div class="grid cols-3">
    ${panel('ACTIVE TIME · idle excluded', activeTimeHTML(d))}
    ${panel('FILE HOTSPOTS', fileHotspotsHTML(d))}
    ${panel('LOOP DETECTOR', loopHTML(d))}
  </div>
  ${panel('OUTCOMES · ' + d.sessionCount + ' SESSIONS', outcomesHTML(d))}`;
}

function priorityHTML(d) {
  const v = d.verdict || {};
  const an = v.anomalies || [];
  if (an.length === 0) return `<div class="priority" aria-hidden="true"></div>`;
  const sig = an.map((a) => `${a.sessionId}:${a.count}`).join('|');
  const acked = state.acked.has(sig);
  const total = an.reduce((s, a) => s + a.count, 0);
  const cls = an[0].errorClass;
  const runaways = an.slice(0, 3).map((a) => `<b>${esc(shortId(a.sessionId))} ×${a.count}</b>`).join('  ');
  return `
  <div class="priority active ${acked ? 'acked' : ''}" data-sig="${esc(sig)}">
    <div class="ptitle"><span class="pulse-ring"></span> ⚠ PRIORITY ONE · RUNAWAY LOOP · ${esc(cls)} ${fmtCompact(total)} across ${an.length} sessions</div>
    <div class="pbody">
      <span class="odometer">${an[0].count.toLocaleString()}</span>
      <span class="runaways">${runaways}</span>
      <div class="pactions">
        <button class="toggle" data-trace="${esc(an[0].sessionId)}">INSPECT TRACE →</button>
        <button class="toggle" data-replay-fp="">⟳ REPLAY</button>
        <button class="toggle" id="ack">${acked ? 'ACKED' : 'ACK'}</button>
      </div>
    </div>
  </div>`;
}

function reticleHTML(d) {
  const v = d.verdict || {};
  const lvl = v.level || 'NOMINAL';
  const sub = v.level === 'ANOMALY'
    ? `${v.anomalies.length} session(s) &gt; 100 of one class`
    : `tool-failing ${v.toolFailingSessions}/${v.total} (${pct(v.toolFailingRatio || 0)})`;
  return `<div class="reticle level-${lvl}">
    <div class="ring"><span class="verdict">${lvl}</span></div>
    <div class="sub num">${sub}</div>
  </div>`;
}

function cliTilesHTML(d) {
  const entries = Object.entries(d.byCli || {});
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return `<div class="cli-tiles">` + entries.map(([name, n]) => `
    <div class="cli-tile" data-chan-cli="${esc(name)}" role="button" tabindex="0">
      <span class="pic" style="color:${cliColor(name)}">${CLI_PIC[name] || '◈'}</span>
      <span class="name">${esc(name)}</span>
      <span class="count num">${n}</span>
      <span class="spark">${sparkBar(n, max)}</span>
    </div>`).join('') + `</div>
    <div class="caption">${entries.length} links nominal</div>`;
}
const sparkBar = (n, max) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((n / max) * 7))];

function fleetVitalsHTML(d) {
  const o = d.outcomes || {};
  const order = ['completed', 'gave_up', 'errored', 'running', 'interrupted', 'unknown'];
  const rows = order.filter((k) => o[k]).map((k) => `
    <div class="led ${k}"><span class="dot">${STATUS_GLYPH[k]}</span><span class="lbl">${k.replace('_', ' ').toUpperCase()}</span><span class="count num">${o[k]}</span></div>`).join('');
  const v = d.verdict || {};
  const r = v.toolFailingRatio || 0;
  return rows + `
    <div class="gauge">
      <div class="lbl"><span>TOOL-LEVEL FAILURES</span><span class="num">${v.toolFailingSessions}/${v.total} · ${pct(r)}</span></div>
      <div class="bar"><span style="width:${(r * 100).toFixed(1)}%"></span></div>
    </div>`;
}

function powerLawHTML(d, limit) {
  const fps = (d.fingerprints || []).slice(0, limit);
  const max = Math.max(1, ...(d.fingerprints || []).map((f) => f.count));
  return `<div class="fps">` + fps.map((f) => fpRowHTML(f, max, false)).join('') + `</div>`;
}

function fpRowHTML(f, max, roving) {
  const g = f.topError ? (ERR_GLYPH[f.topError] || '·') : STATUS_GLYPH[f.outcome] || '·';
  const klass = f.isFailure ? 'failure' : 'nominal';
  return `<div class="fprow ${klass}" data-fp="${esc(f.fp)}" role="button" tabindex="${roving ? -1 : 0}" aria-selected="${state.selectedFp === f.fp}">
    <span class="glyph">${g}</span>
    <span class="lbl">${esc(f.label)}</span>
    <span class="bar" style="width:${logWidth(f.count, max).toFixed(0)}px"></span>
    <span class="cnt num">${f.count}</span>
    <span class="hex">${esc(f.fp.slice(0, 8))}</span>
  </div>`;
}

function interfacePaneHTML() {
  return `<div class="interface" id="interface"><div class="line meta">&gt; select a pattern to interface…</div></div>`;
}

function errorBarsHTML(d) {
  const ec = Object.entries(d.errorClasses || {});
  if (ec.length === 0) return `<div class="caption">no classified errors</div>`;
  const max = Math.max(...ec.map(([, n]) => n));
  const second = ec.length > 1 ? ec[1][1] : max;
  return `<div class="bars">` + ec.map(([cls, n]) => {
    const isSpike = n === max && n > second * 4;
    const w = logWidth(n, max);
    return `<div class="barrow ${cls === 'worktree_collision' ? 'danger' : ''}">
      <span class="glyph">${ERR_GLYPH[cls] || '·'}</span>
      <span class="blabel">${esc(cls.replace(/_/g, ' '))}</span>
      <span class="bar" style="width:${w.toFixed(0)}px"></span>
      <span class="bval num">${fmtCompact(n)}</span>${isSpike ? '<span class="overflow">▲</span>' : ''}
    </div>`;
  }).join('') + `</div><div class="caption">log10 scale · ⚠ worktree_collision dwarfs all others</div>`;
}

function loopHTML(d) {
  const p = (d.loopPairs || [])[0];
  if (!p) return `<div class="caption">no deterministic loops detected</div>`;
  return `<div class="loop">
    <div class="gears"><span>⟳</span> <span>⟳</span></div>
    <div class="pair num">${esc(p.a)} ⇄ ${esc(p.b)}</div>
    <div class="num">${fmtCompact(p.aCount)} : ${fmtCompact(p.bCount)} <span class="ratio">(${pct(p.ratio)})</span></div>
    <div class="ses">deterministic retry loop · ${p.sessions} session(s)</div>
  </div>`;
}

function activeTimeHTML(d) {
  const bins = d.activeTimeBins || [];
  const max = Math.max(1, ...bins.map((b) => b.count));
  const pp = d.activeTimePercentiles || {};
  return `<div class="bars">` + bins.map((b) => `
    <div class="barrow">
      <span class="blabel" style="width:6em">${esc(b.bin)}</span>
      <span class="bar" style="width:${logWidth(b.count, max).toFixed(0)}px"></span>
      <span class="bval num">${b.count}</span>
    </div>`).join('') + `</div>
    <div class="caption">p50 ${fmtMs(pp.p50)} · p90 ${fmtMs(pp.p90)} · ACTIVE · idle excluded</div>`;
}

function fileHotspotsHTML(d) {
  const fh = d.fileHotspots || [];
  const cov = d.coverage || {};
  if (fh.length === 0) return `<div class="caption">no file telemetry</div>`;
  const max = Math.max(1, ...fh.map((f) => f.count));
  return `<div class="bars">` + fh.map((f) => `
    <div class="barrow" title="${esc((f.fullPaths || [])[0] || f.basename)}">
      <span class="blabel">${esc(f.basename)}</span>
      <span class="bar" style="width:${logWidth(f.count, max).toFixed(0)}px"></span>
      <span class="bval num">${f.count}</span>
    </div>`).join('') + `</div>
    <div class="caption">⚠ SPARSE ${cov.fileRefs}/${cov.total} sessions with file refs · basename only</div>`;
}

function outcomesHTML(d) {
  const tiles = (d.digests || []).map((x) =>
    `<span class="tile ${x.outcome}" title="${esc(shortId(x.sessionId))} · ${x.outcome}" data-trace="${esc(x.sessionId)}">${STATUS_GLYPH[x.outcome] || '·'}</span>`).join('');
  return `<div class="outcomes-strip">${tiles}</div>`;
}

// ── 02 PATTERNS ──────────────────────────────────────────────────────────
function patternsHTML() {
  const d = state.data;
  let fps = (d.fingerprints || []).slice();
  if (!state.showNominal) fps = fps.filter((f) => f.isFailure);
  const recurring = fps.filter((f) => f.count >= 2);
  const singles = fps.filter((f) => f.count < 2);
  const max = Math.max(1, ...fps.map((f) => f.count));

  let rows = recurring.map((f, i) => fpRowHTML(f, max, i !== 0)).join('');
  rows += `<div class="fp-boundary">— RECURRING ↑   ONE-OFF ↓ —</div>`;
  if (state.longtailOpen) {
    rows += singles.map((f) => fpRowHTML(f, max, true)).join('');
  } else {
    rows += `<div class="longtail" id="longtail" role="button" tabindex="0">▸ LONG TAIL — ${singles.length} shapes seen once   [+ expand]</div>`;
  }

  const nominalCount = (d.fingerprints || []).filter((f) => !f.isFailure).length;
  return `
  <div class="grid">
    ${panel(`FINGERPRINT POWER-LAW · ${(d.fingerprints || []).length} SHAPES`,
      `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="toggle" id="show-nominal">${state.showNominal ? 'HIDE' : 'SHOW'} NOMINAL (${nominalCount})</button></div>
       <div class="fps" id="fps" role="listbox" aria-label="failure fingerprints">${rows}</div>`)}
    ${panel('INTERFACE', interfacePaneHTML())}
  </div>
  <div class="caption" style="margin-top:8px">hex is a copy-key, not a label (sha256 one-way) · arrow=rove · enter=interface</div>`;
}

// ── 03 TRACE ─────────────────────────────────────────────────────────────
function traceHTML() {
  if (!state.traceId) {
    return panel('TRACE', `<div class="caption">No session selected. Click a tile in the OUTCOMES strip, a CLI tile, or INSPECT TRACE on the anomaly banner.</div>`);
  }
  return `<div id="trace-mount">${panel('TRACE · ' + esc(shortId(state.traceId)), '<div class="caption">loading trace…</div>')}</div>`;
}

async function mountTrace() {
  const mount = document.getElementById('trace-mount');
  if (!mount) return;
  let trace;
  try {
    const res = await fetch(`/api/trace/${encodeURIComponent(state.traceId)}`);
    if (!res.ok) throw new Error(`trace ${res.status}`);
    trace = await res.json();
  } catch (e) {
    mount.innerHTML = panel('TRACE', `<div class="caption">trace not available: ${esc(String(e))}</div>`);
    return;
  }
  const events = trace.events || [];
  const firstUser = events.find((e) => e.kind === 'user_message');
  const firstFail = events.find((e) => e.kind === 'tool_result' && e.ok === false);
  const dig = (state.data.digests || []).find((x) => x.sessionId === trace.sessionId) || {};

  const frames = events.slice(0, 400).map((e) => {
    if (e.kind === 'tool_call') return `<span class="frame tool_call" title="${esc(e.toolName)}">▸</span>`;
    if (e.kind === 'tool_result') return e.ok
      ? `<span class="frame ok" title="ok">✓</span>`
      : `<span class="frame fail" title="${esc(e.errorClass || 'fail')}">✗</span>`;
    if (e.kind === 'error') return `<span class="frame error" title="${esc(e.errorClass || 'error')}">⚠</span>`;
    if (e.kind === 'file_change') return `<span class="frame file_change" title="${esc(basename(e.path || ''))}">◳</span>`;
    return '';
  }).join('');

  const files = [...new Set(events.filter((e) => e.kind === 'file_change').map((e) => basename(e.path || '')))].slice(0, 16);
  const loops = (dig.editLoops || []).slice(0, 6);
  const scrub = (trace.scrubbing?.passes || []).map((p) => p.reason).join(', ') || 'none';

  mount.innerHTML = `
  <button class="toggle" id="trace-back">← back to bridge</button>
  ${panel('DURATION · ASK · FIRST FAIL', `
    <div class="kv"><span class="k">DURATION</span><span><span class="dur-big">${fmtMs(dig.activeDurationMs)}</span> <span class="dur-wall">wall ${fmtMs(dig.durationMs)} ⚠ idle-spanned</span></span></div>
    <div class="kv"><span class="k">ASK</span><span class="ask">${esc(truncate(firstUser?.text, 240)) || '—'}</span></div>
    <div class="kv"><span class="k">FIRST FAIL</span><span class="fail">${firstFail ? '(' + esc(firstFail.errorClass || 'unknown') + ') ' + esc(truncate(firstFail.output, 200)) : '—'}</span></div>`)}
  ${panel('EVENT FILMSTRIP · seq-ordered · ' + events.length + ' events', `<div class="filmstrip">${frames}</div><div class="caption">a wall of ✗ at one seq band = the runaway · hover a frame for detail</div>`)}
  <div class="grid cols-2">
    ${panel('FILES TOUCHED', files.length ? files.map((f) => `<div class="barrow"><span class="blabel">${esc(f)}</span></div>`).join('') : '<div class="caption">none</div>')}
    ${panel('EDIT OSCILLATION · ' + (state.data.coverage?.editLoops ?? 0) + '/' + (state.data.coverage?.total ?? 0) + ' instrumented',
      loops.length ? loops.map((l) => `<div class="barrow"><span class="blabel">${esc(basename(l.path))}</span><span class="bval num">editCount ${l.editCount}</span></div>`).join('') : '<div class="caption">no oscillation recorded</div>')}
  </div>
  <button class="toggle" id="raw-json" style="margin-top:12px">{ } RAW JSON PEEK · scrubbing: ${esc(scrub)}</button>`;

  document.getElementById('trace-back')?.addEventListener('click', () => { state.channel = 'bridge'; render(); });
  document.getElementById('raw-json')?.addEventListener('click', () => openRawModal(trace, scrub));
}

function openRawModal(trace, scrub) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><div class="scrub">scrubbed: ${esc(scrub)} — verify before sharing</div><pre>${esc(JSON.stringify(trace, null, 2).slice(0, 20000))}</pre></div>`;
  bg.addEventListener('click', () => bg.remove());
  document.body.appendChild(bg);
}

// ── INTERFACE interaction ─────────────────────────────────────────────────
async function interfaceQuery(fp) {
  state.selectedFp = fp;
  document.querySelectorAll('.fprow').forEach((el) => el.setAttribute('aria-selected', String(el.dataset.fp === fp)));
  const pane = document.getElementById('interface');
  if (!pane) return;
  const reduced = state.motion === 'reduce';
  const bucket = (state.data.fingerprints || []).find((f) => f.fp === fp);

  pane.innerHTML = `<div class="line prompt">&gt; INTERFACING WITH PATTERN ${esc(fp.slice(0, 12))}…${reduced ? '' : '<span class="caret"></span>'}</div>`;
  if (!reduced) await sleep(380);

  let r;
  try {
    r = await fetch(`/api/replay/${encodeURIComponent(fp)}`).then((x) => x.json());
  } catch (e) {
    pane.innerHTML += `<div class="line fail">interface error: ${esc(String(e))}</div>`;
    return;
  }
  const p = parseReplay(r.markdown || '');
  pane.innerHTML = `
    <div class="line prompt">&gt; PATTERN ${esc(fp.slice(0, 12))}  [${r.matchCount} sessions]</div>
    <div class="line meta">DECODED: ${esc(bucket?.label || '—')}</div>
    ${p.ask ? `<div class="line"><span class="meta">ASK: </span><span class="ask">${esc(p.ask)}</span></div>` : ''}
    ${p.fail ? `<div class="line"><span class="meta">FIRST FAIL: </span><span class="fail">${esc(p.fail)}</span></div>` : ''}
    ${p.tools ? `<div class="line meta">TOOLS: ${esc(p.tools)}</div>` : ''}
    ${p.files ? `<div class="line meta">FILES: ${esc(p.files)}</div>` : ''}
    ${p.active ? `<div class="line meta">${esc(p.active)}</div>` : ''}
    <button class="replay-btn" data-replay-open="${esc(fp)}">⟳ REPLAY THIS FIX</button>`;
}

function parseReplay(md) {
  const out = {};
  const ask = md.match(/- ask:\s*(.+)/);
  if (ask) out.ask = ask[1].trim();
  const fail = md.match(/- first failure \(`(.+?)`\):\s*(.+)/);
  if (fail) out.fail = `(${fail[1]}) ${fail[2].trim()}`;
  const active = md.match(/- \*\*Active duration:\*\*\s*(.+)/);
  if (active) out.active = `ACTIVE ${active[1].replace(/\*/g, '').trim()}`;
  const toolLines = [...md.matchAll(/- `([^`]+)` × (\d+)/g)].slice(0, 5).map((m) => `${m[1]}×${m[2]}`);
  if (toolLines.length) out.tools = toolLines.join('  ');
  const fileSection = md.split('## Files touched')[1] || '';
  const fileLines = [...fileSection.matchAll(/- `([^`]+)`/g)].slice(0, 4).map((m) => basename(m[1]));
  if (fileLines.length) out.files = fileLines.join(' · ');
  return out;
}

async function openReplayModal(fp) {
  let r;
  try { r = await fetch(`/api/replay/${encodeURIComponent(fp)}`).then((x) => x.json()); }
  catch (e) { return; }
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><div class="scrub">REPLAY ${esc(fp.slice(0, 12))} · ${r.matchCount} sessions · read-only drill-down (no agent execution)</div><pre>${esc(r.markdown || '')}</pre></div>`;
  bg.addEventListener('click', () => bg.remove());
  document.body.appendChild(bg);
}

// ── Wiring ──────────────────────────────────────────────────────────────
function wire(app) {
  document.getElementById('rescan')?.addEventListener('click', async () => {
    try { state.data = await fetchOverview(); } catch (e) { state.data = { __error: String(e) }; }
    render();
  });
  document.getElementById('t-crt')?.addEventListener('click', () => {
    state.crt = state.crt === 'on' ? 'off' : 'on';
    localStorage.setItem('aladeen.crt', state.crt);
    document.documentElement.dataset.crt = state.crt;
    render();
  });
  document.getElementById('t-motion')?.addEventListener('click', () => {
    state.motion = state.motion === 'reduce' ? 'full' : 'reduce';
    localStorage.setItem('aladeen.motion', state.motion);
    document.documentElement.dataset.motion = state.motion;
    render();
  });
  app.querySelectorAll('[data-chan]').forEach((b) =>
    b.addEventListener('click', () => { state.channel = b.dataset.chan; render(); if (state.channel === 'trace') mountTrace(); }));

  // channel-scoped wiring
  app.querySelectorAll('.fprow').forEach((row) => {
    row.addEventListener('click', () => interfaceQuery(row.dataset.fp));
    row.addEventListener('keydown', (ev) => onRowKey(ev, row));
  });
  document.getElementById('show-nominal')?.addEventListener('click', () => { state.showNominal = !state.showNominal; render(); });
  document.getElementById('longtail')?.addEventListener('click', () => { state.longtailOpen = true; render(); });
  document.getElementById('ack')?.addEventListener('click', () => {
    const banner = app.querySelector('.priority');
    const sig = banner?.dataset.sig;
    if (sig) { state.acked.add(sig); localStorage.setItem('aladeen.acked', JSON.stringify([...state.acked])); render(); }
  });
  app.querySelectorAll('[data-trace]').forEach((el) =>
    el.addEventListener('click', () => { state.traceId = el.dataset.trace; state.channel = 'trace'; render(); mountTrace(); }));
  app.querySelectorAll('[data-chan-cli]').forEach((el) => {
    const go = () => { state.channel = 'patterns'; state.showNominal = true; render(); };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
  });
  // event delegation for dynamically-built replay buttons
  app.addEventListener('click', (ev) => {
    const open = ev.target.closest?.('[data-replay-open]');
    if (open) openReplayModal(open.dataset.replayOpen);
    const repFp = ev.target.closest?.('[data-replay-fp]');
    if (repFp && state.data?.verdict?.anomalies?.[0]) {
      // anomaly REPLAY: jump to patterns and interface the runaway bucket
      const sid = state.data.verdict.anomalies[0].sessionId;
      const bucket = (state.data.fingerprints || []).find((f) => f.sampleSessionId === sid) ||
        (state.data.fingerprints || []).find((f) => f.outcome === 'gave_up');
      state.channel = 'patterns'; state.showNominal = true; render();
      if (bucket) interfaceQuery(bucket.fp);
    }
  });
}

function onRowKey(ev, row) {
  const rows = [...document.querySelectorAll('.fprow')];
  const i = rows.indexOf(row);
  if (ev.key === 'ArrowDown') { ev.preventDefault(); focusRow(rows, i + 1); }
  else if (ev.key === 'ArrowUp') { ev.preventDefault(); focusRow(rows, i - 1); }
  else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); interfaceQuery(row.dataset.fp); }
}
function focusRow(rows, i) {
  if (i < 0 || i >= rows.length) return;
  rows.forEach((r) => (r.tabIndex = -1));
  rows[i].tabIndex = 0;
  rows[i].focus();
}

// ── utils ───────────────────────────────────────────────────────────────
function panel(title, body) {
  return `<section class="panel"><span class="br-bl"></span><span class="br-br"></span><h2>${esc(title)}</h2>${body}</section>`;
}
function shortId(id) {
  const s = String(id).replace(/^[a-z]+:/, '');
  return s.length > 10 ? s.slice(0, 8) : s;
}
function truncate(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ── go ──────────────────────────────────────────────────────────────────
initPrefs();
boot();
