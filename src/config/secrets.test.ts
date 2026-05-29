import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseSecretsFile,
  serializeSecrets,
  upsertSecret,
  loadSecretsIntoEnv,
  redact,
} from './secrets.js';

let tmp: string;
let secretsPath: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'aladeen-secrets-'));
  secretsPath = path.join(tmp, 'secrets.env');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('parseSecretsFile', () => {
  it('returns entries for valid KEY=VALUE lines', () => {
    const entries = parseSecretsFile('FOO=bar\nBAZ=qux\n');
    expect(entries).toEqual([{ key: 'FOO', value: 'bar' }, { key: 'BAZ', value: 'qux' }]);
  });

  it('strips surrounding double and single quotes', () => {
    const entries = parseSecretsFile('A="b c"\nD=\'e f\'\n');
    expect(entries).toEqual([{ key: 'A', value: 'b c' }, { key: 'D', value: 'e f' }]);
  });

  it('ignores comments, blank lines, and malformed entries', () => {
    const entries = parseSecretsFile('# comment\n\n=oops\nbad\nOK=1\n');
    expect(entries).toEqual([{ key: 'OK', value: '1' }]);
  });

  it('rejects keys that do not match the safe pattern', () => {
    const entries = parseSecretsFile('foo=bar\n123KEY=baz\nOK_KEY=ok\n');
    expect(entries).toEqual([{ key: 'OK_KEY', value: 'ok' }]);
  });
});

describe('serializeSecrets', () => {
  it('round-trips with parseSecretsFile', () => {
    const original = [{ key: 'A', value: 'one' }, { key: 'B', value: 'two with space' }];
    const round = parseSecretsFile(serializeSecrets(original));
    expect(round).toEqual(original);
  });
});

describe('upsertSecret', () => {
  it('creates the file and writes a single entry when no file exists', async () => {
    await upsertSecret('FOO', 'bar', secretsPath);
    const body = await readFile(secretsPath, 'utf-8');
    expect(body).toContain('FOO=bar');
  });

  it('replaces an existing key in place', async () => {
    await upsertSecret('FOO', 'old', secretsPath);
    await upsertSecret('FOO', 'new', secretsPath);
    const body = await readFile(secretsPath, 'utf-8');
    expect(body.match(/^FOO=/gm)?.length).toBe(1);
    expect(body).toContain('FOO=new');
  });

  it('appends a new key without disturbing existing keys', async () => {
    await upsertSecret('FOO', '1', secretsPath);
    await upsertSecret('BAR', '2', secretsPath);
    const entries = parseSecretsFile(await readFile(secretsPath, 'utf-8'));
    expect(entries).toEqual([{ key: 'FOO', value: '1' }, { key: 'BAR', value: '2' }]);
  });

  it('rejects invalid keys', async () => {
    await expect(upsertSecret('lowercase', 'x', secretsPath)).rejects.toThrow(/Invalid secret key/);
  });
});

describe('loadSecretsIntoEnv', () => {
  it('hydrates process.env with file values when env is unset', async () => {
    await writeFile(secretsPath, 'ALADEEN_TEST_NEW=hello\n', 'utf-8');
    delete process.env.ALADEEN_TEST_NEW;
    const applied = await loadSecretsIntoEnv(secretsPath);
    expect(applied).toContain('ALADEEN_TEST_NEW');
    expect(process.env.ALADEEN_TEST_NEW).toBe('hello');
    delete process.env.ALADEEN_TEST_NEW;
  });

  it('does not overwrite already-set env vars', async () => {
    await writeFile(secretsPath, 'ALADEEN_TEST_KEEP=fromfile\n', 'utf-8');
    process.env.ALADEEN_TEST_KEEP = 'fromenv';
    const applied = await loadSecretsIntoEnv(secretsPath);
    expect(applied).not.toContain('ALADEEN_TEST_KEEP');
    expect(process.env.ALADEEN_TEST_KEEP).toBe('fromenv');
    delete process.env.ALADEEN_TEST_KEEP;
  });

  it('returns an empty array when the secrets file is missing', async () => {
    const applied = await loadSecretsIntoEnv(path.join(tmp, 'does-not-exist.env'));
    expect(applied).toEqual([]);
  });
});

describe('redact', () => {
  it('returns *** for short values', () => {
    expect(redact('abc')).toBe('***');
  });

  it('reveals the first 4 chars plus a length hint for longer values', () => {
    expect(redact('sk-abcdef1234567890')).toBe('sk-a***(19 chars)');
  });
});
