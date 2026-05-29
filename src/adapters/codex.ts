
import { BaseProviderAdapter } from './base.js';
import { PreflightResult, SessionOptions, SessionEvent, AdapterCapabilities } from './types.js';
import { IPty } from 'node-pty';
import { PtyRuntime } from '../runtime/pty.js';
import { resolveBinary } from '../engine/binary-resolver.js';
import { runCliPreflight } from './preflight.js';

export class CodexAdapter extends BaseProviderAdapter {
  id = 'codex';
  name = 'Codex CLI';

  async preflight(): Promise<PreflightResult> {
    return runCliPreflight({
      providerName: this.name,
      binary: 'codex',
      versionArgs: ['--version'],
      authEnvVars: ['OPENAI_API_KEY'],
      installHint: 'Install Codex CLI and ensure the `codex` command is on PATH.',
      authHint: 'Set OPENAI_API_KEY or complete Codex CLI sign-in before starting a session.',
    });
  }

  async startSession(options: SessionOptions): Promise<{ pty: IPty; emitter: (event: SessionEvent) => void; }> {
    this.eventEmitter = (_event: SessionEvent) => {
      // Hook for future Codex-specific event transforms (e.g., tool events)
    };

    // Assumes `codex` CLI is installed and on PATH.
    // For now we launch the default interactive experience.
    const cmd = resolveBinary('codex');
    const args: string[] = [];

    const ptyProcess = PtyRuntime.spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env
    });

    const transformer = PtyRuntime.createEventTransformer(this.eventEmitter);

    ptyProcess.onData((data: string) => transformer.onData(data));
    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => transformer.onExit(exitCode));

    this.pty = ptyProcess.pty;

    return {
      pty: this.pty,
      emitter: this.eventEmitter
    };
  }

  async health() {
    const result = await this.preflight();
    return result.success
      ? { status: 'healthy' as const }
      : { status: 'unhealthy' as const, error: result.message };
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsTools: true,
      supportsStreaming: true,
      supportsWSL: true,
    };
  }
}
