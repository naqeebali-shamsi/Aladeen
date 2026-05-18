import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { globalSecretsPath, globalConfigDir } from './paths.js';

const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface SecretEntry {
  key: string;
  value: string;
}

/**
 * Parse a dotenv-style file into key/value pairs.
 * Ignores comments and blank lines. Tolerates KEY=VALUE and KEY="VALUE".
 */
export function parseSecretsFile(content: string): SecretEntry[] {
  const entries: SecretEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (SECRET_KEY_RE.test(key)) entries.push({ key, value });
  }
  return entries;
}

/** Serialize entries to a dotenv-style file body. */
export function serializeSecrets(entries: SecretEntry[]): string {
  return entries.map((e) => `${e.key}=${quoteIfNeeded(e.value)}`).join('\n') + '\n';
}

function quoteIfNeeded(value: string): string {
  return /[\s#'"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export async function readSecrets(filePath = globalSecretsPath()): Promise<SecretEntry[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return parseSecretsFile(content);
  } catch (err: unknown) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/**
 * Upsert a single secret (replace if key exists, append otherwise).
 * Best-effort chmod 600 on POSIX. On Windows, chmod is a no-op.
 */
export async function upsertSecret(
  key: string,
  value: string,
  filePath = globalSecretsPath(),
): Promise<void> {
  if (!SECRET_KEY_RE.test(key)) {
    throw new Error(`Invalid secret key: "${key}" (must match ${SECRET_KEY_RE})`);
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readSecrets(filePath);
  const idx = existing.findIndex((e) => e.key === key);
  if (idx >= 0) existing[idx] = { key, value };
  else existing.push({ key, value });
  await writeFile(filePath, serializeSecrets(existing), 'utf-8');
  try {
    await chmod(filePath, 0o600);
  } catch {
    // chmod may be unsupported (Windows) — not fatal.
  }
}

/**
 * Hydrate process.env with values from the secrets file. Existing env vars win
 * (so callers can override with shell env). Returns the keys actually set.
 */
export async function loadSecretsIntoEnv(filePath = globalSecretsPath()): Promise<string[]> {
  const entries = await readSecrets(filePath);
  const applied: string[] = [];
  for (const { key, value } of entries) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

/** Ensure the global config directory exists. */
export async function ensureGlobalConfigDir(): Promise<void> {
  await mkdir(globalConfigDir(), { recursive: true });
}

/** Redact a secret value for log output. Keeps first 4 chars + length hint. */
export function redact(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '***';
  return `${value.slice(0, 4)}***(${value.length} chars)`;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err &&
    (err as { code: string }).code === 'ENOENT';
}
