#!/usr/bin/env tsx
/**
 * Run a blueprint end-to-end with worktree isolation.
 *
 * Usage:
 *   npx tsx scripts/run-blueprint.ts blueprints/implement-feature.json [--task-id my-task] [--base-branch main]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { BlueprintRunner } from '../src/engine/runner.js';
import { BlueprintSchema } from '../src/engine/types.js';
import type { Blueprint, BlueprintNode, NodeResult, ExecutionState } from '../src/engine/types.js';
import { WorktreeManager } from '../src/isolation/worktree.js';

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const blueprintPath = args.find((a) => !a.startsWith('--'));
const taskId = getArg('--task-id') ?? `run-${Date.now()}`;
const baseBranch = getArg('--base-branch') ?? 'HEAD';

if (!blueprintPath) {
  console.error('Usage: npx tsx scripts/run-blueprint.ts <blueprint.json> [--task-id ID] [--base-branch BRANCH]');
  process.exit(1);
}

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

// ─── Logging Helpers ─────────────────────────────────────────────────────────

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

function log(msg: string) {
  console.log(`${DIM}[aladeen]${RESET} ${msg}`);
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case 'success': return GREEN;
    case 'failure': return RED;
    case 'retry': return YELLOW;
    default: return RESET;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const repoRoot = path.resolve(process.cwd());
  const absoluteBlueprintPath = path.resolve(blueprintPath!);

  log(`${BOLD}Aladeen Blueprint Runner${RESET}`);
  log(`Blueprint: ${CYAN}${absoluteBlueprintPath}${RESET}`);
  log(`Task ID:   ${CYAN}${taskId}${RESET}`);
  log(`Repo root: ${CYAN}${repoRoot}${RESET}`);
  log('');

  // 1. Load and validate blueprint JSON
  log('Loading blueprint...');
  const raw = await readFile(absoluteBlueprintPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const result = BlueprintSchema.safeParse(parsed);
  if (!result.success) {
    console.error('Blueprint validation failed:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  const blueprint: Blueprint = result.data;
  log(`Loaded "${blueprint.name}" v${blueprint.version} (${blueprint.nodes.length} nodes, ${blueprint.edges.length} edges)`);

  // 2. Create worktree
  log('');
  log(`Creating worktree for task "${taskId}"...`);
  const worktreeMgr = new WorktreeManager(repoRoot);
  let worktreeInfo;
  try {
    worktreeInfo = await worktreeMgr.create(taskId, baseBranch);
    log(`Worktree created at ${CYAN}${worktreeInfo.path}${RESET}`);
    log(`Branch: ${CYAN}${worktreeInfo.branch}${RESET}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to create worktree: ${msg}`);
    process.exit(1);
  }

  // 3. Patch blueprint for worktree execution
  const patchedBlueprint = patchForWorktree(blueprint, worktreeInfo.path, repoRoot);

  // 4. Run the blueprint
  log('');
  log(`${BOLD}Starting blueprint execution...${RESET}`);
  log('');

  const startTime = Date.now();

  const runner = new BlueprintRunner({
    repoRoot,
    hooks: {
      onNodeStart: (nodeId: string, node: BlueprintNode) => {
        log(`${CYAN}>>>${RESET} ${BOLD}${node.label}${RESET} ${DIM}(${nodeId})${RESET}`);
      },
      onNodeComplete: (nodeId: string, nodeResult: NodeResult) => {
        const color = outcomeColor(nodeResult.outcome);
        const duration = `${nodeResult.durationMs.toFixed(0)}ms`;
        log(`${color}<<<${RESET} ${nodeResult.outcome.toUpperCase()} ${DIM}(${duration})${RESET} ${nodeResult.summary ?? nodeResult.error ?? ''}`);
        if (nodeResult.outcome !== 'success' && nodeResult.output.stderr) {
          const stderr = String(nodeResult.output.stderr).slice(0, 200);
          log(`    ${RED}${stderr}${RESET}`);
        }
        log('');
      },
      onEscalation: (reason: string) => {
        log(`${RED}${BOLD}ESCALATION:${RESET} ${reason}`);
      },
    },
  });

  let finalState: ExecutionState;
  try {
    // Inject NODE_PATH so worktree can resolve modules from the main repo,
    // and add repo's node_modules/.bin to PATH for tool binaries.
    const nodeModulesPath = path.join(repoRoot, 'node_modules');
    const binPath = path.join(nodeModulesPath, '.bin');
    const existingPath = process.env['PATH'] ?? '';

    finalState = await runner.run(patchedBlueprint, {
      cwd: worktreeInfo.path,
      env: {
        NODE_PATH: nodeModulesPath,
        PATH: `${binPath}${path.delimiter}${existingPath}`,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Blueprint execution error: ${msg}`);
    await cleanup(worktreeMgr, taskId);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 5. Report results
  log(`${BOLD}${'='.repeat(60)}${RESET}`);
  const statusColor = finalState.status === 'completed' ? GREEN : RED;
  log(`${BOLD}Result:${RESET} ${statusColor}${finalState.status.toUpperCase()}${RESET}`);
  log(`${BOLD}Duration:${RESET} ${elapsed}s`);
  log(`${BOLD}Run ID:${RESET} ${finalState.runId}`);

  if (finalState.escalationReason) {
    log(`${BOLD}Escalation:${RESET} ${finalState.escalationReason}`);
  }

  log('');
  log(`${BOLD}Node Results:${RESET}`);
  for (const [nodeId, exec] of Object.entries(finalState.nodeExecutions)) {
    const statusIcon = exec.status === 'completed' ? `${GREEN}OK${RESET}`
      : exec.status === 'failed' ? `${RED}FAIL${RESET}`
      : exec.status === 'skipped' ? `${DIM}SKIP${RESET}`
      : `${YELLOW}${exec.status}${RESET}`;
    log(`  ${statusIcon} ${nodeId} (${exec.attempts} attempt(s))`);
  }

  // 6. Cleanup
  log('');
  await cleanup(worktreeMgr, taskId);

  // Exit with appropriate code
  process.exit(finalState.status === 'completed' ? 0 : 1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Patch blueprint nodes for worktree execution:
 * - Rewrite file-op paths to be absolute within the worktree.
 * - Rewrite shell args that reference node_modules/ to use the repo root's copy,
 *   since worktrees don't have node_modules.
 */
function patchForWorktree(blueprint: Blueprint, worktreePath: string, repoRoot: string): Blueprint {
  const patchedNodes = blueprint.nodes.map((node) => {
    if (node.kind !== 'deterministic') return node;

    if (node.op.type === 'file') {
      const patchedOp = { ...node.op };
      if (patchedOp.path && !path.isAbsolute(patchedOp.path)) {
        patchedOp.path = path.join(worktreePath, patchedOp.path);
      }
      if (patchedOp.dest && !path.isAbsolute(patchedOp.dest)) {
        patchedOp.dest = path.join(worktreePath, patchedOp.dest);
      }
      return { ...node, op: patchedOp };
    }

    if (node.op.type === 'shell' && node.op.args) {
      const patchedArgs = node.op.args.map((arg) => {
        if (arg.startsWith('node_modules/') || arg.startsWith('node_modules\\')) {
          return path.join(repoRoot, arg);
        }
        return arg;
      });
      return { ...node, op: { ...node.op, args: patchedArgs } };
    }

    return node;
  });

  return { ...blueprint, nodes: patchedNodes };
}

async function cleanup(mgr: WorktreeManager, id: string) {
  log('Cleaning up worktree...');
  try {
    await mgr.remove(id);
    log(`${GREEN}Worktree removed.${RESET}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${YELLOW}Warning: worktree cleanup failed: ${msg}${RESET}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
