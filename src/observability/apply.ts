import path from 'node:path';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crossSpawn from 'cross-spawn';
import { WorktreeManager } from '../isolation/worktree.js';
import { runnableFix } from './remedy.js';
import type { RemedyResult } from './remedy.js';

// Apply — the OPT-IN, ISOLATED executor for runnable Class-A remedies (the curated playbook).
//
// Boundary (deliberate, on-brand): Aladeen is an observability layer — it reads logs AFTER the
// fact and is NOT in your agent's execution loop. So it never re-runs your agent. It only repairs
// the repo/environment STATE that tripped it (Class A), inside a throwaway git worktree, and hands
// back a change summary. Your working tree is never touched and nothing is merged automatically.
//
// remedy.ts stays PURE; ALL side effects (worktree, spawn, git) live here, behind injected deps so
// the orchestration is unit-testable without touching the filesystem. `runnableFix` (in remedy.ts)
// is the single gate on what may run.

const execFileAsync = promisify(execFile);

export interface InstallPlan {
  manager: 'pnpm' | 'yarn' | 'bun' | 'npm';
  command: string;
  args: string[];
}

export interface CommandResult { exitCode: number; stdout: string; stderr: string; }

export interface ApplyDeps {
  /** Detect the install plan for a node project dir, or null if there's no package.json. */
  detectInstall: (dir: string) => Promise<InstallPlan | null>;
  /** Create an isolated worktree of the target repo; return its path + a cleanup fn. */
  makeWorktree: (taskId: string) => Promise<{ path: string; cleanup: () => Promise<void> }>;
  /** Run a command in cwd (Windows-safe). */
  run: (command: string, args: string[], cwd: string) => Promise<CommandResult>;
  /** Human-readable summary of tracked-file changes in cwd (git status + diffstat). */
  changeSummary: (cwd: string) => Promise<string>;
}

export interface ApplyOptions {
  keepWorktree?: boolean;   // --keep: leave the worktree on disk for inspection
  taskId?: string;          // deterministic override (tests); else derived from rule + fp
}

export interface ApplyResult {
  runnable: boolean;        // was this a runnable Class-A fix at all?
  applied: boolean;         // did we actually execute it?
  reason?: string;          // honest explanation when not runnable / not applied
  fixId?: string;           // matched rule id
  fixKind?: string;
  command?: string;         // the exact command line that ran
  exitCode?: number;
  stdoutTail?: string;
  stderrTail?: string;
  changeSummary?: string;   // what the fix produced (tracked-file changes)
  worktreePath?: string;
  worktreeKept: boolean;
  markdown: string;         // honest human render
}

const TAIL = 1600;
function tail(s: string, n = TAIL): string {
  const t = s.trim();
  return t.length <= n ? t : '…' + t.slice(t.length - n);
}

function sanitizeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export async function applyRemedy(
  result: RemedyResult,
  opts: ApplyOptions,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const match = runnableFix(result);
  if (!match) {
    const reason = result.tier === 'known-fix'
      ? 'This known-fix is Class B (agent guidance) — tuning the agent\'s own loop, not repo state — '
        + 'so Aladeen cannot honestly run it. Actuate agent guidance with `aladeen lessons --apply`.'
      : `Remedy tier is ${result.tier.toUpperCase()}, not a runnable known-fix. Aladeen runs only `
        + 'proven Class-A environment repairs — this is a read-only suggestion; review it and act yourself.';
    return notRunnable(result, reason);
  }
  const { rule, fix } = match;

  if (fix.kind !== 'install-deps') {
    return notRunnable(result, `Fix kind '${fix.kind}' has no executor yet (apply.ts knows: install-deps).`);
  }

  const taskId = opts.taskId
    ?? `remedy-${rule.id}-${sanitizeId(result.fingerprint).slice(0, 12) || 'fp'}-${nowSuffix()}`;

  let worktree: { path: string; cleanup: () => Promise<void> } | null = null;
  try {
    worktree = await deps.makeWorktree(taskId);
  } catch (err) {
    // The fix WAS runnable; the isolated environment just couldn't be set up. Report honestly as
    // runnable-but-not-applied (not "not runnable"), and confirm the real tree was never touched.
    const reason = `Could not create an isolated worktree (${describeErr(err)}). The target must be a clean git repo.`;
    const md = [
      `# Apply ${result.fingerprint}`, '',
      `**Not applied** (${rule.id} · ${fix.kind}) — ${reason}`, '',
      '_No worktree was created; your working tree was never touched._', '',
    ].join('\n');
    return { runnable: true, applied: false, reason, fixId: rule.id, fixKind: fix.kind, worktreeKept: false, markdown: md };
  }

  let kept = false;
  try {
    const plan = await deps.detectInstall(worktree.path);
    if (!plan) {
      return finalizeNotApplied(result, rule.id, fix.kind, worktree.path,
        'No package.json in the target repo — the install-deps fix does not apply here.');
    }

    const cmdLine = `${plan.command} ${plan.args.join(' ')}`.trim();
    const cmd = await deps.run(plan.command, plan.args, worktree.path);
    const changes = await deps.changeSummary(worktree.path);
    kept = !!opts.keepWorktree;

    return finalizeApplied({
      result, fixId: rule.id, fixKind: fix.kind, fixSummary: fix.summary, note: fix.note,
      command: cmdLine, manager: plan.manager, cmd, changes,
      worktreePath: worktree.path, kept,
    });
  } finally {
    if (worktree && !kept) {
      try { await worktree.cleanup(); } catch { /* best-effort; reported as kept:false */ }
    }
  }
}

// --- renders ----------------------------------------------------------------

function notRunnable(result: RemedyResult, reason: string): ApplyResult {
  const md = [
    `# Apply ${result.fingerprint}`, '',
    '**Not applied** — nothing was run.', '',
    reason, '',
  ].join('\n');
  return { runnable: false, applied: false, reason, worktreeKept: false, markdown: md };
}

function finalizeNotApplied(
  result: RemedyResult, fixId: string, fixKind: string, worktreePath: string, reason: string,
): ApplyResult {
  const md = [
    `# Apply ${result.fingerprint}`, '',
    `**Not applied** (${fixId} · ${fixKind}) — ${reason}`, '',
    '_Isolated worktree was created and removed; your working tree was never touched._', '',
  ].join('\n');
  return { runnable: true, applied: false, reason, fixId, fixKind, worktreePath, worktreeKept: false, markdown: md };
}

interface AppliedArgs {
  result: RemedyResult; fixId: string; fixKind: string; fixSummary: string; note: string;
  command: string; manager: string; cmd: CommandResult; changes: string;
  worktreePath: string; kept: boolean;
}
function finalizeApplied(a: AppliedArgs): ApplyResult {
  const ok = a.cmd.exitCode === 0;
  const md: string[] = [];
  md.push(`# Apply ${a.result.fingerprint}`, '');
  md.push(`**${ok ? 'Applied' : 'Ran (non-zero exit)'}** · ${a.fixId} · ${a.fixKind}`, '');
  md.push(`> ${a.note}`, '');
  md.push('## What ran');
  md.push(`- **${a.fixSummary}**`);
  md.push(`- command: \`${a.command}\` (${a.manager})`);
  md.push(`- isolated worktree: \`${a.worktreePath}\`${a.kept ? ' _(kept --keep)_' : ' _(removed after capture)_'}`);
  md.push(`- exit code: **${a.cmd.exitCode}**`, '');
  md.push('## Change summary (worktree only — nothing merged)');
  md.push('```');
  md.push(a.changes || '(none)');
  md.push('```', '');
  if (a.cmd.stderr.trim()) {
    md.push('<details><summary>stderr tail</summary>', '', '```', tail(a.cmd.stderr), '```', '', '</details>', '');
  }
  md.push(ok
    ? '> Review the change summary above, then apply it to your tree yourself (or re-run with `--keep` to inspect the worktree). Aladeen does not merge.'
    : '> The fix command exited non-zero — treat this as a lead, not a confirmed repair. Your tree is unchanged.');
  return {
    runnable: true, applied: true, reason: undefined,
    fixId: a.fixId, fixKind: a.fixKind, command: a.command, exitCode: a.cmd.exitCode,
    stdoutTail: tail(a.cmd.stdout), stderrTail: tail(a.cmd.stderr), changeSummary: a.changes,
    worktreePath: a.worktreePath, worktreeKept: a.kept, markdown: md.join('\n'),
  };
}

// --- default real deps (used by the CLI) ------------------------------------

function nowSuffix(): string {
  // Regular runtime code (not a workflow script) — Date.now is fine here. Disambiguates worktree
  // ids across repeated applies so WorktreeManager never throws WORKTREE_EXISTS.
  return Date.now().toString(36);
}

function describeErr(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.message : String(err);
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function detectInstallPlan(dir: string): Promise<InstallPlan | null> {
  if (!(await exists(path.join(dir, 'package.json')))) return null;
  if (await exists(path.join(dir, 'pnpm-lock.yaml'))) return { manager: 'pnpm', command: 'pnpm', args: ['install'] };
  if (await exists(path.join(dir, 'yarn.lock')))      return { manager: 'yarn', command: 'yarn', args: ['install'] };
  if (await exists(path.join(dir, 'bun.lockb')) || await exists(path.join(dir, 'bun.lock')))
    return { manager: 'bun', command: 'bun', args: ['install'] };
  return { manager: 'npm', command: 'npm', args: ['install'] };
}

export function defaultApplyDeps(targetRepo: string): ApplyDeps {
  return {
    detectInstall: detectInstallPlan,
    makeWorktree: async (taskId) => {
      // linkNodeModules:false — the whole point is a REAL install; junctioning the main repo's
      // node_modules would both defeat the demo and let an install mutate the real tree via the link.
      const wm = new WorktreeManager(targetRepo, { linkNodeModules: false });
      const info = await wm.create(taskId);
      return { path: info.path, cleanup: () => wm.remove(taskId) };
    },
    run: (command, args, cwd) => new Promise<CommandResult>((resolve) => {
      const child = crossSpawn(command, args, { cwd, env: process.env });
      let out = '', err = '';
      child.stdout?.on('data', (d) => { out += String(d); });
      child.stderr?.on('data', (d) => { err += String(d); });
      child.on('error', (e) => resolve({ exitCode: 127, stdout: out, stderr: `${err}\n${String(e)}`.trim() }));
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout: out, stderr: err }));
    }),
    changeSummary: async (cwd) => {
      try {
        const status = await execFileAsync('git', ['status', '--porcelain'], { cwd });
        if (!status.stdout.trim()) {
          return '(no tracked-file changes — install matched the committed lockfile; deps are now '
            + 'present in the worktree, which is what the failing session lacked)';
        }
        const stat = await execFileAsync('git', ['diff', '--stat'], { cwd });
        return `${status.stdout.trim()}\n\n${stat.stdout.trim()}`.trim();
      } catch (e) {
        return `(could not compute change summary: ${describeErr(e)})`;
      }
    },
  };
}
