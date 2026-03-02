
import { BaseProviderAdapter } from './base.js';
import { PreflightResult, SessionOptions, SessionEvent, AdapterCapabilities } from './types.js';
import { IPty } from 'node-pty';

export class GeminiAdapter extends BaseProviderAdapter {
  id = 'gemini';
  name = 'Gemini CLI';

  async preflight(): Promise<PreflightResult> {
    // TODO: Detect gemini binary and auth
    return { success: true, message: 'Gemini preflight passing (placeholder)' };
  }

  async startSession(options: SessionOptions): Promise<{ pty: IPty; emitter: (event: SessionEvent) => void; }> {
    // TODO: Spawn gemini via node-pty
    throw new Error('Gemini: startSession not implemented');
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
