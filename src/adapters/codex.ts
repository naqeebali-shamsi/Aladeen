
import { BaseProviderAdapter } from './base.js';
import { PreflightResult, SessionOptions, SessionEvent, AdapterCapabilities } from './types.js';
import { IPty } from 'node-pty';

export class CodexAdapter extends BaseProviderAdapter {
  id = 'codex';
  name = 'Codex CLI';

  async preflight(): Promise<PreflightResult> {
    // TODO: Detect codex binary and auth
    return { success: true, message: 'Codex preflight passing (placeholder)' };
  }

  async startSession(options: SessionOptions): Promise<{ pty: IPty; emitter: (event: SessionEvent) => void; }> {
    // TODO: Spawn codex via node-pty
    throw new Error('Codex: startSession not implemented');
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
