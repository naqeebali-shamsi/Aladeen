
import { BaseProviderAdapter } from './base.js';
import { PreflightResult, SessionOptions, SessionEvent, AdapterCapabilities } from './types.js';
import { IPty } from 'node-pty';
import { PtyRuntime } from '../runtime/pty.js';
import { resolveBinary } from '../engine/binary-resolver.js';
import { runCliPreflight } from './preflight.js';

export class GeminiAdapter extends BaseProviderAdapter {
  id = 'gemini';
  name = 'Gemini CLI';

  async preflight(): Promise<PreflightResult> {
    return runCliPreflight({
      providerName: this.name,
      binary: 'gemini',
      versionArgs: ['--version'],
      authEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
      installHint: 'Install Gemini CLI and ensure the `gemini` command is on PATH.',
      authHint: 'Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_APPLICATION_CREDENTIALS, or complete Gemini CLI login before starting a session.',
    });
  }

  async startSession(options: SessionOptions): Promise<{ pty: IPty; emitter: (event: SessionEvent) => void; }> {
    this.eventEmitter = (_event: SessionEvent) => {
      // Hook for future Gemini-specific event transforms
    };

    // Assumes `gemini` CLI is installed and on PATH.
    // `gemini chat` is the interactive chat experience in the official CLI.
    const cmd = resolveBinary('gemini');
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
    const result = await this.preflight();
    return result.success
      ? { status: 'healthy' as const }
      : { status: 'unhealthy' as const, error: result.message };
  }

  capabilities(): AdapterCapabilities {
    return {
      supportsTools: true,
      supportsStreaming: true,
    };
  }
}
