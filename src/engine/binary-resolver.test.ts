import { describe, it, expect, beforeEach } from 'vitest';
import { findBinaryWith, resolveBinaryWith, _resetBinaryResolverCache } from './binary-resolver.js';

beforeEach(() => _resetBinaryResolverCache());

describe('resolveBinaryWith', () => {
  it('returns input unchanged on non-Windows platforms', () => {
    const out = resolveBinaryWith('claude', 'linux', ['/usr/bin'], ['.exe'], () => true);
    expect(out).toBe('claude');
  });

  it('returns input unchanged when it already has an extension', () => {
    const out = resolveBinaryWith('claude.exe', 'win32', ['C:/bin'], ['.EXE'], () => true);
    expect(out).toBe('claude.exe');
  });

  it('returns input unchanged when it is an absolute path', () => {
    const out = resolveBinaryWith('C:\\bin\\claude', 'win32', ['C:/bin'], ['.cmd'], () => true);
    expect(out).toBe('C:\\bin\\claude');
  });

  it('returns input unchanged when it contains a path separator', () => {
    const out = resolveBinaryWith('./claude', 'win32', ['C:/bin'], ['.cmd'], () => true);
    expect(out).toBe('./claude');
  });

  it('finds a .CMD shim on Windows and returns the absolute path', () => {
    const exists = (p: string) => p === 'C:\\Program Files\\nodejs\\claude.cmd';
    const out = resolveBinaryWith(
      'claude',
      'win32',
      ['C:\\Other', 'C:\\Program Files\\nodejs'],
      ['.exe', '.cmd'],
      exists,
    );
    expect(out).toBe('C:\\Program Files\\nodejs\\claude.cmd');
  });

  it('prefers .EXE over .CMD when both exist (PATHEXT order)', () => {
    const exists = (p: string) => p.endsWith('claude.exe') || p.endsWith('claude.cmd');
    const out = resolveBinaryWith(
      'claude',
      'win32',
      ['C:\\bin'],
      ['.exe', '.cmd'],
      exists,
    );
    expect(out).toBe('C:\\bin\\claude.exe');
  });

  it('walks PATH directories in order until a match is found', () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return p === 'C:\\third\\claude.cmd';
    };
    const out = resolveBinaryWith(
      'claude',
      'win32',
      ['C:\\first', 'C:\\second', 'C:\\third'],
      ['.cmd'],
      exists,
    );
    expect(out).toBe('C:\\third\\claude.cmd');
    expect(seen).toEqual([
      'C:\\first\\claude.cmd',
      'C:\\second\\claude.cmd',
      'C:\\third\\claude.cmd',
    ]);
  });

  it('falls back to the bare name when nothing is found (lets spawn fail naturally)', () => {
    const out = resolveBinaryWith('not-installed', 'win32', ['C:\\bin'], ['.exe'], () => false);
    expect(out).toBe('not-installed');
  });

  it('skips empty PATH entries', () => {
    const exists = (p: string) => p === 'C:\\bin\\claude.cmd';
    const out = resolveBinaryWith('claude', 'win32', ['', 'C:\\bin', ''], ['.cmd'], exists);
    expect(out).toBe('C:\\bin\\claude.cmd');
  });

  it('findBinaryWith finds bare commands on non-Windows PATH entries', () => {
    const out = findBinaryWith('claude', 'linux', ['/usr/local/bin', '/usr/bin'], ['.exe'], (p) => p === '/usr/bin/claude');
    expect(out).toBe('/usr/bin/claude');
  });

  it('findBinaryWith returns null when a bare command is missing', () => {
    const out = findBinaryWith('not-installed', 'linux', ['/usr/bin'], ['.exe'], () => false);
    expect(out).toBeNull();
  });

  it('findBinaryWith returns null when a qualified command path is missing', () => {
    const out = findBinaryWith('/opt/bin/claude', 'linux', ['/usr/bin'], ['.exe'], () => false);
    expect(out).toBeNull();
  });
});
