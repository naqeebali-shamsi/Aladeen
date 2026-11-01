import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { SessionTrace } from '../observability/session-trace.js';
import { projectIdForPath, projectIdForTrace } from './scope.js';

function trace(provider: string, cwd: string, extras?: Record<string, unknown>): SessionTrace {
  return {
    schemaVersion: '1', sessionId: 'scope-fixture', agentCli: { name: provider },
    workspace: { cwdScrubbed: cwd }, outcome: 'completed', events: [],
    scrubbing: { passes: [{ reason: 'path-home', version: '2' }] }, ingesterExtras: extras,
  };
}

describe('projectIdForPath', () => {
  it('normalizes Windows case, separator, dot segments and trailing separators', () => {
    const id = projectIdForPath('N:\\Work\\Project\\');
    expect(id).toMatch(/^project:[a-f0-9]{64}$/);
    expect(projectIdForPath('n:/work/./project')).toBe(id);
    expect(projectIdForPath('N:/WORK/other/../project/')).toBe(id);
    expect(projectIdForPath('n:/work/project-two')).not.toBe(id);
  });

  it('keeps POSIX case and separate workspaces distinct', () => {
    expect(projectIdForPath('/workspace/Project/')).toBe(projectIdForPath('/workspace/./Project'));
    expect(projectIdForPath('/workspace/Project')).not.toBe(projectIdForPath('/workspace/project'));
    expect(projectIdForPath('/workspace/repo')).not.toBe(projectIdForPath('/workspace/repo/worktree'));
  });

  it('normalizes roots and UNC shares without conflating siblings', () => {
    expect(projectIdForPath('N:\\')).toBe(projectIdForPath('n:/'));
    expect(projectIdForPath('/')).toMatch(/^project:/);
    expect(projectIdForPath('\\\\SERVER\\Share\\Repo\\')).toBe(projectIdForPath('//server/share/repo'));
    expect(projectIdForPath('//server/share/repo')).not.toBe(projectIdForPath('//server/share-other/repo'));
  });

  it('matches scrubbed home paths to the current absolute home only at directory boundaries', () => {
    expect(projectIdForPath(path.join(os.homedir(), 'scope-fixture'))).toBe(projectIdForPath('~/scope-fixture'));
    expect(projectIdForPath(os.homedir())).toBe(projectIdForPath('~'));
    expect(projectIdForPath(os.homedir() + '-other/scope-fixture')).not.toBe(projectIdForPath('~/scope-fixture'));
    expect(projectIdForPath('~/../scope-other')).toBe(projectIdForPath(path.resolve(os.homedir(), '..', 'scope-other')));
  });

  it.each(['', '(unknown)', 'repo', 'N:relative', '\\rooted', '~other/repo', '~/...-encoded-path', '/x/[REDACTED:secret]', '/repo\nnext', '/repo\u0000next'])('refuses unknown, lossy or relative input %j', (input) => {
    expect(projectIdForPath(input)).toBeUndefined();
  });
});

describe('projectIdForTrace', () => {
  it('does not trust legacy home replacements embedded inside an absolute path', () => {
    const input = trace('codex', '/fixture/~/repo');
    input.scrubbing.passes = [{ reason: 'path-home', version: '1' }];
    expect(projectIdForTrace(input)).toBeUndefined();
  });

  it.each(['codex', 'opencode', 'aladeen'])('uses actual workspace cwd for %s instead of provider-specific hashes', (provider) => {
    const input = trace(provider, 'N:/scope-fixture');
    input.workspace.gitRepoNameHash = 'provider-specific-value';
    expect(projectIdForTrace(input)).toBe(projectIdForPath('N:/scope-fixture'));
  });
  it('requires explicit transcript provenance for Claude cwd', () => {
    expect(projectIdForTrace(trace('claude-code', 'N:/scope-fixture'))).toBeUndefined();
    expect(projectIdForTrace(trace('claude-code', 'N:/scope-fixture', { workspaceCwdSource: 'transcript' }))).toBe(projectIdForPath('N:/scope-fixture'));
    expect(projectIdForTrace(trace('claude-code', '~/...-encoded-path', { workspaceCwdSource: 'transcript' }))).toBeUndefined();
  });
  it('never treats OpenClaw agent storage or unsupported providers as a project', () => {
    expect(projectIdForTrace(trace('openclaw', '~/.openclaw/agents/fixture'))).toBeUndefined();
    expect(projectIdForTrace(trace('unknown', 'N:/scope-fixture'))).toBeUndefined();
  });
  it.each(['codex', 'opencode', 'aladeen', 'claude-code'])('holds legacy home-scrubbed %s identity until reingested with boundary-safe scrubbing', (provider) => {
    const input = trace(provider, '~/scope-fixture', { workspaceCwdSource: 'transcript' });
    input.scrubbing.passes = [{ reason: 'path-home', version: '1' }];
    expect(projectIdForTrace(input)).toBeUndefined();
    input.scrubbing.passes = [];
    expect(projectIdForTrace(input)).toBeUndefined();
    input.scrubbing.passes = [{ reason: 'path-home', version: '2' }];
    expect(projectIdForTrace(input)).toBe(projectIdForPath('~/scope-fixture'));
  });
});
