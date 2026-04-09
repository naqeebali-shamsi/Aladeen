import type { Blueprint } from '../engine/types.js';

/**
 * End-to-end "Implement Feature" blueprint.
 *
 * Flow:
 *   create-worktree -> read-rules -> implement -> lint -> [fix-lint] -> test -> [fix-tests] -> commit -> push -> cleanup
 *
 * Failure/retry edges:
 *   lint --failure--> fix-lint --success--> lint (bounded by maxRetries)
 *   test --failure--> fix-tests --success--> test (bounded by maxRetries)
 */
export function createImplementFeatureLocalBlueprint(params: {
  taskId: string;
  prompt: string;
  adapterId: string;
  repoRoot: string;
  baseBranch?: string;
  targetPaths?: string[];
  testCommand?: string;
  testArgs?: string[];
  lintCommand?: string;
  lintArgs?: string[];
  /** Install CLI in worktree before gates (default: npm install). */
  installCommand?: string;
  installArgs?: string[];
}): Blueprint {
  const {
    taskId,
    prompt,
    adapterId,
    repoRoot,
    baseBranch = 'main',
    targetPaths = ['src/**'],
    testCommand = 'node',
    testArgs = ['node_modules/typescript/lib/tsc.js', '--noEmit'],
    lintCommand = 'node',
    lintArgs = ['node_modules/typescript/lib/tsc.js', '--noEmit'],
    installCommand = 'npm',
    installArgs = ['install', '--no-audit', '--no-fund'],
  } = params;

  const worktreePath = `${repoRoot}/.aladeen/worktrees/${taskId}`;
  const branch = `aladeen/local/${taskId}`;

  return {
    id: `implement-feature-${taskId}`,
    name: `Implement Feature: ${taskId}`,
    version: '1.0.0',
    entryNodeId: 'create-worktree',
    maxDurationMs: 45 * 60 * 1000, // 45 minutes (install + agent + gates)
    maxTotalRetries: 5,

    defaultContext: {
      cwd: worktreePath,
      env: {},
      ruleFiles: [],
      allowedTools: [],
      store: { taskId, prompt, targetPaths, repoRoot },
    },

    nodes: [
      // Step 1: Create worktree
      {
        id: 'create-worktree',
        label: 'Create git worktree',
        kind: 'deterministic' as const,
        op: {
          type: 'git' as const,
          action: 'worktree_add' as const,
          params: { branch, path: worktreePath, base: baseBranch },
        },
        contextOverrides: { cwd: repoRoot },
      },

      // Step 2: Install dependencies in worktree (node_modules not copied by git worktree)
      {
        id: 'bootstrap-deps',
        label: 'Install dependencies in worktree',
        kind: 'deterministic' as const,
        op: {
          type: 'shell' as const,
          command: installCommand,
          args: installArgs,
        },
        timeoutMs: 10 * 60 * 1000,
      },

      // Step 3: Read rule/context files
      {
        id: 'read-rules',
        label: 'Read project rules',
        kind: 'deterministic' as const,
        op: {
          type: 'shell' as const,
          command: 'git',
          args: ['log', '--oneline', '-5'],
        },
      },

      // Step 4: Implement the change (agentic)
      {
        id: 'implement',
        label: 'Implement the requested change',
        kind: 'agentic' as const,
        adapterId,
        prompt: `You are working in ${worktreePath} on branch ${branch}.\n\nTask:\n${prompt}\n\nTarget paths: ${targetPaths.join(', ')}\n\nImplement the change. Make sure it compiles and follows existing code patterns.`,
        maxRetries: 1,
        timeoutMs: 5 * 60 * 1000,
      },

      // Step 5: Typecheck gate
      {
        id: 'typecheck',
        label: 'Run typecheck',
        kind: 'deterministic' as const,
        op: {
          type: 'shell' as const,
          command: 'node',
          args: ['node_modules/typescript/lib/tsc.js', '--noEmit'],
        },
      },

      // Step 6: Run linter
      {
        id: 'lint',
        label: 'Run linter',
        kind: 'deterministic' as const,
        op: {
          type: 'shell' as const,
          command: lintCommand,
          args: lintArgs,
        },
      },

      // Step 7: Fix lint errors (agentic, triggered on lint failure)
      {
        id: 'fix-lint',
        label: 'Fix lint errors',
        kind: 'agentic' as const,
        adapterId,
        prompt: 'The linter failed. Look at the lint output in the store under "lint.stderr" and "lint.stdout", fix all type errors and lint issues in the code.',
        maxRetries: 1,
        timeoutMs: 3 * 60 * 1000,
      },

      // Step 8: Run tests
      {
        id: 'test',
        label: 'Run test suite',
        kind: 'deterministic' as const,
        op: {
          type: 'shell' as const,
          command: testCommand,
          args: testArgs,
        },
      },

      // Step 9: Fix failing tests (agentic, triggered on test failure)
      {
        id: 'fix-tests',
        label: 'Fix failing tests',
        kind: 'agentic' as const,
        adapterId,
        prompt: 'Tests failed. Look at the test output in the store under "test.stderr" and "test.stdout", analyze the failures and fix the code.',
        maxRetries: 2,
        timeoutMs: 3 * 60 * 1000,
      },

      // Step 10: Verify branch status gate
      {
        id: 'verify-branch',
        label: 'Verify branch policy',
        kind: 'deterministic' as const,
        op: {
          type: 'shell' as const,
          command: 'git',
          args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        },
      },

      // Step 11: Commit
      {
        id: 'commit',
        label: 'Create commit',
        kind: 'deterministic' as const,
        op: {
          type: 'shell' as const,
          command: 'git',
          args: ['add', '-A'],
        },
      },

      // Step 12: Actual commit message
      {
        id: 'commit-msg',
        label: 'Commit with message',
        kind: 'deterministic' as const,
        op: {
          type: 'shell' as const,
          command: 'git',
          args: ['commit', '-m', `feat(${taskId}): ${prompt.slice(0, 72)}`],
        },
      },

      // Step 13: Final summary (local-only handoff)
      {
        id: 'finalize',
        label: 'Finalize local PR-ready state',
        kind: 'deterministic' as const,
        op: {
          type: 'file' as const,
          action: 'write' as const,
          path: `${worktreePath}/.aladeen-pr-ready.txt`,
          content: `taskId=${taskId}\nbranch=${branch}\nstatus=ready\n`,
        },
      },

      // Step 14: Cleanup worktree
      {
        id: 'cleanup',
        label: 'Remove worktree',
        kind: 'deterministic' as const,
        op: {
          type: 'git' as const,
          action: 'worktree_remove' as const,
          params: { path: worktreePath },
        },
        contextOverrides: { cwd: repoRoot },
      },
    ],

    edges: [
      // Happy path
      { from: 'create-worktree', to: 'bootstrap-deps' },
      { from: 'bootstrap-deps', to: 'read-rules', on: 'success' },
      { from: 'read-rules', to: 'implement' },
      { from: 'implement', to: 'typecheck' },
      { from: 'typecheck', to: 'lint', on: 'success' },
      { from: 'typecheck', to: 'fix-lint', on: 'failure' },
      { from: 'lint', to: 'test', on: 'success' },
      { from: 'test', to: 'verify-branch', on: 'success' },
      { from: 'verify-branch', to: 'commit', on: 'success' },
      { from: 'commit', to: 'commit-msg' },
      { from: 'commit-msg', to: 'finalize' },
      { from: 'finalize', to: 'cleanup' },

      // Feedback loops
      { from: 'lint', to: 'fix-lint', on: 'failure' },
      { from: 'fix-lint', to: 'lint' },
      { from: 'test', to: 'fix-tests', on: 'failure' },
      { from: 'fix-tests', to: 'test' },
    ],
  };
}

export function createImplementFeatureBlueprint(params: {
  taskId: string;
  prompt: string;
  adapterId: string;
  repoRoot: string;
  baseBranch?: string;
  targetPaths?: string[];
  testCommand?: string;
  testArgs?: string[];
  lintCommand?: string;
  lintArgs?: string[];
  installCommand?: string;
  installArgs?: string[];
}): Blueprint {
  return createImplementFeatureLocalBlueprint(params);
}
