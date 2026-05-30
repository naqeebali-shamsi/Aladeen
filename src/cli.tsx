#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BlueprintSchema } from './engine/types.js';
import type { Blueprint, ExecutionState } from './engine/types.js';
import { StatePersistence } from './engine/state.js';
import { createImplementFeatureLocalBlueprint } from './blueprints/index.js';
import { createLocalFirstRunnerOptions } from './engine/local-runner-options.js';
import { bucketFailures } from './engine/failure-buckets.js';
import { configExists, loadSecretsIntoEnv } from './config/index.js';
import os from 'node:os';
import { ClaudeCodeIngester } from './observability/ingest/claude-code.js';
import { OpencodeIngester } from './observability/ingest/opencode.js';
import { AladeenRunsIngester } from './observability/ingest/aladeen-runs.js';
import { CodexIngester } from './observability/ingest/codex.js';
import { OpenClawIngester } from './observability/ingest/openclaw.js';
import { IngestStorage } from './observability/storage.js';
import { formatReport } from './observability/report.js';
import { replayFingerprint } from './observability/replay.js';
import { suggestRemedy } from './observability/remedy.js';
import { runIngestPipeline } from './observability/ingest-runner.js';

// The interactive TUI and blueprint runner pull in Ink/React and the optional
// native `node-pty` dependency (which has no Linux prebuild). Load them lazily so
// the observability commands (ingest/report/replay/remedy) and the MCP server run
// even when node-pty isn't installed; only the interactive commands require it.
async function loadTui(): Promise<typeof import('./tui/launch.js')> {
  try {
    return await import('./tui/launch.js');
  } catch (err) {
    console.error(
      'The interactive UI and blueprint runner need the optional "node-pty" dependency, which is not installed.\n' +
        'Reinstall on a machine with a C/C++ build toolchain (Python 3 + make + g++ on Linux), or just use the\n' +
        'observability commands — ingest, report, replay, remedy — and the `aladeen-mcp` server, which do not need it.\n' +
        `\nUnderlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

const program = new Command();

program
  .name('aladeen')
  .version('0.1.0')
  .description('Observability + learning layer for agent CLIs. Ingest session logs, surface failure patterns, replay known-good blueprints.');

program
  .command('setup')
  .description('Interactive provider setup wizard (detect, auth, smoke-test, save config)')
  .option('--scope <scope>', 'Where to save config: global or project', 'global')
  .option('--repo-root <path>', 'Repository root for project-scoped config', process.cwd())
  .action(async (opts: { scope: string; repoRoot: string }) => {
    if (opts.scope !== 'global' && opts.scope !== 'project') {
      console.error(`Invalid --scope "${opts.scope}". Use "global" or "project".`);
      process.exit(1);
    }
    console.clear();
    (await loadTui()).launchSetup({ scope: opts.scope as 'global' | 'project', repoRoot: opts.repoRoot });
  });

program
  .command('run <blueprint>')
  .description('Load, validate, and execute a blueprint JSON file')
  .option('--resume <runId>', 'Resume a previously persisted run')
  .option('--repo-root <path>', 'Repository root for state persistence', process.cwd())
  .option('--local-first', 'Use local-first runner (context assembly, model router, heuristic evaluator)')
  .option('--skip-setup-check', 'Skip the first-run setup-wizard prompt')
  .action(async (
    blueprintPath: string,
    opts: { resume?: string; repoRoot: string; localFirst?: boolean; skipSetupCheck?: boolean },
  ) => {
    try {
      // First-run experience: if no config exists, hand off to setup wizard
      await loadSecretsIntoEnv();
      if (!opts.skipSetupCheck && !(await configExists(opts.repoRoot))) {
        console.clear();
        (await loadTui()).launchSetup({ repoRoot: opts.repoRoot });
        return;
      }

      // Load blueprint
      const resolved = path.resolve(blueprintPath);
      const raw = await readFile(resolved, 'utf-8');
      const parsed = JSON.parse(raw);
      const result = BlueprintSchema.safeParse(parsed);

      if (!result.success) {
        console.error('Invalid blueprint:');
        for (const issue of result.error.issues) {
          console.error(`  ${issue.path.join('.')}: ${issue.message}`);
        }
        process.exit(1);
      }

      const blueprint: Blueprint = result.data as Blueprint;

      // Optionally load resume state
      let resumeState: ExecutionState | undefined;
      if (opts.resume) {
        const persistence = new StatePersistence(opts.repoRoot);
        try {
          resumeState = await persistence.load(opts.resume);
          console.log(`Resuming run ${opts.resume}`);
        } catch (err) {
          console.error(`Failed to load run state for "${opts.resume}": ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      }

      const runnerOptions = opts.localFirst ? createLocalFirstRunnerOptions(opts.repoRoot) : undefined;
      console.clear();
      (await loadTui()).launchApp({
        blueprint,
        resumeState,
        repoRoot: opts.repoRoot,
        runnerOptions,
      });
    } catch (err) {
      console.error(`Failed to load blueprint: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('run-local-feature <taskId>')
  .description('Run the canonical local-only implement-feature blueprint')
  .requiredOption('--prompt <text>', 'Feature prompt to implement')
  .option('--adapter <id>', 'Local adapter id', 'local-ollama')
  .option('--base-branch <branch>', 'Base branch', 'main')
  .option('--repo-root <path>', 'Repository root for state persistence', process.cwd())
  .action(async (
    taskId: string,
    opts: { prompt: string; adapter: string; baseBranch: string; repoRoot: string }
  ) => {
    const blueprint = createImplementFeatureLocalBlueprint({
      taskId,
      prompt: opts.prompt,
      adapterId: opts.adapter,
      repoRoot: opts.repoRoot,
      baseBranch: opts.baseBranch,
    });
    const runnerOptions = createLocalFirstRunnerOptions(opts.repoRoot);
    console.clear();
    (await loadTui()).launchApp({
      blueprint,
      repoRoot: opts.repoRoot,
      runnerOptions,
    });
  });

program
  .command('resume <runId>')
  .description('Resume a saved run with a supplied blueprint file')
  .requiredOption('--blueprint <path>', 'Path to blueprint JSON used for the run')
  .option('--repo-root <path>', 'Repository root', process.cwd())
  .option('--local-first', 'Use local-first runner options')
  .action(async (runId: string, opts: { blueprint: string; repoRoot: string; localFirst?: boolean }) => {
    const persistence = new StatePersistence(opts.repoRoot);
    const resumeState = await persistence.load(runId);
    const raw = await readFile(path.resolve(opts.blueprint), 'utf-8');
    const parsed = JSON.parse(raw);
    const result = BlueprintSchema.safeParse(parsed);
    if (!result.success) {
      console.error('Invalid blueprint provided for resume.');
      process.exit(1);
    }
    const blueprint: Blueprint = result.data as Blueprint;
    const runnerOptions = opts.localFirst ? createLocalFirstRunnerOptions(opts.repoRoot) : undefined;
    console.clear();
    (await loadTui()).launchApp({
      blueprint,
      resumeState,
      repoRoot: opts.repoRoot,
      runnerOptions,
    });
  });

program
  .command('inspect-run <runId>')
  .description('Print detailed run status and quality metadata')
  .option('--repo-root <path>', 'Repository root', process.cwd())
  .action(async (runId: string, opts: { repoRoot: string }) => {
    const persistence = new StatePersistence(opts.repoRoot);
    const state = await persistence.load(runId);
    console.log(`Run:       ${state.runId}`);
    console.log(`Blueprint: ${state.blueprintId}`);
    console.log(`Status:    ${state.status}`);
    console.log(`Started:   ${state.startedAt}`);
    console.log(`Completed: ${state.completedAt ?? 'in progress'}`);
    console.log(`Retries:   ${state.totalRetries}`);
    if (state.runPolicy) {
      console.log(`Mode:      ${state.runPolicy.mode}`);
      console.log(`Cloud FB:  ${state.runPolicy.cloudFallbackAllowed ? 'enabled' : 'disabled'}`);
    }
    if (state.quality?.evaluatorOverall !== undefined) {
      console.log(`Eval:      ${state.quality.evaluatorOverall}`);
    }
    if (state.escalationReason) {
      console.log(`Escalated: ${state.escalationReason}`);
    }
  });

program
  .command('list-runs')
  .description('List saved blueprint runs from .aladeen/runs/')
  .option('--repo-root <path>', 'Repository root', process.cwd())
  .option('--no-sweep', 'Skip the stale-run sweep (default: sweep before listing)')
  .action(async (opts: { repoRoot: string; sweep: boolean }) => {
    const persistence = new StatePersistence(opts.repoRoot);

    if (opts.sweep) {
      const swept = await persistence.sweepStale();
      if (swept.length > 0) {
        console.log(`Marked ${swept.length} stale run(s) as abandoned:`);
        for (const id of swept) console.log(`  ${id}`);
        console.log('');
      }
    }

    const runs = await persistence.list();
    if (runs.length === 0) {
      console.log('No saved runs found.');
      return;
    }

    console.log(`Found ${runs.length} run(s):\n`);
    for (const state of runs) {
      console.log(`  ${state.runId}`);
      console.log(`    Blueprint: ${state.blueprintId}`);
      console.log(`    Status:    ${state.status}`);
      console.log(`    Started:   ${state.startedAt}`);
      console.log(`    Completed: ${state.completedAt ?? 'in progress'}`);
      if (state.escalationReason) {
        console.log(`    Reason:    ${state.escalationReason.slice(0, 120)}`);
      }
      console.log('');
    }
  });

program
  .command('failure-patterns')
  .description('Group failed/escalated/abandoned runs by (nodeId, outcome) to surface dominant failure modes')
  .option('--repo-root <path>', 'Repository root', process.cwd())
  .action(async (opts: { repoRoot: string }) => {
    const persistence = new StatePersistence(opts.repoRoot);
    const runs = await persistence.list();
    const buckets = bucketFailures(runs);

    if (buckets.length === 0) {
      console.log(runs.length === 0 ? 'No saved runs found.' : `All ${runs.length} run(s) completed cleanly — no failure patterns.`);
      return;
    }

    console.log(`Found ${buckets.length} failure pattern(s) across ${runs.length} run(s):\n`);
    for (const b of buckets) {
      const location = b.nodeId === '__run__' ? 'run-level' : `node "${b.nodeId}"`;
      console.log(`  [${b.count}×] ${b.outcome} at ${location}`);
      console.log(`    Sample runs: ${b.sampleRunIds.join(', ')}`);
      if (b.sampleErrors.length > 0) {
        console.log(`    Sample error: ${b.sampleErrors[0]}`);
      }
      console.log('');
    }
  });

program
  .command('ingest <source>')
  .description('Ingest agent CLI session logs (supported: claude-code, opencode, codex, openclaw, aladeen-runs)')
  .option('--path <path>', 'Source-specific path override. Defaults: claude-code=~/.claude/projects/<encoded-cwd>; opencode=~/.local/share/opencode/opencode.db; codex=~/.codex/sessions; openclaw=~/.openclaw; aladeen-runs=<repoRoot>/.aladeen/runs')
  .option('--repo-root <path>', 'Repository root for storage', process.cwd())
  .option('--quiet', 'Suppress per-session output')
  .action(async (
    source: string,
    opts: { path?: string; repoRoot: string; quiet?: boolean },
  ) => {
    const storage = new IngestStorage(opts.repoRoot);

    if (source === 'claude-code') {
      const ingester = new ClaudeCodeIngester();
      const targetPath = opts.path ?? defaultClaudeCodeProjectDir(opts.repoRoot);
      const targets = await resolveIngestTargets(targetPath, ingester);
      if (targets.length === 0) {
        console.error(`No .jsonl session files found at ${targetPath}`);
        process.exit(1);
      }
      await runIngestPipeline({
        sourceLabel: 'claude-code',
        sourcePath: targetPath,
        targets,
        ingestOne: (t) => ingester.ingestFile(t),
        displayId: (t) => t.sessionId,
        storage,
        quiet: opts.quiet,
      });
      return;
    }

    if (source === 'opencode') {
      const ingester = new OpencodeIngester();
      const dbPath = opts.path ?? defaultOpencodeDbPath();
      let sessions;
      try {
        sessions = await ingester.listSessions(dbPath);
      } catch (err) {
        console.error(`Failed to read opencode DB at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      if (sessions.length === 0) {
        console.error(`No sessions found in ${dbPath}`);
        process.exit(1);
      }
      await runIngestPipeline({
        sourceLabel: 'opencode',
        sourcePath: dbPath,
        targets: sessions,
        ingestOne: (s) => ingester.ingestSession(dbPath, s),
        displayId: (s) => `opencode:${s.id}`,
        storage,
        quiet: opts.quiet,
      });
      return;
    }

    if (source === 'codex') {
      const ingester = new CodexIngester();
      const rootDir = opts.path ?? path.join(os.homedir(), '.codex', 'sessions');
      const files = await ingester.listSessions(rootDir);
      if (files.length === 0) {
        console.error(`No rollout-*.jsonl session files found under ${rootDir}`);
        process.exit(1);
      }
      await runIngestPipeline({
        sourceLabel: 'codex',
        sourcePath: rootDir,
        targets: files,
        ingestOne: (f) => ingester.ingestFile(f),
        displayId: (f, result) => result?.trace.sessionId ?? path.basename(f),
        storage,
        quiet: opts.quiet,
      });
      return;
    }

    if (source === 'openclaw') {
      const ingester = new OpenClawIngester();
      const rootPath = opts.path ?? path.join(os.homedir(), '.openclaw');
      const sources = await ingester.listSessions(rootPath);
      if (sources.length === 0) {
        console.error(`No session files found at ${path.join(rootPath, 'agents', '<id>', 'sessions')}`);
        process.exit(1);
      }
      await runIngestPipeline({
        sourceLabel: 'openclaw',
        sourcePath: rootPath,
        targets: sources,
        ingestOne: (s) => ingester.ingestFile(s),
        displayId: (s, result) => result?.trace.sessionId ?? `openclaw:${s.sessionId}`,
        storage,
        quiet: opts.quiet,
      });
      return;
    }

    if (source === 'aladeen-runs') {
      const ingester = new AladeenRunsIngester();
      const runsDir = opts.path ?? path.join(opts.repoRoot, '.aladeen', 'runs');
      const files = await ingester.listRunFiles(runsDir);
      if (files.length === 0) {
        console.error(`No run files found at ${runsDir}`);
        process.exit(1);
      }
      await runIngestPipeline({
        sourceLabel: 'aladeen',
        sourcePath: runsDir,
        itemLabel: 'run',
        targets: files,
        ingestOne: (f) => ingester.ingestFile(f),
        displayId: (f, result) => result?.trace.sessionId ?? path.basename(f),
        storage,
        quiet: opts.quiet,
        printWarnings: true,
      });
      return;
    }

    console.error(`Unknown ingest source "${source}". Supported: claude-code, opencode, codex, openclaw, aladeen-runs`);
    process.exit(1);
  });

program
  .command('report')
  .description('Print failure pattern report from ingested sessions')
  .option('--repo-root <path>', 'Repository root', process.cwd())
  .option('--all', 'Include successful sessions in the per-session table')
  .option('--limit <n>', 'Max sessions in per-session table', '20')
  .action(async (opts: { repoRoot: string; all?: boolean; limit: string }) => {
    const storage = new IngestStorage(opts.repoRoot);
    const digests = await storage.listDigests();
    const limit = Number.parseInt(opts.limit, 10);
    console.log(formatReport(digests, {
      failuresOnly: !opts.all,
      limitSessions: Number.isFinite(limit) ? limit : 20,
    }));
  });

program
  .command('replay <fingerprint>')
  .description('Drill into all sessions matching a patternFingerprint (prefix match when unambiguous)')
  .option('--repo-root <path>', 'Repository root', process.cwd())
  .option('--max-sessions <n>', 'Max sessions to deep-load', '10')
  .action(async (fp: string, opts: { repoRoot: string; maxSessions: string }) => {
    const storage = new IngestStorage(opts.repoRoot);
    const max = Number.parseInt(opts.maxSessions, 10);
    const result = await replayFingerprint(fp, storage, {
      maxDeepLoad: Number.isFinite(max) ? max : 10,
    });
    if (result.matchedDigests.length === 0) {
      console.error(result.markdown);
      process.exit(1);
    }
    console.log(result.markdown);
  });

program
  .command('remedy <fingerprint>')
  .description('Suggest a read-only remedy for a failing fingerprint: a known-fix pointer when the shape is a solved bug, else prior sessions of the same shape that later completed. Suggests, never executes.')
  .option('--repo-root <path>', 'Repository root', process.cwd())
  .option('--max-samples <n>', 'Max resolved siblings to deep-load for evidence', '3')
  .action(async (fp: string, opts: { repoRoot: string; maxSamples: string }) => {
    const storage = new IngestStorage(opts.repoRoot);
    const max = Number.parseInt(opts.maxSamples, 10);
    const result = await suggestRemedy(fp, storage, {
      maxResolvedSamples: Number.isFinite(max) ? max : 3,
    });
    // No bucket matched at all → error exit (mirrors `replay`). A matched bucket
    // with tier 'none' is a valid, successful answer (prints the honest no-remedy markdown).
    if (result.failingDigests.length === 0) {
      console.error(result.markdown);
      process.exit(1);
    }
    console.log(result.markdown);
  });

program
  .command('dashboard')
  .description('Open the local Aladeen dashboard (retro sci-fi control center; reads .aladeen/ingested, 100% local)')
  .option('--repo-root <path>', 'Repository root that owns .aladeen/ingested', process.cwd())
  .option('--port <n>', 'Port to bind on 127.0.0.1 (0 = pick a free port)', '4173')
  .option('--no-open', 'Do not auto-open the browser; just print the URL')
  .action(async (opts: { repoRoot: string; port: string; open: boolean }) => {
    const { startDashboardServer } = await import('./dashboard/server.js');
    const { openBrowser } = await import('./dashboard/open-browser.js');
    const storage = new IngestStorage(opts.repoRoot);
    const { url, close } = await startDashboardServer({
      storage,
      host: '127.0.0.1',
      port: Number.parseInt(opts.port, 10) || 0,
      repoRoot: opts.repoRoot,
    });
    console.log(`\n  ◢ ALADEEN online → ${url}`);
    console.log(`    100% local · 127.0.0.1 · Ctrl-C to stop\n`);
    if (opts.open) await openBrowser(url);
    const shutdown = () => { close().finally(() => process.exit(0)); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('tui', { isDefault: true })
  .description('Launch the interactive multi-CLI TUI')
  .action(async () => {
    console.clear();
    (await loadTui()).launchApp();
  });

// Encodes the cwd into the ~/.claude/projects/<encoded>/ folder name. The
// Claude Code convention replaces drive colons and path separators with '-'.
function defaultClaudeCodeProjectDir(repoRoot: string): string {
  const encoded = path.resolve(repoRoot).replace(/[\\/:]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

function defaultOpencodeDbPath(): string {
  // SST opencode stores its global DB under XDG_DATA_HOME (defaults to
  // ~/.local/share on linux/macOS; on Windows the bash shim resolves
  // $HOME to %USERPROFILE%, which mirrors the same layout).
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

async function resolveIngestTargets(
  targetPath: string,
  ingester: ClaudeCodeIngester,
): Promise<Array<{ sessionId: string; filePath: string; parentSessionId?: string }>> {
  const { stat } = await import('node:fs/promises');
  let info;
  try {
    info = await stat(targetPath);
  } catch {
    return [];
  }
  if (info.isFile()) {
    return [{
      sessionId: path.basename(targetPath).replace(/\.jsonl$/, ''),
      filePath: targetPath,
    }];
  }
  if (info.isDirectory()) {
    return ingester.listSessions(targetPath);
  }
  return [];
}

program.parse(process.argv);
