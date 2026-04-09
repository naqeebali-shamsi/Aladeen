import { BaseProviderAdapter } from './base.js';
import { PreflightResult, SessionOptions, SessionEvent, AdapterCapabilities } from './types.js';
import { IPty } from 'node-pty';
import { PtyRuntime } from '../runtime/pty.js';

export class ClaudeAdapter extends BaseProviderAdapter {
  id = 'claude';
  name = 'Claude Code';

  async preflight(): Promise<PreflightResult> {
    // TODO: Detect claude binary and auth
    return { success: true, message: 'Claude preflight passing (placeholder)' };
  }

  async startSession(options: SessionOptions): Promise<{ pty: IPty; emitter: (event: SessionEvent) => void; }> {
    this.eventEmitter = (_event: SessionEvent) => {
      // For now, Claude doesn't need special transformations, but here is where they would go.
    };

    const cmd = 'claude'; // Assumes `claude` CLI is on PATH
    const args: string[] = []; // Launch default interactive experience

    const ptyProcess = PtyRuntime.spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env
    });

    this.pty = ptyProcess.pty;

    const transformer = PtyRuntime.createEventTransformer(this.eventEmitter);

    ptyProcess.onData((data: string) => transformer.onData(data));
    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => transformer.onExit(exitCode));

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
    };
  }
}
