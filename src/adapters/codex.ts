
import { BaseProviderAdapter } from './base.js';
import { PreflightResult, SessionOptions, SessionEvent, AdapterCapabilities } from './types.js';
import { IPty } from 'node-pty';
import { PtyRuntime } from '../runtime/pty.js';

export class CodexAdapter extends BaseProviderAdapter {
  id = 'codex';
  name = 'Codex CLI';

  async preflight(): Promise<PreflightResult> {
    // TODO: Detect codex binary and auth
    return { success: true, message: 'Codex preflight passing (placeholder)' };
  }

  async startSession(options: SessionOptions): Promise<{ pty: IPty; emitter: (event: SessionEvent) => void; }> {
    this.eventEmitter = (_event: SessionEvent) => {
      // Hook for future Codex-specific event transforms (e.g., tool events)
    };

    // Assumes `codex` CLI is installed and on PATH.
    // For now we launch the default interactive experience.
    const cmd = 'codex';
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
    return { status: 'healthy' as const };
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsTools: true,
      supportsStreaming: true,
      supportsWSL: true,
    };
  }
}
