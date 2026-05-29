import { describe, expect, it } from 'vitest';
import { runCliPreflight, type CommandResult } from './preflight.js';

const baseConfig = {
  providerName: 'Test CLI',
  binary: 'test-cli',
  versionArgs: ['--version'],
  authEnvVars: ['TEST_API_KEY'],
  installHint: 'Install test-cli.',
  authHint: 'Set TEST_API_KEY or log in.',
};

describe('runCliPreflight', () => {
  it('fails when the provider binary is missing', async () => {
    const result = await runCliPreflight(baseConfig, {
      env: {},
      findBinary: () => null,
      runCommand: async () => commandResult({ stdout: 'unused' }),
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
    expect(result.suggestedFix).toBe(baseConfig.installHint);
    expect(result.details?.['binary']).toBe('test-cli');
  });

  it('reports version and auth env evidence without exposing secret values', async () => {
    const result = await runCliPreflight(baseConfig, {
      env: { TEST_API_KEY: 'secret-value' },
      findBinary: () => '/usr/bin/test-cli',
      runCommand: async () => commandResult({ stdout: 'test-cli 1.2.3\n' }),
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('test-cli 1.2.3');
    expect(result.message).toContain('TEST_API_KEY');
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(result.suggestedFix).toBeUndefined();
  });

  it('keeps binary preflight successful when only the version command fails', async () => {
    const result = await runCliPreflight(baseConfig, {
      env: {},
      findBinary: () => '/usr/bin/test-cli',
      runCommand: async () => commandResult({
        exitCode: 2,
        stderr: 'unknown option',
        error: 'Exited with code 2',
      }),
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('version check unavailable');
    expect(result.suggestedFix).toBe(baseConfig.authHint);
  });
});

function commandResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}
