import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { SessionTrace } from '../observability/session-trace.js';

// Project scope is lexical and local to this machine. No realpath/git probing:
// aliases and worktrees stay separate rather than guessing that they transfer.
// Hashing removes the readable path from lesson scope; it is not anonymization.
export function projectIdForPath(input: string): string | undefined {
  if (typeof input !== 'string' || !input || [...input].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return undefined;
  if (input === '(unknown)' || input.includes('[REDACTED:') || /^~[\\/]\.\.\./.test(input)) return undefined;

  const home = normalizeAbsolute(os.homedir());
  let normalized: string | undefined;
  if (input === '~' || /^~[\\/]/.test(input)) {
    if (!home) return undefined;
    // Expand before normalizing so ~/../other does not masquerade as home.
    normalized = normalizeAbsolute(input === '~' ? home : home.replace(/\/$/, '') + input.slice(1).replace(/\\/g, '/'));
  } else {
    normalized = normalizeAbsolute(input);
  }
  if (!normalized) return undefined;
  const inHome = home && (normalized === home || normalized.startsWith(home.endsWith('/') ? home : home + '/'));
  const suffix = home ? normalized.slice(home.length) : '';
  const canonical = inHome ? '~' + (suffix && !suffix.startsWith('/') ? '/' + suffix : suffix) : normalized;
  return 'project:' + createHash('sha256').update(canonical).digest('hex');
}

function normalizeAbsolute(input: string): string | undefined {
  const windows = /^[A-Za-z]:[\\/]/.test(input) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(input);
  if (windows) {
    const normalized = path.win32.normalize(input).replace(/\\/g, '/').toLowerCase();
    return /^[a-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, '');
  }
  if (!input.startsWith('/')) return undefined;
  const normalized = path.posix.normalize(input);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

export function projectIdForTrace(trace: SessionTrace): string | undefined {
  // v1 home scrubbing was case-insensitive on POSIX and lacked a directory
  // boundary. Its '~' cannot establish identity reliably; reingest required.
  if (trace.workspace.cwdScrubbed.includes('~')
    && !trace.scrubbing.passes.some((pass) => pass.reason === 'path-home'
      && /^\d+$/.test(pass.version) && Number(pass.version) >= 2)) return undefined;
  switch (trace.agentCli.name) {
    case 'claude-code':
      // Encoded project-directory names are lossy; only actual transcript
      // metadata can establish identity, including for nested subagent logs.
      if (trace.ingesterExtras?.workspaceCwdSource !== 'transcript') return undefined;
      return projectIdForPath(trace.workspace.cwdScrubbed);
    case 'codex':
    case 'opencode':
    case 'aladeen':
      return projectIdForPath(trace.workspace.cwdScrubbed);
    default:
      // OpenClaw currently exposes agent-storage identity, not project cwd.
      return undefined;
  }
}
