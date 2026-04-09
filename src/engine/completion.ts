/**
 * CompletionDetector — Detects when a CLI agent has finished its task.
 *
 * Strategy hierarchy (best to worst):
 *   1. Headless mode: process exit IS the completion signal (preferred)
 *   2. Streaming JSON: parse real-time events for turn.completed / result
 *   3. PTY quiescence: fallback for CLIs without headless support
 *
 * Each CLI adapter should declare which strategy it supports via
 * AdapterCapabilities.headlessMode.
 */

import { spawn, ChildProcess } from 'child_process';

// ─── Types ───────────────────────────────────────────────────────────────────

export type CompletionStrategy = 'headless' | 'streaming' | 'pty-quiescence';

/** CLI-specific configuration for headless execution. */
export interface HeadlessConfig {
  /** The CLI binary name (e.g., 'claude', 'codex', 'gemini') */
  binary: string;
  /** Build the argument list for a headless invocation */
  buildArgs(prompt: string, options: HeadlessOptions): string[];
  /** Parse the process stdout into a structured result */
  parseOutput(stdout: string, exitCode: number): HeadlessResult;
  /** Parse a single streaming JSON line (for progress monitoring) */
  parseStreamEvent?(line: string): StreamEvent | null;
}

export interface HeadlessOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Tool whitelist (maps to --allowedTools, --full-auto, etc.) */
  allowedTools?: string[];
  /** Additional system prompt to append */
  systemPrompt?: string;
  /** Resume a previous session by ID */
  resumeSessionId?: string;
  /** Timeout in ms (enforced by CompletionDetector, not the CLI) */
  timeoutMs?: number;
  /** Request JSON output format */
  outputFormat?: 'text' | 'json' | 'stream-json';
}

export interface HeadlessResult {
  /** Whether the agent completed successfully */
  success: boolean;
  /** The agent's text response */
  response: string;
  /** Session ID for potential resume */
  sessionId?: string;
  /** Token usage if available */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Raw exit code */
  exitCode: number;
  /** Error message if failed */
  error?: string;
  /** Full structured output (parsed JSON) */
  raw?: unknown;
}

export interface StreamEvent {
  type: 'progress' | 'tool_call' | 'text_delta' | 'turn_complete' | 'error';
  data: unknown;
}

/** Callback for streaming progress updates. */
export type OnStreamEvent = (event: StreamEvent) => void;

// ─── CLI Configurations ──────────────────────────────────────────────────────

export const CLAUDE_CONFIG: HeadlessConfig = {
  binary: 'claude',

  buildArgs(prompt: string, options: HeadlessOptions): string[] {
    const args = ['-p', prompt];

    const format = options.outputFormat ?? 'json';
    args.push('--output-format', format);

    if (options.allowedTools?.length) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }

    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt);
    }

    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    }

    return args;
  },

  parseOutput(stdout: string, exitCode: number): HeadlessResult {
    if (exitCode !== 0) {
      return {
        success: false,
        response: '',
        exitCode,
        error: `Claude exited with code ${exitCode}: ${stdout.slice(0, 500)}`,
      };
    }

    // Try parsing as JSON (--output-format json)
    try {
      const parsed = JSON.parse(stdout);
      return {
        success: true,
        response: parsed.result ?? parsed.structured_output ?? stdout,
        sessionId: parsed.session_id,
        usage: parsed.usage
          ? { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens }
          : undefined,
        exitCode,
        raw: parsed,
      };
    } catch {
      // Plain text output
      return { success: true, response: stdout.trim(), exitCode };
    }
  },

  parseStreamEvent(line: string): StreamEvent | null {
    try {
      const event = JSON.parse(line);
      if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
        return { type: 'text_delta', data: event.event.delta.text };
      }
      if (event.type === 'result') {
        return { type: 'turn_complete', data: event };
      }
      return { type: 'progress', data: event };
    } catch {
      return null;
    }
  },
};

export const CODEX_CONFIG: HeadlessConfig = {
  binary: 'codex',

  buildArgs(prompt: string, options: HeadlessOptions): string[] {
    const args = ['exec'];

    if (options.outputFormat === 'json' || options.outputFormat === 'stream-json') {
      args.push('--json');
    }

    if (options.allowedTools?.length) {
      // Codex uses --full-auto for allowing edits; tool-level granularity isn't exposed the same way
      args.push('--full-auto');
    }

    if (options.resumeSessionId) {
      args.push('resume', options.resumeSessionId);
    }

    // Prompt goes last
    args.push(prompt);

    return args;
  },

  parseOutput(stdout: string, exitCode: number): HeadlessResult {
    if (exitCode !== 0) {
      return {
        success: false,
        response: '',
        exitCode,
        error: `Codex exited with code ${exitCode}: ${stdout.slice(0, 500)}`,
      };
    }

    // Codex --json emits JSON Lines; find the last item.completed or turn.completed
    const lines = stdout.trim().split('\n');
    let response = '';
    let usage: HeadlessResult['usage'];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'item.completed' && event.item?.text) {
          response = event.item.text;
        }
        if (event.type === 'turn.completed' && event.usage) {
          usage = {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
          };
        }
      } catch {
        // Non-JSON line (progress text to stderr leaked to stdout); ignore
      }
    }

    // If no JSON parsed, the whole stdout is the plain text response
    if (!response) {
      response = stdout.trim();
    }

    return { success: true, response, usage, exitCode };
  },

  parseStreamEvent(line: string): StreamEvent | null {
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.completed') {
        return { type: 'turn_complete', data: event };
      }
      if (event.type === 'turn.failed') {
        return { type: 'error', data: event };
      }
      if (event.type?.startsWith('item.')) {
        return { type: 'progress', data: event };
      }
      return null;
    } catch {
      return null;
    }
  },
};

export const GEMINI_CONFIG: HeadlessConfig = {
  binary: 'gemini',

  buildArgs(prompt: string, options: HeadlessOptions): string[] {
    const args: string[] = [];

    const format = options.outputFormat ?? 'json';
    if (format === 'json') {
      args.push('--output-format', 'json');
    } else if (format === 'stream-json') {
      args.push('--output-format', 'streaming-json');
    }

    if (options.allowedTools?.length) {
      // Gemini uses --yolo for unattended execution
      args.push('--yolo');
    }

    // Prompt as positional argument (triggers headless mode)
    args.push(prompt);

    return args;
  },

  parseOutput(stdout: string, exitCode: number): HeadlessResult {
    // Gemini exit codes: 0=success, 1=general error, 42=input error, 53=turn limit
    if (exitCode !== 0) {
      const errorType =
        exitCode === 42 ? 'input error' :
        exitCode === 53 ? 'turn limit exceeded' :
        'general error';
      return {
        success: false,
        response: '',
        exitCode,
        error: `Gemini ${errorType} (exit ${exitCode}): ${stdout.slice(0, 500)}`,
      };
    }

    try {
      const parsed = JSON.parse(stdout);
      return {
        success: true,
        response: parsed.response ?? stdout,
        usage: parsed.stats
          ? { inputTokens: parsed.stats.input_tokens, outputTokens: parsed.stats.output_tokens }
          : undefined,
        exitCode,
        raw: parsed,
      };
    } catch {
      return { success: true, response: stdout.trim(), exitCode };
    }
  },

  parseStreamEvent(line: string): StreamEvent | null {
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') {
        return { type: 'turn_complete', data: event };
      }
      if (event.type === 'tool_use') {
        return { type: 'tool_call', data: event };
      }
      if (event.type === 'error') {
        return { type: 'error', data: event };
      }
      return { type: 'progress', data: event };
    } catch {
      return null;
    }
  },
};

export const LOCAL_OLLAMA_CONFIG: HeadlessConfig = {
  binary: 'ollama',
  buildArgs(prompt: string, _options: HeadlessOptions): string[] {
    // NOTE: uses default model alias "qwen2.5-coder:14b" unless overridden by OLLAMA_MODEL.
    const model = process.env['OLLAMA_MODEL'] ?? 'qwen2.5-coder:14b';
    return ['run', model, prompt];
  },
  parseOutput(stdout: string, exitCode: number): HeadlessResult {
    if (exitCode !== 0) {
      return {
        success: false,
        response: '',
        exitCode,
        error: `Ollama exited with code ${exitCode}: ${stdout.slice(0, 500)}`,
      };
    }
    return { success: true, response: stdout.trim(), exitCode };
  },
};

export const LOCAL_LLAMA_CPP_CONFIG: HeadlessConfig = {
  binary: 'llama-cli',
  buildArgs(prompt: string, _options: HeadlessOptions): string[] {
    return ['-p', prompt];
  },
  parseOutput(stdout: string, exitCode: number): HeadlessResult {
    if (exitCode !== 0) {
      return {
        success: false,
        response: '',
        exitCode,
        error: `llama-cli exited with code ${exitCode}: ${stdout.slice(0, 500)}`,
      };
    }
    return { success: true, response: stdout.trim(), exitCode };
  },
};

/** Registry mapping adapter IDs to their headless configs. */
export const HEADLESS_CONFIGS: Record<string, HeadlessConfig> = {
  claude: CLAUDE_CONFIG,
  codex: CODEX_CONFIG,
  gemini: GEMINI_CONFIG,
  'local-ollama': LOCAL_OLLAMA_CONFIG,
  'local-llama-cpp': LOCAL_LLAMA_CPP_CONFIG,
};

// ─── CompletionDetector ──────────────────────────────────────────────────────

/**
 * Executes a CLI agent in headless mode and detects completion via process exit.
 *
 * This is the primary strategy for agentic node execution. The process exit
 * is the completion signal — no PTY parsing, no prompt detection, no quiescence
 * heuristics needed.
 *
 * For interactive TUI use, the existing PTY-based adapters remain unchanged.
 */
export class CompletionDetector {
  private activeProcess: ChildProcess | null = null;
  private abortController: AbortController | null = null;

  /**
   * Execute a prompt via headless CLI and wait for completion.
   * Returns when the process exits (success or failure).
   */
  async execute(
    adapterId: string,
    prompt: string,
    options: HeadlessOptions,
    onStream?: OnStreamEvent,
  ): Promise<HeadlessResult> {
    const config = HEADLESS_CONFIGS[adapterId];
    if (!config) {
      return {
        success: false,
        response: '',
        exitCode: -1,
        error: `No headless config for adapter: "${adapterId}". Supported: ${Object.keys(HEADLESS_CONFIGS).join(', ')}`,
      };
    }

    const args = config.buildArgs(prompt, options);
    this.abortController = new AbortController();

    return new Promise<HeadlessResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const proc = spawn(config.binary, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        signal: this.abortController!.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.activeProcess = proc;

      // Timeout enforcement
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      if (options.timeoutMs) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGTERM');
          // Give it 5s to clean up, then force kill
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 5000);
        }, options.timeoutMs);
      }

      proc.stdout!.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        // If streaming, parse and emit events line by line
        if (onStream && config.parseStreamEvent) {
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              const event = config.parseStreamEvent(line);
              if (event) onStream(event);
            }
          }
        }
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code: number | null) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.activeProcess = null;

        const exitCode = code ?? 1;

        if (timedOut) {
          resolve({
            success: false,
            response: stdout,
            exitCode,
            error: `Timed out after ${options.timeoutMs}ms. Partial output: ${stdout.slice(0, 500)}`,
          });
          return;
        }

        const result = config.parseOutput(stdout, exitCode);

        // Append stderr info if there's an error
        if (!result.success && stderr) {
          result.error = `${result.error ?? ''}\nstderr: ${stderr.slice(0, 500)}`.trim();
        }

        resolve(result);
      });

      proc.on('error', (err: Error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.activeProcess = null;

        // AbortError means we cancelled intentionally
        if (err.name === 'AbortError') {
          resolve({
            success: false,
            response: '',
            exitCode: -1,
            error: 'Execution was cancelled',
          });
          return;
        }

        resolve({
          success: false,
          response: '',
          exitCode: -1,
          error: `Failed to spawn ${config.binary}: ${err.message}`,
        });
      });
    });
  }

  /**
   * Cancel the currently running process.
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Check if a process is currently running.
   */
  isRunning(): boolean {
    return this.activeProcess !== null && !this.activeProcess.killed;
  }
}

// ─── PTY Quiescence Detector (Fallback) ──────────────────────────────────────

/**
 * Fallback completion detection for CLIs that don't support headless mode.
 * Watches PTY output and triggers completion when output stops for N ms.
 *
 * This is inherently unreliable and should only be used as a last resort.
 * Known failure modes:
 *   - False positive: Agent is "thinking" (no output but still working)
 *   - False negative: Agent produces output rapidly then stops briefly
 *   - Prompt regex breaks when CLI updates its UI
 */
export interface QuiescenceConfig {
  /** Milliseconds of silence before declaring completion (default: 10000) */
  quiescenceMs: number;
  /** Optional regex patterns that indicate the CLI has returned to its prompt */
  promptPatterns: RegExp[];
  /** Maximum wait time before giving up (default: 300000 = 5 min) */
  maxWaitMs: number;
}

export const DEFAULT_QUIESCENCE: Record<string, QuiescenceConfig> = {
  claude: {
    quiescenceMs: 10_000,
    promptPatterns: [
      />\s*$/, // Claude Code shows ">" when ready for input
      /\$\s*$/, // May show shell-like prompt
    ],
    maxWaitMs: 300_000,
  },
  codex: {
    quiescenceMs: 10_000,
    promptPatterns: [
      />\s*$/, // Codex interactive prompt
    ],
    maxWaitMs: 300_000,
  },
  gemini: {
    quiescenceMs: 10_000,
    promptPatterns: [
      />\s*$/,
      /❯\s*$/, // Gemini uses different prompt chars
    ],
    maxWaitMs: 300_000,
  },
};

/**
 * Watches a data stream for quiescence (silence) as a completion signal.
 * Returns a promise that resolves when completion is detected.
 *
 * Usage with PTY:
 *   const detector = new QuiescenceDetector(config);
 *   pty.onData((data) => detector.feed(data));
 *   await detector.waitForCompletion();
 */
export class QuiescenceDetector {
  private quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private resolvePromise: ((reason: 'quiescence' | 'prompt' | 'timeout') => void) | null = null;
  private buffer = '';

  constructor(private config: QuiescenceConfig) {}

  /** Feed new PTY output data to the detector. */
  feed(data: string): void {
    this.buffer += data;

    // Check for prompt pattern match
    for (const pattern of this.config.promptPatterns) {
      if (pattern.test(this.buffer.slice(-200))) {
        this.complete('prompt');
        return;
      }
    }

    // Reset quiescence timer on new output
    if (this.quiescenceTimer) clearTimeout(this.quiescenceTimer);
    this.quiescenceTimer = setTimeout(() => {
      this.complete('quiescence');
    }, this.config.quiescenceMs);
  }

  /** Wait for the detector to signal completion. */
  waitForCompletion(): Promise<'quiescence' | 'prompt' | 'timeout'> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;

      // Max wait timeout
      this.maxTimer = setTimeout(() => {
        this.complete('timeout');
      }, this.config.maxWaitMs);
    });
  }

  /** Clean up all timers. */
  dispose(): void {
    if (this.quiescenceTimer) clearTimeout(this.quiescenceTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.resolvePromise = null;
  }

  private complete(reason: 'quiescence' | 'prompt' | 'timeout'): void {
    if (this.quiescenceTimer) clearTimeout(this.quiescenceTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.resolvePromise) {
      this.resolvePromise(reason);
      this.resolvePromise = null;
    }
  }
}
