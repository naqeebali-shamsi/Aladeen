import { describe, it, expect } from 'vitest';
import { renderRemedyCard, TIER_LABEL } from './remedy-card.js';

// renderRemedyCard is the honesty surface a human/agent actually reads. Two invariants,
// previously verified only by manual screenshots, are pinned here:
//   1. VERB DISCIPLINE — only the known-fix tier asserts a fix; medium/low add no "fix".
//   2. ESCAPING — session-derived strings (ask, paths) are escaped before innerHTML.

const FP = '2fcd8f35a91bdeadbeef';

function base(over = {}) {
  return {
    tier: 'none', nFailed: 0, nResolved: 0,
    guardrail: 'placeholder guardrail',
    coverageNote: 'Coverage across 199 sessions: filesChanged 22/199.',
    ruleMatches: [], resolvedSiblings: [],
    ...over,
  };
}

describe('TIER_LABEL', () => {
  it('labels medium as LEAD (never "likely"), and only known-fix says FIX', () => {
    expect(TIER_LABEL['known-fix']).toBe('KNOWN FIX');
    expect(TIER_LABEL.medium).toBe('LEAD');
    expect(TIER_LABEL.low).toBe('THIN');
    expect(TIER_LABEL.none).toBe('NONE');
  });
});

describe('renderRemedyCard — known-fix tier', () => {
  const html = renderRemedyCard(base({
    tier: 'known-fix', nFailed: 1, nResolved: 0,
    guardrail: 'This shape matches a solved bug; confirm before acting. Aladeen does not run it.',
    ruleMatches: [{
      headline: 'A git worktree without its deps.',
      remedyText: 'Install dependencies inside the worktree before running gates.',
      citations: [{ file: 'src/blueprints/implement-feature.ts', lines: '88-99', what: 'bootstrap-deps node' }],
    }],
  }), '0bf55f47e07870a4');

  it('shows the KNOWN FIX badge, the rule, and the citation', () => {
    expect(html).toContain('KNOWN FIX');
    expect(html).toContain('Install dependencies inside the worktree');
    expect(html).toContain('src/blueprints/implement-feature.ts:88-99');
    expect(html).toContain('bootstrap-deps node');
  });
  it('prints denominators and a RAW DRILL-DOWN link', () => {
    expect(html).toContain('n_failed=1 · n_resolved=0');
    expect(html).toContain('RAW DRILL-DOWN');
    expect(html).toContain('data-replay-open="0bf55f47e07870a4"');
  });
});

describe('renderRemedyCard — verb discipline on evidence tiers', () => {
  // Guardrail deliberately contains NO "fix" — proving the CLIENT adds none of its own
  // for medium/low (the word may only originate server-side on the known-fix tier).
  const medium = renderRemedyCard(base({
    tier: 'medium', nFailed: 21, nResolved: 21,
    guardrail: 'n=21 resolved session(s) shared this shape — a lead, judge it yourself. Aladeen does not run anything.',
    resolvedSiblings: [
      { ask: 'set up the booking flow', sharedTools: ['shell_command', 'apply_patch'], hasFileTelemetry: false, changeShaped: [] },
    ],
  }), FP);

  it('the medium card never introduces the word "fix"', () => {
    expect(medium).not.toMatch(/fix/i);
  });
  it('renders the LEAD badge, ASK, DID, and the honest no-telemetry line', () => {
    expect(medium).toContain('LEAD');
    expect(medium).toContain('set up the booking flow');
    expect(medium).toContain('shell_command → apply_patch');
    expect(medium).toContain('no file telemetry for this session');
  });
  it('low tier likewise introduces no "fix"', () => {
    const low = renderRemedyCard(base({
      tier: 'low', nFailed: 3, nResolved: 1,
      guardrail: 'Weak signal: only n=1 resolved session shares this shape. Treat it as a lead.',
      resolvedSiblings: [{ ask: 'do the thing', sharedTools: ['Bash'], hasFileTelemetry: true, changeShaped: [{ path: '/r/a.ts', linesAdded: 5, linesRemoved: 1 }] }],
    }), FP);
    expect(low).not.toMatch(/fix/i);
    expect(low).toContain('THIN');
    expect(low).toContain('a.ts (+5/-1)'); // change-shaped, basename only
    expect(low).toContain('no diff stored');
  });
});

describe('renderRemedyCard — escaping (XSS guard)', () => {
  it('escapes a script payload in a sibling ask', () => {
    const html = renderRemedyCard(base({
      tier: 'low', nFailed: 1, nResolved: 1,
      guardrail: 'a lead, judge it yourself',
      resolvedSiblings: [{ ask: '<script>alert(1)</script>', sharedTools: [], hasFileTelemetry: false, changeShaped: [] }],
    }), FP);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('escapes a malicious file path basename', () => {
    const html = renderRemedyCard(base({
      tier: 'low', nFailed: 1, nResolved: 1,
      guardrail: 'a lead',
      resolvedSiblings: [{ ask: '', sharedTools: [], hasFileTelemetry: true, changeShaped: [{ path: '/r/<img src=x onerror=1>.ts' }] }],
    }), FP);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('renderRemedyCard — denominators always present', () => {
  it('every tier prints n_failed and n_resolved', () => {
    for (const tier of ['known-fix', 'medium', 'low', 'none']) {
      const html = renderRemedyCard(base({ tier, nFailed: 7, nResolved: 2, guardrail: 'g' }), FP);
      expect(html).toContain('n_failed=7');
      expect(html).toContain('n_resolved=2');
      expect(html).toContain('RAW DRILL-DOWN');
    }
  });
});
