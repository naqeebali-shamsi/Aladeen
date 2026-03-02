
import { IProviderAdapter } from './types.js';
import { ClaudeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { CodexAdapter } from './codex.js';

class AdapterRegistry {
  private adapters: Map<string, IProviderAdapter> = new Map();

  constructor() {
    this.register(new ClaudeAdapter());
    this.register(new GeminiAdapter());
    this.register(new CodexAdapter());
  }

  register(adapter: IProviderAdapter) {
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(id: string): IProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  listAdapters(): IProviderAdapter[] {
    return Array.from(this.adapters.values());
  }
}

export const registry = new AdapterRegistry();
export * from './types.js';
