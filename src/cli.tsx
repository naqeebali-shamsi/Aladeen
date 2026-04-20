import * as React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BlueprintSchema } from './engine/types.js';
import type { Blueprint, ExecutionState } from './engine/types.js';
import { StatePersistence } from './engine/state.js';
import AladeenApp from './tui/App.js';
import { createImplementFeatureLocalBlueprint } from './blueprints/index.js';
import { createLocalFirstRunnerOptions } from './engine/local-runner-options.js';

const program = new Command();

program
  .name('aladeen')
  .version('0.1.0')
  .description('Aladeen - Autonomous agentic orchestration');

program
  .command('run <blueprint>')
  .description('Load, validate, and execute a blueprint JSON file')
  .option('--resume <runId>', 'Resume a previously persisted run')
  .option('--repo-root <path>', 'Repository root for state persistence', process.cwd())
  .option('--local-first', 'Use local-first runner (context assembly, model router, heuristic evaluator)')
  .action(async (blueprintPath: string, opts: { resume?: string; repoRoot: string; localFirst?: boolean }) => {
    try {
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
  .command('tui', { isDefault: true })
  .description('Launch the interactive multi-CLI TUI')
  .action(() => {
    console.clear();
    render(<AladeenApp />);
  });

program.parse(process.argv);
