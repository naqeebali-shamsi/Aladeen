import type { BlueprintContext, NodeResult } from '../types.js';

/** Configuration for a single verifier. */
export interface VerifierConfig {
  /** Unique verifier identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Timeout in ms for this verifier */
  timeoutMs?: number;
}

/** A verifier checks some aspect of the work and produces a NodeResult. */
export interface IVerifier {
  readonly id: string;
  verify(context: BlueprintContext): Promise<NodeResult>;
}

export interface VerifierGateResult {
  id: string;
  outcome: 'success' | 'failure' | 'retry';
  required: boolean;
}

export interface VerifierScorecard {
  gateOrder: string[];
  results: VerifierGateResult[];
  passed: boolean;
  failedRequiredGate?: string;
}

/** Lint verifier configuration. */
export interface LintVerifierConfig extends VerifierConfig {
  /** Command to run (e.g. "eslint", "tsc") */
  command: string;
  /** Args to pass to the command */
  args?: string[];
  /** If true, attempt auto-fix first (e.g. eslint --fix) */
  autoFix?: boolean;
  /** Auto-fix args (e.g. ["--fix"]) — appended to command when autoFix is true */
  autoFixArgs?: string[];
}

/** Test verifier configuration. */
export interface TestVerifierConfig extends VerifierConfig {
  /** Command to run tests (e.g. "npm", "jest") */
  command: string;
  /** Args (e.g. ["test", "--", "--reporter=json"]) */
  args?: string[];
}

/** Git verifier configuration. */
export interface GitVerifierConfig extends VerifierConfig {
  /** Checks to perform */
  checks: Array<'clean' | 'no-conflicts' | 'on-branch' | 'committed'>;
  /** Expected branch pattern (regex) — for 'on-branch' check */
  branchPattern?: string;
}

/** Diff verifier configuration. */
export interface DiffVerifierConfig extends VerifierConfig {
  /** Allowed file path patterns (globs). Changes outside these fail. */
  allowedPaths: string[];
  /** Max number of files that can be changed. */
  maxFiles?: number;
  /** Max total diff lines. */
  maxDiffLines?: number;
  /** Base ref to diff against (default: HEAD~1) */
  baseRef?: string;
}
