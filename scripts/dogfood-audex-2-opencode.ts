#!/usr/bin/env tsx
/**
 * Second Aladeen dogfood: same Audex task as dogfood-audex-1.ts (add
 * formatCurrency.js) but routed through SST opencode + a local Ollama model
 * instead of the Claude CLI. Validates the multi-provider claim.
 *
 * Env vars:
 *   OPENCODE_MODEL  provider/model string (default: ollama/qwen2.5-coder:14b)
 *
 * Usage: npx tsx scripts/dogfood-audex-2-opencode.ts
 *
 * NOTE: opencode picks the global Pencil MCP up by default and the smoke test
 * proved it "captures" the model's tool space (model thinks it only has .pen
 * tools). We temporarily disable Pencil MCP in the global config for the run
 * and restore on exit (try/finally so a crash still restores).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { BlueprintRunner } from '../src/engine/runner.js';
import { createImplementFeatureLocalBlueprint } from '../src/blueprints/index.js';
import type { BlueprintNode, NodeResult } from '../src/engine/types.js';

const OPENCODE_CONFIG_PATH = path.join(
  process.env['USERPROFILE'] ?? process.env['HOME'] ?? '',
  '.config', 'opencode', 'opencode.json'
);

const AUDEX_ROOT = 'N:/ITSUBI AUDIT';
const TASK_ID = `audex-format-currency-oc-${Date.now()}`;
const TARGET_FILE = 'app/main/utils/format-currency.js';
const MODEL = process.env['OPENCODE_MODEL'] ?? 'ollama/qwen2.5-coder:14b';

const PROMPT = `Create a new file at ${TARGET_FILE}.

The file must:
1. Export a single function: formatCurrency(amountCents, locale = 'en-US', currency = 'USD')
2. Convert amountCents (integer cents) to a formatted currency string using Intl.NumberFormat.
3. JSDoc block with @param/@returns and 3 @example lines covering different locale/currency combinations.

Use module.exports (CommonJS Electron project; no ESM, no TypeScript).

Do not modify any other file. Do not run npm install or any tests. Just write the file.`;

const blueprint = createImplementFeatureLocalBlueprint({
  taskId: TASK_ID,
  prompt: PROMPT,
  adapterId: 'opencode',
  repoRoot: AUDEX_ROOT,
  baseBranch: 'main',
  targetPaths: [TARGET_FILE],
  installCommand: 'cmd',
  installArgs: ['/c', 'echo', 'skip-install'],
  typecheckCommand: 'node',
  typecheckArgs: ['--check', TARGET_FILE],
  lintCommand: 'node',
  lintArgs: ['--check', TARGET_FILE],
  testCommand: 'node',
  testArgs: ['-e', `require('./${TARGET_FILE}').formatCurrency(123456)`],
});

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

function log(msg: string) { console.log(`${DIM}[dogfood-oc]${RESET} ${msg}`); }
function outcomeColor(o: string): string {
  if (o === 'success') return GREEN;
  if (o === 'failure') return RED;
  if (o === 'retry') return YELLOW;
  return RESET;
}

async function main() {
  log(`${BOLD}Aladeen dogfood #2 — Audex via opencode${RESET}`);
  log(`Task:  ${CYAN}${TASK_ID}${RESET}`);
  log(`Repo:  ${CYAN}${AUDEX_ROOT}${RESET}`);
  log(`Model: ${CYAN}${MODEL}${RESET} (set OPENCODE_MODEL to override)`);
  log(`Target file: ${CYAN}${TARGET_FILE}${RESET}`);
  log('');

  // opencode reads OPENCODE_MODEL via the OPENCODE_CONFIG buildArgs.
  process.env['OPENCODE_MODEL'] = MODEL;

  // Snapshot + temporarily disable Pencil MCP so it doesn't capture the model's tool space.
  const originalConfig = await readFile(OPENCODE_CONFIG_PATH, 'utf-8');
  try {
    const cfg = JSON.parse(originalConfig);
    if (cfg.mcp?.pencil) {
      cfg.mcp.pencil.enabled = false;
      await writeFile(OPENCODE_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
      log(`${YELLOW}temp:${RESET} Pencil MCP disabled in ${OPENCODE_CONFIG_PATH}`);
    }
  } catch (e) {
    log(`${YELLOW}warn:${RESET} could not patch opencode.json (${e instanceof Error ? e.message : e}) — continuing`);
  }

  const restoreConfig = async () => {
    try {
      await writeFile(OPENCODE_CONFIG_PATH, originalConfig, 'utf-8');
      log(`${DIM}restored opencode.json${RESET}`);
    } catch (e) {
      log(`${RED}failed to restore opencode.json (${e instanceof Error ? e.message : e}) — manual fix needed${RESET}`);
    }
  };

  const runner = new BlueprintRunner({
    repoRoot: AUDEX_ROOT,
    runMode: 'local-only',
    hooks: {
      onNodeStart: (nodeId: string, node: BlueprintNode) => {
        log(`${CYAN}>>>${RESET} ${BOLD}${node.label}${RESET} ${DIM}(${nodeId})${RESET}`);
      },
      onNodeComplete: (nodeId: string, r: NodeResult) => {
        const c = outcomeColor(r.outcome);
        const dur = `${r.durationMs.toFixed(0)}ms`;
        log(`${c}<<<${RESET} ${r.outcome.toUpperCase()} ${DIM}(${dur})${RESET} ${r.summary ?? r.error ?? ''}`);
        if (r.outcome !== 'success' && r.output['stderr']) {
          log(`    ${RED}${String(r.output['stderr']).slice(0, 300)}${RESET}`);
        }
        log('');
      },
      onEscalation: (reason: string) => {
        log(`${RED}${BOLD}ESCALATION:${RESET} ${reason}`);
      },
    },
  });

  const start = Date.now();
  let finalState;
  try {
    finalState = await runner.run(blueprint);
  } finally {
    await restoreConfig();
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  log(`${BOLD}${'='.repeat(60)}${RESET}`);
  const sc = finalState.status === 'completed' ? GREEN : RED;
  log(`${BOLD}Final:${RESET} ${sc}${finalState.status.toUpperCase()}${RESET} in ${elapsed}s`);
  log(`${BOLD}Run ID:${RESET} ${finalState.runId}`);
  if (finalState.escalationReason) {
    log(`${BOLD}Escalation:${RESET} ${finalState.escalationReason}`);
  }

  log('');
  log(`${BOLD}Per-node outcomes:${RESET}`);
  for (const [id, exec] of Object.entries(finalState.nodeExecutions)) {
    const tag = exec.status === 'completed' ? `${GREEN}OK${RESET}`
      : exec.status === 'failed' ? `${RED}FAIL${RESET}`
      : exec.status === 'pending' ? `${DIM}skip${RESET}`
      : `${YELLOW}${exec.status}${RESET}`;
    log(`  ${tag} ${id} (${exec.attempts} attempt${exec.attempts === 1 ? '' : 's'})`);
  }

  log('');
  log(`Verify on success:`);
  log(`  cd "${AUDEX_ROOT}" && git log --oneline aladeen/local/${TASK_ID} -3`);
  log(`  cat "${path.join(AUDEX_ROOT, TARGET_FILE)}"`);

  process.exit(finalState.status === 'completed' ? 0 : 1);
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err);
  process.exit(1);
});
