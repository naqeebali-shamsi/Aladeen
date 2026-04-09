
import { IProviderAdapter, PreflightResult, SessionOptions, SessionEvent, AdapterCapabilities } from './types.js';
import { IPty } from 'node-pty';

export abstract class BaseProviderAdapter implements IProviderAdapter {
  abstract id: string;
  abstract name: string;
  protected pty: IPty | null = null;
  protected eventEmitter: ((event: SessionEvent) => void) | null = null;

  abstract preflight(): Promise<PreflightResult>;
  
  async startSession(_options: SessionOptions): Promise<{
    pty: IPty;
    emitter: (event: SessionEvent) => void;
  }> {
    this.eventEmitter = (_event: SessionEvent) => {
      // Logic for session-wide event management (if any)
    };

    // Concrete adapters must override this to provide the correct binary and args.
    throw new Error(`startSession not implemented for provider: ${this.id}`);
  }

  async sendInput(text: string): Promise<void> {
    if (!this.pty) {
       throw new Error(`Session not started for provider: ${this.id}`);
    }
    this.pty.write(text + '\r');
  }

  async interrupt(): Promise<void> {
    if (!this.pty) {
        return;
    }
    // Standard kill -SIGINT equivalent in PTY \x03 is Ctrl-C
    this.pty.write('\x03');
  }

  async stop(): Promise<void> {
    if (this.pty) {
      this.pty.kill();
      this.pty = null;
    }
  }

  abstract health(): Promise<{
    status: 'healthy' | 'unhealthy' | 'unknown';
    latencyMs?: number;
    error?: string;
  }>;

  abstract capabilities(): AdapterCapabilities;

  protected emit(event: SessionEvent) {
      if (this.eventEmitter) {
          this.eventEmitter(event);
      }
  }
}
