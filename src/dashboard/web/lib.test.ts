import { describe, it, expect } from 'vitest';
import {
  logWidth, fmtMs, fmtCompact, pct, basename, esc,
  STATUS_GLYPH, ERR_GLYPH, CLI_PIC, cliColor,
} from './lib.js';

// The dashboard client is buildless vanilla ESM served to the browser; these are its
// pure, load-bearing helpers. esc() is the SOLE XSS guard for session-derived strings
// (asks, file paths) injected via innerHTML — so it gets the most scrutiny.

describe('esc — the XSS guard', () => {
  it('escapes all five HTML-significant characters', () => {
    expect(esc('<')).toBe('&lt;');
    expect(esc('>')).toBe('&gt;');
    expect(esc('&')).toBe('&amp;');
    expect(esc('"')).toBe('&quot;');
    expect(esc("'")).toBe('&#39;');
  });

  it('neutralizes a script-injection payload', () => {
    const out = esc('<script>alert("xss")</script>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes & FIRST so entities are not double-escaped', () => {
    // '<' must become '&lt;', never '&amp;lt;'
    expect(esc('a < b & c')).toBe('a &lt; b &amp; c');
  });

  it('treats null/undefined as empty string', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(0)).toBe('0');
  });
});

describe('logWidth — the chart primitive', () => {
  it('floors at min when n is 0', () => {
    expect(logWidth(0, 100)).toBe(40);
  });
  it('reaches min+span when n === max', () => {
    expect(logWidth(100, 100)).toBeCloseTo(360, 5); // 40 + 320
  });
  it('is monotonically increasing in n', () => {
    expect(logWidth(10, 100)).toBeLessThan(logWidth(50, 100));
    expect(logWidth(50, 100)).toBeLessThan(logWidth(100, 100));
  });
  it('guards a non-positive max (returns min, no NaN/Infinity)', () => {
    expect(logWidth(5, 0)).toBe(40);
    expect(Number.isFinite(logWidth(5, 100))).toBe(true);
  });
  it('honors custom min/span', () => {
    expect(logWidth(0, 100, 10, 200)).toBe(10);
  });
});

describe('fmtMs', () => {
  it('formats across the unit boundaries', () => {
    expect(fmtMs(5000)).toBe('5s');
    expect(fmtMs(65000)).toBe('1m05s');
    expect(fmtMs(3_600_000)).toBe('1h00m');
    expect(fmtMs(90_000_000)).toBe('1d01h');
  });
  it('renders an em-dash for null/undefined', () => {
    expect(fmtMs(null)).toBe('—');
    expect(fmtMs(undefined)).toBe('—');
  });
});

describe('fmtCompact', () => {
  it('compacts thousands and millions', () => {
    expect(fmtCompact(999)).toBe('999');
    expect(fmtCompact(4197)).toBe('4.2k');
    expect(fmtCompact(11102)).toBe('11k');
    expect(fmtCompact(1_500_000)).toBe('1.5M');
  });
});

describe('pct', () => {
  it('formats a ratio to one decimal percent', () => {
    expect(pct(0.538)).toBe('53.8%');
    expect(pct(0)).toBe('0.0%');
    expect(pct(1)).toBe('100.0%');
  });
});

describe('basename', () => {
  it('handles Windows and POSIX paths', () => {
    expect(basename('N:\\Aladeen\\src\\cli.tsx')).toBe('cli.tsx');
    expect(basename('/home/u/p/index.ts')).toBe('index.ts');
    expect(basename('bare.ts')).toBe('bare.ts');
  });
});

describe('glyph + color maps', () => {
  it('maps the load-bearing status + error glyphs', () => {
    expect(STATUS_GLYPH.completed).toBe('●');
    expect(STATUS_GLYPH.gave_up).toBe('○');
    expect(ERR_GLYPH.worktree_collision).toBe('⟳');
    expect(CLI_PIC.codex).toBeTruthy();
  });
  it('falls back to primary for an unknown CLI', () => {
    expect(cliColor('codex')).toBe('var(--cli-codex)');
    expect(cliColor('nope')).toBe('var(--primary)');
  });
});
