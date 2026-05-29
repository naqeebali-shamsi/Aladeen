import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, configExists, writeConfig } from './loader.js';
import { CONFIG_VERSION } from './types.js';

let tmpRepo: string;
let tmpHome: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmpRepo = await mkdtemp(path.join(tmpdir(), 'aladeen-repo-'));
  tmpHome = await mkdtemp(path.join(tmpdir(), 'aladeen-home-'));
  prevHome = process.env.ALADEEN_HOME;
  process.env.ALADEEN_HOME = path.join(tmpHome, '.aladeen');
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.ALADEEN_HOME;
  else process.env.ALADEEN_HOME = prevHome;
  await rm(tmpRepo, { recursive: true, force: true });
  await rm(tmpHome, { recursive: true, force: true });
});

async function writeFileTree(file: string, body: object) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(body), 'utf-8');
}

describe('loadConfig', () => {
  it('returns defaults when no config files exist', async () => {
    const { config, sources, exists } = await loadConfig(tmpRepo);
    expect(sources).toEqual(['defaults']);
    expect(exists).toBe(false);
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.enabledAdapters).toEqual([]);
  });

  it('reads global-only config', async () => {
    await writeFileTree(path.join(process.env.ALADEEN_HOME!, 'config.json'), {
      version: CONFIG_VERSION,
      enabledAdapters: ['claude'],
      adapters: {},
    });
    const { config, sources } = await loadConfig(tmpRepo);
    expect(sources).toEqual(['defaults', 'global']);
    expect(config.enabledAdapters).toEqual(['claude']);
  });

  it('merges project on top of global (project enabledAdapters wins)', async () => {
    await writeFileTree(path.join(process.env.ALADEEN_HOME!, 'config.json'), {
      version: CONFIG_VERSION,
      enabledAdapters: ['claude'],
      defaultAdapterId: 'claude',
      adapters: {},
    });
    await writeFileTree(path.join(tmpRepo, '.aladeen', 'config.json'), {
      version: CONFIG_VERSION,
      enabledAdapters: ['codex'],
      adapters: { codex: { defaultModel: 'gpt-5' } },
    });
    const { config, sources } = await loadConfig(tmpRepo);
    expect(sources).toEqual(['defaults', 'global', 'project']);
    expect(config.enabledAdapters).toEqual(['codex']);
    expect(config.defaultAdapterId).toBe('claude'); // not overridden by project
    expect(config.adapters.codex).toEqual({ defaultModel: 'gpt-5' });
  });

  it('throws on malformed JSON', async () => {
    await mkdir(process.env.ALADEEN_HOME!, { recursive: true });
    await writeFile(path.join(process.env.ALADEEN_HOME!, 'config.json'), '{not json', 'utf-8');
    await expect(loadConfig(tmpRepo)).rejects.toThrow();
  });

  it('throws on schema-invalid JSON', async () => {
    await writeFileTree(path.join(process.env.ALADEEN_HOME!, 'config.json'), {
      version: 'wrong',
    });
    await expect(loadConfig(tmpRepo)).rejects.toThrow(/Invalid config/);
  });
});

describe('configExists', () => {
  it('returns false when neither global nor project config exist', async () => {
    expect(await configExists(tmpRepo)).toBe(false);
  });

  it('returns true when only project config exists', async () => {
    await writeFileTree(path.join(tmpRepo, '.aladeen', 'config.json'), {
      version: CONFIG_VERSION,
      enabledAdapters: ['claude'],
      adapters: {},
    });
    expect(await configExists(tmpRepo)).toBe(true);
  });
});

describe('writeConfig', () => {
  it('writes a valid global config and the file round-trips', async () => {
    const written = await writeConfig(
      'global',
      {
        version: CONFIG_VERSION,
        enabledAdapters: ['claude'],
        adapters: {},
        defaultAdapterId: 'claude',
      },
      tmpRepo,
    );
    const body = JSON.parse(await readFile(written, 'utf-8'));
    expect(body.enabledAdapters).toEqual(['claude']);
    expect(body.defaultAdapterId).toBe('claude');
  });

  it('refuses to write an invalid config', async () => {
    await expect(
      writeConfig(
        'project',
        // @ts-expect-error -- intentional invalid input
        { version: 'bogus', enabledAdapters: [], adapters: {} },
        tmpRepo,
      ),
    ).rejects.toThrow(/Refusing to write invalid config/);
  });
});
