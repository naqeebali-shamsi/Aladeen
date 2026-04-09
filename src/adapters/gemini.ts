
import { BaseProviderAdapter } from './base.js';
import { PreflightResult, SessionOptions, SessionEvent, AdapterCapabilities } from './types.js';
import { IPty } from 'node-pty';
import { PtyRuntime } from '../runtime/pty.js';

export class GeminiAdapter extends BaseProviderAdapter {
  id = 'gemini';
  name = 'Gemini CLI';

  async preflight(): Promise<PreflightResult> {
    // TODO: Detect gemini binary and auth
    return { success: true, message: 'Gemini preflight passing (placeholder)' };
  }

  async startSession(options: SessionOptions): Promise<{ pty: IPty; emitter: (event: SessionEvent) => void; }> {
    this.eventEmitter = (_event: SessionEvent) => {
      // Hook for future Gemini-specific event transforms
    };

    // Assumes `gemini` CLI is installed and on PATH.
    // `gemini chat` is the interactive chat experience in the official CLI.
    const cmd = 'gemini';
    const args: string[] = ['chat'];

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
    };
  }
}
