import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/**
 * Resolve a CLI binary name to an absolute path on Windows.
 *
 * Node's child_process.spawn auto-resolves only .exe extensions on Windows;
 * tools installed via npm (claude, codex, gemini, npx) ship as .cmd shims,
 * so spawn('claude', ...) returns ENOENT. This helper walks PATH using
 * PATHEXT and returns the first match — so spawn can be called without
 * shell:true (which would force us to escape prompt strings for cmd.exe).
 *
 * No-op on non-Windows or when the input already has an extension or path
 * separator. Resolutions are cached for the process lifetime.
 */

const cache = new Map<string, string>();

export function resolveBinary(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const resolved = resolveBinaryWith(
    name,
    process.platform,
    (process.env['PATH'] ?? '').split(delimiter),
    parsePathExt(process.env['PATHEXT']),
    existsSync,
  );
  cache.set(name, resolved);
  return resolved;
}

/** Test seam: pure function, no I/O outside the supplied `exists` callback. */
export function resolveBinaryWith(
  name: string,
  platform: NodeJS.Platform,
  pathDirs: string[],
  pathExts: string[],
  exists: (p: string) => boolean,
): string {
  // Already qualified (extension or path) → trust the caller.
  if (extname(name) !== '' || isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return name;
  }
  // Non-Windows: spawn already handles PATH lookup correctly.
  if (platform !== 'win32') return name;

  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of pathExts) {
      const candidate = join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  // Fallback: let spawn fail naturally so the error message stays familiar.
  return name;
}

function parsePathExt(raw: string | undefined): string[] {
  return (raw ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((s) => s.length > 0);
}

/** Test-only: clear the cache between cases. */
export function _resetBinaryResolverCache(): void {
  cache.clear();
}
