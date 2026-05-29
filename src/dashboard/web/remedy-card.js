import { esc, basename } from './lib.js';

// Pure string builder for the REMEDY card (extracted from app.js so it is importable
// and unit-testable without app.js's DOM bootstrap). Field names match remedy.ts exactly.
//
// Two invariants this module is responsible for and remedy-card.test.ts pins:
//   1. VERB DISCIPLINE — the word "fix" appears only on the known-fix tier (and inside the
//      guardrail's literal "not a fix"); the evidence tiers (medium/low) never assert a fix.
//   2. ESCAPING — every dynamic, session-derived string (ask, file path, guardrail, citations)
//      is run through esc() before it lands in innerHTML. This is the dashboard's XSS guard.

// Badge words must never carry more confidence than the templated guardrail. Only known-fix
// asserts a fix; 'medium' is a LEAD, not 'likely'.
export const TIER_LABEL = { 'known-fix': 'KNOWN FIX', medium: 'LEAD', low: 'THIN', none: 'NONE' };

export function renderRemedyCard(r, fp) {
  const lines = [];
  const badge = `<span class="remedy-badge tier-${esc(r.tier)}">${TIER_LABEL[r.tier] || 'NONE'}</span>`;
  lines.push(`<div class="line prompt">&gt; REMEDY · ${esc(fp.slice(0, 12))} ${badge}`
    + `  [n_failed=${r.nFailed} · n_resolved=${r.nResolved}]</div>`);
  lines.push(`<div class="line remedy-guardrail">${esc(r.guardrail)}</div>`); // verbatim, never edited

  if (r.tier === 'known-fix' && (r.ruleMatches || []).length) {
    const rm = r.ruleMatches[0];
    lines.push(`<div class="line"><span class="meta">KNOWN FIX: </span>`
      + `<span class="ask">${esc(rm.headline)} ${esc(rm.remedyText)}</span></div>`);
    const cites = (rm.citations || []).map((c) => `${esc(c.file)}:${esc(c.lines)} (${esc(c.what)})`).join(' · ');
    if (cites) lines.push(`<div class="line meta">EVIDENCE: ${cites}</div>`);
  }

  if (r.tier === 'medium' || r.tier === 'low') {        // verb discipline: never emit 'fix' here
    for (const s of (r.resolvedSiblings || [])) {       // already capped at 3 upstream
      if (s.ask) lines.push(`<div class="line"><span class="meta">ASK: </span>`
        + `<span class="ask">${esc(s.ask)}</span></div>`);
      if (s.sharedTools && s.sharedTools.length)
        lines.push(`<div class="line meta">DID: ${esc(s.sharedTools.join(' → '))}</div>`);
      if (s.hasFileTelemetry && s.changeShaped && s.changeShaped.length) {
        const files = s.changeShaped.slice(0, 4).map((f) => {
          const d = (f.linesAdded != null || f.linesRemoved != null)
            ? ` (+${f.linesAdded ?? 0}/-${f.linesRemoved ?? 0})` : '';
          return `${esc(basename(f.path))}${esc(d)}`;
        }).join(' · ');
        lines.push(`<div class="line meta change-shaped">FILES (change-shaped, no diff stored): ${files}</div>`);
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
