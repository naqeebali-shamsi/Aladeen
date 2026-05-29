import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, posix, win32 } from 'node:path';

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

  // Keep the original spawn-time semantics: on non-Windows this is a bare-name passthrough (spawn
  // resolves PATH at exec time, honoring the executable bit). findBinaryWith — which eagerly
  // existsSync-resolves on every platform — is reserved for preflight (findBinary), where a missing
  // install must surface as null rather than a hopeful bare name.
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

/**
 * Resolve a CLI binary only when it exists on PATH.
 *
 * This is for preflight checks, where returning the bare command name would
 * hide a real missing-install blocker.
 */
export function findBinary(name: string): string | null {
  return findBinaryWith(
    name,
    process.platform,
    (process.env['PATH'] ?? '').split(delimiter),
    parsePathExt(process.env['PATHEXT']),
    existsSync,
  );
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

/** Test seam for preflight checks: returns null instead of a fallback name. */
export function findBinaryWith(
  name: string,
  platform: NodeJS.Platform,
  pathDirs: string[],
  pathExts: string[],
  exists: (p: string) => boolean,
): string | null {
  if (extname(name) !== '' || isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return exists(name) ? name : null;
  }

  const candidateExts = platform === 'win32' ? pathExts : [''];
  const joinPath = platform === 'win32' ? win32.join : posix.join;
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of candidateExts) {
      const candidate = joinPath(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }

  return null;
}

function parsePathExt(raw: string | undefined): string[] {
  return (raw ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((s) => s.length > 0);
}

/** Test-only: clear the cache between cases. */
export function _resetBinaryResolverCache(): void {
  cache.clear();
}
