import os from 'node:os';
import path from 'node:path';

/**
 * Where global (user-wide) Aladeen config lives.
 *
 * Honors `ALADEEN_HOME` if set — this is the DI seam for tests and portable
 * installs. Falls back to `~/.aladeen`.
 */
export function globalConfigDir(): string {
  const override = process.env.ALADEEN_HOME;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.aladeen');
}

export function globalConfigPath(): string {
  return path.join(globalConfigDir(), 'config.json');
}

/** Where project-scoped Aladeen config lives. */
export function projectConfigDir(repoRoot: string): string {
  return path.join(repoRoot, '.aladeen');
}

export function projectConfigPath(repoRoot: string): string {
  return path.join(projectConfigDir(repoRoot), 'config.json');
}

/** Secrets are global only — never committed per-project. */
export function globalSecretsPath(): string {
  return path.join(globalConfigDir(), 'secrets.env');
}
