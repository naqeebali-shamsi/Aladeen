import * as React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BlueprintSchema } from './engine/types.js';
import type { Blueprint, ExecutionState } from './engine/types.js';
import { StatePersistence } from './engine/state.js';
import AladeenApp from './tui/App.js';
import SetupWizard from './tui/setup/SetupWizard.js';
import { createImplementFeatureLocalBlueprint } from './blueprints/index.js';
import { createLocalFirstRunnerOptions } from './engine/local-runner-options.js';
import { bucketFailures } from './engine/failure-buckets.js';
import { configExists, loadSecretsIntoEnv } from './config/index.js';
import os from 'node:os';
import { ClaudeCodeIngester } from './observability/ingest/claude-code.js';
import { computeDigest } from './observability/digest.js';
import { IngestStorage } from './observability/storage.js';
import { formatReport } from './observability/report.js';

const program = new Command();

program
  .name('aladeen')
  .version('0.1.0')
  .description('Aladeen - Autonomous agentic orchestration');

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
    render(<SetupWizard scope={opts.scope as 'global' | 'project'} repoRoot={opts.repoRoot} />);
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
        render(<SetupWizard repoRoot={opts.repoRoot} />);
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
      render(
        <AladeenApp
          blueprint={blueprint}
          resumeState={resumeState}
          repoRoot={opts.repoRoot}
          runnerOptions={runnerOptions}
        />
      );
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
    render(
      <AladeenApp
        blueprint={blueprint}
        repoRoot={opts.repoRoot}
        runnerOptions={runnerOptions}
      />
    );
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
    render(
      <AladeenApp
        blueprint={blueprint}
        resumeState={resumeState}
        repoRoot={opts.repoRoot}
        runnerOptions={runnerOptions}
      />
    );
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
  .description('Ingest agent CLI session logs (currently: claude-code)')
  .option('--path <path>', 'Path to a .jsonl file or a Claude Code project directory. Default: ~/.claude/projects/<encoded-cwd>')
  .option('--repo-root <path>', 'Repository root for storage', process.cwd())
  .option('--quiet', 'Suppress per-session output')
  .action(async (
    source: string,
    opts: { path?: string; repoRoot: string; quiet?: boolean },
  ) => {
    if (source !== 'claude-code') {
      console.error(`Unknown ingest source "${source}". Supported: claude-code`);
      process.exit(1);
    }

    const ingester = new ClaudeCodeIngester();
    const storage = new IngestStorage(opts.repoRoot);

    const targetPath = opts.path ?? defaultClaudeCodeProjectDir(opts.repoRoot);
    const targets = await resolveIngestTargets(targetPath, ingester);
    if (targets.length === 0) {
      console.error(`No .jsonl session files found at ${targetPath}`);
      process.exit(1);
    }

    if (!opts.quiet) {
      console.log(`Ingesting ${targets.length} session(s) from ${targetPath}\n`);
    }

    let okCount = 0;
    let warnCount = 0;
    for (const source of targets) {
      try {
        const result = await ingester.ingestFile(source);
        const digest = computeDigest(result.trace);
        await storage.writeTrace(result.trace);
        await storage.writeDigest(digest);
        okCount += 1;
        if (result.warnings.length > 0) {
          warnCount += result.warnings.length;
          if (!opts.quiet) {
            for (const w of result.warnings) console.warn(`  warn ${source.sessionId}: ${w}`);
          }
        }
        if (!opts.quiet) {
          const fails = digest.toolFailureCount > 0 ? ` (toolFails=${digest.toolFailureCount})` : '';
          console.log(`  ok  ${source.sessionId.padEnd(36)} events=${result.trace.events.length} outcome=${result.trace.outcome}${fails}`);
        }
      } catch (err) {
        console.error(`  err ${source.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`\nIngested ${okCount}/${targets.length} session(s). Warnings: ${warnCount}.`);
    console.log(`Run \`aladeen report\` to see failure patterns.`);
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
  .command('tui', { isDefault: true })
  .description('Launch the interactive multi-CLI TUI')
  .action(() => {
    console.clear();
    render(<AladeenApp />);
  });

// Encodes the cwd into the ~/.claude/projects/<encoded>/ folder name. The
// Claude Code convention replaces drive colons and path separators with '-'.
function defaultClaudeCodeProjectDir(repoRoot: string): string {
  const encoded = path.resolve(repoRoot).replace(/[\\/:]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
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
