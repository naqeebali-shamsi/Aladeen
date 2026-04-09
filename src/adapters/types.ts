
import { IPty } from 'node-pty';

export interface PreflightResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
  errorDocLink?: string;
  suggestedFix?: string;
}

export interface AdapterCapabilities {
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsWSL?: boolean;
}

export type SessionEvent = 
  | { type: 'stdout_chunk'; content: string }
  | { type: 'stderr_chunk'; content: string }
  | { type: 'tool_event'; name: string; args: unknown }
  | { type: 'status_event'; status: 'ready' | 'running' | 'errored' | 'stopped' }
  | { type: 'final_response'; content: string };

export interface SessionOptions {
  cwd: string;
  env?: Record<string, string>;
}

export interface IProviderAdapter {
  id: string;
  name: string;
  
  /**
   * Run pre-flight checks (binary existence, auth, network).
   */
  preflight(): Promise<PreflightResult>;
  
  /**
   * Start a new interactive session (PTY).
   */
  startSession(options: SessionOptions): Promise<{
    pty: IPty;
    emitter: (event: SessionEvent) => void;
  }>;
  
  /**
   * Send text to the CLI stdin.
   */
  sendInput(text: string): Promise<void>;
  
  /**
   * Interrupt current execution (Ctrl-C).
   */
  interrupt(): Promise<void>;
  
  /**
   * Gracefully stop the session.
   */
  stop(): Promise<void>;
  
  /**
   * Return current health status of the provider.
   */
  health(): Promise<{
    status: 'healthy' | 'unhealthy' | 'unknown';
    latencyMs?: number;
    error?: string;
  }>;
  
  /**
   * Describe adapter capabilities.
   */
  capabilities(): AdapterCapabilities;
}
