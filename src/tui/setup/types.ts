import type { PreflightResult } from '../../adapters/types.js';

export interface AdapterRow {
  id: string;
  name: string;
  preflight: PreflightResult | null;
  /** Auth env vars this adapter cares about, from preflight details. */
  authEnvVars: string[];
  /** Auth env vars currently detected in the environment (after secrets loaded). */
  authEnvVarsDetected: string[];
  /** Whether the user has elected to enable this adapter in this wizard run. */
  enabled: boolean;
  /** True once preflight + auth both succeed, or user explicitly skipped. */
  configured: boolean;
}

export type WizardStep =
  | { kind: 'detecting' }
  | { kind: 'select'; cursor: number }
  | { kind: 'auth'; adapterIdx: number; action?: AuthAction }
  | { kind: 'auth-input'; adapterIdx: number; envVar: string; value: string }
  | { kind: 'review' }
  | { kind: 'done'; configPath: string }
  | { kind: 'error'; message: string };

export type AuthAction = 'enter-key' | 'interactive-login' | 'skip';
