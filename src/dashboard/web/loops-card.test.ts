import { describe, it, expect } from 'vitest';
import { renderLoopsCard, MECH_LABEL } from './loops-card.js';

// renderLoopsCard is the surface a human reads in the dashboard. Two invariants:
//   1. ESCAPING — session-derived strings (label, command, rationale) are escaped.
//   2. HONESTY — the guardrail renders verbatim; the card asserts nothing extra.

function candidate(over = {}) {
  return {
    label: 'review the open pull requests',
    class: 'recurring',
    mechanism: 'loop-interval',
    command: '/loop 2h review the open pull requests',
    rationale: 'Polls external state across 5 sessions.',
    sessionCount: 5,
    providers: ['codex', 'claude-code'],
    safety: 'read-only',
    cadence: { spanDays: 12, medianGapHours: 2, shape: 'irregular' },
    sessionIds: ['a', 'b', 'c'],
    exemplars: ['review the open pull requests'],
    ...over,
  };
}

function report(over = {}) {
  return {
    candidates: [candidate()],
    sessionsScanned: 199,
    humanAsksFound: 144,
    noiseFiltered: 12,
    guardrail: 'Aladeen suggests loop automations; it never creates or runs them.',
    coverageNote: 'Inferred from the first human ask of 144/199 sessions.',
    ...over,
  };
}

describe('MECH_LABEL', () => {
  it('labels each mechanism', () => {
    expect(MECH_LABEL['loop-self-paced']).toContain('/loop');
    expect(MECH_LABEL['loop-interval']).toContain('/loop');
    expect(MECH_LABEL.schedule).toBe('/schedule');
    expect(MECH_LABEL['loop-md']).toBe('.claude/loop.md');
  });
});

describe('renderLoopsCard', () => {
  it('renders the candidate label, mechanism, command, cadence and safety', () => {
    const html = renderLoopsCard(report());
    expect(html).toContain('LOOP CANDIDATES · 1 found');
    expect(html).toContain('review the open pull requests');
    expect(html).toContain('/loop · interval');
    expect(html).toContain('/loop 2h review the open pull requests');
    expect(html).toContain('5×');
    expect(html).toContain('codex, claude-code');
    expect(html).toContain('read-only');
  });

  it('renders the guardrail verbatim and the coverage note', () => {
    const html = renderLoopsCard(report());
    expect(html).toContain('it never creates or runs them');
    expect(html).toContain('Inferred from the first human ask');
  });

  it('shows an honest empty state when nothing recurs', () => {
    const html = renderLoopsCard(report({ candidates: [] }));
    expect(html).toContain('LOOP CANDIDATES · 0 found');
    expect(html).toContain('No recurring workflow cleared the recurrence floor');
  });

  it('escapes an XSS payload in the label, command, and rationale', () => {
    const html = renderLoopsCard(report({
      candidates: [candidate({
        label: '<script>alert(1)</script>',
        command: '/loop <img src=x onerror=1>',
        rationale: '<b>boom</b>',
      })],
    }));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>boom</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });

  it('tolerates a candidate with no clock (single-occurrence timing)', () => {
    const html = renderLoopsCard(report({
      candidates: [candidate({ cadence: { spanDays: 0, medianGapHours: null, shape: 'unknown' } })],
    }));
    expect(html).toContain('no clock');
  });
});
