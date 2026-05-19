import { describe, expect, it } from 'vitest';
import { Scrubber } from './scrubber.js';

describe('Scrubber', () => {
  it('redacts known secret patterns', () => {
    const s = new Scrubber({ homeDir: '/home/test' });
    const cases = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEF12345',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk',
    ];
    for (const value of cases) {
      const { text } = s.scrubMessage(`token=${value} end`);
      expect(text).not.toContain(value);
      expect(text).toContain('[REDACTED:secret]');
    }
  });

  it('replaces the home directory in paths', () => {
    const s = new Scrubber({ homeDir: '/home/test' });
    const { text } = s.scrubMessage('opened /home/test/projects/foo/bar.ts');
    expect(text).toBe('opened ~/projects/foo/bar.ts');
  });

  it('handles win32 home paths with backslashes', () => {
    const s = new Scrubber({ homeDir: 'C:\\Users\\naqee' });
    const { text } = s.scrubMessage('wrote C:\\Users\\naqee\\projects\\foo.ts');
    expect(text).toBe('wrote ~\\projects\\foo.ts');
  });

  it('truncates shell output past the cap and emits a marker', () => {
    const s = new Scrubber({ maxOutputChars: 50 });
    const big = 'x'.repeat(200);
    const { text, appliedPasses } = s.scrubOutput(big);
    expect(text.length).toBeLessThan(big.length);
    expect(text).toContain('[REDACTED:shell-output');
    expect(appliedPasses.find((p) => p.reason === 'shell-output')?.count).toBe(1);
  });

  it('preserves non-string values in scrubArgs', () => {
    const s = new Scrubber();
    const out = s.scrubArgs({ count: 5, flag: true, path: '/home/foo', list: [1, 2] });
    expect(out['count']).toBe(5);
    expect(out['flag']).toBe(true);
    expect(out['list']).toEqual([1, 2]);
  });

  it('manifest declares applied scrubber passes with versions', () => {
    const s = new Scrubber();
    const manifest = s.manifest();
    const reasons = manifest.passes.map((p) => p.reason);
    expect(reasons).toContain('secret');
    expect(reasons).toContain('path-home');
    expect(reasons).toContain('shell-output');
    for (const p of manifest.passes) {
      expect(p.version).toMatch(/^\d+$/);
    }
  });
});
