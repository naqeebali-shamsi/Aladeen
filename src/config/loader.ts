import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  AladeenConfig,
  AladeenConfigSchema,
  DEFAULT_CONFIG,
} from './types.js';
import {
  globalConfigPath,
  projectConfigPath,
  projectConfigDir,
  globalConfigDir,
} from './paths.js';

export interface LoadConfigResult {
  config: AladeenConfig;
  /** Source layers that contributed, in merge order (later overrides earlier). */
  sources: Array<'defaults' | 'global' | 'project'>;
  /** True if either global or project config exists on disk. */
  exists: boolean;
}

/**
 * Load merged config: defaults → global → project (later wins for scalar fields;
 * adapters object is deep-merged at the top level).
 */
export async function loadConfig(repoRoot: string): Promise<LoadConfigResult> {
  const sources: LoadConfigResult['sources'] = ['defaults'];
  let merged: AladeenConfig = structuredClone(DEFAULT_CONFIG);
  let exists = false;

  const global = await readConfigFile(globalConfigPath());
  if (global) {
    merged = mergeConfig(merged, global);
    sources.push('global');
    exists = true;
  }

  const project = await readConfigFile(projectConfigPath(repoRoot));
  if (project) {
    merged = mergeConfig(merged, project);
    sources.push('project');
    exists = true;
  }

  return { config: merged, sources, exists };
}

export async function configExists(repoRoot: string): Promise<boolean> {
  const g = await readConfigFile(globalConfigPath());
  if (g) return true;
  const p = await readConfigFile(projectConfigPath(repoRoot));
  return !!p;
}

async function readConfigFile(filePath: string): Promise<AladeenConfig | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const result = AladeenConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid config at ${filePath}: ${result.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }
    return result.data;
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function mergeConfig(base: AladeenConfig, overlay: AladeenConfig): AladeenConfig {
  return {
    version: overlay.version,
    defaultAdapterId: overlay.defaultAdapterId ?? base.defaultAdapterId,
    enabledAdapters: overlay.enabledAdapters.length
      ? overlay.enabledAdapters
      : base.enabledAdapters,
    adapters: { ...base.adapters, ...overlay.adapters },
    setupCompletedAt: overlay.setupCompletedAt ?? base.setupCompletedAt,
  };
}

export type ConfigScope = 'global' | 'project';

export async function writeConfig(
  scope: ConfigScope,
  config: AladeenConfig,
  repoRoot: string,
): Promise<string> {
  const result = AladeenConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Refusing to write invalid config: ${result.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
    );
  }
  const targetPath = scope === 'global' ? globalConfigPath() : projectConfigPath(repoRoot);
  const dir = scope === 'global' ? globalConfigDir() : projectConfigDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(result.data, null, 2) + '\n', 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, targetPath);
  return targetPath;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err &&
    (err as { code: string }).code === 'ENOENT';
}

/** Used by callers that need just the project's config dir (e.g., for ignore files). */
export { projectConfigDir, globalConfigDir };
