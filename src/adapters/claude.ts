import { BaseProviderAdapter } from './base.js';
import { PreflightResult, SessionOptions, SessionEvent, AdapterCapabilities } from './types.js';
import { IPty } from 'node-pty';
import { PtyRuntime } from '../runtime/pty.js';
import { resolveBinary } from '../engine/binary-resolver.js';
import { runCliPreflight } from './preflight.js';

export class ClaudeAdapter extends BaseProviderAdapter {
  id = 'claude';
  name = 'Claude Code';

  async preflight(): Promise<PreflightResult> {
    return runCliPreflight({
      providerName: this.name,
      binary: 'claude',
      versionArgs: ['--version'],
      authEnvVars: ['ANTHROPIC_API_KEY'],
      installHint: 'Install Claude Code and ensure the `claude` command is on PATH.',
      authHint: 'Set ANTHROPIC_API_KEY or complete Claude Code interactive login before starting a session.',
    });
  }

  async startSession(options: SessionOptions): Promise<{ pty: IPty; emitter: (event: SessionEvent) => void; }> {
    this.eventEmitter = (_event: SessionEvent) => {
      // For now, Claude doesn't need special transformations, but here is where they would go.
    };

    const cmd = resolveBinary('claude');
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
