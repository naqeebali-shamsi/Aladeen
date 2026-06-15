import { esc } from './lib.js';

// Pure string builder for the LOOPS card (extracted so it is importable and
// unit-testable without app.js's DOM bootstrap). Field names match loops.ts
// (LoopReport / LoopCandidate) exactly.
//
// Invariants loops-card.test.ts pins:
//   1. ESCAPING — every dynamic, session-derived string (label, command,
//      rationale, providers, coverageNote) is run through esc() before it
//      lands in innerHTML. This is the dashboard's XSS guard. The suggested
//      command is derived from the user's OWN prior asks, so it is untrusted.
//   2. HONESTY — the guardrail is rendered verbatim, never edited; the card
//      adds no confidence the analyzer did not.

export const MECH_LABEL = {
  'loop-self-paced': '/loop · self-paced',
  'loop-interval': '/loop · interval',
  schedule: '/schedule',
  'loop-md': '.claude/loop.md',
};

// 'ask-cluster' = near-identical repeated ask (precise); 'intent' = same KIND of
// task across days (coarse). Short tags for the badge line.
const SRC_TAG = { 'ask-cluster': 'ask', intent: 'intent' };

export function renderLoopsCard(report) {
  const cands = report.candidates || [];
  const lines = [];
  lines.push(`<div class="line prompt">&gt; LOOP CANDIDATES · ${cands.length} found`
    + `  [${report.humanAsksFound ?? 0} human asks · ${report.noiseFiltered ?? 0} fixtures filtered]</div>`);
  lines.push(`<div class="line remedy-guardrail">${esc(report.guardrail || '')}</div>`); // verbatim

  if (cands.length === 0) {
    lines.push('<div class="line meta">No recurring workflow cleared the recurrence floor yet.</div>');
    lines.push(`<div class="line meta">${esc(report.coverageNote || '')}</div>`);
    return lines.join('');
  }

  cands.forEach((c, i) => {
    const cad = c.cadence && c.cadence.medianGapHours != null
      ? `${esc(c.cadence.shape)} · span ${Math.round(c.cadence.spanDays || 0)}d`
      : 'no clock';
    const mech = MECH_LABEL[c.mechanism] || c.mechanism;
    lines.push(`<div class="line"><span class="loop-badge mech-${esc(c.mechanism)}">${esc(mech)}</span>`
      + ` <span class="loop-src">[${esc(SRC_TAG[c.source] || c.source || 'ask')}]</span>`
      + ` <span class="ask">${esc(c.label)}</span></div>`);
    lines.push(`<div class="line meta">${c.sessionCount}× · ${esc((c.providers || []).join(', '))} · ${cad} · `
      + `<span class="safety-${esc(c.safety)}">${esc(c.safety)}</span></div>`);
    lines.push(`<div class="line"><span class="meta">RUN: </span><code class="loop-cmd">${esc(c.command)}</code></div>`);
    lines.push(`<div class="line meta">${esc(c.rationale)}</div>`);
    if (i < cands.length - 1) lines.push('<div class="line loop-sep">· · ·</div>');
  });

  lines.push(`<div class="line meta">${esc(report.coverageNote || '')}</div>`);
  return lines.join('');
}
