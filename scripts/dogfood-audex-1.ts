#!/usr/bin/env tsx
/**
 * First Aladeen dogfood run against an external repo (Audex).
 *
 * Task: add app/main/utils/format-currency.js exporting formatCurrency().
 * Gates overridden because Audex is JS-only (no tsc, no test/lint scripts).
 *
 * Usage: npx tsx scripts/dogfood-audex-1.ts
 */
import path from 'node:path';
import process from 'node:process';
import { BlueprintRunner } from '../src/engine/runner.js';
import { createImplementFeatureLocalBlueprint } from '../src/blueprints/index.js';
import type { BlueprintNode, NodeResult } from '../src/engine/types.js';

const AUDEX_ROOT = 'N:/ITSUBI AUDIT';
const TASK_ID = `audex-format-currency-${Date.now()}`;
const TARGET_FILE = 'app/main/utils/format-currency.js';

const PROMPT = `Create a new file at ${TARGET_FILE} in this repository.

The file must:
1. Export a single function: formatCurrency(amountCents, locale = 'en-US', currency = 'USD')
2. Convert amountCents (an integer number of cents) into a formatted currency string using Intl.NumberFormat.
3. Include a JSDoc block with @param/@returns and 3 @example lines showing different locale/currency combinations.

Use module.exports (this is a CommonJS Electron project — no ESM, no TypeScript).

Do not modify any other file. Do not run npm install. Do not run any tests.`;

// Gate overrides: Audex has no tsc and no test/lint scripts.
const blueprint = createImplementFeatureLocalBlueprint({
  taskId: TASK_ID,
  prompt: PROMPT,
  adapterId: 'claude',
  repoRoot: AUDEX_ROOT,
  baseBranch: 'main',
  targetPaths: [TARGET_FILE],
  installCommand: 'cmd',
  installArgs: ['/c', 'echo', 'skip-install'],
  // Audex is JS-only — typecheck, lint, and test all collapse to syntax + load checks.
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

function log(msg: string) { console.log(`${DIM}[dogfood]${RESET} ${msg}`); }
function outcomeColor(o: string): string {
  if (o === 'success') return GREEN;
  if (o === 'failure') return RED;
  if (o === 'retry') return YELLOW;
  return RESET;
}

async function main() {
  log(`${BOLD}Aladeen dogfood run #1 — Audex${RESET}`);
  log(`Task: ${CYAN}${TASK_ID}${RESET}`);
  log(`Repo: ${CYAN}${AUDEX_ROOT}${RESET}`);
  log(`Target file: ${CYAN}${TARGET_FILE}${RESET}`);
  log(`Adapter: ${CYAN}claude${RESET} (headless)`);
  log('');

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
  const finalState = await runner.run(blueprint);
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
