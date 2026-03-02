
import { BaseProviderAdapter } from './base.js';
import { PreflightResult, SessionOptions, SessionEvent, AdapterCapabilities } from './types.js';
import { IPty } from 'node-pty';

export class ClaudeAdapter extends BaseProviderAdapter {
  id = 'claude';
  name = 'Claude Code';

  async preflight(): Promise<PreflightResult> {
    // TODO: Detect claude binary and auth
    return { success: true, message: 'Claude preflight passing (placeholder)' };
  }

  async startSession(options: SessionOptions): Promise<{ pty: IPty; emitter: (event: SessionEvent) => void; }> {
    // TODO: Spawn claude via node-pty
    throw new Error('Claude: startSession not implemented');
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
