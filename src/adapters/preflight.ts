import crossSpawn from 'cross-spawn';
import { findBinary } from '../engine/binary-resolver.js';
import type { PreflightResult } from './types.js';

export interface CliPreflightConfig {
  providerName: string;
  binary: string;
  versionArgs?: string[];
  authEnvVars?: string[];
  installHint: string;
  authHint: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

interface CliPreflightDeps {
  env?: NodeJS.ProcessEnv;
  findBinary?: (name: string) => string | null;
  runCommand?: (file: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
  timeoutMs?: number;
}

export async function runCliPreflight(
  config: CliPreflightConfig,
  deps: CliPreflightDeps = {},
): Promise<PreflightResult> {
  const env = deps.env ?? process.env;
  const checkedAuthEnvVars = config.authEnvVars ?? [];
  const authEnvVarsDetected = checkedAuthEnvVars.filter((name) => Boolean(env[name]));
  const binaryPath = (deps.findBinary ?? findBinary)(config.binary);

  if (!binaryPath) {
    return {
      success: false,
      message: `${config.providerName} CLI not found on PATH`,
      details: {
        binary: config.binary,
        checkedAuthEnvVars,
        authEnvVarsDetected,
      },
      suggestedFix: config.installHint,
    };
  }

  const versionResult = config.versionArgs
    ? await (deps.runCommand ?? defaultRunCommand)(
      binaryPath,
      config.versionArgs,
      deps.timeoutMs ?? 5_000,
    )
    : undefined;

  const version = versionResult?.exitCode === 0
    ? firstLine(versionResult.stdout || versionResult.stderr)
    : undefined;
  const authMessage = authEnvVarsDetected.length > 0
    ? `auth env detected (${authEnvVarsDetected.join(', ')})`
    : 'no auth env detected; interactive login may still be configured';

  const versionMessage = version
    ? `version: ${version}`
    : versionResult
      ? `version check unavailable (${versionResult.error ?? `exit ${versionResult.exitCode}`})`
      : 'version check skipped';

  return {
    success: true,
    message: `${config.providerName} CLI found; ${versionMessage}; ${authMessage}`,
    details: {
      binary: config.binary,
      binaryPath,
      version,
      versionCheck: versionResult
        ? {
          exitCode: versionResult.exitCode,
          timedOut: versionResult.timedOut,
          error: versionResult.error,
        }
        : undefined,
      checkedAuthEnvVars,
      authEnvVarsDetected,
    },
    suggestedFix: authEnvVarsDetected.length === 0 ? config.authHint : undefined,
  };
}

function firstLine(text: string): string | undefined {
  const line = text.trim().split(/\r?\n/).find((entry) => entry.trim().length > 0);
  return line?.trim();
}

function defaultRunCommand(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    let proc: ReturnType<typeof crossSpawn>;
    try {
      proc = crossSpawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: -1,
        stdout,
        stderr,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let graceHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      // 'close' only fires once the child's stdio pipes drain; a POSIX child that traps SIGTERM or
      // leaves grandchildren holding those pipes would never emit it, hanging this promise forever.
      // Escalate to SIGKILL after a grace AND force-resolve so the await always settles.
      graceHandle = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already exited */ }
        finish({ exitCode: -1, stdout, stderr, timedOut: true, error: `Timed out after ${timeoutMs}ms` });
      }, 2_000);
    }, timeoutMs);

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (graceHandle) clearTimeout(graceHandle);
      resolve(result);
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err: Error) => {
      finish({
        exitCode: -1,
        stdout,
        stderr,
        error: err.message,
      });
    });
    proc.on('close', (code: number | null) => {
      const exitCode = code ?? 1;
      finish({
        exitCode,
        stdout,
        stderr,
        timedOut,
        error: timedOut
          ? `Timed out after ${timeoutMs}ms`
          : exitCode === 0 ? undefined : `Exited with code ${exitCode}`,
      });
    });
  });
}
